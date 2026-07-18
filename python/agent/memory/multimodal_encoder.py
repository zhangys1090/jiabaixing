"""多模态联合编码器，实现文本与图像的跨模态嵌入。

遵循 AGENTS.md 0.1 模块归属：记忆系统主实现端为 Python。
TS 侧 MultimodalProvider.jointEncode 使用 char hash 伪向量（非 CLIP），
本模块在 Python 端实现真正的跨模态联合编码（CLIP / sentence-transformers），
并提供三级降级策略保证可测试性与可用性。

降级策略:
    1. 首选: sentence-transformers 的 clip-ViT-B-32 多模态模型（文本+图像同一向量空间）。
    2. 降级1: sentence-transformers 文本模型（all-MiniLM-L6-v2）+ 图像特征哈希。
    3. 降级2: 文本哈希 + 图像哈希（与 TS 侧 char hash 等价，最后兜底）。

测试时通过 config.model_name = "fallback" 强制降级模式，不下载真实模型。
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("multimodal_encoder")

# ─── 模块级常量 ───
_DEFAULT_MODEL = "clip-ViT-B-32"  # 默认多模态模型
_FALLBACK_TEXT_MODEL = "all-MiniLM-L6-v2"  # 降级1：纯文本模型
_FALLBACK_MODEL_NAME = "fallback"  # 特殊值：强制降级模式（用于测试/无模型环境）
_HASH_VECTOR_SIZE = 128  # 降级2模式的哈希向量维度
_DEFAULT_BATCH_SIZE = 16  # 默认批量编码批次大小


class ModalityType(str, Enum):
    """模态类型枚举，区分文本与图像。

    用于 EncodedVector 标识向量所属模态，支持跨模态检索时区分来源。
    """

    TEXT = "text"
    IMAGE = "image"


@dataclass
class EncodedVector:
    """编码后的向量表示，包含向量数据与元信息。

    Attributes:
        vector: 嵌入向量（已 L2 归一化）。
        modality: 模态类型（TEXT / IMAGE）。
        content_hash: 内容哈希，用于缓存键与去重。
        model_name: 编码使用的模型名称（含降级标识）。
        dimensions: 向量维度。
    """

    vector: list[float] = field(default_factory=list)
    modality: ModalityType = ModalityType.TEXT
    content_hash: str = ""
    model_name: str = ""
    dimensions: int = 0


@dataclass
class MultimodalEncoderConfig:
    """多模态编码器配置。

    Attributes:
        model_name: 模型名称，"fallback" 表示强制降级模式（不下载模型）。
        cache_enabled: 是否启用向量缓存（避免重复编码）。
        batch_size: 批量编码批次大小。
        fallback_to_hash: 当模型不可用时是否降级到哈希模式。
    """

    model_name: str = _DEFAULT_MODEL
    cache_enabled: bool = True
    batch_size: int = _DEFAULT_BATCH_SIZE
    fallback_to_hash: bool = True


class MultimodalEncoder:
    """多模态联合编码器，支持文本/图像跨模态嵌入。

    遵循"Python 主实现"原则，提供真正的跨模态向量空间映射，
    支持用文本查询图像、用图像查询文本。模型惰性加载，构造时不下载模型，
    首次编码时才尝试加载；加载失败自动降级到哈希模式。

    Attributes:
        _config: 编码器配置。
        _model: 已加载的 sentence-transformers 模型实例（惰性加载）。
        _model_loaded: 模型是否已尝试加载（避免重复尝试）。
        _mode: 当前编码模式（"clip" / "text_fallback" / "hash"）。
        _cache: 向量缓存，键为 (content_hash, modality)。

    Usage:
        config = MultimodalEncoderConfig(model_name="fallback")
        encoder = MultimodalEncoder(config)
        vec = encoder.encode_text("你好世界")
    """

    def __init__(self, config: MultimodalEncoderConfig | None = None) -> None:
        """初始化多模态编码器。

        Args:
            config: 编码器配置，为 None 时使用默认配置。
        """
        self._config = config or MultimodalEncoderConfig()
        self._model: Any = None
        self._model_loaded: bool = False
        self._mode: str = "unknown"  # "clip" / "text_fallback" / "hash"
        self._cache: dict[tuple[str, ModalityType], EncodedVector] = {}
        # 若配置强制降级，直接标记为 hash 模式，跳过模型加载
        if self._config.model_name.lower() == _FALLBACK_MODEL_NAME:
            self._mode = "hash"
            self._model_loaded = True

    def encode_text(self, text: str) -> EncodedVector:
        """编码文本为向量。

        Args:
            text: 待编码的文本内容。

        Returns:
            EncodedVector: 编码后的向量（已 L2 归一化）。

        Raises:
            ValueError: 当 text 为空字符串时抛出。
        """
        if not text:
            raise ValueError("text 不能为空")

        cache_key = self._get_cache_key(text, ModalityType.TEXT)
        if self._config.cache_enabled and cache_key in self._cache:
            return self._cache[cache_key]

        # 惰性加载模型
        self._load_model()

        if self._mode == "clip" and self._model is not None:
            vector = self._model.encode(text, convert_to_numpy=True).tolist()
            model_name = self._config.model_name
        elif self._mode == "text_fallback" and self._model is not None:
            vector = self._model.encode(text, convert_to_numpy=True).tolist()
            model_name = _FALLBACK_TEXT_MODEL
        else:
            # 降级到哈希
            vector = self._fallback_encode_text(text)
            model_name = "hash_fallback"

        vector = self._normalize(vector)
        result = EncodedVector(
            vector=vector,
            modality=ModalityType.TEXT,
            content_hash=cache_key[0],
            model_name=model_name,
            dimensions=len(vector),
        )
        if self._config.cache_enabled:
            self._cache[cache_key] = result
        return result

    def encode_image(self, image_path_or_url: str) -> EncodedVector:
        """编码图像为向量。

        支持本地文件路径或 HTTP/HTTPS URL。URL 模式仅在 CLIP 模式下可用，
        降级模式下仅支持本地文件。

        Args:
            image_path_or_url: 图像本地路径或 URL。

        Returns:
            EncodedVector: 编码后的向量（已 L2 归一化）。

        Raises:
            ValueError: 当路径为空字符串时抛出。
            FileNotFoundError: 当本地文件不存在时抛出。
        """
        if not image_path_or_url:
            raise ValueError("image_path_or_url 不能为空")

        cache_key = self._get_cache_key(image_path_or_url, ModalityType.IMAGE)
        if self._config.cache_enabled and cache_key in self._cache:
            return self._cache[cache_key]

        self._load_model()

        if self._mode == "clip" and self._model is not None:
            # CLIP 模式：使用 PIL 加载图像后编码
            try:
                from PIL import Image  # type: ignore[import-untyped]

                path = self._resolve_image_path(image_path_or_url)
                img = Image.open(path)
                vector = self._model.encode(img, convert_to_numpy=True).tolist()
                model_name = self._config.model_name
            except Exception as exc:
                log.warning("CLIP 图像编码失败，降级到哈希", error=str(exc))
                vector = self._fallback_encode_image(image_path_or_url)
                model_name = "hash_fallback"
        else:
            vector = self._fallback_encode_image(image_path_or_url)
            model_name = "hash_fallback"

        vector = self._normalize(vector)
        result = EncodedVector(
            vector=vector,
            modality=ModalityType.IMAGE,
            content_hash=cache_key[0],
            model_name=model_name,
            dimensions=len(vector),
        )
        if self._config.cache_enabled:
            self._cache[cache_key] = result
        return result

    def encode_batch(
        self, items: list[tuple[ModalityType, str]]
    ) -> list[EncodedVector]:
        """批量编码文本/图像。

        Args:
            items: 待编码项列表，每项为 (模态类型, 内容) 元组。

        Returns:
            list[EncodedVector]: 编码结果列表，顺序与输入一致。

        Raises:
            ValueError: 当遇到不支持的模态类型时抛出。
        """
        results: list[EncodedVector] = []
        for modality, content in items:
            if modality == ModalityType.TEXT:
                results.append(self.encode_text(content))
            elif modality == ModalityType.IMAGE:
                results.append(self.encode_image(content))
            else:
                raise ValueError(f"不支持的模态类型: {modality}")
        return results

    @property
    def current_mode(self) -> str:
        """返回当前编码模式（"clip" / "text_fallback" / "hash" / "unknown"）。

        供外部检测编码器所处模式，判断向量维度兼容性。
        """
        return self._mode

    def cross_modal_search(
        self,
        query_vector: EncodedVector,
        candidates: list[EncodedVector],
        top_k: int = 10,
    ) -> list[tuple[EncodedVector, float]]:
        """跨模态搜索：用查询向量在候选向量中检索最相似项。

        支持跨模态检索（如用文本向量查图像向量），前提是两者在同一向量空间。
        CLIP 模式下文本与图像天然同空间；降级模式下相似度可能偏低但不报错。
        维度不匹配时截断到公共维度计算并记录告警日志。

        Args:
            query_vector: 查询向量。
            candidates: 候选向量列表。
            top_k: 返回的最大结果数。

        Returns:
            list[tuple[EncodedVector, float]]: 按相似度降序排列的 (向量, 相似度) 列表。
        """
        if not candidates:
            return []
        query_dim = query_vector.dimensions
        query_model = query_vector.model_name
        dim_mismatch_logged = False
        scored: list[tuple[EncodedVector, float]] = []
        for c in candidates:
            if c.dimensions != query_dim and not dim_mismatch_logged:
                log.warning(
                    "跨模态检索维度不匹配",
                    query_dim=query_dim,
                    candidate_dim=c.dimensions,
                    query_model=query_model,
                    candidate_model=c.model_name,
                    hint="将截断到公共维度计算，相似度可能偏低",
                )
                dim_mismatch_logged = True
            sim = self.cosine_similarity(query_vector.vector, c.vector)
            scored.append((c, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]

    @staticmethod
    def cosine_similarity(v1: list[float], v2: list[float]) -> float:
        """计算两个向量的余弦相似度。

        当维度不匹配时，截断到公共维度计算（而非返回 0.0），
        避免跨编码模式（如 CLIP 512维 vs 哈希 128维）检索全盘失效。
        截断后相似度为子空间投影近似，可能偏低但不会静默返回空结果。

        Args:
            v1: 第一个向量。
            v2: 第二个向量。

        Returns:
            float: 余弦相似度，范围 [-1, 1]；零向量返回 0.0。
        """
        if not v1 or not v2:
            return 0.0
        min_dim = min(len(v1), len(v2))
        if min_dim == 0:
            return 0.0
        v1_proj = v1[:min_dim]
        v2_proj = v2[:min_dim]
        dot = sum(x * y for x, y in zip(v1_proj, v2_proj))
        norm1 = math.sqrt(sum(x * x for x in v1_proj))
        norm2 = math.sqrt(sum(x * x for x in v2_proj))
        if norm1 == 0 or norm2 == 0:
            return 0.0
        return dot / (norm1 * norm2)

    def _load_model(self) -> None:
        """惰性加载 sentence-transformers 模型。

        加载策略:
            1. 若 config.model_name == "fallback"，直接使用 hash 模式。
            2. 尝试加载 CLIP 多模态模型。
            3. CLIP 失败则尝试加载纯文本模型（text_fallback）。
            4. 全部失败则使用 hash 模式（最终兜底）。

        此方法不抛出异常，所有失败均优雅降级。
        """
        if self._model_loaded:
            return
        self._model_loaded = True

        if self._config.model_name.lower() == _FALLBACK_MODEL_NAME:
            self._mode = "hash"
            return

        # 尝试加载 CLIP 多模态模型
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore[import-untyped]

            log.info("加载多模态模型", model=self._config.model_name)
            self._model = SentenceTransformer(self._config.model_name)
            self._mode = "clip"
            log.info("多模态模型加载成功", mode=self._mode)
        except Exception as exc:
            log.warning("CLIP 模型加载失败，尝试文本降级", error=str(exc))
            if not self._config.fallback_to_hash:
                return
            # 尝试加载纯文本模型
            try:
                from sentence_transformers import SentenceTransformer  # type: ignore[import-untyped]

                self._model = SentenceTransformer(_FALLBACK_TEXT_MODEL)
                self._mode = "text_fallback"
                log.info("文本降级模型加载成功", mode=self._mode)
            except Exception as exc2:
                log.warning("文本降级模型加载失败，使用哈希模式", error=str(exc2))
                self._model = None
                self._mode = "hash"

    def _fallback_encode_text(self, text: str) -> list[float]:
        """降级模式文本编码：基于字符哈希的伪向量。

        与 TS 侧 MultimodalProvider.textToVector 算法等价，作为最后兜底方案。
        通过字符 charCode 的 sin/cos 哈希生成定长向量。

        Args:
            text: 待编码文本。

        Returns:
            list[float]: 128 维伪向量（未归一化）。
        """
        vector = [0.0] * _HASH_VECTOR_SIZE
        for i, ch in enumerate(text):
            char_code = ord(ch)
            idx = i % _HASH_VECTOR_SIZE
            vector[idx] += math.sin(char_code * (i + 1) * 0.01)
            vector[(idx + 1) % _HASH_VECTOR_SIZE] += math.cos(
                char_code * (i + 1) * 0.01
            )
        return vector

    def _fallback_encode_image(self, image_path_or_url: str) -> list[float]:
        """降级模式图像编码：基于图像特征哈希的伪向量。

        优先使用 PIL 提取颜色直方图 + 边缘特征（共 128 维）；
        PIL 不可用或文件损坏时回退到字节哈希。

        Args:
            image_path_or_url: 图像本地路径。

        Returns:
            list[float]: 128 维伪向量（未归一化）。
        """
        path = self._resolve_image_path(image_path_or_url)
        try:
            from PIL import Image  # type: ignore[import-untyped]

            img = Image.open(path).convert("RGB").resize((32, 32))
            # 颜色直方图（64 维）
            hist = img.histogram()[:64]
            # 边缘特征（64 维）：简单梯度累加
            pixels = list(img.getdata())
            edge_features = [0.0] * 64
            for y in range(31):
                for x in range(31):
                    idx = y * 32 + x
                    r1, g1, b1 = pixels[idx]
                    r2, g2, b2 = pixels[idx + 1]
                    r3, g3, b3 = pixels[idx + 32]
                    grad = (
                        abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2)
                        + abs(r1 - r3) + abs(g1 - g3) + abs(b1 - b3)
                    )
                    edge_idx = (x + y) % 64
                    edge_features[edge_idx] += float(grad)
            hist_sum = max(1, sum(hist))
            hist_norm = [float(h) / hist_sum for h in hist]
            edge_max = max(edge_features) if edge_features else 1.0
            if edge_max == 0:
                edge_max = 1.0
            edge_norm = [e / edge_max for e in edge_features]
            return hist_norm + edge_norm
        except Exception as exc:
            log.debug("PIL 图像编码失败，使用字节哈希", error=str(exc))
            return self._byte_hash_vector(path)

    def _byte_hash_vector(self, path: str) -> list[float]:
        """字节哈希伪向量，最后兜底方案（无 PIL 时使用）。

        Args:
            path: 文件路径。

        Returns:
            list[float]: 128 维伪向量。
        """
        try:
            with open(path, "rb") as f:
                data = f.read()
        except Exception:
            data = path.encode("utf-8")
        vector = [0.0] * _HASH_VECTOR_SIZE
        # 最多取前 1KB，避免大文件性能问题
        for i, b in enumerate(data[:1024]):
            idx = i % _HASH_VECTOR_SIZE
            vector[idx] += math.sin(b * (i + 1) * 0.1)
            vector[(idx + 1) % _HASH_VECTOR_SIZE] += math.cos(b * (i + 1) * 0.1)
        return vector

    def _get_cache_key(
        self, content: str, modality: ModalityType
    ) -> tuple[str, ModalityType]:
        """生成缓存键。

        Args:
            content: 内容文本或图像路径。
            modality: 模态类型。

        Returns:
            tuple[str, ModalityType]: (内容 MD5 哈希, 模态类型)。
        """
        h = hashlib.md5(content.encode("utf-8")).hexdigest()
        return (h, modality)

    @staticmethod
    def _normalize(vector: list[float]) -> list[float]:
        """L2 归一化向量。

        Args:
            vector: 待归一化向量。

        Returns:
            list[float]: 归一化后的向量；零向量返回原向量。
        """
        norm = math.sqrt(sum(x * x for x in vector))
        if norm == 0:
            return vector
        return [x / norm for x in vector]

    @staticmethod
    def _resolve_image_path(image_path_or_url: str) -> str:
        """解析图像路径，URL 返回原值，本地路径校验存在性。

        Args:
            image_path_or_url: 图像路径或 URL。

        Returns:
            str: 解析后的路径。

        Raises:
            FileNotFoundError: 本地文件不存在时抛出。
        """
        if image_path_or_url.startswith(("http://", "https://")):
            return image_path_or_url
        p = Path(image_path_or_url)
        if not p.exists():
            raise FileNotFoundError(f"图像文件不存在: {image_path_or_url}")
        return str(p)


# ─── 模块级单例，便于全局复用 ───
_encoder_instance: MultimodalEncoder | None = None


def get_multimodal_encoder(
    config: MultimodalEncoderConfig | None = None,
) -> MultimodalEncoder:
    """获取全局多模态编码器单例。

    Args:
        config: 编码器配置，仅在首次创建时生效。

    Returns:
        MultimodalEncoder: 编码器实例。
    """
    global _encoder_instance
    if _encoder_instance is None:
        _encoder_instance = MultimodalEncoder(config)
    return _encoder_instance


def reset_multimodal_encoder() -> None:
    """重置全局编码器单例。

    主要用于测试场景，确保每个测试用例获得独立的编码器实例。
    """
    global _encoder_instance
    _encoder_instance = None
