"""沙箱审计子代理 — Phase 3+4 审计集成到主系统循环。

周期性检测沙箱隔离完整性，采集健康状态和指标，
当检测到异常时触发修复动作（降级通知、配置热更新、事件告警）。

集成方式：
1. 作为后台任务由 LoopController 启动
2. 通过 KernelEventHooks 监听沙箱事件
3. 通过 context.metadata 注入审计结果供主循环消费
4. 异常时通过 Observer 记录告警
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.types import RiskLevel, BaseAuditFinding, BaseAuditReport
from agent.core.logger import StructuredLogger

log = StructuredLogger("sandbox_audit_agent")


_AUDIT_SEVERITY_TO_RISK: dict[str, RiskLevel] = {
    "info": RiskLevel.LOW,
    "warning": RiskLevel.MEDIUM,
    "critical": RiskLevel.CRITICAL,
}


def _audit_severity_to_risk(level: str) -> RiskLevel:
    return _AUDIT_SEVERITY_TO_RISK.get(level, RiskLevel.LOW)


@dataclass
class AuditFinding(BaseAuditFinding):
    """沙箱审计发现 — 继承 core.types.BaseAuditFinding。"""

    backend: str = ""
    metric_key: str = ""
    metric_value: Any = None


@dataclass
class AuditReport(BaseAuditReport):
    """沙箱审计报告 — 继承 core.types.BaseAuditReport。"""

    health_summary: dict[str, Any] = field(default_factory=dict)
    metrics_summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "overall_status": self.overall_status,
            "finding_count": len(self.findings),
            "critical_count": sum(1 for f in self.findings if f.severity == RiskLevel.CRITICAL),
            "warning_count": sum(1 for f in self.findings if f.severity in (RiskLevel.MEDIUM, RiskLevel.HIGH)),
            "findings": [
                {
                    "severity": f.severity.value,
                    "category": f.category,
                    "message": f.message,
                    "backend": f.backend,
                    "remediation": f.remediation,
                }
                for f in self.findings
            ],
            "health": self.health_summary,
            "metrics": self.metrics_summary,
        }


class SandboxAuditAgent:
    """沙箱审计子代理 — 周期性检测隔离完整性。

    审计维度：
    1. 后端可用性 — 检测每个后端的健康状态
    2. 错误率 — 检测后端错误率是否超过阈值
    3. 延迟 — 检测后端延迟是否超过阈值
    4. 降级频率 — 检测降级是否过于频繁
    5. 配置一致性 — 检测后端优先级配置是否合理
    """

    _DEFAULT_ERROR_RATE_THRESHOLD = 0.3
    _DEFAULT_LATENCY_MS_THRESHOLD = 30000.0
    _DEFAULT_DEGRADE_COUNT_THRESHOLD = 10
    _DEFAULT_CHECK_INTERVAL_SEC = 120.0

    def __init__(
        self,
        error_rate_threshold: float = _DEFAULT_ERROR_RATE_THRESHOLD,
        latency_ms_threshold: float = _DEFAULT_LATENCY_MS_THRESHOLD,
        degrade_count_threshold: int = _DEFAULT_DEGRADE_COUNT_THRESHOLD,
        check_interval_sec: float = _DEFAULT_CHECK_INTERVAL_SEC,
    ) -> None:
        self._error_rate_threshold = error_rate_threshold
        self._latency_ms_threshold = latency_ms_threshold
        self._degrade_count_threshold = degrade_count_threshold
        self._check_interval_sec = check_interval_sec
        self._running: bool = False
        self._task: asyncio.Task[None] | None = None
        self._last_report: AuditReport | None = None
        self._report_history: list[AuditReport] = []
        self._max_history: int = 50
        self._on_report_callbacks: list[Any] = []

    @property
    def last_report(self) -> AuditReport | None:
        return self._last_report

    @property
    def is_running(self) -> bool:
        return self._running

    def on_report(self, callback: Any) -> None:
        self._on_report_callbacks.append(callback)

    async def run_audit(self) -> AuditReport:
        """执行一次完整审计。"""
        findings: list[AuditFinding] = []
        health_summary: dict[str, Any] = {}
        metrics_summary: dict[str, Any] = {}

        try:
            from agent.sandbox.kernel_isolation import KernelIsolationProvider

            health = await KernelIsolationProvider.health_check(force=True)
            for backend_type, status in health.items():
                health_summary[backend_type.value] = {
                    "available": status.available,
                    "consecutive_failures": status.consecutive_failures,
                    "uptime_ratio": round(status.uptime_ratio, 3),
                }

                if not status.available and status.consecutive_failures >= 3:
                    findings.append(AuditFinding(
                        severity=AuditSeverity.CRITICAL,
                        category="backend_availability",
                        message=f"后端 {backend_type.value} 连续 {status.consecutive_failures} 次不可用",
                        backend=backend_type.value,
                        remediation="检查后端依赖是否安装，考虑调整优先级或注销后端",
                    ))
                elif not status.available:
                    findings.append(AuditFinding(
                        severity=AuditSeverity.WARNING,
                        category="backend_availability",
                        message=f"后端 {backend_type.value} 不可用 (连续失败: {status.consecutive_failures})",
                        backend=backend_type.value,
                        remediation="持续监控，若连续失败超过 3 次将升级为 CRITICAL",
                    ))

            metrics = KernelIsolationProvider.get_metrics()
            metrics_summary = metrics.to_dict()

            for backend_name, backend_metrics in metrics_summary.get("backends", {}).items():
                error_count = backend_metrics.get("errors", 0)
                spawn_count = backend_metrics.get("spawns", 0)
                if spawn_count > 0:
                    error_rate = error_count / spawn_count
                    if error_rate > self._error_rate_threshold:
                        findings.append(AuditFinding(
                            severity=AuditSeverity.CRITICAL if error_rate > 0.5 else AuditSeverity.WARNING,
                            category="error_rate",
                            message=f"后端 {backend_name} 错误率 {error_rate:.1%} 超过阈值 {self._error_rate_threshold:.1%}",
                            backend=backend_name,
                            metric_key="error_rate",
                            metric_value=error_rate,
                            remediation="检查后端配置和资源，考虑降低优先级",
                        ))

                avg_latency = backend_metrics.get("avg_latency_ms", 0.0)
                if avg_latency > self._latency_ms_threshold:
                    findings.append(AuditFinding(
                        severity=AuditSeverity.WARNING,
                        category="latency",
                        message=f"后端 {backend_name} 平均延迟 {avg_latency:.0f}ms 超过阈值 {self._latency_ms_threshold:.0f}ms",
                        backend=backend_name,
                        metric_key="avg_latency_ms",
                        metric_value=avg_latency,
                        remediation="检查后端资源负载，考虑增加超时或切换后端",
                    ))

            if metrics.degrade_count > self._degrade_count_threshold:
                findings.append(AuditFinding(
                    severity=AuditSeverity.WARNING,
                    category="degrade_frequency",
                    message=f"降级次数 {metrics.degrade_count} 超过阈值 {self._degrade_count_threshold}",
                    metric_key="degrade_count",
                    metric_value=metrics.degrade_count,
                    remediation="检查内核级隔离环境配置，考虑修复后端或调整默认层级",
                ))

            backends = KernelIsolationProvider.list_backends()
            priorities = [b.priority for b in backends]
            if len(priorities) != len(set(priorities)):
                findings.append(AuditFinding(
                    severity=AuditSeverity.INFO,
                    category="config_consistency",
                    message="多个后端具有相同优先级，auto_select 结果可能不稳定",
                    remediation="为每个后端设置唯一优先级",
                ))

        except Exception as exc:
            findings.append(AuditFinding(
                severity=AuditSeverity.CRITICAL,
                category="audit_error",
                message=f"审计执行异常: {exc}",
                remediation="检查沙箱模块导入和配置",
            ))
            log.warning("Sandbox audit failed", error=str(exc))

        try:
            from agent.desktop.action_sandbox import ActionSandbox
            sandbox = ActionSandbox()
            sandbox_result = await sandbox.integrate_with_sandbox_audit()
            stats = sandbox_result.get("sandbox_stats", {})
            block_rate = stats.get("block_rate", 0.0)
            if block_rate > 0.3:
                findings.append(AuditFinding(
                    severity=AuditSeverity.WARNING,
                    category="action_sandbox_block_rate",
                    message=f"ActionSandbox 拦截率 {block_rate:.1%} 偏高",
                    metric_key="block_rate",
                    metric_value=block_rate,
                    remediation="检查操作目标是否合理，或调整安全策略",
                ))
            active_checkpoints = stats.get("active_checkpoints", 0)
            if active_checkpoints > 20:
                findings.append(AuditFinding(
                    severity=AuditSeverity.INFO,
                    category="action_sandbox_checkpoints",
                    message=f"ActionSandbox 活跃 checkpoint 数 {active_checkpoints}，可能需要清理",
                    metric_key="active_checkpoints",
                    metric_value=active_checkpoints,
                    remediation="清理已完成的 checkpoint 释放资源",
                ))
            sandbox.close()
        except Exception as exc:
            log.debug("Sandbox audit: ActionSandbox integration skipped", error=str(exc))

        overall = "healthy"
        if any(f.severity == AuditSeverity.CRITICAL for f in findings):
            overall = "critical"
        elif any(f.severity == AuditSeverity.WARNING for f in findings):
            overall = "warning"

        report = AuditReport(
            findings=findings,
            health_summary=health_summary,
            metrics_summary=metrics_summary,
            overall_status=overall,
        )

        self._last_report = report
        self._report_history.append(report)
        if len(self._report_history) > self._max_history:
            self._report_history = self._report_history[-self._max_history:]

        for cb in self._on_report_callbacks:
            try:
                result = cb(report)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:
                log.debug("Report callback error", error=str(exc))

        log.info(
            "Sandbox audit complete",
            status=overall,
            findings=len(findings),
            critical=sum(1 for f in findings if f.severity == AuditSeverity.CRITICAL),
        )

        return report

    async def start(self) -> None:
        """启动周期性审计后台任务。"""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        log.info("Sandbox audit agent started", interval=self._check_interval_sec)

    async def stop(self) -> None:
        """停止周期性审计。"""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("Sandbox audit agent stopped")

    async def _run_loop(self) -> None:
        """审计循环。"""
        while self._running:
            try:
                await self.run_audit()
            except Exception as exc:
                log.warning("Audit loop error", error=str(exc))
            await asyncio.sleep(self._check_interval_sec)

    def get_report_history(self, limit: int = 10) -> list[AuditReport]:
        return self._report_history[-limit:]
