from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.persistence.trajectory import (
    ExecutionRecord,
    ToolInvocationRecord,
    TrajectoryDatabase,
)
from agent.core.logger import log_ignored


@dataclass
class ToolStat:
    total_calls: int = 0
    success_rate: float = 0.0
    avg_duration: float = 0.0
    error_rate: float = 0.0
    common_errors: list[str] = field(default_factory=list)


@dataclass
class OptimizationSuggestion:
    id: str = ""
    type: str = "tool"
    priority: str = "medium"
    description: str = ""
    expected_impact: str = ""
    implementation_steps: list[str] = field(default_factory=list)
    estimated_improvement: float = 0.0
    confidence: float = 0.0


@dataclass
class TrajectoryAnalysis:
    total_executions: int = 0
    success_rate: float = 0.0
    avg_duration: float = 0.0
    avg_tool_calls: float = 0.0
    avg_quality_score: float = 0.0
    tool_stats: dict[str, ToolStat] = field(default_factory=dict)
    common_failure_patterns: list[str] = field(default_factory=list)
    common_success_patterns: list[str] = field(default_factory=list)
    optimal_tool_sequences: list[dict[str, Any]] = field(default_factory=list)
    bottlenecks: list[dict[str, Any]] = field(default_factory=list)
    optimization_suggestions: list[OptimizationSuggestion] = field(default_factory=list)


@dataclass
class FlywheelConfig:
    analysis_window_hours: int = 168
    min_sample_size: int = 10
    auto_apply_optimizations: bool = True  # P1 修复：默认启用自动应用，闭合飞轮
    suggestion_threshold: float = 0.7


class TrajectoryFlywheel:
    def __init__(
        self,
        trajectory_db: TrajectoryDatabase,
        config: FlywheelConfig | None = None,
    ) -> None:
        self.db = trajectory_db
        self.config = config or FlywheelConfig()
        self._recent_analyses: list[TrajectoryAnalysis] = []
        self._applied_optimizations: dict[str, dict[str, Any]] = {}

    def analyze(self) -> TrajectoryAnalysis:
        cutoff_ms = int((time.time() - self.config.analysis_window_hours * 3600) * 1000)
        executions = [
            e for e in self.db.get_recent_executions(500) if e.created_at >= cutoff_ms
        ]

        tool_invocations: list[ToolInvocationRecord] = []
        for exec_rec in executions:
            tool_invocations.extend(self.db.get_tool_invocations(exec_rec.id))

        analysis = TrajectoryAnalysis(
            total_executions=len(executions),
            success_rate=self._calc_success_rate(executions),
            avg_duration=self._calc_avg_duration(executions),
            avg_tool_calls=self._calc_avg_tool_calls(executions),
            avg_quality_score=self._calc_avg_quality(executions),
            tool_stats=self._analyze_tool_usage(tool_invocations),
            common_failure_patterns=self._detect_failure_patterns(executions),
            common_success_patterns=self._detect_success_patterns(executions),
            optimal_tool_sequences=self._find_optimal_sequences(executions, tool_invocations),
            bottlenecks=self._identify_bottlenecks(tool_invocations),
            optimization_suggestions=self._generate_suggestions(executions, tool_invocations),
        )

        self._recent_analyses.append(analysis)
        if len(self._recent_analyses) > 10:
            self._recent_analyses.pop(0)

        return analysis

    def apply_suggestion(self, suggestion_id: str) -> dict[str, Any]:
        suggestion = None
        for analysis in self._recent_analyses:
            for s in analysis.optimization_suggestions:
                if s.id == suggestion_id:
                    suggestion = s
                    break

        if not suggestion:
            return {"success": False, "message": "建议不存在"}

        if suggestion.confidence < self.config.suggestion_threshold:
            return {"success": False, "message": "建议置信度低于阈值"}

        # P1 修复：实际应用建议到进化引擎工具权重，而非仅记录到内存 dict
        applied = False
        try:
            from agent.evolution.orchestrator import EvolutionOrchestrator

            orchestrator = EvolutionOrchestrator.get_instance()
            if orchestrator._evolution_engine:
                engine = orchestrator._evolution_engine
                # 根据 suggestion.type 调整工具权重
                if suggestion.type == "tool" and suggestion.description:
                    # 提取工具名（描述中通常包含工具名）
                    for tool_name in engine._tool_weights:
                        if tool_name in suggestion.description:
                            # 成功模式 → 提升权重，失败模式 → 降低权重
                            if "失败" in suggestion.description or "错误" in suggestion.description:
                                new_weight = max(0.1, engine._tool_weights[tool_name] - 0.1)
                                engine._update_tool_weight(tool_name, new_weight)
                                applied = True
                            elif "成功" in suggestion.description or "优化" in suggestion.description:
                                new_weight = min(1.0, engine._tool_weights[tool_name] + 0.1)
                                engine._update_tool_weight(tool_name, new_weight)
                                applied = True
        except Exception as _exc:
            log_ignored(None, "flywheel.TrajectoryFlywheel.apply_suggestion", _exc)

        self._applied_optimizations[suggestion_id] = {
            "timestamp": time.time(),
            "impact": suggestion.estimated_improvement,
            "actually_applied": applied,
        }
        return {"success": True, "message": f"已应用建议: {suggestion.description}", "applied_to_engine": applied}

    def get_improvement_trend(self) -> dict[str, Any]:
        if len(self._recent_analyses) < 2:
            return {"trend": "stable", "data": []}

        data = []
        for i, analysis in enumerate(self._recent_analyses):
            data.append({
                "index": i,
                "success_rate": analysis.success_rate,
                "avg_duration": analysis.avg_duration,
            })

        first = data[0]
        last = data[-1]
        sr_trend = last["success_rate"] - first["success_rate"]

        trend = "improving" if sr_trend > 0.05 else "declining" if sr_trend < -0.05 else "stable"
        return {"trend": trend, "data": data}

    @staticmethod
    def _calc_success_rate(executions: list[ExecutionRecord]) -> float:
        if not executions:
            return 0.0
        return sum(1 for e in executions if e.status == "success") / len(executions)

    @staticmethod
    def _calc_avg_duration(executions: list[ExecutionRecord]) -> float:
        if not executions:
            return 0.0
        return sum(e.total_duration for e in executions) / len(executions)

    @staticmethod
    def _calc_avg_tool_calls(executions: list[ExecutionRecord]) -> float:
        if not executions:
            return 0.0
        return sum(e.total_tool_calls for e in executions) / len(executions)

    @staticmethod
    def _calc_avg_quality(executions: list[ExecutionRecord]) -> float:
        scored = [e for e in executions if e.quality_overall is not None]
        if not scored:
            return 0.0
        return sum(e.quality_overall for e in scored) / len(scored)

    @staticmethod
    def _analyze_tool_usage(
        invocations: list[ToolInvocationRecord],
    ) -> dict[str, ToolStat]:
        stats: dict[str, ToolStat] = {}
        error_lists: dict[str, list[str]] = {}

        for inv in invocations:
            name = inv.tool_name
            if name not in stats:
                stats[name] = ToolStat()
                error_lists[name] = []

            s = stats[name]
            s.total_calls += 1
            success = inv.result_success == 1
            s.success_rate = (s.success_rate * (s.total_calls - 1) + (1 if success else 0)) / s.total_calls
            s.avg_duration = (s.avg_duration * (s.total_calls - 1) + inv.duration) / s.total_calls

            if not success:
                s.error_rate = (s.error_rate * (s.total_calls - 1) + 1) / s.total_calls
                if inv.error_message:
                    error_lists[name].append(inv.error_message)

        for name, errors in error_lists.items():
            simplified: dict[str, int] = {}
            for err in errors:
                key = _simplify_error(err)
                simplified[key] = simplified.get(key, 0) + 1
            stats[name].common_errors = sorted(simplified, key=simplified.get, reverse=True)[:5]

        return stats

    @staticmethod
    def _detect_failure_patterns(executions: list[ExecutionRecord]) -> list[str]:
        patterns: list[str] = []
        failed = [e for e in executions if e.status != "success"]
        if any(e.total_tool_calls > 15 for e in failed):
            patterns.append("工具调用过多导致超时")
        if any(e.total_duration > 300000 for e in failed):
            patterns.append("执行时间过长（>5分钟）")
        return patterns

    @staticmethod
    def _detect_success_patterns(executions: list[ExecutionRecord]) -> list[str]:
        patterns: list[str] = []
        successful = [e for e in executions if e.status == "success"]
        if any(3 <= e.total_tool_calls <= 8 for e in successful):
            patterns.append("工具调用数量适中（3-8次）")
        return patterns

    @staticmethod
    def _find_optimal_sequences(
        executions: list[ExecutionRecord],
        invocations: list[ToolInvocationRecord],
    ) -> list[dict[str, Any]]:
        by_exec: dict[str, list[ToolInvocationRecord]] = {}
        for inv in invocations:
            by_exec.setdefault(inv.execution_id, []).append(inv)

        seq_stats: dict[str, dict[str, int]] = {}
        for exec_rec in executions:
            invs = by_exec.get(exec_rec.id, [])
            if not invs:
                continue
            seq = " → ".join(i.tool_name for i in sorted(invs, key=lambda x: x.step_index))
            if seq not in seq_stats:
                seq_stats[seq] = {"total": 0, "success": 0}
            seq_stats[seq]["total"] += 1
            if exec_rec.status == "success":
                seq_stats[seq]["success"] += 1

        result: list[dict[str, Any]] = []
        for seq, data in seq_stats.items():
            if data["total"] >= 3 and data["success"] / data["total"] > 0.8:
                result.append({
                    "sequence": seq.split(" → "),
                    "success_rate": data["success"] / data["total"],
                })

        return result[:10]

    @staticmethod
    def _identify_bottlenecks(
        invocations: list[ToolInvocationRecord],
    ) -> list[dict[str, Any]]:
        bottlenecks: list[dict[str, Any]] = []

        timings: dict[str, dict[str, float]] = {}
        for inv in invocations:
            name = inv.tool_name
            if name not in timings:
                timings[name] = {"total": 0.0, "count": 0.0}
            timings[name]["total"] += inv.duration
            timings[name]["count"] += 1

        sorted_tools = sorted(
            ((n, d["total"] / d["count"], d["count"]) for n, d in timings.items()),
            key=lambda x: x[1],
            reverse=True,
        )

        for name, avg_dur, count in sorted_tools[:3]:
            if avg_dur > 2000 and count >= 5:
                bottlenecks.append({
                    "type": "tool",
                    "description": f'工具 "{name}" 平均耗时 {int(avg_dur)}ms，调用 {int(count)} 次',
                    "impact": "high" if avg_dur > 5000 else "medium",
                    "suggestion": f'考虑优化工具 "{name}" 的性能',
                })

        return bottlenecks

    def _generate_suggestions(
        self,
        executions: list[ExecutionRecord],
        invocations: list[ToolInvocationRecord],
    ) -> list[OptimizationSuggestion]:
        suggestions: list[OptimizationSuggestion] = []
        tool_stats = self._analyze_tool_usage(invocations)
        sid = 0

        for name, stats in tool_stats.items():
            if stats.error_rate > 0.2 and stats.total_calls >= self.config.min_sample_size:
                suggestions.append(OptimizationSuggestion(
                    id=f"tool_{sid}",
                    type="tool",
                    priority="high" if stats.error_rate > 0.4 else "medium",
                    description=f'工具 "{name}" 失败率过高 ({int(stats.error_rate * 100)}%)',
                    expected_impact="减少工具调用失败，提高整体成功率",
                    implementation_steps=[
                        f'分析工具 "{name}" 的常见错误',
                        "增强参数验证",
                        "添加重试机制",
                    ],
                    estimated_improvement=stats.error_rate * 50,
                    confidence=min(0.9, stats.total_calls / 50),
                ))
                sid += 1

            if stats.avg_duration > 3000 and stats.total_calls >= self.config.min_sample_size:
                suggestions.append(OptimizationSuggestion(
                    id=f"perf_{sid}",
                    type="tool",
                    priority="medium",
                    description=f'工具 "{name}" 平均响应时间过长 ({int(stats.avg_duration)}ms)',
                    expected_impact="提高响应速度",
                    implementation_steps=["分析性能瓶颈", "考虑使用缓存", "优化算法"],
                    estimated_improvement=min(30, stats.avg_duration / 1000 * 5),
                    confidence=0.7,
                ))
                sid += 1

        low_quality = [e for e in executions if e.quality_overall is not None and e.quality_overall < 0.5]
        if len(low_quality) >= self.config.min_sample_size:
            suggestions.append(OptimizationSuggestion(
                id=f"prompt_{sid}",
                type="prompt",
                priority="medium",
                description=f"发现 {len(low_quality)} 次低质量执行 (评分<0.5)",
                expected_impact="提升输出质量",
                implementation_steps=["检查低质量执行的共同点", "优化系统提示词"],
                estimated_improvement=20,
                confidence=0.6,
            ))

        priority_weight = {"high": 3, "medium": 2, "low": 1}
        suggestions.sort(key=lambda s: priority_weight.get(s.priority, 0), reverse=True)
        return suggestions


def _simplify_error(error: str) -> str:
    import re
    s = re.sub(r"\d+", "[number]", error)
    s = re.sub(r"[a-f0-9]{32}", "[hash]", s, flags=re.I)
    s = re.sub(r"['\"].*?['\"]", "[string]", s)
    return s.strip()
