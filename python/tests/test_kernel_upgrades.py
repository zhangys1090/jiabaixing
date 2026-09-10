"""P1-4~P1-7: 统一推理内核 + 元认知 + 自适应预算 + 记忆隔离 + 操作回滚 测试。"""

from __future__ import annotations

import asyncio
import pytest


def test_reasoning_kernel_complexity_assessment():
    from agent.reasoning.kernel import ReasoningKernel, ComplexityLevel, ReasoningStrategy

    kernel = ReasoningKernel()

    simple = kernel._assess_complexity("什么是Python？", {})
    assert simple.level == ComplexityLevel.SIMPLE

    complex_q = kernel._assess_complexity("设计一个高可用分布式系统架构，考虑容错和一致性", {})
    assert complex_q.level in (ComplexityLevel.COMPLEX, ComplexityLevel.VERY_COMPLEX)


def test_reasoning_kernel_direct():
    from agent.reasoning.kernel import ReasoningKernel, ReasoningStrategy

    kernel = ReasoningKernel()
    result = asyncio.get_event_loop().run_until_complete(
        kernel.reason("1+1等于几？", force_strategy=ReasoningStrategy.DIRECT)
    )
    assert result.strategy_used == ReasoningStrategy.DIRECT
    assert result.result_id.startswith("rk_")


def test_meta_cognition_assess_confidence():
    from agent.core.meta_cognition import MetaCognitionEngine

    engine = MetaCognitionEngine()
    assessment = asyncio.get_event_loop().run_until_complete(
        engine.assess_confidence(
            task="编写Python代码",
            result="这是代码实现...",
            tool_calls=[{"name": "code_execute", "success": True, "result": "ok"}],
        )
    )
    assert 0.0 <= assessment.overall_confidence <= 1.0
    assert len(assessment.dimensions) == 5


def test_meta_cognition_knowledge_gaps():
    from agent.core.meta_cognition import MetaCognitionEngine

    engine = MetaCognitionEngine()
    gaps = asyncio.get_event_loop().run_until_complete(
        engine.identify_knowledge_gaps(
            task="使用量子计算优化投资组合",
            available_tools={"web_search"},
        )
    )
    assert len(gaps) >= 1
    has_domain_gap = any(g.gap_type.value == "unknown_domain" for g in gaps)
    assert has_domain_gap


def test_adaptive_budget_general():
    from agent.context.adaptive_budget import AdaptiveTokenBudgetEngine, Scene

    engine = AdaptiveTokenBudgetEngine(max_tokens=128000)
    result = engine.allocate(scene=Scene.GENERAL)
    alloc = result.allocation
    total = alloc.system_prompt + alloc.memory + alloc.history + alloc.dynamic_context + alloc.tool_results + alloc.reserve
    assert total <= 128000
    assert alloc.system_prompt > 0
    assert alloc.reserve > 0


def test_adaptive_budget_coding_scene():
    from agent.context.adaptive_budget import AdaptiveTokenBudgetEngine, Scene

    engine = AdaptiveTokenBudgetEngine(max_tokens=128000)
    result = engine.allocate(scene=Scene.CODING)
    assert result.scene == "coding"
    assert len(result.decisions) > 0


def test_adaptive_budget_with_history_feedback():
    from agent.context.adaptive_budget import (
        AdaptiveTokenBudgetEngine,
        Scene,
        HistoryStats,
    )

    engine = AdaptiveTokenBudgetEngine(max_tokens=128000)
    stats = HistoryStats(
        memory_hit_rate=0.2,
        tool_call_frequency=0.8,
        conversation_turns=20,
        context_overflow_count=2,
    )
    result = engine.allocate(scene=Scene.LONG_TASK, history_stats=stats)
    assert len(result.warnings) > 0 or result.utilization_forecast > 0


def test_adaptive_budget_auto_detect_scene():
    from agent.context.adaptive_budget import AdaptiveTokenBudgetEngine, Scene

    engine = AdaptiveTokenBudgetEngine()
    assert engine.auto_detect_scene("debug this code") == Scene.CODING
    assert engine.auto_detect_scene("搜索最新新闻") == Scene.SEARCH
    assert engine.auto_detect_scene("你好") == Scene.CONVERSATION


def test_memory_isolation_snapshot():
    from agent.memory.isolation import (
        SubAgentMemoryIsolator,
        IsolationLevel,
        MergeStrategy,
    )

    isolator = SubAgentMemoryIsolator()
    snap = isolator.create_snapshot("researcher", isolation_level=IsolationLevel.SNAPSHOT)
    assert snap.snapshot_id.startswith("snap_")
    assert snap.agent_id == "researcher"

    entry = isolator.write_to_snapshot("researcher", "研究发现A", importance=0.8)
    assert entry is not None
    assert entry.content == "研究发现A"

    entries = isolator.read_from_snapshot("researcher")
    assert len(entries) >= 1


def test_memory_isolation_read_only_rejects_write():
    from agent.memory.isolation import SubAgentMemoryIsolator, IsolationLevel

    isolator = SubAgentMemoryIsolator()
    isolator.create_snapshot("observer", isolation_level=IsolationLevel.READ_ONLY)
    entry = isolator.write_to_snapshot("observer", "尝试写入")
    assert entry is None


def test_memory_isolation_merge():
    from agent.memory.isolation import SubAgentMemoryIsolator, MergeStrategy

    isolator = SubAgentMemoryIsolator()
    isolator.create_snapshot("worker1")
    isolator.write_to_snapshot("worker1", "结果1", importance=0.9)
    isolator.write_to_snapshot("worker1", "结果2", importance=0.7)

    result = isolator.merge_snapshot("worker1", strategy=MergeStrategy.APPEND)
    assert result.entries_merged == 2


def test_operation_rollback_file_write():
    import tempfile
    from pathlib import Path
    from agent.desktop.operation_rollback import (
        OperationRollbackEngine,
        OperationType,
        CheckpointStatus,
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        test_file = Path(tmpdir) / "test.txt"
        test_file.write_text("original content", encoding="utf-8")

        engine = OperationRollbackEngine(backup_root=tmpdir)
        cp = engine.save_checkpoint(OperationType.FILE_WRITE, target=str(test_file))

        assert cp.status == CheckpointStatus.ACTIVE
        assert cp.snapshot is not None
        assert cp.snapshot.backup_path != ""

        test_file.write_text("modified content", encoding="utf-8")
        assert test_file.read_text(encoding="utf-8") == "modified content"

        result = engine.rollback(cp.checkpoint_id)
        assert result.success
        assert test_file.read_text(encoding="utf-8") == "original content"


def test_operation_rollback_commit():
    from agent.desktop.operation_rollback import (
        OperationRollbackEngine,
        OperationType,
    )

    engine = OperationRollbackEngine()
    cp = engine.save_checkpoint(OperationType.CUSTOM, target="test_action")
    commit_result = engine.commit(cp.checkpoint_id)
    assert commit_result.success
