from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol, Callable

from agent.security.sensitive_detector import (
    CheckScene,
    RiskLevel,
    check_sensitive_info,
)


@dataclass
class ToolResult:
    """工具执行结果。

    Attributes:
        success: 是否成功。
        output: 输出内容。
        error: 错误信息。
        duration: 执行耗时（秒）。
    """

    success: bool
    output: Any = None
    error: str | None = None
    duration: float = 0.0


@dataclass
class ValidationResult:
    """输出验证结果。

    Attributes:
        valid: 是否通过验证。
        sanitized_output: 清洗后的输出。
        warnings: 警告信息列表。
        errors: 错误信息列表。
        auto_fixed: 是否被自动修复。
    """

    valid: bool
    sanitized_output: str
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    auto_fixed: bool = False


@dataclass
class SafetyCheckResult:
    """安全检查结果。

    Attributes:
        safe: 是否安全。
        risk_level: 风险等级。
        violations: 违规项列表。
        sanitized_output: 清洗后的输出。
    """

    safe: bool
    risk_level: RiskLevel
    violations: list[str] = field(default_factory=list)
    sanitized_output: str | None = None


@dataclass
class GuardrailResult:
    """护栏检查结果。

    Attributes:
        passed: 是否通过。
        reason: 失败原因。
        risk_level: 风险等级。
    """

    passed: bool = True
    reason: str = ""
    risk_level: str = "none"


@dataclass
class OutputGuardrail:
    """输出护栏定义。

    Attributes:
        name: 护栏名称。
        description: 护栏描述。
        check: 检查函数，接收输出文本，返回检查结果。
    """

    name: str = ""
    description: str = ""
    check: Callable[[str], GuardrailResult] = field(default=None)


@dataclass
class QualityScore:
    """输出质量评分。

    Attributes:
        overall: 综合评分（0-1）。
        accuracy: 准确性评分。
        usefulness: 有用性评分。
        friendliness: 友好性评分。
        efficiency: 效率评分。
    """

    overall: float = 1.0
    accuracy: float = 1.0
    usefulness: float = 1.0
    friendliness: float = 1.0
    efficiency: float = 1.0
    details: str = ""


@dataclass
class GoalProgress:
    """目标进度。

    Attributes:
        achieved: 是否已达成目标。
        progress: 进度百分比（0-1）。
        remaining_steps: 剩余步骤列表。
        suggested_action: 建议下一步操作。
    """

    achieved: bool = False
    progress: float = 0.0
    remaining_steps: list[str] = field(default_factory=list)
    suggested_action: str = "continue"


class LLMProtocol(Protocol):
    """LLM调用协议接口。

    定义LLM调用标准方法，实现者需提供chat方法。
    """

    async def chat(self, prompt: str, system_prompt: str | None = None) -> str: ...


@dataclass
class VerificationServiceDeps:
    """验证服务依赖配置。

    Attributes:
        llm: LLM协议实现，用于智能验证。
    """

    llm: LLMProtocol | None = None


class VerificationService:
    """输出验证服务——验证、清洗和保护Agent输出。

    提供三层防护：
    1. 输出护栏：敏感信息检测、有害内容过滤、系统提示泄露防护。
    2. 输出验证：格式校验、长度限制、质量评分。
    3. 目标进度：评估任务完成度，生成下一步建议。

    Usage:
        deps = VerificationServiceDeps(llm=my_llm)
        service = VerificationService(deps)
        result = service.validate_output("输出文本")
        progress = service.check_goal_progress("任务描述", "输出结果")
    """

    MAX_OUTPUT_LENGTH = 4000

    def __init__(self, deps: VerificationServiceDeps | None = None) -> None:
        self.deps = deps or VerificationServiceDeps()
        self._guardrails: list[OutputGuardrail] = []
        self._guardrails_enabled: bool = True
        self._register_builtin_guardrails()

    # ─── OutputGuardrailEngine ───

    def _register_builtin_guardrails(self) -> None:
        self._guardrails.append(OutputGuardrail(
            name="sensitive_data_detection",
            description="检测输出中是否包含敏感信息（API Key、密码、身份证号等）",
            check=self._check_sensitive_data,
        ))
        self._guardrails.append(OutputGuardrail(
            name="harmful_content_detection",
            description="检测输出中是否包含有害内容",
            check=self._check_harmful_content,
        ))
        self._guardrails.append(OutputGuardrail(
            name="system_prompt_leak_detection",
            description="检测输出中是否泄露了系统提示词",
            check=self._check_system_prompt_leak,
        ))

    def _check_sensitive_data(self, output: str) -> GuardrailResult:
        patterns = [
            (r"sk-[a-zA-Z0-9]{20,}", "OpenAI API Key"),
            (r"AKIA[A-Z0-9]{16}", "AWS Access Key"),
            (r"\b\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b", "身份证号"),
            (r"password\s*[:=]\s*['\"][^'\"]{4,}", "明文密码"),
            (r"api[_-]?key\s*[:=]\s*['\"][^'\"]{8,}", "API Key"),
        ]
        for pattern, name in patterns:
            if re.search(pattern, output):
                return GuardrailResult(
                    passed=False,
                    reason=f"输出中包含敏感信息: {name}",
                    risk_level="critical",
                )
        return GuardrailResult(passed=True)

    def _check_harmful_content(self, output: str) -> GuardrailResult:
        harmful_patterns = [
            r"制作.*炸弹",
            r"如何.*自杀",
            r"制造.*毒品",
        ]
        for pattern in harmful_patterns:
            if re.search(pattern, output, re.IGNORECASE):
                return GuardrailResult(
                    passed=False,
                    reason="输出中包含有害内容",
                    risk_level="critical",
                )
        return GuardrailResult(passed=True)

    def _check_system_prompt_leak(self, output: str) -> GuardrailResult:
        leak_patterns = [
            r"你是家百星",
            r"system prompt",
            r"你的系统指令",
            r"constitution prompt",
        ]
        for pattern in leak_patterns:
            if re.search(pattern, output, re.IGNORECASE):
                return GuardrailResult(
                    passed=False,
                    reason="输出中可能泄露了系统提示",
                    risk_level="high",
                )
        return GuardrailResult(passed=True)

    def register_guardrail(self, guardrail: OutputGuardrail) -> None:
        self._guardrails.append(guardrail)

    def check_guardrails(self, output: str) -> GuardrailResult:
        if not self._guardrails_enabled:
            return GuardrailResult(passed=True)
        for guardrail in self._guardrails:
            result = guardrail.check(output)
            if not result.passed:
                return result
        return GuardrailResult(passed=True)

    def set_guardrails_enabled(self, enabled: bool) -> None:
        self._guardrails_enabled = enabled

    def get_guardrails(self) -> list[OutputGuardrail]:
        return list(self._guardrails)

    def validate_tool_result(self, tool_name: str, result: ToolResult) -> ValidationResult:
        warnings: list[str] = []
        errors: list[str] = []

        if not result.success:
            errors.append(f"工具 {tool_name} 执行失败: {result.error or '未知错误'}")
            return ValidationResult(
                valid=False,
                sanitized_output=f"错误: {result.error or '工具执行失败'}",
                warnings=warnings,
                errors=errors,
                auto_fixed=False,
            )

        output_str = (
            result.output
            if isinstance(result.output, str)
            else json.dumps(result.output, ensure_ascii=False, default=str)
        )
        if not output_str or not output_str.strip():
            errors.append(f"工具 {tool_name} 返回空结果")
            return ValidationResult(
                valid=False,
                sanitized_output="工具返回了空结果",
                warnings=warnings,
                errors=errors,
                auto_fixed=False,
            )

        error_patterns = ["error", "exception", "failed", "timeout", "unauthorized"]
        lower_output = output_str.lower()
        if any(p in lower_output for p in error_patterns) and len(output_str) < 200:
            warnings.append(f"工具 {tool_name} 可能返回了错误信息")

        if len(output_str) > self.MAX_OUTPUT_LENGTH:
            sanitized = output_str[: self.MAX_OUTPUT_LENGTH] + "\n...[内容已截断]"
            warnings.append(f"工具 {tool_name} 输出过长，已截断")
            return ValidationResult(
                valid=True,
                sanitized_output=sanitized,
                warnings=warnings,
                errors=errors,
                auto_fixed=True,
            )

        return ValidationResult(
            valid=True,
            sanitized_output=output_str,
            warnings=warnings,
            errors=errors,
            auto_fixed=False,
        )

    def check_output_safety(self, output: str) -> SafetyCheckResult:
        result = check_sensitive_info(output, CheckScene.OUTPUT)
        violations = [f"{v.name} (风险: {v.risk.value})" for v in result.violations]
        return SafetyCheckResult(
            safe=result.safe,
            risk_level=result.risk_level,
            violations=violations,
            sanitized_output=result.sanitized_output,
        )

    def score_quality(self, context: dict[str, Any]) -> QualityScore:
        loop_count: int = context.get("loop_count", 0)
        total_tool_calls: int = context.get("total_tool_calls", 0)
        total_tool_duration: float = context.get("total_tool_duration", 0.0)
        total_duration: float = context.get("total_duration", 0.0)
        completed_successfully: bool = context.get("completed_successfully", True)

        overall = 1.0
        efficiency = 1.0

        if not completed_successfully:
            overall -= 0.3
        if loop_count > 3:
            penalty = 0.1 * (loop_count - 3)
            overall -= penalty
            efficiency -= penalty
        if total_tool_calls > 0:
            avg_duration = total_tool_duration / total_tool_calls
            if avg_duration > 5000:
                efficiency -= 0.1
            if avg_duration > 10000:
                efficiency -= 0.2
        if total_duration > 15000:
            efficiency -= 0.1
        if total_duration > 30000:
            efficiency -= 0.2

        overall = max(0.1, min(1.0, overall))
        efficiency = max(0.1, min(1.0, efficiency))

        friendliness_base = (
            0.85
            if total_duration > 0 and total_tool_calls == 0
            else 0.75 if completed_successfully else 0.5
        )

        return QualityScore(
            overall=overall,
            accuracy=max(0.1, overall * 0.9),
            usefulness=max(0.1, overall * 0.95),
            friendliness=max(0.1, friendliness_base),
            efficiency=efficiency,
            details=f"轮次={loop_count} 工具={total_tool_calls} 时长={total_duration:.0f}ms",
        )

    async def evaluate_goal_progress(
        self,
        original_input: str,
        current_output: str,
    ) -> GoalProgress:
        if not current_output or len(current_output) < 10:
            return GoalProgress(
                achieved=False,
                progress=0.1,
                remaining_steps=["生成有效响应"],
                suggested_action="continue",
            )

        error_indicators = ["抱歉", "无法", "失败", "错误", "error", "failed"]
        has_errors = any(e in current_output.lower() for e in error_indicators)

        if has_errors:
            return GoalProgress(
                achieved=False,
                progress=0.3,
                remaining_steps=["修正错误", "重新执行"],
                suggested_action="replan",
            )

        if self.deps.llm:
            try:
                return await self._llm_evaluate_goal(original_input, current_output)
            except Exception:
                pass

        # 无 LLM 时无法真正评估目标达成，不得误判为成功（审计 V-01）
        return GoalProgress(
            achieved=False,
            progress=0.0,
            remaining_steps=["配置 LLM 以评估目标进度"],
            suggested_action="continue",
        )

    async def _llm_evaluate_goal(
        self,
        original_input: str,
        current_output: str,
    ) -> GoalProgress:
        if not self.deps.llm:
            return GoalProgress(
                achieved=False,
                progress=0.5,
                remaining_steps=[],
                suggested_action="continue",
            )

        prompt = (
            f'评估以下输出是否达成了用户的目标。\n\n'
            f'用户目标: "{original_input}"\n'
            f'当前输出: "{current_output[:500]}"\n\n'
            f'请用JSON格式回答:\n'
            f'{{"achieved": true, "progress": 0.9, "remainingSteps": [], "suggestedAction": "continue"}}'
        )

        response = await self.deps.llm.chat(prompt)
        json_match = re.search(r"\{[\s\S]*\}", response)
        if not json_match:
            # 解析失败时不得默认成功（审计 V-02）
            return GoalProgress(
                achieved=False,
                progress=0.3,
                remaining_steps=[],
                suggested_action="continue",
            )

        try:
            parsed = json.loads(json_match.group())
            return GoalProgress(
                # 缺字段时默认未达成，避免误通过（审计 V-02）
                achieved=parsed.get("achieved", False),
                progress=max(0.0, min(1.0, parsed.get("progress", 0.0))),
                remaining_steps=parsed.get("remainingSteps", []),
                suggested_action=parsed.get("suggestedAction", "continue"),
            )
        except (json.JSONDecodeError, TypeError):
            return GoalProgress(
                achieved=True,
                progress=0.7,
                remaining_steps=[],
                suggested_action="continue",
            )
