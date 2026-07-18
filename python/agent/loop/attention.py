from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MessageScore:
    """带注意力分数的消息。"""
    message: dict[str, str]
    score: float
    position: int  # 在消息列表中的原始位置
    is_system: bool
    content_length: int


class AttentionFocusManager:
    """注意力聚焦管理器。

    解决上下文管理中的"重要信息被稀释"问题。

    对上下文消息按以下维度打分:
    1. 系统指令/计划 (权重最高) — 保持不丢失
    2. 失败信息 (高分) — 避免重复犯同样错误
    3. 反思结论 (高分) — 指导后续执行方向
    4. 近期消息 (中高分) — 时间衰减
    5. 较长消息 (中分) — 信息密度更高

    保留 Top-K 条消息，确保高注意力消息不被踢出。
    """

    def __init__(self, max_messages: int = 15, max_total_tokens: int = 4000) -> None:
        self.max_messages = max_messages
        self.max_total_tokens = max_total_tokens
        self._system_patterns = [
            re.compile(r"【执行计划】|【反思结论】|【经验提示】|【因果影响分析】|【经验迁移】", re.UNICODE),
        ]
        self._failure_patterns = [
            re.compile(r"失败|错误|error|fail|exception|未找到|不存在|权限拒绝", re.UNICODE | re.IGNORECASE),
        ]
        self._reflection_patterns = [
            re.compile(r"根因|修正|策略|建议|反思|root.*cause|corrected|fix.*strategy", re.UNICODE | re.IGNORECASE),
        ]

    def score_message(self, message: dict[str, str], position: int, all_messages: list[dict[str, str]]) -> float:
        """单条消息打分。"""
        role = message.get("role", "user")
        content = message.get("content", "")
        content_lower = content.lower()
        length = len(content)

        score = 0.0

        # 系统指令/计划 — 最高优先级
        for pattern in self._system_patterns:
            if pattern.search(content):
                score += 5.0
                break

        # 失败信息 — 高优先级，避免忘记错误
        for pattern in self._failure_patterns:
            if pattern.search(content):
                score += 3.0
                break

        # 反思结论 — 高优先级
        for pattern in self._reflection_patterns:
            if pattern.search(content):
                score += 3.5
                break

        # 角色权重
        if role == "system":
            score += 2.0
        elif role == "assistant":
            score += 0.5

        # 信息密度 — 越长越可能有高价值信息
        if length > 500:
            score += 1.0
        elif length > 200:
            score += 0.5

        # 时间衰减 — 位置越靠后（越新），分数越高
        total = len(all_messages)
        recency = position / max(total, 1)
        score += recency * 2.0

        # 归一化到 [0, 10]
        return min(10.0, max(0.0, score))

    def focus(self, messages: list[dict[str, str]], max_messages: int | None = None, max_tokens: int | None = None) -> list[dict[str, str]]:
        """从完整消息列表中聚焦出高注意力消息子集。

        Args:
            messages: 原始消息列表。
            max_messages: 最大保留消息数（覆盖默认值）。
            max_tokens: 最大Token数（覆盖默认值）。

        Returns:
            聚焦后的消息列表（保持相对顺序）。
        """
        if not messages:
            return []

        mm = max_messages or self.max_messages
        mt = max_tokens or self.max_total_tokens

        # 打分
        scored: list[MessageScore] = []
        total_tokens = 0
        for i, msg in enumerate(messages):
            content = msg.get("content", "")
            total_tokens += len(content)
            score = self.score_message(msg, i, messages)
            scored.append(MessageScore(
                message=msg,
                score=score,
                position=i,
                is_system=msg.get("role") == "system",
                content_length=len(content),
            ))

        # 策略: 先保留所有高分消息，剩余给低分消息留配额
        scored.sort(key=lambda x: x.score, reverse=True)

        # 保留所有系统指令和计划（不管分数）
        essential = [s for s in scored if s.is_system and s.score >= 5.0]
        non_essential = [s for s in scored if not (s.is_system and s.score >= 5.0)]

        # 从非essential中按分数取Top-K
        result: list[MessageScore] = list(essential)
        remaining = mm - len(result)

        if remaining > 0:
            result.extend(non_essential[:remaining])

        # 按原始位置排序，保持时间线连续性
        result.sort(key=lambda x: x.position)

        # 再次截断 — 检查token限制
        final_messages: list[dict[str, str]] = []
        token_count = 0
        for s in result:
            content_len = s.content_length
            if token_count + content_len > mt:
                # 截断最新消息的内容以适应token限制
                if final_messages:
                    last = final_messages[-1]
                    available = mt - token_count
                    if available > 0 and len(last["content"]) > available:
                        last["content"] = last["content"][:available] + " ...(truncated)"
                        final_messages[-1] = last
                break
            final_messages.append(s.message)
            token_count += content_len

        return final_messages

    def apply_to_context(self, context: Any, max_messages: int | None = None, max_tokens: int | None = None) -> None:
        """直接将聚焦结果注入上下文。

        Args:
            context: 包含 messages 属性的 LoopContext 或类似对象。
            max_messages: 最大消息数。
            max_tokens: 最大Token数。
        """
        messages = getattr(context, "messages", [])
        if not messages:
            return

        focused = self.focus(messages, max_messages, max_tokens)
        context.messages = focused  # type: ignore[attr-defined]
