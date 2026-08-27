"""评估运行器 — 管理评估用例的加载、运行与结果持久化.

提供 EvalCase 数据类和 EvalRunner 运行器，支持:
- 添加/加载评估用例
- 运行评估（接受 LLM 或引擎对象）
- 结果持久化到 JSON 文件

遵循 AGENTS.md 架构原则: 评估逻辑主实现端为 Python。
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

from agent.evaluation.ab_comparator import (
    EvalCaseResult,
    EvalReport,
    EvalSummary,
)
logger = logging.getLogger(__name__)



class LLMOrEngineProtocol(Protocol):
    """LLM 或引擎协议，接受输入返回输出文本."""

    async def run(self, case_input: str) -> str: ...


@dataclass
class EvalCase:
    """评估用例定义.

    Attributes:
        id: 用例唯一标识.
        input: 输入文本（用户请求 / prompt）.
        expected_output: 期望输出文本.
        scoring_criteria: 评分标准字典，可含 threshold 等字段.
    """

    id: str = ""
    input: str = ""
    expected_output: str = ""
    scoring_criteria: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """序列化为字典.

        Returns:
            dict[str, Any]: 可 JSON 序列化的字典表示.
        """
        return {
            "id": self.id,
            "input": self.input,
            "expected_output": self.expected_output,
            "scoring_criteria": self.scoring_criteria,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EvalCase:
        """从字典反序列化.

        Args:
            data: 字典数据.

        Returns:
            EvalCase: 评估用例实例.
        """
        return cls(
            id=data.get("id", ""),
            input=data.get("input", ""),
            expected_output=data.get("expected_output", ""),
            scoring_criteria=data.get("scoring_criteria", {}),
        )


class EvalRunner:
    """评估运行器 — 管理评估用例的加载、运行与结果持久化.

    支持手动添加用例或从 JSON 文件批量加载，运行后生成 EvalReport。

    Attributes:
        _cases: 已注册的评估用例列表.

    Usage:
        runner = EvalRunner()
        runner.add_case(EvalCase(id="t1", input="你好", expected_output="你好！"))
        report = await runner.run(engine)
        EvalRunner.save_results(report, "results.json")
    """

    def __init__(self) -> None:
        """初始化评估运行器."""
        self._cases: list[EvalCase] = []

    def add_case(self, case: EvalCase) -> None:
        """添加评估用例.

        若 case.id 为空则自动生成唯一 ID。

        Args:
            case: 评估用例实例.
        """
        if not case.id:
            case.id = f"case_{uuid.uuid4().hex[:8]}"
        self._cases.append(case)

    async def run(self, engine_or_llm: LLMOrEngineProtocol) -> EvalReport:
        """运行评估，对每个用例调用引擎并评分.

        Args:
            engine_or_llm: 评估引擎或 LLM 对象，需实现 ``run(case_input) -> str``.

        Returns:
            EvalReport: 评估报告，含摘要和逐用例结果.
        """
        results: list[EvalCaseResult] = []

        for case in self._cases:
            try:
                output = await engine_or_llm.run(case.input)
                score = self._score(output, case.expected_output, case.scoring_criteria)
                threshold = case.scoring_criteria.get("threshold", 0.6)
                passed = score >= threshold
                details = "" if passed else f"score={score:.2f} < threshold={threshold}"
            except Exception as e:
                logger.debug("eval_runner 异常处理", error=str(e))
                output = ""
                score = 0.0
                passed = False
                details = f"执行异常: {e}"
                logger.warning("EvalRunner: 用例 %s 异常: %s", case.id, e)

            results.append(EvalCaseResult(
                case_id=case.id,
                passed=passed,
                score=score,
                details=details,
            ))

        total = len(results)
        passed_count = sum(1 for r in results if r.passed)
        pass_rate = passed_count / total if total > 0 else 0.0
        avg_score = sum(r.score for r in results) / total if total > 0 else 0.0

        return EvalReport(
            name="eval_runner",
            summary=EvalSummary(
                total=total,
                passed=passed_count,
                failed=total - passed_count,
                pass_rate=pass_rate,
                average_score=avg_score,
            ),
            results=results,
        )

    @classmethod
    def load_from_json(cls, path: str) -> EvalRunner:
        """从 JSON 文件加载评估用例.

        JSON 文件格式应为 EvalCase 字典的数组:
        ``[{"id": "t1", "input": "...", "expected_output": "...", "scoring_criteria": {}}]``

        Args:
            path: JSON 文件路径.

        Returns:
            EvalRunner: 已加载用例的运行器实例.

        Raises:
            FileNotFoundError: 文件不存在.
            json.JSONDecodeError: 文件内容不是合法 JSON.
        """
        runner = cls()
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        for item in data:
            case = EvalCase.from_dict(item)
            runner.add_case(case)

        logger.info("EvalRunner: 从 %s 加载了 %d 个用例", path, len(runner._cases))
        return runner

    @staticmethod
    def save_results(report: EvalReport, path: str) -> None:
        """保存评估结果到 JSON 文件.

        Args:
            report: 评估报告.
            path: 输出文件路径.
        """
        payload = {
            "name": report.name,
            "summary": {
                "total": report.summary.total,
                "passed": report.summary.passed,
                "failed": report.summary.failed,
                "pass_rate": report.summary.pass_rate,
                "average_score": report.summary.average_score,
            },
            "results": [
                {
                    "case_id": r.case_id,
                    "passed": r.passed,
                    "score": r.score,
                    "details": r.details,
                }
                for r in report.results
            ],
        }

        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

        logger.info("EvalRunner: 评估结果已保存到 %s", path)

    @staticmethod
    def _score(
        output: str,
        expected: str,
        criteria: dict[str, Any],
    ) -> float:
        """根据期望输出和评分标准对输出评分.

        采用关键词覆盖 + 长度比综合评分。

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

        # 长度比
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
