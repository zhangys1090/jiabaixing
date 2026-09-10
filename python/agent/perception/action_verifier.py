"""ActionVerifier — 操作前后对比验证。

在桌面自动化操作前后截图，对比差异判断操作是否成功，
支持自动重试策略。

Usage:
    from agent.perception.action_verifier import ActionVerifier
    verifier = ActionVerifier()
    result = await verifier.verify("点击确定按钮", pre_path, post_path)
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("action_verifier")




@dataclass
class VerificationResult:
    """操作验证结果。

    Attributes:
        success: 操作是否成功。
        confidence: 置信度 (0-1)。
        evidence: 证据描述。
        retry_suggested: 是否建议重试。
        retry_action: 建议的重试动作。
        method: 验证方法（pixel/ocr/vlm/uia_diff）。
        diff_ratio: 差异率（像素策略时）。
    """

    success: bool = False
    confidence: float = 0.0
    evidence: str = ""
    retry_suggested: bool = False
    retry_action: dict[str, Any] | None = None
    method: str = "unknown"
    diff_ratio: float = 0.0


@dataclass
class AutoRetryPolicy:
    """自动重试策略。

    Attributes:
        max_retries: 最大重试次数。
        base_delay: 基础延迟（秒）。
        max_delay: 最大延迟（秒）。
        backoff_factor: 退避因子。
        retry_on_uncertain: 不确定时是否重试。
    """

    max_retries: int = 3
    base_delay: float = 0.5
    max_delay: float = 5.0
    backoff_factor: float = 2.0
    retry_on_uncertain: bool = True


class ActionVerifier:
    """操作验证器。

    支持四种验证策略：
    1. pixel: 像素差异检测（快速，默认）
    2. ocr: OCR 文字对比（检测文字变化）
    3. vlm: Vision 模型判断（精确，需 Vision API）
    4. uia_diff: UIA 元素树差异（检测控件变化）

    自动选择策略：有目标区域用 OCR，有验证问题用 VLM，否则用 pixel。

    Usage:
        verifier = ActionVerifier()
        result = await verifier.verify("点击确定", pre_path, post_path)
        if result.retry_suggested:
            # 执行重试逻辑
    """

    def __init__(self, retry_policy: AutoRetryPolicy | None = None) -> None:
        self._retry_policy = retry_policy or AutoRetryPolicy()
        self._pre_screenshot: str = ""
        self._pre_uia_snapshot: list[dict[str, Any]] = []

    def capture_pre_state(self, screenshot_path: str = "", uia_elements: list[dict[str, Any]] | None = None) -> None:
        """捕获操作前状态。

        Args:
            screenshot_path: 操作前截图路径。
            uia_elements: 操作前 UIA 元素列表。
        """
        self._pre_screenshot = screenshot_path
        self._pre_uia_snapshot = uia_elements or []

    async def verify(
        self,
        action_description: str,
        pre_path: str = "",
        post_path: str = "",
        strategy: str = "auto",
        target_region: str = "",
        threshold: float = 0.01,
        question: str = "",
    ) -> VerificationResult:
        """验证操作是否成功。

        Args:
            action_description: 操作描述。
            pre_path: 操作前截图路径。
            post_path: 操作后截图路径。
            strategy: 验证策略 (auto/pixel/ocr/vlm/uia_diff)。
            target_region: 关注区域 (x1,y1,x2,y2)。
            threshold: 像素差异阈值。
            question: VLM 验证问题。

        Returns:
            VerificationResult: 验证结果。
        """
        if not pre_path:
            pre_path = self._pre_screenshot

        if strategy == "auto":
            strategy = self._select_strategy(target_region, question)

        if strategy == "pixel":
            return await self._verify_pixel(pre_path, post_path, target_region, threshold)
        if strategy == "ocr":
            return await self._verify_ocr(pre_path, post_path, target_region)
        if strategy == "vlm":
            return await self._verify_vlm(pre_path, post_path, question or action_description)
        if strategy == "ocr_pixel_fallback":
            return await self._verify_ocr_pixel_fallback(pre_path, post_path, target_region, threshold, question or action_description)
        if strategy == "uia_diff":
            return await self._verify_uia_diff()

        return VerificationResult(success=False, confidence=0.0, evidence=f"未知策略: {strategy}", method=strategy)

    async def verify_with_retry(
        self,
        action_description: str,
        action_fn: Any,
        post_screenshot_fn: Any,
        strategy: str = "auto",
        max_retries: int | None = None,
    ) -> VerificationResult:
        """带自动重试的操作验证。

        执行操作后验证，失败则按重试策略重试。

        Args:
            action_description: 操作描述。
            action_fn: 执行操作的异步函数。
            post_screenshot_fn: 获取操作后截图的异步函数。
            strategy: 验证策略。
            max_retries: 最大重试次数（覆盖默认值）。

        Returns:
            VerificationResult: 最终验证结果。
        """
        policy = self._retry_policy
        retries = max_retries if max_retries is not None else policy.max_retries

        for attempt in range(retries + 1):
            await action_fn()
            post_path = await post_screenshot_fn()

            result = await self.verify(
                action_description=action_description,
                post_path=post_path,
                strategy=strategy,
            )

            if result.success and result.confidence >= 0.7:
                return result

            if result.retry_suggested and attempt < retries:
                delay = min(
                    policy.base_delay * (policy.backoff_factor ** attempt),
                    policy.max_delay,
                )
                log.info(
                    "操作验证失败，自动重试",
                    attempt=attempt + 1,
                    delay=delay,
                    reason=result.evidence,
                )
                import asyncio
                await asyncio.sleep(delay)
                continue

            # 最后一次尝试仍失败（且非成功）→ 显式标记为重试耗尽，而非沿用最后一次结果。
            if attempt == retries and not result.success:
                return VerificationResult(
                    success=False,
                    confidence=0.0,
                    evidence=f"重试 {retries} 次后仍失败",
                    retry_suggested=False,
                    method="retry_exhausted",
                )
            return result

    def _select_strategy(self, target_region: str, question: str) -> str:
        """自动选择验证策略（含 VLM 离线降级）。

        降级链：
        1. 有 question → 优先 VLM，不可用则降级到 OCR+pixel 组合
        2. 有 target_region → OCR（LocalOCR 不可用时降级到 pixel）
        3. 默认 → pixel（始终可用，无需外部依赖）
        """
        if question:
            if self._vlm_available():
                return "vlm"
            return "ocr_pixel_fallback"
        if target_region:
            if self._local_ocr_available():
                return "ocr"
            return "pixel"
        return "pixel"

    def _vlm_available(self) -> bool:
        """检测 VLM (Vision Language Model) 是否可用。"""
        try:
            from agent.perception.vlm_call import vlmc
            return vlmc is not None
        except ImportError:
            return False

    def _local_ocr_available(self) -> bool:
        """检测 LocalOCR 是否可用。"""
        try:
            from agent.perception.local_ocr import LocalOCR
            ocr = LocalOCR()
            return len(ocr.available_engines) > 0
        except Exception:
            return False

    async def _verify_ocr_pixel_fallback(
        self,
        pre_path: str,
        post_path: str,
        target_region: str,
        threshold: float,
        question: str = "",
    ) -> VerificationResult:
        """VLM 不可用时的降级组合验证：LocalOCR + pixel_diff。

        策略：
        1. pixel_diff 检测屏幕是否变化（快速、无需外部依赖）
        2. LocalOCR 提取文字变化（语义级验证，需 PaddleOCR/Tesseract）
        3. 综合两者结果，pixel 有变化 AND OCR 有变化 → 高置信度成功
        4. 仅 pixel 变化 → 中置信度成功
        5. 均无变化 → 失败，建议重试
        """
        pixel_result = await self._verify_pixel(pre_path, post_path, target_region, threshold)

        ocr_result = await self._verify_ocr(pre_path, post_path, target_region)

        if pixel_result.success and ocr_result.success:
            return VerificationResult(
                success=True,
                confidence=max(pixel_result.confidence, ocr_result.confidence),
                evidence=f"[降级] OCR+pixel 组合验证: {pixel_result.evidence}; {ocr_result.evidence}",
                retry_suggested=False,
                method="ocr_pixel_fallback",
                diff_ratio=pixel_result.diff_ratio,
            )

        if pixel_result.success and not ocr_result.success:
            return VerificationResult(
                success=True,
                confidence=pixel_result.confidence * 0.8,
                evidence=f"[降级] pixel 检测变化但 OCR 未检测到文字变化: {pixel_result.evidence}",
                retry_suggested=False,
                method="ocr_pixel_fallback",
                diff_ratio=pixel_result.diff_ratio,
            )

        if not pixel_result.success and ocr_result.success:
            return VerificationResult(
                success=True,
                confidence=ocr_result.confidence * 0.7,
                evidence=f"[降级] OCR 检测文字变化但 pixel 差异低于阈值: {ocr_result.evidence}",
                retry_suggested=False,
                method="ocr_pixel_fallback",
                diff_ratio=pixel_result.diff_ratio,
            )

        return VerificationResult(
            success=False,
            confidence=0.0,
            evidence=f"[降级] OCR+pixel 均未检测到变化: {pixel_result.evidence}; {ocr_result.evidence}",
            retry_suggested=True,
            method="ocr_pixel_fallback",
            diff_ratio=pixel_result.diff_ratio,
        )

    async def _verify_pixel(
        self, pre_path: str, post_path: str, target_region: str, threshold: float,
    ) -> VerificationResult:
        """像素差异验证。"""
        if not pre_path or not post_path:
            return VerificationResult(
                success=False, confidence=0.0,
                evidence="缺少截图路径", method="pixel",
            )

        diff_ratio = self._compute_pixel_diff(pre_path, post_path, target_region)

        if diff_ratio < threshold:
            return VerificationResult(
                success=False,
                confidence=0.9,
                evidence=f"屏幕无显著变化（差异率={diff_ratio:.4f}，阈值={threshold}）",
                retry_suggested=True,
                method="pixel",
                diff_ratio=diff_ratio,
            )

        return VerificationResult(
            success=True,
            confidence=min(0.95, 0.5 + diff_ratio * 10),
            evidence=f"屏幕已变化（差异率={diff_ratio:.4f}）",
            retry_suggested=False,
            method="pixel",
            diff_ratio=diff_ratio,
        )

    async def _verify_ocr(
        self, pre_path: str, post_path: str, target_region: str,
    ) -> VerificationResult:
        """OCR 文字对比验证（优先 LocalOCR，降级 pytesseract）。"""
        try:
            pre_text, post_text, engine_used = await self._extract_ocr_texts(
                pre_path, post_path, target_region,
            )

            if pre_text == post_text:
                return VerificationResult(
                    success=False, confidence=0.8,
                    evidence=f"OCR({engine_used}): 文字无变化",
                    retry_suggested=True, method="ocr",
                )

            pre_words = set(pre_text.split())
            post_words = set(post_text.split())
            added = post_words - pre_words
            removed = pre_words - post_words

            evidence_parts = [f"OCR({engine_used}): 文字已变化"]
            if added:
                evidence_parts.append(f"新增: {' '.join(list(added)[:5])}")
            if removed:
                evidence_parts.append(f"消失: {' '.join(list(removed)[:5])}")

            return VerificationResult(
                success=True, confidence=0.85,
                evidence="; ".join(evidence_parts),
                retry_suggested=False, method="ocr",
            )

        except ImportError:
            return VerificationResult(
                success=False, confidence=0.0,
                evidence="OCR 引擎不可用（需 PaddleOCR 或 Tesseract）",
                method="ocr",
            )
        except Exception as e:
            log.debug("action_verifier 异常处理", error=str(e))
            return VerificationResult(
                success=False, confidence=0.0,
                evidence=f"OCR 验证失败: {e}", method="ocr",
            )

    async def _extract_ocr_texts(
        self, pre_path: str, post_path: str, target_region: str,
    ) -> tuple[str, str, str]:
        """提取前后截图的 OCR 文本，优先 LocalOCR，降级 pytesseract。

        Returns:
            (pre_text, post_text, engine_name)
        """
        try:
            from agent.perception.local_ocr import LocalOCR
            ocr = LocalOCR()
            if ocr.available_engines:
                region = target_region if target_region else ""
                pre_result = await ocr.recognize(pre_path, region=region)
                post_result = await ocr.recognize(post_path, region=region)
                return (
                    pre_result.text,
                    post_result.text,
                    pre_result.engine or ocr.best_engine,
                )
        except Exception as _exc:
            log_ignored(log, "action_verifier._extract_ocr_texts.local_ocr", _exc)

        import pytesseract
        from PIL import Image

        def _extract(path: str) -> str:
            img = Image.open(path)
            if target_region:
                try:
                    parts = [int(p.strip()) for p in target_region.split(",")]
                    if len(parts) == 4:
                        sw, sh = img.size
                        x1 = parts[0] * sw // 1000
                        y1 = parts[1] * sh // 1000
                        x2 = parts[2] * sw // 1000
                        y2 = parts[3] * sh // 1000
                        img = img.crop((x1, y1, x2, y2))
                except (ValueError, IndexError) as _exc:
                    log_ignored(log, "action_verifier._extract_ocr_texts.crop", _exc)
            return pytesseract.image_to_string(img, lang="chi_sim+eng").strip()

        pre_text = _extract(pre_path)
        post_text = _extract(post_path)
        return pre_text, post_text, "tesseract"

    async def _verify_vlm(self, pre_path: str, post_path: str, question: str) -> VerificationResult:
        """VLM 视觉模型验证。"""
        try:
            import base64
            import io

            from PIL import Image

            def _encode(path: str) -> str:
                img = Image.open(path)
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                return base64.b64encode(buf.getvalue()).decode()

            pre_b64 = _encode(pre_path)
            post_b64 = _encode(post_path)

            verify_question = (
                f"对比操作前后截图，判断操作是否成功。\n"
                f"操作: {question}\n"
                f"请回答: 1.是否成功 2.变化描述 3.异常位置"
            )

            from agent.perception.vlm_call import vlmc
            result = await vlmc.analyze(
                image_base64=pre_b64,
                question=verify_question,
            )

            if not result.success:
                return VerificationResult(
                    success=False, confidence=0.0,
                    evidence=f"VLM 调用失败: {result.error}", method="vlm",
                )

            response = result.text.lower()
            success = not any(kw in response for kw in ["未生效", "无变化", "失败", "no change"])

            return VerificationResult(
                success=success,
                confidence=0.9 if success else 0.6,
                evidence=f"VLM: {result.text[:200]}",
                retry_suggested=not success,
                method="vlm",
            )

        except ImportError:
            return VerificationResult(
                success=False, confidence=0.0,
                evidence="vision_tools 不可用", method="vlm",
            )
        except Exception as e:
            log.debug("action_verifier 异常处理", error=str(e))
            return VerificationResult(
                success=False, confidence=0.0,
                evidence=f"VLM 验证失败: {e}", method="vlm",
            )

    async def _verify_uia_diff(self) -> VerificationResult:
        """UIA 元素树差异验证。"""
        if not self._pre_uia_snapshot:
            return VerificationResult(
                success=False, confidence=0.0,
                evidence="缺少操作前 UIA 快照", method="uia_diff",
            )

        try:
            from agent.perception.uia_cache import UIAElementCache
            cache = UIAElementCache()
            current = await cache.refresh(force=True)

            if current is None:
                return VerificationResult(
                    success=False, confidence=0.0,
                    evidence="无法获取当前 UIA 树", method="uia_diff",
                )

            old_ids = {e.get("id", "") for e in self._pre_uia_snapshot}
            new_ids = {e.id for e in current.flat_elements}

            added = new_ids - old_ids
            removed = old_ids - new_ids

            if not added and not removed:
                return VerificationResult(
                    success=False, confidence=0.8,
                    evidence="UIA: 元素树无变化", retry_suggested=True, method="uia_diff",
                )

            evidence_parts = [f"UIA: 元素树已变化（+{len(added)}, -{len(removed)}）"]
            return VerificationResult(
                success=True, confidence=0.85,
                evidence="; ".join(evidence_parts),
                retry_suggested=False, method="uia_diff",
            )

        except Exception as e:
            log.debug("action_verifier 异常处理", error=str(e))
            return VerificationResult(
                success=False, confidence=0.0,
                evidence=f"UIA 差异验证失败: {e}", method="uia_diff",
            )

    def _compute_pixel_diff(self, pre_path: str, post_path: str, target_region: str = "") -> float:
        """计算两张截图的像素差异率。"""
        try:
            from PIL import Image

            img_pre = Image.open(pre_path).convert("L")
            img_post = Image.open(post_path).convert("L")

            if img_pre.size != img_post.size:
                img_post = img_post.resize(img_pre.size)

            if target_region:
                try:
                    parts = [int(p.strip()) for p in target_region.split(",")]
                    if len(parts) == 4:
                        sw, sh = img_pre.size
                        x1 = parts[0] * sw // 1000
                        y1 = parts[1] * sh // 1000
                        x2 = parts[2] * sw // 1000
                        y2 = parts[3] * sh // 1000
                        img_pre = img_pre.crop((x1, y1, x2, y2))
                        img_post = img_post.crop((x1, y1, x2, y2))
                except (ValueError, IndexError) as _exc:
                    log_ignored(log, "action_verifier._compute_pixel_diff.crop", _exc)

            try:
                import numpy as np
                arr_pre = np.array(img_pre, dtype=np.float32)
                arr_post = np.array(img_post, dtype=np.float32)
                diff = np.abs(arr_pre - arr_post)
                total = diff.size
                if total == 0:
                    return 0.0
                changed = np.count_nonzero(diff > 30)
                return changed / total
            except ImportError:
                pixels_pre = list(img_pre.getdata())
                pixels_post = list(img_post.getdata())
                total = len(pixels_pre)
                if total == 0:
                    return 0.0
                changed = sum(1 for a, b in zip(pixels_pre, pixels_post) if abs(a - b) > 30)
                return changed / total

        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return 0.5
