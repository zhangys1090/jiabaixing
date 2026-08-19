"""W3-3: 预测验证循环单元测试。"""

import pytest

from agent.loop.prediction_verification import (
    AdjustmentAction,
    PredictionOutcome,
    PredictionVerificationLoop,
    StepPrediction,
    VerificationResult,
)
from agent.loop.types import PlanStep, StepState


class TestStepPrediction:
    def test_default_prediction(self):
        p = StepPrediction()
        assert p.tool_name == ""
        assert p.expected_success is True
        assert p.confidence == 0.0
        assert p.source == "rule"

    def test_custom_prediction(self):
        p = StepPrediction(
            tool_name="file_read",
            expected_success=True,
            expected_duration_ms=50.0,
            confidence=0.8,
            source="historical",
        )
        assert p.tool_name == "file_read"
        assert p.expected_duration_ms == 50.0
        assert p.source == "historical"


class TestPredictionVerificationLoop:
    def test_predict_known_tool(self):
        loop = PredictionVerificationLoop()
        step = PlanStep(step_id="s1", tool_name="file_read", description="read file")
        pred = loop.predict_step(step)
        assert pred.tool_name == "file_read"
        assert pred.expected_success is True
        assert pred.expected_duration_ms > 0
        assert len(pred.expected_output_keywords) > 0
        assert pred.confidence > 0

    def test_predict_unknown_tool(self):
        loop = PredictionVerificationLoop()
        step = PlanStep(step_id="s1", tool_name="custom_tool", description="custom")
        pred = loop.predict_step(step)
        assert pred.tool_name == "custom_tool"
        assert pred.expected_duration_ms > 0
        assert pred.source == "rule"

    def test_predict_retry_step_lowers_confidence(self):
        loop = PredictionVerificationLoop()
        step = PlanStep(step_id="s1", tool_name="file_read", description="read")
        step.retry_count = 2
        pred = loop.predict_step(step)
        assert pred.expected_success is False
        assert pred.confidence < 0.6

    def test_verify_match(self):
        loop = PredictionVerificationLoop()
        pred = StepPrediction(
            tool_name="file_read",
            expected_success=True,
            expected_duration_ms=50.0,
            expected_output_keywords=["content", "file"],
            confidence=0.8,
        )

        class FakeResult:
            success = True
            duration_ms = 55.0
            content = "File content read successfully"

        vr = loop.verify_step(pred, FakeResult())
        assert vr.outcome == PredictionOutcome.MATCH
        assert vr.deviation_score == 0.0
        assert vr.adjustment == AdjustmentAction.CONTINUE

    def test_verify_mismatch_success_vs_failure(self):
        loop = PredictionVerificationLoop()
        pred = StepPrediction(
            tool_name="file_read",
            expected_success=True,
            expected_duration_ms=50.0,
            expected_output_keywords=["content"],
            confidence=0.8,
        )

        class FakeResult:
            success = False
            duration_ms = 100.0
            content = "Error: file not found"

        vr = loop.verify_step(pred, FakeResult())
        assert vr.outcome == PredictionOutcome.MISMATCH
        assert vr.deviation_score == 1.0
        assert vr.adjustment == AdjustmentAction.RETRY

    def test_verify_mismatch_low_confidence(self):
        loop = PredictionVerificationLoop()
        pred = StepPrediction(
            tool_name="file_read",
            expected_success=True,
            expected_duration_ms=50.0,
            confidence=0.3,
        )

        class FakeResult:
            success = False
            duration_ms = 100.0
            content = "Error"

        vr = loop.verify_step(pred, FakeResult())
        assert vr.outcome == PredictionOutcome.MISMATCH
        assert vr.adjustment == AdjustmentAction.DOWNGRADE

    def test_verify_partial_duration_deviation(self):
        loop = PredictionVerificationLoop()
        pred = StepPrediction(
            tool_name="file_read",
            expected_success=True,
            expected_duration_ms=50.0,
            expected_output_keywords=["content"],
            confidence=0.8,
        )

        class FakeResult:
            success = True
            duration_ms = 500.0
            content = "content loaded"

        vr = loop.verify_step(pred, FakeResult())
        assert vr.outcome == PredictionOutcome.PARTIAL
        assert vr.duration_deviation > 2.0
        assert vr.adjustment == AdjustmentAction.REPLAN

    def test_verify_no_prediction(self):
        loop = PredictionVerificationLoop()
        pred = StepPrediction(confidence=0.05)

        class FakeResult:
            success = True
            duration_ms = 50.0
            content = "ok"

        vr = loop.verify_step(pred, FakeResult())
        assert vr.outcome == PredictionOutcome.NO_PREDICTION
        assert vr.adjustment == AdjustmentAction.CONTINUE

    def test_record_observation_updates_stats(self):
        loop = PredictionVerificationLoop()
        loop.record_observation("file_read", True, 50.0)
        loop.record_observation("file_read", True, 60.0)
        loop.record_observation("file_read", False, 200.0)

        stats = loop.get_statistics()
        assert stats["tracked_tools"] == 1
        tool_stats = stats["tool_stats"]["file_read"]
        assert tool_stats["total_calls"] == 3
        assert tool_stats["success_count"] == 2
        assert abs(tool_stats["avg_duration_ms"] - 103.33) < 1.0
        assert abs(tool_stats["success_rate"] - 0.667) < 0.01

    def test_adaptive_prediction_after_observations(self):
        loop = PredictionVerificationLoop()
        for _ in range(5):
            loop.record_observation("file_read", True, 80.0)

        step = PlanStep(step_id="s1", tool_name="file_read", description="read")
        pred = loop.predict_step(step)
        assert pred.source == "adaptive"
        assert abs(pred.expected_duration_ms - 80.0) < 0.1

    def test_missing_keywords_detected(self):
        loop = PredictionVerificationLoop()
        pred = StepPrediction(
            tool_name="file_write",
            expected_success=True,
            expected_duration_ms=80.0,
            expected_output_keywords=["wrote", "saved", "created"],
            confidence=0.8,
        )

        class FakeResult:
            success = False
            duration_ms = 100.0
            content = "permission denied"

        vr = loop.verify_step(pred, FakeResult())
        assert len(vr.missing_keywords) == 3

    def test_history_truncation(self):
        loop = PredictionVerificationLoop()
        for i in range(1500):
            loop.record_observation("tool_a", True, float(i))
        assert len(loop._history) <= 1000

    def test_statistics_empty(self):
        loop = PredictionVerificationLoop()
        stats = loop.get_statistics()
        assert stats["total_predictions"] == 0
        assert stats["mismatch_count"] == 0
        assert stats["tracked_tools"] == 0


class TestVerificationResult:
    def test_default_result(self):
        vr = VerificationResult()
        assert vr.outcome == PredictionOutcome.NO_PREDICTION
        assert vr.deviation_score == 0.0
        assert vr.adjustment == AdjustmentAction.CONTINUE

    def test_metadata_in_result(self):
        loop = PredictionVerificationLoop()
        step = PlanStep(step_id="s1", tool_name="file_read", description="read")
        pred = loop.predict_step(step)

        class FakeResult:
            success = True
            duration_ms = 55.0
            content = "File content read"

        vr = loop.verify_step(pred, FakeResult())
        assert vr.actual_success is True
        assert vr.actual_duration_ms == 55.0
