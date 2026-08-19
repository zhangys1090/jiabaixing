"""缓存后端抽象协议。

定义统一缓存层中所有后端必须实现的接口。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass
class CacheStats:
    """缓存统计信息。

    Attributes:
        hits: 命中次数。
        misses: 未命中次数。
        evictions: 淘汰次数。
        size: 当前条目数。
        max_size: 最大容量。
        hit_rate: 命中率 (0.0 ~ 1.0)。
        total_requests: 总请求次数。
    """

    hits: int = 0
    misses: int = 0
    evictions: int = 0
    size: int = 0
    max_size: int = 0
    hit_rate: float = 0.0
    total_requests: int = 0


@runtime_checkable
class CacheBackend(Protocol):
    """缓存后端抽象协议。

    所有缓存后端必须实现此协议。支持同步和异步两种调用方式。
    """

    async def get(self, key: str) -> Any | None:
        """获取缓存值。

        Args:
            key: 缓存键。

        Returns:
            缓存值，不存在或过期时返回 None。
        """
        ...

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        """设置缓存值。

        Args:
            key: 缓存键。
            value: 缓存值。
            ttl: 过期时间（秒），0 表示永不过期。
        """
        ...

    async def delete(self, key: str) -> bool:
        """删除缓存值。

        Args:
            key: 缓存键。

        Returns:
            是否成功删除。
        """
        ...

    async def delete_by_prefix(self, prefix: str) -> int:
        """按前缀批量删除。

        Args:
            prefix: 键前缀。

        Returns:
            删除的条目数。
        """
        ...

    async def exists(self, key: str) -> bool:
        """检查键是否存在。

        Args:
            key: 缓存键。

        Returns:
            是否存在。
        """
        ...

    async def clear(self) -> None:
        """清空所有缓存。"""
        ...

    async def stats(self) -> CacheStats:
        """获取缓存统计信息。

        Returns:
            CacheStats: 统计信息。
        """
        ...

    def get_sync(self, key: str) -> Any | None:
        """同步获取缓存值。"""
        ...

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        """同步设置缓存值。"""
        ...

    def delete_sync(self, key: str) -> bool:
        """同步删除缓存值。"""
        ...

    def clear_sync(self) -> None:
        """同步清空所有缓存。"""
        ...

    def stats_sync(self) -> CacheStats:
        """同步获取缓存统计信息。"""
        ...
