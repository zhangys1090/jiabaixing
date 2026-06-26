import pytest
import time
import tempfile
import json
from pathlib import Path

from agent.evolution.types import (
    EvolutionAction,
    EvolutionCause,
    EvolutionMetrics,
    EvolutionPlan,
    EvolutionPriority,
    EvolutionResult,
    EvolutionType,
    FeedbackSignal,
)
from agent.evolution.engine import EvolutionEngine


def _fresh_engine():
    tmp = tempfile.mkdtemp()
    return EvolutionEngine(data_dir=tmp)


def test_evolution_type_values():
    assert EvolutionType.PROMPT_OPTIMIZATION == "prompt_optimization"
    assert EvolutionType.SELF_MODIFICATION == "self_modification"


def test_evolution_priority_values():
    assert EvolutionPriority.LOW == "low"
    assert EvolutionPriority.CRITICAL == "critical"


def test_feedback_signal_defaults():
    signal = FeedbackSignal()
    assert signal.quality_score == 0.0
    assert signal.user_correction is False


@pytest.mark.anyio
async def test_collect_feedback():
    engine = _fresh_engine()
    signal = FeedbackSignal(
        interaction_id="test_1",
        quality_score=0.9,
        cause="chat",
        timestamp=time.time(),
    )
    await engine.collect_feedback(signal)

    metrics = engine.get_metrics()
    assert metrics.total_interactions == 1
    assert 0.9 in metrics.recent_quality_scores


@pytest.mark.anyio
async def test_collect_feedback_with_tool():
    engine = _fresh_engine()
    signal = FeedbackSignal(
        interaction_id="test_2",
        quality_score=0.6,
        cause="chat",
        tool_name="file_read",
        timestamp=time.time(),
    )
    await engine.collect_feedback(signal)

    weights = engine.get_tool_weights()
    assert "file_read" in weights


@pytest.mark.anyio
async def test_should_evolve_low_quality():
    engine = _fresh_engine()
    for i in range(15):
        signal = FeedbackSignal(
            interaction_id=f"low_{i}",
            quality_score=0.3,
            cause="chat",
            timestamp=time.time(),
        )
        await engine.collect_feedback(signal)

    plan = await engine.should_evolve()
    assert plan is not None
    assert plan.evolution_type == EvolutionType.PROMPT_OPTIMIZATION
    assert plan.priority in (EvolutionPriority.HIGH, EvolutionPriority.MEDIUM)


@pytest.mark.anyio
async def test_should_evolve_good_quality():
    engine = _fresh_engine()
    for i in range(15):
        signal = FeedbackSignal(
            interaction_id=f"good_{i}",
            quality_score=0.9,
            cause="chat",
            timestamp=time.time(),
        )
        await engine.collect_feedback(signal)

    plan = await engine.should_evolve()
    assert plan is None


@pytest.mark.anyio
async def test_should_evolve_tool_failure():
    engine = _fresh_engine()
    for i in range(5):
        signal = FeedbackSignal(
            interaction_id=f"fail_{i}",
            quality_score=0.5,
            cause=EvolutionCause.TOOL_FAILURE,
            tool_name="broken_tool",
            timestamp=time.time(),
        )
        await engine.collect_feedback(signal)

    plan = await engine.should_evolve()
    assert plan is not None
    assert plan.evolution_type == EvolutionType.TOOL_WEIGHT_ADJUSTMENT


@pytest.mark.anyio
async def test_execute_evolution():
    engine = _fresh_engine()
    plan = EvolutionPlan(
        plan_id="test_plan",
        evolution_type=EvolutionType.PROMPT_OPTIMIZATION,
        priority=EvolutionPriority.MEDIUM,
        cause=EvolutionCause.LOW_QUALITY,
        actions=[
            EvolutionAction(
                action_type="adjust_prompt",
                target="system_prompt",
                description="test",
            )
        ],
    )

    result = await engine.execute_evolution(plan)
    assert result.success is True
    assert result.executed_actions == 1


@pytest.mark.anyio
async def test_execute_evolution_reduce_weight():
    engine = _fresh_engine()
    engine._tool_weights["test_tool"] = 0.8

    plan = EvolutionPlan(
        plan_id="weight_plan",
        evolution_type=EvolutionType.TOOL_WEIGHT_ADJUSTMENT,
        actions=[
            EvolutionAction(
                action_type="reduce_weight",
                target="test_tool",
                description="reduce",
            )
        ],
    )

    result = await engine.execute_evolution(plan)
    assert result.success is True
    assert engine._tool_weights["test_tool"] < 0.8


@pytest.mark.anyio
async def test_quality_trend_improving():
    engine = _fresh_engine()
    for i in range(5):
        await engine.collect_feedback(FeedbackSignal(
            interaction_id=f"low_{i}", quality_score=0.3, timestamp=time.time()
        ))
    for i in range(5):
        await engine.collect_feedback(FeedbackSignal(
            interaction_id=f"high_{i}", quality_score=0.9, timestamp=time.time()
        ))

    metrics = engine.get_metrics()
    assert metrics.quality_trend == "improving"


@pytest.mark.anyio
async def test_user_correction_adds_prompt_example():
    engine = _fresh_engine()
    signal = FeedbackSignal(
        interaction_id="corr_1",
        quality_score=0.4,
        user_correction=True,
        timestamp=time.time(),
    )
    await engine.collect_feedback(signal)

    examples = engine.get_prompt_examples()
    assert len(examples) == 1
    assert examples[0]["correction"] == "true"


@pytest.mark.anyio
async def test_adjust_prompt_generates_correction_rules():
    engine = _fresh_engine()
    for i in range(15):
        signal = FeedbackSignal(
            interaction_id=f"low_{i}",
            quality_score=0.3,
            cause="chat",
            tools_used=["file_read"],
            tool_successes={"file_read": False},
            timestamp=time.time(),
        )
        await engine.collect_feedback(signal)

    plan = await engine.should_evolve()
    assert plan is not None
    result = await engine.execute_evolution(plan)
    assert result.success is True

    rules = engine.get_correction_rules()
    assert len(rules) >= 1
    assert "file_read" in rules[0]["rule"]


@pytest.mark.anyio
async def test_build_evolution_prompt_section():
    engine = _fresh_engine()
    engine._tool_weights = {"shell_exec": 0.9, "bad_tool": 0.1}
    engine._tool_call_stats = {
        "shell_exec": {"calls": 5, "successes": 5, "total_duration_ms": 100.0},
        "bad_tool": {"calls": 5, "successes": 0, "total_duration_ms": 500.0},
    }
    engine._correction_rules = [{"rule": "测试纠错规则", "avg_quality": "0.30", "timestamp": "0"}]

    section = engine.build_evolution_prompt_section()
    assert "进化纠错规则" in section
    assert "测试纠错规则" in section
    assert "shell_exec" in section
    assert "低可靠工具" in section


@pytest.mark.anyio
async def test_build_evolution_prompt_section_declining():
    engine = _fresh_engine()
    engine._metrics.quality_trend = "declining"

    section = engine.build_evolution_prompt_section()
    assert "质量预警" in section


@pytest.mark.anyio
async def test_nudge_knowledge_persistence():
    engine = _fresh_engine()

    nudge = engine.nudge_knowledge_persistence("我喜欢用Python写代码", [])
    assert nudge is not None
    assert "我喜欢" in nudge
    assert "持久化" in nudge


@pytest.mark.anyio
async def test_nudge_knowledge_persistence_no_keyword():
    engine = _fresh_engine()

    nudge = engine.nudge_knowledge_persistence("帮我写个函数", [])
    assert nudge is None


@pytest.mark.anyio
async def test_nudge_knowledge_persistence_already_stored():
    engine = _fresh_engine()

    nudge = engine.nudge_knowledge_persistence("请记住我喜欢Python", ["memory_store"])
    assert nudge is None


@pytest.mark.anyio
async def test_generate_correction_timeout():
    engine = _fresh_engine()
    correction = engine._generate_correction("file_read", "timeout after 30s")
    assert "超时" in correction
    assert "file_read" in correction


@pytest.mark.anyio
async def test_generate_correction_permission():
    engine = _fresh_engine()
    correction = engine._generate_correction("shell_exec", "permission denied")
    assert "权限" in correction


@pytest.mark.anyio
async def test_generate_correction_not_found():
    engine = _fresh_engine()
    correction = engine._generate_correction("file_read", "file not found at path")
    assert "不存在" in correction or "确认" in correction


@pytest.mark.anyio
async def test_generate_correction_generic():
    engine = _fresh_engine()
    correction = engine._generate_correction("some_tool", "unknown error")
    assert "失败" in correction


@pytest.mark.anyio
async def test_state_persistence():
    tmp = tempfile.mkdtemp()
    engine = EvolutionEngine(data_dir=tmp)
    engine._tool_weights = {"test_tool": 0.8}
    engine._tool_call_stats = {"test_tool": {"calls": 10, "successes": 8, "total_duration_ms": 500.0}}
    engine._correction_rules = [{"rule": "test rule", "avg_quality": "0.50", "timestamp": "0"}]
    engine._schedule_persist()

    engine2 = EvolutionEngine(data_dir=tmp)
    assert engine2._tool_weights.get("test_tool") == 0.8
    assert engine2._tool_call_stats.get("test_tool", {}).get("calls") == 10
    assert len(engine2._correction_rules) == 1
    assert engine2._correction_rules[0]["rule"] == "test rule"


@pytest.mark.anyio
async def test_state_persistence_auto_on_every_5_feedbacks():
    tmp = tempfile.mkdtemp()
    engine = EvolutionEngine(data_dir=tmp)
    for i in range(5):
        await engine.collect_feedback(FeedbackSignal(
            interaction_id=f"auto_{i}",
            quality_score=0.8,
            timestamp=time.time(),
        ))

    state_file = Path(tmp) / "engine-state.json"
    assert state_file.exists()
    state = json.loads(state_file.read_text(encoding="utf-8"))
    assert state["metrics"]["total_interactions"] == 5
