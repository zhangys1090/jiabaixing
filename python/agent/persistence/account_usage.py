"""账户用量追踪。

追踪账户级别的 API 用量、成本和配额，提供用量报告和预算告警。
与 ModelCostGuard（模型级）互补，提供用户/账户维度的用量视图。

核心功能：
  - 按用户/账户追踪每日/每月用量
  - Token 消耗与成本统计
  - 预算告警（日/月/总预算）
  - 用量报告生成（JSON/文本）
  - 多用户隔离

集成示例::

    from agent.persistence.account_usage import AccountUsageTracker

    tracker = AccountUsageTracker()
    tracker.record("user_1", model="gpt-4o", input_tokens=1000, output_tokens=500)
    report = tracker.get_report_text("user_1")
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import StructuredLogger, log_ignored
from agent.infrastructure.safe_json import safe_json_loads
from agent.core.logger import StructuredLogger

log = StructuredLogger("account_usage")



class BudgetPeriod(str, Enum):
    DAILY = "daily"
    MONTHLY = "monthly"
    TOTAL = "total"


@dataclass
class UsageRecord:
    user_id: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    timestamp: float
    session_id: str = ""
    task_type: str = ""


@dataclass
class UserBudget:
    daily_usd: float = 2.0
    monthly_usd: float = 50.0
    total_usd: float = 1000.0
    daily_tokens: int = 500_000
    monthly_tokens: int = 10_000_000


@dataclass
class UsageSummary:
    user_id: str
    period: str
    total_calls: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    by_model: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_task: dict[str, int] = field(default_factory=dict)
    budget_pct: float = 0.0
    budget_remaining_usd: float = 0.0


@dataclass
class BudgetAlert:
    user_id: str
    period: BudgetPeriod
    pct: float
    message: str
    spent_usd: float = 0.0
    budget_usd: float = 0.0


class AccountUsageTracker:
    """账户用量追踪器。

    追踪用户级别的 API 用量和成本，提供预算告警和用量报告。
    """

    def __init__(self, persist_path: str | Path | None = None) -> None:
        self._path = Path(persist_path) if persist_path else DATA_DIR / "account_usage.json"
        self._records: dict[str, list[UsageRecord]] = defaultdict(list)
        self._budgets: dict[str, UserBudget] = {}
        self._default_budget = UserBudget()
        self._alert_callbacks: list[Any] = []
        self._MAX_USERS = 5000
        self._MAX_RECORDS_PER_USER = 10000
        self._MAX_ALERT_CALLBACKS = 20
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = self._path.read_text(encoding="utf-8")
        except OSError as _exc:
            log_ignored(log, "account_usage.AccountUsageTracker._load", _exc)
            return
        data = safe_json_loads(raw, {}, context="account_usage.load")
        if not isinstance(data, dict):
            # 顶层损坏：保留空用量状态，不再静默清空历史
            return
        # 逐条容错：单条损坏记录仅跳过，不再把整份用量历史静默丢弃
        for uid, records in data.get("records", {}).items():
            if not isinstance(records, list):
                continue
            loaded: list[UsageRecord] = []
            for r in records:
                if not isinstance(r, dict):
                    continue
                try:
                    loaded.append(UsageRecord(
                        user_id=r["user_id"],
                        model=r["model"],
                        input_tokens=r["input_tokens"],
                        output_tokens=r["output_tokens"],
                        cost_usd=r["cost_usd"],
                        timestamp=r["timestamp"],
                        session_id=r.get("session_id", ""),
                        task_type=r.get("task_type", ""),
                    ))
                except (KeyError, TypeError) as _exc:
                    log_ignored(log, "account_usage.AccountUsageTracker._load.record", _exc, uid=uid)
            if loaded:
                self._records[uid] = loaded
        for uid, b in data.get("budgets", {}).items():
            if not isinstance(b, dict):
                continue
            try:
                self._budgets[uid] = UserBudget(**b)
            except (TypeError, ValueError) as _exc:
                log_ignored(log, "account_usage.AccountUsageTracker._load.budget", _exc, uid=uid)

    def _save(self) -> None:
        try:
            records_data: dict[str, list[dict]] = {}
            for uid, records in self._records.items():
                records_data[uid] = [
                    {
                        "user_id": r.user_id,
                        "model": r.model,
                        "input_tokens": r.input_tokens,
                        "output_tokens": r.output_tokens,
                        "cost_usd": r.cost_usd,
                        "timestamp": r.timestamp,
                        "session_id": r.session_id,
                        "task_type": r.task_type,
                    }
                    for r in records
                ]
            budgets_data: dict[str, dict] = {}
            for uid, b in self._budgets.items():
                budgets_data[uid] = {
                    "daily_usd": b.daily_usd,
                    "monthly_usd": b.monthly_usd,
                    "total_usd": b.total_usd,
                    "daily_tokens": b.daily_tokens,
                    "monthly_tokens": b.monthly_tokens,
                }
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps({"records": records_data, "budgets": budgets_data}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            log.warning("用量数据保存失败", error=str(e))

    def set_budget(self, user_id: str, budget: UserBudget) -> None:
        self._budgets[user_id] = budget
        self._save()

    def on_budget_alert(self, callback: Any) -> None:
        if len(self._alert_callbacks) >= self._MAX_ALERT_CALLBACKS:
            self._alert_callbacks = self._alert_callbacks[-(self._MAX_ALERT_CALLBACKS * 3 // 4):]
        self._alert_callbacks.append(callback)

    def record(
        self,
        user_id: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float | None = None,
        session_id: str = "",
        task_type: str = "",
    ) -> UsageRecord:
        if cost_usd is None:
            cost_usd = input_tokens * 0.001 / 1000 + output_tokens * 0.003 / 1000

        rec = UsageRecord(
            user_id=user_id,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            timestamp=time.time(),
            session_id=session_id,
            task_type=task_type,
        )
        self._records[user_id].append(rec)
        if len(self._records[user_id]) > self._MAX_RECORDS_PER_USER:
            self._records[user_id] = self._records[user_id][-self._MAX_RECORDS_PER_USER * 3 // 4:]
        if len(self._records) > self._MAX_USERS:
            sorted_users = sorted(self._records.items(), key=lambda x: x[1][-1].timestamp if x[1] else 0)
            to_remove = sorted_users[: len(self._records) - (self._MAX_USERS * 3 // 4)]
            for uid, _ in to_remove:
                self._records.pop(uid, None)
                self._budgets.pop(uid, None)
        self._check_budget(user_id)
        self._save()
        return rec

    def _check_budget(self, user_id: str) -> None:
        budget = self._budgets.get(user_id, self._default_budget)
        daily_cost = self._get_period_cost(user_id, 86400)
        monthly_cost = self._get_period_cost(user_id, 30 * 86400)
        total_cost = sum(r.cost_usd for r in self._records.get(user_id, []))

        checks = [
            (BudgetPeriod.DAILY, daily_cost, budget.daily_usd),
            (BudgetPeriod.MONTHLY, monthly_cost, budget.monthly_usd),
            (BudgetPeriod.TOTAL, total_cost, budget.total_usd),
        ]
        for period, spent, limit in checks:
            if limit > 0 and spent / limit >= 1.0:
                alert = BudgetAlert(
                    user_id=user_id,
                    period=period,
                    pct=spent / limit,
                    message=f"{period.value}预算已超支: ${spent:.4f} / ${limit:.2f}",
                    spent_usd=spent,
                    budget_usd=limit,
                )
                for cb in self._alert_callbacks:
                    try:
                        cb(alert)
                    except Exception as _exc:
                        log.debug("account_usage 异常处理", error=str(_exc))
                        log_ignored(log, "account_usage.AccountUsageTracker._check_budget", _exc)

    def _get_period_cost(self, user_id: str, period_seconds: int) -> float:
        cutoff = time.time() - period_seconds
        return sum(r.cost_usd for r in self._records.get(user_id, []) if r.timestamp >= cutoff)

    def _get_period_records(self, user_id: str, period_seconds: int) -> list[UsageRecord]:
        cutoff = time.time() - period_seconds
        return [r for r in self._records.get(user_id, []) if r.timestamp >= cutoff]

    def get_daily_summary(self, user_id: str) -> UsageSummary:
        return self._build_summary(user_id, "daily", 86400)

    def get_monthly_summary(self, user_id: str) -> UsageSummary:
        return self._build_summary(user_id, "monthly", 30 * 86400)

    def _build_summary(self, user_id: str, period_name: str, period_seconds: int) -> UsageSummary:
        records = self._get_period_records(user_id, period_seconds)
        budget = self._budgets.get(user_id, self._default_budget)
        budget_limit = budget.daily_usd if period_name == "daily" else budget.monthly_usd

        by_model: dict[str, dict[str, Any]] = defaultdict(lambda: {"calls": 0, "tokens": 0, "cost": 0.0})
        by_task: dict[str, int] = defaultdict(int)

        for r in records:
            by_model[r.model]["calls"] += 1
            by_model[r.model]["tokens"] += r.input_tokens + r.output_tokens
            by_model[r.model]["cost"] += r.cost_usd
            if r.task_type:
                by_task[r.task_type] += 1

        total_cost = sum(r.cost_usd for r in records)
        total_input = sum(r.input_tokens for r in records)
        total_output = sum(r.output_tokens for r in records)

        return UsageSummary(
            user_id=user_id,
            period=period_name,
            total_calls=len(records),
            total_input_tokens=total_input,
            total_output_tokens=total_output,
            total_tokens=total_input + total_output,
            total_cost_usd=total_cost,
            by_model=dict(by_model),
            by_task=dict(by_task),
            budget_pct=total_cost / budget_limit if budget_limit > 0 else 0,
            budget_remaining_usd=max(0, budget_limit - total_cost),
        )

    def get_report_text(self, user_id: str) -> str:
        daily = self.get_daily_summary(user_id)
        monthly = self.get_monthly_summary(user_id)
        lines = [
            f"账户用量报告 - {user_id}",
            "",
            "今日用量:",
            f"  调用次数: {daily.total_calls}",
            f"  Token消耗: {daily.total_tokens:,} (输入{daily.total_input_tokens:,} + 输出{daily.total_output_tokens:,})",
            f"  费用: ${daily.total_cost_usd:.4f}",
            f"  预算使用: {daily.budget_pct:.1%} (剩余${daily.budget_remaining_usd:.2f})",
            "",
            "本月用量:",
            f"  调用次数: {monthly.total_calls}",
            f"  Token消耗: {monthly.total_tokens:,}",
            f"  费用: ${monthly.total_cost_usd:.4f}",
            f"  预算使用: {monthly.budget_pct:.1%} (剩余${monthly.budget_remaining_usd:.2f})",
        ]
        if daily.by_model:
            lines.append("")
            lines.append("按模型分布(今日):")
            for model, stats in daily.by_model.items():
                lines.append(f"  {model}: {stats['calls']}次, {stats['tokens']:,}tokens, ${stats['cost']:.4f}")
        return "\n".join(lines)

    def cleanup(self, max_age_days: int = 90) -> int:
        cutoff = time.time() - max_age_days * 86400
        removed = 0
        for uid in list(self._records.keys()):
            original = len(self._records[uid])
            self._records[uid] = [r for r in self._records[uid] if r.timestamp >= cutoff]
            removed += original - len(self._records[uid])
        if removed > 0:
            self._save()
        return removed
