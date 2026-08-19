"""P3 监管器（P3Supervisor）。

统一管理 P3 阶段三大能力：可观测性、安全审计、进化反馈闭环。

作为 Agent 生命周期中的横切关注点，P3Supervisor 在每次 Agent 交互前后
自动执行以下操作:
- 前置: 安全审计检查、环境健康验证
- 后置: 指标记录、反馈信号收集、进化触发检测
- 定时: 安全审计报告生成、仪表盘快照

Usage:
    from agent.p3_supervisor import P3Supervisor

    supervisor = P3Supervisor()
    supervisor.register_engines(evolution_engine=engine, orchestrator=orch)

    # 在 Agent 交互前后调用
    await supervisor.pre_interaction(agent_name="agent_1", scene="coding")
    # ... Agent 执行 ...
    await supervisor.post_interaction(
        agent_name="agent_1",
        scene="coding",
        success=True,
        duration_ms=150,
        tokens=500,
        tool_calls=3,
        tool_success=2,
    )
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.agent_metrics import AgentMetricsDashboard
from agent.evolution.feedback_loop import (
    EvolutionSuggestion,
    FeedbackLoop,
    FeedbackLoopStats,
    FeedbackSignal,
    FeedbackSignalType,
)
from agent.security.audit_reporter import (
    AuditDimension,
    AuditReport,
    SecurityAuditReporter,
    Severity,
)


@dataclass
class P3HealthStatus:
    """P3 健康状态。

    Attributes:
        healthy: 整体是否健康。
        observability_ok: 可观测性是否正常。
        security_ok: 安全审计是否正常。
        evolution_ok: 进化引擎是否正常。
        warnings: 警告信息。
        last_audit_severity: 最近一次审计严重级别。
        metrics_agent_count: 已监控的 Agent 数量。
        feedback_suggestions: 待处理的进化建议数。
    """

    healthy: bool = True
    observability_ok: bool = True
    security_ok: bool = True
    evolution_ok: bool = True
    warnings: list[str] = field(default_factory=list)
    last_audit_severity: str = "low"
    metrics_agent_count: int = 0
    feedback_suggestions: int = 0


@dataclass
class P3InteractionContext:
    """P3 交互上下文。

    Attributes:
        interaction_id: 交互ID。
        agent_name: Agent名称。
        scene: 场景。
        start_time: 开始时间。
        pre_check_passed: 前置检查是否通过。
        pre_check_warnings: 前置检查警告。
    """

    interaction_id: str = ""
    agent_name: str = ""
    scene: str = "general"
    start_time: float = 0.0
    pre_check_passed: bool = True
    pre_check_warnings: list[str] = field(default_factory=list)


class P3Supervisor:
    """P3 监管器。

    统一管理可观测性、安全审计、进化反馈闭环三大能力。
    """

    def __init__(self) -> None:
        self._metrics_dashboard = AgentMetricsDashboard()
        self._audit_reporter = SecurityAuditReporter()
        self._feedback_loop = FeedbackLoop()

        self._evolution_engine: Any = None
        self._evolution_orchestrator: Any = None

        self._last_audit: AuditReport | None = None
        self._last_audit_time: float = 0.0
        self._audit_interval_seconds: float = 3600.0

        self._interaction_count: int = 0
        self._active_interactions: dict[str, P3InteractionContext] = {}

    def register_engines(
        self,
        evolution_engine: Any = None,
        evolution_orchestrator: Any = None,
    ) -> None:
        """注册进化引擎。

        Args:
            evolution_engine: EvolutionEngine 实例。
            evolution_orchestrator: EvolutionOrchestrator 实例。
        """
        self._evolution_engine = evolution_engine
        self._evolution_orchestrator = evolution_orchestrator
        self._feedback_loop = FeedbackLoop(evolution_engine)

    async def pre_interaction(
        self,
        agent_name: str,
        scene: str = "general",
        env_vars: dict[str, str] | None = None,
        config_values: dict[str, Any] | None = None,
    ) -> P3InteractionContext:
        """Agent 交互前置检查。

        Args:
            agent_name: Agent名称。
            scene: 场景。
            env_vars: 环境变量。
            config_values: 配置值。

        Returns:
            P3InteractionContext: 交互上下文。
        """
        interaction_id = f"p3-{int(time.time() * 1000)}-{self._interaction_count}"
        self._interaction_count += 1

        ctx = P3InteractionContext(
            interaction_id=interaction_id,
            agent_name=agent_name,
            scene=scene,
            start_time=time.time(),
            pre_check_passed=True,
        )

        now = time.time()
        # 限流仅约束"重跑审计"这一昂贵动作，不得连带跳过结论的执行。
        if now - self._last_audit_time > self._audit_interval_seconds:
            self._last_audit = self._audit_reporter.run_audit(
                dimensions=[AuditDimension.CONFIG, AuditDimension.NETWORK],
                env_vars=env_vars,
                config_values=config_values,
            )
            self._last_audit_time = now

        # fail-closed：无论本次是否重跑，最新已知审计结论始终参与放行判断。
        # 此前该判断嵌在限流 if 内，导致任一次审计后的 _audit_interval_seconds
        # （默认 3600s）窗口内，已知 HIGH/CRITICAL 发现完全不拦截交互，
        # 且与 get_health_status() 无条件读取 _last_audit 的口径自相矛盾。
        # 属静默降级 / fail-open，见审计报告 §1.7。
        if self._last_audit is not None and self._last_audit.severity in (
            Severity.HIGH,
            Severity.CRITICAL,
        ):
            ctx.pre_check_passed = False
            for finding in self._last_audit.findings:
                if finding.severity in (Severity.HIGH, Severity.CRITICAL):
                    ctx.pre_check_warnings.append(
                        f"[{finding.severity.value}] {finding.title}: {finding.recommendation}"
                    )

        self._active_interactions[interaction_id] = ctx
        return ctx

    async def post_interaction(
        self,
        agent_name: str,
        scene: str = "general",
        success: bool = True,
        duration_ms: float = 0.0,
        tokens: int = 0,
        tool_calls: int = 0,
        tool_success: int = 0,
        error: str = "",
        tool_name: str = "",
        user_feedback: str = "",
        interaction_id: str = "",
    ) -> list[EvolutionSuggestion]:
        """Agent 交互后置处理。

        Args:
            agent_name: Agent名称。
            scene: 场景。
            success: 是否成功。
            duration_ms: 耗时。
            tokens: Token消耗。
            tool_calls: 工具调用次数。
            tool_success: 工具成功次数。
            error: 错误信息。
            tool_name: 工具名称。
            user_feedback: 用户反馈。
            interaction_id: 交互ID。

        Returns:
            list[EvolutionSuggestion]: 进化建议列表。
        """
        self._metrics_dashboard.record(
            agent_name=agent_name,
            scene=scene,
            success=success,
            duration_ms=duration_ms,
            tokens=tokens,
            tool_calls=tool_calls,
            tool_success=tool_success,
            error=error,
        )

        if tool_name:
            if success:
                signal_type = FeedbackSignalType.TOOL_SUCCESS
            else:
                signal_type = FeedbackSignalType.TOOL_FAILURE
        elif not success:
            signal_type = FeedbackSignalType.TASK_FAILURE
        else:
            signal_type = FeedbackSignalType.TASK_SUCCESS

        signal = FeedbackSignal(
            signal_type=signal_type,
            agent_name=agent_name,
            tool_name=tool_name,
            scene=scene,
            success=success,
            duration_ms=duration_ms,
            error=error,
            user_feedback=user_feedback,
        )
        self._feedback_loop.collect_signal(signal)

        suggestions = self._feedback_loop.check_and_evolve()
        for suggestion in suggestions:
            if suggestion.auto_apply:
                self._feedback_loop.apply_plan(suggestion)

        if interaction_id and interaction_id in self._active_interactions:
            del self._active_interactions[interaction_id]

        return suggestions

    def get_health_status(self) -> P3HealthStatus:
        """获取 P3 健康状态。

        Returns:
            P3HealthStatus: 健康状态。
        """
        warnings: list[str] = []

        dashboard_summary = self._metrics_dashboard.get_summary()
        observability_ok = True
        if dashboard_summary.total_requests > 0 and dashboard_summary.overall_success_rate < 0.5:
            observability_ok = False
            warnings.append(f"整体成功率过低: {dashboard_summary.overall_success_rate:.0%}")

        security_ok = True
        audit_severity = "low"
        if self._last_audit:
            audit_severity = self._last_audit.severity.value
            if self._last_audit.severity in (Severity.HIGH, Severity.CRITICAL):
                security_ok = False
                warnings.append(f"安全审计发现严重问题: {self._last_audit.total_findings} 个发现")

        feedback_stats = self._feedback_loop.get_stats()
        evolution_ok = True
        if feedback_stats.success_rate_improvement < -10.0:
            evolution_ok = False
            warnings.append(f"进化引擎成功率下降: {feedback_stats.success_rate_improvement:.1f}%")

        healthy = observability_ok and security_ok and evolution_ok

        return P3HealthStatus(
            healthy=healthy,
            observability_ok=observability_ok,
            security_ok=security_ok,
            evolution_ok=evolution_ok,
            warnings=warnings,
            last_audit_severity=audit_severity,
            metrics_agent_count=dashboard_summary.total_agents,
            feedback_suggestions=feedback_stats.suggestions_generated,
        )

    def get_dashboard_summary(self):
        """获取可观测性仪表盘汇总。

        Returns:
            DashboardSummary: 仪表盘汇总。
        """
        return self._metrics_dashboard.get_summary()

    def get_agent_stats(self, agent_name: str):
        """获取指定 Agent 的指标。

        Args:
            agent_name: Agent名称。

        Returns:
            AgentMetrics | None: Agent指标。
        """
        return self._metrics_dashboard.get_agent_stats(agent_name)

    def get_feedback_stats(self) -> FeedbackLoopStats:
        """获取反馈闭环统计。

        Returns:
            FeedbackLoopStats: 反馈闭环统计。
        """
        return self._feedback_loop.get_stats()

    def run_security_audit(
        self,
        dimensions: list[AuditDimension] | None = None,
        env_vars: dict[str, str] | None = None,
        config_values: dict[str, Any] | None = None,
    ) -> AuditReport:
        """执行安全审计。

        Args:
            dimensions: 审计维度。
            env_vars: 环境变量。
            config_values: 配置值。

        Returns:
            AuditReport: 审计报告。
        """
        self._last_audit = self._audit_reporter.run_audit(
            dimensions=dimensions,
            env_vars=env_vars,
            config_values=config_values,
        )
        self._last_audit_time = time.time()
        return self._last_audit

    def record_user_correction(self, agent_name: str, scene: str, feedback: str) -> None:
        """记录用户修正信号。

        Args:
            agent_name: Agent名称。
            scene: 场景。
            feedback: 用户反馈文本。
        """
        signal = FeedbackSignal(
            signal_type=FeedbackSignalType.USER_CORRECTION,
            agent_name=agent_name,
            scene=scene,
            success=False,
            user_feedback=feedback,
        )
        self._feedback_loop.collect_signal(signal)

    def record_user_satisfaction(self, agent_name: str, scene: str, satisfied: bool, feedback: str = "") -> None:
        """记录用户满意度信号。

        Args:
            agent_name: Agent名称。
            scene: 场景。
            satisfied: 是否满意。
            feedback: 用户反馈文本。
        """
        signal = FeedbackSignal(
            signal_type=FeedbackSignalType.USER_SATISFACTION,
            agent_name=agent_name,
            scene=scene,
            success=satisfied,
            user_feedback=feedback,
        )
        self._feedback_loop.collect_signal(signal)

    def pre_interaction_sync(
        self,
        agent_name: str,
        scene: str = "general",
        env_vars: dict[str, str] | None = None,
        config_values: dict[str, Any] | None = None,
    ) -> P3InteractionContext:
        """同步版 Agent 交互前置检查。"""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is not None:
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(
                    asyncio.run,
                    self.pre_interaction(agent_name, scene, env_vars, config_values),
                )
                return future.result()
        else:
            return asyncio.run(
                self.pre_interaction(agent_name, scene, env_vars, config_values),
            )

    def post_interaction_sync(
        self,
        agent_name: str,
        scene: str = "general",
        success: bool = True,
        duration_ms: float = 0.0,
        tokens: int = 0,
        tool_calls: int = 0,
        tool_success: int = 0,
        error: str = "",
        tool_name: str = "",
        user_feedback: str = "",
        interaction_id: str = "",
    ) -> list[EvolutionSuggestion]:
        """同步版 Agent 交互后置处理。"""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is not None:
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(
                    asyncio.run,
                    self.post_interaction(
                        agent_name, scene, success, duration_ms, tokens,
                        tool_calls, tool_success, error, tool_name,
                        user_feedback, interaction_id,
                    ),
                )
                return future.result()
        else:
            return asyncio.run(
                self.post_interaction(
                    agent_name, scene, success, duration_ms, tokens,
                    tool_calls, tool_success, error, tool_name,
                    user_feedback, interaction_id,
                ),
            )

    def reset(self) -> None:
        """重置所有 P3 组件。"""
        self._metrics_dashboard.reset()
        self._feedback_loop.reset()
        self._last_audit = None
        self._last_audit_time = 0.0
        self._interaction_count = 0
        self._active_interactions.clear()
