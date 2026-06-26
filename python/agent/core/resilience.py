from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypeVar

from agent.core.logger import get_logger

T = TypeVar("T")

logger = get_logger("resilience")


@dataclass
class RetryConfig:
    max_retries: int = 3
    base_delay: float = 0.5
    max_delay: float = 30.0
    exponential_base: float = 2.0
    retryable_exceptions: tuple[type[Exception], ...] = (ConnectionError, TimeoutError, OSError)


@dataclass
class CircuitState:
    name: str
    failure_threshold: int = 5
    recovery_timeout: float = 30.0
    failure_count: int = 0
    last_failure_time: float = 0.0
    state: str = "closed"

    def record_success(self) -> None:
        self.failure_count = 0
        if self.state == "half-open":
            self.state = "closed"
            logger.info("Circuit closed", circuit=self.name)

    def record_failure(self) -> None:
        self.failure_count += 1
        self.last_failure_time = time.monotonic()
        if self.failure_count >= self.failure_threshold:
            if self.state != "open":
                self.state = "open"
                logger.warning("Circuit opened", circuit=self.name, failures=self.failure_count)

    def allow_request(self) -> bool:
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
    async def _wrapped() -> T:
        if circuit_name:
            return await with_circuit_breaker(fn, circuit_name, fallback=fallback)
        return await fn()

    return await with_retry(_wrapped, config=retry_config, operation=operation)
