"""预算/用量控制模块——管理 LLM 调用的 Token 与费用预算。

提供 BudgetGuard 类，支持按日/周/月周期检查预算、记录用量、
超限拦截与阈值告警，防止意外超支。

Usage:
    guard = BudgetGuard()
    result = guard.check_budget(estimated_tokens=500, estimated_cost=0.01)
    if not result.allowed:
        print(f"预算超限: {result.reason}")
    guard.record_usage(tokens_used=500, cost_usd=0.01, model="gpt-4o")
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum


class BudgetPeriod(str, Enum):
    """预算周期枚举。

    Attributes:
        DAILY: 每日预算周期。
        WEEKLY: 每周预算周期。
        MONTHLY: 每月预算周期。
    """

    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


@dataclass
class BudgetConfig:
    """预算配置。

    Attributes:
        max_tokens_per_period: 每周期最大 Token 数。
        max_cost_usd_per_period: 每周期最大费用（美元）。
        period: 预算周期类型。
        warning_threshold: 告警阈值（0-1），默认 0.8（80%）。
        enabled: 是否启用预算控制，默认 True。
    """

    max_tokens_per_period: int = 500_000
    max_cost_usd_per_period: float = 10.0
    period: BudgetPeriod = BudgetPeriod.DAILY
    warning_threshold: float = 0.8
    enabled: bool = True


@dataclass
class UsageRecord:
    """用量记录。

    Attributes:
        timestamp: 记录时间戳（秒）。
        tokens_used: 消耗的 Token 数。
        cost_usd: 费用（美元）。
        model: 使用的模型名称。
        provider: LLM 提供商名称。
    """

    timestamp: float
    tokens_used: int
    cost_usd: float
    model: str = ""
    provider: str = ""


@dataclass
class BudgetCheckResult:
    """预算检查结果。

    Attributes:
        allowed: 是否允许本次请求。
        reason: 拒绝原因（allowed=False 时有效）。
        remaining_tokens: 剩余可用 Token 数。
        remaining_cost: 剩余可用费用（美元）。
        usage_percentage: 当前用量百分比（0-1）。
    """

    allowed: bool
    reason: str = ""
    remaining_tokens: int = 0
    remaining_cost: float = 0.0
    usage_percentage: float = 0.0


def _period_start(period: BudgetPeriod) -> float:
    """计算当前周期的起始时间戳。

    Args:
        period: 预算周期类型。

    Returns:
        float: 当前周期起始时间戳（秒）。
    """
    now = time.time()
    if period == BudgetPeriod.DAILY:
        # 当天 00:00:00 本地时间的近似值：按 86400 秒取整
        return now - (now % 86400)
    elif period == BudgetPeriod.WEEKLY:
        return now - (now % (86400 * 7))
    else:  # MONTHLY
        return now - (now % (86400 * 30))


class BudgetGuard:
    """预算守卫——管理 LLM 调用的 Token 与费用预算。

    支持按日/周/月周期检查预算、记录用量、超限拦截与阈值告警。

    Attributes:
        _config: 当前预算配置。
        _records: 当前周期内的用量记录列表。
        _period_start: 当前周期的起始时间戳。

    Usage:
        guard = BudgetGuard()
        result = guard.check_budget(estimated_tokens=500)
        guard.record_usage(tokens_used=500, cost_usd=0.01)
    """

    def __init__(self, config: BudgetConfig | None = None) -> None:
        """初始化预算守卫。

        Args:
            config: 预算配置，默认为每日 50 万 Token / 10 美元。
        """
        self._config: BudgetConfig = config or BudgetConfig()
        self._records: list[UsageRecord] = []
        self._period_start: float = _period_start(self._config.period)

    def _ensure_period(self) -> None:
        """检查是否需要切换到新的预算周期。"""
        current_start = _period_start(self._config.period)
        if current_start > self._period_start:
            self._records.clear()
            self._period_start = current_start

    def _total_tokens(self) -> int:
        """计算当前周期已用 Token 总数。"""
        return sum(r.tokens_used for r in self._records)

    def _total_cost(self) -> float:
        """计算当前周期已用费用总和。"""
        return sum(r.cost_usd for r in self._records)

    def check_budget(
        self,
        estimated_tokens: int = 0,
        estimated_cost: float = 0.0,
    ) -> BudgetCheckResult:
        """检查本次请求是否在预算范围内。

        若预算控制未启用，直接放行。

        Args:
            estimated_tokens: 预估 Token 消耗量。
            estimated_cost: 预估费用（美元）。

        Returns:
            BudgetCheckResult: 检查结果，包含是否允许、剩余额度等信息。
        """
        if not self._config.enabled:
            return BudgetCheckResult(
                allowed=True,
                reason="预算控制未启用",
                remaining_tokens=-1,
                remaining_cost=-1.0,
                usage_percentage=0.0,
            )

        self._ensure_period()

        used_tokens = self._total_tokens()
        used_cost = self._total_cost()
        remaining_tokens = max(0, self._config.max_tokens_per_period - used_tokens)
        remaining_cost = max(0.0, self._config.max_cost_usd_per_period - used_cost)

        # 计算用量百分比（取 Token 和费用中较高的比例）
        token_pct = (
            (used_tokens + estimated_tokens) / self._config.max_tokens_per_period
            if self._config.max_tokens_per_period > 0
            else 0.0
        )
        cost_pct = (
            (used_cost + estimated_cost) / self._config.max_cost_usd_per_period
            if self._config.max_cost_usd_per_period > 0
            else 0.0
        )
        usage_percentage = min(max(token_pct, cost_pct), 1.0)

        # 检查是否超限
        if (used_tokens + estimated_tokens) > self._config.max_tokens_per_period:
            return BudgetCheckResult(
                allowed=False,
                reason=f"Token 预算超限: 已用 {used_tokens}, "
                f"预估 {estimated_tokens}, 上限 {self._config.max_tokens_per_period}",
                remaining_tokens=remaining_tokens,
                remaining_cost=remaining_cost,
                usage_percentage=usage_percentage,
            )

        if (used_cost + estimated_cost) > self._config.max_cost_usd_per_period:
            return BudgetCheckResult(
                allowed=False,
                reason=f"费用预算超限: 已用 ${used_cost:.4f}, "
                f"预估 ${estimated_cost:.4f}, 上限 ${self._config.max_cost_usd_per_period:.2f}",
                remaining_tokens=remaining_tokens,
                remaining_cost=remaining_cost,
                usage_percentage=usage_percentage,
            )

        return BudgetCheckResult(
            allowed=True,
            reason="",
            remaining_tokens=remaining_tokens - estimated_tokens,
            remaining_cost=remaining_cost - estimated_cost,
            usage_percentage=usage_percentage,
        )

    def record_usage(
        self,
        tokens_used: int,
        cost_usd: float,
        model: str = "",
        provider: str = "",
    ) -> None:
        """记录一次用量。

        Args:
            tokens_used: 实际消耗的 Token 数。
            cost_usd: 实际费用（美元）。
            model: 使用的模型名称。
            provider: LLM 提供商名称。
        """
        self._ensure_period()
        self._records.append(
            UsageRecord(
                timestamp=time.time(),
                tokens_used=tokens_used,
                cost_usd=cost_usd,
                model=model,
                provider=provider,
            )
        )

    def get_usage_summary(self) -> dict:
        """获取当前周期的用量摘要。

        Returns:
            dict: 包含已用 Token、已用费用、剩余 Token、剩余费用和用量百分比。
        """
        self._ensure_period()
        used_tokens = self._total_tokens()
        used_cost = self._total_cost()
        remaining_tokens = max(0, self._config.max_tokens_per_period - used_tokens)
        remaining_cost = max(0.0, self._config.max_cost_usd_per_period - used_cost)

        token_pct = (
            used_tokens / self._config.max_tokens_per_period
            if self._config.max_tokens_per_period > 0
            else 0.0
        )
        cost_pct = (
            used_cost / self._config.max_cost_usd_per_period
            if self._config.max_cost_usd_per_period > 0
            else 0.0
        )

        return {
            "period": self._config.period.value,
            "used_tokens": used_tokens,
            "used_cost_usd": round(used_cost, 6),
            "remaining_tokens": remaining_tokens,
            "remaining_cost_usd": round(remaining_cost, 6),
            "usage_percentage": round(max(token_pct, cost_pct), 4),
            "records_count": len(self._records),
        }

    def reset_usage(self) -> None:
        """重置当前周期的用量记录。"""
        self._records.clear()
        self._period_start = _period_start(self._config.period)

    def set_budget(self, config: BudgetConfig) -> None:
        """更新预算配置。

        更新后会自动重置用量记录以匹配新周期。

        Args:
            config: 新的预算配置。
        """
        self._config = config
        self.reset_usage()

    def get_remaining_budget(self) -> dict:
        """获取剩余预算。

        Returns:
            dict: 包含剩余 Token 和剩余费用。
        """
        self._ensure_period()
        used_tokens = self._total_tokens()
        used_cost = self._total_cost()
        return {
            "remaining_tokens": max(0, self._config.max_tokens_per_period - used_tokens),
            "remaining_cost_usd": round(
                max(0.0, self._config.max_cost_usd_per_period - used_cost), 6
            ),
        }

    def is_within_budget(self) -> bool:
        """判断当前用量是否在预算范围内。

        Returns:
            bool: True 表示未超限，False 表示已超限。
        """
        self._ensure_period()
        return (
            self._total_tokens() <= self._config.max_tokens_per_period
            and self._total_cost() <= self._config.max_cost_usd_per_period
        )

    def should_warn(self) -> bool:
        """判断当前用量是否超过告警阈值。

        当 Token 或费用使用量超过配置的 warning_threshold（默认 80%）时返回 True。

        Returns:
            bool: True 表示需要告警。
        """
        self._ensure_period()
        used_tokens = self._total_tokens()
        used_cost = self._total_cost()
        token_pct = (
            used_tokens / self._config.max_tokens_per_period
            if self._config.max_tokens_per_period > 0
            else 0.0
        )
        cost_pct = (
            used_cost / self._config.max_cost_usd_per_period
            if self._config.max_cost_usd_per_period > 0
            else 0.0
        )
        return max(token_pct, cost_pct) >= self._config.warning_threshold
