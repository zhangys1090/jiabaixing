"""Token 预算感知调度器（Budget-Aware Scheduler）。

在 TokenBudgetManager（预算分配）基础上，增强为：
1. 预算感知任务调度：根据子Agent预算余额决定任务分配优先级
2. 预算预测：基于历史消耗预测剩余步骤的Token需求
3. 预算不足降级：预算不足时自动降级到低成本模型或简化任务
4. 预算弹性分配：根据任务实际消耗动态调整子Agent配额
5. 预算消耗可视化：生成预算消耗报告

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 LoopController/Executor 集成，在任务编排时注入预算感知
- 非侵入式：未挂载时回退到 TokenBudgetManager
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.llm.token_budget_manager import TokenBudgetManager, SessionBudget
from agent.core.logger import StructuredLogger
log = StructuredLogger("budget_aware_scheduler")



class BudgetAction(str, Enum):
    ALLOW = "allow"
    DOWNGRADE_MODEL = "downgrade_model"
    SIMPLIFY_TASK = "simplify_task"
    QUEUE_UNTIL_REFILL = "queue_until_refill"
    REJECT = "reject"


class BudgetPriority(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"
    DEFERRABLE = "deferrable"


@dataclass
class TaskBudgetRequest:
    task_id: str = ""
    sub_agent_id: str = ""
    estimated_tokens: int = 0
    priority: BudgetPriority = BudgetPriority.NORMAL
    model_preference: str = ""
    tool_name: str = ""
    step_count: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TaskBudgetDecision:
    action: BudgetAction = BudgetAction.ALLOW
    allocated_tokens: int = 0
    allocated_model: str = ""
    remaining_budget_pct: float = 1.0
    reason: str = ""
    alternative_model: str = ""
    simplified: bool = False


@dataclass
class BudgetPrediction:
    total_budget: int = 0
    consumed_tokens: int = 0
    remaining_tokens: int = 0
    remaining_percentage: float = 1.0
    predicted_remaining_steps: int = 0
    predicted_tokens_needed: int = 0
    budget_sufficient: bool = True
    deficit_tokens: int = 0
    recommended_action: BudgetAction = BudgetAction.ALLOW


@dataclass
class BudgetConsumptionRecord:
    task_id: str = ""
    sub_agent_id: str = ""
    allocated_tokens: int = 0
    consumed_tokens: int = 0
    model: str = ""
    priority: BudgetPriority = BudgetPriority.NORMAL
    timestamp: float = 0.0
    over_budget: bool = False


@dataclass
class BudgetReport:
    session_id: str = ""
    timestamp: float = 0.0
    total_budget: int = 0
    total_consumed: int = 0
    total_remaining: int = 0
    consumption_rate: float = 0.0
    sub_agent_breakdown: dict[str, dict[str, Any]] = field(default_factory=dict)
    predictions: BudgetPrediction = field(default_factory=BudgetPrediction)
    recommendations: list[str] = field(default_factory=list)


MODEL_COST_TIERS: dict[str, float] = {
    "openai/gpt-4o": 5.0,
    "openai/gpt-4o-mini": 0.15,
    "openai/o1": 15.0,
    "openai/o3-mini": 1.1,
    "anthropic/claude-3-5-sonnet": 3.0,
    "anthropic/claude-3-haiku-20240307": 0.25,
    "gemini/gemini-2.0-flash": 0.075,
    "deepseek/deepseek-v4-pro": 0.5,
    "deepseek/deepseek-v4-flash": 0.05,
    "ollama/qwen2.5": 0.0,
}

LOW_COST_MODELS: list[str] = [
    "ollama/qwen2.5",
    "deepseek/deepseek-v4-flash",
    "gemini/gemini-2.0-flash",
    "anthropic/claude-3-haiku-20240307",
]

PRIORITY_MULTIPLIER: dict[BudgetPriority, float] = {
    BudgetPriority.CRITICAL: 2.0,
    BudgetPriority.HIGH: 1.5,
    BudgetPriority.NORMAL: 1.0,
    BudgetPriority.LOW: 0.7,
    BudgetPriority.DEFERRABLE: 0.3,
}


class BudgetAwareScheduler:
    """Token 预算感知调度器：根据预算状态决定任务分配和模型选择。"""

    _instance: BudgetAwareScheduler | None = None

    def __init__(
        self,
        budget_manager: TokenBudgetManager | None = None,
        default_session_budget: int = 100000,
        critical_reserve_pct: float = 0.1,
        low_budget_threshold: float = 0.3,
    ) -> None:
        self._budget = budget_manager or TokenBudgetManager(default_session_budget)
        self._critical_reserve = critical_reserve_pct
        self._low_threshold = low_budget_threshold
        self._consumption_history: list[BudgetConsumptionRecord] = []
        self._sub_agent_allocations: dict[str, int] = {}
        self._sub_agent_consumed: dict[str, int] = {}
        self._max_history = 500
        self._MAX_SUB_AGENTS = 500

    @classmethod
    def get_instance(cls) -> BudgetAwareScheduler:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def schedule_task(self, request: TaskBudgetRequest) -> TaskBudgetDecision:
        prediction = self.predict_budget()

        if prediction.remaining_percentage > self._low_threshold:
            return self._allow_task(request, prediction)

        if request.priority in (BudgetPriority.CRITICAL, BudgetPriority.HIGH):
            if prediction.remaining_percentage > self._critical_reserve:
                return self._allow_task(request, prediction)
            return self._allow_with_downgrade(request, prediction)

        if prediction.remaining_percentage < self._critical_reserve:
            if request.priority == BudgetPriority.CRITICAL:
                return self._allow_with_downgrade(request, prediction)
            return TaskBudgetDecision(
                action=BudgetAction.REJECT,
                remaining_budget_pct=prediction.remaining_percentage,
                reason=f"预算不足 ({prediction.remaining_percentage:.1%})，仅保留给关键任务",
            )

        return self._allow_with_downgrade(request, prediction)

    def predict_budget(self) -> BudgetPrediction:
        status = self._budget.get_session_status()
        if not status:
            return BudgetPrediction()

        total = status.get("total_budget", 0)
        consumed = status.get("consumed_tokens", 0)
        remaining = total - consumed
        remaining_pct = remaining / total if total > 0 else 0.0

        avg_consumption = self._estimate_avg_consumption()
        predicted_steps = int(remaining / avg_consumption) if avg_consumption > 0 else 0
        predicted_needed = avg_consumption * max(predicted_steps, 1)

        budget_sufficient = remaining >= predicted_needed
        deficit = max(0, predicted_needed - remaining)

        if remaining_pct < self._critical_reserve:
            recommended = BudgetAction.DOWNGRADE_MODEL
        elif remaining_pct < self._low_threshold:
            recommended = BudgetAction.DOWNGRADE_MODEL
        else:
            recommended = BudgetAction.ALLOW

        return BudgetPrediction(
            total_budget=total,
            consumed_tokens=consumed,
            remaining_tokens=remaining,
            remaining_percentage=round(remaining_pct, 4),
            predicted_remaining_steps=predicted_steps,
            predicted_tokens_needed=predicted_needed,
            budget_sufficient=budget_sufficient,
            deficit_tokens=deficit,
            recommended_action=recommended,
        )

    def record_consumption(
        self,
        task_id: str,
        sub_agent_id: str,
        allocated_tokens: int,
        consumed_tokens: int,
        model: str = "",
        priority: BudgetPriority = BudgetPriority.NORMAL,
    ) -> None:
        record = BudgetConsumptionRecord(
            task_id=task_id,
            sub_agent_id=sub_agent_id,
            allocated_tokens=allocated_tokens,
            consumed_tokens=consumed_tokens,
            model=model,
            priority=priority,
            timestamp=time.time(),
            over_budget=consumed_tokens > allocated_tokens,
        )
        self._consumption_history.append(record)
        if len(self._consumption_history) > self._max_history:
            self._consumption_history = self._consumption_history[-self._max_history:]

        self._sub_agent_consumed[sub_agent_id] = (
            self._sub_agent_consumed.get(sub_agent_id, 0) + consumed_tokens
        )

    def generate_report(self, session_id: str = "") -> BudgetReport:
        prediction = self.predict_budget()
        status = self._budget.get_session_status() or {}

        sub_agent_breakdown: dict[str, dict[str, Any]] = {}
        for agent_id, allocated in self._sub_agent_allocations.items():
            consumed = self._sub_agent_consumed.get(agent_id, 0)
            sub_agent_breakdown[agent_id] = {
                "allocated": allocated,
                "consumed": consumed,
                "utilization": round(consumed / allocated, 3) if allocated > 0 else 0.0,
            }

        recommendations: list[str] = []
        if prediction.remaining_percentage < self._low_threshold:
            recommendations.append(f"预算剩余 {prediction.remaining_percentage:.1%}，建议降级到低成本模型")
        if prediction.deficit_tokens > 0:
            recommendations.append(f"预计缺口 {prediction.deficit_tokens} tokens，建议增加预算或简化任务")
        over_budget_count = sum(1 for r in self._consumption_history if r.over_budget)
        if over_budget_count > len(self._consumption_history) * 0.2:
            recommendations.append(f"{over_budget_count} 个任务超预算，建议调整配额分配")

        return BudgetReport(
            session_id=session_id,
            timestamp=time.time(),
            total_budget=status.get("total_budget", 0),
            total_consumed=status.get("consumed_tokens", 0),
            total_remaining=prediction.remaining_tokens,
            consumption_rate=round(1.0 - prediction.remaining_percentage, 4),
            sub_agent_breakdown=sub_agent_breakdown,
            predictions=prediction,
            recommendations=recommendations,
        )

    def _allow_task(self, request: TaskBudgetRequest, prediction: BudgetPrediction) -> TaskBudgetDecision:
        multiplier = PRIORITY_MULTIPLIER.get(request.priority, 1.0)
        allocated = int(request.estimated_tokens * multiplier)

        self._sub_agent_allocations[request.sub_agent_id] = (
            self._sub_agent_allocations.get(request.sub_agent_id, 0) + allocated
        )
        self._trim_sub_agents()

        return TaskBudgetDecision(
            action=BudgetAction.ALLOW,
            allocated_tokens=allocated,
            allocated_model=request.model_preference,
            remaining_budget_pct=prediction.remaining_percentage,
            reason=f"预算充足 ({prediction.remaining_percentage:.1%})，分配 {allocated} tokens",
        )

    def _allow_with_downgrade(self, request: TaskBudgetRequest, prediction: BudgetPrediction) -> TaskBudgetDecision:
        preferred = request.model_preference
        cost_tier = MODEL_COST_TIERS.get(preferred, 1.0)

        alternative = preferred
        for model in LOW_COST_MODELS:
            if MODEL_COST_TIERS.get(model, 1.0) < cost_tier:
                alternative = model
                break

        multiplier = PRIORITY_MULTIPLIER.get(request.priority, 1.0)
        base_tokens = request.estimated_tokens * multiplier
        if alternative != preferred:
            cost_ratio = MODEL_COST_TIERS.get(alternative, 1.0) / max(cost_tier, 0.01)
            allocated = int(base_tokens * max(cost_ratio, 0.5))
        else:
            allocated = int(base_tokens * 0.7)

        self._sub_agent_allocations[request.sub_agent_id] = (
            self._sub_agent_allocations.get(request.sub_agent_id, 0) + allocated
        )
        self._trim_sub_agents()

        return TaskBudgetDecision(
            action=BudgetAction.DOWNGRADE_MODEL,
            allocated_tokens=allocated,
            allocated_model=alternative,
            remaining_budget_pct=prediction.remaining_percentage,
            reason=f"预算紧张 ({prediction.remaining_percentage:.1%})，降级到 {alternative}，分配 {allocated} tokens",
            alternative_model=alternative,
        )

    def _estimate_avg_consumption(self) -> float:
        if not self._consumption_history:
            return 500.0
        recent = self._consumption_history[-50:]
        return sum(r.consumed_tokens for r in recent) / len(recent)

    def _trim_sub_agents(self) -> None:
        if len(self._sub_agent_allocations) > self._MAX_SUB_AGENTS:
            sorted_agents = sorted(self._sub_agent_allocations.items(), key=lambda x: x[1])
            to_remove = sorted_agents[: len(self._sub_agent_allocations) - (self._MAX_SUB_AGENTS * 3 // 4)]
            for aid, _ in to_remove:
                self._sub_agent_allocations.pop(aid, None)
                self._sub_agent_consumed.pop(aid, None)
