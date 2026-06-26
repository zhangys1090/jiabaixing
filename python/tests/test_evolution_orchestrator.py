from __future__ import annotations

import asyncio
import time

import pytest

from agent.evolution.engine import EvolutionEngine
from agent.evolution.llm_capability_detector import (
    LLMCapabilityDetector,
    LLMCapabilities,
)
from agent.evolution.orchestrator import (
    EvolutionOrchestrator,
    OrchestratorMetrics,
    OptimizationCycle,
    OptimizationCycleResult,
    VerificationResult,
)
from agent.evolution.strategy_adapter import StrategyAdapter
from agent.evolution.v2_engine import EvolutionEngineV2


class MockLLM:
    async def chat(self, messages: list[dict[str, str]], **kwargs: object) -> dict[str, str]:
        return {"content": "test response"}


class TestEvolutionOrchestrator:
    def setup_method(self) -> None:
        EvolutionOrchestrator.reset_instance()

    def teardown_method(self) -> None:
        EvolutionOrchestrator.reset_instance()

    def test_singleton(self):
        o1 = EvolutionOrchestrator.get_instance()
        o2 = EvolutionOrchestrator.get_instance()
        assert o1 is o2

    def test_reset_instance(self):
        o1 = EvolutionOrchestrator.get_instance()
        EvolutionOrchestrator.reset_instance()
        o2 = EvolutionOrchestrator.get_instance()
        assert o1 is not o2

    def test_initial_metrics(self):
        orch = EvolutionOrchestrator.get_instance()
        metrics = orch.get_metrics()
        assert metrics.total_interactions == 0
        assert metrics.total_optimizations == 0
        assert metrics.average_quality == 0.0
        assert metrics.quality_trend == "stable"
        assert metrics.cycle_success_rate == 0.0

    def test_register_engines(self):
        orch = EvolutionOrchestrator.get_instance()
        evo = EvolutionEngine()
        orch.register_engines(evolution_engine=evo)
        metrics = orch.get_metrics()
        assert "EvolutionEngine" in metrics.engines_active

    def test_register_all_engines(self):
        orch = EvolutionOrchestrator.get_instance()
        orch.register_engines(
            evolution_engine=EvolutionEngine(),
            evolution_engine_v2=EvolutionEngineV2(),
            capability_detector=LLMCapabilityDetector(),
            strategy_adapter=StrategyAdapter(),
        )
        metrics = orch.get_metrics()
        assert len(metrics.engines_active) == 4

    def test_is_running_initially_false(self):
        orch = EvolutionOrchestrator.get_instance()
        assert orch.is_running is False

    @pytest.mark.asyncio
    async def test_start_and_stop(self):
        orch = EvolutionOrchestrator.get_instance()
        orch.start()
        assert orch.is_running is True
        orch.stop()
        assert orch.is_running is False

    async def test_record_interaction(self):
        orch = EvolutionOrchestrator.get_instance()
        await orch.record_interaction(0.8, 200.0)
        metrics = orch.get_metrics()
        assert metrics.total_interactions == 1
        assert metrics.average_quality > 0.7

    async def test_record_multiple_interactions(self):
        orch = EvolutionOrchestrator.get_instance()
        for i in range(10):
            await orch.record_interaction(0.5 + i * 0.03, 100.0 + i * 10)
        metrics = orch.get_metrics()
        assert metrics.total_interactions == 10
        assert 0.5 < metrics.average_quality < 1.0

    async def test_record_interaction_updates_quality_history(self):
        orch = EvolutionOrchestrator.get_instance()
        await orch.record_interaction(0.3, 100.0)
        await orch.record_interaction(0.9, 200.0)
        metrics = orch.get_metrics()
        assert metrics.average_quality > 0.5

    async def test_record_interaction_tracks_failures(self):
        orch = EvolutionOrchestrator.get_instance()
        orch._consecutive_failure_count = 0
        await orch.record_interaction(0.2, 100.0, tool_successes=False)
        assert orch._consecutive_failure_count >= 1
        await orch.record_interaction(0.7, 100.0, tool_successes=True)
        assert orch._consecutive_failure_count == 0

    async def test_triggers_optimization_cycle_periodic(self):
        orch = EvolutionOrchestrator.get_instance()
        evo = EvolutionEngine()
        orch.register_engines(evolution_engine=evo)
        for i in range(20):
            await orch.record_interaction(0.7, 100.0)
        assert orch._interaction_count == 20

    def test_set_engine_cooldown(self):
        orch = EvolutionOrchestrator.get_instance()
        orch.set_engine_cooldown("EvolutionEngine", 60000)
        assert orch._engine_cooldowns["EvolutionEngine"] == 60000

    def test_reset_daily_count(self):
        orch = EvolutionOrchestrator.get_instance()
        orch._cycles_today = 10
        orch.reset_daily_count()
        assert orch._cycles_today == 0

    def test_add_verification(self):
        orch = EvolutionOrchestrator.get_instance()
        orch.add_verification("tool_quality", "shell_exec", 0.5, 0.8, True, 0.9)
        assert len(orch._verification_results) == 1
        metrics = orch.get_metrics()
        assert metrics.verification_success_rate == 1.0

    def test_add_verification_failed(self):
        orch = EvolutionOrchestrator.get_instance()
        orch.add_verification("tool_quality", "shell_exec", 0.5, 0.3, False, 0.7)
        metrics = orch.get_metrics()
        assert metrics.verification_success_rate == 0.0

    def test_get_current_llm_capabilities_no_detector(self):
        orch = EvolutionOrchestrator.get_instance()
        assert orch.get_current_llm_capabilities("openai") is None

    def test_get_current_strategy_no_adapter(self):
        orch = EvolutionOrchestrator.get_instance()
        assert orch.get_current_strategy() is None

    async def test_detect_and_adapt_no_detector(self):
        orch = EvolutionOrchestrator.get_instance()
        result = await orch.detect_and_adapt_llm_capabilities("openai", MockLLM())
        assert result is None

    async def test_detect_and_adapt_with_detector(self):
        orch = EvolutionOrchestrator.get_instance()
        detector = LLMCapabilityDetector()
        adapter = StrategyAdapter()
        orch.register_engines(capability_detector=detector, strategy_adapter=adapter)
        result = await orch.detect_and_adapt_llm_capabilities("openai", MockLLM())
        assert result is not None
        assert "capabilities" in result
        assert "strategy" in result

    async def test_quality_trend_improving(self):
        orch = EvolutionOrchestrator.get_instance()
        for i in range(10):
            await orch.record_interaction(0.3 + i * 0.04, 100.0)
        metrics = orch.get_metrics()
        assert metrics.quality_trend == "improving"

    async def test_quality_trend_declining(self):
        orch = EvolutionOrchestrator.get_instance()
        for i in range(10):
            await orch.record_interaction(0.8 - i * 0.04, 100.0)
        metrics = orch.get_metrics()
        assert metrics.quality_trend == "declining"

    async def test_quality_trend_stable(self):
        orch = EvolutionOrchestrator.get_instance()
        for _ in range(10):
            await orch.record_interaction(0.7, 100.0)
        metrics = orch.get_metrics()
        assert metrics.quality_trend == "stable"

    async def test_metrics_tool_weights_from_engine(self):
        orch = EvolutionOrchestrator.get_instance()
        evo = EvolutionEngine()
        evo._tool_weights["shell_exec"] = 0.8
        evo._tool_weights["read_file"] = 0.5
        orch.register_engines(evolution_engine=evo)
        metrics = orch.get_metrics()
        assert "shell_exec" in metrics.tool_weights
        assert metrics.tool_weights["shell_exec"] == 0.8

    def test_detect_auto_improvement_low_quality(self):
        orch = EvolutionOrchestrator.get_instance()
        orch._interaction_count = 20
        orch._consecutive_low_quality_count = 5
        orch._quality_history = [0.3] * 20
        cause = orch._detect_auto_improvement()
        assert cause is not None
        assert cause["type"] == "LOW_QUALITY"

    def test_detect_auto_improvement_failure(self):
        orch = EvolutionOrchestrator.get_instance()
        orch._interaction_count = 20
        orch._consecutive_failure_count = 5
        orch._quality_history = [0.6] * 20
        cause = orch._detect_auto_improvement()
        assert cause is not None
        assert cause["type"] == "FAILURE"

    def test_detect_auto_improvement_none(self):
        orch = EvolutionOrchestrator.get_instance()
        orch._interaction_count = 5
        cause = orch._detect_auto_improvement()
        assert cause is None

    def test_no_auto_improvement_when_quality_ok(self):
        orch = EvolutionOrchestrator.get_instance()
        orch._interaction_count = 20
        orch._quality_history = [0.8] * 20
        orch._consecutive_low_quality_count = 0
        orch._consecutive_failure_count = 0
        cause = orch._detect_auto_improvement()
        assert cause is None


class TestOptimizationCycle:
    def test_cycle_creation(self):
        cycle = OptimizationCycle(
            cycle_id="test-001",
            timestamp=time.time(),
        )
        assert cycle.cycle_id == "test-001"
        assert cycle.engines_participated == []
        assert cycle.results == []

    def test_cycle_with_results(self):
        result = OptimizationCycleResult(
            engine_name="EvolutionEngine",
            triggered=True,
            detail="Success",
        )
        cycle = OptimizationCycle(
            cycle_id="test-002",
            timestamp=time.time(),
            engines_participated=["EvolutionEngine"],
            results=[result],
            overall_score=0.85,
        )
        assert len(cycle.results) == 1
        assert cycle.results[0].engine_name == "EvolutionEngine"
        assert cycle.overall_score == 0.85


class TestVerificationResult:
    def test_verification_result(self):
        vr = VerificationResult(
            vtype="tool_quality",
            target="shell_exec",
            before_score=0.5,
            after_score=0.8,
            success=True,
            confidence=0.9,
        )
        assert vr.vtype == "tool_quality"
        assert vr.success is True
        assert vr.confidence == 0.9


class TestOrchestratorMetrics:
    def test_default_metrics(self):
        m = OrchestratorMetrics()
        assert m.total_interactions == 0
        assert m.average_quality == 0.0
        assert m.quality_trend == "stable"
        assert m.engines_active == []

    def test_metrics_with_data(self):
        m = OrchestratorMetrics(
            total_interactions=100,
            total_optimizations=10,
            average_quality=0.75,
            quality_trend="improving",
            response_time_avg=150.0,
            response_time_p95=300.0,
            cycle_success_rate=0.8,
            cycles_today=5,
            engines_active=["EvolutionEngine"],
            verification_success_rate=0.9,
            tool_weights={"shell_exec": 0.8},
        )
        assert m.total_interactions == 100
        assert m.average_quality == 0.75
        assert m.quality_trend == "improving"
        assert m.cycle_success_rate == 0.8
        assert m.verification_success_rate == 0.9
