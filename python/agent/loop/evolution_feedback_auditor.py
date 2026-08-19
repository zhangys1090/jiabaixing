"""进化反馈闭环校验器（Evolution Feedback Loop Auditor）。

在现有 EvolutionEngine（信号记录+自适应调整）基础上，增强为：
1. 埋点完整性校验：验证每个工具调用的成败信号是否都上报到进化引擎
2. 信号一致性校验：验证上报信号与实际执行结果一致
3. 自适应退化检测：检测进化引擎的自适应调整是否退化（如优先级长期不变）
4. 闭环延迟监控：监控从信号产生到自适应调整生效的延迟
5. 校验报告生成：生成闭环健康度报告

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 EvolutionEngine 集成，复用其信号记录基础设施
- 非侵入式：旁路校验，不修改进化引擎内部逻辑
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("evolution_feedback_auditor")


class AuditSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class SignalType(str, Enum):
    TOOL_SUCCESS = "tool_success"
    TOOL_FAILURE = "tool_failure"
    TOOL_TIMEOUT = "tool_timeout"
    REFLECTION_SUCCESS = "reflection_success"
    REFLECTION_FAILURE = "reflection_failure"
    RETRY_SUCCESS = "retry_success"
    RETRY_FAILURE = "retry_failure"
    FALLBACK_SUCCESS = "fallback_success"
    FALLBACK_FAILURE = "fallback_failure"


@dataclass
class SignalRecord:
    signal_id: str = ""
    signal_type: SignalType = SignalType.TOOL_SUCCESS
    tool_name: str = ""
    timestamp: float = 0.0
    success: bool = True
    duration_ms: float = 0.0
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExecutionRecord:
    execution_id: str = ""
    tool_name: str = ""
    timestamp: float = 0.0
    success: bool = True
    duration_ms: float = 0.0
    error: str | None = None
    reported: bool = False


@dataclass
class AuditFinding:
    finding_id: str = ""
    severity: AuditSeverity = AuditSeverity.INFO
    category: str = ""
    description: str = ""
    tool_name: str = ""
    expected: str = ""
    actual: str = ""
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class AdaptationSnapshot:
    timestamp: float = 0.0
    tool_priorities: dict[str, float] = field(default_factory=dict)
    reflection_config: dict[str, Any] = field(default_factory=dict)
    success_rates: dict[str, float] = field(default_factory=dict)


@dataclass
class LoopHealthReport:
    audit_id: str = ""
    timestamp: float = 0.0
    total_executions: int = 0
    reported_signals: int = 0
    missing_signals: int = 0
    inconsistent_signals: int = 0
    coverage_rate: float = 0.0
    consistency_rate: float = 0.0
    avg_signal_delay_ms: float = 0.0
    adaptation_stagnation_detected: bool = False
    findings: list[AuditFinding] = field(default_factory=list)
    overall_health: str = "healthy"


class EvolutionFeedbackAuditor:
    """进化反馈闭环校验器：旁路校验进化引擎的信号完整性和自适应效果。"""

    def __init__(
        self,
        stagnation_window: int = 50,
        stagnation_threshold: float = 0.02,
        coverage_threshold: float = 0.99,
        consistency_threshold: float = 0.95,
    ) -> None:
        self._stagnation_window = stagnation_window
        self._stagnation_threshold = stagnation_threshold
        self._coverage_threshold = coverage_threshold
        self._consistency_threshold = consistency_threshold
        self._executions: list[ExecutionRecord] = []
        self._signals: list[SignalRecord] = []
        self._adaptation_history: list[AdaptationSnapshot] = []
        self._tool_signal_map: dict[str, list[str]] = {}

    def record_execution(
        self,
        execution_id: str,
        tool_name: str,
        success: bool,
        duration_ms: float = 0.0,
        error: str | None = None,
    ) -> None:
        self._executions.append(ExecutionRecord(
            execution_id=execution_id,
            tool_name=tool_name,
            timestamp=time.time(),
            success=success,
            duration_ms=duration_ms,
            error=error,
        ))

    def record_signal(
        self,
        signal_id: str,
        signal_type: SignalType,
        tool_name: str,
        success: bool,
        duration_ms: float = 0.0,
        error: str | None = None,
    ) -> None:
        self._signals.append(SignalRecord(
            signal_id=signal_id,
            signal_type=signal_type,
            tool_name=tool_name,
            timestamp=time.time(),
            success=success,
            duration_ms=duration_ms,
            error=error,
        ))
        if tool_name not in self._tool_signal_map:
            self._tool_signal_map[tool_name] = []
        self._tool_signal_map[tool_name].append(signal_id)

        for ex in reversed(self._executions):
            if ex.tool_name == tool_name and not ex.reported:
                ex.reported = True
                break

    def record_adaptation_snapshot(
        self,
        tool_priorities: dict[str, float],
        reflection_config: dict[str, Any],
        success_rates: dict[str, float],
    ) -> None:
        self._adaptation_history.append(AdaptationSnapshot(
            timestamp=time.time(),
            tool_priorities=dict(tool_priorities),
            reflection_config=dict(reflection_config),
            success_rates=dict(success_rates),
        ))

    def audit_coverage(self) -> list[AuditFinding]:
        findings: list[AuditFinding] = []
        unreported = [ex for ex in self._executions if not ex.reported]

        for ex in unreported:
            findings.append(AuditFinding(
                finding_id=f"cov_{len(findings)}",
                severity=AuditSeverity.WARNING if not ex.success else AuditSeverity.INFO,
                category="coverage_gap",
                description=f"工具 '{ex.tool_name}' 执行未上报信号",
                tool_name=ex.tool_name,
                expected="信号已上报",
                actual="信号未上报",
                timestamp=time.time(),
                metadata={"execution_id": ex.execution_id, "success": ex.success},
            ))

        return findings

    def audit_consistency(self) -> list[AuditFinding]:
        findings: list[AuditFinding] = []

        for tool_name in self._tool_signal_map:
            tool_executions = [
                ex for ex in self._executions if ex.tool_name == tool_name
            ]
            tool_signals = [
                s for s in self._signals if s.tool_name == tool_name
            ]

            if len(tool_executions) != len(tool_signals):
                continue

            for ex, sig in zip(
                sorted(tool_executions, key=lambda x: x.timestamp),
                sorted(tool_signals, key=lambda x: x.timestamp),
            ):
                if ex.success != sig.success:
                    findings.append(AuditFinding(
                        finding_id=f"con_{len(findings)}",
                        severity=AuditSeverity.CRITICAL,
                        category="consistency_violation",
                        description=f"工具 '{tool_name}' 执行结果与信号不一致",
                        tool_name=tool_name,
                        expected=f"success={ex.success}",
                        actual=f"signal_success={sig.success}",
                        timestamp=time.time(),
                        metadata={
                            "execution_id": ex.execution_id,
                            "signal_id": sig.signal_id,
                        },
                    ))

        return findings

    def audit_adaptation_stagnation(self) -> list[AuditFinding]:
        findings: list[AuditFinding] = []

        if len(self._adaptation_history) < 2:
            return findings

        recent = self._adaptation_history[-self._stagnation_window:]
        if len(recent) < 2:
            return findings

        first = recent[0]
        last = recent[-1]

        priority_changes: dict[str, float] = {}
        for tool in set(list(first.tool_priorities.keys()) + list(last.tool_priorities.keys())):
            old_p = first.tool_priorities.get(tool, 0.0)
            new_p = last.tool_priorities.get(tool, 0.0)
            if old_p > 0:
                priority_changes[tool] = abs(new_p - old_p) / old_p

        stagnant_tools = [
            tool for tool, change in priority_changes.items()
            if change < self._stagnation_threshold
        ]

        if len(stagnant_tools) > len(priority_changes) * 0.8:
            findings.append(AuditFinding(
                finding_id="stag_0",
                severity=AuditSeverity.WARNING,
                category="adaptation_stagnation",
                description=f"自适应优先级大面积停滞 ({len(stagnant_tools)}/{len(priority_changes)} 工具无变化)",
                tool_name="",
                expected="优先级随反馈动态调整",
                actual=f"{len(stagnant_tools)} 工具优先级停滞",
                timestamp=time.time(),
                metadata={"stagnant_tools": stagnant_tools[:10]},
            ))

        return findings

    def audit_signal_delay(self) -> list[AuditFinding]:
        findings: list[AuditFinding] = []
        delays: list[float] = []

        for sig in self._signals:
            for ex in reversed(self._executions):
                if ex.tool_name == sig.tool_name and ex.timestamp <= sig.timestamp:
                    delay_ms = (sig.timestamp - ex.timestamp) * 1000
                    delays.append(delay_ms)
                    if delay_ms > 1000:
                        findings.append(AuditFinding(
                            finding_id=f"delay_{len(findings)}",
                            severity=AuditSeverity.WARNING,
                            category="signal_delay",
                            description=f"工具 '{sig.tool_name}' 信号延迟过高 ({delay_ms:.0f}ms)",
                            tool_name=sig.tool_name,
                            expected="< 1000ms",
                            actual=f"{delay_ms:.0f}ms",
                            timestamp=time.time(),
                        ))
                    break

        return findings

    def run_full_audit(self) -> LoopHealthReport:
        all_findings: list[AuditFinding] = []
        all_findings.extend(self.audit_coverage())
        all_findings.extend(self.audit_consistency())
        all_findings.extend(self.audit_adaptation_stagnation())
        all_findings.extend(self.audit_signal_delay())

        total_exec = len(self._executions)
        reported = sum(1 for ex in self._executions if ex.reported)
        missing = total_exec - reported
        coverage_rate = reported / total_exec if total_exec > 0 else 1.0

        inconsistent = sum(
            1 for f in all_findings if f.category == "consistency_violation"
        )
        consistency_rate = 1.0 - (inconsistent / total_exec if total_exec > 0 else 0.0)

        delays: list[float] = []
        for sig in self._signals:
            for ex in reversed(self._executions):
                if ex.tool_name == sig.tool_name and ex.timestamp <= sig.timestamp:
                    delays.append((sig.timestamp - ex.timestamp) * 1000)
                    break
        avg_delay = sum(delays) / len(delays) if delays else 0.0

        stagnation_detected = any(
            f.category == "adaptation_stagnation" for f in all_findings
        )

        critical_count = sum(1 for f in all_findings if f.severity == AuditSeverity.CRITICAL)
        warning_count = sum(1 for f in all_findings if f.severity == AuditSeverity.WARNING)

        if critical_count > 0:
            health = "unhealthy"
        elif warning_count > 3 or stagnation_detected:
            health = "degraded"
        else:
            health = "healthy"

        report = LoopHealthReport(
            audit_id=f"audit_{int(time.time())}",
            timestamp=time.time(),
            total_executions=total_exec,
            reported_signals=reported,
            missing_signals=missing,
            inconsistent_signals=inconsistent,
            coverage_rate=round(coverage_rate, 4),
            consistency_rate=round(consistency_rate, 4),
            avg_signal_delay_ms=round(avg_delay, 1),
            adaptation_stagnation_detected=stagnation_detected,
            findings=all_findings,
            overall_health=health,
        )

        log.info(
            "Evolution feedback audit completed",
            health=health,
            coverage=f"{coverage_rate:.2%}",
            consistency=f"{consistency_rate:.2%}",
            findings=len(all_findings),
            critical=critical_count,
            warning=warning_count,
        )

        return report

    def get_tool_coverage(self, tool_name: str) -> dict[str, Any]:
        tool_execs = [ex for ex in self._executions if ex.tool_name == tool_name]
        reported = sum(1 for ex in tool_execs if ex.reported)
        total = len(tool_execs)
        return {
            "tool_name": tool_name,
            "total_executions": total,
            "reported_signals": reported,
            "missing_signals": total - reported,
            "coverage_rate": reported / total if total > 0 else 1.0,
        }

    def reset(self) -> None:
        self._executions.clear()
        self._signals.clear()
        self._adaptation_history.clear()
        self._tool_signal_map.clear()
