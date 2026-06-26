from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


_THINK_OPEN = re.compile(r"<think>", re.IGNORECASE)
_THINK_CLOSE = re.compile(r"</think>", re.IGNORECASE)
_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_THINK_OPEN_ONLY = re.compile(r"<think>.*", re.DOTALL | re.IGNORECASE)

_REASONING_OPEN = re.compile(r"<reasoning>", re.IGNORECASE)
_REASONING_CLOSE = re.compile(r"</reasoning>", re.IGNORECASE)
_REASONING_BLOCK = re.compile(r"<reasoning>.*?</reasoning>", re.DOTALL | re.IGNORECASE)

_REFLECTION_OPEN = re.compile(r"<reflection>", re.IGNORECASE)
_REFLECTION_CLOSE = re.compile(r"</reflection>", re.IGNORECASE)
_REFLECTION_BLOCK = re.compile(r"<reflection>.*?</reflection>", re.DOTALL | re.IGNORECASE)

_SCRATCHPAD_OPEN = re.compile(r"<scratchpad>", re.IGNORECASE)
_SCRATCHPAD_CLOSE = re.compile(r"</scratchpad>", re.IGNORECASE)
_SCRATCHPAD_BLOCK = re.compile(r"<scratchpad>.*?</scratchpad>", re.DOTALL | re.IGNORECASE)


@dataclass
class ScrubResult:
    cleaned: str
    removed_tags: list[str] = field(default_factory=list)
    removed_char_count: int = 0
    original_length: int = 0


class ThinkScrubber:
    def __init__(
        self,
        enabled: bool = True,
        strip_think: bool = True,
        strip_reasoning: bool = True,
        strip_reflection: bool = True,
        strip_scratchpad: bool = True,
        preserve_in_debug: bool = True,
    ) -> None:
        self._enabled = enabled
        self._strip_think = strip_think
        self._strip_reasoning = strip_reasoning
        self._strip_reflection = strip_reflection
        self._strip_scratchpad = strip_scratchpad
        self._preserve_in_debug = preserve_in_debug
        self._debug_mode = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    @property
    def debug_mode(self) -> bool:
        return self._debug_mode

    @debug_mode.setter
    def debug_mode(self, value: bool) -> None:
        self._debug_mode = value

    def scrub(self, text: str) -> ScrubResult:
        if not self._enabled or not text:
            return ScrubResult(
                cleaned=text,
                removed_tags=[],
                removed_char_count=0,
                original_length=len(text),
            )

        if self._debug_mode and self._preserve_in_debug:
            return ScrubResult(
                cleaned=text,
                removed_tags=[],
                removed_char_count=0,
                original_length=len(text),
            )

        original_length = len(text)
        cleaned = text
        removed_tags: list[str] = []

        if self._strip_think:
            cleaned, tags = self._strip_tag_pair(cleaned, "think", _THINK_BLOCK, _THINK_OPEN_ONLY)
            removed_tags.extend(tags)

        if self._strip_reasoning:
            cleaned, tags = self._strip_tag_pair(cleaned, "reasoning", _REASONING_BLOCK, None)
            removed_tags.extend(tags)

        if self._strip_reflection:
            cleaned, tags = self._strip_tag_pair(cleaned, "reflection", _REFLECTION_BLOCK, None)
            removed_tags.extend(tags)

        if self._strip_scratchpad:
            cleaned, tags = self._strip_tag_pair(cleaned, "scratchpad", _SCRATCHPAD_BLOCK, None)
            removed_tags.extend(tags)

        cleaned = self._clean_whitespace(cleaned)

        return ScrubResult(
            cleaned=cleaned,
            removed_tags=removed_tags,
            removed_char_count=original_length - len(cleaned),
            original_length=original_length,
        )

    def scrub_message(self, message: dict[str, Any]) -> dict[str, Any]:
        content = message.get("content", "")
        if not isinstance(content, str) or not content:
            return message
        result = self.scrub(content)
        return {**message, "content": result.cleaned}

    def scrub_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [self.scrub_message(m) for m in messages]

    @staticmethod
    def _strip_tag_pair(
        text: str,
        tag_name: str,
        block_pattern: re.Pattern[str],
        open_only_pattern: re.Pattern[str] | None,
    ) -> tuple[str, list[str]]:
        removed: list[str] = []
        new_text, count = block_pattern.subn("", text)
        if count > 0:
            removed.extend([tag_name] * count)

        if open_only_pattern and new_text != text:
            pass
        elif open_only_pattern:
            new_text2, count2 = open_only_pattern.subn("", new_text)
            if count2 > 0:
                removed.extend([f"{tag_name}_open"] * count2)
                new_text = new_text2

        return new_text, removed

    @staticmethod
    def _clean_whitespace(text: str) -> str:
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = text.strip()
        return text

    def get_stats(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "debug_mode": self._debug_mode,
            "strip_think": self._strip_think,
            "strip_reasoning": self._strip_reasoning,
            "strip_reflection": self._strip_reflection,
            "strip_scratchpad": self._strip_scratchpad,
        }
