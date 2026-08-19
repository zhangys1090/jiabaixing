"""测试统一缓存层（P1.1 缓存系统统一）。"""

from __future__ import annotations

import pytest

from agent.cache import (
    CacheKeyBuilder,
    CacheManager,
    CacheStats,
    InMemoryBackend,
    TieredCache,
)
from agent.cache.compat import LRUCacheAdapter, LLMCacheAdapter, ToolResultCacheAdapter


class TestInMemoryBackend:
    """测试 InMemoryBackend。"""

    def test_basic_set_get(self):
        cache = InMemoryBackend(max_size=100)
        cache.set_sync("key1", "value1")
        assert cache.get_sync("key1") == "value1"

    def test_get_nonexistent(self):
        cache = InMemoryBackend()
        assert cache.get_sync("nonexistent") is None

    def test_delete(self):
        cache = InMemoryBackend()
        cache.set_sync("key1", "value1")
        assert cache.delete_sync("key1") is True
        assert cache.get_sync("key1") is None
        assert cache.delete_sync("key1") is False

    def test_clear(self):
        cache = InMemoryBackend()
        cache.set_sync("key1", "value1")
        cache.set_sync("key2", "value2")
        cache.clear_sync()
        assert cache.get_sync("key1") is None
        assert cache.get_sync("key2") is None

    def test_stats(self):
        cache = InMemoryBackend()
        cache.set_sync("key1", "value1")
        cache.get_sync("key1")
        cache.get_sync("nonexistent")

        stats = cache.stats_sync()
        assert isinstance(stats, CacheStats)
        assert stats.hits == 1
        assert stats.misses == 1
        assert stats.size == 1
        assert stats.hit_rate == 0.5

    def test_lru_eviction(self):
        cache = InMemoryBackend(max_size=3)
        cache.set_sync("key1", "v1")
        cache.set_sync("key2", "v2")
        cache.set_sync("key3", "v3")
        cache.set_sync("key4", "v4")

        assert cache.get_sync("key1") is None
        assert cache.get_sync("key2") == "v2"
        assert cache.get_sync("key3") == "v3"
        assert cache.get_sync("key4") == "v4"

        stats = cache.stats_sync()
        assert stats.evictions == 1

    def test_lru_access_order(self):
        cache = InMemoryBackend(max_size=3)
        cache.set_sync("key1", "v1")
        cache.set_sync("key2", "v2")
        cache.set_sync("key3", "v3")

        cache.get_sync("key1")

        cache.set_sync("key4", "v4")

        assert cache.get_sync("key2") is None
        assert cache.get_sync("key1") == "v1"
        assert cache.get_sync("key3") == "v3"
        assert cache.get_sync("key4") == "v4"

    def test_delete_by_prefix(self):
        cache = InMemoryBackend()
        cache.set_sync("llm:key1", "v1")
        cache.set_sync("llm:key2", "v2")
        cache.set_sync("tool:key1", "v3")

        deleted = cache.delete_by_prefix_sync("llm:")
        assert deleted == 2
        assert cache.get_sync("llm:key1") is None
        assert cache.get_sync("llm:key2") is None
        assert cache.get_sync("tool:key1") == "v3"

    def test_exists(self):
        cache = InMemoryBackend()
        cache.set_sync("key1", "v1")
        assert cache.exists_sync("key1") is True
        assert cache.exists_sync("nonexistent") is False

    def test_overwrite(self):
        cache = InMemoryBackend()
        cache.set_sync("key1", "v1")
        cache.set_sync("key1", "v2")
        assert cache.get_sync("key1") == "v2"
        assert cache.size == 1

    def test_zero_max_size(self):
        cache = InMemoryBackend(max_size=0)
        assert cache.max_size == 1000

    def test_hit_count_tracking(self):
        cache = InMemoryBackend()
        cache.set_sync("key1", "v1")
        cache.get_sync("key1")
        cache.get_sync("key1")
        cache.get_sync("key1")

        stats = cache.stats_sync()
        assert stats.hits == 3


class TestTieredCache:
    """测试 TieredCache。"""

    def test_l1_only(self):
        cache = TieredCache(l1_max_size=100, l1_ttl=0)
        cache.set_sync("key1", "value1")
        assert cache.get_sync("key1") == "value1"

    def test_l1_l2_write_through(self):
        l1 = InMemoryBackend(max_size=100)
        l2 = InMemoryBackend(max_size=200)
        cache = TieredCache(l1=l1, l2=l2, write_through=True)

        cache.set_sync("key1", "value1")

        assert l1.get_sync("key1") == "value1"
        assert l2.get_sync("key1") == "value1"

    def test_l1_l2_read_fallback(self):
        l1 = InMemoryBackend(max_size=100)
        l2 = InMemoryBackend(max_size=200)
        cache = TieredCache(l1=l1, l2=l2, write_through=True)

        l2.set_sync("key1", "value1")

        assert l1.get_sync("key1") is None
        assert cache.get_sync("key1") == "value1"
        assert l1.get_sync("key1") == "value1"

    def test_delete_from_both(self):
        l1 = InMemoryBackend(max_size=100)
        l2 = InMemoryBackend(max_size=200)
        cache = TieredCache(l1=l1, l2=l2, write_through=True)

        cache.set_sync("key1", "value1")
        cache.delete_sync("key1")

        assert l1.get_sync("key1") is None
        assert l2.get_sync("key1") is None

    def test_clear(self):
        l1 = InMemoryBackend(max_size=100)
        l2 = InMemoryBackend(max_size=200)
        cache = TieredCache(l1=l1, l2=l2, write_through=True)

        cache.set_sync("key1", "v1")
        cache.set_sync("key2", "v2")
        cache.clear_sync()

        assert cache.get_sync("key1") is None
        assert cache.get_sync("key2") is None


class TestCacheKeyBuilder:
    """测试 CacheKeyBuilder。"""

    def test_from_string(self):
        builder = CacheKeyBuilder(namespace="llm")
        key = builder.from_string("completion", "hello world")
        assert key.startswith("llm:completion:")
        assert len(key) > len("llm:completion:")

    def test_from_string_deterministic(self):
        builder = CacheKeyBuilder()
        key1 = builder.from_string("completion", "hello")
        key2 = builder.from_string("completion", "hello")
        assert key1 == key2

    def test_from_dict(self):
        builder = CacheKeyBuilder(namespace="tools")
        key = builder.from_dict("tool_a", {"param1": "a", "param2": "b"})
        assert key.startswith("tools:tool_a:")

    def test_from_dict_order_independent(self):
        builder = CacheKeyBuilder()
        key1 = builder.from_dict("cat", {"a": 1, "b": 2})
        key2 = builder.from_dict("cat", {"b": 2, "a": 1})
        assert key1 == key2

    def test_from_args(self):
        builder = CacheKeyBuilder(namespace="test")
        key = builder.from_args("func", "arg1", "arg2", kw1="v1")
        assert key.startswith("test:func:")

    def test_namespaced(self):
        builder = CacheKeyBuilder(namespace="llm")
        key = builder.namespaced("responses", "abc123")
        assert key == "llm:responses:abc123"

    def test_prefix(self):
        builder = CacheKeyBuilder(namespace="llm")
        prefix = builder.prefix("completion")
        assert prefix == "llm:completion:"

    def test_prefix_empty_category(self):
        builder = CacheKeyBuilder(namespace="llm")
        prefix = builder.prefix("")
        assert prefix == "llm:"

    def test_prefix_no_namespace(self):
        builder = CacheKeyBuilder()
        prefix = builder.prefix("cat")
        assert prefix == "cat:"

    def test_parse(self):
        key = "llm:completion:abc123"
        parsed = CacheKeyBuilder.parse(key)
        assert parsed["namespace"] == "llm"
        assert parsed["category"] == "completion"
        assert parsed["suffix"] == "abc123"

    def test_parse_no_namespace(self):
        key = "completion:abc123"
        parsed = CacheKeyBuilder.parse(key)
        assert parsed["namespace"] == ""
        assert parsed["category"] == "completion"
        assert parsed["suffix"] == "abc123"


class TestCacheManager:
    """测试 CacheManager。"""

    def test_namespace_creation(self):
        manager = CacheManager()
        ns = manager.namespace("llm", max_size=100)
        assert ns is not None

    def test_namespace_reuse(self):
        manager = CacheManager()
        ns1 = manager.namespace("llm")
        ns2 = manager.namespace("llm")
        assert ns1 is not ns2

    def test_namespace_isolation(self):
        manager = CacheManager()
        ns1 = manager.namespace("llm", max_size=100)
        ns2 = manager.namespace("tools", max_size=100)

        ns1.set_sync("key1", "v1")
        ns2.set_sync("key1", "v2")

        assert ns1.get_sync("key1") == "v1"
        assert ns2.get_sync("key1") == "v2"

    def test_register_custom_backend(self):
        manager = CacheManager()
        backend = InMemoryBackend(max_size=50)
        ns = manager.register("custom", backend)
        ns.set_sync("key1", "v1")
        assert ns.get_sync("key1") == "v1"

    def test_get_existing(self):
        manager = CacheManager()
        manager.namespace("llm")
        ns = manager.get("llm")
        assert ns is not None

    def test_get_nonexistent(self):
        manager = CacheManager()
        ns = manager.get("nonexistent")
        assert ns is None

    def test_get_or_default(self):
        manager = CacheManager()
        ns = manager.get_or_default("nonexistent")
        assert ns is not None

    def test_get_all_stats(self):
        manager = CacheManager()
        manager.namespace("llm")
        manager.namespace("tools")

        stats = manager.get_all_stats_sync()
        assert "llm" in stats
        assert "tools" in stats

    def test_health(self):
        manager = CacheManager()
        ns = manager.namespace("llm")
        ns.set_sync("key1", "v1")
        ns.get_sync("key1")
        ns.get_sync("nonexistent")

        health = manager.get_health()
        assert health.total_namespaces == 1
        assert health.total_hits == 1
        assert health.total_misses == 1
        assert health.overall_hit_rate == 0.5

    def test_health_all_misses(self):
        manager = CacheManager()
        ns = manager.namespace("llm")
        for i in range(5):
            ns.get_sync(f"nonexistent_{i}")

        health = manager.get_health()
        assert health.healthy is False

    def test_remove_namespace(self):
        manager = CacheManager()
        manager.namespace("llm")
        assert manager.remove("llm") is True
        assert manager.get("llm") is None

    def test_remove_nonexistent(self):
        manager = CacheManager()
        assert manager.remove("nonexistent") is False

    def test_clear_all(self):
        manager = CacheManager()
        ns1 = manager.namespace("llm")
        ns2 = manager.namespace("tools")

        ns1.set_sync("key1", "v1")
        ns2.set_sync("key1", "v1")

        count = manager.clear_all_sync()
        assert count == 2
        assert ns1.get_sync("key1") is None
        assert ns2.get_sync("key1") is None

    def test_namespaces_property(self):
        manager = CacheManager()
        manager.namespace("llm")
        manager.namespace("tools")
        manager.namespace("context")

        names = manager.namespaces
        assert "llm" in names
        assert "tools" in names
        assert "context" in names
        assert len(names) == 3


class TestCompatAdapters:
    """测试向后兼容适配器。"""

    def test_lru_cache_adapter(self):
        from agent.context.cache import LRUCache

        legacy = LRUCache(max_size=100, ttl=300)
        adapter = LRUCacheAdapter(legacy)

        adapter.set_sync("key1", "value1")
        assert adapter.get_sync("key1") == "value1"

        stats = adapter.stats_sync()
        assert stats.size == 1

    def test_lru_cache_adapter_delete(self):
        from agent.context.cache import LRUCache

        legacy = LRUCache(max_size=100)
        adapter = LRUCacheAdapter(legacy)

        adapter.set_sync("key1", "value1")
        assert adapter.delete_sync("key1") is True
        assert adapter.get_sync("key1") is None

    def test_llm_cache_adapter(self):
        from agent.llm.cache import LLMCache

        legacy = LLMCache()
        adapter = LLMCacheAdapter(legacy)

        adapter.set_sync("key1", "value1")
        assert adapter.get_sync("key1") == "value1"

    def test_tool_result_cache_adapter(self):
        from agent.tools.tool_result_cache import ToolResultCache
        from agent.tools.tool_result import ToolResult

        legacy = ToolResultCache(max_entries=100, default_ttl=300)
        adapter = ToolResultCacheAdapter(legacy)

        result = ToolResult(success=True, output="test output")
        adapter.set_sync("search:abc123", result)

        cached = adapter.get_sync("search:abc123")
        assert cached is not None
        assert cached.success is True
        assert cached.output == "test output"


class TestAsyncInterface:
    """测试异步接口。"""

    @pytest.mark.asyncio
    async def test_async_set_get(self):
        cache = InMemoryBackend()
        await cache.set("key1", "value1")
        assert await cache.get("key1") == "value1"

    @pytest.mark.asyncio
    async def test_async_delete(self):
        cache = InMemoryBackend()
        await cache.set("key1", "value1")
        assert await cache.delete("key1") is True
        assert await cache.get("key1") is None

    @pytest.mark.asyncio
    async def test_async_clear(self):
        cache = InMemoryBackend()
        await cache.set("key1", "v1")
        await cache.set("key2", "v2")
        await cache.clear()
        stats = await cache.stats()
        assert stats.size == 0

    @pytest.mark.asyncio
    async def test_async_stats(self):
        cache = InMemoryBackend()
        await cache.set("key1", "v1")
        await cache.get("key1")
        await cache.get("nonexistent")

        stats = await cache.stats()
        assert stats.hits == 1
        assert stats.misses == 1

    @pytest.mark.asyncio
    async def test_async_delete_by_prefix(self):
        cache = InMemoryBackend()
        await cache.set("llm:key1", "v1")
        await cache.set("llm:key2", "v2")
        await cache.set("tool:key1", "v3")

        deleted = await cache.delete_by_prefix("llm:")
        assert deleted == 2

    @pytest.mark.asyncio
    async def test_async_exists(self):
        cache = InMemoryBackend()
        await cache.set("key1", "v1")
        assert await cache.exists("key1") is True
        assert await cache.exists("nonexistent") is False
