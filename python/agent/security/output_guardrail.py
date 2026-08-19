from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger
from agent.security.sensitive_detector import check_sensitive_info, CheckScene, RiskLevel

log = StructuredLogger("output_guardrail")


@dataclass
class GuardrailResult:
    """护栏检查结果。

    Attributes:
        passed: 是否通过。
        reason: 失败原因。
        risk_level: 风险等级。
    """

    passed: bool
    reason: str = ""
    risk_level: str = "low"


@dataclass
class OutputGuardrail:
    """输出护栏定义。

    Attributes:
        name: 护栏名称。
        description: 护栏描述。
        check: 检查函数，接收输出文本，返回GuardrailResult。
    """

    name: str
    description: str = ""
    check: Callable[[str], GuardrailResult] = field(default=lambda _: GuardrailResult(passed=True))


_SENSITIVE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"sk-[a-zA-Z0-9]{20,}"), "OpenAI API Key"),
    (re.compile(r"AKIA[A-Z0-9]{16}"), "AWS Access Key"),
    (re.compile(r"\b\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b"), "身份证号"),
    (re.compile(r"password\s*[:=]\s*['\"][^'\"]{4,}", re.IGNORECASE), "明文密码"),
    (re.compile(r"api[_-]?key\s*[:=]\s*['\"][^'\"]{8,}", re.IGNORECASE), "API Key"),
]

_HARMFUL_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"制作.*炸弹", re.IGNORECASE),
    re.compile(r"如何.*自杀", re.IGNORECASE),
    re.compile(r"制造.*毒品", re.IGNORECASE),
    re.compile(r"攻击.*系统", re.IGNORECASE),
    re.compile(r"破解.*密码", re.IGNORECASE),
    re.compile(r"恶意.*代码", re.IGNORECASE),
]

_LEAK_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"你是家百星", re.IGNORECASE),
    re.compile(r"system prompt", re.IGNORECASE),
    re.compile(r"你的系统指令", re.IGNORECASE),
    re.compile(r"constitution prompt", re.IGNORECASE),
    re.compile(r"你的提示词", re.IGNORECASE),
    re.compile(r"你的prompt", re.IGNORECASE),
]


class OutputGuardrailEngine:
    """输出护栏引擎——检测和过滤 Agent 输出中的敏感/有害内容。

    内置三类护栏：
    1. 敏感信息检测：密钥、API Key、密码、身份证号等。
    2. 有害内容过滤：暴力、自杀、非法制造等。
    3. 系统提示泄露防护：检测 System Prompt 泄露风险。

    Usage:
        engine = OutputGuardrailEngine()
        result = engine.check("这是一段输出文本")
        if not result.get("passed"):
            print(result["reason"])
    """

    def __init__(self) -> None:
        self._guardrails: list[OutputGuardrail] = []
        self._enabled: bool = True
        self._register_builtin_guardrails()

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
        for pattern, name in _SENSITIVE_PATTERNS:
            if pattern.search(output):
                log.warning(f"输出Guardrail拦截: 检测到{name}")
                return GuardrailResult(
                    passed=False,
                    reason=f"输出中包含敏感信息: {name}",
                    risk_level="critical",
                )
        return GuardrailResult(passed=True)

    def _check_harmful_content(self, output: str) -> GuardrailResult:
        for pattern in _HARMFUL_PATTERNS:
            if pattern.search(output):
                log.warning("输出Guardrail拦截: 检测到有害内容")
                return GuardrailResult(
                    passed=False,
                    reason="输出中包含有害内容",
                    risk_level="critical",
                )
        return GuardrailResult(passed=True)

    def _check_system_prompt_leak(self, output: str) -> GuardrailResult:
        for pattern in _LEAK_PATTERNS:
            if pattern.search(output):
                log.warning("输出Guardrail拦截: 检测到系统提示泄露")
                return GuardrailResult(
                    passed=False,
                    reason="输出中可能泄露了系统提示",
                    risk_level="high",
                )
        return GuardrailResult(passed=True)

    def register(self, guardrail: OutputGuardrail) -> None:
        self._guardrails.append(guardrail)
        log.info(f"注册输出Guardrail: {guardrail.name}")

    def check(self, output: str) -> GuardrailResult:
        if not self._enabled:
            return GuardrailResult(passed=True)

        for guardrail in self._guardrails:
            result = guardrail.check(output)
            if not result.passed:
                log.warning(f"输出Guardrail [{guardrail.name}] 拦截: {result.reason}")
                return result

        return GuardrailResult(passed=True)

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        log.info(f"输出Guardrail {'已启用' if enabled else '已禁用'}")

    def get_guardrails(self) -> list[OutputGuardrail]:
        return list(self._guardrails)

    @property
    def enabled(self) -> bool:
        return self._enabled
