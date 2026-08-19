"""U2×U3 测试：CapabilityEvolutionLinkage（能力漂移 → 路由降级 + 进化回滚）。"""

from __future__ import annotations

from types import SimpleNamespace

from agent.evolution.capability_evolution_linkage import (
    CapabilityEvolutionLinkage,
    LinkageResult,
    evolution_rollback_handlers,
)
from agent.evolution.llm_capability_detector import CapabilityDiff, LLMCapabilities
from agent.llm.capability_aware_router import CapabilityAwareRouter


def _caps(code=9, reasoning=8, tool=0.9, structured=0.9, ctx=128000):
    return LLMCapabilities(
        provider="gpt",
        model_name="gpt-x",
        reasoning_depth=reasoning,
        tool_calling_accuracy=tool,
        code_generation=code,
        structured_output=structured,
        context_window=ctx,
    )


def _router_with_gpt():
    r = CapabilityAwareRouter()
    r.register("gpt", _caps())
    return r


def test_degradation_triggers_routing_downgrade_and_rollback():
    detector = SimpleNamespace(on_capability_drift=None)
    router = _router_with_gpt()
    rolled_back: list[str] = []

    async def on_rollback(cp_id, _result):
        rolled_back.append(cp_id)

    linkage = CapabilityEvolutionLinkage(
        detector,  # type: ignore[arg-type]
        router,
        on_rollback=on_rollback,
        get_latest_checkpoint_id=lambda: "cp-1",
    )
    linkage.register()
    assert detector.on_capability_drift is not None

    diff = CapabilityDiff(
        changed=[{"field": "code_generation", "from": 9, "to": 4}],
        removed=[],
    )
    result = linkage.notify_capability_change("gpt", diff)

    assert isinstance(result, LinkageResult)
    assert result.degraded is True
    assert result.changed_metrics == ["code_generation"]
    assert result.routing_action == "degraded"
    assert result.rollback_required is True
    assert result.rollback_checkpoint_id == "cp-1"
    # 路由被降级（权重因子 0.25）
    assert router.get_override("gpt") == 0.25

    # 清空_pending 触发回滚
    import asyncio

    n = asyncio.run(linkage.flush_pending_rollbacks())
    assert n == 1
    assert rolled_back == ["cp-1"]


def test_improvement_is_not_degraded():
    detector = SimpleNamespace(on_capability_drift=None)
    router = _router_with_gpt()
    linkage = CapabilityEvolutionLinkage(detector, router)  # type: ignore[arg-type]
    diff = CapabilityDiff(
        changed=[{"field": "code_generation", "from": 4, "to": 9}],
        removed=[],
    )
    result = linkage.notify_capability_change("gpt", diff)
    assert result.degraded is False
    assert result.routing_action == ""
    assert result.rollback_required is False
    assert router.get_override("gpt") is None


def test_removed_capability_is_degraded():
    detector = SimpleNamespace(on_capability_drift=None)
    router = _router_with_gpt()
    linkage = CapabilityEvolutionLinkage(detector, router)  # type: ignore[arg-type]
    diff = CapabilityDiff(changed=[], removed=["structured_output"])
    result = linkage.notify_capability_change("gpt", diff)
    assert result.degraded is True


def test_evolution_rollback_handlers_extract_callbacks():
    fake_engine = SimpleNamespace(
        _rollback=SimpleNamespace(
            _checkpoints={
                "cp-1": {"timestamp": 1.0},
                "cp-2": {"timestamp": 2.0},
            }
        )
    )
    on_rollback, get_latest = evolution_rollback_handlers(fake_engine)
    assert get_latest() == "cp-2"
    assert callable(on_rollback)
