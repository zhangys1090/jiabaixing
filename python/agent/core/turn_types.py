from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class TurnState(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    TOOL_CALLING = "tool_calling"
    RESPONDING = "responding"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRYING = "retrying"


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str

    def parse_arguments(self) -> dict[str, Any]:
        import json
        try:
            return json.loads(self.arguments)
        except (json.JSONDecodeError, TypeError):
            return {}


@dataclass
class ToolResult:
    tool_call_id: str
    name: str
    output: str
    success: bool = True
    error: str | None = None
    duration: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TurnContext:
    turn_id: str = ""
    user_input: str = ""
    messages: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    state: TurnState = TurnState.PENDING
    start_time: float = 0.0
    end_time: float = 0.0
    retry_count: int = 0
    max_retries: int = 3
    error: str | None = None

    @property
    def duration(self) -> float:
        if self.end_time and self.start_time:
            return self.end_time - self.start_time
        return 0.0

    def add_assistant_message(self, content: str, tool_calls: list[dict] | None = None) -> None:
        msg: dict[str, Any] = {"role": "assistant", "content": content}
        if tool_calls:
            msg["tool_calls"] = tool_calls
        self.messages.append(msg)

    def add_tool_result_message(self, tool_call_id: str, content: str) -> None:
        self.messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content,
        })

    def add_user_message(self, content: str) -> None:
        self.messages.append({"role": "user", "content": content})


@dataclass
class IterationBudget:
    """迭代预算管理，控制对话循环的轮数、Token 和连续失败上限。

    Attributes:
        max_tool_rounds: 最大工具调用轮数。
        current_round: 当前已执行的轮数。
        max_tokens_per_round: 每轮最大 Token 数。
        total_tokens_used: 已使用的 Token 总数。
        max_total_tokens: Token 总量上限。
        max_consecutive_failures: 允许的连续失败次数上限。
        consecutive_failures: 当前连续失败计数。
    """

    max_tool_rounds: int = 10
    current_round: int = 0
    max_tokens_per_round: int = 4000
    total_tokens_used: int = 0
    max_total_tokens: int = 50000
    max_consecutive_failures: int = 3
    consecutive_failures: int = 0
    total_failures: int = 0
    total_tool_calls: int = 0
    max_failure_rate: float = 0.8

    @property
    def remaining_rounds(self) -> int:
        """剩余可用轮数。"""
        return max(0, self.max_tool_rounds - self.current_round)

    @property
    def is_exhausted(self) -> bool:
        """轮数是否已耗尽。"""
        return self.current_round >= self.max_tool_rounds

    @property
    def is_token_exhausted(self) -> bool:
        """Token 总量是否已耗尽。"""
        return self.total_tokens_used >= self.max_total_tokens

    @property
    def is_failure_exhausted(self) -> bool:
        """连续失败次数是否已达上限，或总失败率是否过高。"""
        if self.consecutive_failures >= self.max_consecutive_failures:
            return True
        if self.total_tool_calls >= 3 and self.total_failures / self.total_tool_calls >= self.max_failure_rate:
            return True
        return False

    def increment(self) -> None:
        """递增当前轮数。"""
        self.current_round += 1

    def add_tokens(self, count: int) -> None:
        """累加已使用的 Token 数。

        Args:
            count: 本轮消耗的 Token 数量。
        """
        self.total_tokens_used += count

    def record_failure(self) -> None:
        """记录一次连续失败，递增 consecutive_failures 和 total_failures。"""
        self.consecutive_failures += 1
        self.total_failures += 1
        self.total_tool_calls += 1

    def reset_failure_streak(self) -> None:
        """重置连续失败计数为 0，在成功后调用。同时记录总调用数。"""
        self.consecutive_failures = 0
        self.total_tool_calls += 1


@dataclass
class ConversationResult:
    content: str
    session_id: str
    trace_id: str
    tool_calls_made: int = 0
    tool_results_count: int = 0
    rounds_used: int = 0
    total_tokens: int = 0
    duration: float = 0.0
    finish_reason: str = "stop"
    quality_score: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


class CancellationToken:
    """W5: 协作式取消令牌，支持从外部中断 ConversationLoop."""

    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled


@dataclass
class LoopCheckpoint:
    """W1: 对话循环检查点，支持暂停/恢复."""

    turn_id: str
    session_id: str
    user_input: str
    messages: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]]
    tool_results: list[dict[str, Any]]
    current_round: int
    budget_data: dict[str, Any]
    finish_reason: str = "stop"
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if not self.timestamp:
            self.timestamp = time.time()

    def serialize(self) -> dict[str, Any]:
        return {
            "turn_id": self.turn_id,
            "session_id": self.session_id,
            "user_input": self.user_input,
            "messages": self.messages,
            "tool_calls": self.tool_calls,
            "tool_results": self.tool_results,
            "current_round": self.current_round,
            "budget_data": self.budget_data,
            "finish_reason": self.finish_reason,
            "timestamp": self.timestamp,
        }

    @classmethod
    def deserialize(cls, data: dict[str, Any]) -> "LoopCheckpoint":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
