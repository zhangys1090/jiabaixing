"""LLM 速率限制器 (Rate Limiter + Priority Queue)。

提供两层控制：
1. 速率限制 (Rate Limiter) — 令牌桶算法控制请求频率
2. 优先级队列 (Priority Queue) — 按请求优先级调度，确保用户交互不被阻塞

令牌桶：
- 以恒定速率补充令牌
- 请求消耗令牌，令牌不足时等待或拒绝
- 支持突发流量（burst 参数）

优先级队列：
- 三级优先级：HIGH(用户交互) > NORMAL(工具调用) > LOW(后台任务)
- HIGH 优先级请求可抢占 NORMAL/LOW 的排队位置
- 支持超时丢弃（排队过久的低优先级请求自动丢弃）

Usage:
    limiter = RateLimiter(rate=10, burst=5)
    async with limiter.acquire() as allowed:
        if allowed:
            await llm_call()

    pq = PriorityRequestQueue()
    result = await pq.submit(HIGH, my_coroutine)
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Callable, Coroutine
from agent.core.logger import log_ignored


class Priority(IntEnum):
    HIGH = 0
    NORMAL = 1
    LOW = 2


@dataclass
class RateLimitConfig:
    requests_per_second: float = 10.0
    burst: int = 20
    max_wait_seconds: float = 30.0
    enabled: bool = True


@dataclass
class RateLimitStats:
    available_tokens: float = 0.0
    max_tokens: float = 0.0
    total_requests: int = 0
    rejected_requests: int = 0
    waited_requests: int = 0
    total_wait_time: float = 0.0


class RateLimitExceededError(Exception):
    """令牌桶耗尽且等待超时。"""

    def __init__(self, retry_after: float) -> None:
        self.retry_after = retry_after
        super().__init__(f"Rate limit exceeded. Retry after {retry_after:.1f}s")


class RateLimiter:
    """令牌桶速率限制器。

    以恒定速率填充令牌，每次请求消耗一个令牌。
    支持突发流量（burst 参数控制桶容量）。
    """

    def __init__(self, config: RateLimitConfig | None = None) -> None:
        self._config = config or RateLimitConfig()
        self._tokens = float(self._config.burst)
        self._max_tokens = float(self._config.burst)
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()
        self._total_requests = 0
        self._rejected = 0
        self._waited = 0
        self._total_wait = 0.0

    @property
    def stats(self) -> RateLimitStats:
        return RateLimitStats(
            available_tokens=self._tokens,
            max_tokens=self._max_tokens,
            total_requests=self._total_requests,
            rejected_requests=self._rejected,
            waited_requests=self._waited,
            total_wait_time=self._total_wait,
        )

    async def acquire(self) -> bool:
        """尝试获取令牌。

        Returns:
            True 如果获取成功，False 如果等待超时。
        """
        if not self._config.enabled:
            return True

        async with self._lock:
            self._refill()
            self._total_requests += 1

            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True

            tokens_needed = 1.0 - self._tokens
            wait_time = tokens_needed / self._config.requests_per_second

            if wait_time > self._config.max_wait_seconds:
                self._rejected += 1
                return False

            self._waited += 1
            self._total_wait += wait_time

        await asyncio.sleep(wait_time)

        async with self._lock:
            self._refill()
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(
            self._max_tokens,
            self._tokens + elapsed * self._config.requests_per_second,
        )
        self._last_refill = now

    def reset(self) -> None:
        self._tokens = self._max_tokens
        self._last_refill = time.monotonic()
        self._total_requests = 0
        self._rejected = 0
        self._waited = 0
        self._total_wait = 0.0


@dataclass(order=True)
class _PriorityItem:
    priority: int
    sequence: int
    created_at: float
    future: asyncio.Future = field(compare=False)
    timeout: float = field(compare=False, default=0.0)


class PriorityRequestQueue:
    """优先级请求队列 — 按优先级调度 LLM 请求。

    高优先级请求（用户交互）优先于低优先级请求（后台任务）。
    支持超时丢弃和队列深度监控。
    """

    def __init__(
        self,
        max_concurrent: int = 3,
        max_queue_size: int = 100,
        default_timeout: float = 60.0,
    ) -> None:
        self._max_concurrent = max_concurrent
        self._max_queue_size = max_queue_size
        self._default_timeout = default_timeout
        self._sem = asyncio.Semaphore(max_concurrent)
        self._queue: list[_PriorityItem] = []
        self._sequence = 0
        self._lock = asyncio.Lock()
        self._running = 0
        self._total_submitted = 0
        self._total_completed = 0
        self._total_timeouts = 0
        self._total_rejected = 0

    @property
    def queue_depth(self) -> int:
        return len(self._queue)

    @property
    def running(self) -> int:
        return self._running

    async def submit(
        self,
        fn: Callable[..., Coroutine[Any, Any, Any]],
        priority: Priority = Priority.NORMAL,
        timeout: float | None = None,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        """提交请求到优先级队列。

        Args:
            fn: 异步函数。
            priority: 优先级。
            timeout: 排队超时（秒），None 使用默认值。
            *args, **kwargs: 传递给 fn 的参数。

        Returns:
            fn 的返回值。

        Raises:
            asyncio.TimeoutError: 排队超时。
            RuntimeError: 队列已满。
        """
        effective_timeout = timeout if timeout is not None else self._default_timeout

        async with self._lock:
            if len(self._queue) >= self._max_queue_size:
                self._total_rejected += 1
                raise RuntimeError(f"Priority queue full (depth={len(self._queue)})")

            self._sequence += 1
            self._total_submitted += 1

            future: asyncio.Future = asyncio.get_event_loop().create_future()
            item = _PriorityItem(
                priority=int(priority),
                sequence=self._sequence,
                created_at=time.monotonic(),
                future=future,
                timeout=effective_timeout,
            )
            self._queue.append(item)
            self._queue.sort()

        try:
            await asyncio.wait_for(future, timeout=effective_timeout)
        except asyncio.TimeoutError:
            async with self._lock:
                self._total_timeouts += 1
                if not future.done():
                    future.cancel()
                    try:
                        self._queue = [i for i in self._queue if i.future is not future]
                    except ValueError as _exc:
                        log_ignored(None, "rate_limiter.PriorityRequestQueue.submit", _exc)
            raise

        async with self._sem:
            self._running += 1
            try:
                result = await fn(*args, **kwargs)
                self._total_completed += 1
                return result
            finally:
                self._running -= 1

    async def _process_queue(self) -> None:
        """后台处理循环 — 从队列中取出请求并执行。"""
        while True:
            async with self._lock:
                if not self._queue:
                    break
                now = time.monotonic()
                expired = [i for i in self._queue if now - i.created_at > i.timeout]
                for item in expired:
                    if not item.future.done():
                        item.future.set_exception(asyncio.TimeoutError("Queue timeout"))
                    self._total_timeouts += 1
                self._queue = [i for i in self._queue if i not in expired]
                if not self._queue:
                    break

                item = self._queue.pop(0)

            if not item.future.done():
                item.future.set_result(True)

    def stats(self) -> dict[str, Any]:
        return {
            "queue_depth": len(self._queue),
            "running": self._running,
            "max_concurrent": self._max_concurrent,
            "total_submitted": self._total_submitted,
            "total_completed": self._total_completed,
            "total_timeouts": self._total_timeouts,
            "total_rejected": self._total_rejected,
        }


class AdaptiveRateLimiter:
    """自适应速率限制器 — 根据成功率动态调整速率。

    成功率高时提升速率，失败率高时降低速率。
    结合令牌桶和熔断器模式。
    """

    def __init__(
        self,
        initial_rate: float = 10.0,
        min_rate: float = 1.0,
        max_rate: float = 50.0,
        window_size: int = 100,
    ) -> None:
        self._rate = initial_rate
        self._min_rate = min_rate
        self._max_rate = max_rate
        self._window: deque[bool] = deque(maxlen=window_size)
        self._lock = asyncio.Lock()
        self._limiter = RateLimiter(RateLimitConfig(
            requests_per_second=initial_rate,
            burst=int(initial_rate * 2),
        ))

    @property
    def current_rate(self) -> float:
        return self._rate

    async def acquire(self) -> bool:
        return await self._limiter.acquire()

    async def record_result(self, success: bool) -> None:
        """记录请求结果，自动调整速率。"""
        async with self._lock:
            self._window.append(success)
            if len(self._window) < 10:
                return

            success_rate = sum(1 for s in self._window if s) / len(self._window)

            if success_rate > 0.95:
                self._rate = min(self._max_rate, self._rate * 1.1)
            elif success_rate < 0.7:
                self._rate = max(self._min_rate, self._rate * 0.7)
            elif success_rate < 0.85:
                self._rate = max(self._min_rate, self._rate * 0.9)

            self._limiter = RateLimiter(RateLimitConfig(
                requests_per_second=self._rate,
                burst=int(self._rate * 2),
            ))

    def stats(self) -> dict[str, Any]:
        window_success = sum(1 for s in self._window if s) if self._window else 0
        return {
            "current_rate": self._rate,
            "window_size": len(self._window),
            "window_success_rate": window_success / max(len(self._window), 1),
            "limiter_stats": self._limiter.stats.__dict__,
        }
