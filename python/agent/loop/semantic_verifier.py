"""语义验证增强 — 即使轻量模式也执行最小语义验证。

设计目标：
1. 回答完整性验证：输出是否回答了用户问题
2. 自相矛盾检测：输出是否存在逻辑矛盾
3. 已知错误模式检测：输出是否包含常见错误模式
4. 事实性检查：输出中的关键声明是否有证据支持

验证级别：
  - minimal: 最小验证（规则检查 + 错误模式检测）
  - standard: 标准验证（+ 完整性检查 + 矛盾检测）
  - thorough: 深度验证（+ LLM 事实性检查 + 逻辑一致性）

Usage:
    verifier = SemanticVerifier(llm=llm)
    result = await verifier.verify(
        input_text="帮我修复这个 bug",
        output="已修复 bug，修改了...",
        context=loop_context,
        level="minimal",
    )
    if not result.passed:
        print(result.issues)
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("semantic_verifier")


class VerificationLevel(str, Enum):
    MINIMAL = "minimal"
    STANDARD = "standard"
    THOROUGH = "thorough"


class IssueSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass
class VerificationIssue:
    issue_type: str
    severity: IssueSeverity
    description: str
    evidence: str = ""
    suggestion: str = ""


@dataclass
class VerificationResult:
    passed: bool
    level: VerificationLevel = VerificationLevel.MINIMAL
    score: float = 1.0
    issues: list[VerificationIssue] = field(default_factory=list)
    coverage: float = 0.0
    duration_ms: float = 0.0

    @property
    def has_errors(self) -> bool:
        return any(i.severity in (IssueSeverity.ERROR, IssueSeverity.CRITICAL) for i in self.issues)

    @property
    def has_warnings(self) -> bool:
        return any(i.severity == IssueSeverity.WARNING for i in self.issues)


_KNOWN_ERROR_PATTERNS: list[dict[str, str]] = [
    {"pattern": r"我无法|我不能|I cannot|I can't", "type": "capability_limit", "severity": "warning"},
    {"pattern": r"抱歉|sorry", "type": "apology", "severity": "info"},
    {"pattern": r"错误[:：]\s*$|error[:：]\s*$", "type": "empty_error", "severity": "error"},
    {"pattern": r"undefined|null|None(?!\s*=\s*)", "type": "raw_output", "severity": "warning"},
    {"pattern": r"TODO|FIXME|HACK|XXX", "type": "placeholder", "severity": "warning"},
    {"pattern": r"Traceback|Exception|Error[:：]", "type": "stack_trace", "severity": "error"},
    {"pattern": r"作为 AI|as an AI|作为语言模型", "type": "ai_disclaimer", "severity": "info"},
    {"pattern": r"\{.*\}.*\{.*\}", "type": "template_unfilled", "severity": "warning"},
    {"pattern": r"\[.*\].*\[.*\]", "type": "bracket_unfilled", "severity": "warning"},
]

_CONTRADICTION_PATTERNS: list[dict[str, Any]] = [
    {"positive": r"成功|完成|已解决|succeeded|completed", "negative": r"失败|未完成|无法|failed|unable"},
    {"positive": r"是|正确|对|yes|correct|true", "negative": r"否|错误|不对|no|incorrect|false"},
    {"positive": r"增加|提升|提高|increase|improve", "negative": r"减少|降低|下降|decrease|reduce"},
]

_QUESTION_PATTERNS = [
    r"如何", r"怎么", r"为什么", r"什么", r"哪个", r"多少",
    r"how", r"why", r"what", r"which", r"where", r"when",
    r"\?",
]

_TASK_KEYWORDS: dict[str, list[str]] = {
    "fix": ["修复", "fix", "解决", "resolve", "patch", "纠正"],
    "create": ["创建", "create", "新建", "new", "添加", "add", "生成", "generate"],
    "delete": ["删除", "delete", "移除", "remove", "清除", "clear"],
    "explain": ["解释", "explain", "说明", "describe", "分析", "analyze"],
    "find": ["查找", "find", "搜索", "search", "定位", "locate"],
    "modify": ["修改", "modify", "更改", "change", "更新", "update", "编辑", "edit"],
    "test": ["测试", "test", "验证", "verify", "检查", "check"],
    "refactor": ["重构", "refactor", "优化", "optimize", "改进", "improve"],
}


class SemanticVerifier:
    def __init__(self, llm: Any | None = None) -> None:
        self._llm = llm

    async def verify(
        self,
        input_text: str,
        output: str,
        context: Any | None = None,
        level: str | VerificationLevel = VerificationLevel.MINIMAL,
    ) -> VerificationResult:
        if isinstance(level, str):
            try:
                level = VerificationLevel(level)
            except ValueError:
                level = VerificationLevel.MINIMAL

        start = time.time()
        issues: list[VerificationIssue] = []

        error_issues = self._check_error_patterns(output)
        issues.extend(error_issues)

        if level in (VerificationLevel.STANDARD, VerificationLevel.THOROUGH):
            completeness_issues = self._check_completeness(input_text, output)
            issues.extend(completeness_issues)

            contradiction_issues = self._check_contradictions(output)
            issues.extend(contradiction_issues)

        if level == VerificationLevel.THOROUGH and self._llm:
            factuality_issues = await self._check_factuality(input_text, output)
            issues.extend(factuality_issues)

        error_count = sum(1 for i in issues if i.severity in (IssueSeverity.ERROR, IssueSeverity.CRITICAL))
        warning_count = sum(1 for i in issues if i.severity == IssueSeverity.WARNING)

        passed = error_count == 0
        score = max(0.0, 1.0 - error_count * 0.3 - warning_count * 0.1)

        coverage = self._compute_coverage(input_text, output, level)

        duration_ms = (time.time() - start) * 1000

        return VerificationResult(
            passed=passed,
            level=level,
            score=round(score, 4),
            issues=issues,
            coverage=round(coverage, 4),
            duration_ms=duration_ms,
        )

    def _check_error_patterns(self, output: str) -> list[VerificationIssue]:
        issues: list[VerificationIssue] = []

        for pattern_def in _KNOWN_ERROR_PATTERNS:
            matches = re.findall(pattern_def["pattern"], output, re.IGNORECASE)
            if matches:
                severity = IssueSeverity(pattern_def["severity"])
                issues.append(VerificationIssue(
                    issue_type=pattern_def["type"],
                    severity=severity,
                    description=f"检测到已知错误模式: {pattern_def['type']}",
                    evidence=matches[0] if isinstance(matches[0], str) else str(matches[0]),
                    suggestion=self._suggest_fix(pattern_def["type"]),
                ))

        if not output or not output.strip():
            issues.append(VerificationIssue(
                issue_type="empty_output",
                severity=IssueSeverity.CRITICAL,
                description="输出为空",
                suggestion="请检查工具执行是否成功",
            ))

        if len(output) < 10 and not any(c.isdigit() for c in output):
            issues.append(VerificationIssue(
                issue_type="too_short",
                severity=IssueSeverity.WARNING,
                description="输出过短，可能不完整",
                suggestion="请检查是否需要更多执行步骤",
            ))

        return issues

    def _check_completeness(self, input_text: str, output: str) -> list[VerificationIssue]:
        issues: list[VerificationIssue] = []

        has_question = any(re.search(p, input_text, re.IGNORECASE) for p in _QUESTION_PATTERNS)
        if has_question:
            has_answer_indicator = any(
                keyword in output.lower()
                for keyword in ["因为", "由于", "所以", "因此", "because", "therefore", "thus", "是", "yes", "否", "no"]
            )
            if not has_answer_indicator and len(output) < 50:
                issues.append(VerificationIssue(
                    issue_type="question_not_answered",
                    severity=IssueSeverity.WARNING,
                    description="用户提出了问题但输出未包含明确回答",
                    suggestion="请确保输出直接回答了用户的问题",
                ))

        for task_type, keywords in _TASK_KEYWORDS.items():
            if any(kw in input_text.lower() for kw in keywords):
                task_indicators = self._get_task_completion_indicators(task_type)
                if not any(ind in output.lower() for ind in task_indicators):
                    issues.append(VerificationIssue(
                        issue_type="task_incomplete",
                        severity=IssueSeverity.WARNING,
                        description=f"任务类型 '{task_type}' 可能未完成",
                        suggestion=f"请确认 {task_type} 操作已成功执行",
                    ))

        return issues

    def _check_contradictions(self, output: str) -> list[VerificationIssue]:
        issues: list[VerificationIssue] = []
        sentences = re.split(r'[。！？.!?\n]', output)
        sentences = [s.strip() for s in sentences if len(s.strip()) > 5]

        for contradiction in _CONTRADICTION_PATTERNS:
            positive_matches = []
            negative_matches = []

            for sentence in sentences:
                if re.search(contradiction["positive"], sentence, re.IGNORECASE):
                    positive_matches.append(sentence)
                if re.search(contradiction["negative"], sentence, re.IGNORECASE):
                    negative_matches.append(sentence)

            if positive_matches and negative_matches:
                issues.append(VerificationIssue(
                    issue_type="contradiction",
                    severity=IssueSeverity.WARNING,
                    description="输出中可能存在自相矛盾",
                    evidence=f"正面: '{positive_matches[0][:50]}...' vs 负面: '{negative_matches[0][:50]}...'",
                    suggestion="请检查输出逻辑是否一致",
                ))

        return issues

    async def _check_factuality(self, input_text: str, output: str) -> list[VerificationIssue]:
        issues: list[VerificationIssue] = []

        if not self._llm:
            return issues

        try:
            prompt = (
                "请验证以下 AI 输出的事实准确性。检查是否存在：\n"
                "1. 事实性错误（与已知事实不符）\n"
                "2. 逻辑错误（推理过程有误）\n"
                "3. 过时信息（可能已过时的声明）\n\n"
                f"用户输入: {input_text[:200]}\n"
                f"AI 输出: {output[:500]}\n\n"
                "请以 JSON 格式返回: {\"has_issues\": bool, \"issues\": [{\"type\": str, \"description\": str}]}"
            )

            response = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=200,
            )

            content = response.get("content", "") if isinstance(response, dict) else str(response)

            if "true" in content.lower() and "has_issues" in content.lower():
                issues.append(VerificationIssue(
                    issue_type="factuality_check_flagged",
                    severity=IssueSeverity.WARNING,
                    description="LLM 事实性检查标记了潜在问题",
                    evidence=content[:200],
                    suggestion="请人工审查输出的准确性",
                ))
        except Exception as e:
            log_ignored(log, "semantic_verifier._check_factuality", e)

        return issues

    def _compute_coverage(
        self,
        input_text: str,
        output: str,
        level: VerificationLevel,
    ) -> float:
        coverage = 0.0

        if output and output.strip():
            coverage += 0.3

        input_words = set(re.findall(r'\w+', input_text.lower()))
        output_words = set(re.findall(r'\w+', output.lower()))
        if input_words:
            overlap = len(input_words & output_words) / len(input_words)
            coverage += min(overlap * 0.4, 0.4)

        if level in (VerificationLevel.STANDARD, VerificationLevel.THOROUGH):
            has_question = any(re.search(p, input_text, re.IGNORECASE) for p in _QUESTION_PATTERNS)
            if has_question:
                answer_indicators = ["因为", "由于", "所以", "因此", "because", "therefore"]
                if any(ind in output.lower() for ind in answer_indicators):
                    coverage += 0.15

            for task_type, keywords in _TASK_KEYWORDS.items():
                if any(kw in input_text.lower() for kw in keywords):
                    indicators = self._get_task_completion_indicators(task_type)
                    if any(ind in output.lower() for ind in indicators):
                        coverage += 0.15
                        break

        return min(coverage, 1.0)

    def _get_task_completion_indicators(self, task_type: str) -> list[str]:
        indicators_map: dict[str, list[str]] = {
            "fix": ["已修复", "修复完成", "fixed", "resolved", "patched"],
            "create": ["已创建", "创建完成", "created", "generated", "added"],
            "delete": ["已删除", "删除完成", "deleted", "removed"],
            "explain": ["解释如下", "说明如下", "原因是", "because", "the reason"],
            "find": ["找到", "发现", "found", "located", "搜索结果"],
            "modify": ["已修改", "修改完成", "modified", "updated", "changed"],
            "test": ["测试通过", "验证成功", "passed", "verified", "检查完成"],
            "refactor": ["已重构", "重构完成", "refactored", "optimized", "改进完成"],
        }
        return indicators_map.get(task_type, [])

    def _suggest_fix(self, issue_type: str) -> str:
        suggestions: dict[str, str] = {
            "capability_limit": "尝试换一种方式完成任务",
            "apology": "检查是否可以提供替代方案",
            "empty_error": "检查工具执行日志",
            "raw_output": "格式化输出，避免暴露内部数据",
            "placeholder": "完成待办项或移除占位符",
            "stack_trace": "捕获异常并返回用户友好的错误信息",
            "ai_disclaimer": "移除不必要的 AI 免责声明",
            "template_unfilled": "填充模板中的占位变量",
            "bracket_unfilled": "填充方括号中的占位内容",
        }
        return suggestions.get(issue_type, "请检查输出质量")
