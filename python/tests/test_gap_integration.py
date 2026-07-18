"""GAP-02~10 集成测试 — 验证各模块已接入 AgentEngine 主流程"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


class TestGAP02PerformanceMonitor:
    def test_performance_monitor_initialized(self):
        from agent.evolution.monitor import PerformanceMonitor
        monitor = PerformanceMonitor()
        assert monitor is not None

    def test_record_metric(self):
        from agent.evolution.monitor import PerformanceMonitor
        monitor = PerformanceMonitor()
        monitor.record_metric("task_completion", success=True, duration=1.5)

    def test_check_alerts(self):
        from agent.evolution.monitor import PerformanceMonitor
        monitor = PerformanceMonitor()
        alerts = monitor.check_alerts()
        assert isinstance(alerts, list)


class TestGAP03FewShotGeneralizer:
    def test_generalizer_initialized(self):
        from agent.evolution.fewshot_generalizer import FewShotGeneralizer
        from agent.loop.reflection_knowledge_base import ReflectionKnowledgeBase
        kb = ReflectionKnowledgeBase()
        gen = FewShotGeneralizer(kb)
        assert gen is not None

    def test_find_similar_experiences(self):
        from agent.evolution.fewshot_generalizer import FewShotGeneralizer
        from agent.loop.reflection_knowledge_base import ReflectionKnowledgeBase
        kb = ReflectionKnowledgeBase()
        gen = FewShotGeneralizer(kb)
        results = gen.find_similar_experiences("测试查询")
        assert isinstance(results, list)


class TestGAP05IncrementalPlanner:
    def test_planner_initialized(self):
        from agent.loop.incremental_planner import IncrementalPlanner
        planner = IncrementalPlanner()
        assert planner is not None

    def test_incremental_replan(self):
        from agent.loop.incremental_planner import IncrementalPlanner, PlanStep
        planner = IncrementalPlanner()
        steps = [
            PlanStep(step_id="s1", description="步骤1", order=0),
            PlanStep(step_id="s2", description="步骤2", order=1),
        ]
        result = planner.incremental_replan(steps, steps[0], "测试变更")
        assert result is not None
        assert hasattr(result, "success")


class TestGAP06StrategyAdapter:
    def test_adapter_initialized(self):
        from agent.evolution.strategy_adapter import StrategyAdapter
        adapter = StrategyAdapter()
        assert adapter is not None

    def test_record_outcome(self):
        from agent.evolution.strategy_adapter import StrategyAdapter
        adapter = StrategyAdapter()
        adapter.record_outcome("daily", "conversation", success=True)

    def test_get_best_strategy(self):
        from agent.evolution.strategy_adapter import StrategyAdapter
        adapter = StrategyAdapter()
        adapter.record_outcome("daily", "strategy_a", success=True)
        adapter.record_outcome("daily", "strategy_a", success=True)
        best = adapter.get_best_strategy("daily")
        assert best is not None


class TestGAP08PlanQualityChecker:
    def test_checker_initialized(self):
        from agent.loop.plan_quality_checker import PlanQualityChecker
        checker = PlanQualityChecker()
        assert checker is not None

    def test_check_plan_passes(self):
        from agent.loop.plan_quality_checker import PlanQualityChecker
        checker = PlanQualityChecker()
        plan = [
            {"step_id": "s1", "description": "分析需求", "tool_name": "read_file"},
            {"step_id": "s2", "description": "实现功能", "tool_name": "write_file"},
        ]
        result = checker.check_plan(plan)
        assert result is not None
        assert hasattr(result, "quality_score")
        assert hasattr(result, "is_passed")

    def test_check_empty_plan(self):
        from agent.loop.plan_quality_checker import PlanQualityChecker
        checker = PlanQualityChecker()
        result = checker.check_plan([])
        assert result.quality_score == 0.0


class TestGAP09LearningSignals:
    def test_collector_initialized(self):
        from agent.evolution.learning_signals import LearningSignalCollector
        collector = LearningSignalCollector()
        assert collector is not None

    def test_record_signal(self):
        from agent.evolution.learning_signals import LearningSignalCollector
        collector = LearningSignalCollector()
        collector.record_signal("task_success", value=1.0, source="test")

    def test_analyze_signals(self):
        from agent.evolution.learning_signals import LearningSignalCollector
        collector = LearningSignalCollector()
        collector.record_signal("task_success", value=1.0, source="test")
        collector.record_signal("task_failure", value=0.0, source="test")
        insights = collector.analyze_signals()
        assert insights is not None


class TestGAP10ReflectionApplier:
    def test_applier_initialized(self):
        from agent.loop.reflection_applier import ReflectionApplicationManager
        manager = ReflectionApplicationManager()
        assert manager is not None

    def test_record_reflection(self):
        from agent.loop.reflection_applier import ReflectionApplicationManager, ReflectionType
        manager = ReflectionApplicationManager()
        record_id = manager.add_reflection(
            reflection_type=ReflectionType.TOOL_FAILURE,
            content="工具调用失败",
            insight="尝试替代工具",
            tags=["read_file"],
        )
        assert record_id is not None


class TestEngineGAPIntegration:
    def test_engine_has_gap_attributes(self):
        from agent.core.engine import AgentEngine
        engine = AgentEngine()
        assert hasattr(engine, "performance_monitor")
        assert hasattr(engine, "evolution_trigger")
        assert hasattr(engine, "fewshot_generalizer")
        assert hasattr(engine, "strategy_adapter")
        assert hasattr(engine, "learning_signals")
        assert hasattr(engine, "incremental_planner")
        assert hasattr(engine, "plan_quality_checker")
        assert hasattr(engine, "reflection_applier")

    @pytest.mark.asyncio
    async def test_engine_initializes_gap_modules(self):
        from agent.core.engine import AgentEngine
        engine = AgentEngine()
        with patch.dict("os.environ", {"OTEL_ENABLED": "false", "REDIS_ENABLED": "false"}):
            await engine.initialize()
        assert engine.performance_monitor is not None
        assert engine.strategy_adapter is not None
        assert engine.learning_signals is not None
        assert engine.incremental_planner is not None
        assert engine.plan_quality_checker is not None
        assert engine.reflection_applier is not None
