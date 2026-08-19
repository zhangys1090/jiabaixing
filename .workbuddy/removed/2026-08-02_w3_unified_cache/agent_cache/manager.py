"""中央缓存管理器（CacheManager）。

统一管理所有命名空间缓存，提供:
- 命名空间隔离：每个业务模块拥有独立的缓存命名空间
- 后端注册：为不同命名空间配置不同的缓存后端
- 全局统计：聚合所有命名空间的缓存统计
- 全局操作：一键清空所有缓存、获取全局健康状态
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.cache.in_memory import InMemoryBackend
from agent.cache.keys import CacheKeyBuilder
from agent.cache.protocol import CacheBackend, CacheStats


@dataclass
class _NamespaceEntry:
    """命名空间条目。"""

    backend: CacheBackend
    key_builder: CacheKeyBuilder
    created_at: float = field(default_factory=time.time)


class CacheNamespace:
    """缓存命名空间。

    封装了后端和键构建器，对外提供简洁的 get/set/delete 接口。
    """

    def __init__(self, entry: _NamespaceEntry) -> None:
        """初始化命名空间。

        Args:
            entry: 命名空间条目。
        """
        self._entry = entry

    @property
    def backend(self) -> CacheBackend:
        """底层缓存后端。"""
        return self._entry.backend

    @property
    def key_builder(self) -> CacheKeyBuilder:
        """键构建器。"""
        return self._entry.key_builder

    async def get(self, key: str) -> Any | None:
        """异步获取缓存值。"""
        return await self._entry.backend.get(key)

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        """异步设置缓存值。"""
        await self._entry.backend.set(key, value, ttl)

    async def delete(self, key: str) -> bool:
        """异步删除缓存值。"""
        return await self._entry.backend.delete(key)

    async def delete_by_prefix(self, prefix: str) -> int:
        """异步按前缀批量删除。"""
        return await self._entry.backend.delete_by_prefix(prefix)

    async def exists(self, key: str) -> bool:
        """异步检查键是否存在。"""
        return await self._entry.backend.exists(key)

    async def clear(self) -> None:
        """异步清空命名空间缓存。"""
        await self._entry.backend.clear()

    async def stats(self) -> CacheStats:
        """异步获取缓存统计。"""
        return await self._entry.backend.stats()

    def get_sync(self, key: str) -> Any | None:
        """同步获取缓存值。"""
        return self._entry.backend.get_sync(key)

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        """同步设置缓存值。"""
        self._entry.backend.set_sync(key, value, ttl)

    def delete_sync(self, key: str) -> bool:
        """同步删除缓存值。"""
        return self._entry.backend.delete_sync(key)

    def clear_sync(self) -> None:
        """同步清空命名空间缓存。"""
        self._entry.backend.clear_sync()

    def stats_sync(self) -> CacheStats:
        """同步获取缓存统计。"""
        return self._entry.backend.stats_sync()


@dataclass
class CacheHealth:
    """缓存健康状态。

    Attributes:
        total_namespaces: 命名空间总数。
        total_entries: 所有命名空间的估算条目数。
        total_hits: 总命中次数。
        total_misses: 总未命中次数。
        overall_hit_rate: 整体命中率。
        healthy: 是否健康（命中率 >= 50%）。
    """

    total_namespaces: int = 0
    total_entries: int = 0
    total_hits: int = 0
    total_misses: int = 0
    overall_hit_rate: float = 0.0
    healthy: bool = True


class CacheManager:
    """中央缓存管理器。

    统一管理所有命名空间缓存，提供全局操作入口。

    Usage:
        from agent.cache import CacheManager, InMemoryBackend

        manager = CacheManager()

        # 注册命名空间
        llm_cache = manager.namespace("llm", backend=InMemoryBackend(max_size=1000))
        tool_cache = manager.namespace("tools", backend=InMemoryBackend(max_size=500))

        # 使用命名空间缓存
        llm_cache.set_sync("completion:abc", response_data, ttl=300)
        result = llm_cache.get_sync("completion:abc")

        # 全局统计
        health = manager.get_health()
        print(f"整体命中率: {health.overall_hit_rate:.0%}")
    """

    _DEFAULT_NAMESPACE = "default"

    def __init__(self) -> None:
        self._namespaces: dict[str, _NamespaceEntry] = {}

    def namespace(
        self,
        name: str,
        backend: CacheBackend | None = None,
        max_size: int = 0,
        ttl: int = 0,
    ) -> CacheNamespace:
        """获取或创建命名空间缓存。

        Args:
            name: 命名空间名称。
            backend: 缓存后端，None 则创建默认 InMemoryBackend。
            max_size: 最大容量（仅当 backend 为 None 时生效）。
            ttl: 默认 TTL（仅当 backend 为 None 时生效）。

        Returns:
            CacheNamespace: 命名空间缓存实例。
        """
        if name in self._namespaces:
            return CacheNamespace(self._namespaces[name])

        if backend is None:
            backend = InMemoryBackend(max_size=max_size, ttl=ttl)

        entry = _NamespaceEntry(
            backend=backend,
            key_builder=CacheKeyBuilder(namespace=name),
        )
        self._namespaces[name] = entry
        return CacheNamespace(entry)

    def register(
        self,
        name: str,
        backend: CacheBackend,
    ) -> CacheNamespace:
        """注册自定义后端的命名空间。

        Args:
            name: 命名空间名称。
            backend: 缓存后端实例。

        Returns:
            CacheNamespace: 命名空间缓存实例。
        """
        entry = _NamespaceEntry(
            backend=backend,
            key_builder=CacheKeyBuilder(namespace=name),
        )
        self._namespaces[name] = entry
        return CacheNamespace(entry)

    def get(self, name: str) -> CacheNamespace | None:
        """获取已注册的命名空间。

        Args:
            name: 命名空间名称。

        Returns:
            CacheNamespace 或 None。
        """
        entry = self._namespaces.get(name)
        if entry is None:
            return None
        return CacheNamespace(entry)

    def get_or_default(self, name: str) -> CacheNamespace:
        """获取命名空间，不存在时返回默认命名空间。

        Args:
            name: 命名空间名称。

        Returns:
            CacheNamespace。
        """
        cached = self.get(name)
        if cached is not None:
            return cached
        return self.namespace(self._DEFAULT_NAMESPACE)

    async def clear_all(self) -> int:
        """异步清空所有命名空间缓存。

        Returns:
            清空的命名空间数量。
        """
        count = 0
        for entry in self._namespaces.values():
            await entry.backend.clear()
            count += 1
        return count

    def clear_all_sync(self) -> int:
        """同步清空所有命名空间缓存。

        Returns:
            清空的命名空间数量。
        """
        count = 0
        for entry in self._namespaces.values():
            entry.backend.clear_sync()
            count += 1
        return count

    async def get_all_stats(self) -> dict[str, CacheStats]:
        """异步获取所有命名空间的统计信息。

        Returns:
            命名空间名称到统计信息的映射。
        """
        result: dict[str, CacheStats] = {}
        for name, entry in self._namespaces.items():
            result[name] = await entry.backend.stats()
        return result

    def get_all_stats_sync(self) -> dict[str, CacheStats]:
        """同步获取所有命名空间的统计信息。

        Returns:
            命名空间名称到统计信息的映射。
        """
        result: dict[str, CacheStats] = {}
        for name, entry in self._namespaces.items():
            result[name] = entry.backend.stats_sync()
        return result

    def get_health(self) -> CacheHealth:
        """获取全局缓存健康状态。

        Returns:
            CacheHealth: 健康状态。
        """
        total_hits = 0
        total_misses = 0
        total_entries = 0

        for entry in self._namespaces.values():
            stats = entry.backend.stats_sync()
            total_hits += stats.hits
            total_misses += stats.misses
            total_entries += stats.size

        total_requests = total_hits + total_misses
        hit_rate = (total_hits / total_requests) if total_requests > 0 else 0.0

        return CacheHealth(
            total_namespaces=len(self._namespaces),
            total_entries=total_entries,
            total_hits=total_hits,
            total_misses=total_misses,
            overall_hit_rate=hit_rate,
            healthy=hit_rate >= 0.5,
        )

    def remove(self, name: str) -> bool:
        """移除命名空间。

        Args:
            name: 命名空间名称。

        Returns:
            是否成功移除。
        """
        if name in self._namespaces:
            entry = self._namespaces.pop(name)
            entry.backend.clear_sync()
            return True
        return False

    @property
    def namespaces(self) -> list[str]:
        """所有已注册的命名空间名称。"""
        return list(self._namespaces.keys())
