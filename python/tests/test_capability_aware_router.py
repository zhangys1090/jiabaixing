from __future__ import annotations

from agent.evolution.llm_capability_detector import LLMCapabilities
from agent.llm.capability_aware_router import (
    CapabilityAwareRouter,
    TaskRequirement,
    ScoredProvider,
)


def _caps(**kw) -> LLMCapabilities:
    base = dict(
        provider="p",
        model_name="m",
        context_window=8192,
        reasoning_depth=5,
        tool_calling_accuracy=0.6,
        code_generation=5,
        multi_modal=False,
        structured_output=0.6,
    )
    base.update(kw)
    return LLMCapabilities(**base)


class TestTaskRequirement:
    def test_coding_preset(self):
        req = TaskRequirement.from_task_type("coding")
        assert req.needs_code_generation == 1.0
        assert req.needs_tool_calling > 0

    def test_vision_preset(self):
        req = TaskRequirement.from_task_type("vision")
        assert req.needs_multi_modal is True

    def test_unknown_preset_returns_empty(self):
        req = TaskRequirement.from_task_type("nope")
        assert req.active_weights() == {}

    def test_active_weights_filters_zero(self):
        req = TaskRequirement(needs_reasoning=0.0, needs_code_generation=1.0)
        assert "reasoning" not in req.active_weights()
        assert "code" in req.active_weights()


class TestCapabilityAwareRouter:
    def _router(self) -> CapabilityAwareRouter:
        r = CapabilityAwareRouter()
        r.register("weak", _caps(reasoning_depth=2, tool_calling_accuracy=0.3, code_generation=2))
        r.register("strong", _caps(reasoning_depth=9, tool_calling_accuracy=0.95, code_generation=9))
        r.register("vision", _caps(multi_modal=True, reasoning_depth=6))
        r.register("cheap", _caps(reasoning_depth=4), cost_tier=1.0)
        r.register("expensive", _caps(reasoning_depth=9), cost_tier=9.0)
        return r

    def test_register_and_contains(self):
        r = CapabilityAwareRouter()
        r.register("a", _caps())
        assert "a" in r

    def test_coding_selects_high_code(self):
        r = self._router()
        best = r.select(TaskRequirement.from_task_type("coding"))
        assert best is not None
        assert best.provider == "strong"
        assert best.score > 0.8

    def test_vision_filters_non_multimodal(self):
        r = self._router()
        best = r.select(TaskRequirement.from_task_type("vision"))
        assert best is not None
        assert best.provider == "vision"

    def test_long_context_hard_constraint(self):
        r = self._router()
        req = TaskRequirement(min_context_window=100_000)
        best = r.select(req)
        # 所有注册模型上下文均不足 -> 被硬约束排除
        assert best is None

    def test_cost_ceiling_excludes_expensive(self):
        r = self._router()
        req = TaskRequirement(needs_reasoning=0.5, max_cost_tier=3.0)
        best = r.select(req)
        assert best is not None
        assert best.provider != "expensive"

    def test_preferred_provider_bonus(self):
        r = self._router()
        req_no_pref = TaskRequirement(needs_reasoning=0.5)
        req_pref = TaskRequirement(needs_reasoning=0.5, preferred_provider="weak")
        weak_no = r.score("weak", _caps(reasoning_depth=2, tool_calling_accuracy=0.3, code_generation=2), req_no_pref)
        weak_with = r.score("weak", _caps(reasoning_depth=2, tool_calling_accuracy=0.3, code_generation=2), req_pref)
        # 偏好仅做轻微加分，不越权压倒明显更优模型
        assert weak_with.score > weak_no.score
        # 在能力接近时，偏好决定胜者
        r2 = CapabilityAwareRouter()
        r2.register("a", _caps(reasoning_depth=5))
        r2.register("b", _caps(reasoning_depth=5))
        best = r2.select(TaskRequirement(needs_reasoning=0.5, preferred_provider="b"))
        assert best.provider == "b"

    def test_rank_ordering(self):
        r = self._router()
        ranked = r.rank(TaskRequirement.from_task_type("reasoning"))
        assert ranked[0].provider == "strong"
        scores = [s.score for s in ranked]
        assert scores == sorted(scores, reverse=True)

    def test_no_requirement_returns_full_score(self):
        r = self._router()
        scored = r.score("strong", _caps(reasoning_depth=9), TaskRequirement())
        assert scored is not None
        assert scored.score == 1.0

    def test_register_from_detector_uses_cache(self):
        class FakeDetector:
            def get_cached(self, name):
                return _caps(reasoning_depth=7)

            async def detect(self, name, force=False):
                return _caps(reasoning_depth=7)

        r = CapabilityAwareRouter(detector=FakeDetector())
        r.register_from_detector(["x"])
        assert "x" in r


class TestCostTierAutoDerivation:
    def test_known_expensive_model_caps_at_10(self):
        tier = CapabilityAwareRouter.cost_tier_from_pricing("claude-3-opus")
        assert tier == 10.0

    def test_known_cheap_model_low_tier(self):
        tier = CapabilityAwareRouter.cost_tier_from_pricing("gpt-4o-mini")
        assert 0.0 < tier < 2.0

    def test_unknown_model_neutral(self):
        assert CapabilityAwareRouter.cost_tier_from_pricing("no-such-model") == 5.0

    def test_register_auto_cost_sets_tier(self):
        r = CapabilityAwareRouter()
        r.register_auto_cost("p", _caps(model_name="claude-3-opus"), "claude-3-opus")
        assert r._registry["p"][1] == 10.0

    def test_cost_ceiling_uses_autoderived_tier(self):
        r = CapabilityAwareRouter()
        r.register_auto_cost("opus", _caps(model_name="claude-3-opus"), "claude-3-opus")
        r.register_auto_cost("mini", _caps(model_name="gpt-4o-mini"), "gpt-4o-mini")
        req = TaskRequirement(needs_reasoning=0.5, max_cost_tier=3.0)
        best = r.select(req)
        assert best is not None
        assert best.provider == "mini"

    def test_register_from_detector_derives_cost(self):
        class FakeDetector:
            def get_cached(self, name):
                return _caps(model_name="claude-3-opus")

            async def detect(self, name, force=False):
                return _caps(model_name="claude-3-opus")

        r = CapabilityAwareRouter(detector=FakeDetector())
        r.register_from_detector(["x"])
        assert r._registry["x"][1] == 10.0
