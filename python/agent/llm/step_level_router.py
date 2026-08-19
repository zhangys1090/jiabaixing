"""子步骤级模型路由（Step-Level Router）。

在 CapabilityAwareRouter（任务级路由）基础上，提供更细粒度的
**子步骤级**模型路由能力——同一任务的不同子步骤可选用不同模型。

核心能力：
1. 子步骤级路由：每个 PlanStep 独立路由到最合适的模型
2. 路由缓存：相似步骤的路由决策缓存复用，减少重复计算
3. 降级策略：首选模型不可用时自动降级到备选模型
4. Token 预算感知：结合 TokenBudgetManager 的预算状态调整路由

与 TaskAwareModelRouter 的关系：
- TaskAwareModelRouter: 任务级路由（整个任务 → 一个 Provider）
- StepLevelRouter: 子步骤级路由（每个步骤 → 最优 Provider）

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 非侵入式：未挂载时回退到 TaskAwareModelRouter
- 可选挂载：通过 LoopController 注入
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.llm.capability_aware_router import CapabilityAwareRouter, TaskRequirement, ScoredProvider
from agent.core.logger import StructuredLogger

log = StructuredLogger("step_level_router")


class StepComplexity(str, Enum):
    TRIVIAL = "trivial"
    SIMPLE = "simple"
    MODERATE = "moderate"
    COMPLEX = "complex"
    CRITICAL = "critical"


STEP_COMPLEXITY_REQUIREMENTS: dict[StepComplexity, TaskRequirement] = {
    StepComplexity.TRIVIAL: TaskRequirement(
        needs_reasoning=0.1,
        needs_tool_calling=0.2,
        max_cost_tier=3.0,
    ),
    StepComplexity.SIMPLE: TaskRequirement(
        needs_reasoning=0.2,
        needs_tool_calling=0.3,
        max_cost_tier=5.0,
    ),
    StepComplexity.MODERATE: TaskRequirement(
        needs_reasoning=0.5,
        needs_tool_calling=0.5,
        needs_code_generation=0.3,
    ),
    StepComplexity.COMPLEX: TaskRequirement(
        needs_reasoning=0.8,
        needs_tool_calling=0.7,
        needs_code_generation=0.6,
        needs_structured_output=0.5,
    ),
    StepComplexity.CRITICAL: TaskRequirement(
        needs_reasoning=1.0,
        needs_tool_calling=0.8,
        needs_code_generation=0.8,
        needs_structured_output=0.7,
    ),
}

TOOL_COMPLEXITY_MAP: dict[str, StepComplexity] = {
    "shell_exec": StepComplexity.MODERATE,
    "file_read": StepComplexity.TRIVIAL,
    "file_write": StepComplexity.SIMPLE,
    "code_analyze": StepComplexity.COMPLEX,
    "execute_code": StepComplexity.COMPLEX,
    "web_search": StepComplexity.SIMPLE,
    "emotion_perceive": StepComplexity.TRIVIAL,
    "scene_perceive": StepComplexity.TRIVIAL,
    "environment_sense": StepComplexity.TRIVIAL,
    "speech_transcribe": StepComplexity.SIMPLE,
    "screenshot": StepComplexity.TRIVIAL,
    "click": StepComplexity.SIMPLE,
    "type_text": StepComplexity.TRIVIAL,
    "code_review_project": StepComplexity.CRITICAL,
    "debug_error": StepComplexity.COMPLEX,
    "deploy": StepComplexity.CRITICAL,
}


@dataclass
class StepRouteDecision:
    step_id: str = ""
    step_description: str = ""
    step_complexity: StepComplexity = StepComplexity.MODERATE
    provider: str = ""
    score: float = 0.0
    fallback_provider: str = ""
    reasoning: str = ""
    from_cache: bool = False
    budget_aware: bool = False


@dataclass
class StepRouteCacheEntry:
    decision: StepRouteDecision
    timestamp: float = 0.0
    hit_count: int = 0


class StepLevelRouter:
    """子步骤级模型路由器。"""

    def __init__(
        self,
        capability_router: CapabilityAwareRouter | None = None,
        cache_ttl_seconds: float = 300.0,
        cache_max_size: int = 500,
    ) -> None:
        self._capability_router = capability_router or CapabilityAwareRouter()
        self._cache_ttl = cache_ttl_seconds
        self._cache_max_size = cache_max_size
        self._cache: dict[str, StepRouteCacheEntry] = {}
        self._route_count = 0
        self._cache_hit_count = 0
        self._fallback_count = 0
        self._budget_manager: Any | None = None

    def set_capability_router(self, router: CapabilityAwareRouter) -> None:
        self._capability_router = router

    def set_budget_manager(self, manager: Any) -> None:
        self._budget_manager = manager

    def route_step(
        self,
        step_id: str,
        step_description: str,
        tool_name: str = "",
        step_context: dict[str, Any] | None = None,
        candidates: list[str] | None = None,
    ) -> StepRouteDecision:
        self._route_count += 1

        complexity = self._assess_complexity(step_description, tool_name, step_context)

        cache_key = self._make_cache_key(step_description, tool_name, complexity)
        cached = self._cache.get(cache_key)
        if cached and (time.time() - cached.timestamp) < self._cache_ttl:
            cached.hit_count += 1
            self._cache_hit_count += 1
            decision = StepRouteDecision(
                step_id=step_id,
                step_description=step_description,
                step_complexity=complexity,
                provider=cached.decision.provider,
                score=cached.decision.score,
                fallback_provider=cached.decision.fallback_provider,
                reasoning=cached.decision.reasoning + " (缓存命中)",
                from_cache=True,
            )
            return decision

        requirement = self._build_requirement(complexity, step_context)

        if self._budget_manager:
            budget_check = self._budget_manager.check_budget(
                session_id=step_context.get("session_id", "default") if step_context else "default",
                agent_id=step_context.get("agent_id", "") if step_context else "",
            )
            if budget_check.level in ("critical", "exhausted"):
                requirement.max_cost_tier = 3.0

        scored = self._capability_router.rank(requirement)
        if not scored:
            return StepRouteDecision(
                step_id=step_id,
                step_description=step_description,
                step_complexity=complexity,
                provider="",
                score=0.0,
                reasoning="无可用 Provider",
            )

        best = scored[0]
        fallback = scored[1].provider if len(scored) > 1 else ""

        reasoning_parts = [
            f"步骤复杂度={complexity.value}",
            f"选中={best.provider}(评分={best.score:.3f})",
        ]
        if fallback:
            reasoning_parts.append(f"备选={fallback}")
        if best.reasons:
            reasoning_parts.extend(best.reasons[:3])

        decision = StepRouteDecision(
            step_id=step_id,
            step_description=step_description,
            step_complexity=complexity,
            provider=best.provider,
            score=best.score,
            fallback_provider=fallback,
            reasoning="; ".join(reasoning_parts),
            budget_aware=self._budget_manager is not None,
        )

        self._cache[cache_key] = StepRouteCacheEntry(
            decision=decision,
            timestamp=time.time(),
            hit_count=0,
        )
        if len(self._cache) > self._cache_max_size:
            self._evict_cache()

        return decision

    def route_plan(
        self,
        steps: list[dict[str, Any]],
        candidates: list[str] | None = None,
    ) -> list[StepRouteDecision]:
        decisions: list[StepRouteDecision] = []
        for step in steps:
            step_id = step.get("id", step.get("step_id", ""))
            description = step.get("description", "")
            tool_name = step.get("tool_name", "")
            context = step.get("context")
            decision = self.route_step(
                step_id=step_id,
                step_description=description,
                tool_name=tool_name,
                step_context=context,
                candidates=candidates,
            )
            decisions.append(decision)
        return decisions

    def get_fallback(self, decision: StepRouteDecision) -> StepRouteDecision | None:
        if not decision.fallback_provider:
            return None
        self._fallback_count += 1
        return StepRouteDecision(
            step_id=decision.step_id,
            step_description=decision.step_description,
            step_complexity=decision.step_complexity,
            provider=decision.fallback_provider,
            score=0.0,
            fallback_provider="",
            reasoning=f"降级到备选: {decision.fallback_provider}",
        )

    def _assess_complexity(
        self,
        description: str,
        tool_name: str,
        context: dict[str, Any] | None = None,
    ) -> StepComplexity:
        if tool_name and tool_name in TOOL_COMPLEXITY_MAP:
            base = TOOL_COMPLEXITY_MAP[tool_name]
        else:
            base = StepComplexity.MODERATE

        if context:
            risk = context.get("risk_level", "low")
            if risk in ("high", "critical"):
                if base.value < StepComplexity.COMPLEX.value:
                    base = StepComplexity.COMPLEX

        desc_lower = description.lower()
        critical_keywords = ["审查", "review", "部署", "deploy", "删除", "delete", "生产", "production"]
        for kw in critical_keywords:
            if kw in desc_lower:
                base = StepComplexity.CRITICAL
                break

        return base

    def _build_requirement(
        self,
        complexity: StepComplexity,
        context: dict[str, Any] | None = None,
    ) -> TaskRequirement:
        base_req = STEP_COMPLEXITY_REQUIREMENTS.get(complexity, TaskRequirement())

        if context:
            if context.get("needs_multi_modal"):
                base_req.needs_multi_modal = True
            if context.get("preferred_provider"):
                base_req.preferred_provider = context["preferred_provider"]
            min_ctx = context.get("min_context_window", 0)
            if min_ctx:
                base_req.min_context_window = min_ctx

        return base_req

    def _make_cache_key(
        self,
        description: str,
        tool_name: str,
        complexity: StepComplexity,
    ) -> str:
        raw = f"{description[:100]}|{tool_name}|{complexity.value}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _evict_cache(self) -> None:
        sorted_entries = sorted(
            self._cache.items(),
            key=lambda x: (x[1].timestamp, -x[1].hit_count),
        )
        keep = sorted_entries[self._cache_max_size // 2:]
        self._cache = dict(keep)

    def clear_cache(self) -> None:
        self._cache.clear()

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "route_count": self._route_count,
            "cache_hit_count": self._cache_hit_count,
            "cache_hit_rate": (
                round(self._cache_hit_count / self._route_count, 3)
                if self._route_count > 0 else 0.0
            ),
            "fallback_count": self._fallback_count,
            "cache_size": len(self._cache),
        }
