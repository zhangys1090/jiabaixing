"""Redis 缓存后端适配器。

包装 memory/redis_cache.py 的 RedisCache，使其符合统一缓存层的 CacheBackend 协议。
"""

from __future__ import annotations

from typing import Any

from agent.cache.protocol import CacheBackend, CacheStats


class RedisBackend(CacheBackend):
    """Redis 缓存后端适配器。

    包装现有的 RedisCache 实例，暴露统一的 CacheBackend 接口。

    Usage:
        from agent.memory.redis_cache import RedisCache
        from agent.cache import RedisBackend

        redis = RedisCache()
        backend = RedisBackend(redis)
        await backend.set("key", "value", ttl=300)
    """

    def __init__(self, redis_cache: Any) -> None:
        """初始化 Redis 后端。

        Args:
            redis_cache: RedisCache 实例。
        """
        self._redis = redis_cache

    async def get(self, key: str) -> Any | None:
        """异步获取缓存值。"""
        return await self._redis.get(key)

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        """异步设置缓存值。"""
        effective_ttl = ttl if ttl > 0 else 3600
        await self._redis.set(key, value, effective_ttl)

    async def delete(self, key: str) -> bool:
        """异步删除缓存值。"""
        return await self._redis.delete(key)

    async def delete_by_prefix(self, prefix: str) -> int:
        """异步按前缀批量删除。"""
        return await self._redis.delete_by_prefix(prefix)

    async def exists(self, key: str) -> bool:
        """异步检查键是否存在。"""
        return await self._redis.exists(key)

    async def clear(self) -> None:
        """异步清空所有缓存。

        注意：Redis 后端不支持全量清空，仅清空前缀匹配的键。
        """
        await self._redis.delete_by_prefix("")

    async def stats(self) -> CacheStats:
        """异步获取缓存统计信息。

        注意：Redis 后端只能提供有限的统计信息。
        """
        return CacheStats()

    def get_sync(self, key: str) -> Any | None:
        """同步获取缓存值（封装异步调用）。"""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.get(key))

        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(asyncio.run, self.get(key))
            return future.result()

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        """同步设置缓存值（封装异步调用）。"""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self.set(key, value, ttl))
            return

        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(asyncio.run, self.set(key, value, ttl))
            future.result()

    def delete_sync(self, key: str) -> bool:
        """同步删除缓存值（封装异步调用）。"""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.delete(key))

        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(asyncio.run, self.delete(key))
            return future.result()

    def clear_sync(self) -> None:
        """同步清空所有缓存。"""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self.clear())
            return

        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(asyncio.run, self.clear())
            future.result()

    def stats_sync(self) -> CacheStats:
        """同步获取缓存统计信息。"""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.stats())

        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(asyncio.run, self.stats())
            return future.result()
