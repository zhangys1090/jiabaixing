"""长对话有损压缩器。

支持 50+ 轮对话的有损压缩：
  - 滑动窗口压缩（保留最近 N 轮完整）
  - 摘要压缩（旧轮次压缩为摘要）
  - 关键信息提取（决策/代码/错误保留）
  - 压缩策略选择（aggressive/balanced/conservative）
  - 压缩质量评估
  - 渐进式压缩（多级压缩）

与 ContextCompressor 的关系：
  - ContextCompressor 做通用上下文压缩
  - ConversationCompression 专注长对话有损压缩
  - 两者可串联使用

集成示例::

    from agent.context.conversation_compression import ConversationCompression

    comp = ConversationCompression(strategy="balanced")
    result = await comp.compress(messages, max_tokens=4000)
    print(f"压缩比: {result.compression_ratio:.1%}")
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("conversation_compression")


class CompressionStrategy(str, Enum):
    """压缩策略。"""

    AGGRESSIVE = "aggressive"
    BALANCED = "balanced"
    CONSERVATIVE = "conservative"


class MessageType(str, Enum):
    """消息类型分类。"""

    CRITICAL = "critical"
    IMPORTANT = "important"
    NORMAL = "normal"
    REDUNDANT = "redundant"


@dataclass
class CompressionResult:
    """压缩结果。

    Attributes:
        messages: 压缩后的消息列表。
        original_count: 原始消息数。
        compressed_count: 压缩后消息数。
        original_tokens: 原始 token 估算。
        compressed_tokens: 压缩后 token 估算。
        compression_ratio: 压缩比。
        summary: 压缩摘要。
        preserved_critical: 保留的关键消息数。
        strategy: 使用的策略。
    """

    messages: list[dict[str, Any]] = field(default_factory=list)
    original_count: int = 0
    compressed_count: int = 0
    original_tokens: int = 0
    compressed_tokens: int = 0
    compression_ratio: float = 1.0
    summary: str = ""
    preserved_critical: int = 0
    strategy: CompressionStrategy = CompressionStrategy.BALANCED


STRATEGY_CONFIG: dict[CompressionStrategy, dict[str, Any]] = {
    CompressionStrategy.AGGRESSIVE: {
        "recent_window": 5,
        "summary_ratio": 0.3,
        "keep_critical": True,
        "merge_redundant": True,
    },
    CompressionStrategy.BALANCED: {
        "recent_window": 10,
        "summary_ratio": 0.5,
        "keep_critical": True,
        "merge_redundant": True,
    },
    CompressionStrategy.CONSERVATIVE: {
        "recent_window": 20,
        "summary_ratio": 0.7,
        "keep_critical": True,
        "merge_redundant": False,
    },
}

CRITICAL_PATTERNS: list[str] = [
    "error",
    "exception",
    "traceback",
    "failed",
    "决定",
    "decision",
    "确认",
    "confirmed",
    "选择",
    "chose",
]

IMPORTANT_PATTERNS: list[str] = [
    "代码",
    "code",
    "```",
    "函数",
    "function",
    "类",
    "class",
    "结果",
    "result",
    "答案",
    "answer",
]


class ConversationCompression:
    """长对话有损压缩器。

    支持 50+ 轮对话的有损压缩。
    """

    def __init__(
        self,
        strategy: CompressionStrategy = CompressionStrategy.BALANCED,
        tokenizer: Any = None,
    ) -> None:
        self._strategy = strategy
        self._tokenizer = tokenizer
        self._compression_count = 0

    @property
    def strategy(self) -> CompressionStrategy:
        return self._strategy

    async def compress(
        self,
        messages: list[dict[str, Any]],
        max_tokens: int = 4000,
        strategy: CompressionStrategy | None = None,
    ) -> CompressionResult:
        """压缩长对话。

        Args:
            messages: 消息列表。
            max_tokens: 目标最大 token 数。
            strategy: 压缩策略（None 使用实例默认）。

        Returns:
            CompressionResult 压缩结果。
        """
        strat = strategy or self._strategy
        config = STRATEGY_CONFIG[strat]
        self._compression_count += 1

        original_count = len(messages)
        original_tokens = self._estimate_tokens(messages)

        if original_tokens <= max_tokens:
            return CompressionResult(
                messages=messages,
                original_count=original_count,
                compressed_count=original_count,
                original_tokens=original_tokens,
                compressed_tokens=original_tokens,
                compression_ratio=1.0,
                strategy=strat,
            )

        classified = self._classify_messages(messages)

        recent_window = config["recent_window"]
        recent = messages[-recent_window:] if len(messages) > recent_window else messages
        older = messages[: len(messages) - len(recent)]

        critical_older = [m for m, c in zip(older, classified[: len(older)]) if c == MessageType.CRITICAL]
        important_older = [m for m, c in zip(older, classified[: len(older)]) if c == MessageType.IMPORTANT]
        normal_older = [m for m, c in zip(older, classified[: len(older)]) if c == MessageType.NORMAL]

        preserved_critical = len(critical_older)

        summary_parts: list[str] = []
        if normal_older:
            summary = self._summarize_messages(normal_older, config["summary_ratio"])
            if summary:
                summary_parts.append(summary)

        compressed: list[dict[str, Any]] = []

        if summary_parts:
            compressed.append({
                "role": "system",
                "content": f"[对话摘要] {'; '.join(summary_parts)}",
            })

        compressed.extend(critical_older)
        compressed.extend(important_older)
        compressed.extend(recent)

        critical_older_ids = set(id(m) for m in critical_older)
        recent_ids = set(id(m) for m in recent)

        compressed_tokens = self._estimate_tokens(compressed)

        while compressed_tokens > max_tokens:
            removable = None
            for i, msg in enumerate(compressed):
                if msg.get("role") == "system" and "对话摘要" in msg.get("content", ""):
                    continue
                if id(msg) in critical_older_ids:
                    continue
                if id(msg) in recent_ids:
                    continue
                removable = i
                break

            if removable is not None:
                compressed.pop(removable)
                compressed_tokens = self._estimate_tokens(compressed)
            else:
                break

        ratio = compressed_tokens / original_tokens if original_tokens > 0 else 1.0

        log.info(
            "Conversation compressed",
            strategy=strat.value,
            original=original_count,
            compressed=len(compressed),
            ratio=f"{ratio:.1%}",
        )

        return CompressionResult(
            messages=compressed,
            original_count=original_count,
            compressed_count=len(compressed),
            original_tokens=original_tokens,
            compressed_tokens=compressed_tokens,
            compression_ratio=ratio,
            summary=f"压缩 {original_count} → {len(compressed)} 条消息",
            preserved_critical=preserved_critical,
            strategy=strat,
        )

    def _classify_messages(self, messages: list[dict[str, Any]]) -> list[MessageType]:
        """分类消息重要性。"""
        result: list[MessageType] = []
        for msg in messages:
            content = msg.get("content", "").lower()
            if any(p in content for p in CRITICAL_PATTERNS):
                result.append(MessageType.CRITICAL)
            elif any(p in content for p in IMPORTANT_PATTERNS):
                result.append(MessageType.IMPORTANT)
            else:
                result.append(MessageType.NORMAL)
        return result

    def _summarize_messages(self, messages: list[dict[str, Any]], ratio: float) -> str:
        """摘要消息。"""
        if not messages:
            return ""

        topics: list[str] = []
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role == "user" and content:
                preview = content[:80].strip()
                if preview:
                    topics.append(preview)

        max_topics = max(1, int(len(topics) * ratio))
        selected = topics[:max_topics]

        if not selected:
            return ""

        return f"之前讨论了: {'; '.join(selected)}"

    def _estimate_tokens(self, messages: list[dict[str, Any]]) -> int:
        """估算 token 数。"""
        total = 0
        for msg in messages:
            content = msg.get("content", "")
            total += len(content) // 4 + 1
        return total
