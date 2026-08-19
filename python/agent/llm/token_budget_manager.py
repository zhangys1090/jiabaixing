"""全局 Token 预算管理器（Token Budget Manager）。

在 BudgetGuard（周期级预算）和 ModelCostGuard（模型级预算）之上，
提供**会话级**和**子 Agent 级**的 Token 预算分配与追踪。

核心能力：
1. 全局 Token 预算池：按会话分配总预算
2. 子 Agent Token 配额：按任务复杂度自动分配
3. 实时消耗追踪：每次 LLM 调用扣减对应配额
4. 预算耗尽策略：降级/压缩/暂停
5. 预算预测：基于历史消耗预估剩余可执行步骤数

与既有模块的关系：
- BudgetGuard: 管理日/周/月周期级预算（粗粒度）
- ModelCostGuard: 管理模型级预算（中粒度）
- TokenBudgetManager: 管理会话/子Agent级预算（细粒度）

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 非侵入式：未挂载时行为不变，回退到 BudgetGuard
- 可选挂载：通过 LoopController 注入
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("token_budget_manager")


class BudgetExhaustionPolicy(str, Enum):
    DEGRADE = "degrade"
    COMPRESS = "compress"
    PAUSE = "pause"
    ALLOW_OVERDRAFT = "allow_overdraft"


class BudgetLevel(str, Enum):
    SUFFICIENT = "sufficient"
    MODERATE = "moderate"
    LOW = "low"
    CRITICAL = "critical"
    EXHAUSTED = "exhausted"


@dataclass
class SubAgentBudget:
    agent_id: str
    allocated: int = 0
    consumed: int = 0
    reserved: int = 0
    priority: int = 0
    task_type: str = ""

    @property
    def remaining(self) -> int:
        return max(0, self.allocated - self.consumed - self.reserved)

    @property
    def usage_ratio(self) -> float:
        if self.allocated <= 0:
            return 1.0
        return self.consumed / self.allocated


@dataclass
class SessionBudget:
    session_id: str
    total_budget: int = 100_000
    consumed: int = 0
    reserved: int = 0
    created_at: float = field(default_factory=time.time)
    sub_agents: dict[str, SubAgentBudget] = field(default_factory=dict)

    @property
    def remaining(self) -> int:
        return max(0, self.total_budget - self.consumed - self.reserved)

    @property
    def usage_ratio(self) -> float:
        if self.total_budget <= 0:
            return 1.0
        return self.consumed / self.total_budget

    @property
    def level(self) -> BudgetLevel:
        ratio = self.usage_ratio
        if ratio >= 1.0:
            return BudgetLevel.EXHAUSTED
        if ratio >= 0.9:
            return BudgetLevel.CRITICAL
        if ratio >= 0.7:
            return BudgetLevel.LOW
        if ratio >= 0.4:
            return BudgetLevel.MODERATE
        return BudgetLevel.SUFFICIENT


@dataclass
class BudgetCheckResult:
    allowed: bool = True
    level: BudgetLevel = BudgetLevel.SUFFICIENT
    remaining: int = 0
    estimated_steps_remaining: int = 0
    recommendation: str = ""


@dataclass
class ConsumptionRecord:
    timestamp: float = 0.0
    session_id: str = ""
    agent_id: str = ""
    tokens: int = 0
    model: str = ""
    task_type: str = ""


COMPLEXITY_BUDGET_MULTIPLIERS: dict[str, float] = {
    "simple": 0.3,
    "moderate": 0.5,
    "complex": 0.8,
    "critical": 1.0,
}


class TokenBudgetManager:
    """全局 Token 预算管理器。"""

    _instance: TokenBudgetManager | None = None

    def __init__(
        self,
        default_session_budget: int = 100_000,
        exhaustion_policy: BudgetExhaustionPolicy = BudgetExhaustionPolicy.DEGRADE,
        warning_threshold: float = 0.7,
        critical_threshold: float = 0.9,
    ) -> None:
        self._default_session_budget = default_session_budget
        self._exhaustion_policy = exhaustion_policy
        self._warning_threshold = warning_threshold
        self._critical_threshold = critical_threshold
        self._sessions: dict[str, SessionBudget] = {}
        self._consumption_history: list[ConsumptionRecord] = []
        self._max_history = 1000
        self._avg_tokens_per_step = 2000

    @classmethod
    def get_instance(cls) -> TokenBudgetManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def create_session(
        self,
        session_id: str,
        total_budget: int | None = None,
    ) -> SessionBudget:
        budget = total_budget or self._default_session_budget
        session = SessionBudget(session_id=session_id, total_budget=budget)
        self._sessions[session_id] = session
        log.info("Session budget created", session_id=session_id, budget=budget)
        return session

    def get_session(self, session_id: str) -> SessionBudget | None:
        return self._sessions.get(session_id)

    def allocate_sub_agent(
        self,
        session_id: str,
        agent_id: str,
        task_complexity: str = "moderate",
        priority: int = 0,
        task_type: str = "",
        explicit_budget: int | None = None,
    ) -> SubAgentBudget | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None

        if explicit_budget is not None:
            allocated = min(explicit_budget, session.remaining)
        else:
            multiplier = COMPLEXITY_BUDGET_MULTIPLIERS.get(task_complexity, 0.5)
            allocated = max(1000, int(session.remaining * multiplier))

        sub = SubAgentBudget(
            agent_id=agent_id,
            allocated=allocated,
            priority=priority,
            task_type=task_type,
        )
        session.sub_agents[agent_id] = sub
        session.reserved += allocated

        log.info(
            "Sub-agent budget allocated",
            session_id=session_id,
            agent_id=agent_id,
            allocated=allocated,
            complexity=task_complexity,
        )
        return sub

    def check_budget(
        self,
        session_id: str,
        agent_id: str = "",
        estimated_tokens: int = 0,
    ) -> BudgetCheckResult:
        session = self._sessions.get(session_id)
        if session is None:
            return BudgetCheckResult(allowed=True, recommendation="无会话预算，放行")

        level = session.level
        remaining = session.remaining

        if agent_id:
            sub = session.sub_agents.get(agent_id)
            if sub:
                remaining = min(remaining, sub.remaining)
                level = sub_budget_level(sub)

        estimated_steps = self._estimate_steps_remaining(remaining)

        if level == BudgetLevel.EXHAUSTED:
            allowed = self._exhaustion_policy == BudgetExhaustionPolicy.ALLOW_OVERDRAFT
            return BudgetCheckResult(
                allowed=allowed,
                level=level,
                remaining=remaining,
                estimated_steps_remaining=0,
                recommendation=self._exhaustion_recommendation(),
            )

        if estimated_tokens > remaining:
            return BudgetCheckResult(
                allowed=self._exhaustion_policy == BudgetExhaustionPolicy.ALLOW_OVERDRAFT,
                level=BudgetLevel.CRITICAL,
                remaining=remaining,
                estimated_steps_remaining=estimated_steps,
                recommendation="预估 Token 超出剩余预算",
            )

        recommendation = ""
        if level == BudgetLevel.CRITICAL:
            recommendation = "预算严重不足，建议降级到低成本模型"
        elif level == BudgetLevel.LOW:
            recommendation = "预算偏低，注意控制后续步骤消耗"

        return BudgetCheckResult(
            allowed=True,
            level=level,
            remaining=remaining,
            estimated_steps_remaining=estimated_steps,
            recommendation=recommendation,
        )

    def consume(
        self,
        session_id: str,
        tokens: int,
        agent_id: str = "",
        model: str = "",
        task_type: str = "",
    ) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return

        session.consumed += tokens

        if agent_id and agent_id in session.sub_agents:
            sub = session.sub_agents[agent_id]
            sub.consumed += tokens
            session.reserved = max(0, session.reserved - min(tokens, sub.allocated))

        self._consumption_history.append(
            ConsumptionRecord(
                timestamp=time.time(),
                session_id=session_id,
                agent_id=agent_id,
                tokens=tokens,
                model=model,
                task_type=task_type,
            )
        )
        if len(self._consumption_history) > self._max_history:
            self._consumption_history = self._consumption_history[-self._max_history:]

        self._update_avg_tokens_per_step()

        if session.level in (BudgetLevel.CRITICAL, BudgetLevel.EXHAUSTED):
            log.warning(
                "Token budget critical",
                session_id=session_id,
                level=session.level.value,
                remaining=session.remaining,
                usage_ratio=f"{session.usage_ratio:.1%}",
            )

    def release_sub_agent(self, session_id: str, agent_id: str) -> int:
        session = self._sessions.get(session_id)
        if session is None:
            return 0
        sub = session.sub_agents.pop(agent_id, None)
        if sub is None:
            return 0
        released = sub.remaining
        session.reserved = max(0, session.reserved - sub.remaining)
        log.info("Sub-agent budget released", session_id=session_id, agent_id=agent_id, released=released)
        return released

    def rebalance(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return

        active_subs = {aid: sub for aid, sub in session.sub_agents.items() if sub.remaining > 0}
        if not active_subs:
            return

        total_remaining = session.remaining
        total_priority = sum(2 ** sub.priority for sub in active_subs.values())

        for aid, sub in active_subs.items():
            weight = (2 ** sub.priority) / total_priority
            new_alloc = max(1000, int(total_remaining * weight))
            diff = new_alloc - sub.allocated
            sub.allocated = new_alloc
            session.reserved = max(0, session.reserved + diff)

        log.info("Budget rebalanced", session_id=session_id, agents=len(active_subs))

    def get_session_summary(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            return {"error": "session not found"}
        return {
            "session_id": session_id,
            "total_budget": session.total_budget,
            "consumed": session.consumed,
            "remaining": session.remaining,
            "reserved": session.reserved,
            "usage_ratio": round(session.usage_ratio, 3),
            "level": session.level.value,
            "sub_agents": {
                aid: {
                    "allocated": sub.allocated,
                    "consumed": sub.consumed,
                    "remaining": sub.remaining,
                    "usage_ratio": round(sub.usage_ratio, 3),
                    "task_type": sub.task_type,
                }
                for aid, sub in session.sub_agents.items()
            },
            "estimated_steps_remaining": self._estimate_steps_remaining(session.remaining),
        }

    def get_global_stats(self) -> dict[str, Any]:
        total_consumed = sum(s.consumed for s in self._sessions.values())
        total_budget = sum(s.total_budget for s in self._sessions.values())
        return {
            "active_sessions": len(self._sessions),
            "total_budget": total_budget,
            "total_consumed": total_consumed,
            "avg_tokens_per_step": self._avg_tokens_per_step,
            "exhaustion_policy": self._exhaustion_policy.value,
        }

    def _estimate_steps_remaining(self, remaining_tokens: int) -> int:
        if self._avg_tokens_per_step <= 0:
            return 0
        return max(0, remaining_tokens // self._avg_tokens_per_step)

    def _update_avg_tokens_per_step(self) -> None:
        recent = self._consumption_history[-50:]
        if not recent:
            return
        avg = sum(r.tokens for r in recent) / len(recent)
        self._avg_tokens_per_step = int(self._avg_tokens_per_step * 0.8 + avg * 0.2)

    def _exhaustion_recommendation(self) -> str:
        if self._exhaustion_policy == BudgetExhaustionPolicy.DEGRADE:
            return "预算耗尽，建议降级到低成本模型（如 haiku）"
        if self._exhaustion_policy == BudgetExhaustionPolicy.COMPRESS:
            return "预算耗尽，建议压缩上下文减少 Token 消耗"
        if self._exhaustion_policy == BudgetExhaustionPolicy.PAUSE:
            return "预算耗尽，暂停执行等待用户确认"
        return "预算耗尽但允许透支"


def sub_budget_level(sub: SubAgentBudget) -> BudgetLevel:
    ratio = sub.usage_ratio
    if ratio >= 1.0:
        return BudgetLevel.EXHAUSTED
    if ratio >= 0.9:
        return BudgetLevel.CRITICAL
    if ratio >= 0.7:
        return BudgetLevel.LOW
    if ratio >= 0.4:
        return BudgetLevel.MODERATE
    return BudgetLevel.SUFFICIENT
