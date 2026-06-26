"""注意力聚焦适配器。

实时评估信息重要性，动态调整注意力焦点，
主动压缩低价值信息，优化上下文使用效率。

主要功能：
- 信息重要性评估
- 注意力焦点动态调整
- 低价值信息主动压缩
- 关键信息保护机制
- Token使用优化

Usage:
    focus = AttentionFocusAdapter()
    scored = focus.score_messages(messages)
    compressed = focus.compress_messages(messages, max_tokens=2000)
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.context.base import ContextComponent
from agent.context.models import (
    BuildContext,
    ContextBuildRequest,
)

log = StructuredLogger("attention_focus")


@dataclass
class MessageScore:
    """消息重要性评分。"""

    message_index: int
    importance_score: float  # 0.0-1.0
    category: str  # "critical", "important", "normal", "low"
    reason: str
    tokens: int = 0


@dataclass
class AttentionFocusConfig:
    """注意力聚焦配置。"""

    # 关键信息保护阈值（低于此分数的信息才会被压缩）
    critical_threshold: float = 0.8
    important_threshold: float = 0.6
    low_value_threshold: float = 0.3

    # Token压缩目标比例
    compression_target_ratio: float = 0.2  # 目标压缩20%

    # 最大保留的历史消息数
    max_history_messages: int = 50

    # 系统消息始终保留
    preserve_system_messages: bool = True

    # 最近N条消息始终保留
    preserve_recent_messages: int = 10

    # 是否启用主动压缩
    proactive_compression: bool = True


class AttentionFocusAdapter(ContextComponent):
    """注意力聚焦适配器。

    实时评估上下文信息的重要性，动态调整注意力焦点，
    主动压缩低价值信息，在保留关键信息的同时减少Token使用。
    """

    name: str = "attention_focus"
    priority: int = 80  # 较高优先级，在其他组件之后执行

    def __init__(
        self,
        config: AttentionFocusConfig | None = None,
        enabled: bool = True,
    ) -> None:
        """初始化注意力聚焦适配器。

        Args:
            config: 配置。
            enabled: 是否启用。
        """
        super().__init__()
        self._config = config or AttentionFocusConfig()
        self._enabled = enabled

        # 统计
        self._stats = {
            "total_messages_processed": 0,
            "total_tokens_saved": 0,
            "compression_count": 0,
            "critical_info_preserved": 0,
        }

        # 关键词权重（用于重要性评估）
        self._important_keywords = {
            # 高权重关键词
            "error": 0.3,
            "失败": 0.3,
            "错误": 0.3,
            "exception": 0.3,
            "critical": 0.3,
            "重要": 0.25,
            "关键": 0.25,
            "必须": 0.25,
            "注意": 0.2,
            "warning": 0.2,
            "警告": 0.2,
            # 中等权重
            "todo": 0.15,
            "计划": 0.15,
            "目标": 0.15,
            "结果": 0.15,
            "结论": 0.15,
            "总结": 0.15,
            # 低权重
            "好的": 0.05,
            "收到": 0.05,
            "明白": 0.05,
            "ok": 0.05,
        }

        log.info(
            "AttentionFocusAdapter initialized",
            enabled=enabled,
            compression_target=self._config.compression_target_ratio,
        )

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict[str, Any] | None:
        """执行注意力聚焦。

        Args:
            request: 构建请求。
            context: 构建上下文。

        Returns:
            dict[str, Any] | None: 执行输出数据。
        """
        if not self._enabled:
            return None

        try:
            start_time = time.time()

            # 1. 评估消息重要性
            messages = context.messages
            scores = self._score_messages(messages)

            # 2. 检查是否需要压缩
            total_tokens = sum(s.tokens for s in scores)
            target_tokens = int(total_tokens * (1 - self._config.compression_target_ratio))

            if total_tokens > target_tokens and self._config.proactive_compression:
                # 需要压缩
                compressed_messages = self._compress_messages(
                    messages, scores, target_tokens
                )
                context.messages = compressed_messages
                tokens_saved = total_tokens - sum(
                    self._estimate_tokens(m) for m in compressed_messages
                )
                self._stats["total_tokens_saved"] += tokens_saved
                self._stats["compression_count"] += 1
            else:
                tokens_saved = 0

            # 3. 记录统计
            self._stats["total_messages_processed"] += len(messages)

            duration_ms = (time.time() - start_time) * 1000

            log.debug(
                "Attention focus executed",
                messages=len(messages),
                tokens_saved=tokens_saved,
                duration_ms=duration_ms,
            )

            return {
                "messages_processed": len(messages),
                "tokens_saved": tokens_saved,
                "compression_applied": tokens_saved > 0,
                "duration_ms": duration_ms,
            }

        except Exception as e:
            log.error("Attention focus execution failed", error=str(e))
            raise

    def score_messages(self, messages: list[dict[str, Any]]) -> list[MessageScore]:
        """评估消息重要性。

        公开方法，供外部调用。

        Args:
            messages: 消息列表。

        Returns:
            list[MessageScore]: 评分结果列表。
        """
        return self._score_messages(messages)

    def compress_messages(
        self,
        messages: list[dict[str, Any]],
        max_tokens: int,
    ) -> list[dict[str, Any]]:
        """压缩消息到指定Token限制。

        公开方法，供外部调用。

        Args:
            messages: 消息列表。
            max_tokens: 最大Token数。

        Returns:
            list[dict[str, Any]]: 压缩后的消息列表。
        """
        scores = self._score_messages(messages)
        return self._compress_messages(messages, scores, max_tokens)

    def _score_messages(self, messages: list[dict[str, Any]]) -> list[MessageScore]:
        """评估每条消息的重要性。

        Args:
            messages: 消息列表。

        Returns:
            list[MessageScore]: 评分结果列表。
        """
        scores: list[MessageScore] = []
        total_messages = len(messages)

        for i, msg in enumerate(messages):
            score = 0.0
            reasons = []
            content = msg.get("content", "")
            role = msg.get("role", "user")

            # 1. 角色权重
            if role == "system":
                score += 0.4
                reasons.append("系统消息")
            elif role == "assistant":
                score += 0.2
                reasons.append("助手回复")
            elif role == "user":
                score += 0.25
                reasons.append("用户输入")

            # 2. 位置权重（最近的消息更重要）
            recency = i / max(total_messages - 1, 1)
            recency_score = recency * 0.3
            score += recency_score
            if recency > 0.8:
                reasons.append("近期消息")

            # 3. 关键词权重
            keyword_score = self._calculate_keyword_score(content)
            score += keyword_score
            if keyword_score > 0.1:
                reasons.append("含重要关键词")

            # 4. 内容长度权重（适中长度更重要）
            content_length = len(content)
            if content_length > 100:
                length_score = min(content_length / 1000, 0.15)
                score += length_score
                if content_length > 500:
                    reasons.append("内容丰富")

            # 5. 结构化内容加分
            if self._is_structured_content(content):
                score += 0.1
                reasons.append("结构化内容")

            # 归一化到0-1
            score = min(score, 1.0)

            # 分类
            if score >= self._config.critical_threshold:
                category = "critical"
            elif score >= self._config.important_threshold:
                category = "important"
            elif score >= self._config.low_value_threshold:
                category = "normal"
            else:
                category = "low"

            # 估算Token数
            tokens = self._estimate_tokens(content)

            scores.append(MessageScore(
                message_index=i,
                importance_score=score,
                category=category,
                reason=", ".join(reasons) if reasons else "普通消息",
                tokens=tokens,
            ))

        return scores

    def _calculate_keyword_score(self, content: str) -> float:
        """计算关键词得分。

        Args:
            content: 文本内容。

        Returns:
            float: 关键词得分。
        """
        if not content:
            return 0.0

        content_lower = content.lower()
        score = 0.0

        for keyword, weight in self._important_keywords.items():
            if keyword.lower() in content_lower:
                score += weight

        return min(score, 0.4)  # 最多加0.4分

    def _is_structured_content(self, content: str) -> bool:
        """判断是否为结构化内容。

        Args:
            content: 文本内容。

        Returns:
            bool: 是否结构化。
        """
        if not content:
            return False

        # 检查是否包含列表、代码块等结构化元素
        structured_patterns = [
            r'^\s*[-*]\s',  # 列表项
            r'^\s*\d+\.\s',  # 编号列表
            r'```',  # 代码块
            r'^#+\s',  # 标题
            r'\|.*\|',  # 表格
        ]

        for pattern in structured_patterns:
            if re.search(pattern, content, re.MULTILINE):
                return True

        return False

    def _estimate_tokens(self, content: str | dict[str, Any]) -> int:
        """估算Token数。

        Args:
            content: 内容（字符串或消息对象）。

        Returns:
            int: 估算的Token数。
        """
        if isinstance(content, dict):
            content = content.get("content", "")

        if not content:
            return 0

        # 简单估算：中文约1.7字符/token，英文约4字符/token
        # 取平均值，约3字符/token
        return len(str(content)) // 3 + 10

    def _compress_messages(
        self,
        messages: list[dict[str, Any]],
        scores: list[MessageScore],
        target_tokens: int,
    ) -> list[dict[str, Any]]:
        """压缩消息。

        优先保留高重要性消息，压缩或删除低重要性消息。

        Args:
            messages: 消息列表。
            scores: 评分列表。
            target_tokens: 目标Token数。

        Returns:
            list[dict[str, Any]]: 压缩后的消息列表。
        """
        if not messages:
            return []

        total_tokens = sum(s.tokens for s in scores)
        if total_tokens <= target_tokens:
            return messages  # 不需要压缩

        # 创建消息索引到分数的映射
        score_map = {s.message_index: s for s in scores}

        # 确定必须保留的消息
        preserve_indices = set()

        # 1. 系统消息始终保留
        if self._config.preserve_system_messages:
            for i, msg in enumerate(messages):
                if msg.get("role") == "system":
                    preserve_indices.add(i)

        # 2. 最近N条消息保留
        recent_count = self._config.preserve_recent_messages
        for i in range(max(0, len(messages) - recent_count), len(messages)):
            preserve_indices.add(i)

        # 3. 关键信息保留
        for i, score in enumerate(scores):
            if score.category == "critical":
                preserve_indices.add(i)

        # 计算必须保留的Token数
        preserved_tokens = sum(
            score_map[i].tokens for i in preserve_indices if i in score_map
        )

        # 如果必须保留的已经超过目标，返回必须保留的
        if preserved_tokens >= target_tokens:
            result = []
            for i, msg in enumerate(messages):
                if i in preserve_indices:
                    result.append(msg)
            return result

        # 剩余可用Token
        remaining_tokens = target_tokens - preserved_tokens

        # 对非必须保留的消息按重要性排序
        non_preserved = [
            (i, score_map[i])
            for i in range(len(messages))
            if i not in preserve_indices
        ]
        non_preserved.sort(key=lambda x: x[1].importance_score, reverse=True)

        # 按重要性依次添加，直到用完Token预算
        result_indices = set(preserve_indices)
        for i, score in non_preserved:
            if remaining_tokens >= score.tokens:
                result_indices.add(i)
                remaining_tokens -= score.tokens
            else:
                # Token不够，尝试摘要这条消息
                if remaining_tokens > 50:  # 至少保留50token的摘要
                    # 标记为需要摘要
                    result_indices.add(i)
                    # 这里简单处理，实际可以做更复杂的摘要
                    remaining_tokens = 0
                break

        # 按原始顺序重建消息列表
        result = []
        for i, msg in enumerate(messages):
            if i in result_indices:
                # 检查是否需要摘要
                if i not in preserve_indices and score_map[i].category == "low":
                    # 对低价值消息做摘要
                    summarized = self._summarize_message(msg)
                    if summarized:
                        result.append(summarized)
                        continue
                result.append(msg)

        # 统计关键信息保留率
        critical_count = sum(1 for s in scores if s.category == "critical")
        critical_preserved = sum(
            1 for i in result_indices
            if i < len(scores) and scores[i].category == "critical"
        )
        if critical_count > 0:
            self._stats["critical_info_preserved"] += critical_preserved / critical_count

        return result

    def _summarize_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """摘要消息。

        简单实现：只保留前几句。
        实际生产环境可以用LLM做更智能的摘要。

        Args:
            message: 消息对象。

        Returns:
            dict[str, Any] | None: 摘要后的消息。
        """
        content = message.get("content", "")
        if not content:
            return None

        # 简单摘要：取前3句或前200字符
        sentences = re.split(r'[。！？.!?]', content)
        sentences = [s.strip() for s in sentences if s.strip()]

        if len(sentences) <= 2:
            return None  # 太短，不需要摘要

        summary_sentences = sentences[:2]
        summary = "。".join(summary_sentences) + "..."

        if len(summary) >= len(content) * 0.8:
            return None  # 摘要后没短多少，不压缩

        result = dict(message)
        result["content"] = f"[摘要] {summary}"
        return result

    def get_stats(self) -> dict[str, Any]:
        """获取统计信息。

        Returns:
            dict: 统计信息。
        """
        return {
            "total_messages_processed": self._stats["total_messages_processed"],
            "total_tokens_saved": self._stats["total_tokens_saved"],
            "compression_count": self._stats["compression_count"],
            "enabled": self._enabled,
            "compression_target": self._config.compression_target_ratio,
        }

    def can_handle(self, request: ContextBuildRequest) -> bool:
        """检查是否能处理该请求。

        Args:
            request: 构建请求。

        Returns:
            bool: 是否能处理。
        """
        return self._enabled

    def reset_stats(self) -> None:
        """重置统计。"""
        self._stats = {
            "total_messages_processed": 0,
            "total_tokens_saved": 0,
            "compression_count": 0,
            "critical_info_preserved": 0,
        }

    @property
    def enabled(self) -> bool:
        """是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态。"""
        self._enabled = value
        log.info("AttentionFocusAdapter enabled state changed", enabled=value)


AttentionFocusComponent = AttentionFocusAdapter
