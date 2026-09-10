"""记忆整理服务 (Memory Consolidation)。

自动将长对话历史压缩为摘要，节省上下文窗口。
支持三种策略：SUMMARIZE（摘要）、TRUNCATE（截断）、HYBRID（分层摘要+最近原文）。

Usage:
    consolidator = MemoryConsolidator(llm=provider)
    compressed = await consolidator.consolidate(messages, max_tokens=8000)
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol
import logging
logger = logging.getLogger(__name__)


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


class ConsolidationStrategy(str, Enum):
    SUMMARIZE = "summarize"
    TRUNCATE = "truncate"
    HYBRID = "hybrid"


@dataclass
class ConsolidationConfig:
    strategy: ConsolidationStrategy = ConsolidationStrategy.HYBRID
    max_input_tokens: int = 8000
    recent_keep_count: int = 10
    summary_max_tokens: int = 500
    trigger_ratio: float = 0.85
    min_messages_to_consolidate: int = 20
    enabled: bool = True


@dataclass
class ConsolidationResult:
    messages: list[dict[str, str]]
    summary: str = ""
    original_count: int = 0
    compressed_count: int = 0
    compression_ratio: float = 0.0
    duration_ms: float = 0.0


class MemoryConsolidator:
    def __init__(
        self,
        llm: LLMProtocol | None = None,
        config: ConsolidationConfig | None = None,
    ) -> None:
        self._llm = llm
        self._config = config or ConsolidationConfig()
        self._last_summary = ""
        self._consolidation_count = 0

    async def consolidate(
        self,
        messages: list[dict[str, str]],
        system_prompt: str = "",
        token_counter: Any = None,
    ) -> ConsolidationResult:
        if not self._config.enabled:
            return ConsolidationResult(
                messages=messages, original_count=len(messages),
                compressed_count=len(messages), compression_ratio=1.0,
            )
        start = time.time()
        if len(messages) < self._config.min_messages_to_consolidate:
            return ConsolidationResult(
                messages=messages, original_count=len(messages),
                compressed_count=len(messages), compression_ratio=1.0,
            )
        estimated_tokens = self._estimate_tokens(messages, token_counter)
        if estimated_tokens < self._config.max_input_tokens * self._config.trigger_ratio:
            return ConsolidationResult(
                messages=messages, original_count=len(messages),
                compressed_count=len(messages), compression_ratio=1.0,
            )

        if self._config.strategy == ConsolidationStrategy.TRUNCATE:
            result = self._truncate(messages)
        elif self._config.strategy == ConsolidationStrategy.SUMMARIZE:
            result = await self._summarize(messages, system_prompt)
        else:
            result = await self._hybrid(messages, system_prompt)

        self._consolidation_count += 1
        result.duration_ms = (time.time() - start) * 1000
        return result

    def _truncate(self, messages: list[dict[str, str]]) -> ConsolidationResult:
        recent = messages[-self._config.recent_keep_count:]
        return ConsolidationResult(
            messages=recent, original_count=len(messages),
            compressed_count=len(recent),
            compression_ratio=len(recent) / max(len(messages), 1),
        )

    async def _summarize(
        self, messages: list[dict[str, str]], system_prompt: str = "",
    ) -> ConsolidationResult:
        if not self._llm:
            return self._truncate(messages)
        conversation_text = "\n".join(
            f"{m['role']}: {str(m.get('content', ''))[:200]}"
            for m in messages if m.get("role") not in ("system",)
        )
        summary_prompt = (
            f"请将以下对话历史压缩为一段简洁的摘要（不超过{self._config.summary_max_tokens}词），"
            f"保留关键信息：\n\n"
            f"系统提示: {system_prompt[:200] if system_prompt else '无'}\n\n"
            f"对话历史:\n{conversation_text[:3000]}\n\n摘要:"
        )
        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": summary_prompt}],
                use_cache=False,
            )
            summary = str(resp.get("content", ""))
        except Exception as e:
            logger.warning("consolidation.summarize 摘要生成失败", error=str(e))
            summary = f"[对话摘要: {len(messages)} 条消息]"
        self._last_summary = summary
        compressed = [{"role": "system", "content": f"对话历史摘要: {summary}"}]
        return ConsolidationResult(
            messages=compressed, summary=summary,
            original_count=len(messages), compressed_count=len(compressed),
            compression_ratio=len(compressed) / max(len(messages), 1),
        )

    async def _hybrid(
        self, messages: list[dict[str, str]], system_prompt: str = "",
    ) -> ConsolidationResult:
        if len(messages) <= self._config.recent_keep_count:
            return ConsolidationResult(
                messages=messages, original_count=len(messages),
                compressed_count=len(messages), compression_ratio=1.0,
            )
        old_messages = messages[:-self._config.recent_keep_count]
        recent_messages = messages[-self._config.recent_keep_count:]
        if not self._llm:
            summary = f"[早期对话: {len(old_messages)} 条消息]"
        else:
            conversation_text = "\n".join(
                f"{m['role']}: {str(m.get('content', ''))[:200]}"
                for m in old_messages if m.get("role") not in ("system",)
            )
            summary_prompt = (
                f"请将以下早期对话历史压缩为一段简洁的摘要:\n\n"
                f"早期对话:\n{conversation_text[:3000]}\n\n摘要:"
            )
            try:
                resp = await self._llm.chat(
                    messages=[{"role": "user", "content": summary_prompt}],
                    use_cache=False,
                )
                summary = str(resp.get("content", ""))
            except Exception as e:
                logger.warning("consolidation.consolidate 早期对话摘要失败", error=str(e))
                summary = f"[早期对话: {len(old_messages)} 条消息]"
        self._last_summary = summary
        compressed = [
            {"role": "system", "content": f"早期对话摘要: {summary}"},
            *recent_messages,
        ]
        return ConsolidationResult(
            messages=compressed, summary=summary,
            original_count=len(messages), compressed_count=len(compressed),
            compression_ratio=len(compressed) / max(len(messages), 1),
        )

    def _estimate_tokens(
        self, messages: list[dict[str, str]], token_counter: Any = None,
    ) -> int:
        if token_counter is not None and hasattr(token_counter, "count_tokens"):
            total = 0
            for m in messages:
                total += token_counter.count_tokens(m.get("content", ""))
            return total
        return sum(len(m.get("content", "")) // 3 for m in messages)

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "consolidation_count": self._consolidation_count,
            "strategy": self._config.strategy.value,
            "last_summary_length": len(self._last_summary),
        }
