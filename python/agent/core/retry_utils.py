"""智能重试工具。

提供灵活的重试策略，替代简单的 for 循环重试：
  - 指数退避（Exponential Backoff）
  - 抖动（Jitter）避免雷群效应
  - 条件重试（仅对特定异常重试）
  - 最大重试次数 + 最大总耗时双重限制
  - 重试回调（每次重试前通知）
  - 重试统计

与 resilience.py 的关系：
  - resilience.py 提供 CircuitBreaker 等熔断机制
  - retry_utils.py 提供细粒度重试策略
  - 两者可组合使用

集成示例::

    from agent.core.retry_utils import retry, RetryPolicy

    policy = RetryPolicy(max_attempts=5, base_delay=1.0, jitter=True)

    @retry(policy, retry_on=(ConnectionError, TimeoutError))
    async def call_api():
        ...
"""

from __future__ import annotations

import asyncio
import functools
import random
import time
from dataclasses import dataclass
from typing import Any, Callable, Coroutine, TypeVar
from agent.core.logger import StructuredLogger

log = StructuredLogger("retry_utils")


T = TypeVar("T")


@dataclass
class RetryPolicy:
    """重试策略。

    Attributes:
        max_attempts: 最大重试次数（含首次）。
        base_delay: 基础延迟（秒）。
        max_delay: 最大延迟（秒）。
        backoff_factor: 退避因子（delay *= factor^attempt）。
        jitter: 是否添加随机抖动。
        jitter_range: 抖动范围（0-1），0.1 表示 ±10%。
        max_total_time: 最大总耗时（秒），0 表示不限。
        retry_on: 需要重试的异常类型元组。
    """

    max_attempts: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    backoff_factor: float = 2.0
    jitter: bool = True
    jitter_range: float = 0.1
    max_total_time: float = 0.0
    retry_on: tuple[type[Exception], ...] = (Exception,)


@dataclass
class RetryStats:
    """重试统计。

    Attributes:
        total_calls: 总调用次数。
        total_retries: 总重试次数。
        total_failures: 最终失败次数。
        total_successes: 最终成功次数。
        total_delay_time: 总等待时间。
    """

    total_calls: int = 0
    total_retries: int = 0
    total_failures: int = 0
    total_successes: int = 0
    total_delay_time: float = 0.0

    @property
    def success_rate(self) -> float:
        if self.total_calls == 0:
            return 0.0
        return self.total_successes / self.total_calls

    @property
    def avg_retries(self) -> float:
        if self.total_calls == 0:
            return 0.0
        return self.total_retries / self.total_calls


def calculate_delay(attempt: int, policy: RetryPolicy) -> float:
    """计算第 N 次重试的等待时间。

    Args:
        attempt: 重试次数（从 1 开始）。
        policy: 重试策略。

    Returns:
        等待时间（秒）。
    """
    delay = policy.base_delay * (policy.backoff_factor ** (attempt - 1))
    delay = min(delay, policy.max_delay)

    if policy.jitter:
        jitter_amount = delay * policy.jitter_range
        delay += random.uniform(-jitter_amount, jitter_amount)
        delay = max(0.0, delay)

    return delay


async def retry_async(
    func: Callable[..., Coroutine[Any, Any, T]],
    policy: RetryPolicy | None = None,
    retry_on: tuple[type[Exception], ...] | None = None,
    on_retry: Callable[[int, Exception, float], Coroutine[Any, Any, None]] | None = None,
    *args: Any,
    **kwargs: Any,
) -> T:
    """异步重试执行。

    Args:
        func: 异步函数。
        policy: 重试策略。
        retry_on: 需要重试的异常类型。
        on_retry: 重试回调（attempt, exception, delay）。
        *args: 函数位置参数。
        **kwargs: 函数关键字参数。

    Returns:
        函数返回值。

    Raises:
        Exception: 超过重试次数后抛出最后一次异常。
    """
    p = policy or RetryPolicy()
    exceptions = retry_on or p.retry_on
    start_time = time.time()
    last_exception: Exception | None = None

    for attempt in range(1, p.max_attempts + 1):
        try:
            return await func(*args, **kwargs)
        except exceptions as e:
            last_exception = e

            if p.max_total_time > 0:
                elapsed = time.time() - start_time
                if elapsed >= p.max_total_time:
                    log.warning(
                        "Retry total time exceeded",
                        attempt=attempt,
                        elapsed=round(elapsed, 2),
                        max_time=p.max_total_time,
                    )
                    raise

            if attempt >= p.max_attempts:
                log.warning(
                    "Retry exhausted",
                    attempt=attempt,
                    max_attempts=p.max_attempts,
                    error=str(e),
                )
                raise

            delay = calculate_delay(attempt, p)

            if on_retry:
                await on_retry(attempt, e, delay)

            log.info("Retrying", attempt=attempt, delay=round(delay, 3), error=str(e))
            await asyncio.sleep(delay)

    if last_exception:
        raise last_exception
    raise RuntimeError("retry_async: unreachable")


def retry(
    policy: RetryPolicy | None = None,
    retry_on: tuple[type[Exception], ...] | None = None,
    on_retry: Callable[[int, Exception, float], Any] | None = None,
) -> Callable[..., Any]:
    """重试装饰器。

    Args:
        policy: 重试策略。
        retry_on: 需要重试的异常类型。
        on_retry: 重试回调。

    Returns:
        装饰后的函数。
    """

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            async def _on_retry(attempt: int, exc: Exception, delay: float) -> None:
                if on_retry:
                    result = on_retry(attempt, exc, delay)
                    if asyncio.iscoroutine(result):
                        await result

            return await retry_async(
                func, policy=policy, retry_on=retry_on, on_retry=_on_retry, *args, **kwargs
            )

        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            p = policy or RetryPolicy()
            exceptions = retry_on or p.retry_on
            start_time = time.time()
            last_exception: Exception | None = None

            for attempt in range(1, p.max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_exception = e
                    if p.max_total_time > 0:
                        elapsed = time.time() - start_time
                        if elapsed >= p.max_total_time:
                            raise
                    if attempt >= p.max_attempts:
                        raise
                    delay = calculate_delay(attempt, p)
                    if on_retry:
                        on_retry(attempt, e, delay)
                    time.sleep(delay)

            if last_exception:
                raise last_exception
            raise RuntimeError("retry: unreachable")

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    return decorator


class RetryExecutor:
    """重试执行器（带统计）。"""

    def __init__(self, policy: RetryPolicy | None = None) -> None:
        self._policy = policy or RetryPolicy()
        self._stats = RetryStats()

    @property
    def stats(self) -> RetryStats:
        return self._stats

    async def execute(
        self,
        func: Callable[..., Coroutine[Any, Any, T]],
        retry_on: tuple[type[Exception], ...] | None = None,
        *args: Any,
        **kwargs: Any,
    ) -> T:
        """执行带重试的异步函数。"""
        self._stats.total_calls += 1

        async def _on_retry(attempt: int, exc: Exception, delay: float) -> None:
            self._stats.total_retries += 1
            self._stats.total_delay_time += delay

        try:
            result = await retry_async(
                func, policy=self._policy, retry_on=retry_on, on_retry=_on_retry, *args, **kwargs
            )
            self._stats.total_successes += 1
            return result
        except Exception as _exc:
            log.debug("retry_utils 异常处理", error=str(_exc))
            self._stats.total_failures += 1
            raise
