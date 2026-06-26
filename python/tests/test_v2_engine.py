from __future__ import annotations

import tempfile
import time
from pathlib import Path

import pytest

from agent.evolution.v2_engine import (
    CapabilityAssessment,
    EvolutionEngineV2,
    EvolutionPlanner,
    EvolutionRollback,
    SelfModificationEngine,
    StrategyRecord,
    StrategyRecommendation,
    V2EvolutionAction,
    V2EvolutionCause,
    V2EvolutionPlan,
    V2EvolutionResult,
    V2RollbackCheckpoint,
)


# ─── EvolutionRollback ───


def test_rollback_create_checkpoint(tmp_path):
    rb = EvolutionRollback(checkpoint_dir=tmp_path / "cp")
    actions = [
        V2EvolutionAction(type="MODIFY_FILE", target=str(tmp_path / "test.txt"), content="new"),
    ]
    test_file = tmp_path / "test.txt"
    test_file.write_text("original", encoding="utf-8")

    cp = rb.create_checkpoint("plan_1", actions)
    assert cp.plan_id == "plan_1"
    assert str(test_file) in cp.snapshot
    assert cp.snapshot[str(test_file)] == "original"


@pytest.mark.anyio
async def test_rollback_restore(tmp_path):
    rb = EvolutionRollback(checkpoint_dir=tmp_path / "cp")
    test_file = tmp_path / "test.txt"
    test_file.write_text("original content", encoding="utf-8")

    actions = [V2EvolutionAction(type="MODIFY_FILE", target=str(test_file), content="new content")]
    cp = rb.create_checkpoint("plan_1", actions)

    test_file.write_text("modified content", encoding="utf-8")
    assert test_file.read_text(encoding="utf-8") == "modified content"

    result = await rb.rollback(cp.id)
    assert result["success"] is True
    assert test_file.read_text(encoding="utf-8") == "original content"


@pytest.mark.anyio
async def test_rollback_nonexistent_checkpoint():
    tmp = tempfile.mkdtemp()
    rb = EvolutionRollback(checkpoint_dir=tmp)
    result = await rb.rollback("nonexistent")
    assert result["success"] is False


def test_rollback_clean_old(tmp_path):
    rb = EvolutionRollback(checkpoint_dir=tmp_path / "cp")
    cp = V2RollbackCheckpoint(id="old_cp", plan_id="p1", timestamp=time.time() - 8 * 24 * 3600, snapshot={})
    rb._checkpoints[cp.id] = cp
    rb._save_checkpoint(cp)

    cp_path = tmp_path / "cp" / f"{cp.id}.json"
    import os
    old_mtime = time.time() - 8 * 24 * 3600
    os.utime(str(cp_path), (old_mtime, old_mtime))

    deleted = rb.clean_old_checkpoints(days_to_keep=7)
    assert deleted == 1


# ─── SelfModificationEngine ───


@pytest.mark.anyio
async def test_modify_file(tmp_path):
    engine = SelfModificationEngine()
    test_file = tmp_path / "test.py"
    test_file.write_text("old content", encoding="utf-8")

    action = V2EvolutionAction(
        type="MODIFY_FILE",
        target=str(test_file),
        content="new content",
        description="Update file",
    )
    result = await engine._execute_action(action)
    assert result is True
    assert test_file.read_text(encoding="utf-8") == "new content"


@pytest.mark.anyio
async def test_create_file(tmp_path):
    engine = SelfModificationEngine()
    new_file = tmp_path / "subdir" / "new.py"

    action = V2EvolutionAction(
        type="CREATE_FILE",
        target=str(new_file),
        content="created content",
        description="Create new file",
    )
    result = await engine._execute_action(action)
    assert result is True
    assert new_file.read_text(encoding="utf-8") == "created content"


@pytest.mark.anyio
async def test_delete_file(tmp_path):
    engine = SelfModificationEngine()
    test_file = tmp_path / "to_delete.py"
    test_file.write_text("delete me", encoding="utf-8")

    action = V2EvolutionAction(
        type="DELETE_FILE",
        target=str(test_file),
        content="",
        description="Delete file",
    )
    result = await engine._execute_action(action)
    assert result is True
    assert not test_file.exists()


@pytest.mark.anyio
async def test_execute_plan_success(tmp_path):
    engine = SelfModificationEngine()
    test_file = tmp_path / "test.py"
    test_file.write_text("old", encoding="utf-8")

    plan = V2EvolutionPlan(
        id="plan_1",
        actions=[
            V2EvolutionAction(type="MODIFY_FILE", target=str(test_file), content="new", description="Update"),
        ],
    )
    result = await engine.execute_plan(plan)
    assert result.success is True
    assert result.executed_actions == 1


@pytest.mark.anyio
async def test_execute_plan_failure(tmp_path):
    engine = SelfModificationEngine()
    plan = V2EvolutionPlan(
        id="plan_1",
        actions=[
            V2EvolutionAction(type="MODIFY_FILE", target="/nonexistent/path.py", content="new", description="Fail"),
        ],
    )
    result = await engine.execute_plan(plan)
    assert result.success is False
    assert result.failed_at == 0


def test_assess_action_safety_forbidden():
    engine = SelfModificationEngine()
    action = V2EvolutionAction(type="MODIFY_FILE", target="/app/node_modules/pkg/index.js", content="x")
    assessment = engine.assess_action_safety(action)
    assert assessment.risk_level == "forbidden"
    assert assessment.allowed is False


def test_assess_action_safety_delete_forbidden():
    engine = SelfModificationEngine()
    action = V2EvolutionAction(type="DELETE_FILE", target="/app/src/main.ts", content="")
    assessment = engine.assess_action_safety(action)
    assert assessment.risk_level == "forbidden"
    assert assessment.allowed is False


def test_assess_action_safety_cautious():
    engine = SelfModificationEngine()
    action = V2EvolutionAction(type="MODIFY_FILE", target="/app/src/core/engine.ts", content="x")
    assessment = engine.assess_action_safety(action)
    assert assessment.risk_level == "cautious"
    assert assessment.requires_confirmation is True


def test_assess_action_safety_safe():
    engine = SelfModificationEngine()
    action = V2EvolutionAction(type="MODIFY_FILE", target="/app/utils/helper.ts", content="x")
    assessment = engine.assess_action_safety(action)
    assert assessment.risk_level == "safe"
    assert assessment.allowed is True


def test_learn_safety_outcome_escalation():
    engine = SelfModificationEngine()
    action = V2EvolutionAction(type="MODIFY_FILE", target="/app/test.py", content="x")

    engine.learn_safety_outcome(action, False)
    engine.learn_safety_outcome(action, False)

    assessment = engine.assess_action_safety(action)
    assert assessment.risk_level == "cautious"


def test_learn_safety_outcome_de_escalation():
    engine = SelfModificationEngine()
    action = V2EvolutionAction(type="MODIFY_FILE", target="/app/test2.py", content="x")

    for _ in range(5):
        engine.learn_safety_outcome(action, True)

    assessment = engine.assess_action_safety(action)
    assert assessment.risk_level == "safe"


def test_get_safety_report():
    engine = SelfModificationEngine()
    report = engine.get_safety_report()
    assert "forbidden_paths" in report
    assert "safe_paths" in report
    assert len(report["forbidden_paths"]) > 0


def test_resource_preload_hints():
    engine = SelfModificationEngine()
    for i in range(5):
        engine.record_strategy_outcome(StrategyRecord(
            strategy_type="CODE_FIX",
            applied_at=time.time(),
            outcome="success",
        ))
    for i in range(3):
        engine.record_strategy_outcome(StrategyRecord(
            strategy_type="PROMPT_IMPROVEMENT",
            applied_at=time.time(),
            outcome="success",
        ))

    hints = engine.get_resource_preload_hints()
    assert len(hints) >= 1
    assert hints[0].resource_type == "CODE_FIX"
    assert hints[0].probability > 0.5


def test_resource_preload_hints_insufficient_data():
    engine = SelfModificationEngine()
    hints = engine.get_resource_preload_hints()
    assert hints == []


# ─── EvolutionPlanner ───


@pytest.mark.anyio
async def test_planner_fallback_without_llm():
    planner = EvolutionPlanner(llm_client=None)
    cause = V2EvolutionCause(type="FAILURE", description="Test failure")
    plan = await planner.generate_evolution_plan(cause)
    assert plan.id.startswith("plan-")
    assert plan.type == "CODE_FIX"
    assert len(plan.actions) == 0


# ─── EvolutionEngineV2 ───


@pytest.mark.anyio
async def test_trigger_evolution_no_llm():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    cause = V2EvolutionCause(type="FAILURE", description="Test failure")
    result = await engine.trigger_evolution(cause)
    assert result is not None
    assert result.success is True


@pytest.mark.anyio
async def test_trigger_evolution_prevents_concurrent():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    engine._is_running = True
    result = await engine.trigger_evolution(V2EvolutionCause(type="FAILURE", description="test"))
    assert result is None


@pytest.mark.anyio
async def test_get_history():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    await engine.trigger_evolution(V2EvolutionCause(type="FAILURE", description="test1"))
    await engine.trigger_evolution(V2EvolutionCause(type="LOW_SATISFACTION", description="test2"))

    history = engine.get_history()
    assert len(history) == 2


def test_get_metrics_empty():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    metrics = engine.get_metrics()
    assert metrics.total_evolutions == 0
    assert metrics.success_rate == 0.0


@pytest.mark.anyio
async def test_get_metrics_after_evolutions():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    await engine.trigger_evolution(V2EvolutionCause(type="FAILURE", description="test"))
    metrics = engine.get_metrics()
    assert metrics.total_evolutions == 1
    assert metrics.success_rate == 1.0


def test_record_strategy_outcome():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    engine.record_strategy_outcome(StrategyRecord(strategy_type="CODE_FIX", applied_at=time.time(), outcome="success"))
    engine.record_strategy_outcome(StrategyRecord(strategy_type="CODE_FIX", applied_at=time.time(), outcome="success"))
    engine.record_strategy_outcome(StrategyRecord(strategy_type="CODE_FIX", applied_at=time.time(), outcome="failure"))

    rec = engine._strategy_weights.get("CODE_FIX")
    assert rec is not None
    assert 0.4 < rec < 0.8


def test_predict_optimal_strategy():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    engine._strategy_weights = {"CODE_FIX": 0.9, "PROMPT_IMPROVEMENT": 0.5}
    engine._strategy_records = [
        StrategyRecord(strategy_type="CODE_FIX", applied_at=time.time(), outcome="success")
        for _ in range(5)
    ]

    rec = engine.predict_optimal_strategy()
    assert rec is not None
    assert rec.recommended_type == "CODE_FIX"
    assert rec.confidence > 0.5


def test_predict_optimal_strategy_no_data():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    rec = engine.predict_optimal_strategy()
    assert rec is None


def test_get_strategy_trends():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    base_time = time.time()
    for i in range(6):
        engine._strategy_records.append(StrategyRecord(
            strategy_type="CODE_FIX",
            applied_at=base_time + i,
            outcome="success" if i < 3 else "failure",
        ))

    trends = engine.get_strategy_trends()
    assert len(trends) == 1
    assert trends[0].strategy_type == "CODE_FIX"
    assert trends[0].direction == "declining"


def test_get_strategy_trends_improving():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    base_time = time.time()
    for i in range(6):
        engine._strategy_records.append(StrategyRecord(
            strategy_type="PROMPT_IMPROVEMENT",
            applied_at=base_time + i,
            outcome="failure" if i < 3 else "success",
        ))

    trends = engine.get_strategy_trends()
    assert len(trends) == 1
    assert trends[0].direction == "improving"


def test_record_capability_outcome():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    engine.record_capability_outcome("python", True)
    engine.record_capability_outcome("python", True)
    engine.record_capability_outcome("python", False)

    assessment = engine.assess_capability("python")
    assert assessment.can_handle is True
    assert assessment.confidence_level > 0.5


def test_assess_capability_no_data():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    assessment = engine.assess_capability("unknown_domain")
    assert assessment.can_handle is True
    assert assessment.confidence_level == 0.5


def test_assess_capability_weak():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    for _ in range(5):
        engine.record_capability_outcome("rust", False)

    assessment = engine.assess_capability("rust")
    assert assessment.can_handle is False
    assert assessment.suggested_alternative is not None


def test_get_capability_report():
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tempfile.mkdtemp())
    engine.record_capability_outcome("python", True)
    engine.record_capability_outcome("python", True)
    engine.record_capability_outcome("rust", False)
    engine.record_capability_outcome("rust", False)

    report = engine.get_capability_report()
    assert report["total_domains"] == 2
    assert len(report["boundaries"]) == 2
    assert "rust" in report["weak_areas"]
    assert report["average_confidence"] > 0


@pytest.mark.anyio
async def test_rollback_to_checkpoint(tmp_path):
    engine = EvolutionEngineV2(llm_client=None, checkpoint_dir=tmp_path / "cp")
    test_file = tmp_path / "test.txt"
    test_file.write_text("original", encoding="utf-8")

    actions = [V2EvolutionAction(type="MODIFY_FILE", target=str(test_file), content="new")]
    cp = engine._rollback.create_checkpoint("plan_1", actions)

    test_file.write_text("modified", encoding="utf-8")
    result = await engine.rollback_to_checkpoint(cp.id)
    assert result["success"] is True
    assert test_file.read_text(encoding="utf-8") == "original"
