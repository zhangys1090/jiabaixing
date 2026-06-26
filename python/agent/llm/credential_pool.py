from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR


class RotationStrategy(str, Enum):
    FILL_FIRST = "fill_first"
    ROUND_ROBIN = "round_robin"
    LEAST_USED = "least_used"
    RANDOM = "random"


@dataclass
class CredentialEntry:
    key: str
    weight: float = 1.0
    label: str = ""

    @property
    def masked(self) -> str:
        if len(self.key) <= 8:
            return "***"
        return self.key[:4] + "..." + self.key[-4:]


@dataclass
class CredentialState:
    entry: CredentialEntry
    failure_count: int = 0
    rate_limited_until: float = 0.0
    total_requests: int = 0
    last_used: float = 0.0

    @property
    def is_available(self) -> bool:
        if self.failure_count >= 3:
            return False
        if self.rate_limited_until > time.time():
            return False
        return True


class CredentialPool:
    def __init__(
        self,
        provider_name: str,
        entries: list[CredentialEntry],
        strategy: RotationStrategy = RotationStrategy.FILL_FIRST,
    ) -> None:
        self.provider_name = provider_name
        self._strategy = strategy
        self._states: list[CredentialState] = [
            CredentialState(entry=e) for e in entries
        ]
        self._round_robin_index: int = 0

    def get_next(self) -> CredentialEntry:
        available = self._get_available()
        if not available:
            self._force_reset()
            available = self._states

        if self._strategy == RotationStrategy.ROUND_ROBIN:
            return self._select_round_robin(available)
        elif self._strategy == RotationStrategy.LEAST_USED:
            return self._select_least_used(available)
        elif self._strategy == RotationStrategy.RANDOM:
            return self._select_random(available)
        else:
            return self._select_fill_first(available)

    def report_rate_limit(self, key: str, retry_after: float | None = None) -> None:
        state = self._find_by_key(key)
        if state:
            if retry_after is not None:
                if retry_after <= time.time():
                    return
                state.rate_limited_until = retry_after
            else:
                state.rate_limited_until = time.time() + 60

    def report_failure(self, key: str) -> None:
        state = self._find_by_key(key)
        if state:
            state.failure_count += 1

    def report_success(self, key: str) -> None:
        state = self._find_by_key(key)
        if state:
            state.failure_count = 0
            state.total_requests += 1
            state.last_used = time.time()

    @property
    def size(self) -> int:
        return len(self._states)

    @property
    def available_size(self) -> int:
        return len(self._get_available())

    def get_available_credentials(self) -> list[CredentialEntry]:
        return [s.entry for s in self._get_available()]

    def get_stats(self) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "strategy": self._strategy,
            "total": self.size,
            "available": self.available_size,
            "credentials": [
                {
                    "key": s.entry.masked,
                    "available": s.is_available,
                    "failure_count": s.failure_count,
                    "total_requests": s.total_requests,
                    "rate_limited": s.rate_limited_until > time.time(),
                }
                for s in self._states
            ],
        }

    def _get_available(self) -> list[CredentialState]:
        return [s for s in self._states if s.is_available]

    def _find_by_key(self, key: str) -> CredentialState | None:
        for s in self._states:
            if s.entry.key == key:
                return s
        return None

    def _force_reset(self) -> None:
        for s in self._states:
            s.failure_count = 0
            s.rate_limited_until = 0.0

    def _select_fill_first(self, available: list[CredentialState]) -> CredentialEntry:
        return available[0].entry

    def _select_round_robin(self, available: list[CredentialState]) -> CredentialEntry:
        self._round_robin_index = self._round_robin_index % len(available)
        entry = available[self._round_robin_index].entry
        self._round_robin_index += 1
        return entry

    def _select_least_used(self, available: list[CredentialState]) -> CredentialEntry:
        available.sort(key=lambda s: s.total_requests)
        return available[0].entry

    def _select_random(self, available: list[CredentialState]) -> CredentialEntry:
        import random
        total_weight = sum(s.entry.weight for s in available)
        r = random.random() * total_weight
        for s in available:
            r -= s.entry.weight
            if r <= 0:
                return s.entry
        return available[0].entry


@dataclass
class UsageRecord:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    timestamp: float = 0.0


_MODEL_PRICING: dict[str, dict[str, float]] = {
    "gpt-4o": {"input": 2.50 / 1_000_000, "output": 10.00 / 1_000_000},
    "gpt-4o-mini": {"input": 0.15 / 1_000_000, "output": 0.60 / 1_000_000},
    "gpt-4-turbo": {"input": 10.00 / 1_000_000, "output": 30.00 / 1_000_000},
    "gpt-4": {"input": 30.00 / 1_000_000, "output": 60.00 / 1_000_000},
    "gpt-3.5-turbo": {"input": 0.50 / 1_000_000, "output": 1.50 / 1_000_000},
    "claude-3.5-sonnet": {"input": 3.00 / 1_000_000, "output": 15.00 / 1_000_000},
    "claude-3.5-haiku": {"input": 0.80 / 1_000_000, "output": 4.00 / 1_000_000},
    "claude-3-opus": {"input": 15.00 / 1_000_000, "output": 75.00 / 1_000_000},
    "claude-3-haiku": {"input": 0.25 / 1_000_000, "output": 1.25 / 1_000_000},
    "claude-3-sonnet": {"input": 3.00 / 1_000_000, "output": 15.00 / 1_000_000},
    "gemini-pro": {"input": 0.50 / 1_000_000, "output": 1.50 / 1_000_000},
    "gemini-1.5-pro": {"input": 3.50 / 1_000_000, "output": 10.50 / 1_000_000},
    "gemini-1.5-flash": {"input": 0.075 / 1_000_000, "output": 0.30 / 1_000_000},
    "gemini-2.0-flash": {"input": 0.10 / 1_000_000, "output": 0.40 / 1_000_000},
    "deepseek-chat": {"input": 0.14 / 1_000_000, "output": 0.28 / 1_000_000},
    "deepseek-reasoner": {"input": 0.55 / 1_000_000, "output": 2.19 / 1_000_000},
    "qwen-plus": {"input": 0.80 / 1_000_000, "output": 2.00 / 1_000_000},
    "qwen-turbo": {"input": 0.30 / 1_000_000, "output": 0.60 / 1_000_000},
    "qwen-max": {"input": 2.40 / 1_000_000, "output": 9.60 / 1_000_000},
    "glm-4": {"input": 1.50 / 1_000_000, "output": 1.50 / 1_000_000},
    "glm-4-flash": {"input": 0.10 / 1_000_000, "output": 0.10 / 1_000_000},
    "mimo-7b": {"input": 0.10 / 1_000_000, "output": 0.10 / 1_000_000},
}


class BudgetAlertLevel(str, Enum):
    NORMAL = "normal"
    WARNING = "warning"
    CRITICAL = "critical"
    EXCEEDED = "exceeded"


@dataclass
class BudgetAlert:
    level: BudgetAlertLevel
    message: str
    spent_usd: float
    budget_usd: float
    pct: float


@dataclass
class ModelCostEstimate:
    model: str
    estimated_input_tokens: int
    estimated_output_tokens: int
    estimated_cost_usd: float
    within_budget: bool


class CostGuard:
    def __init__(
        self,
        daily_budget_usd: float = 1.0,
        per_request_budget_usd: float = 0.05,
        warning_threshold: float = 0.7,
        critical_threshold: float = 0.9,
    ) -> None:
        self._daily_budget = daily_budget_usd
        self._per_request_budget = per_request_budget_usd
        self._warning_threshold = warning_threshold
        self._critical_threshold = critical_threshold
        self._records: list[UsageRecord] = []
        self._daily_reset: float = time.time()
        self._alert_callbacks: list[Any] = []

    def on_budget_alert(self, callback: Any) -> None:
        self._alert_callbacks.append(callback)

    def check_budget_alert(self) -> BudgetAlert:
        self._check_daily_reset()
        spent = self.get_daily_spent()
        pct = spent / self._daily_budget if self._daily_budget > 0 else 0

        if pct >= 1.0:
            alert = BudgetAlert(
                level=BudgetAlertLevel.EXCEEDED,
                message=f"预算已超支: ${spent:.4f} / ${self._daily_budget:.2f}",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )
        elif pct >= self._critical_threshold:
            alert = BudgetAlert(
                level=BudgetAlertLevel.CRITICAL,
                message=f"预算即将耗尽: ${spent:.4f} / ${self._daily_budget:.2f} ({pct:.0%})",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )
        elif pct >= self._warning_threshold:
            alert = BudgetAlert(
                level=BudgetAlertLevel.WARNING,
                message=f"预算使用过半: ${spent:.4f} / ${self._daily_budget:.2f} ({pct:.0%})",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )
        else:
            alert = BudgetAlert(
                level=BudgetAlertLevel.NORMAL,
                message="预算正常",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )

        for cb in self._alert_callbacks:
            try:
                cb(alert)
            except Exception:
                pass
        return alert

    def estimate_request_cost(
        self,
        model: str,
        estimated_input_tokens: int,
        estimated_output_tokens: int | None = None,
    ) -> ModelCostEstimate:
        if estimated_output_tokens is None:
            estimated_output_tokens = min(estimated_input_tokens, self._per_request_budget / max(self.calculate_cost(model, 1, 1), 0.000001))

        estimated_cost = self.calculate_cost(model, estimated_input_tokens, estimated_output_tokens)
        within = self.check_budget(estimated_cost)

        return ModelCostEstimate(
            model=model,
            estimated_input_tokens=estimated_input_tokens,
            estimated_output_tokens=estimated_output_tokens,
            estimated_cost_usd=estimated_cost,
            within_budget=within,
        )

    @staticmethod
    def get_model_pricing(model: str) -> dict[str, float] | None:
        return _MODEL_PRICING.get(model)

    @staticmethod
    def list_priced_models() -> list[str]:
        return list(_MODEL_PRICING.keys())

    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        pricing = _MODEL_PRICING.get(model)
        if not pricing:
            pricing = {"input": 1.0 / 1_000_000, "output": 3.0 / 1_000_000}
        return input_tokens * pricing["input"] + output_tokens * pricing["output"]

    def record_usage(self, model: str, input_tokens: int, output_tokens: int) -> UsageRecord:
        self._check_daily_reset()
        cost = self.calculate_cost(model, input_tokens, output_tokens)
        record = UsageRecord(
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost,
            timestamp=time.time(),
        )
        self._records.append(record)
        return record

    def check_budget(self, estimated_cost: float) -> bool:
        self._check_daily_reset()
        daily_spent = self.get_daily_spent()
        if daily_spent + estimated_cost > self._daily_budget:
            return False
        if estimated_cost > self._per_request_budget:
            return False
        return True

    def get_daily_spent(self) -> float:
        return sum(r.cost_usd for r in self._records)

    def get_daily_stats(self) -> dict[str, Any]:
        self._check_daily_reset()
        total_input = sum(r.input_tokens for r in self._records)
        total_output = sum(r.output_tokens for r in self._records)
        total_cost = sum(r.cost_usd for r in self._records)
        by_model: dict[str, dict[str, float]] = {}
        for r in self._records:
            if r.model not in by_model:
                by_model[r.model] = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
            by_model[r.model]["input_tokens"] += r.input_tokens
            by_model[r.model]["output_tokens"] += r.output_tokens
            by_model[r.model]["cost_usd"] += r.cost_usd
        return {
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "total_cost_usd": round(total_cost, 6),
            "daily_budget_usd": self._daily_budget,
            "budget_remaining_usd": round(self._daily_budget - total_cost, 6),
            "budget_used_pct": round(total_cost / self._daily_budget * 100, 1) if self._daily_budget > 0 else 0,
            "request_count": len(self._records),
            "by_model": by_model,
        }

    def set_daily_budget(self, budget_usd: float) -> None:
        self._daily_budget = budget_usd

    def _check_daily_reset(self) -> None:
        now = time.time()
        if now - self._daily_reset > 86400:
            self._records = []
            self._daily_reset = now
