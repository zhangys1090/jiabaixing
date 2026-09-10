"""Nous Portal 速率守卫。

为 Nous Portal（AI 模型推理网关）提供速率限制和配额守卫：
  - 多层级速率限制（全局 / 用户 / 模型 / 端点）
  - 令牌桶算法实现
  - 突发流量控制（burst allowance）
  - 配额跟踪与预警
  - 自动降级策略（超限 → 排队 / 拒绝 / 降级模型）
  - 审计日志

与 RateLimitTracker 的关系：
  - RateLimitTracker 追踪外部 API 429 响应
  - NousRateGuard 主动控制出站请求速率
  - 两者组合提供完整的速率保护

集成示例::

    from agent.llm.nous_rate_guard import NousRateGuard, RateTier

    guard = NousRateGuard()
    guard.set_limit(RateTier.GLOBAL, max_rps=100)
    guard.set_limit(RateTier.USER, max_rps=10, user_id="user-123")
    guard.set_limit(RateTier.MODEL, max_rps=30, model="gpt-4o")

    allowed = guard.check(RateTier.USER, user_id="user-123")
    if not allowed:
        logger.info("速率超限，请稍后重试")
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("nous_rate_guard")




class RateTier(str, Enum):
    """速率限制层级。"""

    GLOBAL = "global"
    USER = "user"
    MODEL = "model"
    ENDPOINT = "endpoint"


class ThrottleAction(str, Enum):
    """超限时的动作。"""

    REJECT = "reject"
    QUEUE = "queue"
    DOWNGRADE = "downgrade"


@dataclass
class TokenBucket:
    """令牌桶。

    Attributes:
        max_tokens: 桶容量（最大令牌数）。
        refill_rate: 每秒补充令牌数。
        tokens: 当前令牌数。
        last_refill: 上次补充时间戳。
    """

    max_tokens: float
    refill_rate: float
    tokens: float = 0.0
    last_refill: float = 0.0

    def __post_init__(self) -> None:
        if self.tokens == 0.0:
            self.tokens = self.max_tokens
        if self.last_refill == 0.0:
            self.last_refill = time.time()

    def _refill(self) -> None:
        """补充令牌。"""
        now = time.time()
        elapsed = now - self.last_refill
        added = elapsed * self.refill_rate
        self.tokens = min(self.max_tokens, self.tokens + added)
        self.last_refill = now

    def try_consume(self, count: float = 1.0) -> bool:
        """尝试消费令牌。

        Args:
            count: 需要消费的令牌数。

        Returns:
            是否成功消费。
        """
        self._refill()
        if self.tokens >= count:
            self.tokens -= count
            return True
        return False

    def wait_time(self, count: float = 1.0) -> float:
        """计算需要等待的时间（秒）。

        Args:
            count: 需要消费的令牌数。

        Returns:
            等待时间。
        """
        self._refill()
        if self.tokens >= count:
            return 0.0
        deficit = count - self.tokens
        return deficit / self.refill_rate if self.refill_rate > 0 else float("inf")


@dataclass
class RateLimitSpec:
    """速率限制规格。

    Attributes:
        tier: 限制层级。
        max_rps: 每秒最大请求数。
        burst: 突发允许数。
        key: 限制键（用户 ID / 模型名 / 端点路径）。
        action: 超限动作。
    """

    tier: RateTier
    max_rps: float
    burst: int = 1
    key: str = ""
    action: ThrottleAction = ThrottleAction.REJECT


@dataclass
class QuotaUsage:
    """配额使用情况。

    Attributes:
        key: 配额键。
        used: 已使用量。
        limit: 限制量。
        window_seconds: 窗口大小（秒）。
        window_start: 窗口起始时间。
    """

    key: str
    used: float = 0.0
    limit: float = 0.0
    window_seconds: float = 60.0
    window_start: float = 0.0

    def __post_init__(self) -> None:
        if self.window_start == 0.0:
            self.window_start = time.time()

    @property
    def remaining(self) -> float:
        """剩余配额。"""
        return max(0.0, self.limit - self.used)

    @property
    def utilization(self) -> float:
        """配额利用率（0-1）。"""
        return self.used / self.limit if self.limit > 0 else 0.0

    @property
    def is_exhausted(self) -> bool:
        """配额是否耗尽。"""
        return self.used >= self.limit

    def _check_window(self) -> None:
        """检查是否需要重置窗口。"""
        now = time.time()
        if now - self.window_start >= self.window_seconds:
            self.used = 0.0
            self.window_start = now


@dataclass
class RateCheckResult:
    """速率检查结果。

    Attributes:
        allowed: 是否允许。
        tier: 检查的层级。
        key: 检查的键。
        wait_seconds: 建议等待时间。
        action: 超限动作。
        reason: 原因说明。
    """

    allowed: bool
    tier: RateTier
    key: str = ""
    wait_seconds: float = 0.0
    action: ThrottleAction = ThrottleAction.REJECT
    reason: str = ""


class NousRateGuard:
    """Nous Portal 速率守卫。

    多层级速率限制，令牌桶算法，配额跟踪与自动降级。
    """

    DEFAULT_RPS = 100.0
    DEFAULT_BURST = 5

    def __init__(self) -> None:
        self._buckets: dict[str, TokenBucket] = {}
        self._specs: dict[str, RateLimitSpec] = {}
        self._quotas: dict[str, QuotaUsage] = {}
        self._audit: list[dict[str, Any]] = []
        self._max_audit = 500
        self._MAX_BUCKETS = 5000
        self._MAX_QUOTAS = 5000

    def set_limit(
        self,
        tier: RateTier,
        max_rps: float = DEFAULT_RPS,
        burst: int = DEFAULT_BURST,
        key: str = "",
        action: ThrottleAction = ThrottleAction.REJECT,
    ) -> None:
        """设置速率限制。

        Args:
            tier: 限制层级。
            max_rps: 每秒最大请求数。
            burst: 突发允许数。
            key: 限制键（如用户 ID）。
            action: 超限动作。
        """
        bucket_key = self._make_key(tier, key)
        self._buckets[bucket_key] = TokenBucket(
            max_tokens=max_rps * burst / max_rps + burst,
            refill_rate=max_rps,
        )
        if len(self._buckets) > self._MAX_BUCKETS:
            sorted_buckets = sorted(self._buckets.items(), key=lambda x: x[1].last_refill)
            to_remove = sorted_buckets[: len(self._buckets) - (self._MAX_BUCKETS * 3 // 4)]
            for k, _ in to_remove:
                self._buckets.pop(k, None)
                self._specs.pop(k, None)
        self._specs[bucket_key] = RateLimitSpec(
            tier=tier,
            max_rps=max_rps,
            burst=burst,
            key=key,
            action=action,
        )

    def set_quota(
        self,
        key: str,
        limit: float,
        window_seconds: float = 60.0,
    ) -> None:
        """设置配额限制。

        Args:
            key: 配额键。
            limit: 限制量。
            window_seconds: 窗口大小（秒）。
        """
        self._quotas[key] = QuotaUsage(
            key=key,
            limit=limit,
            window_seconds=window_seconds,
        )
        if len(self._quotas) > self._MAX_QUOTAS:
            sorted_quotas = sorted(self._quotas.items(), key=lambda x: x[1].window_start)
            to_remove = sorted_quotas[: len(self._quotas) - (self._MAX_QUOTAS * 3 // 4)]
            for k, _ in to_remove:
                del self._quotas[k]

    def check(
        self,
        tier: RateTier,
        key: str = "",
        tokens: float = 1.0,
    ) -> RateCheckResult:
        """检查速率限制。

        Args:
            tier: 检查层级。
            key: 检查键。
            tokens: 需要消费的令牌数。

        Returns:
            RateCheckResult 检查结果。
        """
        bucket_key = self._make_key(tier, key)
        bucket = self._buckets.get(bucket_key)

        if bucket is None:
            return RateCheckResult(allowed=True, tier=tier, key=key)

        spec = self._specs.get(bucket_key, RateLimitSpec(tier=tier, max_rps=0))

        if bucket.try_consume(tokens):
            self._record_audit(tier, key, allowed=True)
            return RateCheckResult(allowed=True, tier=tier, key=key)

        wait = bucket.wait_time(tokens)
        self._record_audit(tier, key, allowed=False, wait=wait)

        return RateCheckResult(
            allowed=False,
            tier=tier,
            key=key,
            wait_seconds=wait,
            action=spec.action,
            reason=f"Rate limit exceeded for {tier.value}:{key}",
        )

    def check_quota(self, key: str, amount: float = 1.0) -> bool:
        """检查配额。

        Args:
            key: 配额键。
            amount: 使用量。

        Returns:
            是否在配额内。
        """
        quota = self._quotas.get(key)
        if quota is None:
            return True
        quota._check_window()
        if quota.used + amount <= quota.limit:
            quota.used += amount
            return True
        return False

    def get_quota_status(self, key: str) -> QuotaUsage | None:
        """获取配额状态。"""
        quota = self._quotas.get(key)
        if quota:
            quota._check_window()
        return quota

    def get_audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        """获取审计日志。"""
        return self._audit[-limit:]

    def _make_key(self, tier: RateTier, key: str = "") -> str:
        """生成桶键。"""
        if key:
            return f"{tier.value}:{key}"
        return tier.value

    def _record_audit(
        self, tier: RateTier, key: str, allowed: bool, wait: float = 0.0
    ) -> None:
        """记录审计日志。"""
        entry = {
            "tier": tier.value,
            "key": key,
            "allowed": allowed,
            "wait": round(wait, 3),
            "ts": time.time(),
        }
        self._audit.append(entry)
        if len(self._audit) > self._max_audit:
            self._audit = self._audit[-self._max_audit:]