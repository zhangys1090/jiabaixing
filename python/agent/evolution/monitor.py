"""性能监控模块。

实时监控系统性能指标，检测性能退化和异常模式，
为自动进化触发提供数据支撑。

主要功能：
- 实时性能指标采集和统计
- 性能退化检测（连续失败、成功率下降、响应超时等）
- 滑动窗口统计
- 阈值告警机制

Usage:
    monitor = PerformanceMonitor()
    monitor.record_metric("task_success", success=True, duration=1.5)
    alerts = monitor.check_alerts()
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("evolution_monitor")


class AlertType(str, Enum):
    """告警类型。"""

    CONSECUTIVE_FAILURES = "consecutive_failures"
    SUCCESS_RATE_DROP = "success_rate_drop"
    RESPONSE_TIMEOUT = "response_timeout"
    ERROR_SPIKE = "error_spike"
    PERFORMANCE_DEGRADATION = "performance_degradation"


class AlertSeverity(str, Enum):
    """告警严重级别。"""

    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class PerformanceAlert:
    """性能告警。"""

    type: str
    severity: str
    message: str
    metric_name: str
    current_value: float
    threshold: float
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class MetricRecord:
    """指标记录。"""

    name: str
    value: float
    timestamp: float
    success: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PerformanceThresholds:
    """性能阈值配置。"""

    # 连续失败次数阈值
    consecutive_failures: int = 5
    # 成功率下降阈值（百分比）
    success_rate_drop_pct: float = 20.0
    # 响应超时阈值（秒）
    response_timeout_sec: float = 30.0
    # 错误率突增阈值
    error_spike_rate: float = 0.5
    # 性能退化阈值（响应时间增加百分比）
    perf_degradation_pct: float = 50.0
    # 统计窗口大小
    window_size: int = 100


class PerformanceMonitor:
    """性能监控器。

    实时监控系统性能指标，检测异常模式并触发告警。
    使用滑动窗口统计，支持多种阈值配置。
    """

    def __init__(
        self,
        thresholds: PerformanceThresholds | None = None,
        enabled: bool = True,
    ) -> None:
        """初始化性能监控器。

        Args:
            thresholds: 性能阈值配置。
            enabled: 是否启用监控。
        """
        self._enabled = enabled
        self._thresholds = thresholds or PerformanceThresholds()

        # 指标存储（滑动窗口）
        self._metrics: dict[str, deque[MetricRecord]] = {}
        self._window_size = self._thresholds.window_size

        # 连续失败计数
        self._consecutive_failures: dict[str, int] = {}
        self._consecutive_successes: dict[str, int] = {}

        # 告警历史
        self._alert_history: list[PerformanceAlert] = []
        self._max_alert_history = 100

        # 基线性能（用于检测退化）
        self._baseline_metrics: dict[str, float] = {}
        self._baseline_samples: dict[str, int] = {}
        self._baseline_min_samples = 20

        log.info(
            "PerformanceMonitor initialized",
            enabled=enabled,
            window_size=self._window_size,
        )

    def record_metric(
        self,
        name: str,
        value: float = 1.0,
        success: bool = True,
        duration: float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """记录性能指标。

        Args:
            name: 指标名称。
            value: 指标值。
            success: 是否成功。
            duration: 持续时间（秒）。
            metadata: 元数据。
        """
        if not self._enabled:
            return

        record = MetricRecord(
            name=name,
            value=value,
            timestamp=time.time(),
            success=success,
            metadata=metadata or {},
        )

        # 存储到滑动窗口
        if name not in self._metrics:
            self._metrics[name] = deque(maxlen=self._window_size)
        self._metrics[name].append(record)

        # 更新连续计数
        if success:
            self._consecutive_successes[name] = self._consecutive_successes.get(name, 0) + 1
            self._consecutive_failures[name] = 0
        else:
            self._consecutive_failures[name] = self._consecutive_failures.get(name, 0) + 1
            self._consecutive_successes[name] = 0

        # 更新基线（成功时更新）
        if success and duration is not None:
            self._update_baseline(name, duration)

        log.debug(
            "Metric recorded",
            name=name,
            success=success,
            value=value,
            duration=duration,
        )

    def check_alerts(self) -> list[PerformanceAlert]:
        """检查是否有告警。

        Returns:
            list[PerformanceAlert]: 告警列表。
        """
        if not self._enabled:
            return []

        alerts: list[PerformanceAlert] = []

        # 检查所有指标
        for metric_name in self._metrics:
            alerts.extend(self._check_metric_alerts(metric_name))

        # 去重（同一类型的告警在短时间内只触发一次）
        alerts = self._deduplicate_alerts(alerts)

        # 记录告警历史
        for alert in alerts:
            self._alert_history.append(alert)
            if len(self._alert_history) > self._max_alert_history:
                self._alert_history.pop(0)

            log.warning(
                "Performance alert triggered",
                type=alert.type,
                severity=alert.severity,
                metric=alert.metric_name,
                message=alert.message,
            )

        return alerts

    def _check_metric_alerts(self, metric_name: str) -> list[PerformanceAlert]:
        """检查单个指标的告警。

        Args:
            metric_name: 指标名称。

        Returns:
            list[PerformanceAlert]: 告警列表。
        """
        alerts: list[PerformanceAlert] = []
        records = self._metrics.get(metric_name, deque())

        if not records:
            return alerts

        # 1. 检查连续失败
        consecutive_failures = self._consecutive_failures.get(metric_name, 0)
        if consecutive_failures >= self._thresholds.consecutive_failures:
            alerts.append(PerformanceAlert(
                type=AlertType.CONSECUTIVE_FAILURES.value,
                severity=AlertSeverity.CRITICAL.value,
                message=f"连续失败 {consecutive_failures} 次，超过阈值 {self._thresholds.consecutive_failures}",
                metric_name=metric_name,
                current_value=float(consecutive_failures),
                threshold=float(self._thresholds.consecutive_failures),
                timestamp=time.time(),
                metadata={"consecutive_failures": consecutive_failures},
            ))

        # 2. 检查成功率下降
        if len(records) >= 10:
            # 计算最近一半和前一半的成功率
            mid = len(records) // 2
            recent = list(records)[mid:]
            earlier = list(records)[:mid]

            recent_success_rate = sum(1 for r in recent if r.success) / len(recent)
            earlier_success_rate = sum(1 for r in earlier if r.success) / len(earlier)

            drop_pct = (earlier_success_rate - recent_success_rate) * 100
            if drop_pct >= self._thresholds.success_rate_drop_pct:
                alerts.append(PerformanceAlert(
                    type=AlertType.SUCCESS_RATE_DROP.value,
                    severity=AlertSeverity.WARNING.value,
                    message=f"成功率下降 {drop_pct:.1f}%，超过阈值 {self._thresholds.success_rate_drop_pct}%",
                    metric_name=metric_name,
                    current_value=drop_pct,
                    threshold=self._thresholds.success_rate_drop_pct,
                    timestamp=time.time(),
                    metadata={
                        "recent_success_rate": recent_success_rate,
                        "earlier_success_rate": earlier_success_rate,
                    },
                ))

        # 3. 检查响应超时
        timeout_count = sum(
            1 for r in records
            if r.metadata.get("duration", 0) > self._thresholds.response_timeout_sec
        )
        if timeout_count > 0 and len(records) > 0:
            timeout_rate = timeout_count / len(records)
            if timeout_rate >= 0.1:  # 超过10%的请求超时
                alerts.append(PerformanceAlert(
                    type=AlertType.RESPONSE_TIMEOUT.value,
                    severity=AlertSeverity.WARNING.value,
                    message=f"响应超时率 {timeout_rate:.1%}，超过10%阈值",
                    metric_name=metric_name,
                    current_value=timeout_rate,
                    threshold=0.1,
                    timestamp=time.time(),
                    metadata={"timeout_count": timeout_count},
                ))

        # 4. 检查性能退化
        baseline = self._baseline_metrics.get(metric_name)
        if baseline and baseline > 0:
            recent_records = list(records)[-10:] if len(records) >= 10 else list(records)
            recent_avg = sum(
                r.metadata.get("duration", 0) for r in recent_records
            ) / len(recent_records) if recent_records else 0

            if recent_avg > 0:
                degradation_pct = ((recent_avg - baseline) / baseline) * 100
                if degradation_pct >= self._thresholds.perf_degradation_pct:
                    alerts.append(PerformanceAlert(
                        type=AlertType.PERFORMANCE_DEGRADATION.value,
                        severity=AlertSeverity.WARNING.value,
                        message=f"性能退化 {degradation_pct:.1f}%，超过阈值 {self._thresholds.perf_degradation_pct}%",
                        metric_name=metric_name,
                        current_value=degradation_pct,
                        threshold=self._thresholds.perf_degradation_pct,
                        timestamp=time.time(),
                        metadata={
                            "baseline": baseline,
                            "recent_avg": recent_avg,
                        },
                    ))

        return alerts

    def _update_baseline(self, metric_name: str, duration: float) -> None:
        """更新基线性能。

        Args:
            metric_name: 指标名称。
            duration: 持续时间。
        """
        if metric_name not in self._baseline_metrics:
            self._baseline_metrics[metric_name] = duration
            self._baseline_samples[metric_name] = 1
            return

        samples = self._baseline_samples[metric_name]
        if samples < self._baseline_min_samples:
            # 累积计算平均值
            old_avg = self._baseline_metrics[metric_name]
            new_avg = (old_avg * samples + duration) / (samples + 1)
            self._baseline_metrics[metric_name] = new_avg
            self._baseline_samples[metric_name] = samples + 1
        else:
            # 使用指数移动平均
            alpha = 0.1
            old_avg = self._baseline_metrics[metric_name]
            self._baseline_metrics[metric_name] = alpha * duration + (1 - alpha) * old_avg

    def _deduplicate_alerts(self, alerts: list[PerformanceAlert]) -> list[PerformanceAlert]:
        """告警去重。

        同一类型的告警在5分钟内只触发一次。

        Args:
            alerts: 告警列表。

        Returns:
            list[PerformanceAlert]: 去重后的告警列表。
        """
        now = time.time()
        deduped: list[PerformanceAlert] = []
        seen: set[tuple[str, str]] = set()

        # 检查历史告警
        recent_alerts = [
            a for a in self._alert_history
            if now - a.timestamp < 300  # 5分钟内
        ]
        for alert in recent_alerts:
            seen.add((alert.type, alert.metric_name))

        # 过滤重复告警
        for alert in alerts:
            key = (alert.type, alert.metric_name)
            if key not in seen:
                deduped.append(alert)
                seen.add(key)

        return deduped

    def get_metric_stats(self, metric_name: str) -> dict[str, Any]:
        """获取指标统计信息。

        Args:
            metric_name: 指标名称。

        Returns:
            dict: 统计信息。
        """
        records = self._metrics.get(metric_name, deque())
        if not records:
            return {"count": 0}

        success_count = sum(1 for r in records if r.success)
        total_count = len(records)
        success_rate = success_count / total_count if total_count > 0 else 0.0

        durations = [r.metadata.get("duration", 0) for r in records if r.metadata.get("duration")]
        avg_duration = sum(durations) / len(durations) if durations else 0.0

        return {
            "count": total_count,
            "success_count": success_count,
            "success_rate": success_rate,
            "avg_duration": avg_duration,
            "consecutive_failures": self._consecutive_failures.get(metric_name, 0),
            "consecutive_successes": self._consecutive_successes.get(metric_name, 0),
            "baseline": self._baseline_metrics.get(metric_name, 0.0),
        }

    def get_alert_history(self, limit: int = 20) -> list[PerformanceAlert]:
        """获取告警历史。

        Args:
            limit: 返回数量限制。

        Returns:
            list[PerformanceAlert]: 告警历史列表。
        """
        return self._alert_history[-limit:]

    def reset(self) -> None:
        """重置监控器。"""
        self._metrics.clear()
        self._consecutive_failures.clear()
        self._consecutive_successes.clear()
        self._alert_history.clear()
        self._baseline_metrics.clear()
        self._baseline_samples.clear()
        log.info("PerformanceMonitor reset")

    @property
    def enabled(self) -> bool:
        """是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态。"""
        self._enabled = value
        log.info("PerformanceMonitor enabled state changed", enabled=value)
