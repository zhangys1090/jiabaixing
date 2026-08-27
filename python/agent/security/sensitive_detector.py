from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.types import RiskLevel


class CheckScene(str, Enum):
    """检查场景枚举。

    Attributes:
        OUTPUT: 输出内容检查。
        STORAGE: 存储内容检查。
        COMMAND: 命令执行检查。
    """

    OUTPUT = "output"
    STORAGE = "storage"
    COMMAND = "command"


@dataclass
class SensitiveViolation:
    """敏感信息违规记录。

    Attributes:
        name: 违规类型名称。
        risk: 风险等级。
        matched_text: 匹配到的敏感文本。
    """

    name: str
    risk: RiskLevel
    matched_text: str | None = None


@dataclass
class SensitiveCheckResult:
    """敏感信息检查结果。

    Attributes:
        safe: 是否安全。
        risk_level: 整体风险等级。
        violations: 违规列表。
        sanitized_output: 脱敏后的输出。
    """

    safe: bool
    risk_level: RiskLevel
    violations: list[SensitiveViolation] = field(default_factory=list)
    sanitized_output: str | None = None


@dataclass
class DangerousCommandResult:
    """危险命令检查结果。

    Attributes:
        dangerous: 是否危险。
        reason: 危险原因。
    """

    dangerous: bool
    reason: str | None = None


@dataclass
class SensitivePattern:
    """敏感信息匹配模式。

    Attributes:
        pattern: 正则表达式。
        name: 模式名称。
        risk: 风险等级。
        scenes: 适用的检查场景。
    """

    pattern: re.Pattern[str]
    name: str
    risk: RiskLevel
    scenes: list[CheckScene] | None = None


_SENSITIVE_PATTERNS: list[SensitivePattern] = [
    SensitivePattern(re.compile(r"\b\d{16,19}\b"), "银行卡号", RiskLevel.HIGH),
    SensitivePattern(re.compile(r"\b\d{6}\d{4}\d{2}\d{2}\d{4}\b"), "身份证号", RiskLevel.HIGH),
    SensitivePattern(re.compile(r"\b\d{4}[/\-]?\d{2}[/\-]?\d{2}\b"), "银行卡有效期", RiskLevel.MEDIUM),
    SensitivePattern(re.compile(r"\bCVV[:\s]*\d{3,4}\b", re.IGNORECASE), "CVV码", RiskLevel.CRITICAL),
    SensitivePattern(re.compile(r"\b\d{17}[\dXx]\b"), "身份证号(18位)", RiskLevel.HIGH),
    SensitivePattern(re.compile(r"(?:password|密码|pwd|passwd)\s*(?:[:=]|是|is|was|are)\s*\S+", re.IGNORECASE), "密码泄露", RiskLevel.CRITICAL),
    SensitivePattern(re.compile(r"(?:secret|密钥|api[_-]?key|access[_-]?token|secret[_-]?key)\s*(?:[:=]|是|is|was|are)\s*['\"]?[a-zA-Z0-9\-]{8,}", re.IGNORECASE), "密钥/Token泄露", RiskLevel.CRITICAL, [CheckScene.OUTPUT, CheckScene.STORAGE]),
    SensitivePattern(re.compile(r"(?:bearer|basic)\s+\S+", re.IGNORECASE), "认证头泄露", RiskLevel.HIGH, [CheckScene.OUTPUT]),
    SensitivePattern(re.compile(r"\b(?:sk-|api_)[a-zA-Z0-9]{20,}"), "API密钥", RiskLevel.CRITICAL),
    SensitivePattern(re.compile(r"\bAKIA[A-Z0-9]{16}\b"), "AWS访问密钥", RiskLevel.CRITICAL),
    SensitivePattern(re.compile(r"\bghp_[a-zA-Z0-9]{36}\b"), "GitHub令牌", RiskLevel.CRITICAL),
    SensitivePattern(re.compile(r"\bgho_[a-zA-Z0-9]{36}\b"), "GitHub OAuth令牌", RiskLevel.CRITICAL),
    SensitivePattern(re.compile(r"\bxox[baprs]-[a-zA-Z0-9]{10,}"), "Slack令牌", RiskLevel.CRITICAL),
    SensitivePattern(re.compile(r"\bsk-[a-zA-Z0-9]{8,}"), "API密钥", RiskLevel.CRITICAL, [CheckScene.STORAGE]),
    SensitivePattern(re.compile(r"\bAKIA[A-Z0-9]{16}\b"), "AWS密钥", RiskLevel.CRITICAL, [CheckScene.STORAGE]),
    SensitivePattern(re.compile(r"\bghp_[a-zA-Z0-9]{36}\b"), "GitHub令牌", RiskLevel.CRITICAL, [CheckScene.STORAGE]),
    SensitivePattern(re.compile(r"(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*['\"]?[a-zA-Z0-9]{8,}", re.IGNORECASE), "密钥凭证", RiskLevel.CRITICAL, [CheckScene.STORAGE]),
    SensitivePattern(re.compile(r"密钥|密码|口令|私钥|secret|credential", re.IGNORECASE), "敏感凭证关键词", RiskLevel.HIGH, [CheckScene.STORAGE]),
    SensitivePattern(re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "手机号码", RiskLevel.MEDIUM),
    SensitivePattern(re.compile(r"\+86[-\s]?1[3-9]\d{9}(?!\d)"), "中国手机号码", RiskLevel.MEDIUM),
    SensitivePattern(re.compile(r"\b0\d{2,3}[-\s]?\d{7,8}\b"), "固话号码", RiskLevel.MEDIUM),
    SensitivePattern(re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), "邮箱地址", RiskLevel.MEDIUM),
    SensitivePattern(re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"), "IPv4地址", RiskLevel.LOW),
    SensitivePattern(re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b"), "IPv6地址", RiskLevel.LOW),
    SensitivePattern(re.compile(r"::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b", re.IGNORECASE), "IPv6地址(压缩)", RiskLevel.LOW),
    SensitivePattern(re.compile(r"\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b"), "MAC地址", RiskLevel.LOW),
    SensitivePattern(re.compile(r"\b[A-Z]\d{8,9}\b"), "护照号", RiskLevel.HIGH),
    SensitivePattern(re.compile(r"(?:病历|处方|诊断)[:：]\S+", re.IGNORECASE), "医疗信息", RiskLevel.HIGH),
]

_DANGEROUS_COMMAND_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\brm\s+-rf\s+/"),
    re.compile(r"\bdel\s+/f\s+/q\s+", re.IGNORECASE),
    re.compile(r"\bdel\s+/f\s+", re.IGNORECASE),
    re.compile(r"\bformat\s+[A-Za-z]:", re.IGNORECASE),
    re.compile(r"\bshutdown\b"),
    re.compile(r"\bdrop\s+table\b", re.IGNORECASE),
    re.compile(r"\bdrop\s+database\b", re.IGNORECASE),
    re.compile(r"\btruncate\b.*\btable\b", re.IGNORECASE),
    re.compile(r"\b--\s*;\s*drop\b", re.IGNORECASE),
]


def check_sensitive_info(
    text: str,
    scene: CheckScene = CheckScene.OUTPUT,
) -> SensitiveCheckResult:
    """检查文本中的敏感信息。

    扫描文本中的敏感信息（密钥、密码、身份证号、手机号等），
    返回风险等级和违规列表。High以上风险文本将自动脱敏。

    Args:
        text: 待检查的文本。
        scene: 检查场景（OUTPUT/STORAGE/COMMAND）。

    Returns:
        SensitiveCheckResult: 包含安全状态、风险等级、违规列表和脱敏文本。
    """
    violations: list[SensitiveViolation] = []

    for sp in _SENSITIVE_PATTERNS:
        if sp.scenes and scene not in sp.scenes:
            continue
        regex = re.compile(sp.pattern.pattern, sp.pattern.flags)
        if regex.search(text):
            violations.append(SensitiveViolation(name=sp.name, risk=sp.risk))

    has_violations = len(violations) > 0
    has_critical = any(v.risk == RiskLevel.CRITICAL for v in violations)
    has_high = any(v.risk == RiskLevel.HIGH for v in violations)

    sanitized_output: str | None = None
    if has_violations:
        sanitized_output = sanitize_text(text)

    if has_critical:
        risk_level = RiskLevel.CRITICAL
    elif has_high:
        risk_level = RiskLevel.HIGH
    elif has_violations:
        risk_level = RiskLevel.MEDIUM
    else:
        risk_level = RiskLevel.NONE

    return SensitiveCheckResult(
        safe=not has_violations,
        risk_level=risk_level,
        violations=violations,
        sanitized_output=sanitized_output,
    )


def check_dangerous_command(command: str) -> DangerousCommandResult:
    for pattern in _DANGEROUS_COMMAND_PATTERNS:
        if pattern.search(command):
            return DangerousCommandResult(
                dangerous=True,
                reason=f"检测到危险命令模式: {command[:50]}",
            )
    return DangerousCommandResult(dangerous=False)


def sanitize_text(text: str) -> str:
    result = text
    result = re.sub(r"(?:sk-|api_)[a-zA-Z0-9]{20,}", "[API密钥-已脱敏]", result, flags=re.IGNORECASE)
    result = re.sub(r"\bAKIA[A-Z0-9]{16}\b", "[AWS密钥-已脱敏]", result)
    result = re.sub(r"\bghp_[a-zA-Z0-9]{36}\b", "[GitHub令牌-已脱敏]", result)
    result = re.sub(r"\bgho_[a-zA-Z0-9]{36}\b", "[GitHub OAuth-已脱敏]", result)
    result = re.sub(r"\bxox[baprs]-[a-zA-Z0-9]{10,}", "[Slack令牌-已脱敏]", result)
    result = re.sub(r"\b\d{16,19}\b", "[银行卡-已脱敏]", result)
    result = re.sub(r"\b\d{6}\d{4}\d{2}\d{2}\d{4}\b", "[身份证-已脱敏]", result)
    result = re.sub(r"\b\d{17}[\dXx]\b", "[身份证-已脱敏]", result)
    result = re.sub(r"(?<!\d)1[3-9]\d{9}(?!\d)", "[手机号-已脱敏]", result)
    result = re.sub(r"\+86[-\s]?1[3-9]\d{9}(?!\d)", "[手机号-已脱敏]", result)
    result = re.sub(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b", "[邮箱-已脱敏]", result)
    result = re.sub(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "[IP-已脱敏]", result)
    result = re.sub(r"\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b", "[IPv6-已脱敏]", result, flags=re.IGNORECASE)
    result = re.sub(r"::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b", "[IPv6-已脱敏]", result, flags=re.IGNORECASE)
    result = re.sub(r"((?:password|密码|pwd|passwd|secret|密钥|api[_-]?key|token)\s*(?:[:=]|是|is|was|are)\s*)\S+", r"\1[已脱敏]", result, flags=re.IGNORECASE)
    result = re.sub(r"(?:bearer|basic)\s+\S+", "[认证头-已脱敏]", result, flags=re.IGNORECASE)
    result = re.sub(r"\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b", "[MAC-已脱敏]", result)
    result = re.sub(r"\b[A-Z]\d{8,9}\b", "[护照号-已脱敏]", result)
    return result
