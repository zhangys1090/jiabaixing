"""敏感信息脱敏模块——自动识别并替换文本中的敏感数据。

内置常见敏感信息模式（API Key、JWT、邮箱、手机号、IP、信用卡号），
并支持自定义脱敏模式的动态增删。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import ClassVar


@dataclass
class RedactionPattern:
    """脱敏模式定义。

    Attributes:
        name: 模式名称，用于增删和日志标识。
        pattern: 正则表达式。
        replacement: 替换文本，支持 ``re.sub`` 的 ``\\1`` 等反向引用。
    """

    name: str
    pattern: re.Pattern[str]
    replacement: str = "[已脱敏]"


class RedactionEngine:
    """敏感信息脱敏引擎。

    自动识别并替换文本中的敏感信息，包括 API Key、JWT Token、
    邮箱、手机号、IP 地址和信用卡号等。支持动态增删脱敏模式。

    Attributes:
        REDACTION_PATTERNS: 内置脱敏模式列表。

    Usage:
        engine = RedactionEngine()
        safe = engine.redact("我的邮箱是 test@example.com，key=sk-abc123")
        # safe -> "我的邮箱是 [邮箱-已脱敏]，key=[API Key-已脱敏]"
        engine.add_pattern("custom", r"SECRET-\\d+", "[SECRET-已脱敏]")
    """

    REDACTION_PATTERNS: ClassVar[list[RedactionPattern]] = [
        # API Key 模式
        RedactionPattern(
            name="api_key_sk",
            pattern=re.compile(r"\bsk-[a-zA-Z0-9]{8,}"),
            replacement="[API Key-已脱敏]",
        ),
        RedactionPattern(
            name="api_key_prefix",
            pattern=re.compile(r"\bkey-[a-zA-Z0-9]{8,}"),
            replacement="[API Key-已脱敏]",
        ),
        RedactionPattern(
            name="api_key_assignment",
            pattern=re.compile(
                r"(api[_-]?key\s*[:=]\s*)['\"]?[a-zA-Z0-9\-]{8,}",
                re.IGNORECASE,
            ),
            replacement=r"\1[API Key-已脱敏]",
        ),
        # JWT Token
        RedactionPattern(
            name="jwt_token",
            pattern=re.compile(r"\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*"),
            replacement="[JWT-已脱敏]",
        ),
        # 邮箱地址
        RedactionPattern(
            name="email",
            pattern=re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
            replacement="[邮箱-已脱敏]",
        ),
        # 中国手机号
        RedactionPattern(
            name="phone_cn",
            pattern=re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
            replacement="[手机号-已脱敏]",
        ),
        # 国际手机号（+86 前缀）
        RedactionPattern(
            name="phone_intl",
            pattern=re.compile(r"\+86[-\s]?1[3-9]\d{9}"),
            replacement="[手机号-已脱敏]",
        ),
        # 国际手机号（通用 + 前缀）
        RedactionPattern(
            name="phone_global",
            pattern=re.compile(r"\+\d{1,3}[-\s]?\d{6,14}"),
            replacement="[手机号-已脱敏]",
        ),
        # IPv4 地址
        RedactionPattern(
            name="ipv4",
            pattern=re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
            replacement="[IP-已脱敏]",
        ),
        # 信用卡号（13-19 位纯数字，简单匹配）
        RedactionPattern(
            name="credit_card",
            pattern=re.compile(r"\b(?:\d[ -]*?){13,19}\b"),
            replacement="[信用卡-已脱敏]",
        ),
    ]

    def __init__(self) -> None:
        self._patterns: dict[str, RedactionPattern] = {
            p.name: p for p in self.REDACTION_PATTERNS
        }

    def redact(self, text: str) -> str:
        """脱敏文本中的敏感信息。

        按内置模式（及自定义模式）顺序扫描文本，将匹配到的
        敏感信息替换为对应的脱敏占位符。

        Args:
            text: 待脱敏的原始文本。

        Returns:
            str: 脱敏后的安全文本。
        """
        result = text
        for pattern in self._patterns.values():
            result = pattern.pattern.sub(pattern.replacement, result)
        return result

    def add_pattern(self, name: str, pattern: str, replacement: str = "[已脱敏]") -> None:
        """添加自定义脱敏模式。

        如果同名模式已存在，则覆盖原有模式。

        Args:
            name: 模式名称。
            pattern: 正则表达式字符串。
            replacement: 替换文本，支持 ``\\1`` 等反向引用。
        """
        compiled = re.compile(pattern)
        self._patterns[name] = RedactionPattern(
            name=name,
            pattern=compiled,
            replacement=replacement,
        )

    def remove_pattern(self, name: str) -> bool:
        """移除脱敏模式。

        Args:
            name: 模式名称。

        Returns:
            bool: 成功移除返回 ``True``，模式不存在返回 ``False``。
        """
        if name in self._patterns:
            del self._patterns[name]
            return True
        return False

    def is_sensitive(self, text: str) -> bool:
        """检测文本是否包含敏感信息。

        不做替换，仅判断是否有任一脱敏模式命中。

        Args:
            text: 待检测文本。

        Returns:
            bool: 包含敏感信息返回 ``True``，否则返回 ``False``。
        """
        for pattern in self._patterns.values():
            if pattern.pattern.search(text):
                return True
        return False
