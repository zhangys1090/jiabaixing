from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypeVar

from agent.core.logger import StructuredLogger

T = TypeVar("T")

logger = StructuredLogger("resilience")


@dataclass
class RetryConfig:
    """重试配置。

    Attributes:
        max_retries: 最大重试次数。
        base_delay: 基础延迟（秒）。
        max_delay: 最大延迟（秒）。
        exponential_base: 指数退避基数。
        retryable_exceptions: 可重试的异常类型元组。
    """

    max_retries: int = 3
    base_delay: float = 0.5
    max_delay: float = 30.0
    exponential_base: float = 2.0
    retryable_exceptions: tuple[type[Exception], ...] = (ConnectionError, TimeoutError, OSError)


@dataclass
class CircuitState:
    """熔断器状态 — 三态模型（closed / open / half-open）。

    Attributes:
        name: 熔断器名称。
        failure_threshold: 触发熔断的失败次数阈值。
        recovery_timeout: 熔断恢复超时（秒）。
        failure_count: 当前失败计数。
        last_failure_time: 最近一次失败的时间戳。
        state: 当前状态（closed / open / half-open）。
    """

    name: str
    failure_threshold: int = 5
    recovery_timeout: float = 30.0
    failure_count: int = 0
    last_failure_time: float = 0.0
    state: str = "closed"

    def record_success(self) -> None:
        """记录成功调用，重置失败计数，half-open 状态回到 closed。"""
        self.failure_count = 0
        if self.state == "half-open":
            self.state = "closed"
            logger.info("Circuit closed", circuit=self.name)

    def record_failure(self) -> None:
        """记录失败调用，达到阈值时切换到 open 状态。"""
        self.failure_count += 1
        self.last_failure_time = time.monotonic()
        if self.failure_count >= self.failure_threshold:
            if self.state != "open":
                self.state = "open"
                logger.warning("Circuit opened", circuit=self.name, failures=self.failure_count)

    def allow_request(self) -> bool:
        """判断是否允许请求通过。

        closed 状态允许，open 状态在恢复超时后切换到 half-open 允许，
        half-open 状态允许（试探性请求）。

        Returns:
            bool: 是否允许请求。
        """
        if self.state == "closed":
            return True
        if self.state == "open":
            elapsed = time.monotonic() - self.last_failure_time
            if elapsed >= self.recovery_timeout:
                self.state = "half-open"
                logger.info("Circuit half-open", circuit=self.name)
                return True
            return False
        return True


_circuits: dict[str, CircuitState] = {}


def get_circuit(name: str, failure_threshold: int = 5, recovery_timeout: float = 30.0) -> CircuitState:
    """获取或创建命名熔断器。

    Args:
        name: 熔断器名称。
        failure_threshold: 触发熔断的失败次数阈值。
        recovery_timeout: 熔断恢复超时（秒）。

    Returns:
        CircuitState: 熔断器状态实例。
    """
    if name not in _circuits:
        _circuits[name] = CircuitState(
            name=name,
            failure_threshold=failure_threshold,
            recovery_timeout=recovery_timeout,
        )
    return _circuits[name]


async def with_retry(
    fn: Callable[[], Awaitable[T]],
    config: RetryConfig | None = None,
    operation: str = "operation",
) -> T:
    """带指数退避的重试执行。

    Args:
        fn: 待执行的异步函数。
        config: 重试配置，None 时使用默认配置。
        operation: 操作名称（用于日志）。

    Returns:
        T: 函数执行结果。

    Raises:
        Exception: 重试耗尽后抛出最后一次异常。
    """
    cfg = config or RetryConfig()
    last_error: Exception | None = None
    for attempt in range(cfg.max_retries + 1):
        try:
            return await fn()
        except cfg.retryable_exceptions as e:
            last_error = e
            if attempt < cfg.max_retries:
                delay = min(cfg.base_delay * (cfg.exponential_base ** attempt), cfg.max_delay)
                logger.warning(
                    "Retry attempt",
                    operation=operation,
                    attempt=attempt + 1,
                    max_retries=cfg.max_retries,
                    delay=f"{delay:.2f}s",
                    error=str(e),
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    "Retry exhausted",
                    operation=operation,
                    attempts=cfg.max_retries + 1,
                    error=str(e),
                )
    raise last_error  # type: ignore[misc]


async def with_circuit_breaker(
    fn: Callable[[], Awaitable[T]],
    circuit_name: str,
    fallback: T | None = None,
) -> T:
    """带熔断器保护的执行。

    熔断器 open 状态时拒绝请求，可返回 fallback 值或抛出异常。

    Args:
        fn: 待执行的异步函数。
        circuit_name: 熔断器名称。
        fallback: 熔断时的降级返回值，None 时抛出 ConnectionError。

    Returns:
        T: 函数执行结果或 fallback 值。

    Raises:
        ConnectionError: 熔断器 open 且无 fallback 时抛出。
    """
    circuit = get_circuit(circuit_name)
    if not circuit.allow_request():
        logger.warning("Circuit open, request rejected", circuit=circuit_name)
        if fallback is not None:
            return fallback
        raise ConnectionError(f"Circuit '{circuit_name}' is open")
    try:
        result = await fn()
        circuit.record_success()
        return result
    except Exception as e:
        circuit.record_failure()
        raise


async def resilient_call(
    fn: Callable[[], Awaitable[T]],
    operation: str = "operation",
    retry_config: RetryConfig | None = None,
    circuit_name: str | None = None,
    fallback: T | None = None,
) -> T:
    """弹性调用 — 组合重试 + 熔断器保护。

    优先使用熔断器保护（如果指定 circuit_name），再叠加重试机制。

    Args:
        fn: 待执行的异步函数。
        operation: 操作名称（用于日志）。
        retry_config: 重试配置，None 时使用默认配置。
        circuit_name: 熔断器名称，None 时不使用熔断器。
        fallback: 熔断时的降级返回值。

    Returns:
        T: 函数执行结果。
    """
    async def _wrapped() -> T:
        if circuit_name:
            return await with_circuit_breaker(fn, circuit_name, fallback=fallback)
        return await fn()

    return await with_retry(_wrapped, config=retry_config, operation=operation)
