"""LLM 熔断器 (Circuit Breaker)。

实现经典的三态熔断器模式，防止级联故障：
- CLOSED: 正常通行，失败计数递增
- OPEN: 拒绝所有请求，等待冷却
- HALF_OPEN: 允许少量探测请求，成功则恢复 CLOSED

支持：
- 按 provider 粒度隔离（不同 provider 独立熔断）
- 半开状态探测（可配置探测请求数）
- 指数退避冷却（冷却时间随失败次数递增）
- 熔断事件回调（用于告警/日志）

Usage:
    cb = CircuitBreaker(failure_threshold=5, cooldown_seconds=30)
    async with cb as protected:
        result = await llm_call()
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class CircuitConfig:
    failure_threshold: int = 5
    success_threshold: int = 2
    cooldown_seconds: float = 30.0
    max_cooldown_seconds: float = 300.0
    half_open_max_requests: int = 3
    enabled: bool = True


@dataclass
class CircuitStats:
    name: str = ""
    state: CircuitState = CircuitState.CLOSED
    failure_count: int = 0
    success_count: int = 0
    total_failures: int = 0
    total_successes: int = 0
    last_failure_time: float = 0.0
    last_success_time: float = 0.0
    opened_at: float = 0.0
    half_open_requests: int = 0


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, retry_after: float) -> None:
        self.name = name
        self.retry_after = retry_after
        super().__init__(f"Circuit breaker '{name}' is OPEN. Retry after {retry_after:.1f}s")


class CircuitBreaker:
    """熔断器 — 三态自动故障隔离。

    检测到连续失败达到阈值后自动打开熔断器，
    拒绝请求以保护下游服务。冷却后进入半开状态
    探测恢复情况。
    """

    def __init__(
        self,
        name: str = "default",
        config: CircuitConfig | None = None,
        on_open: Callable[["CircuitBreaker"], None] | None = None,
        on_close: Callable[["CircuitBreaker"], None] | None = None,
        on_half_open: Callable[["CircuitBreaker"], None] | None = None,
    ) -> None:
        self._name = name
        self._config = config or CircuitConfig()
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._total_failures = 0
        self._total_successes = 0
        self._last_failure_time = 0.0
        self._last_success_time = 0.0
        self._opened_at = 0.0
        self._half_open_requests = 0
        self._lock = asyncio.Lock()
        self._on_open = on_open
        self._on_close = on_close
        self._on_half_open = on_half_open

    @property
    def name(self) -> str:
        return self._name

    @property
    def state(self) -> CircuitState:
        return self._state

    @property
    def stats(self) -> CircuitStats:
        return CircuitStats(
            name=self._name,
            state=self._state,
            failure_count=self._failure_count,
            success_count=self._success_count,
            total_failures=self._total_failures,
            total_successes=self._total_successes,
            last_failure_time=self._last_failure_time,
            last_success_time=self._last_success_time,
            opened_at=self._opened_at,
            half_open_requests=self._half_open_requests,
        )

    async def call(self, fn: Callable, *args: Any, **kwargs: Any) -> Any:
        """受熔断器保护的调用。

        根据当前状态决定是否允许请求通过，
        自动记录成功/失败并转换状态。

        Raises:
            CircuitBreakerOpenError: 熔断器当前处于 OPEN 状态。
        """
        if not self._config.enabled:
            return await fn(*args, **kwargs)

        async with self._lock:
            if not self._allow_request():
                retry_after = self._config.cooldown_seconds - (time.time() - self._opened_at)
                raise CircuitBreakerOpenError(self._name, max(0, retry_after))

            if self._state == CircuitState.HALF_OPEN:
                self._half_open_requests += 1

        try:
            result = await fn(*args, **kwargs)
            async with self._lock:
                self._on_success()
            return result
        except Exception:
            async with self._lock:
                self._on_failure()
            raise

    def _allow_request(self) -> bool:
        if self._state == CircuitState.CLOSED:
            return True

        if self._state == CircuitState.OPEN:
            elapsed = time.time() - self._opened_at
            cooldown = min(
                self._config.cooldown_seconds * (1 + self._total_failures * 0.5),
                self._config.max_cooldown_seconds,
            )
            if elapsed >= cooldown:
                self._state = CircuitState.HALF_OPEN
                self._half_open_requests = 0
                if self._on_half_open:
                    self._on_half_open(self)
                return True
            return False

        if self._state == CircuitState.HALF_OPEN:
            return self._half_open_requests < self._config.half_open_max_requests

        return False

    def _on_success(self) -> None:
        self._success_count += 1
        self._total_successes += 1
        self._last_success_time = time.time()

        if self._state == CircuitState.HALF_OPEN:
            if self._success_count >= self._config.success_threshold:
                self._state = CircuitState.CLOSED
                self._failure_count = 0
                self._success_count = 0
                if self._on_close:
                    self._on_close(self)

    def _on_failure(self) -> None:
        self._failure_count += 1
        self._total_failures += 1
        self._last_failure_time = time.time()

        if self._state == CircuitState.HALF_OPEN:
            self._state = CircuitState.OPEN
            self._opened_at = time.time()
            if self._on_open:
                self._on_open(self)
            return

        if self._state == CircuitState.CLOSED:
            if self._failure_count >= self._config.failure_threshold:
                self._state = CircuitState.OPEN
                self._opened_at = time.time()
                self._success_count = 0
                if self._on_open:
                    self._on_open(self)


class CircuitBreakerRegistry:
    """熔断器注册表 — 按 provider 粒度管理熔断器。

    自动为每个 provider 创建独立的熔断器实例，
    支持获取全局统计信息。
    """

    def __init__(self, config: CircuitConfig | None = None) -> None:
        self._config = config or CircuitConfig()
        self._breakers: dict[str, CircuitBreaker] = {}
        self._lock = asyncio.Lock()

    async def get(self, name: str) -> CircuitBreaker:
        async with self._lock:
            if name not in self._breakers:
                self._breakers[name] = CircuitBreaker(name=name, config=self._config)
            return self._breakers[name]

    def get_sync(self, name: str) -> CircuitBreaker:
        if name not in self._breakers:
            self._breakers[name] = CircuitBreaker(name=name, config=self._config)
        return self._breakers[name]

    def all_stats(self) -> dict[str, CircuitStats]:
        return {name: cb.stats for name, cb in self._breakers.items()}

    def reset(self, name: str | None = None) -> None:
        if name:
            self._breakers.pop(name, None)
        else:
            self._breakers.clear()


class AsyncCircuitBreakerContext:
    """异步上下文管理器 — 简化熔断器使用。

    Usage:
        async with cb:
            result = await risky_call()
    """

    def __init__(self, breaker: CircuitBreaker) -> None:
        self._breaker = breaker
        self._allowed = False

    async def __aenter__(self) -> "AsyncCircuitBreakerContext":
        import asyncio as _asyncio

        async with self._breaker._lock:
            self._allowed = self._breaker._allow_request()
            if not self._allowed:
                retry = self._breaker._config.cooldown_seconds - (
                    time.time() - self._breaker._opened_at
                )
                raise CircuitBreakerOpenError(self._breaker._name, max(0, retry))
            if self._breaker._state == CircuitState.HALF_OPEN:
                self._breaker._half_open_requests += 1
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        if exc_type is None:
            async with self._breaker._lock:
                self._breaker._on_success()
        elif exc_type is not None:
            async with self._breaker._lock:
                self._breaker._on_failure()
        return False
