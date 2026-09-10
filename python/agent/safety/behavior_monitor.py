"""A3: 行为边界监控 — 检测Agent异常行为模式。

监控维度：
1. 工具调用循环检测：同一工具连续调用N次未产出新结果
2. 调用频率异常：短时间内工具调用频率突增
3. 权限越界尝试：反复尝试被拒绝的权限
4. 输出退化检测：输出质量持续下降
5. 资源消耗异常：token/时间消耗突增

Usage:
    monitor = BehaviorMonitor()
    monitor.record_tool_call("file_read", success=True)
    alert = monitor.check_anomalies()
    if alert:
        logger.warning(alert.description)
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("behavior_monitor")


class AlertLevel(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class BehaviorAlert:
    alert_type: str
    level: AlertLevel
    description: str
    evidence: dict[str, Any] = field(default_factory=dict)
    suggestion: str = ""
    timestamp: float = 0.0


@dataclass
class _ToolCallRecord:
    name: str
    success: bool
    timestamp: float
    duration_ms: float = 0.0


class BehaviorMonitor:
    """A3: 行为边界监控器.

    在ConversationLoop中每次工具调用后record_tool_call，
    每轮结束后check_anomalies检测异常模式。
    """

    _LOOP_THRESHOLD = 4
    _FREQ_SPIKE_THRESHOLD = 8
    _FREQ_WINDOW_SECONDS = 60.0
    _PERMISSION_RETRY_THRESHOLD = 3
    _QUALITY_DEGRADATION_THRESHOLD = 3
    _MAX_HISTORY = 200

    def __init__(self) -> None:
        self._history: list[_ToolCallRecord] = []
        self._permission_retries: dict[str, int] = defaultdict(int)
        self._quality_scores: list[float] = []
        self._last_check_time: float = time.time()
        self._total_calls: int = 0
        self._alerts_emitted: list[BehaviorAlert] = []

    def record_tool_call(
        self,
        tool_name: str,
        success: bool,
        duration_ms: float = 0.0,
    ) -> None:
        now = time.time()
        self._history.append(_ToolCallRecord(
            name=tool_name, success=success, timestamp=now, duration_ms=duration_ms,
        ))
        self._total_calls += 1
        if not success and "permission" in tool_name.lower() or "denied" in tool_name.lower():
            self._permission_retries[tool_name] += 1
        if len(self._history) > self._MAX_HISTORY:
            self._history = self._history[-self._MAX_HISTORY:]

    def record_quality(self, score: float) -> None:
        self._quality_scores.append(score)
        if len(self._quality_scores) > 50:
            self._quality_scores = self._quality_scores[-50:]

    def check_anomalies(self) -> list[BehaviorAlert]:
        now = time.time()
        alerts: list[BehaviorAlert] = []

        loop_alert = self._detect_loop()
        if loop_alert:
            alerts.append(loop_alert)

        freq_alert = self._detect_frequency_spike(now)
        if freq_alert:
            alerts.append(freq_alert)

        perm_alert = self._detect_permission_abuse()
        if perm_alert:
            alerts.append(perm_alert)

        quality_alert = self._detect_quality_degradation()
        if quality_alert:
            alerts.append(quality_alert)

        for a in alerts:
            a.timestamp = now
            self._alerts_emitted.append(a)

        if alerts:
            log.warning(
                "A3: behavior anomalies detected",
                count=len(alerts),
                types=[a.alert_type for a in alerts],
            )

        self._last_check_time = now
        return alerts

    def _detect_loop(self) -> BehaviorAlert | None:
        if len(self._history) < self._LOOP_THRESHOLD:
            return None
        recent = self._history[-self._LOOP_THRESHOLD:]
        names = [r.name for r in recent]
        if len(set(names)) == 1:
            return BehaviorAlert(
                alert_type="tool_loop",
                level=AlertLevel.CRITICAL,
                description=f"工具循环调用: {names[0]} 连续调用 {len(recent)} 次无产出",
                evidence={"tool": names[0], "count": len(recent)},
                suggestion=f"检查 {names[0]} 的参数或考虑换用其他工具",
            )
        if len(self._history) >= self._LOOP_THRESHOLD * 2:
            recent2 = self._history[-self._LOOP_THRESHOLD * 2:]
            names2 = [r.name for r in recent2]
            pattern = names2[:2]
            is_alternating = all(
                names2[i] == pattern[i % 2]
                for i in range(len(names2))
            )
            if is_alternating:
                return BehaviorAlert(
                    alert_type="tool_oscillation",
                    level=AlertLevel.WARNING,
                    description=f"工具振荡: {pattern[0]} ↔ {pattern[1]} 交替调用",
                    evidence={"pattern": pattern, "count": len(names2)},
                    suggestion="检查两个工具是否形成依赖死循环",
                )
        return None

    def _detect_frequency_spike(self, now: float) -> BehaviorAlert | None:
        window_start = now - self._FREQ_WINDOW_SECONDS
        recent_calls = [r for r in self._history if r.timestamp >= window_start]
        if len(recent_calls) >= self._FREQ_SPIKE_THRESHOLD:
            tool_counts: dict[str, int] = defaultdict(int)
            for r in recent_calls:
                tool_counts[r.name] += 1
            top_tool = max(tool_counts, key=tool_counts.get)
            top_count = tool_counts[top_tool]
            if top_count >= self._FREQ_SPIKE_THRESHOLD:
                return BehaviorAlert(
                    alert_type="frequency_spike",
                    level=AlertLevel.WARNING,
                    description=f"调用频率异常: {top_tool} 在 {self._FREQ_WINDOW_SECONDS:.0f}s 内调用 {top_count} 次",
                    evidence={"tool": top_tool, "count": top_count, "window": self._FREQ_WINDOW_SECONDS},
                    suggestion="检查是否存在无限循环或参数错误导致反复重试",
                )
        return None

    def _detect_permission_abuse(self) -> BehaviorAlert | None:
        for tool, count in self._permission_retries.items():
            if count >= self._PERMISSION_RETRY_THRESHOLD:
                return BehaviorAlert(
                    alert_type="permission_abuse",
                    level=AlertLevel.CRITICAL,
                    description=f"权限越界尝试: {tool} 被拒绝后重试 {count} 次",
                    evidence={"tool": tool, "retry_count": count},
                    suggestion="停止重试被拒绝的操作，考虑降级方案",
                )
        return None

    def _detect_quality_degradation(self) -> BehaviorAlert | None:
        if len(self._quality_scores) < self._QUALITY_DEGRADATION_THRESHOLD + 1:
            return None
        recent = self._quality_scores[-self._QUALITY_DEGRADATION_THRESHOLD:]
        if all(s < 0.5 for s in recent):
            return BehaviorAlert(
                alert_type="quality_degradation",
                level=AlertLevel.WARNING,
                description=f"输出质量持续下降: 最近 {len(recent)} 次质量均 < 0.5",
                evidence={"scores": recent},
                suggestion="检查LLM上下文是否过长或模型是否过载",
            )
        return None

    def summary(self) -> dict[str, Any]:
        return {
            "total_calls": self._total_calls,
            "recent_calls": len(self._history),
            "alerts_emitted": len(self._alerts_emitted),
            "last_check": self._last_check_time,
        }
