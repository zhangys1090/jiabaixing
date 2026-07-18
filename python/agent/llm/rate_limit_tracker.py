"""API 速率限制追踪器。

追踪每个提供商的请求/限流情况，自动计算安全请求间隔，
在接近限流阈值时主动降速，避免触发 429 错误。

策略：
    1. 滑动窗口统计请求数
    2. 收到 429 后记录 Retry-After，期间禁止该提供商
    3. 基于历史数据动态计算建议等待时间
    4. 多提供商时自动降级到未限流的提供商
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ProviderRateState:
    """单个提供商的速率状态。

    Attributes:
        provider: 提供商名称。
        requests: 滑动窗口内的请求时间戳队列。
        rate_limited_until: 限流恢复时间戳，0 表示未限流。
        consecutive_429: 连续 429 次数。
        total_requests: 总请求数。
        total_429: 总 429 次数。
        last_request_time: 最近请求时间戳。
        retry_after_seconds: 最近一次 429 的 Retry-After 值。
    """

    provider: str
    requests: deque[float] = field(default_factory=lambda: deque(maxlen=1000))
    rate_limited_until: float = 0.0
    consecutive_429: int = 0
    total_requests: int = 0
    total_429: int = 0
    last_request_time: float = 0.0
    retry_after_seconds: float = 0.0

    @property
    def is_rate_limited(self) -> bool:
        """当前是否处于限流状态。"""
        return self.rate_limited_until > time.time()

    @property
    def rate_limit_remaining(self) -> float:
        """限流剩余秒数（未限流时为 0）。"""
        if not self.is_rate_limited:
            return 0.0
        return self.rate_limited_until - time.time()


class RateLimitTracker:
    """多提供商速率限制追踪器。

    追踪请求频率与 429 事件，提供降级建议和等待时间计算。

    Usage:
        tracker = RateLimitTracker(default_rpm=60)
        tracker.record_request("openai")
        if tracker.should_degrade("openai"):
            next_provider = tracker.get_healthy_provider(["openai", "anthropic"])
    """

    def __init__(
        self,
        default_rpm: int = 60,
        warning_threshold: float = 0.8,
        window_seconds: float = 60.0,
    ) -> None:
        """初始化速率限制追踪器。

        Args:
            default_rpm: 默认每分钟请求数上限。
            warning_threshold: 达到 RPM 的多少比例时发出警告（0-1）。
            window_seconds: 滑动窗口大小（秒），默认 60 秒。
        """
        self._default_rpm = default_rpm
        self._warning_threshold = warning_threshold
        self._window_seconds = window_seconds
        self._states: dict[str, ProviderRateState] = {}
        self._provider_rpm: dict[str, int] = {}

    def set_provider_rpm(self, provider: str, rpm: int) -> None:
        """设置指定提供商的 RPM 上限。

        Args:
            provider: 提供商名称。
            rpm: 每分钟请求数上限。
        """
        self._provider_rpm[provider] = rpm

    def get_rpm_limit(self, provider: str) -> int:
        """获取提供商的 RPM 上限。

        Args:
            provider: 提供商名称。

        Returns:
            int: RPM 上限，未设置时返回 default_rpm。
        """
        return self._provider_rpm.get(provider, self._default_rpm)

    def record_request(self, provider: str) -> None:
        """记录一次请求。

        Args:
            provider: 提供商名称。
        """
        state = self._get_or_create(provider)
        now = time.time()
        state.requests.append(now)
        state.last_request_time = now
        state.total_requests += 1

    def record_429(
        self,
        provider: str,
        retry_after: float = 0.0,
    ) -> None:
        """记录一次 429 限流事件。

        Args:
            provider: 提供商名称。
            retry_after: Retry-After 秒数，0 表示未提供。
        """
        state = self._get_or_create(provider)
        state.consecutive_429 += 1
        state.total_429 += 1
        state.retry_after_seconds = retry_after

        # 计算限流恢复时间
        if retry_after > 0:
            state.rate_limited_until = time.time() + retry_after
        else:
            # 指数退避：连续 429 越多，等待越久
            backoff = min(60 * (2 ** (state.consecutive_429 - 1)), 3600)
            state.rate_limited_until = time.time() + backoff

    def record_success(self, provider: str) -> None:
        """记录一次成功请求，重置连续 429 计数。

        Args:
            provider: 提供商名称。
        """
        state = self._get_or_create(provider)
        state.consecutive_429 = 0

    def get_current_rpm(self, provider: str) -> int:
        """获取当前滑动窗口内的 RPM。

        Args:
            provider: 提供商名称。

        Returns:
            int: 最近 60 秒内的请求数。
        """
        state = self._get_or_create(provider)
        now = time.time()
        cutoff = now - self._window_seconds
        # 清理过期请求
        while state.requests and state.requests[0] < cutoff:
            state.requests.popleft()
        return len(state.requests)

    def should_degrade(self, provider: str) -> bool:
        """判断是否应该降级（切换到其他提供商）。

        降级条件：
            1. 当前被限流
            2. RPM 达到警告阈值
            3. 连续 429 超过 3 次

        Args:
            provider: 提供商名称。

        Returns:
            bool: 是否建议降级。
        """
        state = self._get_or_create(provider)
        if state.is_rate_limited:
            return True
        if state.consecutive_429 >= 3:
            return True
        rpm_limit = self.get_rpm_limit(provider)
        current_rpm = self.get_current_rpm(provider)
        if rpm_limit > 0 and current_rpm >= rpm_limit * self._warning_threshold:
            return True
        return False

    def get_recommended_wait(self, provider: str) -> float:
        """获取建议等待时间（秒）。

        如果被限流，返回限流剩余时间；
        如果接近 RPM 上限，返回到下一个窗口的建议等待时间。

        Args:
            provider: 提供商名称。

        Returns:
            float: 建议等待秒数。
        """
        state = self._get_or_create(provider)
        if state.is_rate_limited:
            return state.rate_limit_remaining

        rpm_limit = self.get_rpm_limit(provider)
        current_rpm = self.get_current_rpm(provider)
        if rpm_limit > 0 and current_rpm >= rpm_limit * self._warning_threshold:
            # 计算到窗口最早请求过期的时间
            if state.requests:
                oldest = state.requests[0]
                wait = (oldest + self._window_seconds) - time.time()
                return max(wait, 0.5)
        return 0.0

    def get_healthy_provider(
        self,
        candidates: list[str],
    ) -> str | None:
        """从候选列表中选择一个健康的提供商。

        优先选择未限流且 RPM 使用率最低的提供商。

        Args:
            candidates: 候选提供商列表。

        Returns:
            str | None: 选中的提供商名称，全部不健康时返回 None。
        """
        healthy: list[tuple[str, float]] = []
        for provider in candidates:
            state = self._get_or_create(provider)
            if state.is_rate_limited:
                continue
            rpm_limit = self.get_rpm_limit(provider)
            current_rpm = self.get_current_rpm(provider)
            usage = current_rpm / rpm_limit if rpm_limit > 0 else 0.0
            if usage < self._warning_threshold:
                healthy.append((provider, usage))

        if not healthy:
            return None

        # 选择使用率最低的
        healthy.sort(key=lambda x: x[1])
        return healthy[0][0]

    def get_provider_stats(self, provider: str) -> dict[str, Any]:
        """获取指定提供商的速率统计。

        Args:
            provider: 提供商名称。

        Returns:
            dict: 统计信息。
        """
        state = self._get_or_create(provider)
        rpm_limit = self.get_rpm_limit(provider)
        current_rpm = self.get_current_rpm(provider)
        return {
            "provider": provider,
            "is_rate_limited": state.is_rate_limited,
            "rate_limit_remaining_s": round(state.rate_limit_remaining, 1),
            "current_rpm": current_rpm,
            "rpm_limit": rpm_limit,
            "rpm_usage_pct": round(current_rpm / rpm_limit * 100, 1) if rpm_limit > 0 else 0,
            "consecutive_429": state.consecutive_429,
            "total_requests": state.total_requests,
            "total_429": state.total_429,
            "recommended_wait_s": round(self.get_recommended_wait(provider), 1),
            "should_degrade": self.should_degrade(provider),
        }

    def get_all_stats(self) -> dict[str, Any]:
        """获取所有提供商的统计。

        Returns:
            dict: 提供商名称 -> 统计信息。
        """
        return {provider: self.get_provider_stats(provider) for provider in self._states}

    def _get_or_create(self, provider: str) -> ProviderRateState:
        """获取或创建提供商状态。

        Args:
            provider: 提供商名称。

        Returns:
            ProviderRateState: 提供商速率状态。
        """
        if provider not in self._states:
            self._states[provider] = ProviderRateState(provider=provider)
        return self._states[provider]


# 全局单例
_tracker: RateLimitTracker | None = None


def get_rate_limit_tracker() -> RateLimitTracker:
    """获取全局速率限制追踪器单例。

    Returns:
        RateLimitTracker: 全局追踪器实例。
    """
    global _tracker
    if _tracker is None:
        _tracker = RateLimitTracker()
    return _tracker
