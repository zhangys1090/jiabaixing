"""模型级别成本守卫。

在 CostGuard（凭据池级预算）之上，提供模型粒度的成本控制：
  - 每模型每日/每小时用量追踪
  - 昂贵模型自动降级到廉价替代
  - 用户可设单模型预算上限
  - 超预算时自动切换到低成本模型

与 agent.llm.credential_pool.CostGuard 的关系：
  - CostGuard 管理全局/凭据池级预算
  - ModelCostGuard 管理模型级预算，更精细

集成示例::

    from agent.llm.model_cost_guard import ModelCostGuard

    guard = ModelCostGuard()
    guard.set_model_budget("claude-3-opus", daily_usd=0.50)
    check = guard.check_before_call("claude-3-opus", estimated_tokens=2000)
    if not check.allowed:
        model = check.fallback_model  # "claude-3-haiku"
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("model_cost_guard")


class BudgetLevel(str, Enum):
    NORMAL = "normal"
    WARNING = "warning"
    CRITICAL = "critical"
    EXCEEDED = "exceeded"


@dataclass
class ModelPricing:
    input_per_m: float
    output_per_m: float
    fallback_model: str = ""
    category: str = "standard"


_MODEL_PRICING: dict[str, ModelPricing] = {
    "claude-sonnet-4-20250514": ModelPricing(3.0, 15.0, "claude-3-haiku-20240307", "premium"),
    "anthropic/claude-sonnet-4-20250514": ModelPricing(3.0, 15.0, "anthropic/claude-3-haiku-20240307", "premium"),
    "claude-3-opus-20240229": ModelPricing(15.0, 75.0, "claude-sonnet-4-20250514", "expensive"),
    "anthropic/claude-3-opus-20240229": ModelPricing(15.0, 75.0, "anthropic/claude-sonnet-4-20250514", "expensive"),
    "claude-3-haiku-20240307": ModelPricing(0.25, 1.25, "", "cheap"),
    "anthropic/claude-3-haiku-20240307": ModelPricing(0.25, 1.25, "", "cheap"),
    "gpt-4o": ModelPricing(2.5, 10.0, "gpt-4o-mini", "premium"),
    "openai/gpt-4o": ModelPricing(2.5, 10.0, "openai/gpt-4o-mini", "premium"),
    "gpt-4o-mini": ModelPricing(0.15, 0.60, "", "cheap"),
    "openai/gpt-4o-mini": ModelPricing(0.15, 0.60, "", "cheap"),
    "gemini-2.0-flash": ModelPricing(0.10, 0.40, "", "cheap"),
    "gemini/gemini-2.0-flash": ModelPricing(0.10, 0.40, "", "cheap"),
    "deepseek-chat": ModelPricing(0.14, 0.28, "", "cheap"),
    "deepseek/deepseek-chat": ModelPricing(0.14, 0.28, "", "cheap"),
    "deepseek-v4-flash": ModelPricing(0.14, 0.28, "", "cheap"),
    "deepseek/deepseek-v4-flash": ModelPricing(0.14, 0.28, "", "cheap"),
    "deepseek-v4-pro": ModelPricing(0.42, 0.83, "deepseek-v4-flash", "standard"),
    "deepseek/deepseek-v4-pro": ModelPricing(0.42, 0.83, "deepseek/deepseek-v4-flash", "standard"),
}


@dataclass
class ModelUsageRecord:
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    timestamp: float


@dataclass
class ModelBudgetConfig:
    daily_usd: float = 1.0
    hourly_usd: float = 0.20
    warning_pct: float = 0.7
    critical_pct: float = 0.9


@dataclass
class CostCheckResult:
    allowed: bool
    model: str
    estimated_cost_usd: float
    budget_level: BudgetLevel
    fallback_model: str = ""
    reason: str = ""


@dataclass
class ModelCostSummary:
    model: str
    total_calls: int
    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    daily_cost_usd: float
    hourly_cost_usd: float
    budget_pct: float


class ModelCostGuard:
    """模型级别成本守卫。

    追踪每个模型的用量，在超预算时自动降级到廉价替代模型。
    """

    def __init__(self) -> None:
        self._budgets: dict[str, ModelBudgetConfig] = {}
        self._usage: dict[str, list[ModelUsageRecord]] = defaultdict(list)
        self._default_budget = ModelBudgetConfig()
        self._global_daily_budget: float = 5.0
        self._alert_callbacks: list[Any] = []

    def set_model_budget(self, model: str, daily_usd: float = 1.0, hourly_usd: float = 0.20) -> None:
        self._budgets[model] = ModelBudgetConfig(daily_usd=daily_usd, hourly_usd=hourly_usd)

    def set_global_daily_budget(self, budget_usd: float) -> None:
        self._global_daily_budget = budget_usd

    def on_alert(self, callback: Any) -> None:
        self._alert_callbacks.append(callback)

    def estimate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        pricing = _MODEL_PRICING.get(model)
        if not pricing:
            pricing = ModelPricing(1.0 / 1_000_000, 3.0 / 1_000_000)
        return (
            input_tokens * pricing.input_per_m / 1_000_000
            + output_tokens * pricing.output_per_m / 1_000_000
        )

    def record_usage(self, model: str, input_tokens: int, output_tokens: int) -> float:
        cost = self.estimate_cost(model, input_tokens, output_tokens)
        record = ModelUsageRecord(
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost,
            timestamp=time.time(),
        )
        self._usage[model].append(record)
        return cost

    def _get_daily_cost(self, model: str) -> float:
        now = time.time()
        day_ago = now - 86400
        return sum(r.cost_usd for r in self._usage[model] if r.timestamp >= day_ago)

    def _get_hourly_cost(self, model: str) -> float:
        now = time.time()
        hour_ago = now - 3600
        return sum(r.cost_usd for r in self._usage[model] if r.timestamp >= hour_ago)

    def _get_global_daily_cost(self) -> float:
        now = time.time()
        day_ago = now - 86400
        total = 0.0
        for records in self._usage.values():
            total += sum(r.cost_usd for r in records if r.timestamp >= day_ago)
        return total

    def check_before_call(
        self,
        model: str,
        estimated_input_tokens: int = 1000,
        estimated_output_tokens: int = 500,
    ) -> CostCheckResult:
        estimated_cost = self.estimate_cost(model, estimated_input_tokens, estimated_output_tokens)

        global_daily = self._get_global_daily_cost()
        if global_daily + estimated_cost > self._global_daily_budget:
            fallback = _MODEL_PRICING.get(model, ModelPricing(0, 0)).fallback_model
            return CostCheckResult(
                allowed=False,
                model=model,
                estimated_cost_usd=estimated_cost,
                budget_level=BudgetLevel.EXCEEDED,
                fallback_model=fallback,
                reason=f"全局日预算超支: ${global_daily:.4f} + ${estimated_cost:.4f} > ${self._global_daily_budget:.2f}",
            )

        budget = self._budgets.get(model, self._default_budget)
        daily_cost = self._get_daily_cost(model)
        hourly_cost = self._get_hourly_cost(model)

        if daily_cost + estimated_cost > budget.daily_usd:
            fallback = _MODEL_PRICING.get(model, ModelPricing(0, 0)).fallback_model
            level = BudgetLevel.EXCEEDED
            reason = f"模型日预算超支: ${daily_cost:.4f} + ${estimated_cost:.4f} > ${budget.daily_usd:.2f}"
        elif hourly_cost + estimated_cost > budget.hourly_usd:
            fallback = _MODEL_PRICING.get(model, ModelPricing(0, 0)).fallback_model
            level = BudgetLevel.CRITICAL
            reason = f"模型小时预算超支: ${hourly_cost:.4f} + ${estimated_cost:.4f} > ${budget.hourly_usd:.2f}"
        else:
            daily_pct = (daily_cost + estimated_cost) / budget.daily_usd if budget.daily_usd > 0 else 0
            if daily_pct >= budget.critical_pct:
                level = BudgetLevel.CRITICAL
            elif daily_pct >= budget.warning_pct:
                level = BudgetLevel.WARNING
            else:
                level = BudgetLevel.NORMAL
            fallback = ""
            reason = ""

        allowed = level not in (BudgetLevel.EXCEEDED,)

        if not allowed:
            for cb in self._alert_callbacks:
                try:
                    cb(model, level, reason)
                except Exception as _exc:
                    log_ignored(log, "model_cost_guard.ModelCostGuard.check_before_call", _exc)
            log.warning("模型成本守卫触发", model=model, level=level.value, reason=reason)

        return CostCheckResult(
            allowed=allowed,
            model=model,
            estimated_cost_usd=estimated_cost,
            budget_level=level,
            fallback_model=fallback,
            reason=reason,
        )

    def get_summary(self, model: str) -> ModelCostSummary:
        records = self._usage.get(model, [])
        budget = self._budgets.get(model, self._default_budget)
        total_cost = sum(r.cost_usd for r in records)
        daily_cost = self._get_daily_cost(model)
        hourly_cost = self._get_hourly_cost(model)
        return ModelCostSummary(
            model=model,
            total_calls=len(records),
            total_input_tokens=sum(r.input_tokens for r in records),
            total_output_tokens=sum(r.output_tokens for r in records),
            total_cost_usd=total_cost,
            daily_cost_usd=daily_cost,
            hourly_cost_usd=hourly_cost,
            budget_pct=daily_cost / budget.daily_usd if budget.daily_usd > 0 else 0,
        )

    def get_all_summaries(self) -> list[ModelCostSummary]:
        return [self.get_summary(m) for m in self._usage]

    def cleanup_old_records(self, max_age_days: int = 7) -> int:
        cutoff = time.time() - max_age_days * 86400
        removed = 0
        for model in list(self._usage.keys()):
            original = len(self._usage[model])
            self._usage[model] = [r for r in self._usage[model] if r.timestamp >= cutoff]
            removed += original - len(self._usage[model])
        return removed
