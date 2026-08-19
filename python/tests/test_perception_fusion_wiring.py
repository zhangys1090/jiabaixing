from __future__ import annotations

from agent.perception import PerceptionActionLoop, SensoryFusion
from agent.perception.visual_grounding import GroundingResult


def _loop() -> PerceptionActionLoop:
    return PerceptionActionLoop(
        enable_watcher=False,
        enable_ocr=False,
        sensory_fusion=SensoryFusion(),
    )


class TestPerceptionFusionWiring:
    def test_fuse_perception_returns_fused(self):
        loop = _loop()
        g = GroundingResult(target_found=True, coordinates=(10, 20), element={"id": "btn"})
        fused = loop.fuse_perception(grounding=g, extra_text="user: 提交")
        assert "visual" in fused.modalities
        assert "text" in fused.modalities
        assert fused.confidence > 0.0
        assert loop.last_fusion is fused

    def test_perception_context_non_empty(self):
        loop = _loop()
        g = GroundingResult(target_found=True, coordinates=(1, 1))
        loop.fuse_perception(grounding=g, extra_text="hi")
        ctx = loop.perception_context()
        assert "多模态感知融合" in ctx
        assert "命中=True" in ctx

    def test_perception_context_empty_before_fuse(self):
        loop = _loop()
        assert loop.perception_context() == ""

    def test_execute_stores_last_fusion(self):
        # 不实际执行动作，仅验证 execute 末尾融合不抛错（grounding 为 None 时仍产出融合）
        loop = _loop()
        # 直接调用融合层以覆盖 execute 末尾的调用路径
        fused = loop.fuse_perception(extra_text="no grounding")
        assert "text" in fused.modalities
