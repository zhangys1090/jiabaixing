from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.evaluation.ab_comparator import ABComparator, ABComparisonReport, EvalReport


@dataclass
class EvalGateConfig:
    min_pass_rate: float = 0.8
    min_average_score: float = 0.7
    max_regressions: int = 0
    block_on_regression: bool = True
    trend_window: int = 5


@dataclass
class EvalGateResult:
    passed: bool
    reason: str = ""
    details: dict[str, Any] = field(default_factory=dict)


class EvalGate:
    def __init__(self, config: EvalGateConfig | None = None) -> None:
        self.config = config or EvalGateConfig()
        self._history: list[float] = []

    def check(self, report: EvalReport) -> EvalGateResult:
        reasons: list[str] = []
        details: dict[str, Any] = {
            "pass_rate": report.summary.pass_rate,
            "average_score": report.summary.average_score,
            "total": report.summary.total,
            "passed": report.summary.passed,
        }

        if report.summary.pass_rate < self.config.min_pass_rate:
            reasons.append(
                f"通过率 {report.summary.pass_rate:.1%} 低于阈值 {self.config.min_pass_rate:.1%}"
            )

        if report.summary.average_score < self.config.min_average_score:
            reasons.append(
                f"平均分 {report.summary.average_score:.2f} 低于阈值 {self.config.min_average_score:.2f}"
            )

        self._history.append(report.summary.pass_rate)
        if len(self._history) >= 3:
            trend = self._analyze_trend()
            details["trend"] = trend
            if trend == "declining":
                reasons.append("通过率呈下降趋势")

        passed = len(reasons) == 0
        return EvalGate(
            passed=passed,
            reason="; ".join(reasons) if reasons else "门控通过",
            details=details,
        )

    def check_ab(self, ab_report: ABComparisonReport) -> EvalGateResult:
        reasons: list[str] = []
        details: dict[str, Any] = {
            "verdict": ab_report.verdict,
            "delta_pass_rate": ab_report.delta_pass_rate,
            "regressions": len(ab_report.regressions),
            "improvements": len(ab_report.improvements),
        }

        if self.config.block_on_regression and ab_report.regressions:
            if len(ab_report.regressions) > self.config.max_regressions:
                reasons.append(
                    f"存在 {len(ab_report.regressions)} 个回归用例，超过上限 {self.config.max_regressions}"
                )

        if ab_report.verdict == "regression":
            reasons.append("A/B 对比裁决为回归")

        if ab_report.candidate.summary.pass_rate < self.config.min_pass_rate:
            reasons.append(
                f"候选通过率 {ab_report.candidate.summary.pass_rate:.1%} 低于阈值"
            )

        passed = len(reasons) == 0
        return EvalGateResult(
            passed=passed,
            reason="; ".join(reasons) if reasons else "A/B 门控通过",
            details=details,
        )

    def _analyze_trend(self) -> str:
        if len(self._history) < 3:
            return "insufficient_data"
        recent = self._history[-3:]
        older = self._history[-6:-3] if len(self._history) >= 6 else self._history[:-3]
        if not older:
            return "stable"
        avg_recent = sum(recent) / len(recent)
        avg_older = sum(older) / len(older)
        if avg_recent > avg_older + 0.05:
            return "improving"
        elif avg_recent < avg_older - 0.05:
            return "declining"
        return "stable"

    def get_history(self) -> list[float]:
        return list(self._history)

    def reset(self) -> None:
        self._history.clear()
