"""会话回顾摘要生成器。

进入旧会话时自动生成摘要，避免用户迷失上下文。

提供两个类：
- SessionRecapGenerator: 基于 SessionStore + LLM 的回顾生成器（含缓存）。
- SessionRecap: 基于本地规则的回顾生成器（不依赖 LLM），返回结构化数据。

集成示例::

    # LLM + 缓存方式
    from agent.persistence.session_recap import SessionRecapGenerator
    recap = SessionRecapGenerator(session_store, llm)
    summary = await recap.get_or_generate(session_id)

    # 本地规则方式
    from agent.persistence.session_recap import SessionRecap
    recap = SessionRecap()
    result = await recap.recap(messages, max_points=5)

Attributes:
    MAX_MESSAGES_FOR_RECAP: 用于生成摘要的最大消息数。
    RECAP_TTL_SECONDS: 摘要缓存有效期（秒）。
"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING, Any

from agent.core.logger import StructuredLogger

if TYPE_CHECKING:
    from agent.llm.provider import LLMProvider
    from agent.persistence.session_store import SessionStore, SessionMessage

log = StructuredLogger("session_recap")

# 用于生成摘要的最大消息数
MAX_MESSAGES_FOR_RECAP = 20
# 摘要缓存有效期（秒）：6 小时
RECAP_TTL_SECONDS = 6 * 3600
# 关键决策关键词
_DECISION_KEYWORDS = ("决定", "确定", "选择", "采用", "方案", "确认", "敲定")
# 遗留问题关键词
_OPEN_QUESTION_KEYWORDS = ("待处理", "未完成", "遗留", "TODO", "FIXME", "下一步", "接下来")


class SessionRecapGenerator:
    """会话回顾摘要生成器。

    根据会话历史生成简短摘要，包含：
    1. 对话主题
    2. 关键决策
    3. 遗留问题

    摘要缓存在 SessionStore.metadata["recap"] 中，6 小时内复用。
    """

    def __init__(
        self,
        session_store: "SessionStore",
        llm: "LLMProvider",
    ) -> None:
        """初始化会话回顾生成器。

        Args:
            session_store: 会话存储实例。
            llm: LLM 提供者实例。
        """
        self._store = session_store
        self._llm = llm

    async def generate_recap(self, session_id: str, max_tokens: int = 200) -> str:
        """为指定会话生成回顾摘要。

        Args:
            session_id: 会话 ID。
            max_tokens: 摘要最大 token 数。

        Returns:
            会话回顾摘要文本。
        """
        messages = self._store.get_messages(session_id, limit=MAX_MESSAGES_FOR_RECAP)
        if not messages:
            return "无历史对话"

        # 消息过少时无需生成摘要
        if len(messages) < 4:
            return self._build_short_recap(messages)

        # 关键决策提取
        decisions = self._extract_decisions(messages)
        # 遗留问题提取
        open_questions = self._extract_open_questions(messages)

        # LLM 摘要生成
        prompt = self._build_summary_prompt(messages, decisions, open_questions, max_tokens)
        try:
            result = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            recap = result.get("content", "").strip()
            if not recap:
                recap = self._build_short_recap(messages)
            return recap
        except Exception as e:
            log.warning("Recap generation failed, fallback to short recap", error=str(e))
            return self._build_short_recap(messages)

    async def get_or_generate(self, session_id: str) -> str:
        """获取缓存的摘要或重新生成。

        摘要缓存在 SessionStore.metadata["recap"] 中，有效期 6 小时。
        过期后会自动重新生成。

        Args:
            session_id: 会话 ID。

        Returns:
            会话回顾摘要文本。
        """
        session = self._store.get_session(session_id)
        if not session:
            return "会话不存在"

        # 检查缓存
        cached_recap = session.metadata.get("recap")
        recap_generated_at = session.metadata.get("recap_generated_at", 0.0)
        if cached_recap and (time.time() - recap_generated_at < RECAP_TTL_SECONDS):
            return cached_recap

        # 重新生成
        recap = await self.generate_recap(session_id)
        session.metadata["recap"] = recap
        session.metadata["recap_generated_at"] = time.time()
        # 持久化
        try:
            self._store._save()
        except Exception as e:
            log.warning("Failed to persist recap", error=str(e))
        return recap

    def invalidate(self, session_id: str) -> None:
        """使会话的摘要缓存失效。

        当会话有新消息时调用，强制下次重新生成摘要。

        Args:
            session_id: 会话 ID。
        """
        session = self._store.get_session(session_id)
        if session:
            session.metadata.pop("recap", None)
            session.metadata.pop("recap_generated_at", None)

    @staticmethod
    def _extract_decisions(messages: list["SessionMessage"]) -> list[str]:
        """从消息中提取关键决策。

        Args:
            messages: 会话消息列表。

        Returns:
            决策内容片段列表（最多 3 条）。
        """
        decisions: list[str] = []
        for msg in messages:
            if any(kw in msg.content for kw in _DECISION_KEYWORDS):
                snippet = msg.content[:120].replace("\n", " ").strip()
                if snippet:
                    decisions.append(snippet)
                if len(decisions) >= 3:
                    break
        return decisions

    @staticmethod
    def _extract_open_questions(messages: list["SessionMessage"]) -> list[str]:
        """从消息中提取遗留问题。

        Args:
            messages: 会话消息列表。

        Returns:
            遗留问题片段列表（最多 3 条）。
        """
        questions: list[str] = []
        for msg in messages:
            if any(kw in msg.content for kw in _OPEN_QUESTION_KEYWORDS):
                snippet = msg.content[:120].replace("\n", " ").strip()
                if snippet:
                    questions.append(snippet)
                if len(questions) >= 3:
                    break
        return questions

    @staticmethod
    def _build_summary_prompt(
        messages: list["SessionMessage"],
        decisions: list[str],
        open_questions: list[str],
        max_tokens: int,
    ) -> str:
        """构建摘要生成 prompt。

        Args:
            messages: 会话消息列表。
            decisions: 关键决策列表。
            open_questions: 遗留问题列表。
            max_tokens: 摘要最大 token 数。

        Returns:
            摘要生成 prompt 文本。
        """
        # 取首尾消息构建对话概要
        first_user_msgs = [m.content[:80] for m in messages[:3] if m.role == "user"]
        last_msgs = [m.content[:80] for m in messages[-3:]]

        prompt = f"""请用 2-3 句话总结以下对话的关键内容和遗留问题。

对话开头：
{chr(10).join(first_user_msgs)}

对话结尾：
{chr(10).join(last_msgs)}

关键决策：
{chr(10).join(decisions) if decisions else "无明确决策"}

遗留问题：
{chr(10).join(open_questions) if open_questions else "无明确遗留问题"}

要求：
1. 不超过 {max_tokens} token
2. 突出关键决策和遗留问题
3. 用简洁的中文表达
4. 不要罗列消息，只要核心要点

摘要："""
        return prompt

    @staticmethod
    def _build_short_recap(messages: list["SessionMessage"]) -> str:
        """为短会话构建简单摘要（不调用 LLM）。

        Args:
            messages: 会话消息列表。

        Returns:
            简短摘要文本。
        """
        if not messages:
            return "无历史对话"
        first_user = next((m for m in messages if m.role == "user"), None)
        if first_user:
            snippet = first_user.content[:60].replace("\n", " ").strip()
            return f"讨论主题: {snippet}{'...' if len(first_user.content) > 60 else ''}"
        return f"会话包含 {len(messages)} 条消息"


# ==================== 本地规则会话回顾 ====================

# 关键信息关键词模式
_KEY_INFO_PATTERNS: list[str] = [
    r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?",  # 日期
    r"\d{1,2}:\d{2}",  # 时间
    r"[\u4e00-\u9fa5]{2,4}(说|表示|认为|指出|提出)",  # 人名+动词
]

# 决策关键词
_RECAP_DECISION_KEYWORDS: tuple[str, ...] = (
    "决定", "选择", "确认", "确定", "敲定", "采用", "方案",
    "决议", "同意", "批准", "采纳",
)

# 行动项关键词
_RECAP_ACTION_KEYWORDS: tuple[str, ...] = (
    "需要", "待办", "TODO", "FIXME", "必须", "尽快", "记得",
    "别忘了", "记得要", "下一步", "接下来", "后续", "要完成",
    "待完成", "计划", "安排",
)

# 提问关键词
_RECAP_QUESTION_KEYWORDS: tuple[str, ...] = (
    "？", "?", "吗", "呢", "什么", "怎么", "如何", "为什么",
    "哪", "多少", "几", "是否", "能否", "可以",
)


class SessionRecap:
    """基于本地规则的长对话回顾生成器。

    不依赖 LLM 调用，通过关键词匹配和规则提取生成结构化回顾，
    包含摘要、关键信息点、决策和行动项。

    规则提取逻辑：
        - 关键信息: 用户明确提问、数字/日期/人名。
        - 决策: 包含"决定"、"选择"、"确认"等关键词的消息。
        - 行动项: 包含"需要"、"待办"、"TODO"等关键词的消息。

    Usage:
        recap = SessionRecap()
        result = await recap.recap(messages, max_points=5)
        # result = {summary, key_points, decisions, action_items}
    """

    def __init__(self, max_snippet_length: int = 120) -> None:
        """初始化会话回顾生成器。

        Args:
            max_snippet_length: 提取片段的最大长度（字符数）。
        """
        self._max_snippet_length = max_snippet_length

    async def recap(
        self,
        messages: list[dict[str, Any]],
        max_points: int = 5,
    ) -> dict[str, Any]:
        """生成对话回顾。

        Args:
            messages: 消息列表，每项包含 role 和 content 字段。
            max_points: 最大关键信息点数量。

        Returns:
            结构化回顾字典，包含:
            - summary: 对话摘要文本。
            - key_points: 关键信息点列表。
            - decisions: 决策列表。
            - action_items: 行动项列表。
        """
        if not messages:
            return {
                "summary": "无对话内容",
                "key_points": [],
                "decisions": [],
                "action_items": [],
            }

        key_points = self._extract_key_points(messages)[:max_points]
        decisions = self._extract_decisions(messages)
        action_items = self._extract_action_items(messages)
        summary = self._generate_summary(key_points, len(messages))

        return {
            "summary": summary,
            "key_points": key_points,
            "decisions": decisions,
            "action_items": action_items,
        }

    def _extract_key_points(self, messages: list[dict[str, Any]]) -> list[str]:
        """从消息中提取关键信息点。

        提取规则：
        1. 用户明确提问的消息。
        2. 包含数字/日期/人名的消息。
        3. 用户消息中的核心陈述。

        Args:
            messages: 消息列表。

        Returns:
            关键信息点列表（最多 max_points 条）。
        """
        key_points: list[str] = []

        for msg in messages:
            content = msg.get("content", "")
            role = msg.get("role", "")

            if not content or not content.strip():
                continue

            # 用户提问
            if role == "user" and any(kw in content for kw in _RECAP_QUESTION_KEYWORDS):
                snippet = self._make_snippet(content)
                if snippet:
                    key_points.append(f"提问: {snippet}")
                continue

            # 包含日期/时间/人名
            if any(re.search(pat, content) for pat in _KEY_INFO_PATTERNS):
                snippet = self._make_snippet(content)
                if snippet:
                    key_points.append(f"关键信息: {snippet}")
                continue

        # 补充：取前几条用户消息作为上下文要点
        if len(key_points) < 3:
            for msg in messages:
                if msg.get("role") == "user":
                    content = msg.get("content", "")
                    snippet = self._make_snippet(content)
                    if snippet and not any(snippet in kp for kp in key_points):
                        key_points.append(snippet)
                    if len(key_points) >= 5:
                        break

        return key_points

    def _extract_decisions(self, messages: list[dict[str, Any]]) -> list[str]:
        """从消息中提取决策。

        检测包含"决定"、"选择"、"确认"等关键词的消息片段。

        Args:
            messages: 消息列表。

        Returns:
            决策列表（最多 5 条）。
        """
        decisions: list[str] = []
        for msg in messages:
            content = msg.get("content", "")
            if any(kw in content for kw in _RECAP_DECISION_KEYWORDS):
                snippet = self._make_snippet(content)
                if snippet:
                    decisions.append(snippet)
                if len(decisions) >= 5:
                    break
        return decisions

    def _extract_action_items(self, messages: list[dict[str, Any]]) -> list[str]:
        """从消息中提取行动项。

        检测包含"需要"、"待办"、"TODO"等关键词的消息片段。

        Args:
            messages: 消息列表。

        Returns:
            行动项列表（最多 5 条）。
        """
        action_items: list[str] = []
        for msg in messages:
            content = msg.get("content", "")
            if any(kw in content for kw in _RECAP_ACTION_KEYWORDS):
                snippet = self._make_snippet(content)
                if snippet:
                    action_items.append(snippet)
                if len(action_items) >= 5:
                    break
        return action_items

    def _generate_summary(
        self,
        key_points: list[str],
        total_messages: int,
    ) -> str:
        """根据关键信息点生成摘要。

        Args:
            key_points: 关键信息点列表。
            total_messages: 消息总数。

        Returns:
            摘要文本。
        """
        if not key_points:
            return f"共 {total_messages} 条消息的对话"

        # 取前 2 条关键信息点构建摘要
        points_text = "；".join(key_points[:2])
        if len(key_points) > 2:
            return f"共 {total_messages} 条消息，主要涉及: {points_text}等"
        return f"共 {total_messages} 条消息，主要涉及: {points_text}"

    def _make_snippet(self, content: str) -> str:
        """将消息内容截取为片段。

        Args:
            content: 原始消息内容。

        Returns:
            截取后的片段文本。
        """
        cleaned = content.replace("\n", " ").strip()
        if not cleaned:
            return ""
        if len(cleaned) > self._max_snippet_length:
            return cleaned[:self._max_snippet_length - 1] + "…"
        return cleaned
