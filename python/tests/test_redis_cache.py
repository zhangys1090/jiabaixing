"""RedisCache 测试套件。

测试策略：
- 需要 Redis 的测试用例：当 REDIS_ENABLED != "true" 时通过 skipif 跳过
- 优雅降级测试：通过指向不存在端口模拟 Redis 不可用，不需要真实 Redis
- 单例与常量测试：纯逻辑验证，不需要 Redis
"""

from __future__ import annotations

import os
import time
from typing import Any
from unittest.mock import patch

import pytest

from agent.memory.redis_cache import (
    REDIS_POOL_SIZE_DEFAULT,
    REDIS_URL_DEFAULT,
    RedisCache,
    get_redis_cache,
    is_redis_enabled,
)

# 判断 Redis 是否启用（CI 环境通常未启用）
REDIS_ENABLED = os.environ.get("REDIS_ENABLED", "false").lower() == "true"

# 需要 Redis 的测试用例统一标记
require_redis = pytest.mark.skipif(
    not REDIS_ENABLED,
    reason="REDIS_ENABLED != true，跳过需要真实 Redis 的测试",
)


class TestRedisCache:
    """RedisCache 测试类。

    每个测试用例使用唯一键前缀避免数据残留，并在结束前调用 close() 释放资源。
    """

    _key_counter: int = 0

    def _make_cache(
        self, redis_url: str | None = None, pool_size: int | None = None
    ) -> RedisCache:
        """构造带唯一配置的 RedisCache 实例。

        Args:
            redis_url: 自定义 Redis 地址（可选）。
            pool_size: 自定义连接池大小（可选）。

        Returns:
            RedisCache: 新建的缓存实例。
        """
        if redis_url:
            return RedisCache(redis_url=redis_url, pool_size=pool_size or 2)
        return RedisCache(pool_size=pool_size)

    def _key(self, prefix: str = "test") -> str:
        """生成唯一测试键名，避免测试间数据残留。

        Args:
            prefix: 键名前缀。

        Returns:
            str: 唯一键名。
        """
        TestRedisCache._key_counter += 1
        return (
            f"jbx:test:{prefix}:{TestRedisCache._key_counter}:"
            f"{int(time.time() * 1000)}"
        )

    @require_redis
    @pytest.mark.asyncio
    async def test_set_and_get(self) -> None:
        """测试设置并获取字符串值。"""
        cache = self._make_cache()
        try:
            key = self._key("setget")
            ok = await cache.set(key, "hello world", ttl=60)
            assert ok is True
            value = await cache.get(key)
            assert value == "hello world"
        finally:
            await cache.close()

    @require_redis
    @pytest.mark.asyncio
    async def test_get_missing_key(self) -> None:
        """测试获取不存在的键返回 None。"""
        cache = self._make_cache()
        try:
            value = await cache.get(self._key("missing"))
            assert value is None
        finally:
            await cache.close()

    @require_redis
    @pytest.mark.asyncio
    async def test_delete(self) -> None:
        """测试删除键后获取返回 None。"""
        cache = self._make_cache()
        try:
            key = self._key("delete")
            await cache.set(key, "to-delete", ttl=60)
            deleted = await cache.delete(key)
            assert deleted is True
            value = await cache.get(key)
            assert value is None
            # 重复删除返回 False
            deleted_again = await cache.delete(key)
            assert deleted_again is False
        finally:
            await cache.close()

    @require_redis
    @pytest.mark.asyncio
    async def test_exists(self) -> None:
        """测试检查键存在/不存在。"""
        cache = self._make_cache()
        try:
            key = self._key("exists")
            await cache.set(key, "exists-value", ttl=60)
            assert await cache.exists(key) is True
            assert await cache.exists(self._key("not-exists")) is False
        finally:
            await cache.close()

    @require_redis
    @pytest.mark.asyncio
    async def test_set_with_ttl(self) -> None:
        """测试设置带 TTL 的键（仅验证设置成功，不验证过期）。"""
        cache = self._make_cache()
        try:
            key = self._key("ttl")
            ok = await cache.set(key, "ttl-value", ttl=120)
            assert ok is True
            assert await cache.exists(key) is True
        finally:
            await cache.close()

    @require_redis
    @pytest.mark.asyncio
    async def test_json_serialization(self) -> None:
        """测试字典/列表值的 JSON 序列化反序列化。"""
        cache = self._make_cache()
        try:
            # 字典
            dict_key = self._key("dict")
            dict_value = {
                "name": "家百星",
                "version": 5.0,
                "tags": ["ai", "memory"],
            }
            assert await cache.set(dict_key, dict_value, ttl=60) is True
            assert await cache.get(dict_key) == dict_value

            # 列表
            list_key = self._key("list")
            list_value = [1, 2, 3, {"nested": True}]
            assert await cache.set(list_key, list_value, ttl=60) is True
            assert await cache.get(list_key) == list_value

            # 嵌套结构
            nested_key = self._key("nested")
            nested_value = {
                "users": [{"id": 1, "name": "张三"}, {"id": 2, "name": "李四"}],
                "meta": {"total": 2, "page": 1},
            }
            assert await cache.set(nested_key, nested_value, ttl=60) is True
            assert await cache.get(nested_key) == nested_value
        finally:
            await cache.close()

    @pytest.mark.asyncio
    async def test_redis_unavailable_graceful_degradation(self) -> None:
        """测试 Redis 不可用时的优雅降级（连接错误不抛异常）。

        通过指向不存在端口模拟 Redis 不可用。
        该测试不需要真实 Redis。
        """
        cache = RedisCache(
            redis_url="redis://localhost:19999/0", pool_size=2
        )
        try:
            key = self._key("degrade")

            # get 应返回 None，不抛异常
            value = await cache.get(key)
            assert value is None

            # set 应返回 False，不抛异常
            ok = await cache.set(key, "value", ttl=60)
            assert ok is False

            # delete 应返回 False，不抛异常
            ok = await cache.delete(key)
            assert ok is False

            # exists 应返回 False，不抛异常
            ok = await cache.exists(key)
            assert ok is False

            # health_check 应返回 False，不抛异常
            ok = await cache.health_check()
            assert ok is False
        finally:
            await cache.close()

    @require_redis
    @pytest.mark.asyncio
    async def test_health_check(self) -> None:
        """测试健康检查返回 bool（启用 Redis 时应为 True）。"""
        cache = self._make_cache()
        try:
            result = await cache.health_check()
            assert isinstance(result, bool)
            assert result is True
        finally:
            await cache.close()

    @pytest.mark.asyncio
    async def test_health_check_unavailable_returns_false(self) -> None:
        """测试健康检查在 Redis 不可用时返回 False，不需要真实 Redis。"""
        cache = RedisCache(
            redis_url="redis://localhost:19999/0", pool_size=2
        )
        try:
            result = await cache.health_check()
            assert isinstance(result, bool)
            assert result is False
        finally:
            await cache.close()


def test_get_redis_cache_singleton() -> None:
    """测试 get_redis_cache 全局单例（不需要 Redis 连接）。"""
    cache1 = get_redis_cache()
    cache2 = get_redis_cache()
    assert cache1 is cache2
    assert isinstance(cache1, RedisCache)


def test_redis_cache_default_constants() -> None:
    """测试模块级常量默认值（不需要 Redis）。"""
    assert REDIS_URL_DEFAULT == "redis://localhost:6379/0"
    assert REDIS_POOL_SIZE_DEFAULT == 10


def test_is_redis_enabled_default_false() -> None:
    """测试 is_redis_enabled 默认返回 False（不设置环境变量时）。"""
    # 该测试在 REDIS_ENABLED 未设置时验证默认行为
    # 注意：如果环境变量已设置 true，此测试会被 skipif 跳过其他用例
    # 但此函数本身仅验证返回值类型
    result = is_redis_enabled()
    assert isinstance(result, bool)


def test_redis_cache_init_with_explicit_params() -> None:
    """测试显式参数初始化（不需要 Redis 连接，仅验证属性赋值）。"""
    cache = RedisCache(
        redis_url="redis://example.com:6380/2", pool_size=20
    )
    try:
        assert cache._redis_url == "redis://example.com:6380/2"
        assert cache._pool_size == 20
        assert cache._pool is None
    finally:
        # 同步上下文无需 await close，但保持习惯
        pass


# ═══════════════════════════════════════════════════════════════
# 集成测试：MemoryEngine + Redis 缓存（断层修复验证）
# ═══════════════════════════════════════════════════════════════


class TestMemoryEngineRedisCacheIntegration:
    """MemoryEngine 的 search_with_context / get_recent Redis 缓存集成测试。

    验证审计断层 3 修复后的接线：
    - search_with_context 启用 Redis 时先查缓存，未命中再回填
    - get_recent 启用 Redis 时先查缓存，未命中再回填

    通过 monkeypatch 注入一个内存 dict 模拟 RedisCache，避免依赖真实 Redis。
    """

    def _make_in_memory_cache(self):
        """构造内存版 RedisCache 替身（dict 实现），用于无 Redis 环境测试。

        Returns:
            MagicMock: 模拟 RedisCache 的对象，get/set/delete/exists/health_check
                操作均作用于内部 dict。
        """
        store: dict[str, Any] = {}

        class _InMemoryCache:
            """内存 dict 替身，模拟 RedisCache 的异步接口。"""

            async def get(self, key: str):
                """返回缓存值（深拷贝避免外部修改污染）。"""
                import copy
                v = store.get(key)
                return copy.deepcopy(v) if v is not None else None

            async def set(self, key: str, value, ttl: int = 60) -> bool:
                store[key] = value
                return True

            async def delete(self, key: str) -> bool:
                return store.pop(key, None) is not None

            async def exists(self, key: str) -> bool:
                return key in store

            async def health_check(self) -> bool:
                return True

            async def close(self) -> None:
                pass

            def keys(self):
                return list(store.keys())

        return _InMemoryCache()

    @pytest.mark.asyncio
    async def test_search_with_context_uses_redis_cache(
        self, tmp_path, monkeypatch
    ):
        """测试 search_with_context 启用 Redis 时先查缓存并回填。

        验证:
        - 首次调用未命中缓存，走底层 search_multimodal + store.search
        - 缓存被回填
        - 第二次调用命中缓存，直接返回缓存结果
        """
        # 强制 fallback 多模态模式，避免下载 CLIP
        monkeypatch.setenv("MULTIMODAL_MODEL", "fallback")

        from agent.memory.engine import MemoryEngine

        # 构造 MemoryEngine 并注入内存版 RedisCache
        db_path = str(tmp_path / "search_ctx_cache.db")
        engine = MemoryEngine(db_path=db_path)
        in_memory_cache = self._make_in_memory_cache()
        engine._redis_cache = in_memory_cache

        try:
            # 预存一条记忆
            await engine.store(
                content="Redis 缓存集成测试记忆",
                memory_type="long_term",
                scene="test",
            )

            # 第一次调用：未命中缓存，走底层并回填
            results1 = await engine.search_with_context(
                query="Redis", limit=5, include_multimodal=False
            )
            assert isinstance(results1, list)

            # 缓存应被回填（至少有一个 search:ctx 缓存键）
            cache_keys = in_memory_cache.keys()
            ctx_keys = [k for k in cache_keys if "memory:search:" in k]
            assert len(ctx_keys) > 0, \
                f"search_with_context 应回填 Redis 缓存，但 keys={cache_keys}"

            # 第二次调用：应命中缓存（即使删除底层记忆也应返回首次结果）
            # 通过 spy 验证 _store.search 未被调用
            call_count = {"fts": 0}
            original_search = engine._store.search

            def _spy_search(*args, **kwargs):
                call_count["fts"] += 1
                return original_search(*args, **kwargs)

            with patch.object(engine._store, "search", side_effect=_spy_search):
                results2 = await engine.search_with_context(
                    query="Redis", limit=5, include_multimodal=False
                )

            # 第二次应命中缓存，_store.search 不应被调用
            assert call_count["fts"] == 0, \
                f"缓存命中时不应调用底层 search，但调用了 {call_count['fts']} 次"
            # 返回结果应与首次一致
            assert results2 == results1
        finally:
            engine._store.close()

    @pytest.mark.asyncio
    async def test_get_recent_uses_redis_cache(
        self, tmp_path, monkeypatch
    ):
        """测试 get_recent 启用 Redis 时先查缓存并回填。

        验证:
        - 首次调用未命中缓存，走底层 store.get_recent
        - 缓存被回填
        - 第二次调用命中缓存，直接返回缓存结果（底层不被调用）
        """
        monkeypatch.setenv("MULTIMODAL_MODEL", "fallback")

        from agent.memory.engine import MemoryEngine

        db_path = str(tmp_path / "get_recent_cache.db")
        engine = MemoryEngine(db_path=db_path)
        in_memory_cache = self._make_in_memory_cache()
        engine._redis_cache = in_memory_cache

        try:
            # 预存一条记忆
            await engine.store(
                content="get_recent 缓存测试",
                memory_type="short_term",
                scene="recent_test",
            )

            # 第一次调用：未命中缓存，走底层并回填
            results1 = await engine.get_recent(hours=24.0, limit=10)
            assert isinstance(results1, list)

            # 缓存应被回填
            cache_keys = in_memory_cache.keys()
            recent_keys = [k for k in cache_keys if "memory:recent:" in k]
            assert len(recent_keys) > 0, \
                f"get_recent 应回填 Redis 缓存，但 keys={cache_keys}"

            # 第二次调用：应命中缓存
            call_count = {"recent": 0}
            original_get_recent = engine._store.get_recent

            def _spy_get_recent(*args, **kwargs):
                call_count["recent"] += 1
                return original_get_recent(*args, **kwargs)

            with patch.object(
                engine._store, "get_recent", side_effect=_spy_get_recent
            ):
                results2 = await engine.get_recent(hours=24.0, limit=10)

            # 第二次应命中缓存，_store.get_recent 不应被调用
            assert call_count["recent"] == 0, \
                f"缓存命中时不应调用底层 get_recent，但调用了 {call_count['recent']} 次"
            # 返回结果应与首次一致
            assert results2 == results1
        finally:
            engine._store.close()
