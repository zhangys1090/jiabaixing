"""结构化执行报告 — 每轮循环输出 JSON 报告。

设计目标：
1. 步骤列表：每步的操作、工具调用、结果、耗时
2. 质量评分：多维度质量评分和详细分解
3. 风险标记：识别执行过程中的风险点
4. 改进建议：基于执行结果自动生成改进建议
5. 可解析性：报告可被进化引擎自动解析

报告结构：
  {
    "session_id": "...",
    "task_summary": "...",
    "steps": [...],
    "quality": {...},
    "risks": [...],
    "improvements": [...],
    "resources": {...},
    "metadata": {...}
  }

Usage:
    reporter = StructuredReportGenerator()
    report = reporter.generate(context, result)
    json_str = report.to_json()
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

log = StructuredLogger("structured_report")


class RiskSeverity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ImprovementPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass
class StepReport:
    step_id: str
    action: str
    tool_name: str = ""
    tool_params: dict[str, Any] = field(default_factory=dict)
    success: bool = False
    result_summary: str = ""
    error: str = ""
    duration_ms: float = 0.0
    retry_count: int = 0
    quality_score: float = 0.0


@dataclass
class QualityReport:
    overall_score: float = 0.0
    completeness: float = 0.0
    accuracy: float = 0.0
    efficiency: float = 0.0
    step_success_rate: float = 0.0
    error_recovery_rate: float = 0.0
    time_efficiency: float = 0.0
    breakdown: dict[str, float] = field(default_factory=dict)


@dataclass
class RiskReport:
    risk_type: str
    severity: RiskSeverity
    description: str
    affected_step: str = ""
    mitigation: str = ""


@dataclass
class ImprovementReport:
    area: str
    priority: ImprovementPriority
    description: str
    expected_impact: str = ""
    implementation_hint: str = ""


@dataclass
class ResourceReport:
    total_duration_ms: float = 0.0
    llm_calls: int = 0
    llm_tokens_used: int = 0
    tool_calls: int = 0
    tool_calls_succeeded: int = 0
    tool_calls_failed: int = 0
    peak_memory_mb: float = 0.0
    budget_used_pct: float = 0.0


@dataclass
class StructuredExecutionReport:
    session_id: str
    task_summary: str
    steps: list[StepReport] = field(default_factory=list)
    quality: QualityReport = field(default_factory=QualityReport)
    risks: list[RiskReport] = field(default_factory=list)
    improvements: list[ImprovementReport] = field(default_factory=list)
    resources: ResourceReport = field(default_factory=ResourceReport)
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "task_summary": self.task_summary,
            "timestamp": self.timestamp,
            "steps": [
                {
                    "step_id": s.step_id,
                    "action": s.action,
                    "tool_name": s.tool_name,
                    "success": s.success,
                    "result_summary": s.result_summary[:200],
                    "error": s.error[:200] if s.error else "",
                    "duration_ms": round(s.duration_ms, 2),
                    "retry_count": s.retry_count,
                    "quality_score": round(s.quality_score, 4),
                }
                for s in self.steps
            ],
            "quality": {
                "overall_score": round(self.quality.overall_score, 4),
                "completeness": round(self.quality.completeness, 4),
                "accuracy": round(self.quality.accuracy, 4),
                "efficiency": round(self.quality.efficiency, 4),
                "step_success_rate": round(self.quality.step_success_rate, 4),
                "error_recovery_rate": round(self.quality.error_recovery_rate, 4),
                "time_efficiency": round(self.quality.time_efficiency, 4),
                "breakdown": self.quality.breakdown,
            },
            "risks": [
                {
                    "type": r.risk_type,
                    "severity": r.severity.value,
                    "description": r.description,
                    "affected_step": r.affected_step,
                    "mitigation": r.mitigation,
                }
                for r in self.risks
            ],
            "improvements": [
                {
                    "area": i.area,
                    "priority": i.priority.value,
                    "description": i.description,
                    "expected_impact": i.expected_impact,
                }
                for i in self.improvements
            ],
            "resources": {
                "total_duration_ms": round(self.resources.total_duration_ms, 2),
                "llm_calls": self.resources.llm_calls,
                "llm_tokens_used": self.resources.llm_tokens_used,
                "tool_calls": self.resources.tool_calls,
                "tool_calls_succeeded": self.resources.tool_calls_succeeded,
                "tool_calls_failed": self.resources.tool_calls_failed,
                "budget_used_pct": round(self.resources.budget_used_pct, 2),
            },
            "metadata": self.metadata,
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent)


class StructuredReportGenerator:
    def __init__(self, persist_dir: str | None = None) -> None:
        self._persist_dir = Path(persist_dir) if persist_dir else Path(
            os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data"))
        ) / "execution_reports"
        self._persist_dir.mkdir(parents=True, exist_ok=True)
        self._report_counter = 0

    def generate(
        self,
        context: Any,
        result: Any,
        session_id: str = "",
    ) -> StructuredExecutionReport:
        self._report_counter += 1

        task_summary = self._extract_task_summary(context, result)
        steps = self._extract_steps(context)
        quality = self._extract_quality(context, result)
        risks = self._identify_risks(steps, quality)
        improvements = self._generate_improvements(steps, quality, risks)
        resources = self._extract_resources(context, result)

        report = StructuredExecutionReport(
            session_id=session_id or f"session_{int(time.time())}",
            task_summary=task_summary,
            steps=steps,
            quality=quality,
            risks=risks,
            improvements=improvements,
            resources=resources,
            timestamp=time.time(),
        )

        self._persist_report(report)
        return report

    def _extract_task_summary(self, context: Any, result: Any) -> str:
        if result and hasattr(result, "response") and result.response:
            return result.response[:300]
        if context and hasattr(context, "messages") and context.messages:
            for msg in reversed(context.messages):
                if msg.get("role") == "user":
                    return msg.get("content", "")[:300]
        return "Unknown task"

    def _extract_steps(self, context: Any) -> list[StepReport]:
        steps: list[StepReport] = []
        if not context or not hasattr(context, "step_results"):
            return steps

        for step_id, step_result in context.step_results.items():
            tool_name = ""
            tool_params: dict[str, Any] = {}
            if hasattr(step_result, "tool_name"):
                tool_name = step_result.tool_name
            if hasattr(step_result, "tool_params"):
                tool_params = step_result.tool_params

            duration_ms = 0.0
            if hasattr(step_result, "duration_ms"):
                duration_ms = step_result.duration_ms

            retry_count = 0
            if hasattr(step_result, "retry_count"):
                retry_count = step_result.retry_count

            steps.append(StepReport(
                step_id=str(step_id),
                action=tool_name or str(step_id),
                tool_name=tool_name,
                tool_params=tool_params,
                success=getattr(step_result, "success", False),
                result_summary=getattr(step_result, "content", "")[:200],
                error=getattr(step_result, "error", ""),
                duration_ms=duration_ms,
                retry_count=retry_count,
            ))

        return steps

    def _extract_quality(self, context: Any, result: Any) -> QualityReport:
        quality = QualityReport()

        if result and hasattr(result, "quality_score"):
            quality.overall_score = result.quality_score

        if result and hasattr(result, "quality_breakdown"):
            quality.breakdown = result.quality_breakdown or {}
            quality.completeness = quality.breakdown.get("response_completeness", 0.0)
            quality.step_success_rate = quality.breakdown.get("step_success_rate", 0.0)
            quality.error_recovery_rate = quality.breakdown.get("error_recovery", 0.0)
            quality.time_efficiency = quality.breakdown.get("time_efficiency", 0.0)

        if context and hasattr(context, "step_results"):
            total = len(context.step_results)
            if total > 0:
                succeeded = sum(1 for s in context.step_results.values() if getattr(s, "success", False))
                quality.step_success_rate = succeeded / total

        return quality

    def _identify_risks(
        self,
        steps: list[StepReport],
        quality: QualityReport,
    ) -> list[RiskReport]:
        risks: list[RiskReport] = []

        failed_steps = [s for s in steps if not s.success]
        if len(failed_steps) > len(steps) * 0.5 and len(steps) > 2:
            risks.append(RiskReport(
                risk_type="high_failure_rate",
                severity=RiskSeverity.HIGH,
                description=f"步骤失败率过高: {len(failed_steps)}/{len(steps)}",
                mitigation="检查工具可用性和参数正确性",
            ))

        for step in failed_steps:
            if step.retry_count >= 3:
                risks.append(RiskReport(
                    risk_type="excessive_retries",
                    severity=RiskSeverity.MEDIUM,
                    description=f"步骤 {step.step_id} 重试次数过多 ({step.retry_count})",
                    affected_step=step.step_id,
                    mitigation="考虑更换工具或调整参数",
                ))

        if quality.overall_score < 0.4:
            risks.append(RiskReport(
                risk_type="low_quality",
                severity=RiskSeverity.HIGH,
                description=f"整体质量评分过低: {quality.overall_score:.2f}",
                mitigation="检查规划质量和执行策略",
            ))

        if quality.step_success_rate < 0.5:
            risks.append(RiskReport(
                risk_type="low_step_success",
                severity=RiskSeverity.MEDIUM,
                description=f"步骤成功率过低: {quality.step_success_rate:.2f}",
                mitigation="检查工具选择和参数配置",
            ))

        slow_steps = [s for s in steps if s.duration_ms > 10000]
        if slow_steps:
            risks.append(RiskReport(
                risk_type="slow_operations",
                severity=RiskSeverity.LOW,
                description=f"有 {len(slow_steps)} 个步骤耗时超过 10 秒",
                mitigation="考虑优化工具调用或增加超时设置",
            ))

        return risks

    def _generate_improvements(
        self,
        steps: list[StepReport],
        quality: QualityReport,
        risks: list[RiskReport],
    ) -> list[ImprovementReport]:
        improvements: list[ImprovementReport] = []

        failed_tools: dict[str, int] = {}
        for step in steps:
            if not step.success and step.tool_name:
                failed_tools[step.tool_name] = failed_tools.get(step.tool_name, 0) + 1

        for tool_name, fail_count in failed_tools.items():
            improvements.append(ImprovementReport(
                area="tool_reliability",
                priority=ImprovementPriority.HIGH if fail_count >= 3 else ImprovementPriority.MEDIUM,
                description=f"工具 {tool_name} 失败 {fail_count} 次",
                expected_impact="提高工具调用成功率",
                implementation_hint="检查工具参数或添加降级策略",
            ))

        if quality.completeness < 0.6:
            improvements.append(ImprovementReport(
                area="response_quality",
                priority=ImprovementPriority.MEDIUM,
                description="响应完整性不足",
                expected_impact="提高用户满意度",
                implementation_hint="增加推理深度或补充执行步骤",
            ))

        if quality.time_efficiency < 0.5:
            improvements.append(ImprovementReport(
                area="efficiency",
                priority=ImprovementPriority.MEDIUM,
                description="时间效率偏低",
                expected_impact="减少任务完成时间",
                implementation_hint="优化工具选择、启用并行执行",
            ))

        high_risks = [r for r in risks if r.severity in (RiskSeverity.HIGH, RiskSeverity.CRITICAL)]
        if high_risks:
            improvements.append(ImprovementReport(
                area="risk_management",
                priority=ImprovementPriority.HIGH,
                description=f"存在 {len(high_risks)} 个高风险项",
                expected_impact="降低任务失败风险",
                implementation_hint="优先处理高风险项的缓解措施",
            ))

        return improvements

    def _extract_resources(self, context: Any, result: Any) -> ResourceReport:
        resources = ResourceReport()

        if result and hasattr(result, "total_duration_ms"):
            resources.total_duration_ms = result.total_duration_ms

        if context and hasattr(context, "budget"):
            budget = context.budget
            if hasattr(budget, "start_time") and budget.start_time > 0:
                resources.total_duration_ms = (time.time() - budget.start_time) * 1000
            if hasattr(budget, "tokens_used") and hasattr(budget, "token_limit"):
                if budget.token_limit > 0:
                    resources.budget_used_pct = (budget.tokens_used / budget.token_limit) * 100

        if context and hasattr(context, "step_results"):
            resources.tool_calls = len(context.step_results)
            resources.tool_calls_succeeded = sum(
                1 for s in context.step_results.values() if getattr(s, "success", False)
            )
            resources.tool_calls_failed = resources.tool_calls - resources.tool_calls_succeeded

        return resources

    def _persist_report(self, report: StructuredExecutionReport) -> None:
        try:
            filename = f"report_{report.session_id}_{int(report.timestamp)}.json"
            path = self._persist_dir / filename
            with open(str(path), "w", encoding="utf-8") as f:
                f.write(report.to_json())
        except Exception as e:
            log_ignored(log, "structured_report._persist_report", e)
