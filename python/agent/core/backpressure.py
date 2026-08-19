"""背压机制 (Backpressure) — 过载保护。

当系统负载过高时，优雅地拒绝或延迟新请求，防止 OOM 和雪崩。
提供三种策略：
1. 信号量限流 - 并发数上限
2. 队列深度监控 - 排队请求数上限
3. 自适应降级 - 根据负载自动降级非关键功能

架构：
    BackpressureController
    ├── ConcurrencyGuard (信号量)
    ├── QueueDepthMonitor (队列深度)
    └── AdaptiveDegrader (自适应降级)

Usage:
    bp = BackpressureController(max_concurrent=10, max_queue_depth=50)
    async with bp.guard() as token:
        if token.allowed:
            await process_request()
        else:
            return {"error": "系统繁忙，请稍后重试"}
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator


class LoadLevel(str, Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class BackpressureConfig:
    max_concurrent: int = 10
    max_queue_depth: int = 50
    request_timeout: float = 30.0
    low_watermark: int = 5
    high_watermark: int = 8
    critical_watermark: int = 10
    cooldown_seconds: float = 5.0
    enabled: bool = True


@dataclass
class GuardToken:
    allowed: bool = False
    load_level: LoadLevel = LoadLevel.NORMAL
    wait_time_ms: float = 0.0
    queue_depth: int = 0
    active_requests: int = 0


@dataclass
class BackpressureStats:
    total_requests: int = 0
    accepted: int = 0
    rejected: int = 0
    current_load: LoadLevel = LoadLevel.NORMAL
    active_requests: int = 0
    queue_depth: int = 0
    avg_wait_ms: float = 0.0
    degradation_level: int = 0


class BackpressureController:
    """背压控制器 — 多策略过载保护。

    组合信号量限流、队列深度监控和自适应降级，
    在系统负载过高时优雅拒绝请求。
    """

    def __init__(self, config: BackpressureConfig | None = None) -> None:
        self._config = config or BackpressureConfig()
        self._sem = asyncio.Semaphore(self._config.max_concurrent)
        self._queue_depth = 0
        self._active = 0
        self._lock = asyncio.Lock()
        self._total_requests = 0
        self._accepted = 0
        self._rejected = 0
        self._wait_times: deque[float] = deque(maxlen=100)
        self._degradation_level = 0
        self._last_load_check = time.monotonic()
        self._current_load = LoadLevel.NORMAL

    @property
    def config(self) -> BackpressureConfig:
        return self._config

    @property
    def load_level(self) -> LoadLevel:
        return self._current_load

    @property
    def stats(self) -> BackpressureStats:
        avg_wait = sum(self._wait_times) / max(len(self._wait_times), 1) * 1000
        return BackpressureStats(
            total_requests=self._total_requests,
            accepted=self._accepted,
            rejected=self._rejected,
            current_load=self._current_load,
            active_requests=self._active,
            queue_depth=self._queue_depth,
            avg_wait_ms=avg_wait,
            degradation_level=self._degradation_level,
        )

    @asynccontextmanager
    async def guard(self) -> AsyncIterator[GuardToken]:
        """获取请求通行令牌（异步上下文管理器）。

        检查队列深度和当前负载，决定是否允许请求进入。
        过载时返回 rejected token，调用方应返回 503。
        请求在上下文管理器存活期间计入 active_requests，
        退出时自动递减，确保计数准确。

        Yields:
            GuardToken 包含是否允许、负载等级等信息。
        """
        if not self._config.enabled:
            yield GuardToken(allowed=True)
            return

        self._total_requests += 1

        async with self._lock:
            self._queue_depth += 1
            self._update_load()

        start_time = time.monotonic()

        if self._queue_depth > self._config.max_queue_depth:
            self._rejected += 1
            async with self._lock:
                self._queue_depth -= 1
            yield GuardToken(
                allowed=False,
                load_level=self._current_load,
                queue_depth=self._queue_depth,
                active_requests=self._active,
            )
            return

        try:
            async with self._sem:
                self._active += 1
                async with self._lock:
                    self._queue_depth -= 1

                wait_time = (time.monotonic() - start_time) * 1000
                self._wait_times.append(wait_time)
                self._accepted += 1

                try:
                    yield GuardToken(
                        allowed=True,
                        load_level=self._current_load,
                        wait_time_ms=wait_time,
                        queue_depth=self._queue_depth,
                        active_requests=self._active,
                    )
                finally:
                    self._active = max(0, self._active - 1)
        except asyncio.CancelledError:
            async with self._lock:
                self._queue_depth = max(0, self._queue_depth - 1)
            raise

    def _update_load(self) -> None:
        now = time.monotonic()
        if now - self._last_load_check < 0.5:
            return
        self._last_load_check = now

        active = self._active
        if active >= self._config.critical_watermark:
            self._current_load = LoadLevel.CRITICAL
            self._degradation_level = 3
        elif active >= self._config.high_watermark:
            self._current_load = LoadLevel.HIGH
            self._degradation_level = 2
        elif active >= self._config.low_watermark:
            self._current_load = LoadLevel.NORMAL
            self._degradation_level = 1
        else:
            self._current_load = LoadLevel.LOW
            self._degradation_level = 0

    async def wait_for_capacity(self, timeout: float = 30.0) -> bool:
        """等待系统有可用容量。

        阻塞直到有可用并发槽位或超时。

        Returns:
            True 如果获得容量，False 如果超时。
        """
        try:
            await asyncio.wait_for(
                self._sem.acquire(),
                timeout=timeout,
            )
            return True
        except asyncio.TimeoutError:
            return False

    def release(self) -> None:
        """释放一个并发槽位。"""
        self._sem.release()

    def should_degrade(self, feature: str) -> bool:
        """检查指定功能是否应该降级。

        根据当前负载等级决定是否降级非关键功能。

        Args:
            feature: 功能名称，如 "backup_tool", "detailed_logging"。

        Returns:
            True 如果该功能应该降级。
        """
        if self._current_load == LoadLevel.CRITICAL:
            return True
        if self._current_load == LoadLevel.HIGH:
            return feature in ("backup_tool", "secondary_search", "detailed_logging")
        return False

    def get_retry_after(self) -> float:
        """获取建议的重试等待时间（秒）。"""
        if self._current_load == LoadLevel.CRITICAL:
            return 10.0
        if self._current_load == LoadLevel.HIGH:
            return 3.0
        return 0.0


class AdaptiveConcurrencyLimiter:
    """自适应并发限制器 — 根据延迟动态调整并发数。

    监控平均响应延迟，延迟过高时降低并发数，
    延迟恢复正常时逐步提升并发数。
    """

    def __init__(
        self,
        initial_concurrent: int = 10,
        min_concurrent: int = 2,
        max_concurrent: int = 50,
        target_latency_ms: float = 500.0,
        window_size: int = 50,
    ) -> None:
        self._current = initial_concurrent
        self._min = min_concurrent
        self._max = max_concurrent
        self._target_latency = target_latency_ms
        self._latencies: deque[float] = deque(maxlen=window_size)
        self._lock = asyncio.Lock()
        self._sem = asyncio.Semaphore(initial_concurrent)

    @property
    def current_limit(self) -> int:
        return self._current

    async def acquire(self) -> bool:
        return await self._sem.acquire()

    def release(self) -> None:
        self._sem.release()

    async def record_latency(self, latency_ms: float) -> None:
        """记录请求延迟，自动调整并发数。"""
        async with self._lock:
            self._latencies.append(latency_ms)
            if len(self._latencies) < 10:
                return

            avg = sum(self._latencies) / len(self._latencies)
            ratio = avg / self._target_latency

            if ratio > 2.0:
                self._current = max(self._min, self._current - 2)
            elif ratio > 1.5:
                self._current = max(self._min, self._current - 1)
            elif ratio < 0.5:
                self._current = min(self._max, self._current + 2)
            elif ratio < 0.8:
                self._current = min(self._max, self._current + 1)

            diff = self._current - self._sem._value
            if diff > 0:
                self._sem = asyncio.Semaphore(self._current)
            elif diff < 0:
                for _ in range(-diff):
                    try:
                        self._sem.release()
                    except ValueError:
                        break

    def stats(self) -> dict[str, Any]:
        avg_latency = sum(self._latencies) / max(len(self._latencies), 1)
        return {
            "current_limit": self._current,
            "min_limit": self._min,
            "max_limit": self._max,
            "target_latency_ms": self._target_latency,
            "avg_latency_ms": avg_latency,
            "window_size": len(self._latencies),
        }
