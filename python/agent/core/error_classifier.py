"""统一错误分类器 — 通用 + LLM 专用。

将各类异常映射为语义化错误类别，便于上层进行针对性恢复
（重试 / 认证 / 降级 / 压缩上下文等），不依赖 LLM。

分类规则：
    - 429 → RATE_LIMIT, 重试, delay=60s
    - 401/403 → AUTH_FAILED, 不重试
    - TimeoutError → TIMEOUT, 重试, delay=5s
    - ConnectionError → NETWORK_ERROR, 重试, delay=10s
    - 400 → INVALID_REQUEST, 不重试
    - 500/502/503 → SERVER_ERROR, 重试, delay=30s
    - 包含"context" + "length"/"too long" → CONTEXT_TOO_LONG, 不重试
    - 包含"quota" → QUOTA_EXCEEDED, 不重试
    - litellm 特有异常 → 精细分类
    - 其他 → UNKNOWN, 可重试, delay=5s

UX 效果：
    - 用户看到中文友好提示而非原始异常堆栈
    - 主循环根据 is_retryable 自动重试或降级
    - RATE_LIMIT 触发智能退避（delay 随重试次数递增）

集成示例::

    from agent.core.error_classifier import ErrorClassifier, ErrorCategory

    classifier = ErrorClassifier()
    result = classifier.classify(some_exception)
    if result.is_retryable:
        await asyncio.sleep(result.retry_delay)
        await retry()
    else:
        yield {"type": "error", "content": result.user_message}

    # LLM 专用分类
    result = classifier.classify_llm_error(e, model="claude-3-opus")

    # 从 HTTP 状态码分类
    result = ErrorClassifier.from_status_code(429, "Too Many Requests")
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Any


class ErrorCategory(str, Enum):
    RATE_LIMIT = "rate_limit"
    AUTH_FAILED = "auth_failed"
    NETWORK_ERROR = "network_error"
    INVALID_REQUEST = "invalid_request"
    SERVER_ERROR = "server_error"
    CONTEXT_TOO_LONG = "context_too_long"
    MODEL_NOT_FOUND = "model_not_found"
    QUOTA_EXCEEDED = "quota_exceeded"
    TIMEOUT = "timeout"
    CONTENT_FILTERED = "content_filtered"
    STREAM_INTERRUPTED = "stream_interrupted"
    UNKNOWN = "unknown"


_RETRYABLE_CATEGORIES: set[ErrorCategory] = {
    ErrorCategory.RATE_LIMIT,
    ErrorCategory.NETWORK_ERROR,
    ErrorCategory.SERVER_ERROR,
    ErrorCategory.TIMEOUT,
    ErrorCategory.STREAM_INTERRUPTED,
    ErrorCategory.UNKNOWN,
}

_RETRY_DELAYS: dict[ErrorCategory, float] = {
    ErrorCategory.RATE_LIMIT: 60.0,
    ErrorCategory.NETWORK_ERROR: 10.0,
    ErrorCategory.SERVER_ERROR: 30.0,
    ErrorCategory.TIMEOUT: 5.0,
    ErrorCategory.STREAM_INTERRUPTED: 3.0,
    ErrorCategory.UNKNOWN: 5.0,
    ErrorCategory.AUTH_FAILED: 0.0,
    ErrorCategory.INVALID_REQUEST: 0.0,
    ErrorCategory.CONTEXT_TOO_LONG: 0.0,
    ErrorCategory.MODEL_NOT_FOUND: 0.0,
    ErrorCategory.QUOTA_EXCEEDED: 0.0,
    ErrorCategory.CONTENT_FILTERED: 0.0,
}

_SUGGESTED_ACTIONS: dict[ErrorCategory, str] = {
    ErrorCategory.RATE_LIMIT: "等待后重试，或降低请求频率",
    ErrorCategory.AUTH_FAILED: "检查 API 凭据是否有效",
    ErrorCategory.NETWORK_ERROR: "检查网络连接后重试",
    ErrorCategory.INVALID_REQUEST: "检查请求参数是否正确",
    ErrorCategory.SERVER_ERROR: "等待后重试，或切换到备用服务",
    ErrorCategory.CONTEXT_TOO_LONG: "压缩上下文或减少输入长度",
    ErrorCategory.MODEL_NOT_FOUND: "切换到可用的模型",
    ErrorCategory.QUOTA_EXCEEDED: "等待配额重置或升级套餐",
    ErrorCategory.TIMEOUT: "增加超时时间或重试",
    ErrorCategory.CONTENT_FILTERED: "修改输入内容，避免触发安全过滤",
    ErrorCategory.STREAM_INTERRUPTED: "重新发起请求",
    ErrorCategory.UNKNOWN: "查看错误详情并手动处理",
}

_USER_MESSAGES: dict[ErrorCategory, str] = {
    ErrorCategory.RATE_LIMIT: "请求过于频繁，请稍后再试",
    ErrorCategory.AUTH_FAILED: "认证失败，请检查配置",
    ErrorCategory.NETWORK_ERROR: "网络连接异常，请检查网络后重试",
    ErrorCategory.INVALID_REQUEST: "请求参数有误，请调整后重试",
    ErrorCategory.SERVER_ERROR: "服务暂时不可用，请稍后重试",
    ErrorCategory.CONTEXT_TOO_LONG: "输入内容过长，请精简后重试",
    ErrorCategory.MODEL_NOT_FOUND: "当前模型不可用，请切换模型",
    ErrorCategory.QUOTA_EXCEEDED: "使用配额已用尽，请稍后或升级套餐",
    ErrorCategory.TIMEOUT: "请求超时，请稍后重试",
    ErrorCategory.CONTENT_FILTERED: "内容被安全过滤拦截，请修改输入",
    ErrorCategory.STREAM_INTERRUPTED: "响应流中断，请重新提问",
    ErrorCategory.UNKNOWN: "发生未知错误，请稍后重试",
}

_STATUS_CODE_MAP: dict[int, ErrorCategory] = {
    400: ErrorCategory.INVALID_REQUEST,
    401: ErrorCategory.AUTH_FAILED,
    403: ErrorCategory.AUTH_FAILED,
    404: ErrorCategory.MODEL_NOT_FOUND,
    429: ErrorCategory.RATE_LIMIT,
    500: ErrorCategory.SERVER_ERROR,
    502: ErrorCategory.SERVER_ERROR,
    503: ErrorCategory.SERVER_ERROR,
    504: ErrorCategory.SERVER_ERROR,
}

_MESSAGE_PATTERNS: list[tuple[str, ErrorCategory]] = [
    (r"context.*(?:length|too.?long|exceed)", ErrorCategory.CONTEXT_TOO_LONG),
    (r"(?:too.?many|exceed).*token", ErrorCategory.CONTEXT_TOO_LONG),
    (r"max.*token", ErrorCategory.CONTEXT_TOO_LONG),
    (r"quota", ErrorCategory.QUOTA_EXCEEDED),
    (r"rate.?limit|too.?many.?request", ErrorCategory.RATE_LIMIT),
    (r"timeout|timed.?out", ErrorCategory.TIMEOUT),
    (r"connection(?:error|refused|reset)", ErrorCategory.NETWORK_ERROR),
    (r"network|unreachable|dns", ErrorCategory.NETWORK_ERROR),
    (r"model.*not.*found|model.*unavailable", ErrorCategory.MODEL_NOT_FOUND),
    (r"content.*filter|safety|refused.*policy", ErrorCategory.CONTENT_FILTERED),
    (r"stream.*interrupt|stream.*abort|partial.*response", ErrorCategory.STREAM_INTERRUPTED),
]

_LLM_MESSAGE_PATTERNS: list[tuple[str, ErrorCategory]] = [
    (r"overloaded|capacity|overload", ErrorCategory.SERVER_ERROR),
    (r"api.?key|invalid.*key|unauthorized", ErrorCategory.AUTH_FAILED),
    (r"context.window|context.length|token.limit", ErrorCategory.CONTEXT_TOO_LONG),
    (r"content.policy|safety.filter|refused", ErrorCategory.CONTENT_FILTERED),
    (r"stream.*error|chunk.*error|partial.*message", ErrorCategory.STREAM_INTERRUPTED),
    (r"model.*overloaded|model.*busy", ErrorCategory.RATE_LIMIT),
    (r"billing|payment|subscription|quota", ErrorCategory.QUOTA_EXCEEDED),
]


@dataclass
class ClassifiedError:
    category: ErrorCategory
    original_error: Exception
    is_retryable: bool
    suggested_action: str
    retry_delay: float
    user_message: str = ""

    def __post_init__(self) -> None:
        if not self.user_message:
            self.user_message = _USER_MESSAGES.get(self.category, _USER_MESSAGES[ErrorCategory.UNKNOWN])


class ErrorClassifier:
    """统一错误分类器 — 通用 + LLM 专用。

    分类优先级：
        1. 异常类型（TimeoutError、ConnectionError、litellm 异常等）。
        2. HTTP 状态码（从异常属性提取）。
        3. LLM 消息模式匹配（litellm/Anthropic/OpenAI 特有模式）。
        4. 通用消息模式匹配。
        5. 兜底为 UNKNOWN。
    """

    def classify(self, error: Exception) -> ClassifiedError:
        category = self._classify_by_type(error)

        status_code = self._extract_status_code(error)
        if status_code is not None:
            status_cat = _STATUS_CODE_MAP.get(status_code)
            if status_cat is not None:
                category = status_cat

        message = str(error)
        if category == ErrorCategory.UNKNOWN:
            for pattern, cat in _LLM_MESSAGE_PATTERNS:
                if re.search(pattern, message, re.IGNORECASE):
                    category = cat
                    break

        if category not in _RETRYABLE_CATEGORIES or category == ErrorCategory.UNKNOWN:
            for pattern, cat in _MESSAGE_PATTERNS:
                if re.search(pattern, message, re.IGNORECASE):
                    category = cat
                    break

        is_retryable = category in _RETRYABLE_CATEGORIES
        retry_delay = _RETRY_DELAYS.get(category, 5.0)
        suggested_action = _SUGGESTED_ACTIONS.get(category, "")
        user_message = _USER_MESSAGES.get(category, _USER_MESSAGES[ErrorCategory.UNKNOWN])

        return ClassifiedError(
            category=category,
            original_error=error,
            is_retryable=is_retryable,
            suggested_action=suggested_action,
            retry_delay=retry_delay,
            user_message=user_message,
        )

    def classify_llm_error(
        self,
        error: Exception,
        model: str | None = None,
        attempt: int = 0,
    ) -> ClassifiedError:
        result = self.classify(error)

        if result.category == ErrorCategory.RATE_LIMIT:
            result.retry_delay = min(60.0 * (2 ** attempt), 300.0)

        if result.category == ErrorCategory.MODEL_NOT_FOUND and model:
            result.user_message = f"模型 {model} 暂时不可用，请切换模型"

        if result.category == ErrorCategory.CONTEXT_TOO_LONG:
            result.suggested_action = "压缩上下文或减少输入长度，也可尝试支持更长上下文的模型"

        return result

    @classmethod
    def from_status_code(cls, status_code: int, message: str = "") -> ClassifiedError:
        category = _STATUS_CODE_MAP.get(status_code, ErrorCategory.UNKNOWN)

        if message:
            for pattern, cat in _LLM_MESSAGE_PATTERNS:
                if re.search(pattern, message, re.IGNORECASE):
                    category = cat
                    break
            if category == ErrorCategory.UNKNOWN:
                for pattern, cat in _MESSAGE_PATTERNS:
                    if re.search(pattern, message, re.IGNORECASE):
                        category = cat
                        break

        is_retryable = category in _RETRYABLE_CATEGORIES
        retry_delay = _RETRY_DELAYS.get(category, 5.0)
        suggested_action = _SUGGESTED_ACTIONS.get(category, "")
        user_message = _USER_MESSAGES.get(category, _USER_MESSAGES[ErrorCategory.UNKNOWN])

        placeholder_error = Exception(f"HTTP {status_code}: {message}")

        return ClassifiedError(
            category=category,
            original_error=placeholder_error,
            is_retryable=is_retryable,
            suggested_action=suggested_action,
            retry_delay=retry_delay,
            user_message=user_message,
        )

    def is_retryable(self, category: ErrorCategory) -> bool:
        return category in _RETRYABLE_CATEGORIES

    def get_retry_delay(self, category: ErrorCategory) -> float:
        return _RETRY_DELAYS.get(category, 5.0)

    @staticmethod
    def _classify_by_type(error: Exception) -> ErrorCategory:
        error_type = type(error)

        if issubclass(error_type, TimeoutError):
            return ErrorCategory.TIMEOUT

        if issubclass(error_type, ConnectionError):
            return ErrorCategory.NETWORK_ERROR

        if issubclass(error_type, OSError):
            error_name = error_type.__name__.lower()
            if "connect" in error_name or "network" in error_name:
                return ErrorCategory.NETWORK_ERROR
            return ErrorCategory.UNKNOWN

        error_name = error_type.__name__
        error_module = getattr(error_type, "__module__", "")
        if "litellm" in error_module:
            name_lower = error_name.lower()
            if "ratelimit" in name_lower or "rate" in name_lower:
                return ErrorCategory.RATE_LIMIT
            if "auth" in name_lower or "authentication" in name_lower:
                return ErrorCategory.AUTH_FAILED
            if "context" in name_lower or "token" in name_lower:
                return ErrorCategory.CONTEXT_TOO_LONG
            if "timeout" in name_lower:
                return ErrorCategory.TIMEOUT
            if "model" in name_lower or "notfound" in name_lower:
                return ErrorCategory.MODEL_NOT_FOUND
            if "content" in name_lower or "policy" in name_lower or "safety" in name_lower:
                return ErrorCategory.CONTENT_FILTERED
            if "api" in name_lower and "connection" in name_lower:
                return ErrorCategory.NETWORK_ERROR

        if "httpx" in error_module:
            name_lower = error_name.lower()
            if "connect" in name_lower:
                return ErrorCategory.NETWORK_ERROR
            if "timeout" in name_lower:
                return ErrorCategory.TIMEOUT
            if "status" in name_lower:
                return ErrorCategory.SERVER_ERROR

        return ErrorCategory.UNKNOWN

    @staticmethod
    def _extract_status_code(error: Exception) -> int | None:
        status = getattr(error, "status_code", None)
        if isinstance(status, int):
            return status

        response = getattr(error, "response", None)
        if response is not None:
            resp_status = getattr(response, "status_code", None)
            if isinstance(resp_status, int):
                return resp_status

        code = getattr(error, "code", None)
        if isinstance(code, int):
            return code

        return None
