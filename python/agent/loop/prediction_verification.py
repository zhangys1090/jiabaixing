"""W3-3: 预测验证循环 — predictNextAction → 执行 → 验证 → 调整闭环。

核心流程：
1. 执行前：基于历史经验和当前上下文预测步骤的预期结果
2. 执行后：将实际结果与预测对比
3. 偏差过大时：触发调整（重规划/降级/跳过）

设计原则：
- 非侵入式：预测失败不阻断执行，静默降级
- 轻量级：预测使用规则+缓存，避免额外 LLM 调用
- 可观测：预测偏差记录供 LoopObserver 追踪

@module loop.prediction_verification
@version 1.0.0
@since 2026-08-13
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("prediction_verification")



class PredictionOutcome(str, Enum):
    MATCH = "match"
    PARTIAL = "partial"
    MISMATCH = "mismatch"
    NO_PREDICTION = "no_prediction"


class AdjustmentAction(str, Enum):
    CONTINUE = "continue"
    REPLAN = "replan"
    DOWNGRADE = "downgrade"
    SKIP = "skip"
    RETRY = "retry"


@dataclass
class StepPrediction:
    tool_name: str = ""
    expected_success: bool = True
    expected_duration_ms: float = 0.0
    expected_output_keywords: list[str] = field(default_factory=list)
    confidence: float = 0.0
    source: str = "rule"


@dataclass
class VerificationResult:
    outcome: PredictionOutcome = PredictionOutcome.NO_PREDICTION
    deviation_score: float = 0.0
    actual_success: bool = False
    actual_duration_ms: float = 0.0
    duration_deviation: float = 0.0
    missing_keywords: list[str] = field(default_factory=list)
    adjustment: AdjustmentAction = AdjustmentAction.CONTINUE
    adjustment_reason: str = ""


_TOOL_DURATION_BASELINES: dict[str, dict[str, float]] = {
    "file_read": {"avg_ms": 50, "p95_ms": 200},
    "file_write": {"avg_ms": 80, "p95_ms": 300},
    "file_search": {"avg_ms": 200, "p95_ms": 1000},
    "shell_exec": {"avg_ms": 500, "p95_ms": 3000},
    "web_search": {"avg_ms": 2000, "p95_ms": 8000},
    "web_fetch": {"avg_ms": 3000, "p95_ms": 10000},
    "code_analyze": {"avg_ms": 1000, "p95_ms": 5000},
    "code_generate": {"avg_ms": 3000, "p95_ms": 10000},
    "execute_code": {"avg_ms": 1000, "p95_ms": 5000},
    "memory_recall": {"avg_ms": 30, "p95_ms": 100},
    "desktop_screenshot": {"avg_ms": 500, "p95_ms": 2000},
}

_TOOL_SUCCESS_RATES: dict[str, float] = {
    "file_read": 0.95,
    "file_write": 0.9,
    "file_search": 0.85,
    "shell_exec": 0.7,
    "web_search": 0.8,
    "web_fetch": 0.75,
    "code_analyze": 0.85,
    "code_generate": 0.7,
    "execute_code": 0.65,
    "memory_recall": 0.95,
    "desktop_screenshot": 0.8,
}

_SUCCESS_OUTPUT_KEYWORDS: dict[str, list[str]] = {
    "file_read": ["content", "file", "read"],
    "file_write": ["wrote", "saved", "created", "written"],
    "file_search": ["found", "results", "matches"],
    "shell_exec": ["output", "exit", "result"],
    "web_search": ["results", "found", "search"],
    "web_fetch": ["content", "page", "fetched"],
    "code_analyze": ["analysis", "issues", "findings"],
    "code_generate": ["generated", "code", "created"],
    "execute_code": ["output", "result", "executed"],
}


class PredictionVerificationLoop:
    """预测验证循环 — 在步骤执行前后进行预测和验证。"""

    def __init__(self, trajectory_db: Any | None = None) -> None:
        self._trajectory_db = trajectory_db
        self._history: list[dict[str, Any]] = []
        self._tool_stats: dict[str, dict[str, float]] = {}
        self._mismatch_count = 0
        self._total_predictions = 0

    def predict_step(self, step: Any, context: Any = None) -> StepPrediction:
        self._total_predictions += 1
        tool_name = step.tool_name or ""
        prediction = StepPrediction(tool_name=tool_name)

        baseline = _TOOL_DURATION_BASELINES.get(tool_name, {"avg_ms": 1000, "p95_ms": 5000})
        prediction.expected_duration_ms = baseline["avg_ms"]

        prediction.expected_success = _TOOL_SUCCESS_RATES.get(tool_name, 0.8) > 0.5

        prediction.expected_output_keywords = _SUCCESS_OUTPUT_KEYWORDS.get(tool_name, [])

        if self._trajectory_db:
            try:
                historical = self._trajectory_db.estimate_tool_time(tool_name)
                if historical and historical.avg_duration_ms > 0:
                    prediction.expected_duration_ms = historical.avg_duration_ms
                    prediction.source = "historical"
            except Exception as _exc:
                log.warning("prediction_verification 异常被捕获", error=str(_exc))
                pass

        if tool_name in self._tool_stats:
            stats = self._tool_stats[tool_name]
            prediction.expected_duration_ms = stats.get("avg_duration_ms", prediction.expected_duration_ms)
            prediction.expected_success = stats.get("success_rate", 0.8) > 0.5
            prediction.source = "adaptive"

        prediction.confidence = 0.6 if prediction.source == "rule" else 0.8

        if step.retry_count > 0:
            prediction.expected_success = False
            prediction.confidence *= 0.7

        return prediction

    def verify_step(
        self,
        prediction: StepPrediction,
        result: Any,
    ) -> VerificationResult:
        vr = VerificationResult(
            actual_success=result.success,
            actual_duration_ms=result.duration_ms,
        )

        if prediction.confidence < 0.1:
            vr.outcome = PredictionOutcome.NO_PREDICTION
            vr.adjustment = AdjustmentAction.CONTINUE
            return vr

        success_match = prediction.expected_success == result.success
        duration_ratio = (
            result.duration_ms / prediction.expected_duration_ms
            if prediction.expected_duration_ms > 0 else 1.0
        )
        vr.duration_deviation = abs(duration_ratio - 1.0)

        keyword_match_count = 0
        if prediction.expected_output_keywords and result.content:
            content_lower = result.content.lower()
            for kw in prediction.expected_output_keywords:
                if kw in content_lower:
                    keyword_match_count += 1
            keyword_ratio = keyword_match_count / len(prediction.expected_output_keywords) if prediction.expected_output_keywords else 1.0
        else:
            keyword_ratio = 1.0

        if not success_match:
            vr.deviation_score = 1.0
            vr.outcome = PredictionOutcome.MISMATCH
        elif vr.duration_deviation > 2.0 or keyword_ratio < 0.3:
            vr.deviation_score = 0.6
            vr.outcome = PredictionOutcome.PARTIAL
        else:
            vr.deviation_score = 0.0
            vr.outcome = PredictionOutcome.MATCH

        if not result.success and prediction.expected_success:
            vr.missing_keywords = [
                kw for kw in prediction.expected_output_keywords
                if result.content and kw not in result.content.lower()
            ]

        vr.adjustment = self._determine_adjustment(vr, prediction)
        return vr

    def _determine_adjustment(
        self,
        vr: VerificationResult,
        prediction: StepPrediction,
    ) -> AdjustmentAction:
        if vr.outcome == PredictionOutcome.MATCH:
            return AdjustmentAction.CONTINUE

        if vr.outcome == PredictionOutcome.NO_PREDICTION:
            return AdjustmentAction.CONTINUE

        if vr.outcome == PredictionOutcome.MISMATCH:
            if not vr.actual_success and prediction.confidence > 0.7:
                return AdjustmentAction.RETRY
            if not vr.actual_success:
                return AdjustmentAction.DOWNGRADE
            return AdjustmentAction.CONTINUE

        if vr.outcome == PredictionOutcome.PARTIAL:
            if vr.duration_deviation > 3.0:
                return AdjustmentAction.REPLAN
            return AdjustmentAction.CONTINUE

        return AdjustmentAction.CONTINUE

    def record_observation(
        self,
        tool_name: str,
        success: bool,
        duration_ms: float,
    ) -> None:
        if tool_name not in self._tool_stats:
            self._tool_stats[tool_name] = {
                "total_calls": 0,
                "success_count": 0,
                "total_duration_ms": 0.0,
                "avg_duration_ms": 0.0,
                "success_rate": 0.0,
            }

        stats = self._tool_stats[tool_name]
        stats["total_calls"] += 1
        stats["success_count"] += int(success)
        stats["total_duration_ms"] += duration_ms
        stats["avg_duration_ms"] = stats["total_duration_ms"] / stats["total_calls"]
        stats["success_rate"] = stats["success_count"] / stats["total_calls"]

        self._history.append({
            "tool_name": tool_name,
            "success": success,
            "duration_ms": duration_ms,
            "timestamp": time.time(),
        })

        if len(self._history) > 1000:
            self._history = self._history[-500:]

    def get_statistics(self) -> dict[str, Any]:
        return {
            "total_predictions": self._total_predictions,
            "mismatch_count": self._mismatch_count,
            "mismatch_rate": (
                self._mismatch_count / self._total_predictions
                if self._total_predictions > 0 else 0.0
            ),
            "tracked_tools": len(self._tool_stats),
            "tool_stats": dict(self._tool_stats),
        }
