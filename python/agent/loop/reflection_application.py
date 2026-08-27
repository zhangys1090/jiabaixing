from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from agent.core.logger import StructuredLogger
log = StructuredLogger("reflection_application")



class ReflectionType(str, Enum):
    TOOL_FAILURE = "tool_failure"
    SUCCESS = "success"
    STRATEGY = "strategy"
    PLANNING = "planning"


@dataclass
class ReflectionRecord:
    id: str
    reflection_type: ReflectionType
    content: str
    insight: str = ""
    actionable_items: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    priority: float = 0.5
    application_count: int = 0
    success_count: int = 0
    created_at: float = 0.0
    status: str = "active"

    @property
    def success_rate(self) -> float:
        if self.application_count == 0:
            return 0.0
        return self.success_count / self.application_count


@dataclass
class ReflectionApplierConfig:
    max_reflections: int = 1000
    application_threshold: float = 0.3
    verification_threshold: int = 3
    enable_auto_apply: bool = True


@dataclass
class ApplierMetrics:
    total_reflections: int = 0
    applied_reflections: int = 0
    application_success_rate: float = 0.0
    closed_loop_rate: float = 0.0


class ToolSelector:
    def __init__(self) -> None:
        self._tool_results: dict[str, list[dict[str, Any]]] = {}

    def record_tool_result(
        self,
        tool_name: str,
        success: bool,
        context: dict[str, Any] | None = None,
        result: str = "",
        insight: str = "",
    ) -> None:
        if tool_name not in self._tool_results:
            self._tool_results[tool_name] = []
        self._tool_results[tool_name].append({
            "success": success,
            "context": context or {},
            "result": result,
            "insight": insight,
            "timestamp": time.time(),
        })

    def get_recommended_tools(self, task: str = "") -> list[str]:
        success_rates: dict[str, float] = {}
        for tool_name, results in self._tool_results.items():
            if not results:
                continue
            successes = sum(1 for r in results if r["success"])
            success_rates[tool_name] = successes / len(results)
        sorted_tools = sorted(success_rates.items(), key=lambda x: x[1], reverse=True)
        return [t[0] for t in sorted_tools[:5]]


class StrategyAdapter:
    def __init__(self) -> None:
        self._planning_results: list[dict[str, Any]] = []

    def estimate_complexity(self, task_input: str) -> float:
        complexity_keywords = {
            "同时": 0.3, "并行": 0.3, "多个": 0.2, "综合": 0.2,
            "拆解": 0.2, "分析": 0.15, "对比": 0.15, "整合": 0.2,
            "修改": 0.1, "添加": 0.05, "创建": 0.05,
        }
        score = 0.1
        for kw, weight in complexity_keywords.items():
            if kw in task_input:
                score += weight
        return min(score, 1.0)

    def record_planning_result(
        self,
        task_input: str,
        success: bool,
        complexity: float,
        strategy_used: str = "default",
        result: str = "",
        insight: str = "",
    ) -> None:
        self._planning_results.append({
            "task_input": task_input[:100],
            "success": success,
            "complexity": complexity,
            "strategy_used": strategy_used,
            "result": result,
            "insight": insight,
            "timestamp": time.time(),
        })


class ReflectionApplier:
    def __init__(self, config: ReflectionApplierConfig | None = None) -> None:
        self._config = config or ReflectionApplierConfig()
        self._reflections: dict[str, ReflectionRecord] = {}
        self._enabled = True
        self._application_results: list[dict[str, Any]] = []

    @property
    def enabled(self) -> bool:
        return self._enabled

    def add_reflection(
        self,
        reflection_type: ReflectionType | str,
        content: str,
        insight: str = "",
        actionable_items: list[str] | None = None,
        tags: list[str] | None = None,
        priority: float = 0.5,
    ) -> str:
        if isinstance(reflection_type, str):
            try:
                reflection_type = ReflectionType(reflection_type)
            except ValueError:
                reflection_type = ReflectionType.TOOL_FAILURE
        ref_id = str(uuid.uuid4())
        self._reflections[ref_id] = ReflectionRecord(
            id=ref_id,
            reflection_type=reflection_type,
            content=content,
            insight=insight,
            actionable_items=actionable_items or [],
            tags=tags or [],
            priority=priority,
            created_at=time.time(),
        )
        return ref_id

    def get_reflection(self, ref_id: str) -> ReflectionRecord | None:
        return self._reflections.get(ref_id)

    def apply_reflections(
        self,
        context: dict[str, Any],
        task_type: str = "",
    ) -> list[ReflectionRecord]:
        applied = []
        context_tags = set(context.get("tags", []))
        context_tool = context.get("tool_name", "")

        for ref in self._reflections.values():
            if ref.priority < self._config.application_threshold:
                continue

            relevance = 0.0
            if context_tags & set(ref.tags):
                relevance += 0.3
            if context_tool and context_tool in ref.content:
                relevance += 0.2
            if task_type and task_type in ref.reflection_type.value:
                relevance += 0.3

            if relevance > 0 or not context_tags:
                applied.append(ref)
                ref.application_count += 1

        return applied[:10]

    def record_application_result(
        self,
        ref_id: str,
        success: bool,
        impact_score: float = 0.0,
        feedback: str = "",
    ) -> bool:
        ref = self._reflections.get(ref_id)
        if not ref:
            return False

        if success:
            ref.success_count += 1

        self._application_results.append({
            "ref_id": ref_id,
            "success": success,
            "impact_score": impact_score,
            "feedback": feedback,
            "timestamp": time.time(),
        })
        return True

    def get_metrics(self) -> ApplierMetrics:
        total = len(self._reflections)
        applied = sum(1 for r in self._reflections.values() if r.application_count > 0)

        total_applications = sum(r.application_count for r in self._reflections.values())
        total_successes = sum(r.success_count for r in self._reflections.values())

        verified = sum(
            1 for r in self._reflections.values()
            if r.application_count >= self._config.verification_threshold
        )

        return ApplierMetrics(
            total_reflections=total,
            applied_reflections=applied,
            application_success_rate=total_successes / total_applications if total_applications > 0 else 0.0,
            closed_loop_rate=verified / total if total > 0 else 0.0,
        )

    def _cleanup_expired(self, max_age_days: int = 60) -> None:
        now = time.time()
        cutoff = now - max_age_days * 86400
        for ref in self._reflections.values():
            if ref.created_at < cutoff and ref.status == "active":
                ref.status = "deprecated"


class ReflectionApplicationManager:
    def __init__(self, kb: Any | None = None) -> None:
        self._kb = kb
        self.tool_selector = ToolSelector()
        self.strategy_adapter = StrategyAdapter()
        self._applier = ReflectionApplier()
        self._logger = StructuredLogger("reflection_application_manager")

    def get_adjusted_config(self, input_text: str) -> dict[str, Any]:
        complexity = self.strategy_adapter.estimate_complexity(input_text)
        recommended_tools = self.tool_selector.get_recommended_tools(input_text)

        if complexity < 0.3:
            reflection_depth = "shallow"
        elif complexity < 0.6:
            reflection_depth = "moderate"
        else:
            reflection_depth = "deep"

        return {
            "reflection_depth": reflection_depth,
            "recommended_tools": recommended_tools,
            "complexity": complexity,
        }

    def add_reflection(
        self,
        reflection_type: ReflectionType,
        content: str,
        insight: str = "",
        tags: list[str] | None = None,
        priority: float = 0.5,
    ) -> str:
        return self._applier.add_reflection(
            reflection_type=reflection_type,
            content=content,
            insight=insight,
            tags=tags,
            priority=priority,
        )

    def get_metrics(self) -> ApplierMetrics:
        return self._applier.get_metrics()
