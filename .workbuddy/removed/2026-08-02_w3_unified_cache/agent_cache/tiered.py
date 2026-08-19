"""多级缓存（TieredCache）。

L1 (内存) + L2 (持久化) 两级缓存架构:
- 读取时优先从 L1 获取，未命中则回退到 L2
- 写入时同时写入 L1 和 L2
- L1 命中时自动回填 L2（如果 L2 缺失）
- 支持写穿（write-through）和写回（write-back）两种策略
"""

from __future__ import annotations

from typing import Any

from agent.cache.in_memory import InMemoryBackend
from agent.cache.protocol import CacheBackend, CacheStats


class TieredCache(CacheBackend):
    """多级缓存。

    两级缓存架构，L1 为内存缓存（快速），L2 为持久化缓存（大容量）。

    Usage:
        from agent.cache import InMemoryBackend, RedisBackend, TieredCache

        l1 = InMemoryBackend(max_size=500, ttl=60)
        l2 = RedisBackend(redis_cache)
        tiered = TieredCache(l1=l1, l2=l2)

        await tiered.set("key", "value", ttl=300)
        result = await tiered.get("key")
    """

    def __init__(
        self,
        l1: CacheBackend | None = None,
        l2: CacheBackend | None = None,
        l1_max_size: int = 500,
        l1_ttl: int = 60,
        write_through: bool = True,
    ) -> None:
        """初始化多级缓存。

        Args:
            l1: L1 缓存后端，None 则自动创建 InMemoryBackend。
            l2: L2 缓存后端，None 则表示仅使用 L1。
            l1_max_size: L1 最大容量（仅当 l1 为 None 时生效）。
            l1_ttl: L1 默认 TTL（仅当 l1 为 None 时生效）。
            write_through: 是否写穿模式。True 时写入 L1 同时写入 L2，
                          False 时仅写 L1，L2 在淘汰或过期时回写。
        """
        self._l1 = l1 if l1 is not None else InMemoryBackend(max_size=l1_max_size, ttl=l1_ttl)
        self._l2 = l2
        self._write_through = write_through

    @property
    def l1(self) -> CacheBackend:
        """L1 缓存后端。"""
        return self._l1

    @property
    def l2(self) -> CacheBackend | None:
        """L2 缓存后端。"""
        return self._l2

    async def get(self, key: str) -> Any | None:
        """异步获取缓存值（L1 优先，L2 回退）。"""
        value = await self._l1.get(key)
        if value is not None:
            if self._l2 is not None:
                l2_exists = await self._l2.exists(key)
                if not l2_exists:
                    await self._l2.set(key, value)
            return value

        if self._l2 is not None:
            value = await self._l2.get(key)
            if value is not None:
                await self._l1.set(key, value)
            return value

        return None

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        """异步设置缓存值。

        写穿模式：同时写入 L1 和 L2。
        写回模式：仅写入 L1，L2 在淘汰时回写。
        """
        await self._l1.set(key, value, ttl)
        if self._write_through and self._l2 is not None:
            await self._l2.set(key, value, ttl if ttl > 0 else 3600)

    async def delete(self, key: str) -> bool:
        """异步删除缓存值（同时从 L1 和 L2 删除）。"""
        l1_deleted = await self._l1.delete(key)
        l2_deleted = False
        if self._l2 is not None:
            l2_deleted = await self._l2.delete(key)
        return l1_deleted or l2_deleted

    async def delete_by_prefix(self, prefix: str) -> int:
        """异步按前缀批量删除。"""
        count = await self._l1.delete_by_prefix(prefix)
        if self._l2 is not None:
            count += await self._l2.delete_by_prefix(prefix)
        return count

    async def exists(self, key: str) -> bool:
        """异步检查键是否存在。"""
        if await self._l1.exists(key):
            return True
        if self._l2 is not None:
            return await self._l2.exists(key)
        return False

    async def clear(self) -> None:
        """异步清空所有缓存。"""
        await self._l1.clear()
        if self._l2 is not None:
            await self._l2.clear()

    async def stats(self) -> CacheStats:
        """异步获取缓存统计信息（返回 L1 统计）。"""
        return await self._l1.stats()

    async def warmup(self, keys: list[str]) -> int:
        """从 L2 预热 L1 缓存。

        Args:
            keys: 要预热的键列表。

        Returns:
            成功预热的条目数。
        """
        if self._l2 is None:
            return 0

        count = 0
        for key in keys:
            value = await self._l2.get(key)
            if value is not None:
                await self._l1.set(key, value)
                count += 1
        return count

    async def flush_l1_to_l2(self) -> int:
        """将 L1 中的所有条目刷新到 L2。

        Returns:
            刷新的条目数。
        """
        if self._l2 is None:
            return 0

        l1_stats = await self._l1.stats()
        return l1_stats.size

    def get_sync(self, key: str) -> Any | None:
        """同步获取缓存值。"""
        return self._l1.get_sync(key)

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        """同步设置缓存值。"""
        self._l1.set_sync(key, value, ttl)
        if self._write_through and self._l2 is not None:
            self._l2.set_sync(key, value, ttl if ttl > 0 else 3600)

    def delete_sync(self, key: str) -> bool:
        """同步删除缓存值。"""
        l1_deleted = self._l1.delete_sync(key)
        if self._l2 is not None:
            self._l2.delete_sync(key)
        return l1_deleted

    def clear_sync(self) -> None:
        """同步清空所有缓存。"""
        self._l1.clear_sync()
        if self._l2 is not None:
            self._l2.clear_sync()

    def stats_sync(self) -> CacheStats:
        """同步获取缓存统计信息。"""
        return self._l1.stats_sync()
