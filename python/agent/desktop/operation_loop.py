"""桌面操作闭环 — UIA + ActionVerifier + DesktopController 三层集成。

设计目标：
1. 操作前感知：截图 + UIA 元素树快照
2. 操作执行：UIA 精确操作优先，pyautogui 降级
3. 操作后验证：ActionVerifier 多策略验证（pixel/ocr/uia_diff）
4. 失败自动重试：带退避的自动重试 + UIA 重定位
5. Phase 4: 操作循环指标采集 + UIA 元素树 diff 验证

闭环流程：
  capture_pre → execute → capture_post → verify(uia_diff+pixel/ocr) → [retry?]

Usage:
    loop = DesktopOperationLoop()
    result = await loop.execute("点击确定按钮", action_type="click", target="确定")
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.core.logger import log_ignored

log = StructuredLogger("desktop_operation_loop")


@dataclass
class OperationSpec:
    action_type: str = "click"
    target: str = ""
    value: str = ""
    control_type: str = ""
    coordinates: tuple[int, int] | None = None
    timeout: float = 10.0
    max_retries: int = 2
    verify_strategy: str = "auto"


@dataclass
class OperationResult:
    success: bool
    action: str
    evidence: str = ""
    retries: int = 0
    duration_ms: float = 0.0
    verification: dict[str, Any] = field(default_factory=dict)
    error: str = ""


@dataclass
class OperationLoopMetrics:
    total_operations: int = 0
    success_count: int = 0
    failure_count: int = 0
    total_retries: int = 0
    uac_blocked_count: int = 0
    total_duration_ms: float = 0.0
    action_counts: dict[str, int] = field(default_factory=dict)
    action_success_counts: dict[str, int] = field(default_factory=dict)
    action_latency_ms: dict[str, list[float]] = field(default_factory=dict)

    def record(self, action: str, success: bool, duration_ms: float, retries: int = 0, uac_blocked: bool = False) -> None:
        self.total_operations += 1
        self.total_duration_ms += duration_ms
        self.total_retries += retries
        self.action_counts[action] = self.action_counts.get(action, 0) + 1
        if success:
            self.success_count += 1
            self.action_success_counts[action] = self.action_success_counts.get(action, 0) + 1
        else:
            self.failure_count += 1
        if uac_blocked:
            self.uac_blocked_count += 1
        samples = self.action_latency_ms.get(action, [])
        samples.append(duration_ms)
        if len(samples) > 500:
            samples = samples[-250:]
        self.action_latency_ms[action] = samples

    @property
    def success_rate(self) -> float:
        return self.success_count / self.total_operations if self.total_operations else 0.0

    @property
    def avg_duration_ms(self) -> float:
        return self.total_duration_ms / self.total_operations if self.total_operations else 0.0

    def to_dict(self) -> dict[str, Any]:
        actions_info = {}
        for k, v in self.action_counts.items():
            lat = self.action_latency_ms.get(k, [])
            actions_info[k] = {
                "count": v,
                "success": self.action_success_counts.get(k, 0),
                "avg_ms": round(sum(lat) / len(lat), 2) if lat else 0.0,
            }
        return {
            "total_operations": self.total_operations,
            "success_count": self.success_count,
            "failure_count": self.failure_count,
            "success_rate": round(self.success_rate, 4),
            "avg_duration_ms": round(self.avg_duration_ms, 2),
            "total_retries": self.total_retries,
            "uac_blocked_count": self.uac_blocked_count,
            "actions": actions_info,
        }


class DesktopOperationLoop:
    def __init__(self) -> None:
        self._uia_engine: Any | None = None
        self._desktop_controller: Any | None = None
        self._action_verifier: Any | None = None
        self._screenshot_dir: str = ""
        self._long_task_orchestrator: Any | None = None
        self._metrics = OperationLoopMetrics()
        self._init_components()

    def get_metrics(self) -> OperationLoopMetrics:
        return self._metrics

    def _init_components(self) -> None:
        try:
            from agent.tools.windows_uia import UIAEngine
            self._uia_engine = UIAEngine.get_instance()
        except Exception as e:
            log.debug("UIA engine not available", error=str(e))

        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            self._desktop_controller = get_desktop_controller()
        except Exception as e:
            log.debug("DesktopController not available", error=str(e))

        try:
            from agent.perception.action_verifier import ActionVerifier
            self._action_verifier = ActionVerifier()
        except Exception as e:
            log.debug("ActionVerifier not available", error=str(e))

        try:
            from agent.config import DATA_ROOT
            self._screenshot_dir = os.path.join(str(DATA_ROOT), "screenshots", "op_loop")
            os.makedirs(self._screenshot_dir, exist_ok=True)
        except Exception as _exc:
            log.debug("operation_loop 异常处理", error=str(_exc))
            self._screenshot_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "screenshots", "op_loop")
            os.makedirs(self._screenshot_dir, exist_ok=True)

    async def execute(self, spec: OperationSpec) -> OperationResult:
        start = time.time()

        # D2: UAC窗口检测 — 操作前检测是否有UAC提权提示阻塞
        uac_blocked = await self._detect_uac_block()
        if uac_blocked:
            log.warning("D2: UAC窗口阻塞操作，需用户手动处理", action=spec.action_type)
            duration_ms = (time.time() - start) * 1000
            self._metrics.record(spec.action_type, False, duration_ms, uac_blocked=True)
            return OperationResult(
                success=False,
                action=spec.action_type,
                evidence="UAC elevation prompt detected, requires manual user action",
                duration_ms=duration_ms,
                error="uac_blocked",
            )

        pre_screenshot = await self._capture_screenshot("pre")
        pre_uia = await self._capture_uia_snapshot()

        result = await self._execute_with_retry(spec)

        post_screenshot = await self._capture_screenshot("post")
        post_uia = await self._capture_uia_snapshot()

        verification = {}
        if self._action_verifier and pre_screenshot and post_screenshot:
            try:
                verify_result = await self._action_verifier.verify(
                    action_description=f"{spec.action_type} {spec.target}",
                    pre_path=pre_screenshot,
                    post_path=post_screenshot,
                    strategy=spec.verify_strategy,
                )
                verification = {
                    "success": verify_result.success,
                    "confidence": verify_result.confidence,
                    "evidence": verify_result.evidence,
                    "method": verify_result.method,
                    "retry_suggested": verify_result.retry_suggested,
                }
            except Exception as e:
                log.debug("Verification failed", error=str(e))

        # D9: UIA 元素树 diff 验证 — 检测操作前后 UI 元素变化
        if pre_uia and post_uia:
            uia_diff = self._compute_uia_diff(pre_uia, post_uia)
            if uia_diff:
                verification["uia_diff"] = uia_diff

        duration_ms = (time.time() - start) * 1000
        self._metrics.record(spec.action_type, result, duration_ms)
        return OperationResult(
            success=result,
            action=spec.action_type,
            evidence=verification.get("evidence", ""),
            retries=0,
            duration_ms=duration_ms,
            verification=verification,
        )

    def _compute_uia_diff(
        self,
        pre: list[dict[str, Any]],
        post: list[dict[str, Any]],
    ) -> dict[str, Any]:
        pre_keys = {(e.get("name", ""), e.get("control_type", ""), e.get("automation_id", "")) for e in pre}
        post_keys = {(e.get("name", ""), e.get("control_type", ""), e.get("automation_id", "")) for e in post}
        added = post_keys - pre_keys
        removed = pre_keys - post_keys
        if not added and not removed:
            return {}
        return {
            "added_count": len(added),
            "removed_count": len(removed),
            "added": [{"name": k[0], "control_type": k[1], "automation_id": k[2]} for k in sorted(added)[:10]],
            "removed": [{"name": k[0], "control_type": k[1], "automation_id": k[2]} for k in sorted(removed)[:10]],
        }

    async def _execute_with_retry(self, spec: OperationSpec) -> bool:
        for attempt in range(spec.max_retries + 1):
            success = await self._execute_single(spec)
            if success:
                return True

            if attempt < spec.max_retries:
                delay = min(0.5 * (2 ** attempt), 5.0)
                log.info(
                    "Operation failed, retrying",
                    action=spec.action_type,
                    target=spec.target,
                    attempt=attempt + 1,
                    delay=delay,
                )
                await asyncio.sleep(delay)

        return False

    async def _execute_single(self, spec: OperationSpec) -> bool:
        if spec.action_type == "click":
            return await self._do_click(spec)
        elif spec.action_type == "type":
            return await self._do_type(spec)
        elif spec.action_type == "get_text":
            return await self._do_get_text(spec)
        elif spec.action_type == "set_text":
            return await self._do_set_text(spec)
        elif spec.action_type == "screenshot":
            return await self._do_screenshot(spec)
        elif spec.action_type == "activate_window":
            return await self._do_activate_window(spec)
        elif spec.action_type == "hotkey":
            return await self._do_hotkey(spec)
        elif spec.action_type == "scroll":
            return await self._do_scroll(spec)
        else:
            return await self._do_generic(spec)

    async def _do_click(self, spec: OperationSpec) -> bool:
        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(
                    name=spec.target,
                    control_type=spec.control_type or None,
                    timeout=spec.timeout,
                )
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return await self._uia_engine.click(elements[0])
            except Exception as e:
                log.debug("UIA click failed, falling back", error=str(e))

        if spec.coordinates and self._desktop_controller:
            result = self._desktop_controller.click(spec.coordinates[0], spec.coordinates[1])
            return result.success

        if spec.target and self._desktop_controller:
            try:
                result = self._desktop_controller.click_element(spec.target)
                return result.success
            except Exception as _exc:
                log.debug("operation_loop 异常处理", error=str(_exc))
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_click", _exc)

        return False

    async def _do_type(self, spec: OperationSpec) -> bool:
        if not spec.value:
            return False

        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(name=spec.target, control_type=spec.control_type or "Edit")
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return await self._uia_engine.set_text(elements[0], spec.value)
            except Exception as e:
                log.debug("UIA type failed, falling back", error=str(e))

        if self._desktop_controller:
            try:
                pg = self._desktop_controller._get_pyautogui()
                if pg:
                    pg.write(spec.value)
                    return True
            except Exception as _exc:
                log.debug("operation_loop 异常处理", error=str(_exc))
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_type", _exc)

        return False

    async def _do_get_text(self, spec: OperationSpec) -> bool:
        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(name=spec.target, control_type=spec.control_type or None)
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return True
            except Exception as e:
                log.debug("UIA get_text failed", error=str(e))
        return False

    async def _do_set_text(self, spec: OperationSpec) -> bool:
        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(name=spec.target, control_type=spec.control_type or "Edit")
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return await self._uia_engine.set_text(elements[0], spec.value or "")
            except Exception as e:
                log.debug("UIA set_text failed", error=str(e))
        return False

    async def _do_screenshot(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            result = self._desktop_controller.screenshot_full()
            return result.success
        return False

    async def _do_activate_window(self, spec: OperationSpec) -> bool:
        if self._desktop_controller and spec.target:
            result = self._desktop_controller.activate_window(spec.target)
            return result.success
        return False

    async def _do_hotkey(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            try:
                keys = spec.value.split("+") if spec.value else []
                if keys:
                    pg = self._desktop_controller._get_pyautogui()
                    if pg:
                        pg.hotkey(*[k.strip() for k in keys])
                        return True
            except Exception as _exc:
                log.debug("operation_loop 异常处理", error=str(_exc))
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_hotkey", _exc)
        return False

    async def _do_scroll(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            try:
                pg = self._desktop_controller._get_pyautogui()
                if pg:
                    clicks = int(spec.value) if spec.value else 3
                    pg.scroll(clicks)
                    return True
            except Exception as _exc:
                log.debug("operation_loop 异常处理", error=str(_exc))
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_scroll", _exc)
        return False

    async def _do_generic(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            try:
                result = self._desktop_controller.open_app(spec.target)
                return result.success
            except Exception as _exc:
                log.debug("operation_loop 异常处理", error=str(_exc))
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_generic", _exc)
        return False

    async def _capture_screenshot(self, prefix: str) -> str:
        if not self._desktop_controller:
            return ""
        try:
            result = self._desktop_controller.screenshot_full()
            if result.success:
                return result.image_path
        except Exception as e:
            log.debug("Screenshot capture failed", error=str(e))
        return ""

    async def _capture_uia_snapshot(self) -> list[dict[str, Any]]:
        if not self._uia_engine or not self._uia_engine.is_available:
            return []
        try:
            elements = await self._uia_engine.get_element_tree(max_depth=2)
            return [
                {
                    "name": e.name,
                    "control_type": e.control_type,
                    "automation_id": e.automation_id,
                    "is_enabled": e.is_enabled,
                }
                for e in elements[:50]
            ]
        except Exception as e:
            log.debug("UIA snapshot failed", error=str(e))
            return []

    async def _detect_uac_block(self) -> bool:
        """D2: 检测UAC提权窗口是否阻塞当前操作。

        UAC窗口特征（Windows）：
        1. 窗口类名包含 "Credential Dialog" 或 "#32770"
        2. 窗口标题包含 "用户账户控制" / "User Account Control"
        3. 进程名为 "consent.exe" 或 "CredentialUIBroker.exe"

        检测到UAC时返回True，调用方应通知用户手动处理。
        """
        if not os.name == "nt":
            return False

        try:
            import ctypes
            hwnd = ctypes.windll.user32.FindWindowW(None, "用户账户控制")
            if hwnd:
                return True
            hwnd = ctypes.windll.user32.FindWindowW(None, "User Account Control")
            if hwnd:
                return True

            import subprocess
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq consent.exe"],
                capture_output=True, text=True, timeout=2,
            )
            if "consent.exe" in result.stdout:
                return True
        except Exception:
            pass

        return False

    async def execute_sequence(self, specs: list[OperationSpec], stop_on_fail: bool = True) -> list[OperationResult]:
        """执行操作序列 — 支持多步桌面操作的批量执行。

        Args:
            specs: 操作规格列表，按顺序执行
            stop_on_fail: 某步失败时是否停止后续操作

        Returns:
            每步操作的结果列表
        """
        results: list[OperationResult] = []
        for i, spec in enumerate(specs):
            result = await self.execute(spec)
            results.append(result)
            if not result.success and stop_on_fail:
                log.info(
                    "Sequence stopped at failed step",
                    step=i,
                    action=spec.action_type,
                    target=spec.target,
                )
                break
        return results

    async def execute_parallel(self, specs: list[OperationSpec]) -> list[OperationResult]:
        """并行执行多个独立操作 — 互不依赖的操作可同时执行。

        Args:
            specs: 操作规格列表，并行执行

        Returns:
            每步操作的结果列表（顺序与输入一致）
        """
        tasks = [self.execute(spec) for spec in specs]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        out: list[OperationResult] = []
        for r in results:
            if isinstance(r, OperationResult):
                out.append(r)
            else:
                out.append(OperationResult(success=False, action="unknown", error=str(r)))
        return out

    def bind_long_task_orchestrator(self, orchestrator: Any) -> None:
        """绑定长任务编排器，使桌面操作可委托为长任务子步骤。"""
        self._long_task_orchestrator = orchestrator

    async def execute_as_subtask(self, spec: OperationSpec, task_id: str, subtask_name: str) -> OperationResult:
        """将桌面操作注册为长任务的子任务并执行。

        执行结果会更新长任务编排器中对应子任务的状态。
        """
        result = await self.execute(spec)
        if self._long_task_orchestrator:
            try:
                subtasks = self._long_task_orchestrator._subtasks.get(task_id, [])
                for st in subtasks:
                    if st.name == subtask_name:
                        from agent.core.long_task import SubTaskStatus
                        st.status = SubTaskStatus.COMPLETED if result.success else SubTaskStatus.FAILED
                        break
            except Exception as e:
                log.debug("Failed to update long task subtask status", error=str(e))
        return result
