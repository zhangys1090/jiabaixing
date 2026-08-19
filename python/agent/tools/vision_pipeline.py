"""Vision 多模态预处理管线 — 图片压缩、格式转换、批量理解、缓存去重。

统一 Vision 输入预处理入口，处理：
1. 图片压缩与格式转换（过大图片自动缩放）
2. 多图批量理解（多页PDF、多帧视频）
3. 相似图片去重（避免重复调用 Vision API）
4. 跨模态记忆检索闭环（历史 Vision 结果语义检索）

Usage:
    from agent.tools.vision_pipeline import VisionPipeline, VisionInput
    pipeline = VisionPipeline()
    result = await pipeline.understand(VisionInput(...), question="这张图里有什么？")
"""

from __future__ import annotations

import base64
import hashlib
import io
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("vision_pipeline")

try:
    from PIL import Image

    HAS_PIL = True
except ImportError:
    HAS_PIL = False

MAX_IMAGE_SIZE = 20 * 1024 * 1024
MAX_DIMENSION = 4096
JPEG_QUALITY = 85
THUMBNAIL_SIZE = (512, 512)


@dataclass
class VisionInput:
    """统一 Vision 输入——支持图片/文件/截图/视频帧。

    Attributes:
        source_type: 来源类型 ("image", "screenshot", "pdf_page", "video_frame", "file")
        image_data: 图片二进制数据
        mime_type: MIME 类型
        metadata: 附加元数据（来源路径、页码、帧号等）
    """

    source_type: str = "image"
    image_data: bytes = b""
    mime_type: str = "image/png"
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.image_data).hexdigest()[:16]

    @property
    def size_bytes(self) -> int:
        return len(self.image_data)


@dataclass
class VisionResult:
    """Vision 理解结果。

    Attributes:
        content: 理解结果文本。
        content_hash: 输入图片哈希，用于去重缓存。
        model: 使用的 Vision 模型。
        source_type: 来源类型。
        metadata: 附加元数据。
    """

    content: str
    content_hash: str
    model: str
    source_type: str = "image"
    metadata: dict[str, Any] = field(default_factory=dict)


class VisionPipeline:
    """Vision 预处理管线。

    处理流程：
    1. 预处理（压缩/缩放/格式转换）
    2. 去重检查（相同图片不重复调用 API）
    3. 送入 Vision 模型理解
    4. 结果写入跨模态记忆
    """

    _cache: dict[str, VisionResult] = {}

    @classmethod
    def clear_cache(cls) -> None:
        cls._cache.clear()

    @classmethod
    def cache_size(cls) -> int:
        return len(cls._cache)

    async def preprocess(self, input: VisionInput) -> VisionInput:
        """预处理 Vision 输入：压缩过大图片、转换格式。

        Args:
            input: 原始 Vision 输入。

        Returns:
            VisionInput: 预处理后的输入（可能被压缩/转换）。
        """
        if not HAS_PIL:
            log.warning("Pillow 未安装，跳过图片预处理。pip install Pillow")
            return input

        if input.size_bytes > MAX_IMAGE_SIZE:
            input = await self._compress_image(input)

        if input.size_bytes > MAX_IMAGE_SIZE:
            input = await self._resize_image(input)

        return input

    async def _compress_image(self, input: VisionInput) -> VisionInput:
        """JPEG 压缩减少体积。"""
        try:
            img = Image.open(io.BytesIO(input.image_data))
            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            compressed = buf.getvalue()

            log.debug(
                "图片已压缩",
                original_size=input.size_bytes,
                compressed_size=len(compressed),
                ratio=f"{len(compressed) / input.size_bytes * 100:.1f}%",
            )
            return VisionInput(
                source_type=input.source_type,
                image_data=compressed,
                mime_type="image/jpeg",
                metadata=input.metadata,
            )
        except Exception as exc:
            log.warning("图片压缩失败", error=str(exc))
            return input

    async def _resize_image(self, input: VisionInput) -> VisionInput:
        """缩放过大图片。"""
        try:
            img = Image.open(io.BytesIO(input.image_data))
            img.thumbnail(THUMBNAIL_SIZE, Image.LANCZOS)

            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)

            log.debug(
                "图片已缩放",
                original_size=input.size_bytes,
                resized_size=buf.tell(),
            )
            return VisionInput(
                source_type=input.source_type,
                image_data=buf.getvalue(),
                mime_type="image/jpeg",
                metadata=input.metadata,
            )
        except Exception as exc:
            log.warning("图片缩放失败", error=str(exc))
            return input

    def check_cache(self, input: VisionInput) -> VisionResult | None:
        """检查缓存：相同图片不重复调用 Vision API。

        Args:
            input: Vision 输入。

        Returns:
            VisionResult | None: 缓存命中时返回已有结果，否则返回 None。
        """
        return self._cache.get(input.content_hash)

    def cache_result(self, input: VisionInput, result: VisionResult) -> None:
        """缓存 Vision 结果。"""
        self._cache[input.content_hash] = result

    async def batch_understand(
        self,
        inputs: list[VisionInput],
        question: str,
        model: str = "gpt-4o",
        vision_executor: Any = None,
    ) -> list[VisionResult]:
        """批量理解多张图片。

        处理流程：
        1. 逐张预处理
        2. 去重检查
        3. 调用 Vision 模型
        4. 缓存结果

        Args:
            inputs: Vision 输入列表。
            question: 对每张图片的提问。
            model: Vision 模型名称。
            vision_executor: Vision 理解执行器（可注入，默认从 vision_tools 获取）。

        Returns:
            list[VisionResult]: 每张图片的理解结果。
        """
        results: list[VisionResult] = []

        for i, input in enumerate(inputs):
            processed = await self.preprocess(input)

            cached = self.check_cache(processed)
            if cached is not None:
                log.debug(
                    "Vision 缓存命中",
                    index=i,
                    content_hash=processed.content_hash,
                )
                results.append(cached)
                continue

            try:
                if vision_executor is not None:
                    content = await vision_executor(processed, question, model)
                else:
                    content = await self._default_understand(processed, question, model)
            except Exception as exc:
                log.error(
                    "Vision 理解失败",
                    index=i,
                    error=str(exc),
                )
                content = f"[Vision 理解失败: {exc}]"

            result = VisionResult(
                content=content,
                content_hash=processed.content_hash,
                model=model,
                source_type=processed.source_type,
                metadata=processed.metadata,
            )
            self.cache_result(processed, result)
            results.append(result)

        return results

    async def _default_understand(
        self,
        input: VisionInput,
        question: str,
        model: str,
    ) -> str:
        """默认 Vision 理解（直接调用 VLM 原生层）。

        当未提供 vision_executor 时使用此后备方案。
        """
        try:
            from agent.perception.vlm_call import vlmc

            result = await vlmc.analyze(
                image_bytes=input.image_data,
                question=question,
                model=model,
            )
            return result.text if result.success else f"[Vision 失败: {result.error}]"
        except Exception as exc:
            return f"[Vision 调用异常: {exc}]"

    async def try_store_memory(
        self,
        result: VisionResult,
        image_path: str | None = None,
    ) -> None:
        """将 Vision 结果异步写入跨模态记忆（失败不影响主流程）。

        Args:
            result: Vision 理解结果。
            image_path: 本地图像路径（可选）。
        """
        try:
            from agent.main import engine

            if not engine or not getattr(engine, "memory", None):
                return
            memory = engine.memory
            await memory.store_multimodal(
                content=result.content,
                image_path=image_path,
                memory_type="long_term",
                scene="vision_understand",
                emotion="neutral",
                metadata={
                    "source": "vision_pipeline",
                    "vision_model": result.model,
                    "content_hash": result.content_hash,
                    "source_type": result.source_type,
                },
            )
            log.debug("Vision 结果已写入跨模态记忆", content_hash=result.content_hash)
        except Exception as exc:
            log.warning("Vision 结果写入跨模态记忆失败", error=str(exc))
