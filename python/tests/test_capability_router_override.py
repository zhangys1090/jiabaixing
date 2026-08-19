"""U2×U3 测试：CapabilityAwareRouter 动态权重覆写（漂移自愈降权）。"""

from __future__ import annotations

from agent.evolution.llm_capability_detector import LLMCapabilities
from agent.llm.capability_aware_router import CapabilityAwareRouter, TaskRequirement


def _caps():
    return LLMCapabilities(
        provider="gpt",
        model_name="gpt-x",
        reasoning_depth=8,
        tool_calling_accuracy=0.9,
        code_generation=9,
        structured_output=0.9,
        context_window=128000,
    )


def _router():
    r = CapabilityAwareRouter()
    r.register("gpt", _caps())
    return r


def test_override_lowers_score():
    router = _router()
    req = TaskRequirement.from_task_type("coding")
    caps = router._registry["gpt"][0]
    base = router.score("gpt", caps, req).score

    router.set_provider_degraded("gpt", True)
    degraded = router.score("gpt", caps, req).score
    assert degraded == round(base * 0.25, 4)
    assert router.get_override("gpt") == 0.25

    router.clear_override("gpt")
    assert router.score("gpt", caps, req).score == base
    assert router.get_override("gpt") is None


def test_explicit_weight_factor():
    router = _router()
    req = TaskRequirement.from_task_type("coding")
    caps = router._registry["gpt"][0]
    base = router.score("gpt", caps, req).score
    router.override_provider_weight("gpt", 0.5)
    assert router.score("gpt", caps, req).score == round(base * 0.5, 4)


def test_invalid_factor_rejected():
    router = _router()
    try:
        router.override_provider_weight("gpt", 1.5)
    except ValueError:
        pass
    else:
        raise AssertionError("因子应限制在 0-1")
