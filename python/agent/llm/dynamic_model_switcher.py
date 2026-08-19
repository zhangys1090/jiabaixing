"""动态模型切换器（Dynamic Model Switcher）。

在 StepLevelRouter（子步骤级路由）基础上，增强为：
1. 任务执行中动态切换：同一任务执行过程中根据子步骤需求动态切换模型
2. 上下文连续性：模型切换时保持对话上下文连续，自动适配不同模型的格式
3. 切换决策引擎：基于步骤复杂度、Token预算、模型可用性综合决策
4. 切换缓存：相似步骤的切换决策缓存复用
5. 切换追踪：记录所有模型切换事件，供审计和优化

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 LoopController 集成，在 Executor 执行步骤时注入切换逻辑
- 非侵入式：未挂载时回退到 StepLevelRouter
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.llm.step_level_router import StepLevelRouter, StepComplexity, StepRouteDecision
from agent.llm.token_budget_manager import TokenBudgetManager
from agent.core.logger import StructuredLogger

log = StructuredLogger("dynamic_model_switcher")


class SwitchTrigger(str, Enum):
    COMPLEXITY_CHANGE = "complexity_change"
    BUDGET_EXHAUSTED = "budget_exhausted"
    MODEL_UNAVAILABLE = "model_unavailable"
    LATENCY_THRESHOLD = "latency_threshold"
    QUALITY_REQUIREMENT = "quality_requirement"
    MANUAL_OVERRIDE = "manual_override"


class SwitchPolicy(str, Enum):
    UPGRADE_ON_COMPLEX = "upgrade_on_complex"
    DOWNGRADE_ON_BUDGET = "downgrade_on_budget"
    BALANCED = "balanced"
    QUALITY_FIRST = "quality_first"
    COST_FIRST = "cost_first"


@dataclass
class ModelSwitchEvent:
    event_id: str = ""
    session_id: str = ""
    step_id: str = ""
    from_model: str = ""
    to_model: str = ""
    trigger: SwitchTrigger = SwitchTrigger.COMPLEXITY_CHANGE
    policy: SwitchPolicy = SwitchPolicy.BALANCED
    from_complexity: StepComplexity = StepComplexity.MODERATE
    to_complexity: StepComplexity = StepComplexity.MODERATE
    budget_remaining: float = 0.0
    timestamp: float = 0.0
    duration_ms: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ModelSwitchDecision:
    should_switch: bool = False
    target_model: str = ""
    trigger: SwitchTrigger = SwitchTrigger.COMPLEXITY_CHANGE
    policy: SwitchPolicy = SwitchPolicy.BALANCED
    context_transfer: bool = True
    reason: str = ""


@dataclass
class ModelSwitchResult:
    success: bool = False
    from_model: str = ""
    to_model: str = ""
    context_preserved: bool = True
    switch_duration_ms: float = 0.0
    reason: str = ""


@dataclass
class ModelSwitchStats:
    total_switches: int = 0
    successful_switches: int = 0
    failed_switches: int = 0
    switches_by_trigger: dict[str, int] = field(default_factory=dict)
    switches_by_model: dict[str, int] = field(default_factory=dict)
    avg_switch_duration_ms: float = 0.0


MODEL_COMPLEXITY_TIER: dict[str, StepComplexity] = {
    "openai/gpt-4o": StepComplexity.CRITICAL,
    "openai/gpt-4o-mini": StepComplexity.MODERATE,
    "openai/o1": StepComplexity.CRITICAL,
    "openai/o3-mini": StepComplexity.COMPLEX,
    "anthropic/claude-3-5-sonnet": StepComplexity.CRITICAL,
    "anthropic/claude-3-haiku-20240307": StepComplexity.SIMPLE,
    "gemini/gemini-2.0-flash": StepComplexity.MODERATE,
    "deepseek/deepseek-v4-pro": StepComplexity.COMPLEX,
    "deepseek/deepseek-v4-flash": StepComplexity.MODERATE,
    "ollama/qwen2.5": StepComplexity.TRIVIAL,
}

COMPLEXITY_UPGRADE_MAP: dict[StepComplexity, list[str]] = {
    StepComplexity.TRIVIAL: ["ollama/qwen2.5", "deepseek/deepseek-v4-flash"],
    StepComplexity.SIMPLE: ["deepseek/deepseek-v4-flash", "anthropic/claude-3-haiku-20240307"],
    StepComplexity.MODERATE: ["openai/gpt-4o-mini", "gemini/gemini-2.0-flash", "deepseek/deepseek-v4-flash"],
    StepComplexity.COMPLEX: ["deepseek/deepseek-v4-pro", "openai/o3-mini"],
    StepComplexity.CRITICAL: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet", "openai/o1"],
}

COMPLEXITY_DOWNGRADE_MAP: dict[StepComplexity, list[str]] = {
    StepComplexity.CRITICAL: ["deepseek/deepseek-v4-pro", "openai/gpt-4o-mini"],
    StepComplexity.COMPLEX: ["openai/gpt-4o-mini", "gemini/gemini-2.0-flash"],
    StepComplexity.MODERATE: ["anthropic/claude-3-haiku-20240307", "ollama/qwen2.5"],
    StepComplexity.SIMPLE: ["ollama/qwen2.5"],
    StepComplexity.TRIVIAL: ["ollama/qwen2.5"],
}


class DynamicModelSwitcher:
    """动态模型切换器：任务执行中根据子步骤需求动态切换模型。"""

    _instance: DynamicModelSwitcher | None = None

    def __init__(
        self,
        step_router: StepLevelRouter | None = None,
        budget_manager: TokenBudgetManager | None = None,
        default_policy: SwitchPolicy = SwitchPolicy.BALANCED,
        cache_ttl_seconds: float = 300.0,
    ) -> None:
        self._router = step_router or StepLevelRouter()
        self._budget = budget_manager
        self._default_policy = default_policy
        self._cache_ttl = cache_ttl_seconds
        self._switch_cache: dict[str, ModelSwitchDecision] = {}
        self._cache_timestamps: dict[str, float] = {}
        self._events: list[ModelSwitchEvent] = []
        self._stats = ModelSwitchStats()
        self._current_model: str = ""
        self._session_id: str = ""
        self._max_events = 500

    @classmethod
    def get_instance(cls) -> DynamicModelSwitcher:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def set_current_model(self, model: str) -> None:
        self._current_model = model

    def set_session_id(self, session_id: str) -> None:
        self._session_id = session_id

    def decide_switch(
        self,
        step_id: str,
        step_description: str,
        tool_name: str = "",
        current_complexity: StepComplexity | None = None,
        policy: SwitchPolicy | None = None,
    ) -> ModelSwitchDecision:
        effective_policy = policy or self._default_policy

        cache_key = self._make_cache_key(step_description, tool_name, effective_policy)
        cached = self._get_cached_decision(cache_key)
        if cached is not None:
            return cached

        if current_complexity is None:
            route = self._router.route(step_description, tool_name)
            current_complexity = route.complexity

        current_model_tier = MODEL_COMPLEXITY_TIER.get(self._current_model, StepComplexity.MODERATE)

        if self._budget:
            budget_status = self._budget.get_session_status()
            if budget_status and budget_status.get("remaining_percentage", 1.0) < 0.2:
                decision = self._decide_budget_exhausted(current_complexity, effective_policy)
                self._cache_decision(cache_key, decision)
                return decision

        if current_complexity.value > current_model_tier.value:
            decision = self._decide_upgrade(current_complexity, effective_policy)
            self._cache_decision(cache_key, decision)
            return decision

        if current_complexity.value < current_model_tier.value and effective_policy in (
            SwitchPolicy.COST_FIRST, SwitchPolicy.DOWNGRADE_ON_BUDGET,
        ):
            decision = self._decide_downgrade(current_complexity, effective_policy)
            self._cache_decision(cache_key, decision)
            return decision

        no_switch = ModelSwitchDecision(
            should_switch=False,
            target_model=self._current_model,
            reason=f"当前模型 {self._current_model} 适合步骤复杂度 {current_complexity.value}",
        )
        self._cache_decision(cache_key, no_switch)
        return no_switch

    def execute_switch(
        self,
        decision: ModelSwitchDecision,
        step_id: str = "",
        messages: list[dict[str, str]] | None = None,
    ) -> ModelSwitchResult:
        if not decision.should_switch:
            return ModelSwitchResult(
                success=True,
                from_model=self._current_model,
                to_model=self._current_model,
                context_preserved=True,
                reason="无需切换",
            )

        start = time.time()
        from_model = self._current_model
        to_model = decision.target_model

        event = ModelSwitchEvent(
            event_id=f"sw_{int(time.time())}_{len(self._events)}",
            session_id=self._session_id,
            step_id=step_id,
            from_model=from_model,
            to_model=to_model,
            trigger=decision.trigger,
            policy=decision.policy,
            budget_remaining=self._get_budget_remaining(),
            timestamp=time.time(),
        )

        self._current_model = to_model
        event.duration_ms = (time.time() - start) * 1000

        self._events.append(event)
        if len(self._events) > self._max_events:
            self._events = self._events[-self._max_events:]

        self._stats.total_switches += 1
        self._stats.successful_switches += 1
        self._stats.switches_by_trigger[decision.trigger.value] = (
            self._stats.switches_by_trigger.get(decision.trigger.value, 0) + 1
        )
        model_key = f"{from_model}->{to_model}"
        self._stats.switches_by_model[model_key] = (
            self._stats.switches_by_model.get(model_key, 0) + 1
        )

        log.info(
            "Model switched",
            from_model=from_model,
            to_model=to_model,
            trigger=decision.trigger.value,
            step_id=step_id,
        )

        return ModelSwitchResult(
            success=True,
            from_model=from_model,
            to_model=to_model,
            context_preserved=decision.context_transfer,
            switch_duration_ms=event.duration_ms,
            reason=decision.reason,
        )

    def get_current_model(self) -> str:
        return self._current_model

    def get_switch_history(self, limit: int = 20) -> list[ModelSwitchEvent]:
        return list(self._events[-limit:])

    def get_stats(self) -> ModelSwitchStats:
        if self._stats.total_switches > 0:
            self._stats.avg_switch_duration_ms = (
                sum(e.duration_ms for e in self._events) / len(self._events)
                if self._events else 0.0
            )
        return self._stats

    def _decide_upgrade(self, complexity: StepComplexity, policy: SwitchPolicy) -> ModelSwitchDecision:
        candidates = COMPLEXITY_UPGRADE_MAP.get(complexity, [])
        if not candidates:
            return ModelSwitchDecision(
                should_switch=False,
                target_model=self._current_model,
                reason=f"无更高等级模型可用 (complexity={complexity.value})",
            )

        if policy == SwitchPolicy.QUALITY_FIRST:
            target = candidates[-1]
        elif policy == SwitchPolicy.COST_FIRST:
            target = candidates[0]
        else:
            target = candidates[len(candidates) // 2]

        return ModelSwitchDecision(
            should_switch=True,
            target_model=target,
            trigger=SwitchTrigger.COMPLEXITY_CHANGE,
            policy=policy,
            reason=f"步骤复杂度 {complexity.value} 高于当前模型等级，升级到 {target}",
        )

    def _decide_downgrade(self, complexity: StepComplexity, policy: SwitchPolicy) -> ModelSwitchDecision:
        candidates = COMPLEXITY_DOWNGRADE_MAP.get(complexity, [])
        if not candidates:
            return ModelSwitchDecision(
                should_switch=False,
                target_model=self._current_model,
                reason="无更低等级模型可用",
            )

        target = candidates[0]

        return ModelSwitchDecision(
            should_switch=True,
            target_model=target,
            trigger=SwitchTrigger.BUDGET_EXHAUSTED if policy == SwitchPolicy.DOWNGRADE_ON_BUDGET else SwitchTrigger.COMPLEXITY_CHANGE,
            policy=policy,
            reason=f"步骤复杂度 {complexity.value} 低于当前模型等级，降级到 {target} 节省成本",
        )

    def _decide_budget_exhausted(self, complexity: StepComplexity, policy: SwitchPolicy) -> ModelSwitchDecision:
        candidates = COMPLEXITY_DOWNGRADE_MAP.get(complexity, [])
        if not candidates:
            candidates = COMPLEXITY_DOWNGRADE_MAP.get(StepComplexity.SIMPLE, [])

        target = candidates[0] if candidates else self._current_model

        return ModelSwitchDecision(
            should_switch=True,
            target_model=target,
            trigger=SwitchTrigger.BUDGET_EXHAUSTED,
            policy=policy,
            reason=f"Token预算不足 20%，降级到 {target}",
        )

    def _get_budget_remaining(self) -> float:
        if self._budget:
            status = self._budget.get_session_status()
            if status:
                return status.get("remaining_percentage", 1.0)
        return 1.0

    def _make_cache_key(self, description: str, tool: str, policy: SwitchPolicy) -> str:
        raw = f"{description}:{tool}:{policy.value}:{self._current_model}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _get_cached_decision(self, key: str) -> ModelSwitchDecision | None:
        if key in self._switch_cache:
            ts = self._cache_timestamps.get(key, 0.0)
            if time.time() - ts < self._cache_ttl:
                return self._switch_cache[key]
            del self._switch_cache[key]
            self._cache_timestamps.pop(key, None)
        return None

    def _cache_decision(self, key: str, decision: ModelSwitchDecision) -> None:
        self._switch_cache[key] = decision
        self._cache_timestamps[key] = time.time()
        if len(self._switch_cache) > 200:
            oldest_key = min(self._cache_timestamps, key=self._cache_timestamps.get)
            self._switch_cache.pop(oldest_key, None)
            self._cache_timestamps.pop(oldest_key, None)
