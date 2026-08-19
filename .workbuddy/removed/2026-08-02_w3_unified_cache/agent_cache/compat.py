"""向后兼容适配器。

为现有模块提供与统一缓存层的桥接，使渐进迁移成为可能。

提供以下适配器：
- LLMCacheAdapter: 包装 LLMCache，使其符合 CacheBackend 协议
- LRUCacheAdapter: 包装 context/cache.py 的 LRUCache
- ToolResultCacheAdapter: 包装 tools/tool_result_cache.py 的 ToolResultCache
- PromptCacheAdapter: 包装 llm/prompt_cache.py 的 PromptCache

Usage:
    from agent.cache.compat import LLMCacheAdapter
    from agent.llm.cache import LLMCache

    legacy_cache = LLMCache()
    unified = LLMCacheAdapter(legacy_cache)
    manager = CacheManager()
    manager.register("llm", unified)
"""

from __future__ import annotations

from typing import Any

from agent.cache.protocol import CacheBackend, CacheStats


class LLMCacheAdapter(CacheBackend):
    """LLMCache 适配器。

    将 agent.llm.cache.LLMCache 适配为 CacheBackend 接口。
    """

    def __init__(self, llm_cache: Any) -> None:
        """初始化适配器。

        Args:
            llm_cache: LLMCache 实例。
        """
        self._cache = llm_cache

    async def get(self, key: str) -> Any | None:
        return self._cache.get(key)

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        self._cache._cache[key] = (value, __import__("time").time())

    async def delete(self, key: str) -> bool:
        if key in self._cache._cache:
            del self._cache._cache[key]
            return True
        return False

    async def delete_by_prefix(self, prefix: str) -> int:
        keys = [k for k in self._cache._cache if k.startswith(prefix)]
        for k in keys:
            del self._cache._cache[k]
        return len(keys)

    async def exists(self, key: str) -> bool:
        return self._cache.get(key) is not None

    async def clear(self) -> None:
        self._cache.clear()

    async def stats(self) -> CacheStats:
        size = getattr(self._cache, "size", 0)
        return CacheStats(size=size, max_size=1000)

    def get_sync(self, key: str) -> Any | None:
        return self._cache.get(key)

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        self._cache._cache[key] = (value, __import__("time").time())

    def delete_sync(self, key: str) -> bool:
        if key in self._cache._cache:
            del self._cache._cache[key]
            return True
        return False

    def clear_sync(self) -> None:
        self._cache.clear()

    def stats_sync(self) -> CacheStats:
        size = getattr(self._cache, "size", 0)
        return CacheStats(size=size, max_size=1000)


class LRUCacheAdapter(CacheBackend):
    """LRUCache 适配器。

    将 agent.context.cache.LRUCache 适配为 CacheBackend 接口。
    """

    def __init__(self, lru_cache: Any) -> None:
        """初始化适配器。

        Args:
            lru_cache: LRUCache 实例。
        """
        self._cache = lru_cache

    async def get(self, key: str) -> Any | None:
        return self._cache.get(key)

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        self._cache.set(key, value)

    async def delete(self, key: str) -> bool:
        return self._cache.delete(key)

    async def delete_by_prefix(self, prefix: str) -> int:
        keys = [k for k in self._cache._cache if k.startswith(prefix)]
        for k in keys:
            del self._cache._cache[k]
        return len(keys)

    async def exists(self, key: str) -> bool:
        return self._cache.get(key) is not None

    async def clear(self) -> None:
        self._cache.clear()

    async def stats(self) -> CacheStats:
        return CacheStats(
            hits=self._cache.hits,
            misses=self._cache.misses,
            evictions=self._cache.evictions,
            size=self._cache.size(),
            max_size=self._cache._max_size,
            hit_rate=self._cache.hit_rate,
        )

    def get_sync(self, key: str) -> Any | None:
        return self._cache.get(key)

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        self._cache.set(key, value)

    def delete_sync(self, key: str) -> bool:
        return self._cache.delete(key)

    def clear_sync(self) -> None:
        self._cache.clear()

    def stats_sync(self) -> CacheStats:
        return CacheStats(
            hits=self._cache.hits,
            misses=self._cache.misses,
            evictions=self._cache.evictions,
            size=self._cache.size(),
            max_size=self._cache._max_size,
            hit_rate=self._cache.hit_rate,
        )


class ToolResultCacheAdapter(CacheBackend):
    """ToolResultCache 适配器。

    将 agent.tools.tool_result_cache.ToolResultCache 适配为 CacheBackend 接口。
    """

    def __init__(self, tool_cache: Any) -> None:
        """初始化适配器。

        Args:
            tool_cache: ToolResultCache 实例。
        """
        self._cache = tool_cache

    async def get(self, key: str) -> Any | None:
        tool_name, _, params_hash = key.partition(":")
        return self._cache.get(tool_name, params_hash)

    async def set(self, key: str, value: Any, ttl: int = 0) -> None:
        tool_name, _, params_hash = key.partition(":")
        from agent.tools.tool_result import ToolResult

        if isinstance(value, ToolResult):
            self._cache.set(tool_name, params_hash, value, ttl)
        else:
            result = ToolResult(success=True, output=str(value))
            self._cache.set(tool_name, params_hash, result, ttl)

    async def delete(self, key: str) -> bool:
        tool_name, _, params_hash = key.partition(":")
        return self._cache.invalidate(tool_name, params_hash)

    async def delete_by_prefix(self, prefix: str) -> int:
        tool_name = prefix.rstrip(":")
        return self._cache.invalidate_all(tool_name)

    async def exists(self, key: str) -> bool:
        tool_name, _, params_hash = key.partition(":")
        return self._cache.get(tool_name, params_hash) is not None

    async def clear(self) -> None:
        self._cache.clear()

    async def stats(self) -> CacheStats:
        return CacheStats(
            hits=self._cache.hits,
            misses=self._cache.misses,
            size=len(self._cache._cache),
            max_size=self._cache._max_entries,
        )

    def get_sync(self, key: str) -> Any | None:
        tool_name, _, params_hash = key.partition(":")
        return self._cache.get(tool_name, params_hash)

    def set_sync(self, key: str, value: Any, ttl: int = 0) -> None:
        tool_name, _, params_hash = key.partition(":")
        from agent.tools.tool_result import ToolResult

        if isinstance(value, ToolResult):
            self._cache.set(tool_name, params_hash, value, ttl)
        else:
            result = ToolResult(success=True, output=str(value))
            self._cache.set(tool_name, params_hash, result, ttl)

    def delete_sync(self, key: str) -> bool:
        tool_name, _, params_hash = key.partition(":")
        return self._cache.invalidate(tool_name, params_hash)

    def clear_sync(self) -> None:
        self._cache.clear()

    def stats_sync(self) -> CacheStats:
        return CacheStats(
            hits=self._cache.hits,
            misses=self._cache.misses,
            size=len(self._cache._cache),
            max_size=self._cache._max_entries,
        )
