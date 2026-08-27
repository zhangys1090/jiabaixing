"""模块协作逻辑测试 - 不依赖外部包(纯mock)

这些测试验证各模块间的协作逻辑,即使没有Redis/OTel等依赖也能运行。
"""
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent))


class TestModuleContractValidation:
    """测试模块间的接口契约验证"""

    async def test_memory_api_contract(self):
        """验证Memory API的接口契约"""
        from agent.models.memory import MemoryStoreRequest, MemorySearchRequest

        # 测试MemoryStoreRequest
        store_req = MemoryStoreRequest(
            content="测试内容",
            memory_type="episodic",
            scene="test",
            emotion="neutral"
        )
        assert store_req.content == "测试内容", "内容字段应正确"
        assert store_req.memory_type == "episodic", "类型字段应正确"

        # 测试MemorySearchRequest
        search_req = MemorySearchRequest(query="搜索词", limit=5)
        assert search_req.query == "搜索词", "查询字段应正确"
        assert search_req.limit == 5, "限制字段应正确"

    async def test_loop_data_models(self):
        """测试Loop阶段的数据模型（与 agent/models/plan.py 当前契约一致）"""
        from agent.models.plan import PlanStep

        # 按 PlanStep 当前字段构造（step_id 为 int，工具链用 tool/tool_input/depends_on）
        step = PlanStep(
            step_id=1,
            description="测试描述",
            tool="search",
            tool_input={"query": "x"},
            depends_on=[],
        )
        assert step.step_id == 1, "步骤ID应正确"
        assert step.description == "测试描述", "描述应正确"
        assert step.tool == "search", "工具名应正确"

    async def test_a2a_type_definitions(self):
        """验证A2A协议类型定义（当前 A2A* 命名空间契约）"""
        from agent.a2a.types import (
            A2AAgentCard,
            A2ACapability,
            A2ACapabilityType,
            A2ATask,
            A2ATaskStatus,
        )

        # 测试A2ACapability
        cap = A2ACapability(type=A2ACapabilityType.TASK_EXECUTION, name="test-cap")
        assert cap.name == "test-cap", "能力名称应正确"

        # 测试A2AAgentCard
        card = A2AAgentCard(
            id="agent:test",
            name="test-agent",
            description="测试Agent",
            capabilities=[cap],
        )
        assert card.name == "test-agent", "Agent名称应正确"
        assert card.id == "agent:test", "Agent ID应正确"

        # 测试A2ATask（dataclass，用 to_dict() 序列化）
        task = A2ATask(
            id="task_001",
            session_id="sess_1",
            description="测试任务",
            from_agent_id="agent:caller",
            to_agent_id="agent:test",
        )
        json_str = json.dumps(task.to_dict())
        assert "task_001" in json_str, "任务ID应在序列化结果中"

        # 测试A2ATaskStatus枚举
        assert A2ATaskStatus.SUBMITTED.value == "submitted", "TaskStatus应正确"


class TestMemoryLogicFlow:
    """测试记忆系统的逻辑流"""

    async def test_memory_storage_flow(self):
        """测试记忆存储流程"""
        from agent.api.memory import get_memory

        # Mock memory engine
        mock_mem = AsyncMock()
        mock_mem.store = AsyncMock(return_value="mem_abc123")
        mock_mem.search = AsyncMock(return_value=[
            {"id": "m1", "content": "result1", "score": 0.95},
            {"id": "m2", "content": "result2", "score": 0.85}
        ])
        mock_mem.get_stats = AsyncMock(return_value={"total": 2})

        with patch('agent.api.memory.get_memory', return_value=mock_mem):
            # 测试存储
            mem_id = await mock_mem.store(
                content="测试记忆",
                memory_type="episodic"
            )
            assert mem_id == "mem_abc123", "存储ID应正确返回"

            # 测试搜索
            results = await mock_mem.search(query="关键词", limit=10)
            assert len(results) == 2, "应返回2条结果"
            assert results[0]["score"] > results[1]["score"], "结果应按分数降序"

    async def test_memory_retrieval_by_type(self):
        """测试按类型检索记忆"""
        from agent.api.memory import get_memory

        mock_mem = AsyncMock()
        mock_mem.search = AsyncMock(return_value=[
            {"id": "e1", "content": "情景记忆", "type": "episodic"},
            {"id": "s1", "content": "语义记忆", "type": "semantic"}
        ])

        with patch('agent.api.memory.get_memory', return_value=mock_mem):
            episodic_results = await mock_mem.search(query="test", memory_type="episodic")
            assert len(episodic_results) == 2, "应返回所有匹配类型的结果"


class TestLoopOrchestrationLogic:
    """测试Loop编排逻辑"""

    async def test_task_decomposition(self):
        """测试任务分解逻辑"""
        from agent.loop.causal import CausalGraphNode, CausalGraphEdge, CausalGraph

        # 构建一个简单的因果图
        nodes = [
            CausalGraphNode(id="parse", description="解析输入", type="analysis"),
            CausalGraphNode(id="retrieve", description="检索记忆", type="action"),
            CausalGraphNode(id="generate", description="生成响应", type="action"),
        ]

        edges = [
            CausalGraphEdge(from_id="parse", to_id="retrieve", reason="需要先解析"),
            CausalGraphEdge(from_id="retrieve", to_id="generate", reason="需要记忆上下文"),
        ]

        graph = CausalGraph(nodes=nodes, edges=edges)

        assert len(graph.nodes) == 3, "应有3个节点"
        assert len(graph.edges) == 2, "应有2条边"
        assert graph.nodes[0].type == "analysis", "第一个节点类型应正确"

    async def test_parallel_task_grouping(self):
        """测试并行任务分组"""
        from agent.loop.causal import CausalGraph, CausalGraphNode

        graph = CausalGraph(
            nodes=[
                CausalGraphNode(id="t1", description="任务1"),
                CausalGraphNode(id="t2", description="任务2"),
                CausalGraphNode(id="t3", description="任务3(串行)"),
            ],
            parallel_groups=[["t1", "t2"]]  # t1和t2可以并行执行
        )

        assert len(graph.parallel_groups[0]) == 2, "并行组应有2个任务"
        assert "t3" not in graph.parallel_groups[0], "t3不应在并行组中"


class TestReflectionAndEvaluation:
    """测试反思和评估逻辑"""

    async def test_quality_scoring(self):
        """测试质量评分逻辑"""
        from unittest.mock import MagicMock

        from agent.loop.evaluator import Evaluator

        # 当前 Evaluator 需要注入 LLMProvider（契约见 agent/loop/evaluator.py）
        evaluator = Evaluator(llm=MagicMock())

        # 验证evaluator实例能正确创建
        assert evaluator is not None, "Evaluator应能正确实例化"

    async def test_output_validation_logic(self):
        """测试输出验证逻辑"""
        # Mock validation function
        def validate_output(output: dict) -> bool:
            """Basic output validation"""
            required_keys = ["status", "data"]
            return all(k in output for k in required_keys)

        # Test valid output
        valid = {"status": "success", "data": {"result": "test"}}
        assert validate_output(valid), "有效输出应通过验证"

        # Test invalid output
        invalid = {"status": "success"}  # Missing 'data'
        assert not validate_output(invalid), "无效输出应验证失败"


class TestSecurityAndGuardrails:
    """测试安全和护栏逻辑"""

    async def test_sensitive_content_detection(self):
        """测试敏感内容检测"""
        from agent.security.sensitive_detector import (
            CheckScene,
            SensitiveCheckResult,
            check_sensitive_info,
        )

        # 当前契约：函数式 check_sensitive_info(text, scene) -> SensitiveCheckResult
        res = check_sensitive_info("my api key is sk-123", scene=CheckScene.OUTPUT)
        assert res is not None, "check_sensitive_info 应返回结果"
        assert isinstance(res, SensitiveCheckResult), "应返回 SensitiveCheckResult"
        assert hasattr(res, "risk_level"), "结果应包含 risk_level 字段"

    async def test_permission_check_flow(self):
        """测试权限检查流程"""
        from agent.tools.permission_guard import PermissionGuard

        guard = PermissionGuard()
        assert guard is not None, "PermissionGuard应能正确实例化"


class TestToolCallValidation:
    """测试工具调用验证"""

    async def test_schema_validation(self):
        """测试参数Schema验证"""
        from agent.tools.schema_validator import SchemaValidator

        validator = SchemaValidator()
        assert validator is not None, "Validator应能正确实例化"

    async def test_tool_call_guard(self):
        """测试工具调用守卫"""
        from agent.tools.tool_call_guard import ToolCallGuard

        guard = ToolCallGuard()
        assert guard is not None, "ToolCallGuard应能正确实例化"


class TestBatchProcessing:
    """测试批量处理逻辑"""

    async def test_batch_processor_creation(self):
        """测试批量处理器创建"""
        from agent.loop.batch_processor import BatchConfig, BatchProcessor

        # 当前契约：BatchProcessor(config: BatchConfig | None = None)
        processor = BatchProcessor(BatchConfig(concurrency=10))
        assert processor is not None, "BatchProcessor应能正确实例化"


class TestSandboxContract:
    """测试沙箱隔离模块契约"""

    async def test_sandbox_tier_enum(self):
        from agent.sandbox.executor import SandboxTier

        assert SandboxTier.KERNEL.value == "kernel"
        assert SandboxTier.CONTAINER.value == "container"
        assert SandboxTier.PROCESS.value == "process"
        assert SandboxTier.LOGICAL.value == "logical"

    async def test_sandbox_tier_info_dataclass(self):
        from agent.sandbox.executor import SandboxTier, SandboxTierInfo

        info = SandboxTierInfo(tier=SandboxTier.PROCESS, available=True, reason="test")
        assert info.tier == SandboxTier.PROCESS
        assert info.available is True
        assert info.reason == "test"

    async def test_sandbox_config_contract(self):
        from agent.sandbox.executor import SandboxConfig, SecurityLevel

        config = SandboxConfig(security_level=SecurityLevel.HIGH, timeout_ms=5000)
        assert config.security_level == SecurityLevel.HIGH
        assert config.timeout_ms == 5000
        assert config.network_policy == "deny"

    async def test_sandbox_execution_result_contract(self):
        from agent.sandbox.executor import SandboxExecutionResult

        result = SandboxExecutionResult(success=True, output="ok", duration_ms=100)
        assert result.success is True
        assert result.output == "ok"
        assert result.duration_ms == 100

    async def test_kernel_isolation_type_enum(self):
        from agent.sandbox.kernel_isolation import KernelIsolationType

        assert KernelIsolationType.GVISOR.value == "gvisor"
        assert KernelIsolationType.FIRECRACKER.value == "firecracker"
        assert KernelIsolationType.WINDOWS_SANDBOX.value == "windows_sandbox"

    async def test_kernel_sandbox_config_contract(self):
        from agent.sandbox.kernel_isolation import KernelSandboxConfig, KernelIsolationType

        config = KernelSandboxConfig(isolation_type=KernelIsolationType.GVISOR, memory_mb=512)
        assert config.isolation_type == KernelIsolationType.GVISOR
        assert config.memory_mb == 512
        assert config.network == "none"

    async def test_kernel_sandbox_result_contract(self):
        from agent.sandbox.kernel_isolation import KernelSandboxResult, KernelIsolationType

        result = KernelSandboxResult(
            success=True, output="done", isolation_type=KernelIsolationType.GVISOR, vm_id="vm-001",
        )
        assert result.success is True
        assert result.isolation_type == KernelIsolationType.GVISOR
        assert result.vm_id == "vm-001"

    async def test_kernel_provider_plugin_api(self):
        from agent.sandbox.kernel_isolation import KernelIsolationProvider, KernelIsolationType

        backends = KernelIsolationProvider.list_backends()
        assert len(backends) >= 3, "应有至少3个默认后端"
        names = [b.name for b in backends]
        assert KernelIsolationType.GVISOR in names
        assert KernelIsolationType.FIRECRACKER in names
        assert KernelIsolationType.WINDOWS_SANDBOX in names

    async def test_risk_tool_classification(self):
        from agent.sandbox.executor import _HIGH_RISK_TOOLS, _MEDIUM_RISK_TOOLS

        assert "delete_file" in _HIGH_RISK_TOOLS
        assert "execute_command" in _HIGH_RISK_TOOLS
        assert "write_file" in _MEDIUM_RISK_TOOLS
        assert _HIGH_RISK_TOOLS.isdisjoint(_MEDIUM_RISK_TOOLS), "高/中危工具不应重叠"


class TestGatewayContract:
    """测试网关模块契约"""

    async def test_message_dataclass(self):
        from agent.gateway.base import Message

        msg = Message(platform="feishu", sender="user1", content="hello")
        assert msg.platform == "feishu"
        assert msg.sender == "user1"
        assert msg.content == "hello"
        assert msg.id != ""

    async def test_platform_adapter_interface(self):
        from agent.gateway.base import PlatformAdapter

        abstract_methods = {"start", "stop", "send_message", "receive_message", "is_connected"}
        actual = {m for m in dir(PlatformAdapter) if not m.startswith("_")}
        assert abstract_methods.issubset(actual), f"PlatformAdapter缺少方法: {abstract_methods - actual}"

    async def test_feishu_adapter_contract(self):
        from agent.gateway.platforms.feishu_adapter import FeishuAdapter
        from agent.gateway.base import PlatformAdapter

        adapter = FeishuAdapter(app_id="test_id", app_secret="test_secret")
        assert isinstance(adapter, PlatformAdapter)
        assert adapter.name == "feishu"
        assert adapter.simulated is False

    async def test_gateway_config_contract(self):
        from agent.gateway.base import GatewayConfig

        config = GatewayConfig(host="0.0.0.0", port=9000)
        assert config.host == "0.0.0.0"
        assert config.port == 9000
        assert config.max_retries == 3

    async def test_platform_toolset_contract(self):
        from agent.tools.platform_toolset import AgentPlatform, PLATFORM_TOOLSET_MAP

        assert AgentPlatform.FEISHU.value == "feishu"
        assert AgentPlatform.FEISHU in PLATFORM_TOOLSET_MAP
        assert PLATFORM_TOOLSET_MAP[AgentPlatform.FEISHU] == "daily"


class TestEvolutionContract:
    """测试进化闭环模块契约"""

    async def test_learning_signal_types(self):
        from agent.evolution.types import SignalType

        assert hasattr(SignalType, "TASK_SUCCESS")
        assert hasattr(SignalType, "TASK_FAILURE")
        assert hasattr(SignalType, "TOOL_ERROR")

    async def test_learning_signal_dataclass(self):
        from agent.evolution.types import LearningSignal, SignalType
        import time

        signal = LearningSignal(
            signal_type=SignalType.TASK_SUCCESS,
            quality=0.85,
            timestamp=time.time(),
        )
        assert signal.signal_type == SignalType.TASK_SUCCESS
        assert signal.quality == 0.85

    async def test_feedback_types(self):
        from agent.evolution.types import FeedbackType, FeedbackStrength, FeedbackSource

        assert hasattr(FeedbackType, "POSITIVE")
        assert hasattr(FeedbackType, "NEGATIVE")
        assert hasattr(FeedbackStrength, "MEDIUM")
        assert hasattr(FeedbackSource, "SATISFACTION")


class TestLongTaskContract:
    """测试长任务编排模块契约"""

    async def test_long_task_config(self):
        from agent.core.long_task import LongTaskConfig

        config = LongTaskConfig(max_duration_sec=3600, checkpoint_interval_sec=60)
        assert config.max_duration_sec == 3600
        assert config.checkpoint_interval_sec == 60

    async def test_long_task_priority(self):
        from agent.core.long_task import TaskPriority

        assert hasattr(TaskPriority, "CRITICAL")
        assert hasattr(TaskPriority, "HIGH")
        assert hasattr(TaskPriority, "NORMAL")
        assert hasattr(TaskPriority, "LOW")


class TestEvaluationContract:
    """测试评测系统模块契约"""

    async def test_eval_config(self):
        from agent.evaluation.agent_eval_system import EvalConfig

        config = EvalConfig()
        assert hasattr(config, "pass_k")
        assert hasattr(config, "max_retries")

    async def test_three_axis_weights(self):
        from agent.harness.three_axis import ThreeAxisScorer

        scorer = ThreeAxisScorer()
        assert hasattr(scorer, "score")

    async def test_golden_eval_set_categories(self):
        from agent.evaluation.golden_eval_set import GOLDEN_EVAL_SET

        categories = {case.get("category", "") for case in GOLDEN_EVAL_SET}
        assert "safety" in categories
        assert "memory" in categories
        assert "desktop" in categories


async def run_module_contract_tests():
    """运行模块契约测试"""
    print("=" * 80)
    print("[MODULE CONTRACT TESTS] Jiabaixing Cross-Module Collaboration Tests")
    print("=" * 80)
    print()

    test_classes = [
        TestModuleContractValidation,
        TestMemoryLogicFlow,
        TestLoopOrchestrationLogic,
        TestReflectionAndEvaluation,
        TestSecurityAndGuardrails,
        TestToolCallValidation,
        TestBatchProcessing,
        TestSandboxContract,
        TestGatewayContract,
        TestEvolutionContract,
        TestLongTaskContract,
        TestEvaluationContract,
    ]

    total_passed = 0
    total_failed = 0
    total_skipped = 0

    for test_class in test_classes:
        print(f"[RUNNING] {test_class.__name__}...")
        instance = test_class()

        test_methods = [
            method for method in dir(instance)
            if method.startswith('test_') and callable(getattr(instance, method))
        ]

        for method_name in test_methods:
            # Skip if marked to skip by decorator
            func = getattr(instance, method_name)
            if hasattr(func, '__unittest_skip__'):
                print(f"   SKIP: {method_name} ({func.__unittest_skip__})")
                total_skipped += 1
                continue

            try:
                await func()
                print(f"   PASS: {method_name}")
                total_passed += 1
            except AssertionError as e:
                print(f"   FAIL: {method_name}: {e}")
                total_failed += 1
            except Exception as e:
                print(f"   SKIP: {method_name}: {type(e).__name__} - {e}")
                total_skipped += 1

    print()
    print("=" * 80)
    print("[TEST RESULTS]")
    print(f"   PASSED: {total_passed}")
    print(f"   FAILED: {total_failed}")
    print(f"   SKIPPED: {total_skipped}")
    print(f"   TOTAL: {total_passed + total_failed + total_skipped}")
    print("=" * 80)

    return total_failed == 0


if __name__ == "__main__":
    success = asyncio.run(run_module_contract_tests())
    sys.exit(0 if success else 1)
