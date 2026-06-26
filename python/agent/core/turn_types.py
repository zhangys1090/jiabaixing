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
    max_tool_rounds: int = 10
    current_round: int = 0
    max_tokens_per_round: int = 4000
    total_tokens_used: int = 0

    @property
    def remaining_rounds(self) -> int:
        return max(0, self.max_tool_rounds - self.current_round)

    @property
    def is_exhausted(self) -> bool:
        return self.current_round >= self.max_tool_rounds

    def increment(self) -> None:
        self.current_round += 1

    def add_tokens(self, count: int) -> None:
        self.total_tokens_used += count


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
    metadata: dict[str, Any] = field(default_factory=dict)
