from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("context_compressor")


@dataclass
class CompressionResult:
    original_tokens: int
    compressed_tokens: int
    ratio: float
    strategy: str
    removed_messages: int = 0
    summary: str = ""
    attention_keywords: list[str] = field(default_factory=list)


class ContextCompressor:
    def __init__(self, max_context_tokens: int = 8000, reserve_ratio: float = 0.3) -> None:
        self._max_tokens = max_context_tokens
        self._reserve_ratio = reserve_ratio

    @staticmethod
    def estimate_tokens(text: str) -> int:
        return max(1, len(text) // 4)

    def estimate_messages_tokens(self, messages: list[dict[str, Any]]) -> int:
        total = 0
        for msg in messages:
            total += self.estimate_tokens(msg.get("content", ""))
            if msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    total += self.estimate_tokens(fn.get("name", ""))
                    total += self.estimate_tokens(fn.get("arguments", ""))
        return total

    def extract_attention_keywords(self, messages: list[dict[str, Any]]) -> list[str]:
        keywords: dict[str, int] = {}
        for msg in messages[-6:]:
            content = msg.get("content", "")
            if not content:
                continue
            try:
                from agent.memory.tokenizer import ChineseTokenizer
                tags = ChineseTokenizer.extract_tags(content, top_k=8)
                for tag in tags:
                    keywords[tag] = keywords.get(tag, 0) + 1
            except Exception:
                words = re.findall(r'[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}', content)
                for w in words:
                    keywords[w] = keywords.get(w, 0) + 1

        sorted_kw = sorted(keywords.items(), key=lambda x: x[1], reverse=True)
        return [kw for kw, _ in sorted_kw[:10]]

    def compress_with_attention(
        self,
        messages: list[dict[str, Any]],
        target_tokens: int | None = None,
        memory_results: list[dict[str, Any]] | None = None,
    ) -> CompressionResult:
        if not messages:
            return CompressionResult(0, 0, 1.0, "empty")

        attention_keywords = self.extract_attention_keywords(messages)

        result = self.compress(messages, target_tokens)

        if memory_results:
            memory_context = self._build_memory_context(memory_results, attention_keywords)
            if memory_context:
                has_system = any(m.get("role") == "system" for m in messages)
                inject_pos = 1 if has_system else 0
                messages_copy = list(messages)
                messages_copy.insert(inject_pos, {
                    "role": "system",
                    "content": memory_context,
                })
                result = self.compress(messages_copy, target_tokens)
                result.strategy = "attention_focused_" + result.strategy

        result.attention_keywords = attention_keywords
        return result

    def _build_memory_context(
        self,
        memory_results: list[dict[str, Any]],
        attention_keywords: list[str],
    ) -> str:
        if not memory_results:
            return ""

        relevant: list[tuple[dict[str, Any], float]] = []
        for mem in memory_results:
            score = mem.get("relevance_score", 0.0)
            content = mem.get("content", "")
            for kw in attention_keywords:
                if kw in content:
                    score += 0.2
            relevant.append((mem, score))

        relevant.sort(key=lambda x: x[1], reverse=True)
        top = [m[0] for m in relevant[:5]]

        if not top:
            return ""

        parts = ["【主动检索的相关记忆】"]
        for i, mem in enumerate(top):
            content = mem.get("content", "")[:200]
            mem_type = mem.get("memory_type", "")
            parts.append(f"{i + 1}. [{mem_type}] {content}")

        return "\n".join(parts)

    def compress(
        self,
        messages: list[dict[str, Any]],
        target_tokens: int | None = None,
    ) -> CompressionResult:
        if not messages:
            return CompressionResult(0, 0, 1.0, "empty")

        original = self.estimate_messages_tokens(messages)
        target = target_tokens or int(self._max_tokens * (1 - self._reserve_ratio))

        if original <= target:
            return CompressionResult(original, original, 1.0, "none_needed")

        strategies = [
            self._strategy_truncate_tool_output,
            self._strategy_remove_old_tool_results,
            self._strategy_summarize_early_history,
            self._strategy_keep_recent_only,
        ]

        current = list(messages)
        current_tokens = original
        applied = "none"

        for strategy_fn in strategies:
            result = strategy_fn(current, target)
            if result:
                current = result
                current_tokens = self.estimate_messages_tokens(current)
                applied = strategy_fn.__name__
                if current_tokens <= target:
                    break

        return CompressionResult(
            original_tokens=original,
            compressed_tokens=current_tokens,
            ratio=current_tokens / original if original > 0 else 1.0,
            strategy=applied,
            removed_messages=len(messages) - len(current),
        )

    def _strategy_truncate_tool_output(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        modified = False
        result = []
        for msg in messages:
            if msg.get("role") == "tool" and len(msg.get("content", "")) > 2000:
                truncated = msg["content"][:1500] + "\n...[输出已截断]"
                result.append({**msg, "content": truncated})
                modified = True
            else:
                result.append(msg)
        return result if modified else None

    def _strategy_remove_old_tool_results(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        tool_indices = [
            i for i, m in enumerate(non_system)
            if m.get("role") == "tool"
        ]

        if not tool_indices:
            return None

        keep = set()
        for idx in tool_indices[-3:]:
            keep.add(idx)
            if idx > 0 and non_system[idx - 1].get("role") == "assistant":
                keep.add(idx - 1)

        filtered = [m for i, m in enumerate(non_system) if i in keep or m.get("role") != "tool"]
        if len(filtered) < len(non_system):
            return system_msgs + filtered
        return None

    def _strategy_summarize_early_history(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        if len(non_system) <= 4:
            return None

        early = non_system[:-4]
        recent = non_system[-4:]

        summary_parts = []
        for msg in early:
            role = msg.get("role", "")
            content = msg.get("content", "")[:200]
            if role in ("user", "assistant") and content:
                summary_parts.append(f"{role}: {content}")

        if not summary_parts:
            return None

        summary = "【历史对话摘要】\n" + "\n".join(summary_parts[:10])
        summary_msg = {"role": "system", "content": summary}

        return system_msgs + [summary_msg] + recent

    def _strategy_keep_recent_only(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        max_non_system = max(4, target // 200)
        if len(non_system) <= max_non_system:
            return None

        return system_msgs + non_system[-max_non_system:]


class ContextWindowManager:
    """上下文窗口管理器——循环级Token预算管理与自动压缩。

    在每轮循环前检查上下文是否超出预算，自动触发压缩策略。
    支持按比例保留系统消息区域，确保关键上下文不被压缩。

    Usage:
        mgr = ContextWindowManager(max_tokens=8000, reserve_ratio=0.3)
        messages = mgr.check_and_compress(messages)
        if mgr.is_over_budget(messages):
            messages = mgr.force_compress(messages)
    """

    def __init__(
        self,
        max_tokens: int = 8_000,
        reserve_ratio: float = 0.3,
        min_free_tokens: int = 500,
        auto_compress: bool = True,
    ) -> None:
        self._compressor = ContextCompressor(
            max_context_tokens=max_tokens,
            reserve_ratio=reserve_ratio,
        )
        self._max_tokens = max_tokens
        self._reserve_ratio = reserve_ratio
        self._min_free_tokens = min_free_tokens
        self._auto_compress = auto_compress
        self._compression_stats: list[CompressionResult] = []

    def is_over_budget(self, messages: list[dict[str, Any]]) -> bool:
        """检查消息列表是否超出Token预算。

        Args:
            messages: 消息列表。

        Returns:
            bool: 是否超出预算。
        """
        total = self._compressor.estimate_messages_tokens(messages)
        budget = self._get_effective_budget()
        return total > budget

    def get_free_tokens(self, messages: list[dict[str, Any]]) -> int:
        """计算剩余可用Token数。

        Args:
            messages: 消息列表。

        Returns:
            int: 剩余Token数（可能为负）。
        """
        total = self._compressor.estimate_messages_tokens(messages)
        budget = self._get_effective_budget()
        return budget - total

    def check_and_compress(
        self,
        messages: list[dict[str, Any]],
        force: bool = False,
    ) -> tuple[list[dict[str, Any]], CompressionResult | None]:
        """检查预算，必要时主动压缩。

        主动触发条件（满足任一即可）：
        - 已超预算 (is_over_budget)
        - 剩余 token 低于 min_free_tokens（提前压缩，避免被动截断）
        - force=True

        Args:
            messages: 消息列表。
            force: 是否强制压缩（忽略auto_compress设置）。

        Returns:
            tuple: (压缩后的消息列表, 压缩结果或None)。
        """
        if not messages:
            return messages, None

        if not self._auto_compress and not force:
            return messages, None

        if self.is_over_budget(messages) or force:
            return self._do_compress(messages)

        # 主动压缩：剩余 token 不足 min_free_tokens 时提前压缩
        free_tokens = self.get_free_tokens(messages)
        if free_tokens < self._min_free_tokens:
            log.info(
                "Proactive compression triggered",
                free_tokens=free_tokens,
                threshold=self._min_free_tokens,
            )
            return self._do_compress(messages)

        return messages, None

    def force_compress(
        self,
        messages: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], CompressionResult]:
        """强制压缩，即使预算未超。

        Args:
            messages: 消息列表。

        Returns:
            tuple: (压缩后的消息列表, 压缩结果)。
        """
        return self._do_compress(messages)

    def _do_compress(
        self, messages: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], CompressionResult]:
        target = self._get_effective_budget()
        result = self._compressor.compress(messages, target_tokens=target)
        self._compression_stats.append(result)
        log.info(
            f"上下文压缩: {result.original_tokens} → {result.compressed_tokens} tokens",
            strategy=result.strategy,
            ratio=f"{result.ratio:.2f}",
        )
        return messages, result

    def _get_effective_budget(self) -> int:
        return int(self._max_tokens * (1 - self._reserve_ratio))

    def get_compression_stats(self) -> list[CompressionResult]:
        """获取压缩统计历史。

        Returns:
            list[CompressionResult]: 压缩结果列表。
        """
        return list(self._compression_stats)

    def get_average_compression_ratio(self) -> float:
        """获取平均压缩率。

        Returns:
            float: 平均压缩率（0-1）。
        """
        if not self._compression_stats:
            return 1.0
        return sum(r.ratio for r in self._compression_stats) / len(self._compression_stats)

    def update_budget(self, max_tokens: int, reserve_ratio: float | None = None) -> None:
        """更新预算参数。

        Args:
            max_tokens: 新的最大Token数。
            reserve_ratio: 新的保留比例，None则不变。
        """
        self._max_tokens = max_tokens
        if reserve_ratio is not None:
            self._reserve_ratio = reserve_ratio
        self._compressor = ContextCompressor(
            max_context_tokens=max_tokens,
            reserve_ratio=self._reserve_ratio,
        )

    def reset_stats(self) -> None:
        """重置压缩统计。"""
        self._compression_stats.clear()
