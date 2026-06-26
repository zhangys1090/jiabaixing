from __future__ import annotations

import time

import pytest

from agent.context.base import (
    ComponentRegistry,
    ContextComponent,
    DependencyResolver,
)
from agent.context.cache import ContextCache, LRUCache, generate_cache_key
from agent.context.models import (
    BuildContext,
    BuildStatus,
    BuildStatistics,
    CacheMetrics,
    CacheStrategy,
    ComponentDependency,
    ComponentMetrics,
    ComponentPriority,
    ComponentResult,
    ComponentStatus,
    ContextBuildRequest,
    ContextBuildResult,
    ErrorInfo,
)
from agent.context.unified_orchestrator import UnifiedContextOrchestrator
from agent.context.adapters import (
    ContextAssemblerComponent,
    FileContextComponent,
    MemoryRetrievalComponent,
    PersonaComponent,
    SystemPromptComponent,
    TokenBudgetComponent,
)


# ============================================================================
# 测试辅助函数
# ============================================================================


class MockComponent(ContextComponent):
    """测试用的Mock组件"""

    def __init__(
        self,
        name: str,
        priority: int = 100,
        dependencies: list[ComponentDependency] | None = None,
        should_fail: bool = False,
        output: dict | None = None,
    ) -> None:
        super().__init__()
        self._name = name
        self._priority = priority
        self._dependencies = dependencies or []
        self._should_fail = should_fail
        self._output = output or {"value": name}
        self.execute_count = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def priority(self) -> int:
        return self._priority

    @property
    def dependencies(self) -> list[ComponentDependency]:
        return self._dependencies

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        self.execute_count += 1
        if self._should_fail:
            raise RuntimeError(f"Component {self._name} failed")
        return self._output


def _make_request(user_input: str = "test", **kwargs) -> ContextBuildRequest:
    """创建测试用的构建请求"""
    return ContextBuildRequest(user_input=user_input, **kwargs)


# ============================================================================
# 数据结构测试
# ============================================================================


class TestDataStructures:
    """数据结构测试"""

    def test_context_build_request_creation(self):
        """测试构建请求创建"""
        request = ContextBuildRequest(user_input="hello")
        assert request.user_input == "hello"
        assert request.session_id == "default"
        assert request.scene == "daily"
        assert request.use_memory is True
        assert request.max_tokens == 8000

    def test_context_build_request_cache_key(self):
        """测试缓存键生成"""
        request1 = ContextBuildRequest(user_input="hello")
        request2 = ContextBuildRequest(user_input="hello")
        request3 = ContextBuildRequest(user_input="world")

        # 相同输入应该有相同的缓存键
        assert request1.get_cache_key() == request2.get_cache_key()
        # 不同输入应该有不同的缓存键
        assert request1.get_cache_key() != request3.get_cache_key()

    def test_context_build_result_creation(self):
        """测试构建结果创建"""
        result = ContextBuildResult(
            messages=[{"role": "user", "content": "test"}],
            status=BuildStatus.SUCCESS,
        )
        assert len(result.messages) == 1
        assert result.status == BuildStatus.SUCCESS
        assert result.is_success() is True

    def test_component_result_status(self):
        """测试组件结果状态"""
        result = ComponentResult(component_name="test")
        assert result.status == ComponentStatus.PENDING
        assert result.is_success() is False

        result.status = ComponentStatus.SUCCESS
        assert result.is_success() is True

        result.status = ComponentStatus.DEGRADED
        assert result.is_success() is True

    def test_error_info_creation(self):
        """测试错误信息创建"""
        error = ErrorInfo(error_type="TestError", message="test error")
        assert error.error_type == "TestError"
        assert error.message == "test error"
        assert error.recoverable is True

    def test_build_statistics(self):
        """测试构建统计"""
        stats = BuildStatistics()
        assert stats.total_builds == 0
        assert stats.success_rate == 0.0

        result = ContextBuildResult(status=BuildStatus.SUCCESS, build_time_ms=100.0)
        stats.record_build(result)

        assert stats.total_builds == 1
        assert stats.successful_builds == 1
        assert stats.success_rate == 1.0
        assert stats.avg_time_ms == 100.0

    def test_component_metrics(self):
        """测试组件指标"""
        metrics = ComponentMetrics(component_name="test")
        assert metrics.total_executions == 0

        result = ComponentResult(
            component_name="test",
            status=ComponentStatus.SUCCESS,
            execution_time_ms=50.0,
        )
        metrics.record_execution(result)

        assert metrics.total_executions == 1
        assert metrics.successful_executions == 1
        assert metrics.avg_time_ms == 50.0
        assert metrics.success_rate == 1.0

    def test_cache_metrics(self):
        """测试缓存指标"""
        metrics = CacheMetrics()
        assert metrics.hit_rate == 0.0

        metrics.record_hit()
        metrics.record_miss()
        metrics.record_miss()

        assert metrics.total_requests == 3
        assert metrics.cache_hits == 1
        assert metrics.cache_misses == 2
        assert metrics.hit_rate == pytest.approx(1 / 3)

    def test_build_context(self):
        """测试构建上下文"""
        request = _make_request()
        context = BuildContext(request=request)

        assert context.request is request
        assert context.messages == []
        assert context.tokens_used == 0

        context.add_message("system", "test")
        assert len(context.messages) == 1

        context.set_output("test_comp", {"key": "value"})
        assert context.get_output("test_comp") == {"key": "value"}
        assert context.has_component_output("test_comp") is True

    def test_component_priority_constants(self):
        """测试组件优先级常量"""
        assert ComponentPriority.SYSTEM_PROMPT < ComponentPriority.MEMORY_RETRIEVAL
        assert ComponentPriority.MEMORY_RETRIEVAL < ComponentPriority.TOKEN_BUDGET
        assert ComponentPriority.TOKEN_BUDGET < ComponentPriority.WINDOW_MANAGER


# ============================================================================
# 组件注册与发现测试
# ============================================================================


class TestComponentRegistry:
    """组件注册器测试"""

    def test_register_and_get(self):
        """测试注册和获取组件"""
        registry = ComponentRegistry()
        comp = MockComponent("test_comp", priority=100)

        registry.register(comp)
        assert registry.has("test_comp") is True
        assert registry.get("test_comp") is comp
        assert registry.count() == 1

    def test_register_duplicate(self):
        """测试重复注册"""
        registry = ComponentRegistry()
        comp = MockComponent("test_comp")

        registry.register(comp)
        with pytest.raises(ValueError, match="already registered"):
            registry.register(comp)

    def test_unregister(self):
        """测试注销组件"""
        registry = ComponentRegistry()
        comp = MockComponent("test_comp")

        registry.register(comp)
        assert registry.count() == 1

        result = registry.unregister("test_comp")
        assert result is True
        assert registry.count() == 0
        assert registry.has("test_comp") is False

    def test_unregister_nonexistent(self):
        """测试注销不存在的组件"""
        registry = ComponentRegistry()
        result = registry.unregister("nonexistent")
        assert result is False

    def test_list_components(self):
        """测试列出组件"""
        registry = ComponentRegistry()
        registry.register(MockComponent("comp1", priority=200))
        registry.register(MockComponent("comp2", priority=100))
        registry.register(MockComponent("comp3", priority=150))

        names = registry.list_names()
        assert len(names) == 3
        assert "comp1" in names
        assert "comp2" in names
        assert "comp3" in names

    def test_get_by_priority(self):
        """测试按优先级排序"""
        registry = ComponentRegistry()
        registry.register(MockComponent("comp_low", priority=200))
        registry.register(MockComponent("comp_high", priority=100))
        registry.register(MockComponent("comp_mid", priority=150))

        sorted_comps = registry.get_by_priority()
        assert len(sorted_comps) == 3
        assert sorted_comps[0].name == "comp_high"
        assert sorted_comps[1].name == "comp_mid"
        assert sorted_comps[2].name == "comp_low"

    def test_enable_disable(self):
        """测试启用/禁用组件"""
        registry = ComponentRegistry()
        comp = MockComponent("test_comp")
        registry.register(comp)

        assert comp.enabled is True
        assert len(registry.get_enabled()) == 1

        comp.enabled = False
        assert len(registry.get_enabled()) == 0

    def test_clear(self):
        """测试清空所有组件"""
        registry = ComponentRegistry()
        registry.register(MockComponent("comp1"))
        registry.register(MockComponent("comp2"))

        assert registry.count() == 2
        registry.clear()
        assert registry.count() == 0


# ============================================================================
# 依赖解析测试
# ============================================================================


class TestDependencyResolver:
    """依赖解析器测试"""

    def test_simple_dependency_order(self):
        """测试简单依赖排序"""
        resolver = DependencyResolver()

        comp_a = MockComponent("A", priority=100)
        comp_b = MockComponent(
            "B",
            priority=200,
            dependencies=[ComponentDependency(component_name="A", required=True)],
        )

        ordered = resolver.resolve_execution_order([comp_b, comp_a])
        assert ordered[0].name == "A"
        assert ordered[1].name == "B"

    def test_multiple_dependencies(self):
        """测试多依赖排序"""
        resolver = DependencyResolver()

        comp_a = MockComponent("A", priority=100)
        comp_b = MockComponent("B", priority=200)
        comp_c = MockComponent(
            "C",
            priority=300,
            dependencies=[
                ComponentDependency(component_name="A", required=True),
                ComponentDependency(component_name="B", required=True),
            ],
        )

        ordered = resolver.resolve_execution_order([comp_c, comp_a, comp_b])
        # A 和 B 应该在 C 之前
        c_index = next(i for i, c in enumerate(ordered) if c.name == "C")
        a_index = next(i for i, c in enumerate(ordered) if c.name == "A")
        b_index = next(i for i, c in enumerate(ordered) if c.name == "B")

        assert a_index < c_index
        assert b_index < c_index

    def test_circular_dependency(self):
        """测试循环依赖检测"""
        resolver = DependencyResolver()

        comp_a = MockComponent(
            "A",
            priority=100,
            dependencies=[ComponentDependency(component_name="B", required=True)],
        )
        comp_b = MockComponent(
            "B",
            priority=200,
            dependencies=[ComponentDependency(component_name="A", required=True)],
        )

        with pytest.raises(ValueError, match="Circular dependency"):
            resolver.resolve_execution_order([comp_a, comp_b])

    def test_check_dependencies(self):
        """测试依赖检查"""
        resolver = DependencyResolver()

        comp_a = MockComponent("A", priority=100)
        comp_b = MockComponent(
            "B",
            priority=200,
            dependencies=[ComponentDependency(component_name="C", required=True)],
        )

        missing = resolver.check_dependencies([comp_a, comp_b])
        assert "B" in missing
        assert "C" in missing["B"]

    def test_get_dependents(self):
        """测试获取依赖者"""
        resolver = DependencyResolver()

        comp_a = MockComponent("A", priority=100)
        comp_b = MockComponent(
            "B",
            priority=200,
            dependencies=[ComponentDependency(component_name="A", required=True)],
        )
        comp_c = MockComponent(
            "C",
            priority=300,
            dependencies=[ComponentDependency(component_name="A", required=True)],
        )

        dependents = resolver.get_dependents("A", [comp_a, comp_b, comp_c])
        assert "B" in dependents
        assert "C" in dependents
        assert len(dependents) == 2


# ============================================================================
# 缓存功能测试
# ============================================================================


class TestLRUCache:
    """LRU缓存测试"""

    def test_set_and_get(self):
        """测试设置和获取"""
        cache = LRUCache(max_size=10)
        cache.set("key1", "value1")

        value, hit = cache.get("key1")
        assert hit is True
        assert value == "value1"

    def test_get_miss(self):
        """测试缓存未命中"""
        cache = LRUCache(max_size=10)
        value, hit = cache.get("nonexistent")
        assert hit is False
        assert value is None

    def test_max_size_eviction(self):
        """测试容量限制和淘汰"""
        cache = LRUCache(max_size=3)

        cache.set("key1", "value1")
        cache.set("key2", "value2")
        cache.set("key3", "value3")
        assert cache.size() == 3

        # 访问 key1，使其成为最近使用
        cache.get("key1")

        # 添加新key，应该淘汰最久未使用的 key2
        cache.set("key4", "value4")
        assert cache.size() == 3

        _, hit = cache.get("key2")
        assert hit is False

        _, hit = cache.get("key1")
        assert hit is True

    def test_ttl_expiration(self):
        """测试TTL过期"""
        cache = LRUCache(max_size=10, ttl=0.1)  # 100ms TTL

        cache.set("key1", "value1")
        _, hit = cache.get("key1")
        assert hit is True

        time.sleep(0.15)  # 等待过期

        _, hit = cache.get("key1")
        assert hit is False

    def test_delete(self):
        """测试删除"""
        cache = LRUCache(max_size=10)
        cache.set("key1", "value1")

        result = cache.delete("key1")
        assert result is True
        assert cache.size() == 0

        result = cache.delete("key1")
        assert result is False

    def test_clear(self):
        """测试清空"""
        cache = LRUCache(max_size=10)
        cache.set("key1", "value1")
        cache.set("key2", "value2")

        cache.clear()
        assert cache.size() == 0
        assert cache.hits == 0
        assert cache.misses == 0

    def test_hit_rate(self):
        """测试命中率"""
        cache = LRUCache(max_size=10)

        cache.set("key1", "value1")
        cache.get("key1")  # hit
        cache.get("key1")  # hit
        cache.get("key2")  # miss

        assert cache.hits == 2
        assert cache.misses == 1
        assert cache.hit_rate == pytest.approx(2 / 3)


class TestContextCache:
    """上下文缓存测试"""

    def test_result_cache(self):
        """测试结果缓存"""
        cache = ContextCache(strategy=CacheStrategy.LRU, max_size=10)

        result = ContextBuildResult(messages=[{"role": "user", "content": "test"}])
        cache.set_result("key1", result)

        cached, hit = cache.get_result("key1")
        assert hit is True
        assert cached is result

    def test_result_cache_miss(self):
        """测试结果缓存未命中"""
        cache = ContextCache(strategy=CacheStrategy.LRU, max_size=10)

        _, hit = cache.get_result("nonexistent")
        assert hit is False

    def test_no_cache_strategy(self):
        """测试禁用缓存策略"""
        cache = ContextCache(strategy=CacheStrategy.NO_CACHE)

        cache.set_result("key1", "value1")
        _, hit = cache.get_result("key1")
        assert hit is False

    def test_component_cache(self):
        """测试组件级缓存"""
        cache = ContextCache(strategy=CacheStrategy.LRU, max_size=10)

        output = {"data": "test"}
        cache.set_component_output("comp1", "key1", output)

        cached, hit = cache.get_component_output("comp1", "key1")
        assert hit is True
        assert cached == output

    def test_invalidate_component(self):
        """测试使组件缓存失效"""
        cache = ContextCache(strategy=CacheStrategy.LRU, max_size=10)

        cache.set_component_output("comp1", "key1", {"data": "test"})
        cache.invalidate_component("comp1")

        _, hit = cache.get_component_output("comp1", "key1")
        assert hit is False

    def test_clear_all(self):
        """测试清空所有缓存"""
        cache = ContextCache(strategy=CacheStrategy.LRU, max_size=10)

        cache.set_result("key1", "value1")
        cache.set_component_output("comp1", "key1", {"data": "test"})

        cache.clear_all()

        _, hit = cache.get_result("key1")
        assert hit is False

    def test_cache_metrics(self):
        """测试缓存统计"""
        cache = ContextCache(strategy=CacheStrategy.LRU, max_size=10)

        cache.set_result("key1", "value1")
        cache.get_result("key1")  # hit
        cache.get_result("key2")  # miss

        metrics = cache.get_metrics()
        assert metrics.total_requests == 2
        assert metrics.cache_hits == 1
        assert metrics.cache_misses == 1
        assert metrics.hit_rate == pytest.approx(0.5)


class TestCacheKeyGeneration:
    """缓存键生成测试"""

    def test_generate_cache_key(self):
        """测试缓存键生成"""
        key1 = generate_cache_key("a", "b", "c")
        key2 = generate_cache_key("a", "b", "c")
        key3 = generate_cache_key("a", "b", "d")

        assert key1 == key2
        assert key1 != key3
        assert len(key1) == 32  # MD5 hash length


# ============================================================================
# 编排执行测试
# ============================================================================


class TestUnifiedContextOrchestrator:
    """统一上下文编排器测试"""

    def test_initialization(self):
        """测试初始化"""
        orchestrator = UnifiedContextOrchestrator(enabled=True)
        assert orchestrator.enabled is True
        assert orchestrator.component_count == 0

    def test_register_component(self):
        """测试注册组件"""
        orchestrator = UnifiedContextOrchestrator()
        comp = MockComponent("test_comp", priority=100)

        orchestrator.register_component(comp)
        assert orchestrator.component_count == 1
        assert orchestrator.get_component("test_comp") is comp

    def test_unregister_component(self):
        """测试注销组件"""
        orchestrator = UnifiedContextOrchestrator()
        comp = MockComponent("test_comp")

        orchestrator.register_component(comp)
        assert orchestrator.component_count == 1

        result = orchestrator.unregister_component("test_comp")
        assert result is True
        assert orchestrator.component_count == 0

    def test_list_components(self):
        """测试列出组件"""
        orchestrator = UnifiedContextOrchestrator()
        orchestrator.register_component(MockComponent("comp1"))
        orchestrator.register_component(MockComponent("comp2"))

        names = orchestrator.list_components()
        assert len(names) == 2
        assert "comp1" in names
        assert "comp2" in names

    def test_enable_disable_component(self):
        """测试启用/禁用组件"""
        orchestrator = UnifiedContextOrchestrator()
        comp = MockComponent("test_comp")
        orchestrator.register_component(comp)

        result = orchestrator.disable_component("test_comp")
        assert result is True
        assert comp.enabled is False

        result = orchestrator.enable_component("test_comp")
        assert result is True
        assert comp.enabled is True

    @pytest.mark.asyncio
    async def test_build_context_basic(self):
        """测试基本的上下文构建"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)
        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(PersonaComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        request = _make_request(user_input="hello")
        result = await orchestrator.build_context(request)

        assert isinstance(result, ContextBuildResult)
        assert result.is_success() is True
        assert len(result.messages) > 0
        assert result.status == BuildStatus.SUCCESS

    @pytest.mark.asyncio
    async def test_build_context_with_all_components(self):
        """测试使用所有组件构建上下文"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)

        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(PersonaComponent())
        orchestrator.register_component(MemoryRetrievalComponent())
        orchestrator.register_component(FileContextComponent())
        orchestrator.register_component(TokenBudgetComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        request = _make_request(user_input="test query")
        result = await orchestrator.build_context(request)

        assert result.is_success() is True
        assert len(result.component_results) == 6
        assert result.total_tokens > 0

    @pytest.mark.asyncio
    async def test_build_context_disabled(self):
        """测试编排器禁用时的构建"""
        orchestrator = UnifiedContextOrchestrator(enabled=False)
        request = _make_request(
            user_input="hello",
            system_prompt="You are helpful.",
        )
        result = await orchestrator.build_context(request)

        assert result.is_success() is True
        assert len(result.messages) >= 2  # system + user

    @pytest.mark.asyncio
    async def test_build_context_with_history(self):
        """测试带历史消息的构建"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)
        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        history = [
            {"role": "user", "content": "msg1"},
            {"role": "assistant", "content": "reply1"},
        ]
        request = _make_request(user_input="hello", history=history)
        result = await orchestrator.build_context(request)

        assert result.is_success() is True
        # system + 2 history + user
        assert len(result.messages) >= 3

    @pytest.mark.asyncio
    async def test_build_context_cache(self):
        """测试缓存功能"""
        orchestrator = UnifiedContextOrchestrator(use_cache=True)
        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        request = _make_request(user_input="hello")

        # 第一次构建（缓存未命中）
        result1 = await orchestrator.build_context(request)
        assert result1.from_cache is False

        # 第二次构建（缓存命中）
        result2 = await orchestrator.build_context(request)
        assert result2.from_cache is True

    def test_clear_cache(self):
        """测试清空缓存"""
        orchestrator = UnifiedContextOrchestrator(use_cache=True)
        orchestrator.clear_cache()

        stats = orchestrator.get_cache_stats()
        assert stats["cache_size"] == 0

    def test_get_statistics(self):
        """测试获取统计信息"""
        orchestrator = UnifiedContextOrchestrator()
        stats = orchestrator.get_statistics()

        assert isinstance(stats, BuildStatistics)
        assert stats.total_builds == 0

    def test_reset_statistics(self):
        """测试重置统计"""
        orchestrator = UnifiedContextOrchestrator()
        orchestrator.reset_statistics()

        stats = orchestrator.get_statistics()
        assert stats.total_builds == 0


# ============================================================================
# 错误处理与降级测试
# ============================================================================


class TestErrorHandling:
    """错误处理测试"""

    @pytest.mark.asyncio
    async def test_single_component_failure(self):
        """测试单个组件失败"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)

        good_comp = MockComponent("good", priority=100)
        bad_comp = MockComponent("bad", priority=200, should_fail=True)

        orchestrator.register_component(good_comp)
        orchestrator.register_component(bad_comp)

        request = _make_request()
        result = await orchestrator.build_context(request)

        # 应该是部分成功
        assert result.status == BuildStatus.PARTIAL
        assert len(result.errors) >= 1

        # 好的组件应该成功执行
        assert "good" in result.component_results
        assert result.component_results["good"].status == ComponentStatus.SUCCESS

        # 坏的组件应该失败
        assert "bad" in result.component_results
        assert result.component_results["bad"].status == ComponentStatus.FAILED

    @pytest.mark.asyncio
    async def test_component_dependency_failure(self):
        """测试依赖组件失败"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)

        base_comp = MockComponent("base", priority=100, should_fail=True)
        dependent_comp = MockComponent(
            "dependent",
            priority=200,
            dependencies=[ComponentDependency(component_name="base", required=True)],
        )

        orchestrator.register_component(base_comp)
        orchestrator.register_component(dependent_comp)

        request = _make_request()
        result = await orchestrator.build_context(request)

        # 依赖组件应该被跳过
        dep_result = result.component_results["dependent"]
        assert dep_result.status == ComponentStatus.SKIPPED

    @pytest.mark.asyncio
    async def test_all_components_fail(self):
        """测试所有组件失败"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)

        comp1 = MockComponent("comp1", priority=100, should_fail=True)
        comp2 = MockComponent("comp2", priority=200, should_fail=True)

        orchestrator.register_component(comp1)
        orchestrator.register_component(comp2)

        request = _make_request()
        result = await orchestrator.build_context(request)

        assert result.status == BuildStatus.FAILED

    def test_error_info_to_dict(self):
        """测试错误信息转字典"""
        error = ErrorInfo(
            error_type="TestError",
            message="test message",
            component="test_comp",
        )
        d = error.to_dict()

        assert d["error_type"] == "TestError"
        assert d["message"] == "test message"
        assert d["component"] == "test_comp"


# ============================================================================
# 适配器测试
# ============================================================================


class TestAdapters:
    """组件适配器测试"""

    @pytest.mark.asyncio
    async def test_system_prompt_component(self):
        """测试系统Prompt组件"""
        comp = SystemPromptComponent()
        request = _make_request()
        context = BuildContext(request=request)

        result = await comp.execute(request, context)

        assert result.status == ComponentStatus.SUCCESS
        assert "system_prompt" in result.output
        assert len(context.messages) == 1
        assert context.messages[0]["role"] == "system"

    @pytest.mark.asyncio
    async def test_persona_component(self):
        """测试人格组件"""
        comp = PersonaComponent()
        request = _make_request(scene="development")
        context = BuildContext(request=request)
        context.add_message("system", "base prompt")

        result = await comp.execute(request, context)

        assert result.status == ComponentStatus.SUCCESS
        assert "persona_summary" in result.output
        assert "tone_instruction" in result.output

    @pytest.mark.asyncio
    async def test_memory_retrieval_component(self):
        """测试记忆检索组件"""
        comp = MemoryRetrievalComponent()
        request = _make_request(use_memory=True)
        context = BuildContext(request=request)
        context.add_message("system", "base prompt")

        result = await comp.execute(request, context)

        assert result.status == ComponentStatus.SUCCESS
        assert "memories" in result.output
        assert "memory_count" in result.output

    @pytest.mark.asyncio
    async def test_memory_disabled(self):
        """测试记忆禁用"""
        comp = MemoryRetrievalComponent()
        request = _make_request(use_memory=False)
        context = BuildContext(request=request)

        result = await comp.execute(request, context)

        assert result.status == ComponentStatus.SKIPPED

    @pytest.mark.asyncio
    async def test_file_context_component(self):
        """测试文件上下文组件"""
        comp = FileContextComponent()
        request = _make_request(use_file_context=True)
        context = BuildContext(request=request)
        context.add_message("system", "base prompt")

        result = await comp.execute(request, context)

        assert result.status == ComponentStatus.SUCCESS
        assert "context_files" in result.output
        assert "file_count" in result.output

    @pytest.mark.asyncio
    async def test_token_budget_component(self):
        """测试Token预算组件"""
        comp = TokenBudgetComponent()
        request = _make_request(max_tokens=8000)
        context = BuildContext(request=request)
        context.add_message("system", "test")

        result = await comp.execute(request, context)

        assert result.status == ComponentStatus.SUCCESS
        assert "max_tokens" in result.output
        assert "allocation" in result.output
        assert result.output["max_tokens"] == 8000

    @pytest.mark.asyncio
    async def test_context_assembler_component(self):
        """测试上下文组装组件"""
        comp = ContextAssemblerComponent()
        request = _make_request(user_input="hello")
        context = BuildContext(request=request)
        context.add_message("system", "base prompt")

        result = await comp.execute(request, context)

        assert result.status == ComponentStatus.SUCCESS
        assert "total_messages" in result.output
        assert len(context.messages) >= 2  # system + user


# ============================================================================
# 性能测试
# ============================================================================


class TestPerformance:
    """性能测试"""

    @pytest.mark.asyncio
    async def test_build_context_speed(self):
        """测试构建速度"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)

        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(PersonaComponent())
        orchestrator.register_component(MemoryRetrievalComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        request = _make_request(user_input="test")

        start = time.time()
        result = await orchestrator.build_context(request)
        elapsed = (time.time() - start) * 1000

        assert result.is_success() is True
        # 应该在合理时间内完成
        assert elapsed < 1000  # 1秒以内

    @pytest.mark.asyncio
    async def test_cache_hit_speed(self):
        """测试缓存命中速度"""
        orchestrator = UnifiedContextOrchestrator(use_cache=True)

        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        request = _make_request(user_input="test")

        # 第一次构建
        await orchestrator.build_context(request)

        # 第二次构建（缓存命中）
        start = time.time()
        result = await orchestrator.build_context(request)
        elapsed = (time.time() - start) * 1000

        assert result.from_cache is True
        assert elapsed < 100  # 缓存命中应该很快

    def test_lru_cache_performance(self):
        """测试LRU缓存性能"""
        cache = LRUCache(max_size=1000)

        # 写入1000条
        start = time.time()
        for i in range(1000):
            cache.set(f"key_{i}", f"value_{i}")
        write_time = (time.time() - start) * 1000

        # 读取1000次
        start = time.time()
        for i in range(1000):
            cache.get(f"key_{i}")
        read_time = (time.time() - start) * 1000

        assert write_time < 1000  # 1秒以内写入
        assert read_time < 1000  # 1秒以内读取


# ============================================================================
# 集成测试
# ============================================================================


class TestIntegration:
    """集成测试"""

    @pytest.mark.asyncio
    async def test_full_pipeline(self):
        """测试完整的流水线"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)

        # 注册所有6个适配器
        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(PersonaComponent())
        orchestrator.register_component(MemoryRetrievalComponent())
        orchestrator.register_component(FileContextComponent())
        orchestrator.register_component(TokenBudgetComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        # 构建请求
        request = ContextBuildRequest(
            user_input="帮我写一个Python函数",
            session_id="test_session",
            scene="development",
            use_memory=True,
            use_file_context=True,
            use_compression=True,
            max_tokens=4000,
            history=[
                {"role": "user", "content": "你好"},
                {"role": "assistant", "content": "你好！有什么可以帮你的？"},
            ],
        )

        # 执行构建
        result = await orchestrator.build_context(request)

        # 验证结果
        assert result.is_success() is True
        assert len(result.messages) > 0
        assert result.system_prompt != ""
        assert len(result.history) >= 2
        assert result.total_tokens > 0
        assert len(result.component_results) == 6

        # 验证组件都执行了
        assert "system_prompt" in result.component_results
        assert "persona" in result.component_results
        assert "memory_retrieval" in result.component_results
        assert "file_context" in result.component_results
        assert "token_budget" in result.component_results
        assert "context_assembler" in result.component_results

        # 验证统计
        stats = orchestrator.get_statistics()
        assert stats.total_builds == 1
        assert stats.successful_builds == 1

    @pytest.mark.asyncio
    async def test_different_scenes(self):
        """测试不同场景"""
        orchestrator = UnifiedContextOrchestrator(use_cache=False)
        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(PersonaComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        scenes = ["daily", "development", "work", "comfort"]

        for scene in scenes:
            request = _make_request(user_input="test", scene=scene)
            result = await orchestrator.build_context(request)

            assert result.is_success() is True
            assert result.status == BuildStatus.SUCCESS

    @pytest.mark.asyncio
    async def test_cache_consistency(self):
        """测试缓存一致性"""
        orchestrator = UnifiedContextOrchestrator(use_cache=True)
        orchestrator.register_component(SystemPromptComponent())
        orchestrator.register_component(ContextAssemblerComponent())

        request1 = _make_request(user_input="test1")
        request2 = _make_request(user_input="test2")

        result1a = await orchestrator.build_context(request1)
        result1b = await orchestrator.build_context(request1)
        result2 = await orchestrator.build_context(request2)

        # 相同请求应该命中缓存
        assert result1b.from_cache is True

        # 不同请求不应该命中缓存
        assert result2.from_cache is False

        # 结果内容应该一致
        assert result1a.messages == result1b.messages
