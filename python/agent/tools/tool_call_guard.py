from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("tool_call_guard")


@dataclass
class CachedResult:
    """工具调用缓存结果条目。

    Attributes:
        result: 缓存的执行结果。
        timestamp: 缓存时间戳（毫秒）。
    """

    result: dict[str, Any]
    timestamp: float


@dataclass
class ToolCallRecord:
    """工具调用历史记录。

    Attributes:
        tool_name: 工具名称。
        args_hash: 参数的JSON哈希值。
        timestamp: 调用时间戳（毫秒）。
    """

    tool_name: str
    args_hash: str
    timestamp: float


@dataclass
class GuardResult:
    """调用守卫检查结果。

    Attributes:
        blocked: 是否被拦截。
        result: 拦截时返回的替代结果（含缓存/去重/限速信息）。
        reason: 拦截原因。
    """

    blocked: bool
    result: dict[str, Any] | None = None
    reason: str = ""


class ToolCallGuard:
    """工具调用守卫——去重、缓存、速率限制。

    防止Agent在短时间内重复调用同一工具，提供三个维度的防护：
    1. 结果缓存：相同参数5分钟内返回缓存结果。
    2. 调用去重：30秒内相同参数调用直接拦截。
    3. 速率限制：同一工具每轮最多调用2次。

    Usage:
        guard = ToolCallGuard()
        check_result = guard.check("web_search", {"query": "test"})
        if check_result.blocked:
            return check_result.result
        ...  # 执行工具
        guard.record("web_search", {"query": "test"}, result)
    """

    _CACHE_TTL_MS = 5 * 60 * 1000
    _MAX_HISTORY = 20
    _MAX_SAME_TOOL = 2
    _DEDUP_WINDOW_MS = 30_000

    def __init__(self) -> None:
        self._result_cache: dict[str, CachedResult] = {}
        self._call_history: list[ToolCallRecord] = []
        self._per_tool_counts: dict[str, int] = {}

    def check(self, tool_name: str, args: dict[str, Any]) -> GuardResult:
        """检查工具调用是否被拦截。

        依次检查：缓存命中 → 去重检测 → 速率限制。

        Args:
            tool_name: 工具名称。
            args: 调用参数。

        Returns:
            GuardResult: 包含blocked标志和替代结果。
        """
        args_hash = self._hash_args(args)
        now_ms = time.time() * 1000

        cache_key = f"{tool_name}:{args_hash}"
        cached = self._result_cache.get(cache_key)
        if cached and now_ms - cached.timestamp < self._CACHE_TTL_MS:
            age_sec = int((now_ms - cached.timestamp) / 1000)
            log.debug("工具缓存命中", tool=tool_name, age=f"{age_sec}s")
            return GuardResult(
                blocked=True,
                result={
                    **(cached.result),
                    "output": f"[缓存结果 {age_sec}秒前]\n{cached.result.get('output', '')}",
                    "metadata": {**(cached.result.get("metadata", {})), "fromCache": True},
                },
            )

        for record in self._call_history:
            if record.tool_name == tool_name and record.args_hash == args_hash and now_ms - record.timestamp < self._DEDUP_WINDOW_MS:
                age_sec = int((now_ms - record.timestamp) / 1000)
                log.warning("工具去重拦截", tool=tool_name, age=f"{age_sec}s")
                return GuardResult(
                    blocked=True,
                    result={
                        "success": True,
                        "output": f"[去重] {tool_name} 在 {age_sec} 秒前已用相同参数调用过，结果没有变化。请使用已有结果或换一个不同的关键词/参数重试。",
                        "duration": 0,
                        "validated": True,
                        "metadata": {"deduplicated": True},
                    },
                    reason=f"{age_sec}秒前已调用相同参数",
                )

        tool_count = self._per_tool_counts.get(tool_name, 0)
        if tool_count >= self._MAX_SAME_TOOL:
            log.warning("工具速率限制", tool=tool_name, count=tool_count, max=self._MAX_SAME_TOOL)
            return GuardResult(
                blocked=True,
                result={
                    "success": True,
                    "output": f"[速率限制] {tool_name} 已调用 {tool_count} 次。请立即基于已有结果回复用户，不要再调用此工具。",
                    "duration": 0,
                    "validated": True,
                    "metadata": {"rateLimited": True},
                },
                reason=f"已调用 {tool_count} 次，超过上限 {self._MAX_SAME_TOOL}",
            )

        return GuardResult(blocked=False)

    def record(self, tool_name: str, args: dict[str, Any], result: dict[str, Any]) -> None:
        """记录一次工具调用结果，更新历史记录和缓存。

        Args:
            tool_name: 工具名称。
            args: 调用参数。
            result: 工具执行结果，success=True时缓存。
        """
        args_hash = self._hash_args(args)
        now_ms = time.time() * 1000

        self._call_history.append(ToolCallRecord(tool_name=tool_name, args_hash=args_hash, timestamp=now_ms))
        if len(self._call_history) > self._MAX_HISTORY:
            self._call_history = self._call_history[-self._MAX_HISTORY:]

        self._per_tool_counts[tool_name] = self._per_tool_counts.get(tool_name, 0) + 1

        if result.get("success"):
            cache_key = f"{tool_name}:{args_hash}"
            self._result_cache[cache_key] = CachedResult(result=result, timestamp=now_ms)

            if len(self._result_cache) > 50:
                expired = [k for k, e in self._result_cache.items() if now_ms - e.timestamp > self._CACHE_TTL_MS]
                for k in expired:
                    del self._result_cache[k]

        log.debug("工具调用记录", tool=tool_name, count=self._per_tool_counts.get(tool_name, 0))

    def reset_round(self) -> None:
        self._call_history = []
        self._per_tool_counts.clear()

    def get_stats(self) -> dict[str, Any]:
        per_tool = dict(self._per_tool_counts)
        return {
            "total_calls": len(self._call_history),
            "per_tool": per_tool,
            "cache_size": len(self._result_cache),
        }

    @staticmethod
    def _hash_args(args: dict[str, Any]) -> str:
        try:
            return json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            return str(time.time())
