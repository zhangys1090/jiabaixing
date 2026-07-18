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
    """清洗结果 — 记录从文本中移除的思考标签信息。

    Attributes:
        cleaned: 清洗后的文本。
        removed_tags: 被移除的标签名称列表。
        removed_char_count: 被移除的字符数。
        original_length: 原始文本长度。
    """

    cleaned: str
    removed_tags: list[str] = field(default_factory=list)
    removed_char_count: int = 0
    original_length: int = 0


class ThinkScrubber:
    """思考过程清洗器 — 从 LLM 输出中移除内部思考标签。

    支持 <think>、<reasoning>、<reflection>、<scratchpad> 四种标签的
    识别和移除。debug_mode 下可选择保留原始内容用于调试。

    Usage:
        scrubber = ThinkScrubber()
        result = scrubber.scrub("<think>推理过程</think>最终答案")
        print(result.cleaned)  # "最终答案"
    """

    def __init__(
        self,
        enabled: bool = True,
        strip_think: bool = True,
        strip_reasoning: bool = True,
        strip_reflection: bool = True,
        strip_scratchpad: bool = True,
        preserve_in_debug: bool = True,
    ) -> None:
        """初始化思考清洗器。

        Args:
            enabled: 是否启用清洗功能。
            strip_think: 是否移除 <think> 标签。
            strip_reasoning: 是否移除 <reasoning> 标签。
            strip_reflection: 是否移除 <reflection> 标签。
            strip_scratchpad: 是否移除 <scratchpad> 标签。
            preserve_in_debug: debug_mode 下是否保留原始内容。
        """
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
        """清洗文本中的思考标签，返回清洗结果。

        Args:
            text: 待清洗的文本。

        Returns:
            ScrubResult: 清洗结果，包含清洗后文本和移除统计。
        """
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
        """清洗单条消息的 content 字段。

        Args:
            message: 消息字典，需包含 "content" 键。

        Returns:
            dict: 清洗后的消息字典（浅拷贝）。
        """
        content = message.get("content", "")
        if not isinstance(content, str) or not content:
            return message
        result = self.scrub(content)
        return {**message, "content": result.cleaned}

    def scrub_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """批量清洗消息列表。

        Args:
            messages: 消息字典列表。

        Returns:
            list[dict]: 清洗后的消息列表。
        """
        return [self.scrub_message(m) for m in messages]

    @staticmethod
    def _strip_tag_pair(
        text: str,
        tag_name: str,
        block_pattern: re.Pattern[str],
        open_only_pattern: re.Pattern[str] | None,
    ) -> tuple[str, list[str]]:
        """移除成对标签及其内容。

        Args:
            text: 待处理文本。
            tag_name: 标签名称（用于记录）。
            block_pattern: 完整标签对的正则模式。
            open_only_pattern: 仅开标签的正则模式（处理未闭合标签）。

        Returns:
            tuple[str, list[str]]: (处理后的文本, 移除的标签名列表)。
        """
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
        """清理多余空白：三个以上连续换行压缩为两个，首尾去空白。

        Args:
            text: 待清理文本。

        Returns:
            str: 清理后的文本。
        """
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = text.strip()
        return text

    def get_stats(self) -> dict[str, Any]:
        """获取清洗器当前配置统计。

        Returns:
            dict: 包含 enabled、debug_mode、各标签开关的状态字典。
        """
        return {
            "enabled": self._enabled,
            "debug_mode": self._debug_mode,
            "strip_think": self._strip_think,
            "strip_reasoning": self._strip_reasoning,
            "strip_reflection": self._strip_reflection,
            "strip_scratchpad": self._strip_scratchpad,
        }
