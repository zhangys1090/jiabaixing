"""会话标题自动生成器。

为会话自动生成简短标题，方便用户识别历史对话。

提供两个类：
- SessionTitleGenerator: 基于 SessionStore + LLM 的标题生成器（含缓存）。
- TitleGenerator: 基于本地规则的标题生成器（不依赖 LLM），预留 async 接口。

集成示例::

    # LLM + 缓存方式
    from agent.persistence.title_generator import SessionTitleGenerator
    gen = SessionTitleGenerator(session_store, llm)
    title = await gen.get_or_generate(session_id)

    # 本地规则方式
    from agent.persistence.title_generator import TitleGenerator
    gen = TitleGenerator()
    title = await gen.generate("帮我写个函数", "好的，这是你的函数...")
"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING

from agent.core.logger import StructuredLogger

if TYPE_CHECKING:
    from agent.llm.provider import LLMProvider
    from agent.persistence.session_store import SessionStore

log = StructuredLogger("title_generator")

# 标题最大长度（字符数）
MAX_TITLE_LENGTH = 30
# 标题生成所需的最小消息数
MIN_MESSAGES_FOR_LLM_TITLE = 2
# 标题缓存有效期：永久（标题不会过时）
TITLE_TTL_SECONDS = 7 * 24 * 3600


class SessionTitleGenerator:
    """会话标题自动生成器。

    根据会话首条用户消息自动生成简短标题。
    标题缓存在 SessionStore.metadata["auto_title"] 中，7 天内复用。
    """

    def __init__(
        self,
        session_store: "SessionStore",
        llm: "LLMProvider",
    ) -> None:
        """初始化标题生成器。

        Args:
            session_store: 会话存储实例。
            llm: LLM 提供者实例。
        """
        self._store = session_store
        self._llm = llm

    async def generate_title(self, session_id: str) -> str:
        """为指定会话生成标题。

        Args:
            session_id: 会话 ID。

        Returns:
            会话标题文本（不超过 30 字符）。
        """
        messages = self._store.get_messages(session_id, limit=4)
        if not messages:
            return f"会话 {session_id}"

        # 消息过少时直接取首条用户消息
        if len(messages) < MIN_MESSAGES_FOR_LLM_TITLE:
            return self._extract_short_title(messages[0].content)

        # LLM 标题生成
        prompt = self._build_title_prompt(messages)
        try:
            result = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            title = result.get("content", "").strip()
            # 清理可能的引号和换行
            title = title.strip('"\'`').split("\n")[0].strip()
            if not title:
                title = self._extract_short_title(messages[0].content)
            elif len(title) > MAX_TITLE_LENGTH:
                title = title[:MAX_TITLE_LENGTH - 1] + "…"
            return title
        except Exception as e:
            log.warning("Title generation failed, fallback to short title", error=str(e))
            return self._extract_short_title(messages[0].content)

    async def get_or_generate(self, session_id: str) -> str:
        """获取缓存的标题或重新生成。

        标题缓存在 SessionStore.metadata["auto_title"] 中。
        如果会话已有用户设置的标题（非默认 "会话 xxx"），则保留用户标题。

        Args:
            session_id: 会话 ID。

        Returns:
            会话标题文本。
        """
        session = self._store.get_session(session_id)
        if not session:
            return f"会话 {session_id}"

        # 用户已设置自定义标题则保留
        if session.title and not session.title.startswith("会话 "):
            return session.title

        # 检查缓存
        cached_title = session.metadata.get("auto_title")
        title_generated_at = session.metadata.get("title_generated_at", 0.0)
        if cached_title and (time.time() - title_generated_at < TITLE_TTL_SECONDS):
            return cached_title

        # 重新生成
        title = await self.generate_title(session_id)
        session.metadata["auto_title"] = title
        session.metadata["title_generated_at"] = time.time()
        # 如果会话标题是默认值，则更新为自动生成的标题
        if not session.title or session.title.startswith("会话 "):
            session.title = title
        try:
            self._store._save()
        except Exception as e:
            log.warning("Failed to persist title", error=str(e))
        return title

    def invalidate(self, session_id: str) -> None:
        """使会话的标题缓存失效。

        Args:
            session_id: 会话 ID。
        """
        session = self._store.get_session(session_id)
        if session:
            session.metadata.pop("auto_title", None)
            session.metadata.pop("title_generated_at", None)

    @staticmethod
    def _extract_short_title(content: str) -> str:
        """从用户消息中提取简短标题。

        Args:
            content: 用户消息内容。

        Returns:
            简短标题文本。
        """
        # 去除首尾空白和换行
        text = content.strip().replace("\n", " ")
        if not text:
            return "新会话"
        # 截断到最大长度
        if len(text) > MAX_TITLE_LENGTH:
            return text[:MAX_TITLE_LENGTH - 1] + "…"
        return text

    @staticmethod
    def _build_title_prompt(messages: list) -> str:
        """构建标题生成 prompt。

        Args:
            messages: 会话消息列表。

        Returns:
            标题生成 prompt 文本。
        """
        # 取前几条消息构建上下文
        msgs_text = "\n".join(
            f"{m.role}: {m.content[:100]}" for m in messages[:4]
        )
        prompt = f"""请为以下对话生成一个简短的标题。

对话内容：
{msgs_text}

要求：
1. 不超过 15 个字
2. 概括对话主题
3. 不要使用标点符号
4. 不要使用"会话"、"对话"等前缀
5. 直接输出标题文本，不要加引号

标题："""
        return prompt


# ==================== 本地规则标题生成器 ====================

# 标题生成常量
_TITLE_MAX_LENGTH = 20
_FALLBACK_PREFIX = "对话"

# 意图模式列表：(正则, 提取组索引)
_INTENT_PATTERNS: list[tuple[str, int]] = [
    (r"帮我(.{1,10})", 1),
    (r"请(.{1,10})", 1),
    (r"如何(.{1,10})", 1),
    (r"怎么(.{1,10})", 1),
    (r"为什么(.{1,10})", 1),
    (r"能不能(.{1,10})", 1),
    (r"可以(.{1,10})", 1),
    (r"我想(.{1,10})", 1),
]

# 停用词列表
_STOP_WORDS: frozenset[str] = frozenset({
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
    "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
    "你", "会", "着", "没有", "看", "好", "自己", "这", "他",
    "她", "它", "们", "那", "些", "什么", "吗", "呢", "吧",
    "啊", "哦", "嗯", "呀", "哈", "么", "嘛", "把", "被", "让",
    "给", "对", "从", "向", "为", "以", "用", "而", "但", "或",
    "如果", "虽然", "因为", "所以", "然后", "这个", "那个",
})


class TitleGenerator:
    """基于本地规则的会话标题生成器。

    不依赖 LLM 调用，通过关键词提取、意图检测和内容摘要
    生成会话标题。预留 async 接口以便未来用 LLM 增强。

    标题生成策略：
        1. 如果用户消息 <= 20 字，直接用用户消息。
        2. 提取关键词，拼接为 "关键词1 + 关键词2"。
        3. 如果有明确意图（如 "帮我写..."），提取意图。
        回退: "对话 " + 时间戳。

    Usage:
        gen = TitleGenerator()
        title = await gen.generate("帮我写一个排序算法", "好的，这是快速排序...")
    """

    def __init__(self, max_title_length: int = _TITLE_MAX_LENGTH) -> None:
        """初始化标题生成器。

        Args:
            max_title_length: 标题最大长度（字符数）。
        """
        self._max_title_length = max_title_length

    async def generate(self, user_message: str, assistant_message: str = "") -> str:
        """根据对话内容自动生成标题。

        Args:
            user_message: 用户消息文本。
            assistant_message: 助手消息文本（可选，用于增强语义）。

        Returns:
            生成的标题文本。
        """
        if not user_message or not user_message.strip():
            return self._make_fallback_title()

        text = user_message.strip()

        # 策略1: 短消息直接使用
        if len(text) <= self._max_title_length:
            # 清理标点和多余空白
            cleaned = re.sub(r"[，。！？、；：\s]+", " ", text).strip()
            if cleaned and len(cleaned) <= self._max_title_length:
                return cleaned

        # 策略2: 意图提取
        intent = self._extract_intent(text)
        if intent:
            return self._format_title([], intent)

        # 策略3: 关键词 + 摘要
        keywords = self._extract_keywords(text)
        summary = self._summarize_content(text)
        title = self._format_title(keywords, summary)
        if title:
            return title

        # 回退
        return self._make_fallback_title()

    def _extract_keywords(self, text: str) -> list[str]:
        """从文本中提取关键词。

        使用 jieba 分词（可选）或简单规则提取，
        过滤停用词后返回关键词列表。

        Args:
            text: 待提取的文本。

        Returns:
            关键词列表（最多 4 个）。
        """
        # 尝试 jieba 分词
        try:
            import jieba
            words = [w.strip() for w in jieba.cut(text) if w.strip()]
        except ImportError:
            # 回退：按空白和标点切分
            words = re.split(r"[,\s;|，；、。\n\r\t！？!?]+", text)

        # 过滤停用词和过短的词
        keywords = [
            w for w in words
            if w and len(w) >= 2 and w not in _STOP_WORDS
            and not re.match(r"^[\s\d\W]+$", w)
        ]

        # 去重并保留顺序
        seen: set[str] = set()
        unique_keywords: list[str] = []
        for kw in keywords:
            if kw.lower() not in seen:
                seen.add(kw.lower())
                unique_keywords.append(kw)

        return unique_keywords[:4]

    def _summarize_content(self, text: str, max_length: int = 20) -> str:
        """摘要内容，截取核心部分。

        Args:
            text: 待摘要的文本。
            max_length: 摘要最大长度。

        Returns:
            摘要文本。
        """
        # 去除换行和多余空白
        cleaned = re.sub(r"\s+", " ", text).strip()
        if not cleaned:
            return ""

        # 尝试取第一个完整句子
        first_sentence = re.split(r"[。！？；.!?;]", cleaned)[0].strip()
        if first_sentence and len(first_sentence) <= max_length:
            return first_sentence

        # 截断
        if len(cleaned) > max_length:
            return cleaned[:max_length - 1] + "…"
        return cleaned

    def _format_title(self, keywords: list[str], summary: str = "") -> str:
        """将关键词和摘要格式化为标题。

        Args:
            keywords: 关键词列表。
            summary: 内容摘要（或意图文本）。

        Returns:
            格式化后的标题文本。
        """
        # 如果有摘要（意图）且足够短，优先使用
        if summary:
            formatted = summary.strip()
            if len(formatted) > self._max_title_length:
                formatted = formatted[:self._max_title_length - 1] + "…"
            return formatted

        # 关键词拼接
        if keywords:
            title = " + ".join(keywords[:3])
            if len(title) > self._max_title_length:
                # 尝试只用前两个关键词
                title = " + ".join(keywords[:2])
            if len(title) > self._max_title_length:
                title = keywords[0][:self._max_title_length - 1] + "…"
            return title

        return ""

    @staticmethod
    def _extract_intent(text: str) -> str:
        """从用户消息中提取意图。

        检测常见意图模式（如 "帮我写..."、"如何..."），
        提取意图内容。

        Args:
            text: 用户消息文本。

        Returns:
            提取的意图文本，无匹配时返回空字符串。
        """
        for pattern, group_idx in _INTENT_PATTERNS:
            match = re.search(pattern, text)
            if match:
                intent = match.group(group_idx).strip()
                # 清理尾部标点
                intent = re.sub(r"[，。！？、；：\s]+$", "", intent)
                if intent:
                    return intent
        return ""

    @staticmethod
    def _make_fallback_title() -> str:
        """生成回退标题（对话 + 时间戳）。

        Returns:
            回退标题文本。
        """
        timestamp = time.strftime("%H:%M:%S", time.localtime())
        return f"{_FALLBACK_PREFIX} {timestamp}"
