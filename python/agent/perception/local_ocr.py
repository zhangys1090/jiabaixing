"""LocalOCR — 本地文字识别引擎。

封装 Tesseract / PaddleOCR 引擎，提供统一的 OCR 接口，
减少对 Vision API 的依赖，加速桌面自动化感知。

Usage:
    from agent.perception.local_ocr import LocalOCR
    ocr = LocalOCR()
    result = await ocr.recognize("screenshot.png")
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("local_ocr")




@dataclass
class OCRResult:
    """OCR 识别结果。

    Attributes:
        text: 识别的完整文本。
        blocks: 文本块列表（含位置和置信度）。
        engine: 使用的引擎名称。
        duration_ms: 识别耗时（毫秒）。
    """

    text: str = ""
    blocks: list[dict[str, Any]] = field(default_factory=list)
    engine: str = "none"
    duration_ms: float = 0.0


class LocalOCR:
    """本地 OCR 引擎管理器。

    自动检测可用的 OCR 引擎（Tesseract / PaddleOCR），
    按优先级选择最佳引擎。

    引擎优先级：
    1. PaddleOCR：中文识别精度高，GPU 加速
    2. Tesseract：通用 OCR，CPU 即可运行

    Usage:
        ocr = LocalOCR()
        result = await ocr.recognize("screenshot.png")
        logger.info(result.text)
    """

    def __init__(self, preferred_engine: str = "auto", language: str = "chi_sim+eng") -> None:
        self._preferred_engine = preferred_engine
        self._language = language
        self._available_engines: list[str] = []
        self._paddle_instance: Any = None
        self._detect_engines()

    @property
    def available_engines(self) -> list[str]:
        return list(self._available_engines)

    @property
    def best_engine(self) -> str:
        if not self._available_engines:
            return "none"
        return self._available_engines[0]

    async def recognize(self, image_path: str, region: str = "") -> OCRResult:
        """识别图片中的文字。

        Args:
            image_path: 图片文件路径。
            region: 识别区域 (x1,y1,x2,y2)，空字符串表示全图。

        Returns:
            OCRResult: 识别结果。
        """
        start = time.monotonic()

        if not self._available_engines:
            return OCRResult(engine="none", duration_ms=(time.monotonic() - start) * 1000)

        engine = self._select_engine()

        if engine == "paddle":
            result = await self._recognize_paddle(image_path, region)
        elif engine == "tesseract":
            result = await self._recognize_tesseract(image_path, region)
        else:
            result = OCRResult(engine="none")

        result.duration_ms = (time.monotonic() - start) * 1000
        return result

    async def recognize_region(self, image_path: str, x1: int, y1: int, x2: int, y2: int) -> OCRResult:
        """识别图片指定区域的文字。

        Args:
            image_path: 图片文件路径。
            x1, y1, x2, y2: 区域坐标。

        Returns:
            OCRResult: 识别结果。
        """
        return await self.recognize(image_path, region=f"{x1},{y1},{x2},{y2}")

    def _detect_engines(self) -> None:
        """检测可用的 OCR 引擎。"""
        engines: list[str] = []

        try:
            import paddleocr
            engines.append("paddle")
            log.debug("LocalOCR: PaddleOCR 可用")
        except ImportError as _exc:
            log_ignored(log, "local_ocr._detect_engines.paddle", _exc)

        try:
            import pytesseract
            engines.append("tesseract")
            log.debug("LocalOCR: Tesseract 可用")
        except ImportError as _exc:
            log_ignored(log, "local_ocr._detect_engines.tesseract", _exc)

        if self._preferred_engine != "auto" and self._preferred_engine in engines:
            engines.remove(self._preferred_engine)
            engines.insert(0, self._preferred_engine)

        self._available_engines = engines
        log.debug("LocalOCR 引擎检测完成", available=engines)

    def _select_engine(self) -> str:
        """选择 OCR 引擎。"""
        if self._available_engines:
            return self._available_engines[0]
        return "none"

    async def _recognize_paddle(self, image_path: str, region: str) -> OCRResult:
        """PaddleOCR 识别。"""
        try:
            import asyncio

            if self._paddle_instance is None:
                import paddleocr
                self._paddle_instance = paddleocr.PaddleOCR(
                    use_angle_cls=True,
                    lang="ch",
                    show_log=False,
                )

            def _sync_recognize() -> list[Any]:
                return self._paddle_instance.ocr(image_path, cls=True)

            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(None, _sync_recognize)

            blocks: list[dict[str, Any]] = []
            text_parts: list[str] = []

            if results and results[0]:
                for line in results[0]:
                    bbox = line[0]
                    text = line[1][0]
                    confidence = line[1][1]

                    x_coords = [p[0] for p in bbox]
                    y_coords = [p[1] for p in bbox]
                    x1 = int(min(x_coords))
                    y1 = int(min(y_coords))
                    x2 = int(max(x_coords))
                    y2 = int(max(y_coords))

                    blocks.append({
                        "text": text,
                        "confidence": confidence,
                        "bbox": (x1, y1, x2, y2),
                    })
                    text_parts.append(text)

            return OCRResult(
                text="\n".join(text_parts),
                blocks=blocks,
                engine="paddle",
            )

        except Exception as e:
            log.warning("PaddleOCR 识别失败", error=str(e))
            if "tesseract" in self._available_engines:
                return await self._recognize_tesseract(image_path, region)
            return OCRResult(engine="paddle")

    async def _recognize_tesseract(self, image_path: str, region: str) -> OCRResult:
        """Tesseract OCR 识别。"""
        try:
            import pytesseract
            from PIL import Image

            img = Image.open(image_path)

            if region:
                try:
                    parts = [int(p.strip()) for p in region.split(",")]
                    if len(parts) == 4:
                        img = img.crop(tuple(parts))
                except (ValueError, IndexError) as _exc:
                    log_ignored(log, "local_ocr._recognize_tesseract.crop", _exc)

            data = pytesseract.image_to_data(
                img, output_type=pytesseract.Output.DICT, lang=self._language,
            )

            blocks: list[dict[str, Any]] = []
            text_parts: list[str] = []

            for i in range(len(data["text"])):
                text = data["text"][i].strip()
                if not text:
                    continue

                conf = float(data["conf"][i]) if data["conf"][i] != "-1" else 0.0
                x = data["left"][i]
                y = data["top"][i]
                w = data["width"][i]
                h = data["height"][i]

                blocks.append({
                    "text": text,
                    "confidence": conf / 100.0 if conf > 1 else conf,
                    "bbox": (x, y, x + w, y + h),
                })
                text_parts.append(text)

            return OCRResult(
                text=" ".join(text_parts),
                blocks=blocks,
                engine="tesseract",
            )

        except Exception as e:
            log.warning("Tesseract 识别失败", error=str(e))
            return OCRResult(engine="tesseract")
