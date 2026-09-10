"""自动进化触发模块。

基于性能监控数据自动触发进化，实现系统的自我优化。

主要功能：
- 监听性能告警，自动触发进化
- 进化策略选择（根据告警类型选择合适的进化方式）
- 进化频率控制（避免过度进化）
- 进化结果评估和回滚

Usage:
    trigger = EvolutionTrigger(evolution_engine, monitor)
    trigger.start()  # 启动自动进化监听
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.evolution.monitor import PerformanceMonitor, PerformanceAlert, AlertType, AlertSeverity
from agent.evolution.v2_engine import (
    EvolutionEngineV2,
    V2EvolutionCause,
    V2CauseType,
    V2EvolutionType,
    V2EvolutionPriority,
)

log = StructuredLogger("evolution_trigger")


class TriggerStrategy(str, Enum):
    """触发策略。"""

    CONSERVATIVE = "conservative"  # 保守：只在严重问题时触发
    MODERATE = "moderate"  # 适度：在警告和严重问题时触发
    AGGRESSIVE = "aggressive"  # 激进：任何问题都触发


@dataclass
class EvolutionTriggerConfig:
    """进化触发配置。"""

    # 触发策略
    strategy: str = TriggerStrategy.MODERATE.value
    # 最小进化间隔（秒）
    min_evolution_interval: int = 300  # 5分钟
    # 每日最大进化次数
    max_daily_evolutions: int = 10
    # 是否自动回滚失败的进化
    auto_rollback: bool = True
    # 进化成功率阈值（低于此值暂停自动进化）
    min_success_rate: float = 0.6
    # 评估窗口大小
    evaluation_window: int = 10


@dataclass
class TriggerRecord:
    """触发记录。"""

    trigger_time: float
    alert_type: str
    evolution_plan_id: str
    success: bool
    duration: float
    rollback_needed: bool = False


class EvolutionTrigger:
    """自动进化触发器。

    监听性能监控器的告警，自动触发进化。
    支持多种触发策略和频率控制。
    """

    def __init__(
        self,
        evolution_engine: EvolutionEngineV2,
        monitor: PerformanceMonitor,
        config: EvolutionTriggerConfig | None = None,
        enabled: bool = True,
    ) -> None:
        """初始化进化触发器。

        Args:
            evolution_engine: 进化引擎。
            monitor: 性能监控器。
            config: 触发配置。
            enabled: 是否启用。
        """
        self._engine = evolution_engine
        self._monitor = monitor
        self._config = config or EvolutionTriggerConfig()
        self._enabled = enabled

        # 触发历史
        self._trigger_history: list[TriggerRecord] = []
        self._max_history = 100

        # 状态
        self._last_evolution_time: float = 0.0
        self._daily_evolution_count: int = 0
        self._last_day_reset: float = 0.0

        # 异步任务
        self._monitor_task: asyncio.Task | None = None
        self._is_running: bool = False

        log.info(
            "EvolutionTrigger initialized",
            enabled=enabled,
            strategy=self._config.strategy,
            min_interval=self._config.min_evolution_interval,
        )

    def start(self) -> None:
        """启动自动进化监听。"""
        if self._is_running:
            log.warning("EvolutionTrigger already running")
            return

        self._is_running = True
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        log.debug("EvolutionTrigger started")

    def stop(self) -> None:
        """停止自动进化监听。"""
        self._is_running = False
        if self._monitor_task:
            self._monitor_task.cancel()
            self._monitor_task = None
        log.info("EvolutionTrigger stopped")

    async def _monitor_loop(self) -> None:
        """监控循环。

        定期检查性能告警并触发进化。
        """
        while self._is_running:
            try:
                if self._enabled:
                    await self._check_and_trigger()
            except Exception as e:
                log.error("Monitor loop error", error=str(e))

            # 每30秒检查一次
            await asyncio.sleep(30)

    async def _check_and_trigger(self) -> None:
        """检查告警并触发进化。"""
        # 检查是否可以触发
        if not self._can_trigger():
            return

        # 获取告警
        alerts = self._monitor.check_alerts()
        if not alerts:
            return

        # 根据策略过滤告警
        filtered_alerts = self._filter_alerts_by_strategy(alerts)
        if not filtered_alerts:
            return

        # 选择最严重的告警触发进化
        top_alert = self._select_top_alert(filtered_alerts)
        if top_alert:
            await self._trigger_evolution(top_alert)

    def _can_trigger(self) -> bool:
        """检查是否可以触发进化。

        Returns:
            bool: 是否可以触发。
        """
        # 检查是否启用
        if not self._enabled:
            return False

        # 检查最小间隔
        now = time.time()
        if now - self._last_evolution_time < self._config.min_evolution_interval:
            return False

        # 检查每日次数限制
        self._reset_daily_count_if_needed()
        if self._daily_evolution_count >= self._config.max_daily_evolutions:
            return False

        # 检查进化成功率
        if not self._check_success_rate():
            return False

        return True

    def _reset_daily_count_if_needed(self) -> None:
        """如果是新的一天，重置每日计数。"""
        now = time.time()
        # 简单的日重置（按24小时计算）
        if now - self._last_day_reset >= 86400:  # 24小时
            self._daily_evolution_count = 0
            self._last_day_reset = now

    def _check_success_rate(self) -> bool:
        """检查进化成功率是否达标。

        Returns:
            bool: 是否达标。
        """
        if len(self._trigger_history) < self._config.evaluation_window:
            return True  # 历史数据不足时允许触发

        recent = self._trigger_history[-self._config.evaluation_window :]
        success_count = sum(1 for r in recent if r.success)
        success_rate = success_count / len(recent)

        return success_rate >= self._config.min_success_rate

    def _filter_alerts_by_strategy(self, alerts: list[PerformanceAlert]) -> list[PerformanceAlert]:
        """根据策略过滤告警。

        Args:
            alerts: 告警列表。

        Returns:
            list[PerformanceAlert]: 过滤后的告警列表。
        """
        strategy = self._config.strategy

        if strategy == TriggerStrategy.CONSERVATIVE.value:
            # 只保留严重告警
            return [a for a in alerts if a.severity == AlertSeverity.CRITICAL.value]
        elif strategy == TriggerStrategy.MODERATE.value:
            # 保留警告和严重告警
            return [
                a
                for a in alerts
                if a.severity in (AlertSeverity.WARNING.value, AlertSeverity.CRITICAL.value)
            ]
        else:  # AGGRESSIVE
            # 保留所有告警
            return alerts

    def _select_top_alert(self, alerts: list[PerformanceAlert]) -> PerformanceAlert | None:
        """选择最严重的告警。

        Args:
            alerts: 告警列表。

        Returns:
            PerformanceAlert | None: 最严重的告警。
        """
        if not alerts:
            return None

        # 按严重程度排序
        severity_order = {
            AlertSeverity.CRITICAL.value: 3,
            AlertSeverity.WARNING.value: 2,
            AlertSeverity.INFO.value: 1,
        }

        sorted_alerts = sorted(
            alerts,
            key=lambda a: (severity_order.get(a.severity, 0), a.current_value),
            reverse=True,
        )

        return sorted_alerts[0]

    async def _trigger_evolution(self, alert: PerformanceAlert) -> None:
        """触发进化。

        Args:
            alert: 触发进化的告警。
        """
        start_time = time.time()

        try:
            log.info(
                "Triggering evolution",
                alert_type=alert.type,
                severity=alert.severity,
                metric=alert.metric_name,
                message=alert.message,
            )

            # 创建进化原因
            cause = self._build_evolution_cause(alert)

            # 触发进化
            result = await self._engine.trigger_evolution(cause)

            if result:
                # 记录触发历史
                record = TriggerRecord(
                    trigger_time=start_time,
                    alert_type=alert.type,
                    evolution_plan_id=result.plan_id,
                    success=result.success and not result.rollback_needed,
                    duration=(time.time() - start_time) * 1000,
                    rollback_needed=result.rollback_needed,
                )
                self._trigger_history.append(record)
                if len(self._trigger_history) > self._max_history:
                    self._trigger_history.pop(0)

                # 更新状态
                self._last_evolution_time = time.time()
                self._daily_evolution_count += 1

                log.info(
                    "Evolution completed",
                    plan_id=result.plan_id,
                    success=result.success,
                    duration_ms=record.duration,
                    rollback_needed=result.rollback_needed,
                )
            else:
                log.warning("Evolution returned None result")

        except Exception as e:
            log.error("Evolution trigger failed", error=str(e))

    def _build_evolution_cause(self, alert: PerformanceAlert) -> V2EvolutionCause:
        """根据告警构建进化原因。

        Args:
            alert: 性能告警。

        Returns:
            V2EvolutionCause: 进化原因。
        """
        # 根据告警类型确定进化类型和优先级
        evolution_type, priority = self._map_alert_to_evolution(alert)

        return V2EvolutionCause(
            type=evolution_type,
            description=f"自动进化触发: {alert.message}",
            context={
                "alert_type": alert.type,
                "alert_severity": alert.severity,
                "metric_name": alert.metric_name,
                "current_value": alert.current_value,
                "threshold": alert.threshold,
                "metadata": alert.metadata,
                "trigger_source": "auto_monitor",
            },
            timestamp=time.time(),
        )

    def _map_alert_to_evolution(self, alert: PerformanceAlert) -> tuple[str, str]:
        """将告警映射到进化类型和优先级。

        Args:
            alert: 性能告警。

        Returns:
            tuple[str, str]: (进化类型, 优先级)
        """
        # 默认值
        evolution_type = V2CauseType.PERFORMANCE_ISSUE.value
        priority = V2EvolutionPriority.MEDIUM.value

        # 根据告警类型映射
        if alert.type == AlertType.CONSECUTIVE_FAILURES.value:
            evolution_type = V2CauseType.FAILURE.value
            priority = V2EvolutionPriority.CRITICAL.value
        elif alert.type == AlertType.SUCCESS_RATE_DROP.value:
            evolution_type = V2CauseType.LOW_SATISFACTION.value
            priority = V2EvolutionPriority.HIGH.value
        elif alert.type == AlertType.RESPONSE_TIMEOUT.value:
            evolution_type = V2CauseType.PERFORMANCE_ISSUE.value
            priority = V2EvolutionPriority.HIGH.value
        elif alert.type == AlertType.ERROR_SPIKE.value:
            evolution_type = V2CauseType.FAILURE.value
            priority = V2EvolutionPriority.HIGH.value
        elif alert.type == AlertType.PERFORMANCE_DEGRADATION.value:
            evolution_type = V2CauseType.PERFORMANCE_ISSUE.value
            priority = V2EvolutionPriority.MEDIUM.value

        # 根据严重程度调整优先级
        if alert.severity == AlertSeverity.CRITICAL.value:
            priority = V2EvolutionPriority.CRITICAL.value
        elif alert.severity == AlertSeverity.INFO.value:
            priority = V2EvolutionPriority.LOW.value

        return evolution_type, priority

    def get_trigger_stats(self) -> dict[str, Any]:
        """获取触发统计信息。

        Returns:
            dict: 统计信息。
        """
        total = len(self._trigger_history)
        success_count = sum(1 for r in self._trigger_history if r.success)
        success_rate = success_count / total if total > 0 else 0.0

        rollback_count = sum(1 for r in self._trigger_history if r.rollback_needed)

        return {
            "total_triggers": total,
            "success_count": success_count,
            "success_rate": success_rate,
            "rollback_count": rollback_count,
            "daily_count": self._daily_evolution_count,
            "last_evolution_time": self._last_evolution_time,
            "enabled": self._enabled,
            "strategy": self._config.strategy,
        }

    def get_trigger_history(self, limit: int = 20) -> list[TriggerRecord]:
        """获取触发历史。

        Args:
            limit: 返回数量限制。

        Returns:
            list[TriggerRecord]: 触发历史列表。
        """
        return self._trigger_history[-limit:]

    def set_strategy(self, strategy: str) -> None:
        """设置触发策略。

        Args:
            strategy: 策略名称。
        """
        valid_strategies = {s.value for s in TriggerStrategy}
        if strategy not in valid_strategies:
            raise ValueError(f"Invalid strategy: {strategy}")

        self._config.strategy = strategy
        log.info("Trigger strategy updated", strategy=strategy)

    def reset(self) -> None:
        """重置触发器。"""
        self._trigger_history.clear()
        self._last_evolution_time = 0.0
        self._daily_evolution_count = 0
        self._last_day_reset = 0.0
        log.info("EvolutionTrigger reset")

    @property
    def enabled(self) -> bool:
        """是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态。"""
        self._enabled = value
        log.info("EvolutionTrigger enabled state changed", enabled=value)

    @property
    def is_running(self) -> bool:
        """是否正在运行。"""
        return self._is_running
