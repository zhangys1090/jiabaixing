from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from agent.tools.registry import ToolResult


@dataclass
class CacheEntry:
    """工具结果缓存条目。

    Attributes:
        result: 缓存的工具执行结果。
        timestamp: 缓存写入时的 Unix 时间戳（秒）。
        ttl_seconds: 缓存存活时间（秒）。
        hit_count: 缓存命中次数。
    """

    result: ToolResult
    timestamp: float
    ttl_seconds: int
    hit_count: int = 0


class ToolResultCache:
    """工具结果缓存。

    缓存工具执行结果以避免重复计算。使用 LRU 策略管理条目数量，
    支持 TTL 过期和按工具名批量失效。

    - 默认 TTL: 300 秒（5 分钟）
    - 最大条目数: 1000（LRU 驱逐）
    - 不缓存失败结果（success=False）

    Usage:
        cache = ToolResultCache()
        cache.put("file_read", params_hash, tool_result)
        result = cache.get("file_read", params_hash)
    """

    DEFAULT_TTL: int = 300
    MAX_ENTRIES: int = 1000

    def __init__(self, default_ttl: int = DEFAULT_TTL, max_entries: int = MAX_ENTRIES) -> None:
        """初始化工具结果缓存。

        Args:
            default_ttl: 默认缓存存活时间（秒）。
            max_entries: 最大缓存条目数。
        """
        self._default_ttl = default_ttl
        self._max_entries = max_entries
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._hits: int = 0
        self._misses: int = 0

    def put(
        self,
        tool_name: str,
        params_hash: str,
        result: ToolResult,
        ttl: int = 0,
    ) -> None:
        """存入缓存。

        不缓存失败结果（success=False）。

        Args:
            tool_name: 工具名称。
            params_hash: 参数哈希值，通过 compute_hash 计算得到。
            result: 工具执行结果。
            ttl: 缓存存活时间（秒），0 表示使用默认值。
        """
        # 不缓存失败结果
        if not result.success:
            return

        cache_key = self._make_key(tool_name, params_hash)
        effective_ttl = ttl if ttl > 0 else self._default_ttl

        # 如果已存在，先移除（OrderedDict 会重新插入到末尾）
        if cache_key in self._cache:
            del self._cache[cache_key]

        # LRU 驱逐：超过最大条目数时移除最旧的
        while len(self._cache) >= self._max_entries:
            self._cache.popitem(last=False)

        self._cache[cache_key] = CacheEntry(
            result=result,
            timestamp=time.time(),
            ttl_seconds=effective_ttl,
        )

    def get(self, tool_name: str, params_hash: str) -> ToolResult | None:
        """获取缓存。

        命中时自动将条目移到 OrderedDict 末尾（LRU 更新）。

        Args:
            tool_name: 工具名称。
            params_hash: 参数哈希值。

        Returns:
            ToolResult | None: 缓存命中且未过期时返回结果，否则返回 None。
        """
        cache_key = self._make_key(tool_name, params_hash)
        entry = self._cache.get(cache_key)

        if entry is None:
            self._misses += 1
            return None

        # 检查过期
        if self._is_expired(entry):
            del self._cache[cache_key]
            self._misses += 1
            return None

        # LRU: 移到末尾
        self._cache.move_to_end(cache_key)
        entry.hit_count += 1
        self._hits += 1
        return entry.result

    def invalidate(self, tool_name: str, params_hash: str) -> bool:
        """使指定缓存条目失效。

        Args:
            tool_name: 工具名称。
            params_hash: 参数哈希值。

        Returns:
            bool: 成功移除返回 True，条目不存在返回 False。
        """
        cache_key = self._make_key(tool_name, params_hash)
        if cache_key in self._cache:
            del self._cache[cache_key]
            return True
        return False

    def invalidate_all(self, tool_name: str) -> int:
        """使某工具的所有缓存失效。

        Args:
            tool_name: 工具名称。

        Returns:
            int: 移除的缓存条目数。
        """
        prefix = f"{tool_name}:"
        keys_to_remove = [k for k in self._cache if k.startswith(prefix)]
        for key in keys_to_remove:
            del self._cache[key]
        return len(keys_to_remove)

    def clear(self) -> None:
        """清空所有缓存。"""
        self._cache.clear()
        self._hits = 0
        self._misses = 0

    def cleanup_expired(self) -> int:
        """清理过期缓存。

        Returns:
            int: 清理的过期条目数。
        """
        expired_keys = [
            key for key, entry in self._cache.items()
            if self._is_expired(entry)
        ]
        for key in expired_keys:
            del self._cache[key]
        return len(expired_keys)

    def get_stats(self) -> dict[str, Any]:
        """获取缓存统计信息。

        Returns:
            dict: 包含命中数、未命中数、条目数和命中率的统计。
        """
        total = self._hits + self._misses
        hit_rate = (self._hits / total) if total > 0 else 0.0
        return {
            "hits": self._hits,
            "misses": self._misses,
            "entries": len(self._cache),
            "hit_rate": round(hit_rate, 4),
        }

    @staticmethod
    def compute_hash(tool_name: str, params: dict[str, Any]) -> str:
        """计算参数哈希值。

        将工具名和参数序列化为 JSON 后进行 SHA-256 哈希。

        Args:
            tool_name: 工具名称。
            params: 工具调用参数。

        Returns:
            str: 参数哈希值（SHA-256 十六进制字符串）。
        """
        payload = json.dumps(
            {"tool": tool_name, "params": params},
            sort_keys=True,
            ensure_ascii=False,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @staticmethod
    def _make_key(tool_name: str, params_hash: str) -> str:
        """构造缓存键。

        Args:
            tool_name: 工具名称。
            params_hash: 参数哈希值。

        Returns:
            str: 组合缓存键。
        """
        return f"{tool_name}:{params_hash}"

    @staticmethod
    def _is_expired(entry: CacheEntry) -> bool:
        """检查缓存条目是否已过期。

        Args:
            entry: 缓存条目。

        Returns:
            bool: 已过期返回 True。
        """
        return (time.time() - entry.timestamp) > entry.ttl_seconds
