"""回合重试状态机。

管理 LLM 回合的重试逻辑和状态追踪：
  - 重试状态机（IDLE → RETRYING → RECOVERED / EXHAUSTED）
  - 可重试错误分类（网络/速率限制/上下文溢出/工具错误）
  - 自适应重试策略（根据错误类型调整延迟和次数）
  - 重试上下文保持（保留部分上下文用于恢复）
  - 降级策略（重试失败后降级到更小模型/更少工具）

与 retry_utils.py 的关系：
  - retry_utils.py 提供通用重试装饰器
  - TurnRetryState 提供 LLM 回合级别的重试状态机
  - 两者可组合使用

集成示例::

    from agent.core.turn_retry_state import TurnRetryState, RetryableError

    state = TurnRetryState()
    state.begin_turn()

    try:
        result = await call_llm(...)
    except RetryableError as e:
        action = state.record_error(e)
        if action == RetryAction.RETRY:
            continue
        elif action == RetryAction.DOWNGRADE:
            result = await call_llm(model="smaller_model", ...)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("turn_retry_state")


class RetryState(str, Enum):
    """重试状态。"""

    IDLE = "idle"
    RETRYING = "retrying"
    RECOVERED = "recovered"
    EXHAUSTED = "exhausted"
    DOWNGRADED = "downgraded"


class RetryAction(str, Enum):
    """重试动作。"""

    RETRY = "retry"
    DOWNGRADE = "downgrade"
    ABORT = "abort"
    SKIP = "skip"


class ErrorCategory(str, Enum):
    """错误分类。"""

    NETWORK = "network"
    RATE_LIMIT = "rate_limit"
    CONTEXT_OVERFLOW = "context_overflow"
    TOOL_ERROR = "tool_error"
    AUTH_ERROR = "auth_error"
    SERVER_ERROR = "server_error"
    UNKNOWN = "unknown"


ERROR_RETRY_CONFIG: dict[ErrorCategory, dict[str, Any]] = {
    ErrorCategory.NETWORK: {"max_retries": 3, "base_delay": 1.0, "backoff": 2.0},
    ErrorCategory.RATE_LIMIT: {"max_retries": 5, "base_delay": 5.0, "backoff": 1.5},
    ErrorCategory.CONTEXT_OVERFLOW: {"max_retries": 2, "base_delay": 0.0, "backoff": 1.0},
    ErrorCategory.TOOL_ERROR: {"max_retries": 2, "base_delay": 1.0, "backoff": 2.0},
    ErrorCategory.AUTH_ERROR: {"max_retries": 1, "base_delay": 0.0, "backoff": 1.0},
    ErrorCategory.SERVER_ERROR: {"max_retries": 3, "base_delay": 2.0, "backoff": 2.0},
    ErrorCategory.UNKNOWN: {"max_retries": 1, "base_delay": 1.0, "backoff": 1.0},
}


@dataclass
class RetryAttempt:
    """重试尝试记录。

    Attributes:
        attempt: 尝试次数。
        error_category: 错误分类。
        error_message: 错误信息。
        delay: 等待延迟。
        timestamp: 时间戳。
    """

    attempt: int = 0
    error_category: ErrorCategory = ErrorCategory.UNKNOWN
    error_message: str = ""
    delay: float = 0.0
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()


@dataclass
class RetryContext:
    """重试上下文。

    Attributes:
        turn_id: 回合 ID。
        original_model: 原始模型。
        current_model: 当前模型（降级后可能变化）。
        original_tools: 原始工具列表。
        current_tools: 当前工具列表。
        preserved_messages: 保留的消息上下文。
    """

    turn_id: str = ""
    original_model: str = ""
    current_model: str = ""
    original_tools: list[str] = field(default_factory=list)
    current_tools: list[str] = field(default_factory=list)
    preserved_messages: list[dict[str, Any]] = field(default_factory=list)


DOWNGRADE_CHAIN: dict[str, list[str]] = {
    "claude-3-opus": ["claude-3-sonnet", "claude-3-haiku"],
    "claude-3-sonnet": ["claude-3-haiku"],
    "gpt-4o": ["gpt-4o-mini"],
    "gpt-4-turbo": ["gpt-4o-mini"],
    "gemini-pro": ["gemini-flash"],
}


class RetryableError(Exception):
    """可重试错误。"""

    def __init__(self, message: str, category: ErrorCategory = ErrorCategory.UNKNOWN) -> None:
        super().__init__(message)
        self.category = category


class TurnRetryState:
    """回合重试状态机。

    管理 LLM 回合的重试逻辑和状态追踪。
    """

    def __init__(self) -> None:
        self._state = RetryState.IDLE
        self._attempts: list[RetryAttempt] = []
        self._context = RetryContext()
        self._total_retries: int = 0
        self._total_recoveries: int = 0
        self._total_exhaustions: int = 0

    @property
    def state(self) -> RetryState:
        return self._state

    @property
    def attempts(self) -> list[RetryAttempt]:
        return self._attempts

    @property
    def context(self) -> RetryContext:
        return self._context

    def record_attempt(self, success: bool) -> None:
        """记录一次重试尝试（兼容 conversation_loop 调用）。"""
        if success:
            self._state = RetryState.RECOVERED
        else:
            self._state = RetryState.RETRYING
            self._total_retries += 1

    def should_retry(self, _error: Exception) -> bool:
        """判断是否应重试（兼容 conversation_loop 调用）。"""
        return self._total_retries < 3

    def begin_turn(
        self,
        turn_id: str = "",
        model: str = "",
        tools: list[str] | None = None,
    ) -> None:
        """开始新回合。

        Args:
            turn_id: 回合 ID。
            model: 模型名称。
            tools: 工具列表。
        """
        self._state = RetryState.IDLE
        self._attempts = []
        self._context = RetryContext(
            turn_id=turn_id,
            original_model=model,
            current_model=model,
            original_tools=tools or [],
            current_tools=tools or [],
        )

    def record_error(
        self,
        error: Exception | RetryableError,
    ) -> RetryAction:
        """记录错误并决定重试动作。

        Args:
            error: 异常对象。

        Returns:
            RetryAction 重试动作。
        """
        if isinstance(error, RetryableError):
            category = error.category
        else:
            category = self._classify_error(error)

        config = ERROR_RETRY_CONFIG.get(category, ERROR_RETRY_CONFIG[ErrorCategory.UNKNOWN])
        attempt_num = len(self._attempts) + 1
        max_retries = config["max_retries"]

        delay = 0.0
        if attempt_num <= max_retries:
            delay = config["base_delay"] * (config["backoff"] ** (attempt_num - 1))

        attempt = RetryAttempt(
            attempt=attempt_num,
            error_category=category,
            error_message=str(error)[:200],
            delay=delay,
        )
        self._attempts.append(attempt)

        if category == ErrorCategory.CONTEXT_OVERFLOW:
            action = self._handle_context_overflow()
        elif attempt_num <= max_retries:
            self._state = RetryState.RETRYING
            self._total_retries += 1
            action = RetryAction.RETRY
        elif self._can_downgrade():
            self._state = RetryState.DOWNGRADED
            self._perform_downgrade()
            action = RetryAction.DOWNGRADE
        else:
            self._state = RetryState.EXHAUSTED
            self._total_exhaustions += 1
            action = RetryAction.ABORT

        log.info(
            "Error recorded",
            category=category.value,
            attempt=attempt_num,
            action=action.value,
            delay=round(delay, 3),
        )

        return action

    def mark_recovered(self) -> None:
        """标记已恢复。"""
        self._state = RetryState.RECOVERED
        self._total_recoveries += 1

    def get_retry_delay(self) -> float:
        """获取当前重试延迟。"""
        if self._attempts:
            return self._attempts[-1].delay
        return 0.0

    def get_stats(self) -> dict[str, Any]:
        """获取重试统计。"""
        return {
            "state": self._state.value,
            "total_retries": self._total_retries,
            "total_recoveries": self._total_recoveries,
            "total_exhaustions": self._total_exhaustions,
            "current_attempts": len(self._attempts),
            "by_category": self._count_by_category(),
        }

    def _classify_error(self, error: Exception) -> ErrorCategory:
        """分类错误。"""
        msg = str(error).lower()
        if any(k in msg for k in ["connection", "timeout", "network", "eof"]):
            return ErrorCategory.NETWORK
        if any(k in msg for k in ["rate", "429", "too many", "quota"]):
            return ErrorCategory.RATE_LIMIT
        if any(k in msg for k in ["context", "token", "length", "overflow", "max_tokens"]):
            return ErrorCategory.CONTEXT_OVERFLOW
        if any(k in msg for k in ["tool", "function", "execution"]):
            return ErrorCategory.TOOL_ERROR
        if any(k in msg for k in ["auth", "401", "403", "key", "credential"]):
            return ErrorCategory.AUTH_ERROR
        if any(k in msg for k in ["500", "502", "503", "server", "internal"]):
            return ErrorCategory.SERVER_ERROR
        return ErrorCategory.UNKNOWN

    def _handle_context_overflow(self) -> RetryAction:
        """处理上下文溢出。"""
        if self._context.preserved_messages:
            return RetryAction.RETRY
        if self._can_downgrade():
            self._state = RetryState.DOWNGRADED
            self._perform_downgrade()
            return RetryAction.DOWNGRADE
        return RetryAction.ABORT

    def _can_downgrade(self) -> bool:
        """是否可以降级模型。"""
        current = self._context.current_model
        chain = DOWNGRADE_CHAIN.get(current, [])
        return bool(chain)

    def _perform_downgrade(self) -> None:
        """执行模型降级。"""
        current = self._context.current_model
        chain = DOWNGRADE_CHAIN.get(current, [])
        if chain:
            self._context.current_model = chain[0]
            log.info("Model downgraded", from_model=current, to_model=chain[0])

    def _count_by_category(self) -> dict[str, int]:
        """按错误分类计数。"""
        counts: dict[str, int] = {}
        for a in self._attempts:
            cat = a.error_category.value
            counts[cat] = counts.get(cat, 0) + 1
        return counts
