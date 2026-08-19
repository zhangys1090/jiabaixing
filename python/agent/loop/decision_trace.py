"""自主决策可解释性 — 决策链追踪与可解释输出。

设计目标：
1. 每次决策输出 DecisionTrace：决策原因 → 考虑的选项 → 选择理由 → 预期结果
2. 供用户审查：用户可理解 Agent 为何做出该决策
3. 供进化引擎学习：从决策历史中提取成功/失败模式

DecisionTrace 结构：
  - trigger: 触发决策的原因（用户输入/感知变化/定时器）
  - context: 决策时的上下文（感知状态/预算/历史）
  - options: 考虑的所有选项
  - selected: 选择的选项
  - reasoning: 选择理由
  - expected_outcome: 预期结果
  - actual_outcome: 实际结果（事后填充）
  - quality: 决策质量评分

Usage:
    tracer = DecisionTracer()
    trace = tracer.begin("plan_selection", trigger="complex_task")
    trace.add_option("simple_planner", score=0.3)
    trace.add_option("tot_planner", score=0.8)
    trace.select("tot_planner", reason="任务复杂度高，需要多候选规划")
    tracer.end(trace, success=True, quality=0.85)
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("decision_trace")


class DecisionType(str, Enum):
    PLAN_SELECTION = "plan_selection"
    TOOL_SELECTION = "tool_selection"
    STRATEGY_SELECTION = "strategy_selection"
    RETRY_DECISION = "retry_decision"
    DEGRADATION = "degradation"
    ESCALATION = "escalation"
    ABANDONMENT = "abandonment"
    USER_INTERACTION = "user_interaction"
    PROACTIVE_ACTION = "proactive_action"
    MODEL_ROUTING = "model_routing"
    BUDGET_ALLOCATION = "budget_allocation"
    OTHER = "other"


@dataclass
class DecisionOption:
    name: str
    score: float = 0.0
    description: str = ""
    estimated_cost: float = 0.0
    estimated_latency_ms: float = 0.0
    risk_level: str = "low"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class DecisionTrace:
    trace_id: str
    decision_type: DecisionType
    trigger: str
    timestamp: float

    context_snapshot: dict[str, Any] = field(default_factory=dict)
    options: list[DecisionOption] = field(default_factory=list)
    selected_option: str = ""
    selection_reason: str = ""
    expected_outcome: str = ""
    actual_outcome: str = ""
    success: bool | None = None
    quality_score: float = 0.0
    duration_ms: float = 0.0
    completed: bool = False


class DecisionTracer:
    def __init__(self, data_dir: str | None = None, max_history: int = 1000) -> None:
        self._data_dir = Path(data_dir) if data_dir else Path(
            os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data"))
        ) / "decision_traces"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._max_history = max_history
        self._history: list[DecisionTrace] = []
        self._counter = 0
        self._active_traces: dict[str, DecisionTrace] = {}

    def begin(
        self,
        decision_type: str | DecisionType,
        trigger: str,
        context: dict[str, Any] | None = None,
    ) -> DecisionTrace:
        if isinstance(decision_type, str):
            try:
                decision_type = DecisionType(decision_type)
            except ValueError:
                decision_type = DecisionType.OTHER

        self._counter += 1
        trace_id = f"dt_{int(time.time())}_{self._counter:04d}"

        context_snapshot: dict[str, Any] = {}
        if context:
            for key, value in context.items():
                try:
                    json.dumps(value)
                    context_snapshot[key] = value
                except (TypeError, ValueError):
                    context_snapshot[key] = str(value)

        trace = DecisionTrace(
            trace_id=trace_id,
            decision_type=decision_type,
            trigger=trigger,
            timestamp=time.time(),
            context_snapshot=context_snapshot,
        )

        self._active_traces[trace_id] = trace
        return trace

    def add_option(
        self,
        trace: DecisionTrace,
        name: str,
        score: float = 0.0,
        description: str = "",
        estimated_cost: float = 0.0,
        estimated_latency_ms: float = 0.0,
        risk_level: str = "low",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        option = DecisionOption(
            name=name,
            score=score,
            description=description,
            estimated_cost=estimated_cost,
            estimated_latency_ms=estimated_latency_ms,
            risk_level=risk_level,
            metadata=metadata or {},
        )
        trace.options.append(option)

    def select(
        self,
        trace: DecisionTrace,
        option_name: str,
        reason: str = "",
        expected_outcome: str = "",
    ) -> None:
        trace.selected_option = option_name
        trace.selection_reason = reason
        trace.expected_outcome = expected_outcome

    def end(
        self,
        trace: DecisionTrace,
        success: bool,
        quality_score: float = 0.5,
        actual_outcome: str = "",
    ) -> None:
        trace.completed = True
        trace.success = success
        trace.quality_score = quality_score
        trace.actual_outcome = actual_outcome
        trace.duration_ms = (time.time() - trace.timestamp) * 1000

        self._active_traces.pop(trace.trace_id, None)
        self._history.append(trace)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

        self._persist_trace(trace)

    def get_trace(self, trace_id: str) -> DecisionTrace | None:
        active = self._active_traces.get(trace_id)
        if active:
            return active
        for trace in reversed(self._history):
            if trace.trace_id == trace_id:
                return trace
        return None

    def get_recent_traces(self, limit: int = 20) -> list[DecisionTrace]:
        return self._history[-limit:]

    def get_traces_by_type(self, decision_type: DecisionType) -> list[DecisionTrace]:
        return [t for t in self._history if t.decision_type == decision_type]

    def get_explainable_trace(self, trace_id: str) -> dict[str, Any] | None:
        trace = self.get_trace(trace_id)
        if not trace:
            return None

        options_desc = []
        for opt in trace.options:
            options_desc.append({
                "name": opt.name,
                "score": opt.score,
                "description": opt.description,
                "estimated_cost": opt.estimated_cost,
                "risk_level": opt.risk_level,
                "was_selected": opt.name == trace.selected_option,
            })

        return {
            "trace_id": trace.trace_id,
            "decision_type": trace.decision_type.value,
            "trigger": trace.trigger,
            "timestamp": trace.timestamp,
            "context": trace.context_snapshot,
            "options_considered": options_desc,
            "selected": trace.selected_option,
            "reasoning": trace.selection_reason,
            "expected_outcome": trace.expected_outcome,
            "actual_outcome": trace.actual_outcome,
            "success": trace.success,
            "quality_score": trace.quality_score,
        }

    def get_stats(self) -> dict[str, Any]:
        total = len(self._history)
        if total == 0:
            return {"total_decisions": 0}

        successful = sum(1 for t in self._history if t.success)
        avg_quality = sum(t.quality_score for t in self._history) / total

        type_counts: dict[str, int] = {}
        for t in self._history:
            key = t.decision_type.value
            type_counts[key] = type_counts.get(key, 0) + 1

        option_diversity: dict[str, int] = {}
        for t in self._history:
            n = len(t.options)
            option_diversity[f"{n}_options"] = option_diversity.get(f"{n}_options", 0) + 1

        return {
            "total_decisions": total,
            "successful_decisions": successful,
            "success_rate": round(successful / total, 4),
            "avg_quality_score": round(avg_quality, 4),
            "active_traces": len(self._active_traces),
            "decision_type_breakdown": type_counts,
            "option_diversity": option_diversity,
        }

    def _persist_trace(self, trace: DecisionTrace) -> None:
        try:
            path = self._data_dir / f"{trace.trace_id}.json"
            data = {
                "trace_id": trace.trace_id,
                "decision_type": trace.decision_type.value,
                "trigger": trace.trigger,
                "timestamp": trace.timestamp,
                "context_snapshot": trace.context_snapshot,
                "options": [
                    {
                        "name": o.name,
                        "score": o.score,
                        "description": o.description,
                        "estimated_cost": o.estimated_cost,
                        "risk_level": o.risk_level,
                    }
                    for o in trace.options
                ],
                "selected_option": trace.selected_option,
                "selection_reason": trace.selection_reason,
                "expected_outcome": trace.expected_outcome,
                "actual_outcome": trace.actual_outcome,
                "success": trace.success,
                "quality_score": trace.quality_score,
                "duration_ms": round(trace.duration_ms, 2),
            }
            with open(str(path), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log_ignored(log, "decision_tracer._persist_trace", e)
