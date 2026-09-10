from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class EvalAssertion:
    assertion_type: str
    tool_name: str | None = None
    value: str | None = None
    field_path: str | None = None
    field_value: Any = None
    pattern: str | None = None
    min_score: float | None = None
    max_score: float | None = None
    tool_names: list[str] = field(default_factory=list)
    max_latency_ms: float | None = None
    min_length: int | None = None
    max_length: int | None = None


@dataclass
class AssertionResult:
    assertion: EvalAssertion
    passed: bool
    reason: str = ""


class AssertionValidator:
    def validate(
        self,
        assertions: list[EvalAssertion],
        actual_output: str = "",
        tool_calls: list[dict[str, Any]] | None = None,
        quality_score: float | None = None,
    ) -> list[AssertionResult]:
        results: list[AssertionResult] = []
        for assertion in assertions:
            result = self._validate_single(
                assertion, actual_output, tool_calls or [], quality_score
            )
            results.append(result)
        return results

    def validate_all(
        self,
        assertions: list[EvalAssertion],
        actual_output: str = "",
        tool_calls: list[dict[str, Any]] | None = None,
        quality_score: float | None = None,
    ) -> bool:
        results = self.validate(assertions, actual_output, tool_calls, quality_score)
        return all(r.passed for r in results)

    def _validate_single(
        self,
        assertion: EvalAssertion,
        actual_output: str,
        tool_calls: list[dict[str, Any]],
        quality_score: float | None,
    ) -> AssertionResult:
        atype = assertion.assertion_type

        if atype == "tool_call":
            return self._check_tool_call(assertion, tool_calls)
        elif atype == "output_contains":
            return self._check_output_contains(assertion, actual_output)
        elif atype == "output_not_contains":
            return self._check_output_not_contains(assertion, actual_output)
        elif atype == "json_field":
            return self._check_json_field(assertion, actual_output)
        elif atype == "regex":
            return self._check_regex(assertion, actual_output)
        elif atype == "score_range":
            return self._check_score_range(assertion, quality_score)
        elif atype == "tool_call_order":
            return self._check_tool_call_order(assertion, tool_calls)
        elif atype == "latency_bound":
            return self._check_latency_bound(assertion, tool_calls)
        elif atype == "output_length":
            return self._check_output_length(assertion, actual_output)

        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"未知断言类型: {atype}",
        )

    @staticmethod
    def _check_tool_call(
        assertion: EvalAssertion,
        tool_calls: list[dict[str, Any]],
    ) -> AssertionResult:
        target = assertion.tool_name or ""
        for tc in tool_calls:
            name = tc.get("name", "") or tc.get("function", {}).get("name", "")
            if name == target:
                return AssertionResult(
                    assertion=assertion,
                    passed=True,
                    reason=f"工具调用 {target} 存在",
                )
        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"未找到工具调用 {target}",
        )

    @staticmethod
    def _check_output_contains(
        assertion: EvalAssertion,
        actual_output: str,
    ) -> AssertionResult:
        value = assertion.value or ""
        if value in actual_output:
            return AssertionResult(
                assertion=assertion,
                passed=True,
                reason=f"输出包含 '{value}'",
            )
        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"输出不包含 '{value}'",
        )

    @staticmethod
    def _check_output_not_contains(
        assertion: EvalAssertion,
        actual_output: str,
    ) -> AssertionResult:
        value = assertion.value or ""
        if value not in actual_output:
            return AssertionResult(
                assertion=assertion,
                passed=True,
                reason=f"输出不包含 '{value}'",
            )
        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"输出包含被禁止的 '{value}'",
        )

    @staticmethod
    def _check_json_field(
        assertion: EvalAssertion,
        actual_output: str,
    ) -> AssertionResult:
        import json

        json_match = re.search(r"\{[\s\S]*\}", actual_output)
        if not json_match:
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason="输出中未找到JSON",
            )
        try:
            parsed = json.loads(json_match.group())
        except json.JSONDecodeError:
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason="JSON解析失败",
            )

        path = assertion.field_path or ""
        current: Any = parsed
        for key in path.split("."):
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return AssertionResult(
                    assertion=assertion,
                    passed=False,
                    reason=f"字段路径 '{path}' 不存在",
                )

        if assertion.field_value is not None and current != assertion.field_value:
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason=f"字段值不匹配: 期望 {assertion.field_value}, 实际 {current}",
            )

        return AssertionResult(
            assertion=assertion,
            passed=True,
            reason=f"字段 '{path}' 验证通过",
        )

    @staticmethod
    def _check_regex(
        assertion: EvalAssertion,
        actual_output: str,
    ) -> AssertionResult:
        pattern = assertion.pattern or ""
        try:
            if re.search(pattern, actual_output):
                return AssertionResult(
                    assertion=assertion,
                    passed=True,
                    reason=f"正则匹配成功: {pattern}",
                )
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason=f"正则不匹配: {pattern}",
            )
        except re.error as e:
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason=f"正则表达式错误: {e}",
            )

    @staticmethod
    def _check_score_range(
        assertion: EvalAssertion,
        quality_score: float | None,
    ) -> AssertionResult:
        if quality_score is None:
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason="未提供质量分数",
            )
        min_s = assertion.min_score if assertion.min_score is not None else 0.0
        max_s = assertion.max_score if assertion.max_score is not None else 1.0
        if min_s <= quality_score <= max_s:
            return AssertionResult(
                assertion=assertion,
                passed=True,
                reason=f"分数 {quality_score:.2f} 在范围 [{min_s}, {max_s}]",
            )
        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"分数 {quality_score:.2f} 不在范围 [{min_s}, {max_s}]",
        )

    @staticmethod
    def _check_tool_call_order(
        assertion: EvalAssertion,
        tool_calls: list[dict[str, Any]],
    ) -> AssertionResult:
        expected_order = assertion.tool_names
        if not expected_order:
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason="未指定 tool_names 顺序",
            )
        actual_order = []
        for tc in tool_calls:
            name = tc.get("name", "") or tc.get("function", {}).get("name", "")
            if name in expected_order:
                actual_order.append(name)
        filtered = [n for n in actual_order if n in expected_order]
        is_ordered = True
        prev_idx = -1
        for name in filtered:
            idx = expected_order.index(name)
            if idx < prev_idx:
                is_ordered = False
                break
            prev_idx = idx
        if is_ordered:
            return AssertionResult(
                assertion=assertion,
                passed=True,
                reason=f"工具调用顺序正确: {filtered}",
            )
        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"工具调用顺序错误: 期望 {expected_order}, 实际 {filtered}",
        )

    @staticmethod
    def _check_latency_bound(
        assertion: EvalAssertion,
        tool_calls: list[dict[str, Any]],
    ) -> AssertionResult:
        max_ms = assertion.max_latency_ms
        if max_ms is None:
            return AssertionResult(
                assertion=assertion,
                passed=False,
                reason="未指定 max_latency_ms",
            )
        actual_ms = sum(tc.get("latency_ms", 0) for tc in tool_calls)
        if actual_ms <= max_ms:
            return AssertionResult(
                assertion=assertion,
                passed=True,
                reason=f"延迟 {actual_ms:.0f}ms <= {max_ms}ms",
            )
        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"延迟 {actual_ms:.0f}ms > {max_ms}ms",
        )

    @staticmethod
    def _check_output_length(
        assertion: EvalAssertion,
        actual_output: str,
    ) -> AssertionResult:
        length = len(actual_output)
        min_len = assertion.min_length if assertion.min_length is not None else 0
        max_len = assertion.max_length if assertion.max_length is not None else float("inf")
        if min_len <= length <= max_len:
            return AssertionResult(
                assertion=assertion,
                passed=True,
                reason=f"输出长度 {length} 在范围 [{min_len}, {max_len}]",
            )
        return AssertionResult(
            assertion=assertion,
            passed=False,
            reason=f"输出长度 {length} 不在范围 [{min_len}, {max_len}]",
        )
