"""
鲁棒性模块 - 第一阶段：基础鲁棒性

提供错误分类、重试策略、工具降级、效果监控等基础鲁棒性功能。
支持降级开关 ENABLE_ROBUSTNESS，出问题可快速回退。

设计原则：
- 增量式改造，不破坏现有功能
- 为后续阶段（认知增强、自进化、效率优化）预留接口
- 生产级代码质量，完善的类型注解和错误处理
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from agent.core.logger import StructuredLogger

log = StructuredLogger("robustness")


# ============================================================================
# 错误类型定义
# ============================================================================

class ErrorType:
    """错误类型枚举。

    每种错误类型对应不同的恢复策略。
    """
    # 可重试的瞬时错误
    RETRYABLE = "retryable"
    # 速率限制（429）
    RATE_LIMITED = "rate_limited"
    # 服务过载（503）
    OVERLOADED = "overloaded"
    # 网络错误
    NETWORK_ERROR = "network_error"
    # 超时错误
    TIMEOUT = "timeout"

    # 不可重试的错误
    NON_RETRYABLE = "non_retryable"
    # 参数错误
    PARAM_ERROR = "param_error"
    # 工具不可用
    TOOL_UNAVAILABLE = "tool_unavailable"
    # 权限错误
    PERMISSION_ERROR = "permission_error"
    # 资源不存在
    NOT_FOUND = "not_found"
    # 语法错误
    SYNTAX_ERROR = "syntax_error"

    # 特殊处理的错误
    CONTEXT_OVERFLOW = "context_overflow"
    CONTENT_POLICY = "content_policy"
    BILLING_ERROR = "billing_error"
    MODEL_NOT_FOUND = "model_not_found"

    # 未知错误
    UNKNOWN = "unknown"


# 可重试的错误类型集合
RETRYABLE_ERROR_TYPES = {
    ErrorType.RETRYABLE,
    ErrorType.RATE_LIMITED,
    ErrorType.OVERLOADED,
    ErrorType.NETWORK_ERROR,
    ErrorType.TIMEOUT,
}


# ============================================================================
# 错误分类器
# ============================================================================

class ErrorClassifier:
    """错误分类器。

    基于规则的错误分类，将错误信息映射到对应的错误类型。
    为后续的重试策略和工具降级提供依据。

    设计为可扩展的，后续可以添加LLM辅助分类。
    """

    # 错误分类规则：(正则模式, 错误类型)
    _CLASSIFICATION_RULES: list[tuple[re.Pattern[str], str]] = [
        # 速率限制
        (re.compile(r"rate.?limit|429|too many requests", re.I), ErrorType.RATE_LIMITED),
        # 服务过载
        (re.compile(r"overload|503|service unavailable|busy", re.I), ErrorType.OVERLOADED),
        # 网络错误
        (re.compile(r"network|econnrefused|connection|dns|socket", re.I), ErrorType.NETWORK_ERROR),
        # 超时错误
        (re.compile(r"timeout|timed out|etimedout", re.I), ErrorType.TIMEOUT),
        # 参数错误
        (re.compile(r"invalid.*param|param.*invalid|bad request|400|validation", re.I), ErrorType.PARAM_ERROR),
        # 权限错误
        (re.compile(r"permission|eacces|eperm|403|forbidden|denied", re.I), ErrorType.PERMISSION_ERROR),
        # 资源不存在
        (re.compile(r"not found|enoent|404|不存在|找不到", re.I), ErrorType.NOT_FOUND),
        # 语法错误
        (re.compile(r"syntax|parse|语法|解析", re.I), ErrorType.SYNTAX_ERROR),
        # 上下文溢出
        (re.compile(r"context.*length|token.*limit|max.*tokens|context.*overflow", re.I), ErrorType.CONTEXT_OVERFLOW),
        # 内容策略
        (re.compile(r"content.*policy|safety|moderation", re.I), ErrorType.CONTENT_POLICY),
        # 计费错误
        (re.compile(r"billing|quota|insufficient|balance", re.I), ErrorType.BILLING_ERROR),
        # 模型未找到
        (re.compile(r"model.*not found|model.*does not exist", re.I), ErrorType.MODEL_NOT_FOUND),
    ]

    def __init__(self) -> None:
        self._custom_rules: list[tuple[re.Pattern[str], str]] = []

    def add_rule(self, pattern: str, error_type: str) -> None:
        """添加自定义分类规则。

        Args:
            pattern: 正则表达式模式
            error_type: 对应的错误类型
        """
        try:
            compiled = re.compile(pattern, re.I)
            self._custom_rules.append((compiled, error_type))
        except re.error as e:
            log.warning("Invalid regex pattern for error classification", pattern=pattern, error=str(e))

    def classify(self, error: str, tool_name: str | None = None) -> str:
        """分类错误类型。

        Args:
            error: 错误信息
            tool_name: 工具名称（可选，用于特定工具的错误分类）

        Returns:
            错误类型字符串
        """
        if not error:
            return ErrorType.UNKNOWN

        error_lower = error.lower()

        # 先检查自定义规则
        for pattern, error_type in self._custom_rules:
            if pattern.search(error):
                log.debug("Error matched custom rule", error=error[:50], error_type=error_type)
                return error_type

        # 再检查内置规则
        for pattern, error_type in self._CLASSIFICATION_RULES:
            if pattern.search(error):
                log.debug("Error classified", error=error[:50], error_type=error_type)
                return error_type

        # 默认归类为可重试的未知错误（保守策略，尽量重试）
        log.debug("Error classified as unknown (retryable by default)", error=error[:50])
        return ErrorType.RETRYABLE

    def is_retryable(self, error_type: str) -> bool:
        """判断错误类型是否可重试。

        Args:
            error_type: 错误类型

        Returns:
            是否可重试
        """
        return error_type in RETRYABLE_ERROR_TYPES


# ============================================================================
# 重试策略
# ============================================================================

@dataclass
class RetryConfig:
    """重试配置。"""
    # 最大重试次数
    max_retries: int = 3
    # 初始退避时间（毫秒）
    initial_backoff_ms: float = 100.0
    # 退避乘数（指数退避）
    backoff_multiplier: float = 2.0
    # 最大退避时间（毫秒）
    max_backoff_ms: float = 5000.0
    # 是否添加随机抖动
    enable_jitter: bool = True
    # 速率限制的额外退避倍数
    rate_limit_backoff_multiplier: float = 3.0


@dataclass
class RetryAttempt:
    """单次重试尝试的信息。"""
    attempt: int
    error_type: str
    error_message: str
    backoff_ms: float
    timestamp: float = field(default_factory=time.time)


class RetryStrategy:
    """重试策略 - 指数退避 + 抖动。

    实现了标准的指数退避算法，并支持：
    - 不同错误类型的差异化退避策略
    - 随机抖动避免惊群效应
    - 可配置的重试参数
    """

    def __init__(self, config: RetryConfig | None = None) -> None:
        self._config = config or RetryConfig()
        self._attempts: list[RetryAttempt] = []

    @property
    def attempts(self) -> list[RetryAttempt]:
        """获取所有重试尝试记录。"""
        return list(self._attempts)

    @property
    def attempt_count(self) -> int:
        """获取当前重试次数。"""
        return len(self._attempts)

    def should_retry(self, error_type: str) -> bool:
        """判断是否应该重试。

        Args:
            error_type: 错误类型

        Returns:
            是否应该重试
        """
        # 超过最大重试次数则不再重试
        if self.attempt_count >= self._config.max_retries:
            return False

        # 根据错误类型判断是否可重试
        classifier = ErrorClassifier()
        return classifier.is_retryable(error_type)

    def get_backoff_ms(self, error_type: str) -> float:
        """计算下一次重试的退避时间。

        Args:
            error_type: 错误类型

        Returns:
            退避时间（毫秒）
        """
        attempt = len(self._attempts)

        # 基础指数退避
        backoff = self._config.initial_backoff_ms * (self._config.backoff_multiplier ** attempt)

        # 速率限制错误增加额外退避
        if error_type == ErrorType.RATE_LIMITED:
            backoff *= self._config.rate_limit_backoff_multiplier

        # 限制最大退避时间
        backoff = min(backoff, self._config.max_backoff_ms)

        # 添加随机抖动（±20%）
        if self._config.enable_jitter:
            jitter_factor = 0.8 + 0.4 * (hash(time.time()) % 1000) / 1000.0
            backoff *= jitter_factor

        return backoff

    def record_attempt(self, error_type: str, error_message: str) -> None:
        """记录一次重试尝试。

        Args:
            error_type: 错误类型
            error_message: 错误信息
        """
        backoff = self.get_backoff_ms(error_type)
        attempt = RetryAttempt(
            attempt=len(self._attempts) + 1,
            error_type=error_type,
            error_message=error_message,
            backoff_ms=backoff,
        )
        self._attempts.append(attempt)

        log.info(
            "Retry attempt recorded",
            attempt=attempt.attempt,
            error_type=error_type,
            backoff_ms=f"{backoff:.0f}ms",
        )

    def reset(self) -> None:
        """重置重试状态。"""
        self._attempts.clear()


# ============================================================================
# 工具降级映射
# ============================================================================

@dataclass
class ToolAlternative:
    """工具替代方案。"""
    tool: str
    arg_transform: Callable[[dict[str, Any]], dict[str, Any]]
    reason: str


class ToolAlternatives:
    """工具降级映射表。

    当主工具失败时，按顺序尝试替代工具。
    设计为可扩展的，支持动态添加替代方案。
    """

    def __init__(self) -> None:
        self._alternatives: dict[str, list[ToolAlternative]] = {}
        self._init_default_alternatives()

    def _init_default_alternatives(self) -> None:
        """初始化默认的工具替代方案。"""
        # file_read 的降级方案
        self.add_alternative(
            "file_read",
            "file_search",
            lambda args: {"pattern": args.get("path", args.get("pattern", "*"))},
            "file_read 失败，降级为 file_search 查找相似路径",
        )
        self.add_alternative(
            "file_read",
            "shell_exec",
            lambda args: {"command": f"cat {args.get('path', '')}"},
            "file_read 失败，降级为 shell_exec cat 读取文件",
        )

        # web_fetch 的降级方案
        self.add_alternative(
            "web_fetch",
            "web_search",
            lambda args: {"query": args.get("url", args.get("query", ""))},
            "web_fetch 失败，降级为 web_search 搜索相关内容",
        )

        # grep 的降级方案
        self.add_alternative(
            "grep",
            "shell_exec",
            lambda args: {"command": f"grep -r \"{args.get('pattern', '')}\" {args.get('path', '.')}"},
            "grep 失败，降级为 shell_exec grep",
        )

        # file_write 的降级方案
        self.add_alternative(
            "file_write",
            "shell_exec",
            lambda args: {"command": f"echo \"{args.get('content', '')}\" > {args.get('path', '')}"},
            "file_write 失败，降级为 shell_exec echo 重定向",
        )

        # list_directory 的降级方案
        self.add_alternative(
            "list_directory",
            "shell_exec",
            lambda args: {"command": f"ls -la {args.get('path', '.')}"},
            "list_directory 失败，降级为 shell_exec ls",
        )

        # execute_code 的降级方案
        self.add_alternative(
            "execute_code",
            "shell_exec",
            lambda args: {"command": args.get("code", args.get("command", ""))},
            "execute_code 失败，降级为 shell_exec 直接执行",
        )

        # web_search 的降级方案
        self.add_alternative(
            "web_search",
            "web_fetch",
            lambda args: {"url": f"https://www.google.com/search?q={__import__('urllib.parse').parse.quote(str(args.get('query', '')))}"},
            "web_search 失败，降级为 web_fetch 直接抓取搜索结果",
        )

        # shell_exec 的降级方案
        self.add_alternative(
            "shell_exec",
            "execute_code",
            lambda args: {"code": args.get("command", ""), "language": "bash"},
            "shell_exec 失败，降级为 execute_code 执行",
        )

    def add_alternative(
        self,
        original_tool: str,
        alternative_tool: str,
        arg_transform: Callable[[dict[str, Any]], dict[str, Any]],
        reason: str,
    ) -> None:
        """添加工具替代方案。

        Args:
            original_tool: 原始工具名称
            alternative_tool: 替代工具名称
            arg_transform: 参数转换函数
            reason: 降级原因说明
        """
        if original_tool not in self._alternatives:
            self._alternatives[original_tool] = []

        self._alternatives[original_tool].append(
            ToolAlternative(
                tool=alternative_tool,
                arg_transform=arg_transform,
                reason=reason,
            )
        )

        log.debug(
            "Added tool alternative",
            original=original_tool,
            alternative=alternative_tool,
        )

    def get_alternatives(self, tool_name: str) -> list[ToolAlternative]:
        """获取工具的所有替代方案。

        Args:
            tool_name: 工具名称

        Returns:
            替代方案列表（按优先级排序）
        """
        return list(self._alternatives.get(tool_name, []))

    def has_alternatives(self, tool_name: str) -> bool:
        """检查工具是否有替代方案。

        Args:
            tool_name: 工具名称

        Returns:
            是否有替代方案
        """
        return tool_name in self._alternatives and len(self._alternatives[tool_name]) > 0


# ============================================================================
# 鲁棒性配置
# ============================================================================

@dataclass
class RobustnessConfig:
    """鲁棒性配置。

    所有鲁棒性功能的统一配置入口。
    支持通过环境变量 ENABLE_ROBUSTNESS 进行全局开关控制。
    """

    # 全局开关
    enabled: bool = True

    # 错误分类器配置
    enable_error_classification: bool = True

    # 重试策略配置
    enable_retry: bool = True
    retry_config: RetryConfig = field(default_factory=RetryConfig)

    # 工具降级配置
    enable_tool_fallback: bool = True

    # 反思配置
    enable_reflection: bool = True
    max_reflection_retries: int = 3

    # 监控配置
    enable_metrics: bool = True

    @classmethod
    def from_env(cls) -> "RobustnessConfig":
        """从环境变量创建配置。

        Returns:
            鲁棒性配置实例
        """
        enabled = os.environ.get("ENABLE_ROBUSTNESS", "true").lower() == "true"

        config = cls(enabled=enabled)

        # 重试配置
        config.retry_config.max_retries = int(os.environ.get("ROBUSTNESS_MAX_RETRIES", "3"))
        config.retry_config.initial_backoff_ms = float(
            os.environ.get("ROBUSTNESS_INITIAL_BACKOFF_MS", "100")
        )
        config.retry_config.backoff_multiplier = float(
            os.environ.get("ROBUSTNESS_BACKOFF_MULTIPLIER", "2.0")
        )
        config.retry_config.max_backoff_ms = float(
            os.environ.get("ROBUSTNESS_MAX_BACKOFF_MS", "5000")
        )

        # 反思配置
        config.max_reflection_retries = int(
            os.environ.get("ROBUSTNESS_MAX_REFLECTION_RETRIES", "3")
        )

        log.info(
            "Robustness config loaded from environment",
            enabled=enabled,
            max_retries=config.retry_config.max_retries,
            max_reflection_retries=config.max_reflection_retries,
        )

        return config


# ============================================================================
# 鲁棒性效果监控
# ============================================================================

@dataclass
class RobustnessMetrics:
    """鲁棒性效果监控指标。

    记录和统计鲁棒性功能的效果，用于量化评估和后续优化。
    """

    # 工具调用统计
    total_tool_calls: int = 0
    successful_tool_calls: int = 0
    failed_tool_calls: int = 0

    # 重试统计
    total_retries: int = 0
    retry_successes: int = 0
    retry_failures: int = 0
    avg_retries_per_task: float = 0.0

    # 错误类型分布
    error_type_distribution: dict[str, int] = field(default_factory=dict)

    # 工具降级统计
    total_fallbacks: int = 0
    fallback_successes: int = 0

    # 反思统计
    total_reflections: int = 0
    reflection_successes: int = 0

    # 性能统计
    avg_tool_duration_ms: float = 0.0
    avg_retry_duration_ms: float = 0.0

    # 时间窗口
    _window_start: float = field(default_factory=time.time)
    _duration_sum_ms: float = 0.0
    _retry_duration_sum_ms: float = 0.0

    def record_tool_call(self, success: bool, duration_ms: float, error_type: str | None = None) -> None:
        """记录一次工具调用。

        Args:
            success: 是否成功
            duration_ms: 耗时（毫秒）
            error_type: 错误类型（失败时）
        """
        self.total_tool_calls += 1
        self._duration_sum_ms += duration_ms
        self.avg_tool_duration_ms = self._duration_sum_ms / self.total_tool_calls

        if success:
            self.successful_tool_calls += 1
        else:
            self.failed_tool_calls += 1
            if error_type:
                self.error_type_distribution[error_type] = (
                    self.error_type_distribution.get(error_type, 0) + 1
                )

    def record_retry(self, success: bool, duration_ms: float) -> None:
        """记录一次重试。

        Args:
            success: 重试是否成功
            duration_ms: 重试耗时（毫秒）
        """
        self.total_retries += 1
        self._retry_duration_sum_ms += duration_ms
        self.avg_retry_duration_ms = (
            self._retry_duration_sum_ms / self.total_retries
            if self.total_retries > 0
            else 0.0
        )

        if success:
            self.retry_successes += 1
        else:
            self.retry_failures += 1

    def record_fallback(self, success: bool) -> None:
        """记录一次工具降级。

        Args:
            success: 降级是否成功
        """
        self.total_fallbacks += 1
        if success:
            self.fallback_successes += 1

    def record_reflection(self, success: bool) -> None:
        """记录一次反思。

        Args:
            success: 反思是否成功修复问题
        """
        self.total_reflections += 1
        if success:
            self.reflection_successes += 1

    @property
    def success_rate(self) -> float:
        """工具调用成功率。"""
        if self.total_tool_calls == 0:
            return 1.0
        return self.successful_tool_calls / self.total_tool_calls

    @property
    def retry_success_rate(self) -> float:
        """重试成功率。"""
        if self.total_retries == 0:
            return 0.0
        return self.retry_successes / self.total_retries

    @property
    def fallback_success_rate(self) -> float:
        """工具降级成功率。"""
        if self.total_fallbacks == 0:
            return 0.0
        return self.fallback_successes / self.total_fallbacks

    @property
    def reflection_success_rate(self) -> float:
        """反思成功率。"""
        if self.total_reflections == 0:
            return 0.0
        return self.reflection_successes / self.total_reflections

    def get_summary(self) -> dict[str, Any]:
        """获取监控指标摘要。

        Returns:
            指标摘要字典
        """
        return {
            "total_tool_calls": self.total_tool_calls,
            "successful_tool_calls": self.successful_tool_calls,
            "failed_tool_calls": self.failed_tool_calls,
            "success_rate": f"{self.success_rate:.2%}",
            "total_retries": self.total_retries,
            "retry_successes": self.retry_successes,
            "retry_success_rate": f"{self.retry_success_rate:.2%}",
            "total_fallbacks": self.total_fallbacks,
            "fallback_success_rate": f"{self.fallback_success_rate:.2%}",
            "total_reflections": self.total_reflections,
            "reflection_success_rate": f"{self.reflection_success_rate:.2%}",
            "avg_tool_duration_ms": f"{self.avg_tool_duration_ms:.0f}ms",
            "error_type_distribution": dict(self.error_type_distribution),
        }

    def reset(self) -> None:
        """重置所有指标。"""
        self.total_tool_calls = 0
        self.successful_tool_calls = 0
        self.failed_tool_calls = 0
        self.total_retries = 0
        self.retry_successes = 0
        self.retry_failures = 0
        self.avg_retries_per_task = 0.0
        self.error_type_distribution.clear()
        self.total_fallbacks = 0
        self.fallback_successes = 0
        self.total_reflections = 0
        self.reflection_successes = 0
        self.avg_tool_duration_ms = 0.0
        self.avg_retry_duration_ms = 0.0
        self._window_start = time.time()
        self._duration_sum_ms = 0.0
        self._retry_duration_sum_ms = 0.0


# ============================================================================
# 鲁棒性管理器 - 统一入口
# ============================================================================

class RobustnessManager:
    """鲁棒性管理器 - 统一入口。

    整合错误分类、重试策略、工具降级、效果监控等功能，
    提供简洁的接口供执行器调用。

    设计原则：
    - 单一入口，便于使用和维护
    - 支持降级开关，出问题可快速回退
    - 为后续阶段预留扩展接口
    """

    _instance: "RobustnessManager" | None = None

    def __init__(self, config: RobustnessConfig | None = None) -> None:
        self._config = config or RobustnessConfig.from_env()

        # 组件
        self._error_classifier = ErrorClassifier()
        self._tool_alternatives = ToolAlternatives()
        self._metrics = RobustnessMetrics()

        # 每个任务的重试策略（按 trace_id 区分）
        self._retry_strategies: dict[str, RetryStrategy] = {}

        log.info(
            "Robustness manager initialized",
            enabled=self._config.enabled,
        )

    @classmethod
    def get_instance(cls) -> "RobustnessManager":
        """获取单例实例。"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """重置单例实例（用于测试）。"""
        cls._instance = None

    @property
    def enabled(self) -> bool:
        """鲁棒性功能是否启用。"""
        return self._config.enabled

    @property
    def config(self) -> RobustnessConfig:
        """获取配置。"""
        return self._config

    @property
    def metrics(self) -> RobustnessMetrics:
        """获取监控指标。"""
        return self._metrics

    @property
    def error_classifier(self) -> ErrorClassifier:
        """获取错误分类器。"""
        return self._error_classifier

    @property
    def tool_alternatives(self) -> ToolAlternatives:
        """获取工具降级映射。"""
        return self._tool_alternatives

    def get_retry_strategy(self, trace_id: str) -> RetryStrategy:
        """获取指定任务的重试策略。

        Args:
            trace_id: 任务追踪ID

        Returns:
            重试策略实例
        """
        if trace_id not in self._retry_strategies:
            self._retry_strategies[trace_id] = RetryStrategy(self._config.retry_config)
        return self._retry_strategies[trace_id]

    def cleanup_retry_strategy(self, trace_id: str) -> None:
        """清理指定任务的重试策略。

        Args:
            trace_id: 任务追踪ID
        """
        if trace_id in self._retry_strategies:
            del self._retry_strategies[trace_id]

    def classify_error(self, error: str, tool_name: str | None = None) -> str:
        """分类错误类型（便捷方法）。

        Args:
            error: 错误信息
            tool_name: 工具名称

        Returns:
            错误类型
        """
        if not self._config.enabled or not self._config.enable_error_classification:
            # 降级时默认返回可重试类型（保守策略）
            return ErrorType.RETRYABLE

        return self._error_classifier.classify(error, tool_name)

    def should_retry_tool(
        self,
        trace_id: str,
        error: str,
        tool_name: str | None = None,
    ) -> tuple[bool, str, float]:
        """判断工具是否应该重试，并返回退避时间。

        Args:
            trace_id: 任务追踪ID
            error: 错误信息
            tool_name: 工具名称

        Returns:
            (是否重试, 错误类型, 退避时间毫秒)
        """
        if not self._config.enabled or not self._config.enable_retry:
            return False, ErrorType.UNKNOWN, 0.0

        error_type = self.classify_error(error, tool_name)
        retry_strategy = self.get_retry_strategy(trace_id)

        if not retry_strategy.should_retry(error_type):
            return False, error_type, 0.0

        backoff_ms = retry_strategy.get_backoff_ms(error_type)
        return True, error_type, backoff_ms

    def record_retry_attempt(
        self,
        trace_id: str,
        error: str,
        tool_name: str | None = None,
    ) -> None:
        """记录一次重试尝试。

        Args:
            trace_id: 任务追踪ID
            error: 错误信息
            tool_name: 工具名称
        """
        if not self._config.enabled:
            return

        error_type = self.classify_error(error, tool_name)
        retry_strategy = self.get_retry_strategy(trace_id)
        retry_strategy.record_attempt(error_type, error)

        # 记录到监控指标
        self._metrics.record_tool_call(False, 0.0, error_type)

    def get_tool_alternatives(self, tool_name: str) -> list[ToolAlternative]:
        """获取工具的替代方案（便捷方法）。

        Args:
            tool_name: 工具名称

        Returns:
            替代方案列表
        """
        if not self._config.enabled or not self._config.enable_tool_fallback:
            return []

        return self._tool_alternatives.get_alternatives(tool_name)

    def has_tool_alternatives(self, tool_name: str) -> bool:
        """检查工具是否有替代方案（便捷方法）。

        Args:
            tool_name: 工具名称

        Returns:
            是否有替代方案
        """
        if not self._config.enabled or not self._config.enable_tool_fallback:
            return False

        return self._tool_alternatives.has_alternatives(tool_name)

    def get_metrics_summary(self) -> dict[str, Any]:
        """获取监控指标摘要（便捷方法）。

        Returns:
            指标摘要字典
        """
        return self._metrics.get_summary()

    def reset_metrics(self) -> None:
        """重置监控指标。"""
        self._metrics.reset()
