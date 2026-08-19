"""闭环度量（U1 × U3）单元测试。

验证 ClosedLoopMetricCollector 把「感知→行动→验证」每一轮的结果沉淀为
命中率指标，并作为适应度信号回喂 LearningSignalCollector / 进化引擎。
"""

import pytest

from agent.perception.closed_loop_metrics import (
    ClosedLoopAttempt,
    ClosedLoopMetricCollector,
    ClosedLoopMetrics,
)
from agent.evolution.learning_signals import LearningSignalCollector, SignalType


class TestClosedLoopMetricCollector:
    def test_empty_snapshot(self):
        c = ClosedLoopMetricCollector()
        m = c.snapshot()
        assert isinstance(m, ClosedLoopMetrics)
        assert m.total_attempts == 0
        assert m.successes == 0
        assert m.failures == 0
        assert m.hit_rate == 0.0
        assert m.trace_id  # 非空 trace_id 贯通审计

    def test_record_returns_attempt_with_trace(self):
        c = ClosedLoopMetricCollector(trace_id="trace-xyz")
        a = c.record_attempt(action="点击登录", verification_success=True)
        assert isinstance(a, ClosedLoopAttempt)
        assert a.action == "点击登录"
        assert a.verification_success is True
        assert a.trace_id == "trace-xyz"

    def test_hit_rate_and_aggregates(self):
        c = ClosedLoopMetricCollector()
        c.record_attempt(
            action="a1", verification_success=True,
            perception_confidence=0.9, verification_confidence=0.95, retries=0,
        )
        c.record_attempt(
            action="a2", verification_success=False,
            perception_confidence=0.5, verification_confidence=0.2, retries=2,
        )
        m = c.snapshot()
        assert m.total_attempts == 2
        assert m.successes == 1
        assert m.failures == 1
        assert m.hit_rate == 0.5
        assert m.avg_perception_confidence == pytest.approx(0.7)
        # 平均验证置信度仅统计成功轮
        assert m.avg_verification_confidence == pytest.approx(0.95)
        assert m.avg_retries == pytest.approx(1.0)
        assert m.window_start <= m.window_end

    def test_confidence_clamping(self):
        c = ClosedLoopMetricCollector()
        a = c.record_attempt(
            action="a", verification_success=True,
            perception_confidence=1.5, verification_confidence=-0.3,
        )
        assert a.perception_confidence == 1.0
        assert a.verification_confidence == 0.0

    def test_retries_clamped_non_negative(self):
        c = ClosedLoopMetricCollector()
        a = c.record_attempt(action="a", verification_success=False, retries=-5)
        assert a.retries == 0

    def test_to_evolution_signal(self):
        c = ClosedLoopMetricCollector()
        c.record_attempt(action="a1", verification_success=True)
        c.record_attempt(action="a2", verification_success=False)
        sig = c.to_evolution_signal()
        assert sig["signal_type"] == "perception_action_hit_rate"
        assert sig["hit_rate"] == 0.5
        assert sig["total_attempts"] == 2
        assert sig["successes"] == 1
        assert sig["failures"] == 1
        assert "trace_id" in sig
        assert "timestamp" in sig

    def test_emit_learning_signal_records_hit_rate(self):
        c = ClosedLoopMetricCollector()
        c.record_attempt(
            action="a1", verification_success=True, perception_confidence=0.9,
        )
        c.record_attempt(
            action="a2", verification_success=False, perception_confidence=0.4,
        )
        collector = LearningSignalCollector()
        sig_id = c.emit_learning_signal(collector)
        assert sig_id is not None

        signals = collector.get_signals(
            signal_type=SignalType.PERCEPTION_ACTION_HIT_RATE
        )
        assert len(signals) == 1
        assert signals[0].value == 0.5  # 命中率作为信号值
        assert "closed_loop" in signals[0].tags

    def test_emit_learning_signal_empty_returns_none(self):
        c = ClosedLoopMetricCollector()
        collector = LearningSignalCollector()
        assert c.emit_learning_signal(collector) is None

    def test_reset_clears_attempts(self):
        c = ClosedLoopMetricCollector()
        c.record_attempt(action="a", verification_success=True)
        c.reset()
        assert c.snapshot().total_attempts == 0
        # trace_id 保留
        assert c.trace_id

    def test_all_success_hit_rate_one(self):
        c = ClosedLoopMetricCollector()
        for i in range(5):
            c.record_attempt(action=f"a{i}", verification_success=True)
        assert c.snapshot().hit_rate == 1.0
