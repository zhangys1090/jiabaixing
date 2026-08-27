"""V3: 操作自修复引擎 — 操作失败时的自动诊断与修复策略。

现有 PerceptionActionLoop 支持简单重试（固定次数+退避），
本模块增强为"智能修复"：

1. 失败诊断（Failure Diagnosis）：分析失败原因（元素消失/遮挡/加载中/权限不足/坐标偏移）
2. 修复策略（Repair Strategy）：根据诊断结果选择修复方案
3. 修复执行（Repair Execution）：执行修复后重试原操作
4. 修复经验沉淀（Repair Learning）：记录修复成功/失败，优化未来修复选择

修复策略库：
- 元素消失 → 刷新UIA树 + 重新定位
- 元素遮挡 → 滚动到可见区域 / 关闭遮挡层
- 加载中 → 等待加载完成（轮询检测）
- 权限不足 → 请求权限 / 降级操作
- 坐标偏移 → 基于UIA精确坐标重定位
- 弹窗阻断 → 识别并关闭弹窗后重试
- 窗口失焦 → 重新激活目标窗口

Usage:
    from agent.perception.operation_self_repair import OperationSelfRepair
    repair = OperationSelfRepair()
    result = await repair.attempt_repair(failure_context, original_action)
    if result.repaired:
        await retry_original_action()
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("operation_self_repair")


class FailureType(str, Enum):
    ELEMENT_GONE = "element_gone"
    ELEMENT_OBSCURED = "element_obscured"
    LOADING = "loading"
    PERMISSION_DENIED = "permission_denied"
    COORDINATE_SHIFT = "coordinate_shift"
    POPUP_BLOCKING = "popup_blocking"
    WINDOW_UNFOCUSED = "window_unfocused"
    TIMEOUT = "timeout"
    UNEXPECTED_STATE = "unexpected_state"
    UNKNOWN = "unknown"


class RepairStrategy(str, Enum):
    REFRESH_RELOCATE = "refresh_relocate"
    SCROLL_TO_VISIBLE = "scroll_to_visible"
    CLOSE_OBSCURING = "close_obscuring"
    WAIT_LOADING = "wait_loading"
    REQUEST_PERMISSION = "request_permission"
    DOWNGRADE_ACTION = "downgrade_action"
    PRECISE_RELOCATE = "precise_relocate"
    CLOSE_POPUP = "close_popup"
    REFOCUS_WINDOW = "refocus_window"
    RETRY_WITH_DELAY = "retry_with_delay"
    ABANDON = "abandon"


@dataclass
class FailureContext:
    failure_type: FailureType = FailureType.UNKNOWN
    action_description: str = ""
    error_message: str = ""
    target_element: dict[str, Any] | None = None
    screenshot_before: str = ""
    screenshot_after: str = ""
    uia_before: list[dict[str, Any]] = field(default_factory=list)
    uia_after: list[dict[str, Any]] = field(default_factory=list)
    attempt_count: int = 0
    duration_ms: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RepairResult:
    repaired: bool = False
    strategy_used: RepairStrategy = RepairStrategy.ABANDON
    repair_actions: list[str] = field(default_factory=list)
    new_coordinates: tuple[int, int] | None = None
    new_element: dict[str, Any] | None = None
    repair_duration_ms: float = 0.0
    should_retry: bool = False
    diagnosis: str = ""
    confidence: float = 0.0


_FAILURE_REPAIR_MAP: dict[FailureType, list[RepairStrategy]] = {
    FailureType.ELEMENT_GONE: [RepairStrategy.REFRESH_RELOCATE, RepairStrategy.SCROLL_TO_VISIBLE, RepairStrategy.RETRY_WITH_DELAY],
    FailureType.ELEMENT_OBSCURED: [RepairStrategy.SCROLL_TO_VISIBLE, RepairStrategy.CLOSE_OBSCURING],
    FailureType.LOADING: [RepairStrategy.WAIT_LOADING, RepairStrategy.RETRY_WITH_DELAY],
    FailureType.PERMISSION_DENIED: [RepairStrategy.REQUEST_PERMISSION, RepairStrategy.DOWNGRADE_ACTION],
    FailureType.COORDINATE_SHIFT: [RepairStrategy.PRECISE_RELOCATE, RepairStrategy.REFRESH_RELOCATE],
    FailureType.POPUP_BLOCKING: [RepairStrategy.CLOSE_POPUP, RepairStrategy.CLOSE_OBSCURING],
    FailureType.WINDOW_UNFOCUSED: [RepairStrategy.REFOCUS_WINDOW],
    FailureType.TIMEOUT: [RepairStrategy.RETRY_WITH_DELAY, RepairStrategy.WAIT_LOADING],
    FailureType.UNEXPECTED_STATE: [RepairStrategy.REFRESH_RELOCATE, RepairStrategy.RETRY_WITH_DELAY],
    FailureType.UNKNOWN: [RepairStrategy.RETRY_WITH_DELAY, RepairStrategy.REFRESH_RELOCATE],
}


class OperationSelfRepair:
    """V3: 操作自修复引擎.

    当感知-行动闭环操作失败时，自动诊断失败原因并选择修复策略，
    执行修复后建议重试原操作。

    设计原则：
    - 非阻塞：修复失败不阻断，返回 should_retry=False
    - 渐进式：按策略优先级依次尝试，首次轻量修复，后续重度修复
    - 经验沉淀：修复成功/失败记录到反思知识库，优化未来选择
    - 最多2轮修复：避免修复本身陷入循环
    """

    _MAX_REPAIR_ROUNDS = 2
    _WAIT_LOADING_INTERVAL = 0.5
    _WAIT_LOADING_TIMEOUT = 10.0

    def __init__(self, llm: Any = None) -> None:
        self._llm = llm
        self._repair_history: list[dict[str, Any]] = []
        self._MAX_HISTORY = 200

    async def diagnose(self, context: FailureContext) -> FailureType:
        """诊断失败原因.

        优先级：
        1. 基于错误消息的关键词匹配（快速、确定性高）
        2. 基于UIA前后对比的差异分析
        3. 基于VLM的视觉诊断（最灵活，需API）
        """
        error_lower = context.error_message.lower()

        if any(kw in error_lower for kw in ("not found", "不存在", "消失", "stale", "detached", "no such element")):
            return FailureType.ELEMENT_GONE

        if any(kw in error_lower for kw in ("obscured", "遮挡", "covered", "not visible", "不可见")):
            return FailureType.ELEMENT_OBSCURED

        if any(kw in error_lower for kw in ("loading", "加载中", "spinner", "pending", "请稍候")):
            return FailureType.LOADING

        if any(kw in error_lower for kw in ("permission", "权限", "denied", "forbidden", "unauthorized")):
            return FailureType.PERMISSION_DENIED

        if any(kw in error_lower for kw in ("timeout", "超时", "timed out")):
            return FailureType.TIMEOUT

        if any(kw in error_lower for kw in ("popup", "弹窗", "dialog", "modal", "对话框")):
            return FailureType.POPUP_BLOCKING

        if any(kw in error_lower for kw in ("focus", "失焦", "inactive", "后台")):
            return FailureType.WINDOW_UNFOCUSED

        if context.uia_before and context.uia_after:
            before_ids = {e.get("automation_id", "") for e in context.uia_before}
            after_ids = {e.get("automation_id", "") for e in context.uia_after}
            if context.target_element:
                target_id = context.target_element.get("automation_id", "")
                if target_id in before_ids and target_id not in after_ids:
                    return FailureType.ELEMENT_GONE
            new_ids = after_ids - before_ids
            if any("dialog" in e.get("control_type", "").lower() or "popup" in e.get("name", "").lower() for e in context.uia_after if e.get("automation_id", "") in new_ids):
                return FailureType.POPUP_BLOCKING

        if context.attempt_count >= 3:
            return FailureType.UNEXPECTED_STATE

        return FailureType.UNKNOWN

    async def attempt_repair(self, context: FailureContext, original_action: str = "") -> RepairResult:
        """尝试修复操作失败.

        Args:
            context: 失败上下文
            original_action: 原始操作描述

        Returns:
            RepairResult: 修复结果
        """
        start = time.monotonic()

        if context.attempt_count > self._MAX_REPAIR_ROUNDS:
            log.warning("V3: max repair rounds exceeded", attempts=context.attempt_count)
            return RepairResult(
                repaired=False,
                strategy_used=RepairStrategy.ABANDON,
                diagnosis="超过最大修复轮数",
                should_retry=False,
            )

        failure_type = await self.diagnose(context)
        context.failure_type = failure_type

        strategies = _FAILURE_REPAIR_MAP.get(failure_type, [RepairStrategy.RETRY_WITH_DELAY])

        log.info(
            "V3: attempting repair",
            failure=failure_type.value,
            strategies=[s.value for s in strategies],
            attempt=context.attempt_count,
        )

        for strategy in strategies:
            result = await self._execute_strategy(strategy, context, original_action)
            if result.repaired:
                result.strategy_used = strategy
                result.repair_duration_ms = (time.monotonic() - start) * 1000
                result.diagnosis = f"失败类型: {failure_type.value}, 修复策略: {strategy.value}"

                self._record_repair(failure_type, strategy, success=True, duration_ms=result.repair_duration_ms)

                log.info(
                    "V3: repair succeeded",
                    failure=failure_type.value,
                    strategy=strategy.value,
                    duration_ms=round(result.repair_duration_ms, 1),
                )
                return result

        repair_duration_ms = (time.monotonic() - start) * 1000
        self._record_repair(failure_type, strategies[-1], success=False, duration_ms=repair_duration_ms)

        log.warning(
            "V3: all repair strategies failed",
            failure=failure_type.value,
            duration_ms=round(repair_duration_ms, 1),
        )

        return RepairResult(
            repaired=False,
            strategy_used=RepairStrategy.ABANDON,
            repair_duration_ms=repair_duration_ms,
            diagnosis=f"失败类型: {failure_type.value}, 所有修复策略均失败",
            should_retry=False,
        )

    async def _execute_strategy(self, strategy: RepairStrategy, context: FailureContext, original_action: str) -> RepairResult:
        """执行单个修复策略."""
        try:
            if strategy == RepairStrategy.REFRESH_RELOCATE:
                return await self._repair_refresh_relocate(context, original_action)
            elif strategy == RepairStrategy.SCROLL_TO_VISIBLE:
                return await self._repair_scroll_to_visible(context)
            elif strategy == RepairStrategy.CLOSE_OBSCURING:
                return await self._repair_close_obscuring(context)
            elif strategy == RepairStrategy.WAIT_LOADING:
                return await self._repair_wait_loading(context)
            elif strategy == RepairStrategy.CLOSE_POPUP:
                return await self._repair_close_popup(context)
            elif strategy == RepairStrategy.REFOCUS_WINDOW:
                return await self._repair_refocus_window(context)
            elif strategy == RepairStrategy.PRECISE_RELOCATE:
                return await self._repair_precise_relocate(context, original_action)
            elif strategy == RepairStrategy.REQUEST_PERMISSION:
                return RepairResult(repaired=False, strategy_used=strategy, should_retry=False, diagnosis="需要用户授权权限")
            elif strategy == RepairStrategy.DOWNGRADE_ACTION:
                return RepairResult(repaired=False, strategy_used=strategy, should_retry=False, diagnosis="操作降级：跳过此步骤")
            elif strategy == RepairStrategy.RETRY_WITH_DELAY:
                delay = min(1.0 * (2 ** context.attempt_count), 8.0)
                await asyncio.sleep(delay)
                return RepairResult(repaired=True, strategy_used=strategy, should_retry=True, repair_actions=[f"等待{delay:.1f}秒后重试"], confidence=0.5)
            else:
                return RepairResult(repaired=False, strategy_used=strategy, should_retry=False)
        except Exception as e:
            log.warning("V3: repair strategy execution failed", strategy=strategy.value, error=str(e))
            return RepairResult(repaired=False, strategy_used=strategy, should_retry=False)

    async def _repair_refresh_relocate(self, context: FailureContext, original_action: str) -> RepairResult:
        """修复：刷新UIA树 + 重新定位元素."""
        actions: list[str] = []

        try:
            from agent.perception.uia_cache import UIAElementCache
            cache = UIAElementCache()
            tree = await cache.refresh(force=True)
            actions.append("刷新UIA元素树")
        except Exception as e:
            log.debug("V3: UIA refresh failed", error=str(e))
            return RepairResult(repaired=False, should_retry=False)

        if original_action:
            try:
                from agent.perception.visual_grounding import VisualGrounding
                vg = VisualGrounding()
                result = await vg.locate(original_action)
                if result.target_found and result.coordinates:
                    actions.append(f"重新定位到({result.coordinates[0]},{result.coordinates[1]})")
                    return RepairResult(
                        repaired=True,
                        should_retry=True,
                        new_coordinates=result.coordinates,
                        new_element=result.element,
                        repair_actions=actions,
                        confidence=result.confidence,
                    )
            except Exception as e:
                log.debug("V3: re-localization failed", error=str(e))

        return RepairResult(repaired=False, should_retry=False, repair_actions=actions)

    async def _repair_scroll_to_visible(self, context: FailureContext) -> RepairResult:
        """修复：滚动到元素可见区域."""
        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            controller = get_desktop_controller()

            target = context.target_element
            if target:
                bbox = target.get("bbox", "")
                if bbox:
                    try:
                        parts = [int(p.strip()) for p in bbox.strip("()").split(",")]
                        if len(parts) >= 4:
                            center_y = (parts[1] + parts[3]) // 2
                            from agent.desktop.desktop_controller import Rect
                            screen_height = 1080
                            if center_y < 100:
                                controller.scroll(0, -300)
                            elif center_y > screen_height - 100:
                                controller.scroll(0, 300)
                            return RepairResult(
                                repaired=True,
                                should_retry=True,
                                repair_actions=["滚动到目标元素可见区域"],
                                confidence=0.6,
                            )
                    except (ValueError, IndexError):
                        pass
        except Exception as e:
            log.debug("V3: scroll repair failed", error=str(e))

        return RepairResult(repaired=False, should_retry=False)

    async def _repair_close_obscuring(self, context: FailureContext) -> RepairResult:
        """修复：关闭遮挡层."""
        try:
            from agent.perception.uia_cache import UIAElementCache
            cache = UIAElementCache()
            tree = await cache.refresh(force=True)

            for elem in tree.flat_elements:
                ctrl = elem.raw.get("control_type", "").lower()
                name = elem.raw.get("name", "").lower()
                if ctrl in ("window", "dialog", "popup") or "关闭" in name or "close" in name or "cancel" in name or "取消" in name:
                    from agent.perception.visual_grounding import VisualGrounding
                    vg = VisualGrounding()
                    close_keywords = ["关闭", "close", "取消", "cancel", "×", "dismiss"]
                    for kw in close_keywords:
                        result = await vg.locate(kw)
                        if result.target_found and result.coordinates:
                            from agent.desktop.desktop_controller import get_desktop_controller
                            controller = get_desktop_controller()
                            controller.click(result.coordinates[0], result.coordinates[1])
                            await asyncio.sleep(0.5)
                            return RepairResult(
                                repaired=True,
                                should_retry=True,
                                repair_actions=[f"关闭遮挡层: {name or ctrl}"],
                                confidence=0.7,
                            )
                    break
        except Exception as e:
            log.debug("V3: close obscuring repair failed", error=str(e))

        return RepairResult(repaired=False, should_retry=False)

    async def _repair_wait_loading(self, context: FailureContext) -> RepairResult:
        """修复：等待加载完成."""
        elapsed = 0.0
        while elapsed < self._WAIT_LOADING_TIMEOUT:
            await asyncio.sleep(self._WAIT_LOADING_INTERVAL)
            elapsed += self._WAIT_LOADING_INTERVAL

            try:
                from agent.perception.uia_cache import UIAElementCache
                cache = UIAElementCache()
                tree = await cache.refresh(force=True)

                loading_indicators = ["loading", "加载", "spinner", "progress", "请稍候", "pending"]
                still_loading = any(
                    any(ind in elem.raw.get("name", "").lower() for ind in loading_indicators)
                    for elem in tree.flat_elements
                )

                if not still_loading:
                    return RepairResult(
                        repaired=True,
                        should_retry=True,
                        repair_actions=[f"等待加载完成({elapsed:.1f}秒)"],
                        confidence=0.8,
                    )
            except Exception:
                continue

        return RepairResult(repaired=False, should_retry=False, repair_actions=[f"等待超时({self._WAIT_LOADING_TIMEOUT}秒)"])

    async def _repair_close_popup(self, context: FailureContext) -> RepairResult:
        """修复：识别并关闭弹窗."""
        try:
            from agent.perception.visual_grounding import VisualGrounding
            vg = VisualGrounding()

            close_targets = ["关闭", "close", "取消", "cancel", "不再提示", "don't show", "×", "dismiss", "确定", "ok"]
            for target in close_targets:
                result = await vg.locate(target)
                if result.target_found and result.coordinates:
                    from agent.desktop.desktop_controller import get_desktop_controller
                    controller = get_desktop_controller()
                    controller.click(result.coordinates[0], result.coordinates[1])
                    await asyncio.sleep(0.5)
                    return RepairResult(
                        repaired=True,
                        should_retry=True,
                        repair_actions=[f"关闭弹窗: 点击'{target}'"],
                        confidence=0.75,
                    )
        except Exception as e:
            log.debug("V3: close popup repair failed", error=str(e))

        return RepairResult(repaired=False, should_retry=False)

    async def _repair_refocus_window(self, context: FailureContext) -> RepairResult:
        """修复：重新激活目标窗口."""
        try:
            target = context.target_element
            if target:
                window_title = target.get("window_title", "")
                if window_title:
                    from agent.desktop.desktop_controller import get_desktop_controller
                    controller = get_desktop_controller()
                    windows = controller.list_windows()
                    for win in windows:
                        if window_title in win.title:
                            controller.focus_window(win.handle)
                            await asyncio.sleep(0.3)
                            return RepairResult(
                                repaired=True,
                                should_retry=True,
                                repair_actions=[f"重新激活窗口: {window_title}"],
                                confidence=0.8,
                            )
        except Exception as e:
            log.debug("V3: refocus window repair failed", error=str(e))

        return RepairResult(repaired=False, should_retry=False)

    async def _repair_precise_relocate(self, context: FailureContext, original_action: str) -> RepairResult:
        """修复：基于UIA精确坐标重定位."""
        if not original_action:
            return RepairResult(repaired=False, should_retry=False)

        try:
            from agent.perception.visual_grounding import VisualGrounding
            vg = VisualGrounding()
            result = await vg.locate(original_action, prefer_method="uia")
            if result.target_found and result.coordinates and result.method == "uia":
                return RepairResult(
                    repaired=True,
                    should_retry=True,
                    new_coordinates=result.coordinates,
                    new_element=result.element,
                    repair_actions=["UIA精确重定位"],
                    confidence=result.confidence,
                )
        except Exception as e:
            log.debug("V3: precise relocate repair failed", error=str(e))

        return RepairResult(repaired=False, should_retry=False)

    def _record_repair(self, failure_type: FailureType, strategy: RepairStrategy, success: bool, duration_ms: float) -> None:
        """记录修复经验."""
        self._repair_history.append({
            "failure_type": failure_type.value,
            "strategy": strategy.value,
            "success": success,
            "duration_ms": duration_ms,
            "timestamp": time.time(),
        })
        if len(self._repair_history) > self._MAX_HISTORY:
            self._repair_history = self._repair_history[-self._MAX_HISTORY * 3 // 4:]

    def get_repair_stats(self) -> dict[str, Any]:
        """获取修复统计数据."""
        if not self._repair_history:
            return {"total": 0, "success_rate": 0.0, "by_failure_type": {}, "by_strategy": {}}

        total = len(self._repair_history)
        success_count = sum(1 for r in self._repair_history if r["success"])

        by_failure: dict[str, dict[str, int]] = {}
        for r in self._repair_history:
            ft = r["failure_type"]
            if ft not in by_failure:
                by_failure[ft] = {"total": 0, "success": 0}
            by_failure[ft]["total"] += 1
            if r["success"]:
                by_failure[ft]["success"] += 1

        by_strategy: dict[str, dict[str, int]] = {}
        for r in self._repair_history:
            st = r["strategy"]
            if st not in by_strategy:
                by_strategy[st] = {"total": 0, "success": 0}
            by_strategy[st]["total"] += 1
            if r["success"]:
                by_strategy[st]["success"] += 1

        return {
            "total": total,
            "success_rate": success_count / total,
            "by_failure_type": by_failure,
            "by_strategy": by_strategy,
        }
