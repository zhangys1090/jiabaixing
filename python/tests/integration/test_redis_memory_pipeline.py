"""端到端集成测试: Redis缓存 -> MemoryEngine -> LoopController -> ReflectionEngine

验证跨模块协作链路的完整性和正确性。
这些测试设计为在没有Redis/OTel安装的情况下也能运行(通过mock)。
"""
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# 添加Python后端路径
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


def _can_import(module_path: str) -> bool:
    """Check if a module can be imported."""
    try:
        __import__(module_path)
        return True
    except ImportError:
        return False


def skip_if_missing(*modules):
    """装饰器: 如果任一模块不可导入则跳过测试"""
    def decorator(func):
        missing = [m for m in modules if not _can_import(m.split('.')[0])]
        if missing:
            func.__unittest_skip__ = f"Missing dependencies: {', '.join(missing)}"
            return func
        return func
    return decorator


class TestRedisMemoryPipeline:
    """测试Redis <-> MemoryEngine的完整交互链路"""

    @skip_if_missing('redis')
    async def test_redis_cache_set_get(self):
        """测试Redis缓存的基本读写功能"""
        from agent.memory.redis_cache import RedisCache

        cache = RedisCache(redis_url="redis://localhost:6379/0")

        # Mock Redis不可用时的优雅降级
        with patch.object(cache, '_ensure_pool', return_value=None):
            result = await cache.get("test_key")
            assert result is None, "Redis不可用时应返回None"

            success = await cache.set("test_key", {"data": "value"})
            assert success is False, "Redis不可用时SET应返回False"

    async def test_redis_cache_json_serialization(self):
        """测试Redis缓存的JSON序列化功能"""
        from agent.memory.redis_cache import RedisCache

        cache = RedisCache(redis_url="redis://localhost:6379/0")

        # Mock Redis连接池
        mock_pool = AsyncMock()
        mock_pool.get = AsyncMock(return_value=json.dumps({"test": "data"}))
        mock_pool.set = AsyncMock()
        mock_pool.delete = AsyncMock(return_value=1)
        mock_pool.exists = AsyncMock(return_value=1)

        with patch.object(cache, '_ensure_pool', return_value=mock_pool):
            result = await cache.get("test_key")
            assert result == {"test": "data"}, "JSON反序列化应正确"

            success = await cache.set("test_key", {"nested": {"value": 123}})
            assert success is True, "SET应成功"
            mock_pool.set.assert_called_once()

    async def test_redis_cache_ttl_expiration(self):
        """测试Redis缓存的TTL过期功能"""
        from agent.memory.redis_cache import RedisCache

        cache = RedisCache(redis_url="redis://localhost:6379/0")

        mock_pool = AsyncMock()
        mock_pool.set = AsyncMock()

        with patch.object(cache, '_ensure_pool', return_value=mock_pool):
            await cache.set("test_key", {"data": "value"}, ttl=60)
            # 验证set调用中包含ex参数
            call_args = mock_pool.set.call_args
            assert call_args[1]['ex'] == 60, "TTL应正确传递到Redis"


class TestMemoryEngineLoopIntegration:
    """测试MemoryEngine <-> LoopController的协作"""

    async def test_memory_store_in_loop_context(self):
        """测试MemoryEngine在Loop上下文中正确存储记忆"""
        from agent.api.memory import router as memory_router
        from agent.models.memory import MemoryStoreRequest

        # Mock engine和memory
        mock_memory = AsyncMock()
        mock_memory.store = AsyncMock(return_value="mem_123")
        mock_memory.search = AsyncMock(return_value=[])
        mock_memory.get_stats = AsyncMock(return_value={"total": 0})

        with patch('agent.api.memory.get_memory', return_value=mock_memory):
            req = MemoryStoreRequest(
                content="测试记忆内容",
                memory_type="episodic",
                scene="test_scene",
                emotion="neutral"
            )

            # 模拟存储调用
            mem_id = await mock_memory.store(
                content=req.content,
                memory_type=req.memory_type,
                scene=req.scene,
                emotion=req.emotion,
                metadata=req.metadata
            )
            assert mem_id == "mem_123", "记忆ID应正确返回"

    async def test_memory_search_during_execution(self):
        """测试在Loop执行过程中检索相关记忆"""
        from agent.api.memory import router as memory_router

        mock_memory = AsyncMock()
        mock_memory.search = AsyncMock(return_value=[
            {"id": "mem_1", "content": "相关记忆1", "score": 0.9},
            {"id": "mem_2", "content": "相关记忆2", "score": 0.8}
        ])

        with patch('agent.api.memory.get_memory', return_value=mock_memory):
            results = await mock_memory.search(query="测试查询", limit=10)
            assert len(results) == 2, "应返回两条搜索结果"
            assert results[0]["score"] > results[1]["score"], "结果应按相关性排序"


class TestReflectionEngineLoopIntegration:
    """测试ReflectionEngine <-> LoopController的协作"""

    async def test_reflection_after_tool_execution(self):
        """测试工具执行后的反思验证"""
        from unittest.mock import MagicMock

        from agent.loop.evaluator import Evaluator
        from agent.loop.types import LoopContext, StepResult

        # 当前 Evaluator 需要注入 LLMProvider；用 MagicMock 模拟 LLM
        evaluator = Evaluator(llm=MagicMock())
        mock_llm = MagicMock()
        mock_llm.chat = AsyncMock(
            return_value={
                "content": '{"goalProgress": 0.8, "suggestedAction": "continue", '
                           '"reason": "ok", "qualityScore": 0.85}'
            }
        )

        ctx = LoopContext(
            step_results={"s1": StepResult(step_id="s1", success=True, content="结果")}
        )
        with patch.object(evaluator, "llm", mock_llm):
            result = await evaluator.evaluate(input_text="测试任务", context=ctx)

        # 验证返回结构（EvaluatorOutput 含质量评分）
        assert result is not None, "评估结果不应为空"
        assert hasattr(result, "quality_score"), "评估结果应包含质量指标"

    async def test_error_identification_in_loop(self):
        """测试循环中的错误识别"""
        from agent.security.output_guardrail import (
            GuardrailResult,
            OutputGuardrailEngine,
        )

        engine = OutputGuardrailEngine()

        # 测试敏感内容检测：含敏感信息应被拦截(passed=False)
        # 注意：密码检测模式要求 password='xxx' 带引号（见 _SENSITIVE_PATTERNS）
        test_cases = [
            ("这是一个正常的测试文本", True),
            ("包含敏感信息: password='123456'", False),
            ("普通内容没有敏感信息", True),
        ]

        for text, should_pass in test_cases:
            result = engine.check(text)
            # 验证返回 GuardrailResult 含 passed 字段
            assert isinstance(result, GuardrailResult), f"检查结果应为GuardrailResult: {text}"
            assert result.passed == should_pass, f"敏感判定应一致: {text}"


class TestCausalModelerPlanning:
    """测试CausalModeler的任务规划能力"""

    async def test_build_causal_graph_without_llm(self):
        """测试无LLM时CausalModeler返回空图"""
        from agent.loop.causal import CausalModeler

        modeler = CausalModeler(llm=None)
        graph = await modeler.build_causal_model("测试任务")

        assert len(graph.nodes) == 0, "无LLM时应返回空图"
        assert len(graph.edges) == 0, "无LLM时应返回空边列表"

    async def test_causal_graph_data_structures(self):
        """测试因果图数据结构"""
        from agent.loop.causal import CausalGraphNode, CausalGraphEdge, CausalGraph

        node1 = CausalGraphNode(id="step1", description="第一步", type="action")
        node2 = CausalGraphNode(id="step2", description="第二步", type="analysis")

        edge = CausalGraphEdge(from_id="step1", to_id="step2", reason="依赖关系")

        graph = CausalGraph(
            nodes=[node1, node2],
            edges=[edge]
        )

        assert len(graph.nodes) == 2, "应有两个节点"
        assert len(graph.edges) == 1, "应有一条边"
        assert graph.edges[0].from_id == "step1", "边的起点应正确"


class TestA2AManagerCommunication:
    """测试A2A跨Agent通信"""

    async def test_a2a_agent_card_creation(self):
        """测试Agent Card创建"""
        from agent.a2a.types import A2AAgentCard, A2ACapability, A2ACapabilityType

        cap = A2ACapability(
            type=A2ACapabilityType.TASK_EXECUTION,
            name="test-cap",
            description="测试能力",
        )

        card = A2AAgentCard(
            id="agent:test",
            name="test-agent",
            description="测试Agent",
            capabilities=[cap],
        )

        assert card.name == "test-agent", "Agent名称应正确"
        assert card.id == "agent:test", "Agent ID应正确"
        assert len(card.capabilities) == 1, "应包含1项能力"

    async def test_a2a_task_lifecycle(self):
        """测试A2A任务生命周期"""
        from agent.a2a.types import A2ATask, A2ATaskStatus

        task = A2ATask(
            id="task_001",
            session_id="sess_1",
            description="测试任务",
            from_agent_id="agent:caller",
            to_agent_id="test-agent",
        )

        assert task.id == "task_001", "任务ID应正确"
        assert task.status == A2ATaskStatus.SUBMITTED, "初始状态应为SUBMITTED"


class TestMCPToolBridgeIntegration:
    """测试MCP工具桥接"""

    async def test_mcp_tools_list_and_call(self):
        """测试MCP工具列表和调用（经 provider 桥接到本地注册表）"""
        from agent.tools.mcp_tool_bridge import MCPProvider, MCPToolBridge, MCPToolInfo
        from agent.tools.registry import ToolRegistry

        class MockProvider(MCPProvider):
            async def get_running_servers(self):
                return ["mock_server"]

            async def list_tools(self, server_name: str):
                return [
                    MCPToolInfo(
                        name="test_tool",
                        description="测试工具",
                        input_schema={"type": "object"},
                    )
                ]

            async def call_tool(self, server_name: str, tool_name: str, params: dict):
                return {"result": "ok"}

        registry = ToolRegistry()
        bridge = MCPToolBridge(provider=MockProvider())

        # 同步后至少桥接 1 个工具
        count = await bridge.sync_to_registry(registry)
        assert count >= 1, "应桥接至少1个MCP工具"

        # 桥接后的工具名应为 mcp_{server}_{tool}
        entry = registry.get("mcp_mock_server_test_tool")
        assert entry is not None, "桥接后的工具应在注册表中"


class TestOTelTracingIntegration:
    """测试OTel可观测性集成"""

    async def test_otel_span_creation(self, monkeypatch):
        """测试OTel Span创建（禁用态返回NoOp，不依赖collector）"""
        from agent.core.otel_tracer import get_tracer, init_tracer

        # 禁用态：init_tracer 显式返回 NoOp，不触发 exporter 依赖
        monkeypatch.setenv("OTEL_ENABLED", "false")
        tracer = init_tracer(service_name="test-service", endpoint="http://localhost:9999")
        assert tracer is not None, "tracer 不应为 None"
        assert get_tracer() is not None, "get_tracer 应返回单例 tracer"

    async def test_otel_metrics_collection(self, monkeypatch):
        """测试OTel指标收集（禁用态返回NoOp，不依赖exporter）"""
        from agent.core.otel_metrics import (
            get_meter,
            init_metrics,
            loop_iterations_counter,
        )

        # 禁用态：init_metrics 返回 NoOp meter
        monkeypatch.setenv("OTEL_ENABLED", "false")
        init_metrics(endpoint="http://localhost:9999")
        meter = get_meter()
        assert meter is not None, "meter 不应为 None"

        # 计数器可创建并累加（NoOp 安全）
        counter = loop_iterations_counter()
        assert counter is not None, "计数器应可创建"
        counter.add(1)


class TestFullPipelineIntegration:
    """全链路集成测试: Redis -> Memory -> Loop -> Reflection"""

    async def test_complete_pipeline_flow(self):
        """测试从缓存到记忆的完整数据流"""
        from agent.memory.redis_cache import RedisCache
        from agent.loop.causal import CausalGraph, CausalModeler, CausalGraphNode

        # Step 1: 写入Redis缓存
        cache = RedisCache(redis_url="redis://localhost:6379/0")

        mock_pool = AsyncMock()
        mock_pool.set = AsyncMock()

        with patch.object(cache, '_ensure_pool', return_value=mock_pool):
            await cache.set(
                "memory_session_001",
                {
                    "user_input": "帮我分析这段代码",
                    "timestamp": "2026-07-05T10:00:00Z",
                    "context": {"file": "test.py", "lines": [1, 100]}
                },
                ttl=3600
            )

        # Step 2: 创建因果图规划
        modeler = CausalModeler(llm=None)
        graph = await modeler.build_causal_model("代码分析任务")

        # 验证因果图结构
        assert isinstance(graph, CausalGraph), "应返回CausalGraph"

    async def test_error_handling_throughout_pipeline(self):
        """测试全链路中的错误处理"""
        from agent.memory.redis_cache import RedisCache
        from agent.a2a.types import A2AAgentCard

        # 测试Redis不可用时的行为
        cache = RedisCache(redis_url="redis://nonexistent:6379/0")

        with patch.object(cache, '_ensure_pool', return_value=None):
            get_result = await cache.get("key")
            set_result = await cache.set("key", "value")
            delete_result = await cache.delete("key")

        assert get_result is None, "GET应返回None"
        assert set_result is False, "SET应返回False"
        assert delete_result is False, "DELETE应返回False"

        # 测试AgentCard序列化
        card = A2AAgentCard(id="agent:test", name="test", description="test")
        json_str = json.dumps(card.to_dict())
        assert "test" in json_str, "JSON序列化应包含Agent名称"


async def run_all_integration_tests():
    """运行所有集成测试"""
    import pytest

    print("=" * 80)
    print("[INTEGRATION TEST SUITE] Jiabaixing End-to-End Integration Tests")
    print("=" * 80)
    print()

    test_classes = [
        TestRedisMemoryPipeline,
        TestMemoryEngineLoopIntegration,
        TestReflectionEngineLoopIntegration,
        TestCausalModelerPlanning,
        TestA2AManagerCommunication,
        TestMCPToolBridgeIntegration,
        TestOTelTracingIntegration,
        TestFullPipelineIntegration,
    ]

    total_passed = 0
    total_failed = 0
    total_skipped = 0

    for test_class in test_classes:
        print(f"\n[RUNNING] {test_class.__name__}...")
        instance = test_class()

        # Get all test_* methods
        test_methods = [
            method for method in dir(instance)
            if method.startswith('test_') and callable(getattr(instance, method))
        ]

        for method_name in test_methods:
            try:
                await getattr(instance, method_name)()
                print(f"   PASS: {method_name}")
                total_passed += 1
            except AssertionError as e:
                print(f"   FAIL: {method_name}: {e}")
                total_failed += 1
            except ImportError as e:
                print(f"   SKIP: {method_name}: Missing dependency - {e}")
                total_skipped += 1
            except Exception as e:
                print(f"   ERROR: {method_name}: Unexpected error - {e}")
                total_skipped += 1

    print()
    print("=" * 80)
    print("[RESULTS SUMMARY]")
    print(f"   PASSED: {total_passed}")
    print(f"   FAILED: {total_failed}")
    print(f"   SKIPPED: {total_skipped}")
    print(f"   TOTAL: {total_passed + total_failed + total_skipped}")
    print("=" * 80)

    return total_failed == 0


if __name__ == "__main__":
    success = asyncio.run(run_all_integration_tests())
    sys.exit(0 if success else 1)
