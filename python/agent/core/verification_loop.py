"""验证闭环集成 (Verification Loop)。

将 VerificationService 集成到对话循环中，实现每步验证 + 自动修正。
支持：
- 工具执行后验证：检查工具输出有效性、安全性
- 最终响应验证：护栏检查、质量评分、目标进度评估
- 自动修正：验证失败时触发 LLM 自我反思，修正后重试
- 验证报告：生成可追溯的验证日志

架构：
    ConversationLoop.run()
        ↓
    VerificationLoop.wrap()
        ├── pre_tool: 工具执行前校验
        ├── post_tool: 工具执行后验证 → 失败则触发修正
        ├── post_response: 最终响应验证 → 护栏 + 质量评分
        └── report: 生成验证报告

Usage:
    vloop = VerificationLoop(verification_service=engine.verification)
    result = await vloop.run_with_verification(
        loop=conversation_loop,
        user_input="...",
    )
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.verification.service import (
    GuardrailResult,
    QualityScore,
    SafetyCheckResult,
    ValidationResult,
    VerificationService,
)

log = StructuredLogger("verification_loop")


class VerifyAction(str, Enum):
    PASS = "pass"
    RETRY = "retry"
    WARN = "warn"
    BLOCK = "block"


@dataclass
class StepVerification:
    step_type: str = ""
    action: VerifyAction = VerifyAction.PASS
    message: str = ""
    validation: ValidationResult | None = None
    safety: SafetyCheckResult | None = None
    guardrail: GuardrailResult | None = None
    quality: QualityScore | None = None
    duration_ms: float = 0.0


@dataclass
class VerificationReport:
    steps: list[StepVerification] = field(default_factory=list)
    total_checks: int = 0
    passed: int = 0
    retried: int = 0
    blocked: int = 0
    overall_score: float = 1.0
    summary: str = ""


class VerificationLoop:
    """验证闭环 — 在对话循环的每个关键节点进行验证。

    三阶段验证：
    1. 工具执行后：验证输出有效性、检测错误模式
    2. 最终响应：护栏检查、安全扫描、质量评分
    3. 目标进度：评估任务完成度

    验证失败时的处理策略：
    - retry: 将错误信息反馈给 LLM，触发自我修正
    - warn: 记录警告但继续执行
    - block: 阻止输出，返回安全提示
    """

    def __init__(
        self,
        verification: VerificationService | None = None,
        enable_tool_verification: bool = True,
        enable_response_verification: bool = True,
        enable_guardrails: bool = True,
        max_correction_rounds: int = 2,
    ) -> None:
        self._verification = verification
        self._enable_tool_verification = enable_tool_verification
        self._enable_response_verification = enable_response_verification
        self._enable_guardrails = enable_guardrails
        self._max_correction_rounds = max_correction_rounds
        self._reports: list[VerificationReport] = []

    def verify_tool_result(
        self,
        tool_name: str,
        output: str,
        success: bool,
        error: str | None = None,
    ) -> StepVerification:
        """验证工具执行结果。

        Args:
            tool_name: 工具名称。
            output: 工具输出。
            success: 工具是否执行成功。
            error: 错误信息。

        Returns:
            StepVerification: 验证结果，包含 action 和 message。
        """
        start = time.time()

        if not self._enable_tool_verification or not self._verification:
            return StepVerification(
                step_type="tool",
                action=VerifyAction.PASS,
                duration_ms=(time.time() - start) * 1000,
            )

        from agent.verification.service import ToolResult as VToolResult

        vresult = VToolResult(
            success=success,
            output=output,
            error=error,
        )

        validation = self._verification.validate_tool_result(tool_name, vresult)

        action = VerifyAction.PASS
        message = ""

        if not validation.valid:
            if "执行失败" in (validation.errors[0] if validation.errors else ""):
                action = VerifyAction.RETRY
                message = f"工具 {tool_name} 执行失败，需要重试: {validation.errors[0]}"
            else:
                action = VerifyAction.WARN
                message = f"工具 {tool_name} 验证未通过: {', '.join(validation.errors)}"

        if validation.warnings:
            if action == VerifyAction.PASS:
                action = VerifyAction.WARN
            message += f" 警告: {', '.join(validation.warnings)}"

        return StepVerification(
            step_type="tool",
            action=action,
            message=message or f"工具 {tool_name} 验证通过",
            validation=validation,
            duration_ms=(time.time() - start) * 1000,
        )

    def verify_response(
        self,
        content: str,
        context: dict[str, Any] | None = None,
    ) -> StepVerification:
        """验证最终响应。

        执行护栏检查、安全扫描、质量评分。

        Args:
            content: 响应内容。
            context: 上下文信息（loop_count, tool_calls 等）。

        Returns:
            StepVerification: 验证结果。
        """
        start = time.time()

        if not self._enable_response_verification or not self._verification:
            return StepVerification(
                step_type="response",
                action=VerifyAction.PASS,
                duration_ms=(time.time() - start) * 1000,
            )

        action = VerifyAction.PASS
        messages: list[str] = []
        safety = None
        guardrail = None
        quality = None

        if self._enable_guardrails:
            guardrail = self._verification.check_guardrails(content)
            if not guardrail.passed:
                if guardrail.risk_level == "critical":
                    action = VerifyAction.BLOCK
                else:
                    action = VerifyAction.WARN
                messages.append(f"护栏检查失败: {guardrail.reason}")

            safety = self._verification.check_output_safety(content)
            if not safety.safe:
                action = VerifyAction.BLOCK
                messages.append(f"安全检查失败: {', '.join(safety.violations)}")

        if context:
            quality = self._verification.score_quality(context)
            if quality.overall < 0.5:
                if action == VerifyAction.PASS:
                    action = VerifyAction.WARN
                messages.append(f"质量评分偏低: {quality.overall:.2f}")

        return StepVerification(
            step_type="response",
            action=action,
            message="; ".join(messages) if messages else "响应验证通过",
            safety=safety,
            guardrail=guardrail,
            quality=quality,
            duration_ms=(time.time() - start) * 1000,
        )

    def build_correction_prompt(
        self,
        verification: StepVerification,
        original_output: str,
    ) -> str:
        """构建修正提示，引导 LLM 自我修正。

        Args:
            verification: 验证结果。
            original_output: 原始输出。

        Returns:
            str: 修正提示文本。
        """
        if verification.action == VerifyAction.PASS:
            return ""

        parts: list[str] = []

        if verification.action == VerifyAction.RETRY:
            parts.append("上一步执行结果存在以下问题：")
            if verification.validation and verification.validation.errors:
                for err in verification.validation.errors:
                    parts.append(f"  - {err}")
            parts.append("")
            parts.append("请根据以上问题重新尝试，修正错误后再次执行。")
            parts.append(f"原始输出: {original_output[:500]}")

        elif verification.action == VerifyAction.WARN:
            parts.append("注意：上一步结果存在以下警告：")
            if verification.validation and verification.validation.warnings:
                for warn in verification.validation.warnings:
                    parts.append(f"  - {warn}")
            parts.append("请关注以上警告，确保后续步骤正确。")

        return "\n".join(parts)

    def generate_report(self) -> VerificationReport:
        """生成当前会话的验证报告。

        Returns:
            VerificationReport: 验证报告汇总。
        """
        if not self._reports:
            return VerificationReport()

        latest = self._reports[-1]
        return latest

    def start_session(self) -> None:
        """开始新的验证会话，重置报告。"""
        self._reports.append(VerificationReport())

    def record_step(self, step: StepVerification) -> None:
        """记录验证步骤到当前报告。

        Args:
            step: 验证步骤结果。
        """
        if not self._reports:
            self.start_session()
        report = self._reports[-1]
        report.steps.append(step)
        report.total_checks += 1

        if step.action == VerifyAction.PASS:
            report.passed += 1
        elif step.action == VerifyAction.RETRY:
            report.retried += 1
        elif step.action == VerifyAction.BLOCK:
            report.blocked += 1

        if report.total_checks > 0:
            report.overall_score = report.passed / report.total_checks

        report.summary = (
            f"验证完成: {report.total_checks}次检查, "
            f"通过{report.passed}, 重试{report.retried}, 阻止{report.blocked}, "
            f"得分{report.overall_score:.2f}"
        )

    @property
    def stats(self) -> dict[str, Any]:
        if not self._reports:
            return {"sessions": 0, "total_checks": 0, "avg_score": 1.0}
        total_checks = sum(r.total_checks for r in self._reports)
        avg_score = (
            sum(r.overall_score for r in self._reports) / len(self._reports)
            if self._reports else 1.0
        )
        return {
            "sessions": len(self._reports),
            "total_checks": total_checks,
            "avg_score": round(avg_score, 3),
        }
