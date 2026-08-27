"""VisualGrounding — 文本描述到屏幕坐标的视觉定位。

将自然语言描述（如"确定按钮"、"文件菜单"）映射到屏幕上的
具体 UI 元素和坐标，支持 UIA 匹配、OCR 匹配和 VLM 定位。

Usage:
    from agent.perception.visual_grounding import VisualGrounding
    vg = VisualGrounding()
    result = await vg.locate("确定按钮")
    if result.target_found:
        logger.info(result.coordinates)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("visual_grounding")




@dataclass
class GroundingResult:
    """视觉定位结果。

    Attributes:
        target_found: 是否找到目标。
        element: 匹配的 UI 元素。
        coordinates: 目标中心坐标 (x, y)。
        confidence: 匹配置信度 (0-1)。
        alternatives: 备选元素列表。
        method: 定位方法（uia/ocr/vlm）。
    """

    target_found: bool = False
    element: dict[str, Any] | None = None
    coordinates: tuple[int, int] | None = None
    confidence: float = 0.0
    alternatives: list[dict[str, Any]] = field(default_factory=list)
    method: str = "unknown"


class VisualGrounding:
    """视觉定位器。

    三级定位策略：
    1. UIA 匹配：在 Accessibility Tree 中按名称/类型搜索（精确、零 GPU）
    2. OCR 匹配：在 OCR 文字区域中搜索（中等精度）
    3. VLM 定位：使用 Vision 模型定位（最灵活，需 API）

    Usage:
        vg = VisualGrounding()
        result = await vg.locate("确定按钮")
    """

    def __init__(self) -> None:
        self._uia_cache: Any = None

    async def locate(
        self,
        description: str,
        context: str = "desktop",
        prefer_method: str = "auto",
    ) -> GroundingResult:
        """定位目标元素。

        Args:
            description: 目标描述（如"确定按钮"、"文件菜单"）。
            context: 上下文（desktop/browser）。
            prefer_method: 首选方法（auto/uia/ocr/vlm）。

        Returns:
            GroundingResult: 定位结果。
        """
        if prefer_method == "auto":
            result = await self._locate_by_uia(description)
            if result.target_found and result.confidence >= 0.7:
                return result

            result = await self._locate_by_ocr(description)
            if result.target_found and result.confidence >= 0.5:
                return result

            result = await self._locate_by_vlm(description)
            return result

        if prefer_method == "uia":
            return await self._locate_by_uia(description)
        if prefer_method == "ocr":
            return await self._locate_by_ocr(description)
        if prefer_method == "vlm":
            return await self._locate_by_vlm(description)

        return GroundingResult(target_found=False, method="unknown")

    async def _locate_by_uia(self, description: str) -> GroundingResult:
        """通过 UIA 元素树匹配定位。"""
        try:
            from agent.perception.uia_cache import UIAElementCache

            if self._uia_cache is None:
                self._uia_cache = UIAElementCache()

            tree = await self._uia_cache.refresh()

            candidates: list[tuple[dict[str, Any], float]] = []
            desc_lower = description.lower()

            for elem in tree.flat_elements:
                score = self._compute_name_similarity(desc_lower, elem.name.lower())
                if score > 0:
                    candidates.append((elem.raw, score))

            if not candidates:
                return GroundingResult(target_found=False, method="uia")

            candidates.sort(key=lambda x: x[1], reverse=True)

            best_elem, best_score = candidates[0]
            coords = self._parse_coordinates(best_elem.get("bbox", ""))

            alternatives = [c[0] for c in candidates[1:4]]

            return GroundingResult(
                target_found=True,
                element=best_elem,
                coordinates=coords,
                confidence=best_score,
                alternatives=alternatives,
                method="uia",
            )

        except Exception as e:
            log.warning("UIA 定位失败", error=str(e))
            return GroundingResult(target_found=False, method="uia")

    async def _locate_by_ocr(self, description: str) -> GroundingResult:
        """通过 OCR 文字匹配定位。"""
        try:
            from agent.perception.uia_cache import UIAElementCache

            if self._uia_cache is None:
                self._uia_cache = UIAElementCache()

            tree = await self._uia_cache.refresh()

            if tree.source != "ocr":
                return GroundingResult(target_found=False, method="ocr")

            desc_lower = description.lower()
            candidates: list[tuple[dict[str, Any], float]] = []

            for elem in tree.flat_elements:
                name_lower = elem.name.lower()
                if desc_lower in name_lower or name_lower in desc_lower:
                    score = len(desc_lower) / max(len(name_lower), 1)
                    candidates.append((elem.raw, min(score, 1.0)))

            if not candidates:
                return GroundingResult(target_found=False, method="ocr")

            candidates.sort(key=lambda x: x[1], reverse=True)

            best_elem, best_score = candidates[0]
            coords = self._parse_coordinates(best_elem.get("bbox", ""))

            return GroundingResult(
                target_found=True,
                element=best_elem,
                coordinates=coords,
                confidence=best_score * 0.8,
                alternatives=[c[0] for c in candidates[1:4]],
                method="ocr",
            )

        except Exception as e:
            log.warning("OCR 定位失败", error=str(e))
            return GroundingResult(target_found=False, method="ocr")

    async def _locate_by_vlm(self, description: str) -> GroundingResult:
        """通过 VLM 视觉模型定位。"""
        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            controller = get_desktop_controller()
            screenshot_result = controller.screenshot_full()
            if not screenshot_result.success:
                return GroundingResult(target_found=False, method="vlm")

            import base64
            import io
            from PIL import Image

            img = Image.open(screenshot_result.image_path)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            img_b64 = base64.b64encode(buf.getvalue()).decode()

            w, h = img.size

            from agent.perception.vlm_call import vlmc
            result = await vlmc.locate_element(
                image_base64=img_b64,
                description=description,
                image_size=(w, h),
            )

            if not result.success:
                return GroundingResult(target_found=False, method="vlm")

            coords = self._parse_vlm_coordinates(result.text, w, h)
            if coords is None:
                return GroundingResult(
                    target_found=False,
                    confidence=0.3,
                    evidence=result.text[:200],
                    method="vlm",
                )

            return GroundingResult(
                target_found=True,
                coordinates=coords,
                confidence=0.75,
                evidence=result.text[:200],
                method="vlm",
            )

        except Exception as e:
            log.warning("VLM 定位失败", error=str(e))
            return GroundingResult(target_found=False, method="vlm")

    def _compute_name_similarity(self, desc: str, name: str) -> float:
        """计算描述与元素名称的相似度。

        Args:
            desc: 目标描述（小写）。
            name: 元素名称（小写）。

        Returns:
            相似度分数 (0-1)。
        """
        if not desc or not name:
            return 0.0

        if desc == name:
            return 1.0

        if desc in name:
            return 0.9

        if name in desc:
            return 0.8

        desc_words = set(desc.split())
        name_words = set(name.split())
        overlap = desc_words & name_words

        if not overlap:
            return 0.0

        return len(overlap) / max(len(desc_words), len(name_words)) * 0.7

    def _parse_coordinates(self, bbox: str) -> tuple[int, int] | None:
        """从边界框字符串解析中心坐标。

        Args:
            bbox: 边界框字符串 "(x1,y1,x2,y2)"。

        Returns:
            中心坐标 (x, y) 或 None。
        """
        if not bbox:
            return None

        try:
            bbox = bbox.strip("()")
            parts = [int(p.strip()) for p in bbox.split(",")]
            if len(parts) == 4:
                cx = (parts[0] + parts[2]) // 2
                cy = (parts[1] + parts[3]) // 2
                return (cx, cy)
        except (ValueError, IndexError) as _exc:
            log_ignored(log, "visual_grounding._parse_bbox_coordinates", _exc)

        return None

    def _parse_vlm_coordinates(self, response: str, img_w: int, img_h: int) -> tuple[int, int] | None:
        """从 VLM 响应中解析坐标。

        Args:
            response: VLM 响应文本。
            img_w: 截图宽度。
            img_h: 截图高度。

        Returns:
            坐标 (x, y) 或 None。
        """
        try:
            import json

            json_match = re.search(r'\{[^}]+\}', response)
            if json_match:
                data = json.loads(json_match.group())
                if data.get("found", False):
                    x = int(data.get("x", 0))
                    y = int(data.get("y", 0))
                    return (x, y)
        except (json.JSONDecodeError, ValueError) as _exc:
            log_ignored(log, "visual_grounding._parse_vlm_coordinates", _exc)

        coord_pattern = re.compile(r'(\d+)\s*[,\s]\s*(\d+)')
        matches = coord_pattern.findall(response)
        if matches:
            x, y = int(matches[0][0]), int(matches[0][1])
            if 0 <= x <= img_w and 0 <= y <= img_h:
                return (x, y)

        return None