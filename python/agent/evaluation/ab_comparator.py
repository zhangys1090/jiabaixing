from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class EvalCaseResult:
    case_id: str
    passed: bool
    score: float = 0.0
    details: str = ""


@dataclass
class EvalSummary:
    total: int = 0
    passed: int = 0
    failed: int = 0
    pass_rate: float = 0.0
    average_score: float = 0.0


@dataclass
class EvalReport:
    name: str
    summary: EvalSummary
    results: list[EvalCaseResult] = field(default_factory=list)


@dataclass
class CaseComparison:
    case_id: str
    baseline_passed: bool
    candidate_passed: bool
    baseline_score: float
    candidate_score: float
    score_delta: float = 0.0


@dataclass
class ABComparisonReport:
    baseline: EvalReport
    candidate: EvalReport
    delta_pass_rate: float = 0.0
    delta_average_score: float = 0.0
    regressions: list[CaseComparison] = field(default_factory=list)
    improvements: list[CaseComparison] = field(default_factory=list)
    case_comparisons: list[CaseComparison] = field(default_factory=list)
    verdict: str = "neutral"


class ABComparator:
    def compare(self, baseline: EvalReport, candidate: EvalReport) -> ABComparisonReport:
        baseline_map = {r.case_id: r for r in baseline.results}
        candidate_map = {r.case_id: r for r in candidate.results}

        all_case_ids = set(baseline_map.keys()) | set(candidate_map.keys())

        case_comparisons: list[CaseComparison] = []
        regressions: list[CaseComparison] = []
        improvements: list[CaseComparison] = []

        for case_id in all_case_ids:
            base = baseline_map.get(case_id)
            cand = candidate_map.get(case_id)

            comp = CaseComparison(
                case_id=case_id,
                baseline_passed=base.passed if base else False,
                candidate_passed=cand.passed if cand else False,
                baseline_score=base.score if base else 0.0,
                candidate_score=cand.score if cand else 0.0,
                score_delta=(cand.score if cand else 0.0) - (base.score if base else 0.0),
            )
            case_comparisons.append(comp)

            if comp.baseline_passed and not comp.candidate_passed:
                regressions.append(comp)
            elif not comp.baseline_passed and comp.candidate_passed:
                improvements.append(comp)

        delta_pass_rate = candidate.summary.pass_rate - baseline.summary.pass_rate
        delta_average_score = candidate.summary.average_score - baseline.summary.average_score

        verdict = self._determine_verdict(len(regressions), len(improvements), delta_pass_rate)

        return ABComparisonReport(
            baseline=baseline,
            candidate=candidate,
            delta_pass_rate=delta_pass_rate,
            delta_average_score=delta_average_score,
            regressions=regressions,
            improvements=improvements,
            case_comparisons=case_comparisons,
            verdict=verdict,
        )

    @staticmethod
    def _determine_verdict(
        regression_count: int,
        improvement_count: int,
        delta_pass_rate: float,
    ) -> str:
        if regression_count > 0:
            return "regression"
        if improvement_count > 0 or delta_pass_rate > 0:
            return "improvement"
        return "neutral"
