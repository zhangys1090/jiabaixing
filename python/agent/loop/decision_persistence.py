"""决策经验持久化 + 多目标优化（Decision Experience Persistence & Multi-Objective Optimization）。

在现有 MetaDecisionEngine（Q-Learning 单目标策略选择）基础上，增强为：
1. 决策经验持久化：完整记录决策上下文/策略/结果/反思，支持跨会话复用
2. 多目标优化：同时优化质量、延迟、成本、安全等多个目标
3. Pareto 最优策略：基于多目标评估产出 Pareto 前沿策略集
4. 经验检索：根据当前上下文检索相似历史决策经验
5. 决策反思：自动分析失败决策，提取改进建议

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 MetaDecisionEngine 集成，复用其 Q-Table 和策略评估
- 非侵入式：包装 MetaDecisionEngine，不修改其内部逻辑
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.loop.meta_decision_engine import (
    MetaDecisionEngine,
    DecisionContext,
    DecisionStrategy,
    DecisionRecord,
)
from agent.core.logger import StructuredLogger
log = StructuredLogger("decision_persistence")



class Objective(str, Enum):
    QUALITY = "quality"
    LATENCY = "latency"
    COST = "cost"
    SAFETY = "safety"
    USER_SATISFACTION = "user_satisfaction"


@dataclass
class ObjectiveScore:
    objective: Objective = Objective.QUALITY
    raw_value: float = 0.0
    normalized_value: float = 0.0
    weight: float = 1.0

    @property
    def weighted_score(self) -> float:
        return self.normalized_value * self.weight


@dataclass
class MultiObjectiveResult:
    strategy: DecisionStrategy = DecisionStrategy.RULE_BASED
    scores: list[ObjectiveScore] = field(default_factory=list)
    weighted_sum: float = 0.0
    pareto_optimal: bool = False
    dominated_by: list[DecisionStrategy] = field(default_factory=list)

    def get_score(self, objective: Objective) -> float:
        for s in self.scores:
            if s.objective == objective:
                return s.normalized_value
        return 0.0


@dataclass
class DecisionExperience:
    experience_id: str = ""
    timestamp: float = 0.0
    session_id: str = ""
    context: DecisionContext = field(default_factory=DecisionContext)
    strategy: DecisionStrategy = DecisionStrategy.RULE_BASED
    outcome: str = "unknown"
    objective_scores: dict[str, float] = field(default_factory=dict)
    quality_score: float = 0.0
    duration_ms: float = 0.0
    cost_units: float = 0.0
    safety_violations: int = 0
    user_rating: float = 0.0
    reflection: str = ""
    improvement_suggestions: list[str] = field(default_factory=list)
    similar_experience_ids: list[str] = field(default_factory=list)


@dataclass
class ObjectiveWeights:
    quality: float = 1.0
    latency: float = 0.7
    cost: float = 0.5
    safety: float = 1.5
    user_satisfaction: float = 0.8

    def to_dict(self) -> dict[str, float]:
        return {
            Objective.QUALITY.value: self.quality,
            Objective.LATENCY.value: self.latency,
            Objective.COST.value: self.cost,
            Objective.SAFETY.value: self.safety,
            Objective.USER_SATISFACTION.value: self.user_satisfaction,
        }


class DecisionExperienceStore:
    """决策经验持久化存储：完整记录和检索决策经验。"""

    def __init__(self, data_dir: str | Path | None = None) -> None:
        if data_dir:
            self._data_dir = Path(data_dir)
        else:
            self._data_dir = Path(
                __file__
            ).resolve().parent.parent.parent / "data" / "decision_experience"
        self._data_dir.mkdir(parents=True, exist_ok=True)

        self._experiences_path = self._data_dir / "experiences.jsonl"
        self._index_path = self._data_dir / "context_index.json"
        self._experiences: dict[str, DecisionExperience] = {}
        self._context_index: dict[str, list[str]] = {}
        self._max_experiences = 2000

        self._load()

    def store(self, experience: DecisionExperience) -> None:
        self._experiences[experience.experience_id] = experience
        context_key = self._make_context_key(experience.context)
        if context_key not in self._context_index:
            self._context_index[context_key] = []
        self._context_index[context_key].append(experience.experience_id)

        if len(self._experiences) > self._max_experiences:
            oldest_id = min(self._experiences, key=lambda eid: self._experiences[eid].timestamp)
            del self._experiences[oldest_id]
            for key, ids in self._context_index.items():
                if oldest_id in ids:
                    ids.remove(oldest_id)

        self._append_experience(experience)

    def retrieve(self, experience_id: str) -> DecisionExperience | None:
        return self._experiences.get(experience_id)

    def search_similar(
        self,
        context: DecisionContext,
        limit: int = 5,
    ) -> list[DecisionExperience]:
        context_key = self._make_context_key(context)
        exact_matches = self._context_index.get(context_key, [])
        results = [self._experiences[eid] for eid in exact_matches if eid in self._experiences]

        if len(results) < limit:
            partial_key = f"{context.complexity}|{context.scene}"
            for key, ids in self._context_index.items():
                if key.startswith(partial_key) and key != context_key:
                    for eid in ids:
                        if eid in self._experiences and eid not in {e.experience_id for e in results}:
                            results.append(self._experiences[eid])

        results.sort(key=lambda e: e.timestamp, reverse=True)
        return results[:limit]

    def get_successful_experiences(
        self,
        context: DecisionContext,
        limit: int = 5,
    ) -> list[DecisionExperience]:
        similar = self.search_similar(context, limit=limit * 3)
        successful = [e for e in similar if e.outcome == "success" and e.quality_score >= 0.7]
        return successful[:limit]

    def get_failed_experiences(
        self,
        context: DecisionContext,
        limit: int = 5,
    ) -> list[DecisionExperience]:
        similar = self.search_similar(context, limit=limit * 3)
        failed = [e for e in similar if e.outcome == "failure"]
        return failed[:limit]

    def _make_context_key(self, context: DecisionContext) -> str:
        return f"{context.complexity}|{context.scene}|{context.emotion}|{context.risk_level}"

    def _append_experience(self, exp: DecisionExperience) -> None:
        try:
            data = {
                "experience_id": exp.experience_id,
                "timestamp": exp.timestamp,
                "session_id": exp.session_id,
                "strategy": exp.strategy.value,
                "outcome": exp.outcome,
                "quality_score": exp.quality_score,
                "duration_ms": exp.duration_ms,
                "cost_units": exp.cost_units,
                "safety_violations": exp.safety_violations,
                "user_rating": exp.user_rating,
                "reflection": exp.reflection,
                "improvement_suggestions": exp.improvement_suggestions,
                "context": {
                    "complexity": exp.context.complexity,
                    "scene": exp.context.scene,
                    "emotion": exp.context.emotion,
                    "risk_level": exp.context.risk_level,
                },
                "objective_scores": exp.objective_scores,
            }
            line = json.dumps(data, ensure_ascii=False) + "\n"
            with open(self._experiences_path, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception as e:
            log.debug("Failed to append experience", error=str(e))

    def _load(self) -> None:
        if not self._experiences_path.exists():
            return
        try:
            lines = self._experiences_path.read_text(encoding="utf-8").strip().split("\n")
            for line in lines:
                if not line.strip():
                    continue
                raw = json.loads(line)
                eid = raw.get("experience_id", "")
                ctx_raw = raw.get("context", {})
                exp = DecisionExperience(
                    experience_id=eid,
                    timestamp=raw.get("timestamp", 0.0),
                    session_id=raw.get("session_id", ""),
                    context=DecisionContext(
                        complexity=ctx_raw.get("complexity", "moderate"),
                        scene=ctx_raw.get("scene", "daily"),
                        emotion=ctx_raw.get("emotion", "neutral"),
                        risk_level=ctx_raw.get("risk_level", "low"),
                    ),
                    strategy=DecisionStrategy(raw.get("strategy", "rule_based")),
                    outcome=raw.get("outcome", "unknown"),
                    objective_scores=raw.get("objective_scores", {}),
                    quality_score=raw.get("quality_score", 0.0),
                    duration_ms=raw.get("duration_ms", 0.0),
                    cost_units=raw.get("cost_units", 0.0),
                    safety_violations=raw.get("safety_violations", 0),
                    user_rating=raw.get("user_rating", 0.0),
                    reflection=raw.get("reflection", ""),
                    improvement_suggestions=raw.get("improvement_suggestions", []),
                )
                self._experiences[eid] = exp
                context_key = self._make_context_key(exp.context)
                self._context_index.setdefault(context_key, []).append(eid)
        except Exception as e:
            log.debug("Failed to load experiences", error=str(e))

    @property
    def total_experiences(self) -> int:
        return len(self._experiences)

    def get_stats(self) -> dict[str, Any]:
        outcomes = {"success": 0, "failure": 0, "unknown": 0}
        for exp in self._experiences.values():
            outcomes[exp.outcome] = outcomes.get(exp.outcome, 0) + 1
        return {
            "total_experiences": len(self._experiences),
            "context_index_size": len(self._context_index),
            "outcomes": outcomes,
        }


class MultiObjectiveOptimizer:
    """多目标优化器：同时优化质量/延迟/成本/安全/满意度。"""

    def __init__(
        self,
        weights: ObjectiveWeights | None = None,
        latency_budget_ms: float = 10000.0,
        cost_budget: float = 100.0,
    ) -> None:
        self._weights = weights or ObjectiveWeights()
        self._latency_budget_ms = latency_budget_ms
        self._cost_budget = cost_budget

    def evaluate_strategy(
        self,
        strategy: DecisionStrategy,
        context: DecisionContext,
        experience_store: DecisionExperienceStore,
    ) -> MultiObjectiveResult:
        similar = experience_store.search_similar(context, limit=20)
        strategy_experiences = [e for e in similar if e.strategy == strategy]

        scores: list[ObjectiveScore] = []
        weights_dict = self._weights.to_dict()

        quality_val = self._compute_quality(strategy_experiences)
        scores.append(ObjectiveScore(
            objective=Objective.QUALITY,
            raw_value=quality_val,
            normalized_value=quality_val,
            weight=weights_dict.get(Objective.QUALITY.value, 1.0),
        ))

        latency_val = self._compute_latency(strategy_experiences)
        latency_norm = max(0.0, 1.0 - latency_val / self._latency_budget_ms) if self._latency_budget_ms > 0 else 0.5
        scores.append(ObjectiveScore(
            objective=Objective.LATENCY,
            raw_value=latency_val,
            normalized_value=latency_norm,
            weight=weights_dict.get(Objective.LATENCY.value, 0.7),
        ))

        cost_val = self._compute_cost(strategy_experiences, strategy)
        cost_norm = max(0.0, 1.0 - cost_val / self._cost_budget) if self._cost_budget > 0 else 0.5
        scores.append(ObjectiveScore(
            objective=Objective.COST,
            raw_value=cost_val,
            normalized_value=cost_norm,
            weight=weights_dict.get(Objective.COST.value, 0.5),
        ))

        safety_val = self._compute_safety(strategy_experiences)
        scores.append(ObjectiveScore(
            objective=Objective.SAFETY,
            raw_value=safety_val,
            normalized_value=safety_val,
            weight=weights_dict.get(Objective.SAFETY.value, 1.5),
        ))

        satisfaction_val = self._compute_satisfaction(strategy_experiences)
        scores.append(ObjectiveScore(
            objective=Objective.USER_SATISFACTION,
            raw_value=satisfaction_val,
            normalized_value=satisfaction_val,
            weight=weights_dict.get(Objective.USER_SATISFACTION.value, 0.8),
        ))

        weighted_sum = sum(s.weighted_score for s in scores)

        return MultiObjectiveResult(
            strategy=strategy,
            scores=scores,
            weighted_sum=weighted_sum,
        )

    def find_pareto_optimal(
        self,
        context: DecisionContext,
        experience_store: DecisionExperienceStore,
    ) -> list[MultiObjectiveResult]:
        results: list[MultiObjectiveResult] = []
        for strategy in DecisionStrategy:
            result = self.evaluate_strategy(strategy, context, experience_store)
            results.append(result)

        pareto: list[MultiObjectiveResult] = []
        for r in results:
            is_dominated = False
            for other in results:
                if other.strategy == r.strategy:
                    continue
                if self._dominates(other, r):
                    is_dominated = True
                    r.dominated_by.append(other.strategy)
            r.pareto_optimal = not is_dominated
            if r.pareto_optimal:
                pareto.append(r)

        if not pareto:
            best = max(results, key=lambda r: r.weighted_sum)
            best.pareto_optimal = True
            pareto.append(best)

        return sorted(pareto, key=lambda r: r.weighted_sum, reverse=True)

    def decide_with_multi_objective(
        self,
        context: DecisionContext,
        experience_store: DecisionExperienceStore,
        meta_engine: MetaDecisionEngine,
    ) -> tuple[DecisionStrategy, MultiObjectiveResult]:
        pareto = self.find_pareto_optimal(context, experience_store)

        if len(pareto) == 1:
            return pareto[0].strategy, pareto[0]

        meta_strategy = meta_engine.decide(context)
        for r in pareto:
            if r.strategy == meta_strategy:
                return r.strategy, r

        best = pareto[0]
        return best.strategy, best

    def _dominates(self, a: MultiObjectiveResult, b: MultiObjectiveResult) -> bool:
        a_scores = {s.objective: s.normalized_value for s in a.scores}
        b_scores = {s.objective: s.normalized_value for s in b.scores}
        all_objectives = set(a_scores.keys()) | set(b_scores.keys())

        at_least_one_better = False
        for obj in all_objectives:
            a_val = a_scores.get(obj, 0.0)
            b_val = b_scores.get(obj, 0.0)
            if a_val < b_val:
                return False
            if a_val > b_val:
                at_least_one_better = True
        return at_least_one_better

    def _compute_quality(self, experiences: list[DecisionExperience]) -> float:
        if not experiences:
            return 0.5
        return sum(e.quality_score for e in experiences) / len(experiences)

    def _compute_latency(self, experiences: list[DecisionExperience]) -> float:
        if not experiences:
            return 5000.0
        return sum(e.duration_ms for e in experiences) / len(experiences)

    def _compute_cost(self, experiences: list[DecisionExperience], strategy: DecisionStrategy) -> float:
        base_costs = {
            DecisionStrategy.RULE_BASED: 1.0,
            DecisionStrategy.LLM_DRIVEN: 10.0,
            DecisionStrategy.DEBATE_DRIVEN: 30.0,
            DecisionStrategy.MCTS_DRIVEN: 20.0,
        }
        base = base_costs.get(strategy, 5.0)
        if experiences:
            avg_cost = sum(e.cost_units for e in experiences) / len(experiences)
            return (base + avg_cost) / 2.0
        return base

    def _compute_safety(self, experiences: list[DecisionExperience]) -> float:
        if not experiences:
            return 0.8
        total_violations = sum(e.safety_violations for e in experiences)
        total_decisions = len(experiences)
        return max(0.0, 1.0 - total_violations / max(total_decisions, 1))

    def _compute_satisfaction(self, experiences: list[DecisionExperience]) -> float:
        if not experiences:
            return 0.5
        rated = [e for e in experiences if e.user_rating > 0]
        if not rated:
            success_rate = sum(1 for e in experiences if e.outcome == "success") / len(experiences)
            return success_rate
        return sum(e.user_rating for e in rated) / len(rated)


class DecisionReflector:
    """决策反思器：自动分析失败决策，提取改进建议。"""

    def analyze_failure(self, experience: DecisionExperience) -> list[str]:
        suggestions: list[str] = []

        if experience.outcome != "failure":
            return suggestions

        if experience.quality_score < 0.3:
            suggestions.append("决策质量极低，建议切换到更高精度策略（debate/mcts）")

        if experience.duration_ms > 30000:
            suggestions.append("决策延迟过高，建议对简单任务使用 rule_based 策略")

        if experience.safety_violations > 0:
            suggestions.append("存在安全违规，建议增加安全约束检查或使用 debate_driven 策略")

        if experience.cost_units > 50:
            suggestions.append("成本过高，建议评估是否可用 rule_based 替代")

        strategy = experience.strategy
        context = experience.context

        if strategy == DecisionStrategy.RULE_BASED and context.complexity in ("complex",):
            suggestions.append("复杂任务使用 rule_based 策略可能不足，建议升级到 llm_driven 或 debate_driven")

        if strategy == DecisionStrategy.LLM_DRIVEN and context.risk_level in ("high", "critical"):
            suggestions.append("高风险任务使用 llm_driven 可能不够严谨，建议升级到 debate_driven")

        if context.emotion in ("frustrated", "anxious") and strategy == DecisionStrategy.RULE_BASED:
            suggestions.append("用户情绪不佳时建议使用更精细的策略以提升满意度")

        return suggestions

    def reflect_on_experience(self, experience: DecisionExperience) -> DecisionExperience:
        if experience.outcome == "failure":
            experience.improvement_suggestions = self.analyze_failure(experience)
            if experience.improvement_suggestions:
                experience.reflection = f"失败原因分析: {'; '.join(experience.improvement_suggestions[:3])}"
        elif experience.quality_score < 0.5:
            experience.reflection = f"决策质量偏低({experience.quality_score:.2f})，可考虑优化策略选择"
        return experience
