from __future__ import annotations

import pytest

from agent.perception.sensory_fusion import (
    SensoryFusion,
    SenseSample,
    FusedPerception,
    DEFAULT_SENSE_WEIGHTS,
)


class TestSenseSample:
    def test_valid_modality(self):
        s = SenseSample(modality="visual", content="button at (10,20)", confidence=0.9)
        assert s.modality == "visual"

    def test_invalid_modality_raises(self):
        with pytest.raises(ValueError):
            SenseSample(modality="smell", content="x", confidence=0.5)

    def test_confidence_out_of_range_raises(self):
        with pytest.raises(ValueError):
            SenseSample(modality="text", content="x", confidence=1.5)


class TestSensoryFusion:
    def _fusion(self) -> SensoryFusion:
        f = SensoryFusion()
        f.add(SenseSample("visual", "检测到红色按钮", confidence=0.9))
        f.add(SenseSample("ocr", "登录", confidence=0.8))
        f.add(SenseSample("uia", "button#login enabled", confidence=0.95))
        f.add(SenseSample("text", "用户说：点击登录", confidence=1.0))
        return f

    def test_fuse_empty(self):
        f = SensoryFusion()
        fused = f.fuse()
        assert fused.text == ""
        assert fused.confidence == 0.0

    def test_fuse_weighted_contains_all_modalities(self):
        fused = self._fusion().fuse("weighted")
        assert isinstance(fused, FusedPerception)
        assert set(fused.modalities) == {"visual", "ocr", "uia", "text"}
        assert 0.0 < fused.confidence <= 1.0
        assert "登录" in fused.text

    def test_fuse_concat(self):
        fused = self._fusion().fuse("concat")
        assert fused.modalities == ["ocr", "text", "uia", "visual"]
        assert fused.text.count("\n") == 3

    def test_weighted_sorts_by_confidence(self):
        fused = self._fusion().fuse("weighted")
        # 高置信度通道（text 1.0）应排在第一行
        assert fused.text.startswith("[text|1.00]")

    def test_to_prompt_context_has_header(self):
        ctx = self._fusion().to_prompt_context()
        assert "多模态感知融合" in ctx
        assert "综合置信度" in ctx

    def test_custom_weights(self):
        f = SensoryFusion(weights={"ocr": 0.1})
        f.add(SenseSample("ocr", "low weight", confidence=1.0))
        f.add(SenseSample("text", "high weight", confidence=1.0))
        fused = f.fuse("weighted")
        assert fused.text.startswith("[text|1.00]")

    def test_structured_backed(self):
        fused = self._fusion().fuse()
        assert "visual" in fused.structured
        assert fused.structured["visual"][0]["content"] == "检测到红色按钮"

    def test_clear(self):
        f = self._fusion()
        f.clear()
        assert f.fuse().text == ""

    def test_unknown_strategy_raises(self):
        with pytest.raises(ValueError):
            self._fusion().fuse("bogus")
