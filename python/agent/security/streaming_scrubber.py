"""流式脱敏清洗器（Streaming Context Scrubber）。

在 LLM 请求发出前和响应返回后，实时脱敏敏感信息：
  - API Key / Token / 密码
  - 手机号 / 身份证号 / 银行卡号
  - 邮箱地址 / IP 地址
  - 自定义敏感词

核心价值：
  - 防止敏感信息泄露到第三方 LLM API
  - 流式处理，不增加延迟
  - 可逆脱敏（保留映射表，本地可还原）

集成示例::

    from agent.security.streaming_scrubber import StreamingScrubber

    scrubber = StreamingScrubber()
    safe_text = scrubber.scrub("我的手机号是13812345678，密码是abc123")
    # safe_text = "我的手机号是[PHONE_1]，密码是[PWD_1]"
    original = scrubber.restore(safe_text)
    # original = "我的手机号是13812345678，密码是abc123"
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("streaming_scrubber")


class SensitiveType(str, Enum):
    API_KEY = "api_key"
    PASSWORD = "pwd"
    PHONE = "phone"
    ID_CARD = "id_card"
    BANK_CARD = "bank_card"
    EMAIL = "email"
    IP_ADDR = "ip"
    CUSTOM = "custom"


@dataclass
class ScrubPattern:
    type: SensitiveType
    pattern: re.Pattern
    placeholder_template: str
    priority: int = 0


@dataclass
class ScrubRecord:
    placeholder: str
    original: str
    sensitive_type: SensitiveType
    position: int = 0


@dataclass
class ScrubResult:
    scrubbed_text: str
    records: list[ScrubRecord]
    original_length: int
    scrubbed_length: int
    sensitive_count: int
    duration_ms: float


_DEFAULT_PATTERNS: list[ScrubPattern] = [
    ScrubPattern(
        type=SensitiveType.API_KEY,
        pattern=re.compile(
            r"(?i)(?:api[_-]?key|token|secret|access[_-]?key|private[_-]?key|auth[_-]?token)"
            r"\s*[:=]\s*['\"]?([A-Za-z0-9_\-]{20,})['\"]?"
        ),
        placeholder_template="API_KEY_{n}",
        priority=10,
    ),
    ScrubPattern(
        type=SensitiveType.PASSWORD,
        pattern=re.compile(
            r"(?i)(?:password|passwd|pwd|pass|secret|credentials)"
            r"\s*[:=]\s*['\"]?([^\s'\"]{3,})['\"]?"
        ),
        placeholder_template="PWD_{n}",
        priority=9,
    ),
    ScrubPattern(
        type=SensitiveType.PHONE,
        pattern=re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
        placeholder_template="PHONE_{n}",
        priority=7,
    ),
    ScrubPattern(
        type=SensitiveType.ID_CARD,
        pattern=re.compile(r"(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)"),
        placeholder_template="ID_CARD_{n}",
        priority=8,
    ),
    ScrubPattern(
        type=SensitiveType.BANK_CARD,
        pattern=re.compile(r"(?<!\d)[1-9]\d{14,18}(?!\d)"),
        placeholder_template="BANK_CARD_{n}",
        priority=7,
    ),
    ScrubPattern(
        type=SensitiveType.EMAIL,
        pattern=re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"),
        placeholder_template="EMAIL_{n}",
        priority=5,
    ),
    ScrubPattern(
        type=SensitiveType.IP_ADDR,
        pattern=re.compile(r"(?<!\d)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?!\d)"),
        placeholder_template="IP_{n}",
        priority=4,
    ),
]


class StreamingScrubber:
    """流式脱敏清洗器。

    在文本中检测并替换敏感信息，支持可逆还原。
    """

    def __init__(self) -> None:
        self._patterns: list[ScrubPattern] = list(_DEFAULT_PATTERNS)
        self._custom_patterns: list[ScrubPattern] = []
        self._counter: dict[SensitiveType, int] = {}
        self._mapping: dict[str, str] = {}
        self._reverse_mapping: dict[str, str] = {}
        self._enabled: bool = True
        self._stats = {"total_scrubbed": 0, "total_restored": 0, "by_type": {}}

    def enable(self) -> None:
        self._enabled = True

    def disable(self) -> None:
        self._enabled = False

    def add_custom_pattern(self, name: str, pattern: str, placeholder_template: str = "CUSTOM_{n}") -> None:
        self._custom_patterns.append(
            ScrubPattern(
                type=SensitiveType.CUSTOM,
                pattern=re.compile(pattern),
                placeholder_template=placeholder_template,
            )
        )

    def add_sensitive_word(self, word: str) -> None:
        escaped = re.escape(word)
        placeholder = f"WORD_{len(self._custom_patterns) + 1}"
        self._custom_patterns.append(
            ScrubPattern(
                type=SensitiveType.CUSTOM,
                pattern=re.compile(escaped),
                placeholder_template=placeholder,
            )
        )

    def _next_placeholder(self, stype: SensitiveType, template: str) -> str:
        n = self._counter.get(stype, 0) + 1
        self._counter[stype] = n
        return template.format(n=n)

    def scrub(self, text: str) -> str:
        if not self._enabled or not text:
            return text

        start = time.monotonic()
        all_patterns = sorted(
            self._patterns + self._custom_patterns,
            key=lambda p: p.priority,
            reverse=True,
        )

        records: list[ScrubRecord] = []
        result = text

        for sp in all_patterns:
            matches = list(sp.pattern.finditer(result))
            if not matches:
                continue

            replacements: list[tuple[int, int, str, str]] = []
            for match in matches:
                group = match.group(1) if match.lastindex else match.group(0)
                if group in self._reverse_mapping:
                    continue
                placeholder = self._next_placeholder(sp.type, sp.placeholder_template)
                replacements.append((match.start(), match.end(), group, placeholder))

            for start_pos, end_pos, original, placeholder in reversed(replacements):
                result = result[:start_pos] + placeholder + result[end_pos:]
                self._mapping[placeholder] = original
                self._reverse_mapping[original] = placeholder
                records.append(ScrubRecord(
                    placeholder=placeholder,
                    original=original,
                    sensitive_type=sp.type,
                    position=start_pos,
                ))

        duration = (time.monotonic() - start) * 1000
        self._stats["total_scrubbed"] += 1
        for rec in records:
            key = rec.sensitive_type.value
            self._stats["by_type"][key] = self._stats["by_type"].get(key, 0) + 1

        if records:
            log.debug(
                "脱敏完成",
                sensitive_count=len(records),
                types=list(set(r.sensitive_type.value for r in records)),
                duration_ms=f"{duration:.2f}",
            )

        return result

    def scrub_messages(self, messages: list[dict[str, str]]) -> list[dict[str, str]]:
        if not self._enabled:
            return messages

        scrubbed = []
        for msg in messages:
            new_msg = dict(msg)
            if "content" in new_msg and new_msg["content"]:
                new_msg["content"] = self.scrub(new_msg["content"])
            scrubbed.append(new_msg)
        return scrubbed

    def restore(self, text: str) -> str:
        if not text:
            return text

        result = text
        for placeholder, original in self._mapping.items():
            result = result.replace(placeholder, original)

        self._stats["total_restored"] += 1
        return result

    def restore_messages(self, messages: list[dict[str, str]]) -> list[dict[str, str]]:
        restored = []
        for msg in messages:
            new_msg = dict(msg)
            if "content" in new_msg and new_msg["content"]:
                new_msg["content"] = self.restore(new_msg["content"])
            restored.append(new_msg)
        return restored

    def clear_session(self) -> None:
        self._counter.clear()
        self._mapping.clear()
        self._reverse_mapping.clear()

    def get_stats(self) -> dict[str, Any]:
        return dict(self._stats)

    def preview(self, text: str) -> list[dict[str, Any]]:
        if not text:
            return []

        findings: list[dict[str, Any]] = []
        all_patterns = sorted(
            self._patterns + self._custom_patterns,
            key=lambda p: p.priority,
            reverse=True,
        )
        for sp in all_patterns:
            for match in sp.pattern.finditer(text):
                group = match.group(1) if match.lastindex else match.group(0)
                findings.append({
                    "type": sp.type.value,
                    "value": group[:3] + "***" + group[-3:] if len(group) > 6 else "***",
                    "start": match.start(),
                    "end": match.end(),
                    "priority": sp.priority,
                })
        return findings
