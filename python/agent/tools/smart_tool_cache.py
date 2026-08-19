"""智能工具缓存 — 细粒度缓存 + 幂等性标记 + 分类统计。

设计目标：
1. 细粒度缓存键：基于 (tool_name + params_hash) 的精确缓存
2. 幂等性标记：幂等工具自动缓存，非幂等工具标记不可缓存
3. TTL 差异化：不同工具类型使用不同 TTL（文件读取长/网络请求短）
4. LRU 淘汰：内存限制下的 LRU 驱逐
5. 分类统计：按工具/模板分类统计命中率、节省 Token 数、延迟改善

幂等工具判定：
  - file_read, file_list, code_analyze, lsp_*: 幂等，可缓存
  - file_write, desktop_click, browser_type: 非幂等，不可缓存
  - screen_parse, environment_info: 短 TTL 可缓存（环境可能变化）

Usage:
    cache = SmartToolCache()
    cache.register_idempotent("file_read", ttl=600)
    cache.register_non_idempotent("file_write")
    result = cache.get("file_read", {"path": "/tmp/a.txt"})
    if result is None:
        result = await execute_tool(...)
        cache.put("file_read", {"path": "/tmp/a.txt"}, result)
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("smart_tool_cache")


class CachePolicy(str, Enum):
    ALWAYS = "always"
    SHORT_TTL = "short_ttl"
    NEVER = "never"


@dataclass
class CacheEntry:
    key: str
    tool_name: str
    result: Any
    timestamp: float
    ttl_seconds: float
    hit_count: int = 0
    token_saved: int = 0
    latency_saved_ms: float = 0.0


@dataclass
class ToolCachePolicy:
    tool_name: str
    policy: CachePolicy
    ttl_seconds: float = 300.0
    max_entries: int = 100


@dataclass
class CacheStats:
    tool_name: str
    hits: int = 0
    misses: int = 0
    hit_rate: float = 0.0
    entries: int = 0
    token_saved: int = 0
    latency_saved_ms: float = 0.0


_IDEMPOTENT_TOOLS: dict[str, tuple[CachePolicy, float]] = {
    "file_read": (CachePolicy.ALWAYS, 600.0),
    "file_list": (CachePolicy.ALWAYS, 300.0),
    "file_search": (CachePolicy.ALWAYS, 120.0),
    "code_analyze": (CachePolicy.ALWAYS, 600.0),
    "code_search": (CachePolicy.ALWAYS, 300.0),
    "lsp_diagnostics": (CachePolicy.SHORT_TTL, 60.0),
    "lsp_hover": (CachePolicy.ALWAYS, 300.0),
    "lsp_definitions": (CachePolicy.ALWAYS, 600.0),
    "lsp_references": (CachePolicy.ALWAYS, 300.0),
    "memory_search": (CachePolicy.SHORT_TTL, 60.0),
    "memory_recall": (CachePolicy.SHORT_TTL, 60.0),
    "screen_parse": (CachePolicy.SHORT_TTL, 30.0),
    "environment_info": (CachePolicy.SHORT_TTL, 60.0),
    "scene_perceive": (CachePolicy.SHORT_TTL, 30.0),
    "emotion_perceive": (CachePolicy.SHORT_TTL, 15.0),
    "desktop_uia_find": (CachePolicy.SHORT_TTL, 10.0),
    "desktop_uia_inspect": (CachePolicy.SHORT_TTL, 10.0),
    "browser_screenshot": (CachePolicy.SHORT_TTL, 5.0),
    "web_search": (CachePolicy.SHORT_TTL, 120.0),
    "web_fetch": (CachePolicy.ALWAYS, 300.0),
}

_NON_IDEMPOTENT_TOOLS: set[str] = {
    "file_write", "file_delete", "file_move", "file_copy",
    "desktop_click", "desktop_type", "desktop_hotkey",
    "desktop_uia_invoke", "desktop_uia_set_value",
    "browser_click", "browser_type", "browser_navigate",
    "code_fix", "code_refactor",
    "process_kill", "service_control",
    "clipboard_set",
}


class SmartToolCache:
    def __init__(
        self,
        max_total_entries: int = 2000,
        default_ttl: float = 300.0,
        short_ttl: float = 30.0,
    ) -> None:
        self._max_total_entries = max_total_entries
        self._default_ttl = default_ttl
        self._short_ttl = short_ttl

        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._policies: dict[str, ToolCachePolicy] = {}
        self._stats: dict[str, CacheStats] = {}
        self._total_hits = 0
        self._total_misses = 0

        self._init_default_policies()

    def _init_default_policies(self) -> None:
        for tool_name, (policy, ttl) in _IDEMPOTENT_TOOLS.items():
            self._policies[tool_name] = ToolCachePolicy(
                tool_name=tool_name, policy=policy, ttl_seconds=ttl,
            )
        for tool_name in _NON_IDEMPOTENT_TOOLS:
            self._policies[tool_name] = ToolCachePolicy(
                tool_name=tool_name, policy=CachePolicy.NEVER, ttl_seconds=0,
            )

    def register_idempotent(self, tool_name: str, ttl: float = 300.0) -> None:
        self._policies[tool_name] = ToolCachePolicy(
            tool_name=tool_name, policy=CachePolicy.ALWAYS, ttl_seconds=ttl,
        )

    def register_non_idempotent(self, tool_name: str) -> None:
        self._policies[tool_name] = ToolCachePolicy(
            tool_name=tool_name, policy=CachePolicy.NEVER, ttl_seconds=0,
        )

    def register_short_ttl(self, tool_name: str, ttl: float = 30.0) -> None:
        self._policies[tool_name] = ToolCachePolicy(
            tool_name=tool_name, policy=CachePolicy.SHORT_TTL, ttl_seconds=ttl,
        )

    def is_cacheable(self, tool_name: str) -> bool:
        policy = self._policies.get(tool_name)
        if policy is None:
            return True
        return policy.policy != CachePolicy.NEVER

    def get(self, tool_name: str, params: dict[str, Any]) -> Any | None:
        policy = self._policies.get(tool_name)
        if policy and policy.policy == CachePolicy.NEVER:
            self._record_miss(tool_name)
            return None

        cache_key = self._compute_key(tool_name, params)
        entry = self._cache.get(cache_key)

        if entry is None:
            self._record_miss(tool_name)
            return None

        if self._is_expired(entry):
            del self._cache[cache_key]
            self._record_miss(tool_name)
            return None

        self._cache.move_to_end(cache_key)
        entry.hit_count += 1
        self._total_hits += 1

        stats = self._get_stats(tool_name)
        stats.hits += 1
        stats.token_saved += entry.token_saved
        stats.latency_saved_ms += entry.latency_saved_ms

        return entry.result

    def put(
        self,
        tool_name: str,
        params: dict[str, Any],
        result: Any,
        token_count: int = 0,
        latency_ms: float = 0.0,
    ) -> None:
        policy = self._policies.get(tool_name)
        if policy and policy.policy == CachePolicy.NEVER:
            return

        success = getattr(result, "success", True)
        if success is False:
            return

        cache_key = self._compute_key(tool_name, params)
        ttl = self._resolve_ttl(tool_name, policy)

        if cache_key in self._cache:
            del self._cache[cache_key]

        while len(self._cache) >= self._max_total_entries:
            self._cache.popitem(last=False)

        self._cache[cache_key] = CacheEntry(
            key=cache_key,
            tool_name=tool_name,
            result=result,
            timestamp=time.time(),
            ttl_seconds=ttl,
            token_saved=token_count,
            latency_saved_ms=latency_ms,
        )

        stats = self._get_stats(tool_name)
        stats.entries = sum(1 for e in self._cache.values() if e.tool_name == tool_name)

    def invalidate(self, tool_name: str, params: dict[str, Any]) -> bool:
        cache_key = self._compute_key(tool_name, params)
        if cache_key in self._cache:
            del self._cache[cache_key]
            return True
        return False

    def invalidate_tool(self, tool_name: str) -> int:
        keys_to_remove = [k for k, v in self._cache.items() if v.tool_name == tool_name]
        for key in keys_to_remove:
            del self._cache[key]
        return len(keys_to_remove)

    def clear(self) -> None:
        self._cache.clear()
        self._total_hits = 0
        self._total_misses = 0
        for stats in self._stats.values():
            stats.hits = 0
            stats.misses = 0
            stats.entries = 0

    def cleanup_expired(self) -> int:
        expired_keys = [k for k, v in self._cache.items() if self._is_expired(v)]
        for key in expired_keys:
            del self._cache[key]
        return len(expired_keys)

    def get_stats(self, tool_name: str | None = None) -> dict[str, Any]:
        if tool_name:
            stats = self._get_stats(tool_name)
            total = stats.hits + stats.misses
            stats.hit_rate = (stats.hits / total) if total > 0 else 0.0
            return {
                "tool_name": stats.tool_name,
                "hits": stats.hits,
                "misses": stats.misses,
                "hit_rate": round(stats.hit_rate, 4),
                "entries": stats.entries,
                "token_saved": stats.token_saved,
                "latency_saved_ms": round(stats.latency_saved_ms, 2),
            }

        total = self._total_hits + self._total_misses
        overall_hit_rate = (self._total_hits / total) if total > 0 else 0.0

        per_tool: dict[str, dict[str, Any]] = {}
        for name, stats in self._stats.items():
            t = stats.hits + stats.misses
            per_tool[name] = {
                "hits": stats.hits,
                "misses": stats.misses,
                "hit_rate": round((stats.hits / t) if t > 0 else 0.0, 4),
                "entries": stats.entries,
                "token_saved": stats.token_saved,
                "latency_saved_ms": round(stats.latency_saved_ms, 2),
            }

        return {
            "overall_hits": self._total_hits,
            "overall_misses": self._total_misses,
            "overall_hit_rate": round(overall_hit_rate, 4),
            "total_entries": len(self._cache),
            "per_tool": per_tool,
        }

    def get_low_efficiency_tools(self, threshold: float = 0.2) -> list[str]:
        low_eff: list[str] = []
        for name, stats in self._stats.items():
            total = stats.hits + stats.misses
            if total >= 5:
                hit_rate = stats.hits / total
                if hit_rate < threshold:
                    low_eff.append(name)
        return low_eff

    def _compute_key(self, tool_name: str, params: dict[str, Any]) -> str:
        payload = json.dumps(
            {"tool": tool_name, "params": params},
            sort_keys=True,
            ensure_ascii=False,
        )
        params_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
        return f"{tool_name}:{params_hash}"

    def _resolve_ttl(self, tool_name: str, policy: ToolCachePolicy | None) -> float:
        if policy:
            return policy.ttl_seconds
        return self._default_ttl

    @staticmethod
    def _is_expired(entry: CacheEntry) -> bool:
        return (time.time() - entry.timestamp) > entry.ttl_seconds

    def _get_stats(self, tool_name: str) -> CacheStats:
        if tool_name not in self._stats:
            self._stats[tool_name] = CacheStats(tool_name=tool_name)
        return self._stats[tool_name]

    def _record_miss(self, tool_name: str) -> None:
        self._total_misses += 1
        stats = self._get_stats(tool_name)
        stats.misses += 1
