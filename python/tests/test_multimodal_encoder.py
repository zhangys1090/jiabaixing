"""多模态联合编码器测试套件。

测试规则:
    - 必须使用降级模式（config.model_name = "fallback"），不下载真实 CLIP 模型。
    - 不依赖真实图像文件，使用临时生成的 PNG。
    - 所有测试可独立运行，无外部网络/模型依赖。

覆盖差距报告 #12：Python 端实现真正的跨模态联合编码，
对比 TS 侧 MultimodalProvider.jointEncode 的 char hash 伪向量方案。
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

import pytest

from agent.memory.multimodal_encoder import (
    EncodedVector,
    ModalityType,
    MultimodalEncoder,
    MultimodalEncoderConfig,
    get_multimodal_encoder,
    reset_multimodal_encoder,
)


def _make_minimal_png(
    width: int = 4, height: int = 4, rgb: tuple[int, int, int] = (255, 0, 0)
) -> bytes:
    """生成最小 PNG 文件字节（无 PIL 依赖）。

    用于测试时生成临时图像，避免依赖真实图像文件。

    Args:
        width: 图像宽度（像素）。
        height: 图像高度（像素）。
        rgb: 像素 RGB 颜色值。

    Returns:
        bytes: 完整的 PNG 文件字节数据。
    """

    def _chunk(chunk_type: bytes, data: bytes) -> bytes:
        """构造 PNG chunk（含长度、类型、数据、CRC）。"""
        c = chunk_type + data
        crc = struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack(">I", len(data)) + c + crc

    # PNG 文件签名
    sig = b"\x89PNG\r\n\x1a\n"
    # IHDR: 宽、高、位深度 8、颜色类型 2（RGB）、压缩 0、滤波 0、隔行 0
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    # 像素数据：每行前加滤波字节 0（None）
    raw = b""
    for _ in range(height):
        raw += b"\x00"
        raw += bytes(rgb) * width
    idat = zlib.compress(raw)
    return sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


@pytest.fixture
def fallback_encoder() -> MultimodalEncoder:
    """返回强制降级模式的编码器实例（不下载真实模型）。"""
    config = MultimodalEncoderConfig(model_name="fallback", cache_enabled=True)
    return MultimodalEncoder(config)


@pytest.fixture
def sample_image_path(tmp_path: Path) -> Path:
    """生成临时 PNG 图像文件并返回路径。"""
    img_path = tmp_path / "test.png"
    img_path.write_bytes(_make_minimal_png(4, 4, (255, 0, 0)))
    return img_path


class TestMultimodalEncoder:
    """多模态编码器核心功能测试。"""

    def test_encode_text_returns_vector(
        self, fallback_encoder: MultimodalEncoder
    ) -> None:
        """测试文本编码返回合法的 EncodedVector。"""
        result = fallback_encoder.encode_text("你好世界")
        assert isinstance(result, EncodedVector)
        assert result.modality == ModalityType.TEXT
        assert result.dimensions > 0
        assert len(result.vector) == result.dimensions
        assert result.content_hash
        assert result.model_name

    def test_encode_text_caches_result(
        self, fallback_encoder: MultimodalEncoder
    ) -> None:
        """测试重复编码同一文本走缓存，返回同一对象。"""
        r1 = fallback_encoder.encode_text("缓存测试")
        r2 = fallback_encoder.encode_text("缓存测试")
        assert r1 is r2  # 启用缓存时应返回同一对象
        assert r1.content_hash == r2.content_hash

    def test_encode_image_with_fallback(
        self, fallback_encoder: MultimodalEncoder, sample_image_path: Path
    ) -> None:
        """测试降级模式编码图像返回合法向量。"""
        result = fallback_encoder.encode_image(str(sample_image_path))
        assert isinstance(result, EncodedVector)
        assert result.modality == ModalityType.IMAGE
        assert result.dimensions > 0
        assert len(result.vector) == result.dimensions
        assert result.content_hash

    def test_encode_batch_returns_all_vectors(
        self, fallback_encoder: MultimodalEncoder, sample_image_path: Path
    ) -> None:
        """测试批量编码返回与输入等长的向量列表。"""
        items = [
            (ModalityType.TEXT, "文本一"),
            (ModalityType.TEXT, "文本二"),
            (ModalityType.IMAGE, str(sample_image_path)),
        ]
        results = fallback_encoder.encode_batch(items)
        assert len(results) == 3
        assert results[0].modality == ModalityType.TEXT
        assert results[1].modality == ModalityType.TEXT
        assert results[2].modality == ModalityType.IMAGE

    def test_cross_modal_search_returns_top_k(
        self, fallback_encoder: MultimodalEncoder
    ) -> None:
        """测试跨模态搜索返回 top_k 结果并按相似度降序。"""
        query = fallback_encoder.encode_text("查询文本")
        candidates = [
            fallback_encoder.encode_text("候选一"),
            fallback_encoder.encode_text("候选二"),
            fallback_encoder.encode_text("候选三"),
        ]
        results = fallback_encoder.cross_modal_search(query, candidates, top_k=2)
        assert len(results) == 2
        # 按相似度降序排列
        assert results[0][1] >= results[1][1]
        # 自身相似度应为 1.0
        self_results = fallback_encoder.cross_modal_search(query, [query], top_k=1)
        assert self_results[0][1] == pytest.approx(1.0, abs=1e-6)

    def test_cosine_similarity_correctness(self) -> None:
        """测试余弦相似度计算正确性（含正交、相反、维度不匹配）。"""
        # 相同向量相似度 1.0
        v1 = [1.0, 0.0, 0.0]
        v2 = [1.0, 0.0, 0.0]
        assert MultimodalEncoder.cosine_similarity(v1, v2) == pytest.approx(1.0)

        # 正交向量相似度 0.0
        v3 = [0.0, 1.0, 0.0]
        assert MultimodalEncoder.cosine_similarity(v1, v3) == pytest.approx(0.0)

        # 相反向量相似度 -1.0
        v4 = [-1.0, 0.0, 0.0]
        assert MultimodalEncoder.cosine_similarity(v1, v4) == pytest.approx(-1.0)

        # 维度不匹配时按公共维度截断计算（而非返回 0.0），
        # 避免跨编码模式（如 CLIP 512维 vs 哈希 128维）检索全盘失效。
        trunc = MultimodalEncoder.cosine_similarity([1.0, 1.0], [1.0, 0.0, 9.0])
        assert trunc == pytest.approx(1.0 / math.sqrt(2.0))

        # 空向量返回 0.0
        assert MultimodalEncoder.cosine_similarity([], []) == 0.0

    def test_fallback_encode_text_returns_vector(
        self, fallback_encoder: MultimodalEncoder
    ) -> None:
        """测试降级文本编码返回浮点向量。"""
        vector = fallback_encoder._fallback_encode_text("降级测试文本")
        assert isinstance(vector, list)
        assert len(vector) > 0
        assert all(isinstance(x, float) for x in vector)

    def test_fallback_encode_image_returns_vector(
        self, fallback_encoder: MultimodalEncoder, sample_image_path: Path
    ) -> None:
        """测试降级图像编码返回浮点向量。"""
        vector = fallback_encoder._fallback_encode_image(str(sample_image_path))
        assert isinstance(vector, list)
        assert len(vector) > 0
        assert all(isinstance(x, float) for x in vector)

    def test_config_controls_cache(self) -> None:
        """测试配置可关闭缓存，关闭后重复编码返回不同对象。"""
        config = MultimodalEncoderConfig(model_name="fallback", cache_enabled=False)
        encoder = MultimodalEncoder(config)
        r1 = encoder.encode_text("无缓存测试")
        r2 = encoder.encode_text("无缓存测试")
        # 缓存关闭时应生成新对象
        assert r1 is not r2
        # 但内容哈希应相同
        assert r1.content_hash == r2.content_hash

    def test_different_modality_types(self) -> None:
        """测试 TEXT 和 IMAGE 模态类型可区分。"""
        assert ModalityType.TEXT != ModalityType.IMAGE
        assert ModalityType.TEXT.value == "text"
        assert ModalityType.IMAGE.value == "image"

    def test_encode_text_empty_raises(
        self, fallback_encoder: MultimodalEncoder
    ) -> None:
        """测试空文本编码抛出 ValueError。"""
        with pytest.raises(ValueError):
            fallback_encoder.encode_text("")

    def test_encode_image_not_found_raises(
        self, fallback_encoder: MultimodalEncoder
    ) -> None:
        """测试不存在的图像文件抛出 FileNotFoundError。"""
        with pytest.raises(FileNotFoundError):
            fallback_encoder.encode_image("/nonexistent/path/image.png")

    def test_encode_image_caches_result(
        self, fallback_encoder: MultimodalEncoder, sample_image_path: Path
    ) -> None:
        """测试图像编码也走缓存。"""
        r1 = fallback_encoder.encode_image(str(sample_image_path))
        r2 = fallback_encoder.encode_image(str(sample_image_path))
        assert r1 is r2

    def test_cross_modal_search_empty_candidates(
        self, fallback_encoder: MultimodalEncoder
    ) -> None:
        """测试空候选列表返回空结果。"""
        query = fallback_encoder.encode_text("查询")
        results = fallback_encoder.cross_modal_search(query, [], top_k=5)
        assert results == []

    def test_get_and_reset_global_encoder(self) -> None:
        """测试全局编码器单例的获取与重置。"""
        reset_multimodal_encoder()
        config = MultimodalEncoderConfig(model_name="fallback")
        e1 = get_multimodal_encoder(config)
        e2 = get_multimodal_encoder()  # 不传 config 应返回同一实例
        assert e1 is e2
        reset_multimodal_encoder()
        e3 = get_multimodal_encoder(MultimodalEncoderConfig(model_name="fallback"))
        assert e3 is not e1


class TestMemoryEngineMultimodalIntegration:
    """记忆引擎多模态集成测试，验证与现有 MemoryEngine 的端到端联通。"""

    @pytest.mark.asyncio
    async def test_engine_store_and_search_multimodal(
        self, tmp_path: Path, sample_image_path: Path
    ) -> None:
        """测试记忆引擎多模态存取端到端流程。"""
        from agent.memory.engine import MemoryEngine

        db_path = str(tmp_path / "multimodal_memory.db")
        engine = MemoryEngine(db_path=db_path)
        try:
            # 存储多模态记忆
            mem_id = await engine.store_multimodal(
                content="这是一张红色测试图片",
                image_path=str(sample_image_path),
                memory_type="long_term",
                scene="multimodal_test",
            )
            assert mem_id is not None

            # 再存一条纯文本记忆
            mem_id2 = await engine.store_multimodal(
                content="普通文本记忆",
                memory_type="long_term",
                scene="multimodal_test",
            )
            assert mem_id2 is not None

            # 多模态搜索
            results = await engine.search_multimodal(
                query="红色图片", limit=5
            )
            assert isinstance(results, list)
            assert len(results) >= 1
            # 第一条应是相关度最高的
            assert results[0]["relevance_score"] >= 0.0
        finally:
            engine._store.close()
