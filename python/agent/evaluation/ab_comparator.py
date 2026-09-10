from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol
logger = logging.getLogger(__name__)



class EngineProtocol(Protocol):
    """评估引擎协议，表示可被 A/B 评估调用的对象.

    只要实现 ``run`` 方法（输入测试用例，返回输出文本）即可参与 A/B 对比。
    """

    async def run(self, case_input: str) -> str: ...


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

    async def auto_evaluate(
        self,
        baseline_engine: EngineProtocol,
        candidate_engine: EngineProtocol,
        test_cases: list[dict[str, Any]],
    ) -> ABComparisonReport:
        """自动化 A/B 评估：分别运行 baseline 和 candidate 引擎，对比结果.

        Args:
            baseline_engine: 基线引擎（当前版本）.
            candidate_engine: 候选引擎（待验证版本）.
            test_cases: 测试用例列表，每项含 id / input / expected_output / scoring_criteria.

        Returns:
            ABComparisonReport: A/B 对比报告.
        """
        baseline_report = await self._run_eval_suite(baseline_engine, test_cases)
        candidate_report = await self._run_eval_suite(candidate_engine, test_cases)
        return self.compare(baseline_report, candidate_report)

    async def _run_eval_suite(
        self,
        engine: EngineProtocol,
        test_cases: list[dict[str, Any]],
    ) -> EvalReport:
        """运行评估套件，对每个测试用例调用引擎并评分.

        Args:
            engine: 评估引擎.
            test_cases: 测试用例列表.

        Returns:
            EvalReport: 评估报告.
        """
        results: list[EvalCaseResult] = []
        for case in test_cases:
            case_id = case.get("id", "")
            case_input = case.get("input", "")
            expected = case.get("expected_output", "")
            criteria = case.get("scoring_criteria", {})

            try:
                output = await engine.run(case_input)
                score = self._score_output(output, expected, criteria)
                passed = score >= (criteria.get("threshold", 0.6) if criteria else 0.6)
                details = ""
                if not passed:
                    details = f"score={score:.2f} < threshold"
            except Exception as e:
                logger.debug("ab_comparator 异常处理", error=str(e))
                output = ""
                score = 0.0
                passed = False
                details = f"引擎异常: {e}"
                logger.warning("A/B 评估: 用例 %s 执行异常: %s", case_id, e)

            results.append(EvalCaseResult(
                case_id=case_id,
                passed=passed,
                score=score,
                details=details,
            ))

        total = len(results)
        passed_count = sum(1 for r in results if r.passed)
        failed_count = total - passed_count
        pass_rate = passed_count / total if total > 0 else 0.0
        avg_score = sum(r.score for r in results) / total if total > 0 else 0.0

        return EvalReport(
            name="eval_suite",
            summary=EvalSummary(
                total=total,
                passed=passed_count,
                failed=failed_count,
                pass_rate=pass_rate,
                average_score=avg_score,
            ),
            results=results,
        )

    @staticmethod
    def _score_output(
        output: str,
        expected: str,
        criteria: dict[str, Any],
    ) -> float:
        """根据期望输出和评分标准对输出评分.

        采用简单的关键词覆盖 + 长度比综合评分。
        子类可覆盖此方法接入 LLM 评分等高级策略。

        Args:
            output: 引擎输出.
            expected: 期望输出.
            criteria: 评分标准字典.

        Returns:
            float: 0.0 ~ 1.0 的评分.
        """
        if not output:
            return 0.0
        if not expected:
            return 0.5

        # 关键词覆盖率
        expected_keywords = [w for w in expected.lower().split() if len(w) > 1]
        if expected_keywords:
            output_lower = output.lower()
            hit = sum(1 for kw in expected_keywords if kw in output_lower)
            keyword_score = hit / len(expected_keywords)
        else:
            keyword_score = 0.5

        # 长度比（输出不能太短也不能太长）
        len_ratio = len(output) / max(len(expected), 1)
        if len_ratio > 2.0:
            length_score = 0.7
        elif len_ratio >= 0.5:
            length_score = 1.0
        elif len_ratio >= 0.2:
            length_score = 0.5
        else:
            length_score = 0.2

        return 0.7 * keyword_score + 0.3 * length_score

    def generate_report(self, comparison: ABComparisonReport) -> str:
        """生成人类可读的 A/B 对比报告.

        Args:
            comparison: A/B 对比结果.

        Returns:
            str: 格式化的文本报告.
        """
        lines: list[str] = []
        lines.append("=" * 60)
        lines.append("A/B 评估报告")
        lines.append("=" * 60)
        lines.append("")

        # 概要
        b = comparison.baseline.summary
        c = comparison.candidate.summary
        lines.append(f"基线通过率: {b.pass_rate:.1%} ({b.passed}/{b.total})")
        lines.append(f"候选通过率: {c.pass_rate:.1%} ({c.passed}/{c.total})")
        lines.append(f"基线均分:   {b.average_score:.2f}")
        lines.append(f"候选均分:   {c.average_score:.2f}")
        lines.append(f"通过率差值: {comparison.delta_pass_rate:+.1%}")
        lines.append(f"均分差值:   {comparison.delta_average_score:+.2f}")
        lines.append(f"结论:       {comparison.verdict}")
        lines.append("")

        # 回归
        if comparison.regressions:
            lines.append(f"回归用例 ({len(comparison.regressions)}):")
            for r in comparison.regressions:
                lines.append(
                    f"  - {r.case_id}: {r.baseline_score:.2f} → {r.candidate_score:.2f}"
                    f" ({r.score_delta:+.2f})"
                )
            lines.append("")

        # 改进
        if comparison.improvements:
            lines.append(f"改进用例 ({len(comparison.improvements)}):")
            for i in comparison.improvements:
                lines.append(
                    f"  + {i.case_id}: {i.baseline_score:.2f} → {i.candidate_score:.2f}"
                    f" ({i.score_delta:+.2f})"
                )
            lines.append("")

        lines.append("=" * 60)
        return "\n".join(lines)

    def determine_go_no_go(
        self,
        comparison: ABComparisonReport,
        max_regressions: int = 0,
        min_improvement: float = 0.05,
    ) -> bool:
        """Go/No-Go 决策：判断候选引擎是否可以替代基线.

        Args:
            comparison: A/B 对比结果.
            max_regressions: 允许的最大回归用例数，默认 0.
            min_improvement: 要求的最低均分提升幅度，默认 0.05.

        Returns:
            bool: True 表示 Go（可以上线），False 表示 No-Go.
        """
        if len(comparison.regressions) > max_regressions:
            logger.info(
                "No-Go: 回归用例数 %d 超过阈值 %d",
                len(comparison.regressions), max_regressions,
            )
            return False

        if comparison.delta_average_score < min_improvement:
            logger.info(
                "No-Go: 均分提升 %.2f 低于阈值 %.2f",
                comparison.delta_average_score, min_improvement,
            )
            return False

        if comparison.delta_pass_rate < 0:
            logger.info("No-Go: 通过率下降 %.1f%%", comparison.delta_pass_rate * -100)
            return False

        return True

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
