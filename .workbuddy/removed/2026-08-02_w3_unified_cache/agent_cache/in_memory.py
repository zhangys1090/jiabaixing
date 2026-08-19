"""统一内存缓存后端。

统一了 context/cache.py 的 LRUCache 和 tools/tool_result_cache.py 的 ToolResultCache
中重复的 LRU + TTL 逻辑，提供单一、高性能的内存缓存实现。

特性:
- 基于 OrderedDict 的 LRU 淘汰策略
- 可配置的 TTL 过期
- 批量过期清理（节流优化）
- 完整的命中/未命中/淘汰统计
- 同步和异步双接口
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from agent.cache.protocol import CacheBackend, CacheStats


@dataclass
class _CacheEntry:
    """单个缓存条目。"""

    value: Any
    timestamp: float = field(default_factory=time.time)
    ttl: int = 0
    hit_count: int = 0


class InMemoryBackend(CacheBackend):
    """统一内存缓存后端。

    基于 OrderedDict 实现的 LRU 缓存，支持 TTL 过期和批量清理。

    Usage:
        cache = InMemoryBackend(max_size=1000, ttl=300)
        cache.set_sync("key", "value", ttl=60)
        result = cache.get_sync("key")
    """

    _DEFAULT_MAX_SIZE = 1000
    _CLEANUP_INTERVAL = 5.0

    def __init__(self, max_size: int = 0, ttl: int = 0) -> None:
        """初始化内存缓存。

        Args:
            max_size: 最大条目数，0 表示使用默认值 1000。
            ttl: 默认过期时间（秒），0 表示永不过期。
        """
        self._max_size = max_size if max_size > 0 else self._DEFAULT_MAX_SIZE
        self._ttl = ttl
        self._cache: OrderedDict[str, _CacheEntry] = OrderedDict()

        self._hits = 0
        self._misses = 0
        self._evictions = 0

        self._last_cleanup_time = 0.0

    def _is_expired(self, entry: _CacheEntry, now: float | None = None) -> bool:
        """检查条目是否过期。

        Args:
            entry: 缓存条目。
            now: 当前时间戳，None 则使用当前时间。

        Returns:
            是否过期。
        """
        if entry.ttl <= 0:
            return False
        current = now if now is not None else time.time()
        return (current - entry.timestamp) > entry.ttl

    def _cleanup_expired(self) -> None:
        """批量清理过期条目（节流优化）。

        至少间隔 _CLEANUP_INTERVAL 秒才执行一次清理。
        """
        if self._ttl <= 0:
            return

        now = time.time()
        if now - self._last_cleanup_time < self._CLEANUP_INTERVAL:
            return

        self._last_cleanup_time = now
        expired_keys = [
            key for key, entry in self._cache.items()
            if self._is_expired(entry, now)
        ]
        for key in expired_keys:
            del self._cache[key]

    def get_sync(self, key: str) -> Any | None:
        """同步获取缓存值。

        Args:
            key: 缓存键。

        Returns:
            缓存值，不存在或过期时返回 None。
        """
        self._cleanup_expired()
        entry = self._cache.get(key)

        if entry is None:
            self._misses += 1
            return None

        if self._is_expired(entry):
            del self._cache[key]
            self._misses += 1
            return None

        self._cache.move_to_end(key)
        entry.hit_count += 1
        self._hits += 1
        return entry.value

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        """同步设置缓存值。

        Args:
            key: 缓存键。
            value: 缓存值。
            ttl: 过期时间（秒），0 表示使用默认 TTL。
        """
        effective_ttl = ttl if ttl > 0 else self._ttl

        if key in self._cache:
            del self._cache[key]

        while len(self._cache) >= self._max_size:
            self._cache.popitem(last=False)
            self._evictions += 1

        self._cache[key] = _CacheEntry(
            value=value,
            timestamp=time.time(),
            ttl=effective_ttl,
        )

    def delete_sync(self, key: str) -> bool:
        """同步删除缓存值。

        Args:
            key: 缓存键。

        Returns:
            是否成功删除。
        """
        if key in self._cache:
            del self._cache[key]
            return True
        return False

    def delete_by_prefix_sync(self, prefix: str) -> int:
        """同步按前缀批量删除。

        Args:
            prefix: 键前缀。

        Returns:
            删除的条目数。
        """
        keys_to_remove = [k for k in self._cache if k.startswith(prefix)]
        for key in keys_to_remove:
            del self._cache[key]
        return len(keys_to_remove)

    def exists_sync(self, key: str) -> bool:
        """同步检查键是否存在。

        Args:
            key: 缓存键。

        Returns:
            是否存在（且未过期）。
        """
        entry = self._cache.get(key)
        if entry is None:
            return False
        if self._is_expired(entry):
            del self._cache[key]
            return False
        return True

    def clear_sync(self) -> None:
        """同步清空所有缓存。"""
        self._cache.clear()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    def stats_sync(self) -> CacheStats:
        """同步获取缓存统计信息。

        Returns:
            CacheStats: 统计信息。
        """
        total = self._hits + self._misses
        return CacheStats(
            hits=self._hits,
            misses=self._misses,
            evictions=self._evictions,
            size=len(self._cache),
            max_size=self._max_size,
            hit_rate=(self._hits / total) if total > 0 else 0.0,
            total_requests=total,
        )

    async def get(self, key: str) -> Any | None:
        """异步获取缓存值。"""
        return self.get_sync(key)

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        """异步设置缓存值。"""
        self.set_sync(key, value, ttl)

    async def delete(self, key: str) -> bool:
        """异步删除缓存值。"""
        return self.delete_sync(key)

    async def delete_by_prefix(self, prefix: str) -> int:
        """异步按前缀批量删除。"""
        return self.delete_by_prefix_sync(prefix)

    async def exists(self, key: str) -> bool:
        """异步检查键是否存在。"""
        return self.exists_sync(key)

    async def clear(self) -> None:
        """异步清空所有缓存。"""
        self.clear_sync()

    async def stats(self) -> CacheStats:
        """异步获取缓存统计信息。"""
        return self.stats_sync()

    @property
    def size(self) -> int:
        """当前条目数。"""
        return len(self._cache)

    @property
    def max_size(self) -> int:
        """最大容量。"""
        return self._max_size

    @property
    def hits(self) -> int:
        """命中次数。"""
        return self._hits

    @property
    def misses(self) -> int:
        """未命中次数。"""
        return self._misses

    @property
    def hit_rate(self) -> float:
        """命中率。"""
        total = self._hits + self._misses
        return (self._hits / total) if total > 0 else 0.0
