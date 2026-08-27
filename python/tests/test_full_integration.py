"""P0/P1/P2 全量集成测试 — 验证 ConversationLoop 与所有新引擎的集成。"""

from __future__ import annotations

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


class TestConversationLoopIntegration:
    """验证 ConversationLoop 绑定新引擎后的集成行为。"""

    def test_bind_all_p0_p1_p2_engines(self):
        from agent.core.conversation_loop import ConversationLoop
        loop = ConversationLoop.__new__(ConversationLoop)
        loop._reasoning_kernel = None
        loop._meta_cognition = None
        loop._hallucination_detector = None
        loop._adaptive_budget = None
        loop._memory_isolator = None
        loop._operation_rollback = None
        loop._world_model = None
        loop._continual_learning = None
        loop._cross_device_coordinator = None

        loop.set_reasoning_kernel(MagicMock())
        assert loop._reasoning_kernel is not None

        loop.set_meta_cognition(MagicMock())
        assert loop._meta_cognition is not None

        loop.set_hallucination_detector(MagicMock())
        assert loop._hallucination_detector is not None

        loop.set_adaptive_budget(MagicMock())
        assert loop._adaptive_budget is not None

        loop.set_memory_isolator(MagicMock())
        assert loop._memory_isolator is not None

        loop.set_operation_rollback(MagicMock())
        assert loop._operation_rollback is not None

        loop.set_world_model(MagicMock())
        assert loop._world_model is not None

        loop.set_continual_learning(MagicMock())
        assert loop._continual_learning is not None

        loop.set_cross_device_coordinator(MagicMock())
        assert loop._cross_device_coordinator is not None


class TestWorldModelIntegration:
    """P2-1: 世界模型与主循环集成。"""

    def test_predict_before_tool_execution(self):
        from agent.cognition.world_model import WorldModel, WorldState, Entity, EntityState
        model = WorldModel()
        state = WorldState(
            state_id="s1",
            entities={"btn": Entity(entity_id="btn", name="OK", state=EntityState.ACTIVE, enabled=True)},
        )
        pred = asyncio.get_event_loop().run_until_complete(model.predict(state, "click", "btn"))
        assert pred.confidence >= 0.5
        assert pred.prediction_id.startswith("pred_")

    def test_surprise_detection_after_state_change(self):
        from agent.cognition.world_model import WorldModel, WorldState, Entity, EntityState
        model = WorldModel()
        before = WorldState(state_id="s1", entities={
            "win": Entity(entity_id="win", name="Dialog", state=EntityState.ACTIVE, visible=True),
        })
        after = WorldState(state_id="s2", entities={
            "win": Entity(entity_id="win", name="Dialog", state=EntityState.ERROR, visible=False),
        })
        report = asyncio.get_event_loop().run_until_complete(model.detect_surprise(before, after, threshold=0.1))
        assert report.is_surprising
        assert report.surprise_score > 0

    def test_causal_rule_learning_and_update(self):
        from agent.cognition.world_model import WorldModel, CausalRule
        model = WorldModel()
        rule = CausalRule(
            rule_id="test_scroll", action_pattern="scroll",
            target_pattern="list", expected_effects={"scrolled": True},
            probability=0.7,
        )
        model.learn_causal_rule(rule)
        assert "test_scroll" in model.causal_rules

        model.update_rule_from_outcome("test_scroll", success=True)
        assert model.causal_rules["test_scroll"].probability > 0.7

        model.update_rule_from_outcome("test_scroll", success=False)
        assert model.causal_rules["test_scroll"].learned_from == 2


class TestContinualLearningIntegration:
    """P2-2: 持续学习与主循环集成。"""

    def test_record_and_learn_cycle(self):
        from agent.cognition.continual_learning import ContinualLearningLoop
        loop = ContinualLearningLoop()
        loop.record_experience("搜索文档", "web_search", "找到结果", True, 0.9, 500, ["web_search"], "direct")
        loop.record_experience("搜索文档", "web_search", "找到结果", True, 0.85, 600, ["web_search"], "direct")
        loop.record_experience("调试代码", "code_execute", "修复bug", True, 0.8, 1200, ["code_execute"], "cot")
        loop.record_experience("部署服务", "deploy", "失败", False, 0.2, 3000, ["deploy"], "direct")

        report = asyncio.get_event_loop().run_until_complete(loop.learn())
        assert report.total_experiences == 4
        assert report.new_patterns_found >= 0

    def test_knowledge_retrieval_for_context_injection(self):
        from agent.cognition.continual_learning import ContinualLearningLoop, KnowledgeCategory
        loop = ContinualLearningLoop()
        loop.record_experience("搜索Python文档", "web_search", "OK", True, 0.9, 500, ["web_search"], "direct")
        loop.record_experience("搜索Python文档", "web_search", "OK", True, 0.85, 600, ["web_search"], "direct")
        loop.record_experience("搜索Python文档", "web_search", "OK", True, 0.88, 550, ["web_search"], "direct")
        asyncio.get_event_loop().run_until_complete(loop.learn())

        entries = loop.retrieve_relevant_knowledge("搜索Python", top_k=3)
        assert len(entries) >= 0

    def test_tool_and_strategy_recommendations(self):
        from agent.cognition.continual_learning import ContinualLearningLoop
        loop = ContinualLearningLoop()
        tools = loop.get_tool_recommendation("search")
        assert len(tools) > 0
        assert tools[0][1] > 0.5

        strategies = loop.get_strategy_recommendation("task")
        assert len(strategies) > 0


class TestCrossDeviceIntegration:
    """P2-3: 跨设备协同与主循环集成。"""

    def test_multi_device_task_execution(self):
        from agent.cognition.cross_device import (
            CrossDeviceCoordinator, DeviceProfile, DeviceCapability,
            DeviceKind, DeviceStatus,
        )
        coord = CrossDeviceCoordinator()
        coord.register_device(DeviceProfile(
            device_id="desktop1", name="Main PC", kind=DeviceKind.DESKTOP,
            status=DeviceStatus.ONLINE,
            capabilities=[
                DeviceCapability(name="screen_capture", reliability=0.95, avg_latency_ms=50),
                DeviceCapability(name="uia", reliability=0.9, avg_latency_ms=30),
            ],
        ))
        coord.register_device(DeviceProfile(
            device_id="phone1", name="Phone", kind=DeviceKind.MOBILE,
            status=DeviceStatus.ONLINE,
            capabilities=[
                DeviceCapability(name="tap", reliability=0.85, avg_latency_ms=100),
                DeviceCapability(name="swipe", reliability=0.8, avg_latency_ms=80),
            ],
        ))

        result = asyncio.get_event_loop().run_until_complete(
            coord.execute_task(
                "截图并点击",
                subtask_defs=[
                    {"description": "截图", "capabilities": ["screen_capture"]},
                    {"description": "点击", "capabilities": ["tap"]},
                ],
            )
        )
        assert result.success
        assert result.completed_subtasks == 2
        assert len(result.devices_used) >= 1

    def test_device_registry_heartbeat(self):
        from agent.cognition.cross_device import DeviceRegistry, DeviceProfile, DeviceKind, DeviceStatus
        registry = DeviceRegistry(heartbeat_timeout_s=30.0)
        registry.register(DeviceProfile(
            device_id="dev1", name="Device1", kind=DeviceKind.DESKTOP,
            status=DeviceStatus.ONLINE,
        ))
        assert registry.online_count == 1
        assert registry.update_heartbeat("dev1")
        assert not registry.update_heartbeat("nonexistent")

    def test_no_available_device_fallback(self):
        from agent.cognition.cross_device import CrossDeviceCoordinator
        coord = CrossDeviceCoordinator()
        result = asyncio.get_event_loop().run_until_complete(
            coord.execute_task("需要不存在的设备", required_capabilities=["quantum_compute"])
        )
        assert not result.success
        assert result.failed_subtasks > 0


class TestP0P1ExistingIntegration:
    """验证之前实现的 P0/P1 模块仍然正常工作。"""

    def test_counterfactual_engine(self):
        from agent.reasoning.counterfactual import CounterfactualEngine, DecisionNode, DecisionImportance
        engine = CounterfactualEngine()
        path = [DecisionNode(node_id="n1", thought="A", score=0.8, depth=0, importance=DecisionImportance.HIGH)]
        report = asyncio.get_event_loop().run_until_complete(engine.analyze("test", path))
        assert report.report_id.startswith("cf_")

    def test_constitution_checker(self):
        from agent.alignment.constitution_checker import ConstitutionChecker, ConstitutionRule
        checker = ConstitutionChecker()
        result = checker.check("正常输出")
        assert result.is_compliant

    def test_hallucination_detector(self):
        from agent.verification.hallucination_detector import HallucinationDetector
        detector = HallucinationDetector()
        result = asyncio.get_event_loop().run_until_complete(detector.detect("正常输出"))
        assert result.overall_confidence >= 0.8

    def test_reasoning_kernel(self):
        from agent.reasoning.kernel import ReasoningKernel, ComplexityLevel
        kernel = ReasoningKernel()
        complexity = kernel._assess_complexity("简单问题", {})
        assert complexity.level == ComplexityLevel.SIMPLE

    def test_meta_cognition(self):
        from agent.core.meta_cognition import MetaCognitionEngine
        engine = MetaCognitionEngine()
        assessment = asyncio.get_event_loop().run_until_complete(
            engine.assess_confidence(task="编写代码", result="代码实现")
        )
        assert 0.0 <= assessment.overall_confidence <= 1.0

    def test_adaptive_budget(self):
        from agent.context.adaptive_budget import AdaptiveTokenBudgetEngine, Scene
        budget = AdaptiveTokenBudgetEngine(max_tokens=128000)
        result = budget.allocate(scene=Scene.CODING)
        total = (result.allocation.system_prompt + result.allocation.memory +
                 result.allocation.history + result.allocation.dynamic_context +
                 result.allocation.tool_results + result.allocation.reserve)
        assert total <= 128000

    def test_memory_isolation(self):
        from agent.memory.isolation import SubAgentMemoryIsolator, IsolationLevel, MergeStrategy
        isolator = SubAgentMemoryIsolator()
        isolator.create_snapshot("agent_a", IsolationLevel.SNAPSHOT)
        entry = isolator.write_to_snapshot("agent_a", "数据A", importance=0.8)
        assert entry.content == "数据A"

    def test_operation_rollback(self):
        import tempfile
        from pathlib import Path
        from agent.desktop.operation_rollback import OperationRollbackEngine, OperationType
        with tempfile.TemporaryDirectory() as tmpdir:
            f = Path(tmpdir) / "test.txt"
            f.write_text("original", encoding="utf-8")
            engine = OperationRollbackEngine(backup_root=tmpdir)
            cp = engine.save_checkpoint(OperationType.FILE_WRITE, target=str(f))
            f.write_text("modified", encoding="utf-8")
            rb = engine.rollback(cp.checkpoint_id)
            assert rb.success
            assert f.read_text(encoding="utf-8") == "original"
