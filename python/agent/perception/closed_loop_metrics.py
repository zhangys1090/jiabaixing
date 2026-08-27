"""闭环度量（U1 × U3）—— 感知→行动→验证 命中率采集与进化反馈。

家百星的"手脚五感"是闭环：感知世界 → 决策 → 施加动作 → 验证结果 → 再感知。
本模块把每一轮闭环的「验证是否成功」沉淀为可度量的命中率指标，并作为适应度信号
回喂 ``EvolutionEngine`` / ``LearningSignalCollector``，使"更会感知-行动"的 Agent
策略被进化引擎优选——闭合 U1（感知-行动闭环）与 U3（进化引擎）的反馈回路。

设计要点：
- 纯数据 + 无副作用，便于单测；不依赖具体感知实现。
- 与 ``PerceptionActionLoop`` 解耦：由 loop 在每轮验证后调用 ``record_attempt``。
- ``to_evolution_signal`` 产出进化引擎可消费的扁平字典；``emit_learning_signal``
  复用 ``LearningSignalCollector.record_signal`` 的既有契约。

详见 docs/jiabaixing-unique-capability-enhancement.md §二 2.2 / §四。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from agent.core.tracing import new_trace_id

if TYPE_CHECKING:
    from agent.evolution.learning_signals import LearningSignalCollector


@dataclass
class ClosedLoopAttempt:
    """单次感知→行动→验证闭环记录。

    Attributes:
        action: 执行的操作描述。
        verification_success: 验证是否成功。
        perception_confidence: 感知（定位/融合）置信度 (0-1)。
        verification_confidence: 验证置信度 (0-1)。
        retries: 本轮重试次数。
        duration_ms: 本轮总耗时（毫秒）。
        trace_id: 链路追踪标识，贯通审计。
        timestamp: 记录时间戳。
    """

    action: str = ""
    verification_success: bool = False
    perception_confidence: float = 0.0
    verification_confidence: float = 0.0
    retries: int = 0
    duration_ms: float = 0.0
    trace_id: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class ClosedLoopMetrics:
    """闭环度量快照（聚合视图）。

    Attributes:
        total_attempts: 总尝试轮数。
        successes: 验证成功轮数。
        failures: 验证失败轮数。
        hit_rate: 命中率 (successes / total_attempts)，无数据时为 0.0。
        avg_perception_confidence: 平均感知置信度。
        avg_verification_confidence: 平均验证置信度（仅成功轮）。
        avg_retries: 平均重试次数。
        window_start: 统计窗口起始时间戳。
        window_end: 统计窗口结束时间戳。
        trace_id: 链路追踪标识。
    """

    total_attempts: int = 0
    successes: int = 0
    failures: int = 0
    hit_rate: float = 0.0
    avg_perception_confidence: float = 0.0
    avg_verification_confidence: float = 0.0
    avg_retries: float = 0.0
    window_start: float = 0.0
    window_end: float = 0.0
    trace_id: str = ""


class ClosedLoopMetricCollector:
    """感知→行动→验证 闭环度量收集器。

    由 ``PerceptionActionLoop`` 在每轮验证结束后调用 ``record_attempt``，累积度量；
    通过 ``snapshot`` 取聚合视图，``to_evolution_signal`` 产出进化反馈信号。

    Usage:
        collector = ClosedLoopMetricCollector()
        collector.record_attempt(action="点击登录", verification_success=True, ...)
        metrics = collector.snapshot()
        collector.emit_learning_signal(signal_collector)
    """

    def __init__(self, trace_id: str | None = None) -> None:
        self._trace_id = trace_id or new_trace_id()
        self._attempts: list[ClosedLoopAttempt] = []
        self._MAX_ATTEMPTS = 1000

    @property
    def trace_id(self) -> str:
        return self._trace_id

    @property
    def attempts(self) -> list[ClosedLoopAttempt]:
        return list(self._attempts)

    def record_attempt(
        self,
        *,
        action: str,
        verification_success: bool,
        perception_confidence: float = 0.0,
        verification_confidence: float = 0.0,
        retries: int = 0,
        duration_ms: float = 0.0,
        trace_id: str | None = None,
    ) -> ClosedLoopAttempt:
        """记录一次闭环尝试。

        Args:
            action: 操作描述。
            verification_success: 验证是否成功。
            perception_confidence: 感知置信度 (0-1)，越界自动截断。
            verification_confidence: 验证置信度 (0-1)，越界自动截断。
            retries: 重试次数。
            duration_ms: 总耗时（毫秒）。
            trace_id: 链路追踪标识，缺省取收集器自身 trace_id。

        Returns:
            ClosedLoopAttempt: 已记录的尝试。
        """
        attempt = ClosedLoopAttempt(
            action=action,
            verification_success=bool(verification_success),
            perception_confidence=max(0.0, min(1.0, float(perception_confidence))),
            verification_confidence=max(0.0, min(1.0, float(verification_confidence))),
            retries=max(0, int(retries)),
            duration_ms=max(0.0, float(duration_ms)),
            trace_id=trace_id or self._trace_id,
        )
        self._attempts.append(attempt)
        if len(self._attempts) > self._MAX_ATTEMPTS:
            self._attempts = self._attempts[-self._MAX_ATTEMPTS * 3 // 4:]
        return attempt

    def snapshot(self) -> ClosedLoopMetrics:
        """产出当前累积度量的聚合快照。"""
        total = len(self._attempts)
        if total == 0:
            return ClosedLoopMetrics(trace_id=self._trace_id)
        successes = sum(1 for a in self._attempts if a.verification_success)
        failures = total - successes
        avg_perc = sum(a.perception_confidence for a in self._attempts) / total
        successful = [a for a in self._attempts if a.verification_success]
        avg_verify = (
            sum(a.verification_confidence for a in successful) / len(successful)
            if successful
            else 0.0
        )
        avg_retries = sum(a.retries for a in self._attempts) / total
        window_start = self._attempts[0].timestamp
        window_end = self._attempts[-1].timestamp
        return ClosedLoopMetrics(
            total_attempts=total,
            successes=successes,
            failures=failures,
            hit_rate=successes / total,
            avg_perception_confidence=avg_perc,
            avg_verification_confidence=avg_verify,
            avg_retries=avg_retries,
            window_start=window_start,
            window_end=window_end,
            trace_id=self._trace_id,
        )

    def reset(self) -> None:
        """清空累积记录（保留 trace_id）。"""
        self._attempts.clear()

    def to_evolution_signal(self) -> dict[str, Any]:
        """产出进化引擎可消费的扁平反馈信号。

        命中率越高、平均重试越少，表示感知-行动闭环越健壮，适应度越高。
        进化引擎可据此调整策略权重（连接 U3）。
        """
        metrics = self.snapshot()
        return {
            "signal_type": "perception_action_hit_rate",
            "trace_id": metrics.trace_id,
            "total_attempts": metrics.total_attempts,
            "successes": metrics.successes,
            "failures": metrics.failures,
            "hit_rate": round(metrics.hit_rate, 4),
            "avg_perception_confidence": round(metrics.avg_perception_confidence, 4),
            "avg_verification_confidence": round(metrics.avg_verification_confidence, 4),
            "avg_retries": round(metrics.avg_retries, 4),
            "timestamp": time.time(),
        }

    def emit_learning_signal(
        self,
        signal_collector: "LearningSignalCollector",
        *,
        source: str = "execution",
    ) -> str | None:
        """把当前命中率作为学习信号写入 ``LearningSignalCollector``。

        Args:
            signal_collector: 学习信号收集器实例。
            source: 信号来源标签。

        Returns:
            信号 ID（无数据时返回 None）。
        """
        from agent.evolution.learning_signals import SignalType

        metrics = self.snapshot()
        if metrics.total_attempts == 0:
            return None
        context = {
            "total_attempts": metrics.total_attempts,
            "successes": metrics.successes,
            "failures": metrics.failures,
            "avg_retries": round(metrics.avg_retries, 4),
            "window_start": metrics.window_start,
            "window_end": metrics.window_end,
        }
        return signal_collector.record_signal(
            signal_type=SignalType.PERCEPTION_ACTION_HIT_RATE,
            value=metrics.hit_rate,
            source=source,
            context=context,
            confidence=metrics.avg_perception_confidence,
            tags=["closed_loop", "u1_u3"],
        )
