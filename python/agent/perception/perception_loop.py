"""PerceptionActionLoop — 感知-行动闭环编排。

整合 UIAElementCache、ActionVerifier、VisualGrounding、ScreenWatcher、
LocalOCR 五大组件，提供完整的感知-行动闭环能力。

闭环流程：
1. VisualGrounding 定位目标
2. 捕获操作前状态（截图 + UIA 树）
3. 执行操作
4. ScreenWatcher 检测屏幕变化
5. ActionVerifier 验证操作结果
6. 失败则自动重试

Usage:
    from agent.perception import PerceptionActionLoop
    loop = PerceptionActionLoop()
    result = await loop.execute("点击确定按钮")
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.perception.uia_cache import UIAElementCache, CachedTree
from agent.perception.action_verifier import ActionVerifier, VerificationResult, AutoRetryPolicy
from agent.perception.visual_grounding import VisualGrounding, GroundingResult
from agent.perception.screen_watcher import ScreenWatcher, ScreenChangeEvent
from agent.perception.local_ocr import LocalOCR, OCRResult
from agent.perception.sensory_fusion import SensoryFusion, SenseSample, FusedPerception
from agent.perception.closed_loop_metrics import ClosedLoopMetricCollector

log = StructuredLogger("perception_loop")


@dataclass
class LoopResult:
    """感知-行动闭环结果。

    Attributes:
        success: 操作是否成功。
        action: 执行的操作描述。
        grounding: 视觉定位结果。
        verification: 操作验证结果。
        retries: 重试次数。
        total_duration_ms: 总耗时（毫秒）。
        events: 屏幕变化事件列表。
    """

    success: bool = False
    action: str = ""
    grounding: GroundingResult | None = None
    verification: VerificationResult | None = None
    retries: int = 0
    total_duration_ms: float = 0.0
    events: list[ScreenChangeEvent] = field(default_factory=list)


class PerceptionActionLoop:
    """感知-行动闭环编排器。

    将感知、定位、执行、验证四个阶段串联成闭环，
    支持自动重试和增量感知。

    Usage:
        loop = PerceptionActionLoop()
        result = await loop.execute("点击确定按钮", action_fn=my_click_fn)
    """

    def __init__(
        self,
        retry_policy: AutoRetryPolicy | None = None,
        enable_watcher: bool = True,
        enable_ocr: bool = True,
        shutdown_event: asyncio.Event | None = None,
        sensory_fusion: SensoryFusion | None = None,
        closed_loop_collector: ClosedLoopMetricCollector | None = None,
    ) -> None:
        self._uia_cache = UIAElementCache()
        self._verifier = ActionVerifier(retry_policy)
        self._grounding = VisualGrounding()
        self._watcher = ScreenWatcher(shutdown_event=shutdown_event) if enable_watcher else None
        self._ocr = LocalOCR() if enable_ocr else None
        self._retry_policy = retry_policy or AutoRetryPolicy()
        # 五感融合层（W6）：把分散感知通道统一为可喂给决策的上下文
        self._fusion = sensory_fusion or SensoryFusion()
        self._last_fusion: FusedPerception | None = None
        # 闭环度量（U1 × U3）：记录每轮感知→行动→验证结果，回喂进化引擎
        self._closed_loop = closed_loop_collector or ClosedLoopMetricCollector()

    @property
    def uia_cache(self) -> UIAElementCache:
        return self._uia_cache

    @property
    def verifier(self) -> ActionVerifier:
        return self._verifier

    @property
    def grounding(self) -> VisualGrounding:
        return self._grounding

    @property
    def watcher(self) -> ScreenWatcher | None:
        return self._watcher

    @property
    def ocr(self) -> LocalOCR | None:
        return self._ocr

    @property
    def closed_loop(self) -> ClosedLoopMetricCollector:
        """闭环度量收集器（U1 × U3）：感知→行动→验证 命中率。"""
        return self._closed_loop

    @property
    def closed_loop_metrics(self):
        """当前累积的闭环度量快照。"""
        return self._closed_loop.snapshot()

    async def execute(
        self,
        action_description: str,
        action_fn: Any | None = None,
        max_retries: int | None = None,
        verify_strategy: str = "auto",
    ) -> LoopResult:
        """执行感知-行动闭环。

        Args:
            action_description: 操作描述。
            action_fn: 执行操作的异步函数。如果为 None，只做定位不做执行。
            max_retries: 最大重试次数。
            verify_strategy: 验证策略。

        Returns:
            LoopResult: 闭环结果。
        """
        start = time.monotonic()
        retries = max_retries if max_retries is not None else self._retry_policy.max_retries

        log.info("感知-行动闭环开始", action=action_description)

        # Phase 1: 视觉定位
        grounding = await self._grounding.locate(action_description)
        if not grounding.target_found:
            duration_ms = (time.monotonic() - start) * 1000
            self._closed_loop.record_attempt(
                action=action_description,
                verification_success=False,
                perception_confidence=0.2,
                verification_confidence=0.0,
                retries=0,
                duration_ms=duration_ms,
            )
            return LoopResult(
                success=False,
                action=action_description,
                grounding=grounding,
                total_duration_ms=duration_ms,
            )

        # Phase 2: 捕获操作前状态
        pre_screenshot = await self._capture_screenshot()
        pre_tree = await self._uia_cache.refresh(force=True)
        self._verifier.capture_pre_state(
            screenshot_path=pre_screenshot,
            uia_elements=[e.raw for e in pre_tree.flat_elements],
        )

        # Phase 3: 启动屏幕监听
        if self._watcher and not self._watcher.is_running:
            await self._watcher.start()

        # Phase 4: 执行操作（带重试）
        verification: VerificationResult | None = None
        actual_retries = 0

        for attempt in range(retries + 1):
            if action_fn is not None:
                try:
                    if grounding.coordinates:
                        await action_fn(grounding.coordinates, grounding.element)
                    else:
                        await action_fn()
                except Exception as e:
                    log.warning("操作执行异常", attempt=attempt, error=str(e))
                    if attempt < retries:
                        import asyncio
                        delay = min(
                            self._retry_policy.base_delay * (self._retry_policy.backoff_factor ** attempt),
                            self._retry_policy.max_delay,
                        )
                        await asyncio.sleep(delay)
                        actual_retries += 1
                        continue
                    exc_duration_ms = (time.monotonic() - start) * 1000
                    self._closed_loop.record_attempt(
                        action=action_description,
                        verification_success=False,
                        perception_confidence=0.9,
                        verification_confidence=0.0,
                        retries=actual_retries,
                        duration_ms=exc_duration_ms,
                    )
                    return LoopResult(
                        success=False,
                        action=action_description,
                        grounding=grounding,
                        verification=VerificationResult(
                            success=False, confidence=0.0,
                            evidence=f"操作执行异常: {e}", method="exception",
                        ),
                        retries=actual_retries,
                        total_duration_ms=exc_duration_ms,
                    )

            # Phase 5: 等待屏幕变化
            if self._watcher:
                import asyncio
                await asyncio.sleep(0.5)

            # Phase 6: 验证操作结果
            post_screenshot = await self._capture_screenshot()
            verification = await self._verifier.verify(
                action_description=action_description,
                post_path=post_screenshot,
                strategy=verify_strategy,
            )

            if verification.success and verification.confidence >= 0.7:
                break

            if verification.retry_suggested and attempt < retries:
                import asyncio
                delay = min(
                    self._retry_policy.base_delay * (self._retry_policy.backoff_factor ** attempt),
                    self._retry_policy.max_delay,
                )
                log.info("操作验证失败，重试", attempt=attempt + 1, delay=delay)
                await asyncio.sleep(delay)
                actual_retries += 1
                continue

            break

        # 收集屏幕变化事件
        events: list[ScreenChangeEvent] = []
        if self._watcher:
            events = self._watcher.get_events(limit=10)

        # Phase 7: 五感融合（W6）—— 把本轮感知统一为可喂给决策的上下文
        self._last_fusion = self.fuse_perception(
            grounding=grounding,
            uia_elements=[e.raw for e in pre_tree.flat_elements] if pre_tree else None,
            watcher_events=events,
        )

        result = LoopResult(
            success=verification.success if verification else False,
            action=action_description,
            grounding=grounding,
            verification=verification,
            retries=actual_retries,
            total_duration_ms=(time.monotonic() - start) * 1000,
            events=events,
        )

        # 闭环度量（U1 × U3）：记录本轮感知→行动→验证结果，回喂进化引擎
        perc_conf = (
            self._last_fusion.confidence
            if self._last_fusion is not None
            else (0.9 if grounding.target_found else 0.2)
        )
        self._closed_loop.record_attempt(
            action=action_description,
            verification_success=result.success,
            perception_confidence=perc_conf,
            verification_confidence=verification.confidence if verification else 0.0,
            retries=actual_retries,
            duration_ms=result.total_duration_ms,
        )

        log.info(
            "感知-行动闭环完成",
            success=result.success,
            retries=actual_retries,
            duration_ms=result.total_duration_ms,
        )

        return result

    # ------------------------------------------------------------------ 五感融合（W6）
    def fuse_perception(
        self,
        grounding: GroundingResult | None = None,
        ocr_text: str | None = None,
        uia_elements: list[Any] | None = None,
        watcher_events: list[ScreenChangeEvent] | None = None,
        extra_text: str | None = None,
        strategy: str = "weighted",
    ) -> FusedPerception:
        """把分散的感知通道融合为统一的 ``FusedPerception``。

        各通道被封装为 ``SenseSample``（带置信度），由 ``SensoryFusion`` 加权/拼接，
        直接产出可拼入提示词的上下文，闭合"感知 → 决策"回路。
        """
        samples: list[SenseSample] = []
        if grounding is not None:
            action_desc = getattr(grounding, "action_description", None) or "目标"
            samples.append(
                SenseSample(
                    modality="visual",
                    content=(
                        f"定位[{action_desc}] "
                        f"命中={grounding.target_found} 坐标={grounding.coordinates}"
                    ),
                    confidence=0.9 if grounding.target_found else 0.2,
                    metadata={"kind": "grounding"},
                )
            )
        if ocr_text:
            samples.append(SenseSample(modality="ocr", content=ocr_text, confidence=0.85))
        if uia_elements:
            text = "; ".join(str(e) for e in uia_elements[:50])
            samples.append(
                SenseSample(modality="uia", content=f"界面元素: {text}", confidence=0.8)
            )
        if watcher_events:
            desc = "; ".join(getattr(ev, "description", str(ev)) for ev in watcher_events)
            samples.append(
                SenseSample(modality="visual", content=f"屏幕变化: {desc}", confidence=0.7)
            )
        if extra_text:
            samples.append(SenseSample(modality="text", content=extra_text, confidence=1.0))
        self._fusion.clear()
        self._fusion.add_many(samples)
        fused = self._fusion.fuse(strategy=strategy)
        self._last_fusion = fused
        return fused

    def perception_context(self, strategy: str = "weighted") -> str:
        """产出最近一次融合的提示词上下文；若尚未融合则返回空串。"""
        if self._last_fusion is None:
            return ""
        return self._fusion.to_prompt_context(strategy)

    @property
    def last_fusion(self) -> FusedPerception | None:
        return self._last_fusion

    async def locate(self, description: str) -> GroundingResult:
        """仅定位，不执行操作。

        Args:
            description: 目标描述。

        Returns:
            GroundingResult: 定位结果。
        """
        return await self._grounding.locate(description)

    async def verify_only(
        self,
        action_description: str,
        pre_path: str = "",
        post_path: str = "",
        strategy: str = "auto",
    ) -> VerificationResult:
        """仅验证，不执行操作。

        Args:
            action_description: 操作描述。
            pre_path: 操作前截图路径。
            post_path: 操作后截图路径。
            strategy: 验证策略。

        Returns:
            VerificationResult: 验证结果。
        """
        return await self._verifier.verify(
            action_description=action_description,
            pre_path=pre_path,
            post_path=post_path,
            strategy=strategy,
        )

    async def refresh_uia(self, force: bool = False) -> CachedTree:
        """刷新 UIA 元素树缓存。

        Args:
            force: 是否强制刷新。

        Returns:
            CachedTree: 最新的 UI 元素树。
        """
        return await self._uia_cache.refresh(force=force)

    async def ocr_recognize(self, image_path: str, region: str = "") -> OCRResult | None:
        """OCR 文字识别。

        Args:
            image_path: 图片路径。
            region: 识别区域。

        Returns:
            OCRResult: 识别结果，OCR 不可用时返回 None。
        """
        if self._ocr is None:
            return None
        return await self._ocr.recognize(image_path, region)

    async def _capture_screenshot(self) -> str:
        """截图并返回路径。"""
        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            controller = get_desktop_controller()
            result = controller.screenshot_full()
            if result.success:
                return result.image_path
        except Exception as _exc:
            log_ignored(log, "perception_loop._screenshot", _exc)
        return ""
