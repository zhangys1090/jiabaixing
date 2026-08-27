"""自适应 Token 预算引擎 (Adaptive Token Budget Engine)。

在 DynamicTokenBudgetAllocator 基础上增强：
  - 场景感知分配（开发/闲聊/长任务/搜索/分析）
  - 历史统计反馈（记忆命中率→调整memory预算，工具调用频率→调整tool预算）
  - 实时预算监控与超支预警
  - 预算分配可解释性（每次分配输出决策理由）

Usage:
    engine = AdaptiveTokenBudgetEngine(max_tokens=128000)
    result = engine.allocate(scene="coding", history_stats=stats)
    print(result.allocation)
    print(result.reasoning)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("adaptive_budget")


class Scene(str, Enum):
    CODING = "coding"
    CONVERSATION = "conversation"
    LONG_TASK = "long_task"
    SEARCH = "search"
    ANALYSIS = "analysis"
    PLANNING = "planning"
    GENERAL = "general"


@dataclass
class HistoryStats:
    memory_hit_rate: float = 0.5
    tool_call_frequency: float = 0.3
    conversation_turns: int = 1
    avg_response_tokens: int = 500
    context_overflow_count: int = 0
    tool_result_avg_tokens: int = 200


@dataclass
class BudgetAllocation:
    system_prompt: int = 0
    memory: int = 0
    history: int = 0
    dynamic_context: int = 0
    tool_results: int = 0
    reserve: int = 0


@dataclass
class AllocationDecision:
    component: str
    ratio: float
    tokens: int
    reason: str


@dataclass
class AdaptiveBudgetResult:
    total_budget: int = 0
    scene: str = ""
    allocation: BudgetAllocation = field(default_factory=BudgetAllocation)
    decisions: list[AllocationDecision] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    utilization_forecast: float = 0.0
    timestamp: float = 0.0


_SCENE_BASE_WEIGHTS: dict[Scene, dict[str, float]] = {
    Scene.CODING: {
        "system_prompt": 0.25, "memory": 0.10, "history": 0.20,
        "dynamic_context": 0.25, "tool_results": 0.20,
    },
    Scene.CONVERSATION: {
        "system_prompt": 0.20, "memory": 0.20, "history": 0.35,
        "dynamic_context": 0.10, "tool_results": 0.15,
    },
    Scene.LONG_TASK: {
        "system_prompt": 0.20, "memory": 0.10, "history": 0.15,
        "dynamic_context": 0.15, "tool_results": 0.40,
    },
    Scene.SEARCH: {
        "system_prompt": 0.20, "memory": 0.15, "history": 0.15,
        "dynamic_context": 0.10, "tool_results": 0.40,
    },
    Scene.ANALYSIS: {
        "system_prompt": 0.30, "memory": 0.20, "history": 0.20,
        "dynamic_context": 0.15, "tool_results": 0.15,
    },
    Scene.PLANNING: {
        "system_prompt": 0.40, "memory": 0.10, "history": 0.15,
        "dynamic_context": 0.20, "tool_results": 0.15,
    },
    Scene.GENERAL: {
        "system_prompt": 0.30, "memory": 0.15, "history": 0.25,
        "dynamic_context": 0.15, "tool_results": 0.15,
    },
}

_RESERVE_RATIO = 0.05
_MAX_COMPONENT_RATIO = 0.50
_MIN_COMPONENT_RATIO = 0.03


class AdaptiveTokenBudgetEngine:
    """自适应 Token 预算引擎。

    Args:
        max_tokens: 总 Token 预算。
        reserve_ratio: 保留区比例。
    """

    def __init__(
        self,
        max_tokens: int = 128000,
        reserve_ratio: float = _RESERVE_RATIO,
    ) -> None:
        self._max_tokens = max_tokens
        self._reserve_ratio = reserve_ratio
        self._allocation_history: list[AdaptiveBudgetResult] = []
        self._max_history = 20

    def allocate(
        self,
        scene: str | Scene = Scene.GENERAL,
        history_stats: HistoryStats | None = None,
        overrides: dict[str, float] | None = None,
    ) -> AdaptiveBudgetResult:
        start = time.time()

        if isinstance(scene, str):
            try:
                scene_enum = Scene(scene)
            except ValueError:
                scene_enum = Scene.GENERAL
        else:
            scene_enum = scene

        stats = history_stats or HistoryStats()

        base_weights = dict(_SCENE_BASE_WEIGHTS.get(scene_enum, _SCENE_BASE_WEIGHTS[Scene.GENERAL]))

        decisions: list[AllocationDecision] = []
        for comp, ratio in base_weights.items():
            decisions.append(AllocationDecision(
                component=comp, ratio=ratio, tokens=0,
                reason=f"场景{scene_enum.value}基础权重",
            ))

        adjustments = self._apply_history_feedback(base_weights, stats)
        for comp, (delta, reason) in adjustments.items():
            base_weights[comp] = base_weights.get(comp, 0.0) + delta
            decisions.append(AllocationDecision(
                component=comp, ratio=base_weights[comp], tokens=0,
                reason=f"历史反馈调整: {reason} (Δ={delta:+.3f})",
            ))

        if overrides:
            for comp, ratio in overrides.items():
                if comp in base_weights:
                    old = base_weights[comp]
                    base_weights[comp] = ratio
                    decisions.append(AllocationDecision(
                        component=comp, ratio=ratio, tokens=0,
                        reason=f"手动覆盖: {old:.3f}→{ratio:.3f}",
                    ))

        for comp in base_weights:
            base_weights[comp] = max(_MIN_COMPONENT_RATIO, min(_MAX_COMPONENT_RATIO, base_weights[comp]))

        total_weight = sum(base_weights.values())
        if total_weight > 0:
            base_weights = {k: v / total_weight for k, v in base_weights.items()}

        reserve_tokens = int(self._max_tokens * self._reserve_ratio)
        allocatable = self._max_tokens - reserve_tokens

        allocation = BudgetAllocation(
            system_prompt=int(allocatable * base_weights.get("system_prompt", 0.3)),
            memory=int(allocatable * base_weights.get("memory", 0.15)),
            history=int(allocatable * base_weights.get("history", 0.25)),
            dynamic_context=int(allocatable * base_weights.get("dynamic_context", 0.15)),
            tool_results=int(allocatable * base_weights.get("tool_results", 0.15)),
            reserve=reserve_tokens,
        )

        for d in decisions:
            if d.component == "system_prompt":
                d.tokens = allocation.system_prompt
            elif d.component == "memory":
                d.tokens = allocation.memory
            elif d.component == "history":
                d.tokens = allocation.history
            elif d.component == "dynamic_context":
                d.tokens = allocation.dynamic_context
            elif d.component == "tool_results":
                d.tokens = allocation.tool_results

        warnings = self._generate_warnings(allocation, stats)

        forecast = self._forecast_utilization(allocation, stats)

        result = AdaptiveBudgetResult(
            total_budget=self._max_tokens,
            scene=scene_enum.value,
            allocation=allocation,
            decisions=decisions,
            warnings=warnings,
            utilization_forecast=forecast,
            timestamp=start,
        )

        self._allocation_history.append(result)
        if len(self._allocation_history) > self._max_history:
            self._allocation_history = self._allocation_history[-self._max_history:]

        log.info(
            "自适应预算分配完成",
            scene=scene_enum.value,
            total=self._max_tokens,
            forecast=round(forecast, 3),
            warnings=len(warnings),
        )
        return result

    def _apply_history_feedback(
        self,
        weights: dict[str, float],
        stats: HistoryStats,
    ) -> dict[str, tuple[float, str]]:
        adjustments: dict[str, tuple[float, str]] = {}

        if stats.memory_hit_rate < 0.3:
            delta = 0.05
            adjustments["memory"] = (delta, f"记忆命中率低({stats.memory_hit_rate:.1%})，增加预算")
            adjustments["history"] = (-delta * 0.5, "补偿memory增加")
        elif stats.memory_hit_rate > 0.8:
            delta = 0.03
            adjustments["memory"] = (-delta, f"记忆命中率高({stats.memory_hit_rate:.1%})，减少预算")
            adjustments["dynamic_context"] = (delta, "补偿memory减少")

        if stats.tool_call_frequency > 0.6:
            delta = 0.05
            adjustments["tool_results"] = (delta, f"工具调用频繁({stats.tool_call_frequency:.1%})，增加预算")
            adjustments["history"] = (adjustments.get("history", (0, ""))[0] - delta * 0.5, "补偿tool增加")
        elif stats.tool_call_frequency < 0.1:
            delta = 0.03
            adjustments["tool_results"] = (-delta, f"工具调用稀少({stats.tool_call_frequency:.1%})，减少预算")
            adjustments["dynamic_context"] = (adjustments.get("dynamic_context", (0, ""))[0] + delta, "补偿tool减少")

        if stats.conversation_turns > 15:
            delta = 0.05
            adjustments["history"] = (adjustments.get("history", (0, ""))[0] + delta, f"对话轮次多({stats.conversation_turns})，增加历史预算")
            adjustments["memory"] = (adjustments.get("memory", (0, ""))[0] - delta * 0.3, "补偿history增加")

        if stats.context_overflow_count > 0:
            delta = 0.03 * min(stats.context_overflow_count, 5)
            adjustments["history"] = (adjustments.get("history", (0, ""))[0] - delta, f"上下文溢出{stats.context_overflow_count}次，压缩历史")
            adjustments["reserve"] = (delta * 0.5, "增加保留区")

        return adjustments

    def _generate_warnings(
        self, allocation: BudgetAllocation, stats: HistoryStats,
    ) -> list[str]:
        warnings: list[str] = []

        total_allocated = (
            allocation.system_prompt + allocation.memory + allocation.history
            + allocation.dynamic_context + allocation.tool_results
        )
        if total_allocated > self._max_tokens * 0.95:
            warnings.append(f"预算分配接近上限: {total_allocated}/{self._max_tokens}")

        if allocation.history < 2000 and stats.conversation_turns > 5:
            warnings.append(f"历史预算过小({allocation.history})，对话轮次={stats.conversation_turns}，可能丢失上下文")

        if allocation.tool_results < 1000 and stats.tool_call_frequency > 0.3:
            warnings.append(f"工具结果预算过小({allocation.tool_results})，工具调用频率={stats.tool_call_frequency:.1%}")

        if allocation.reserve < 500:
            warnings.append(f"保留区过小({allocation.reserve})，缺乏弹性空间")

        return warnings

    def _forecast_utilization(
        self, allocation: BudgetAllocation, stats: HistoryStats,
    ) -> float:
        estimated_usage = (
            allocation.system_prompt * 0.9
            + allocation.memory * stats.memory_hit_rate
            + min(allocation.history, stats.conversation_turns * stats.avg_response_tokens)
            + allocation.dynamic_context * 0.7
            + allocation.tool_results * min(1.0, stats.tool_call_frequency * 2)
        )
        return min(1.0, estimated_usage / self._max_tokens) if self._max_tokens > 0 else 0.0

    def get_history(self) -> list[AdaptiveBudgetResult]:
        return list(self._allocation_history)

    def auto_detect_scene(self, task: str, tool_count: int = 0, turn_count: int = 0) -> Scene:
        task_lower = task.lower()

        coding_kws = ["代码", "编程", "debug", "code", "function", "class", "fix", "refactor"]
        if any(kw in task_lower for kw in coding_kws):
            return Scene.CODING

        search_kws = ["搜索", "查找", "search", "find", "lookup", "查询"]
        if any(kw in task_lower for kw in search_kws):
            return Scene.SEARCH

        analysis_kws = ["分析", "比较", "评估", "analyze", "compare", "evaluate"]
        if any(kw in task_lower for kw in analysis_kws):
            return Scene.ANALYSIS

        planning_kws = ["规划", "设计", "计划", "plan", "design", "architect"]
        if any(kw in task_lower for kw in planning_kws):
            return Scene.PLANNING

        if tool_count > 5 or turn_count > 10:
            return Scene.LONG_TASK

        if turn_count <= 3 and tool_count <= 1:
            return Scene.CONVERSATION

        return Scene.GENERAL
