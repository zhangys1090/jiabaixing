"""上下文窗口管理器 — 学习 Codex Harness 的 Context Window Management 设计.

Codex Harness 关键设计:
  - 上下文窗口管理与输出截断策略
  - 长对话中 Agent 不崩溃的关键
  - 优先级衰减: 越早的对话轮次优先级越低
  - 关键信息保留: system prompt / 最近N轮 / 工具结果
  - Token 预算分配: system/context/history/response 各有预算

jiabaixing 适配:
  - 与现有 ContextPipeline/ContextCompressor 集成
  - 提供 Codex-style 的截断策略
  - Token 预算管理
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("context_window_manager")


@dataclass
class TokenBudget:
    total: int = 128000
    system_prompt: int = 4096
    context: int = 32768
    history: int = 65536
    response: int = 8192
    tool_results: int = 16384

    @property
    def available_for_history(self) -> int:
        used = self.system_prompt + self.context + self.response + self.tool_results
        return max(0, self.total - used)


@dataclass
class TruncationPolicy:
    keep_system: bool = True
    keep_recent_turns: int = 5
    keep_tool_results: bool = True
    max_tool_result_chars: int = 2000
    compression_threshold: float = 0.85
    priority_decay: float = 0.9


@dataclass
class ContextEntry:
    role: str
    content: str
    token_count: int = 0
    priority: float = 1.0
    timestamp: float = field(default_factory=time.time)
    is_tool_result: bool = False
    is_system: bool = False
    turn_index: int = 0


@dataclass
class TruncationResult:
    entries: list[ContextEntry] = field(default_factory=list)
    original_count: int = 0
    truncated_count: int = 0
    tokens_before: int = 0
    tokens_after: int = 0
    compression_ratio: float = 1.0
    strategy_used: str = ""


class ContextWindowManager:
    """上下文窗口管理器 — Codex-style Context Window Management.

    功能:
      - Token 预算分配
      - 优先级衰减截断
      - 关键信息保留
      - 工具结果压缩
    """

    def __init__(
        self,
        budget: TokenBudget | None = None,
        policy: TruncationPolicy | None = None,
    ):
        self.budget = budget or TokenBudget()
        self.policy = policy or TruncationPolicy()

    def truncate(
        self,
        entries: list[ContextEntry],
        current_tokens: int = 0,
    ) -> TruncationResult:
        if not entries:
            return TruncationResult()

        total_tokens = current_tokens or sum(e.token_count for e in entries)
        budget = self.budget.available_for_history

        if budget <= 0:
            budget = self.budget.total

        if total_tokens <= budget:
            return TruncationResult(
                entries=entries,
                original_count=len(entries),
                truncated_count=len(entries),
                tokens_before=total_tokens,
                tokens_after=total_tokens,
                compression_ratio=1.0,
                strategy_used="none_needed",
            )

        if total_tokens > self.budget.total * self.policy.compression_threshold:
            result = self._priority_truncate(entries, budget)
        else:
            result = self._simple_truncate(entries, budget)

        result.tokens_before = total_tokens
        result.compression_ratio = (
            result.tokens_after / total_tokens if total_tokens > 0 else 1.0
        )
        return result

    def _priority_truncate(
        self, entries: list[ContextEntry], budget: int
    ) -> TruncationResult:
        scored = []
        max_turn = max((e.turn_index for e in entries), default=0)

        for entry in entries:
            priority = entry.priority

            if entry.is_system and self.policy.keep_system:
                priority = 100.0
            elif entry.is_tool_result and self.policy.keep_tool_results:
                priority = 80.0
            elif max_turn > 0:
                recency = (entry.turn_index / max_turn)
                priority *= (self.policy.priority_decay ** (1 - recency))

                if max_turn - entry.turn_index < self.policy.keep_recent_turns:
                    priority = max(priority, 50.0)

            scored.append((priority, entry))

        scored.sort(key=lambda x: -x[0])

        kept: list[ContextEntry] = []
        used_tokens = 0
        for priority, entry in scored:
            content = entry.content
            if entry.is_tool_result and len(content) > self.policy.max_tool_result_chars:
                content = content[:self.policy.max_tool_result_chars] + "\n[...truncated]"
                token_count = int(entry.token_count * self.policy.max_tool_result_chars / len(entry.content))
            else:
                token_count = entry.token_count

            if used_tokens + token_count > budget:
                break

            kept_entry = ContextEntry(
                role=entry.role,
                content=content,
                token_count=token_count,
                priority=priority,
                timestamp=entry.timestamp,
                is_tool_result=entry.is_tool_result,
                is_system=entry.is_system,
                turn_index=entry.turn_index,
            )
            kept.append(kept_entry)
            used_tokens += token_count

        kept.sort(key=lambda e: e.turn_index)

        return TruncationResult(
            entries=kept,
            original_count=len(entries),
            truncated_count=len(kept),
            tokens_after=used_tokens,
            strategy_used="priority_truncate",
        )

    def _simple_truncate(
        self, entries: list[ContextEntry], budget: int
    ) -> TruncationResult:
        kept: list[ContextEntry] = []
        used_tokens = 0

        for entry in entries:
            if used_tokens + entry.token_count > budget:
                break
            kept.append(entry)
            used_tokens += entry.token_count

        return TruncationResult(
            entries=kept,
            original_count=len(entries),
            truncated_count=len(kept),
            tokens_after=used_tokens,
            strategy_used="simple_truncate",
        )

    def estimate_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)

    def from_messages(
        self, messages: list[dict[str, Any]]
    ) -> list[ContextEntry]:
        entries = []
        for i, msg in enumerate(messages):
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    c.get("text", "") for c in content if isinstance(c, dict)
                )
            entries.append(ContextEntry(
                role=role,
                content=str(content),
                token_count=self.estimate_tokens(str(content)),
                is_system=(role == "system"),
                is_tool_result=(role == "tool"),
                turn_index=i,
            ))
        return entries
