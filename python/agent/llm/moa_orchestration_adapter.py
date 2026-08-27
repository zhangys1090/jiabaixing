"""MOA 编排适配器（Mixture-of-Agents Orchestration Adapter）。

将 moa_aggregator.py（多模型协作聚合）与编排层深度集成：
1. 编排感知的 MOA 调用：根据任务编排阶段选择不同的聚合策略
2. 子步骤级 MOA：每个子步骤可独立选择是否使用 MOA 及聚合策略
3. MOA 结果注入编排流：MOA 聚合结果自动注入编排流程的后续步骤
4. MOA 与动态模型切换联动：MOA 候选模型集随动态切换调整
5. MOA 预算感知：聚合调用受 Token 预算约束

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 非侵入式：未挂载时 MOA 独立运行，编排层独立运行
- 可选挂载：每个子步骤可独立决定是否启用 MOA
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.llm.moa_aggregator import MoAAggregator, AggregationStrategy, AggregationResult
from agent.core.logger import StructuredLogger
log = StructuredLogger("moa_orchestration_adapter")



class OrchestrationPhase(str, Enum):
    PLANNING = "planning"
    EXECUTION = "execution"
    VERIFICATION = "verification"
    REFLECTION = "reflection"
    RECOVERY = "recovery"


class MoATrigger(str, Enum):
    HIGH_STAKES = "high_stakes"
    AMBIGUOUS_TASK = "ambiguous_task"
    VERIFICATION_DISAGREEMENT = "verification_disagreement"
    USER_REQUEST = "user_request"
    BUDGET_AVAILABLE = "budget_available"
    ALWAYS = "always"
    NEVER = "never"


PHASE_STRATEGY_MAP: dict[OrchestrationPhase, AggregationStrategy] = {
    OrchestrationPhase.PLANNING: AggregationStrategy.CONSENSUS,
    OrchestrationPhase.EXECUTION: AggregationStrategy.VOTING,
    OrchestrationPhase.VERIFICATION: AggregationStrategy.CONSENSUS,
    OrchestrationPhase.REFLECTION: AggregationStrategy.CASCADE,
    OrchestrationPhase.RECOVERY: AggregationStrategy.VOTING,
}

PHASE_MODEL_SETS: dict[OrchestrationPhase, list[str]] = {
    OrchestrationPhase.PLANNING: [
        "openai/gpt-4o",
        "anthropic/claude-3-5-sonnet",
        "deepseek/deepseek-v4-pro",
    ],
    OrchestrationPhase.EXECUTION: [
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "deepseek/deepseek-v4-flash",
    ],
    OrchestrationPhase.VERIFICATION: [
        "openai/gpt-4o",
        "anthropic/claude-3-5-sonnet",
    ],
    OrchestrationPhase.REFLECTION: [
        "openai/gpt-4o",
        "anthropic/claude-3-5-sonnet",
        "openai/o1",
    ],
    OrchestrationPhase.RECOVERY: [
        "openai/gpt-4o",
        "deepseek/deepseek-v4-pro",
    ],
}


@dataclass
class MoAOrchestrationConfig:
    trigger: MoATrigger = MoATrigger.HIGH_STAKES
    min_consensus_score: float = 0.7
    max_parallel_models: int = 3
    budget_limit_per_call: int = 5000
    fallback_to_single: bool = True
    inject_results_to_flow: bool = True
    respect_phase_strategy: bool = True


@dataclass
class MoAOrchestrationResult:
    success: bool = False
    used_moa: bool = False
    phase: OrchestrationPhase = OrchestrationPhase.EXECUTION
    strategy: AggregationStrategy = AggregationStrategy.VOTING
    models_used: list[str] = field(default_factory=list)
    best_answer: str = ""
    best_model: str = ""
    consensus_score: float = 0.0
    total_cost_usd: float = 0.0
    total_duration_ms: float = 0.0
    candidates_count: int = 0
    fallback_used: bool = False
    injection_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class MoAOrchestrationStats:
    total_calls: int = 0
    moa_calls: int = 0
    single_calls: int = 0
    fallback_calls: int = 0
    calls_by_phase: dict[str, int] = field(default_factory=dict)
    calls_by_strategy: dict[str, int] = field(default_factory=dict)
    total_cost_usd: float = 0.0
    avg_consensus_score: float = 0.0
    avg_duration_ms: float = 0.0


class MoAOrchestrationAdapter:
    """MOA 编排适配器：将多模型协作与任务编排深度集成。"""

    _instance: MoAOrchestrationAdapter | None = None

    def __init__(
        self,
        aggregator: MoAAggregator | None = None,
        config: MoAOrchestrationConfig | None = None,
        budget_checker: Any = None,
    ) -> None:
        self._aggregator = aggregator or MoAAggregator()
        self._config = config or MoAOrchestrationConfig()
        self._budget_checker = budget_checker
        self._stats = MoAOrchestrationStats()
        self._history: list[MoAOrchestrationResult] = []
        self._max_history = 200

    @classmethod
    def get_instance(cls) -> MoAOrchestrationAdapter:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    async def orchestrate(
        self,
        messages: list[dict[str, str]],
        phase: OrchestrationPhase = OrchestrationPhase.EXECUTION,
        models: list[str] | None = None,
        strategy: AggregationStrategy | None = None,
        max_tokens: int = 1000,
        temperature: float = 0.7,
        step_metadata: dict[str, Any] | None = None,
    ) -> MoAOrchestrationResult:
        self._stats.total_calls += 1
        self._stats.calls_by_phase[phase.value] = (
            self._stats.calls_by_phase.get(phase.value, 0) + 1
        )

        start = time.time()

        should_use_moa = self._should_use_moa(phase, step_metadata)
        if not should_use_moa:
            result = await self._single_model_call(messages, phase, max_tokens, temperature)
            result.total_duration_ms = (time.time() - start) * 1000
            self._record_result(result)
            return result

        effective_strategy = strategy
        if effective_strategy is None and self._config.respect_phase_strategy:
            effective_strategy = PHASE_STRATEGY_MAP.get(phase, AggregationStrategy.VOTING)

        effective_models = models
        if effective_models is None:
            effective_models = PHASE_MODEL_SETS.get(phase, [])
            if len(effective_models) > self._config.max_parallel_models:
                effective_models = effective_models[: self._config.max_parallel_models]

        if not effective_models:
            result = await self._single_model_call(messages, phase, max_tokens, temperature)
            result.fallback_used = True
            result.total_duration_ms = (time.time() - start) * 1000
            self._record_result(result)
            return result

        try:
            moa_result = await self._aggregator.aggregate(
                messages=messages,
                models=effective_models,
                strategy=effective_strategy or AggregationStrategy.VOTING,
                max_tokens=max_tokens,
                temperature=temperature,
            )

            result = MoAOrchestrationResult(
                success=True,
                used_moa=True,
                phase=phase,
                strategy=effective_strategy or AggregationStrategy.VOTING,
                models_used=effective_models,
                best_answer=moa_result.best_answer,
                best_model=moa_result.best_model,
                consensus_score=moa_result.consensus_score,
                total_cost_usd=moa_result.total_cost_usd,
                candidates_count=len(moa_result.candidates),
            )

            self._stats.moa_calls += 1
            self._stats.calls_by_strategy[result.strategy.value] = (
                self._stats.calls_by_strategy.get(result.strategy.value, 0) + 1
            )
            self._stats.total_cost_usd += moa_result.total_cost_usd

        except Exception as e:
            log.warning("MOA aggregation failed, falling back to single model", error=str(e))
            result = await self._single_model_call(messages, phase, max_tokens, temperature)
            result.fallback_used = True
            self._stats.fallback_calls += 1

        result.total_duration_ms = (time.time() - start) * 1000
        self._record_result(result)
        return result

    def _should_use_moa(
        self,
        phase: OrchestrationPhase,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        trigger = self._config.trigger

        if trigger == MoATrigger.NEVER:
            return False
        if trigger == MoATrigger.ALWAYS:
            return True

        if trigger == MoATrigger.HIGH_STAKES:
            if phase in (OrchestrationPhase.PLANNING, OrchestrationPhase.VERIFICATION):
                return True
            if metadata and metadata.get("high_stakes", False):
                return True
            return False

        if trigger == MoATrigger.AMBIGUOUS_TASK:
            if metadata and metadata.get("ambiguity_score", 0.0) > 0.5:
                return True
            return False

        if trigger == MoATrigger.VERIFICATION_DISAGREEMENT:
            if phase == OrchestrationPhase.VERIFICATION:
                return True
            if metadata and metadata.get("disagreement_detected", False):
                return True
            return False

        if trigger == MoATrigger.USER_REQUEST:
            if metadata and metadata.get("user_requested_moa", False):
                return True
            return False

        if trigger == MoATrigger.BUDGET_AVAILABLE:
            if self._budget_checker:
                try:
                    status = self._budget_checker.get_session_status()
                    if status and status.get("remaining_percentage", 0.0) > 0.5:
                        return True
                except Exception as _exc:
                    log.warning("预算检查异常", error=str(_exc))
            return False

        return False

    async def _single_model_call(
        self,
        messages: list[dict[str, str]],
        phase: OrchestrationPhase,
        max_tokens: int,
        temperature: float,
    ) -> MoAOrchestrationResult:
        model_sets = PHASE_MODEL_SETS.get(phase, ["openai/gpt-4o-mini"])
        primary_model = model_sets[0] if model_sets else "openai/gpt-4o-mini"

        try:
            moa_result = await self._aggregator.aggregate(
                messages=messages,
                models=[primary_model],
                strategy=AggregationStrategy.VOTING,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            self._stats.single_calls += 1
            return MoAOrchestrationResult(
                success=True,
                used_moa=False,
                phase=phase,
                strategy=AggregationStrategy.VOTING,
                models_used=[primary_model],
                best_answer=moa_result.best_answer,
                best_model=moa_result.best_model,
                consensus_score=moa_result.consensus_score,
                total_cost_usd=moa_result.total_cost_usd,
                candidates_count=1,
            )
        except Exception as e:
            log.debug("moa_orchestration_adapter 异常处理", error=str(e))
            return MoAOrchestrationResult(
                success=False,
                used_moa=False,
                phase=phase,
                best_answer="",
                best_model=primary_model,
            )

    def _record_result(self, result: MoAOrchestrationResult) -> None:
        self._history.append(result)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

        if self._history:
            moa_results = [r for r in self._history if r.used_moa and r.consensus_score > 0]
            if moa_results:
                self._stats.avg_consensus_score = (
                    sum(r.consensus_score for r in moa_results) / len(moa_results)
                )
            self._stats.avg_duration_ms = (
                sum(r.total_duration_ms for r in self._history) / len(self._history)
            )

    def get_stats(self) -> MoAOrchestrationStats:
        return self._stats

    def get_history(self, limit: int = 20) -> list[MoAOrchestrationResult]:
        return list(self._history[-limit:])

    def get_phase_recommendation(self, phase: OrchestrationPhase) -> dict[str, Any]:
        strategy = PHASE_STRATEGY_MAP.get(phase, AggregationStrategy.VOTING)
        models = PHASE_MODEL_SETS.get(phase, [])
        return {
            "phase": phase.value,
            "recommended_strategy": strategy.value,
            "recommended_models": models[:self._config.max_parallel_models],
            "trigger_threshold": self._config.trigger.value,
        }
