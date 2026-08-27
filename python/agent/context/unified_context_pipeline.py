"""统一上下文管道（UnifiedContextPipeline）。

对标 TS 侧 src/core/UnifiedContextPipeline.ts。

负责 AI 上下文构建的核心逻辑：
- 场景检测与分类
- 情感分析与强度评估
- 时间上下文构建
- 用户画像构建
- 数据主权评分

与 UnifiedContextOrchestrator 的关系：
- UnifiedContextPipeline：负责上下文数据生成（场景、情感、记忆、画像）
- UnifiedContextOrchestrator：负责组件编排和执行
- UnifiedContextBuilder：统一入口，协调两者
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
import logging
logger = logging.getLogger(__name__)


@dataclass
class EmotionInfo:
    """情感信息。

    Attributes:
        type: 情感类型 (neutral/happy/sad/angry/anxious/curious/frustrated/satisfied)
        intensity: 强度 (0.0 ~ 1.0)
        confidence: 置信度 (0.0 ~ 1.0)
    """

    type: str = "neutral"
    intensity: float = 0.0
    confidence: float = 0.0


@dataclass
class TimeContext:
    """时间上下文。

    Attributes:
        hour: 当前小时 (0-23)
        time_slot: 时段 (morning/afternoon/evening/night)
        day_of_week: 星期几
        is_weekend: 是否周末
        timestamp: Unix 时间戳
    """

    hour: int = 0
    time_slot: str = "morning"
    day_of_week: str = ""
    is_weekend: bool = False
    timestamp: float = 0.0


@dataclass
class UserProfile:
    """用户画像。

    Attributes:
        name: 用户名
        preferences: 偏好列表
        emotional_patterns: 情感模式
        recent_triggers: 最近触发词
        expertise_level: 专业水平
        communication_style: 沟通风格
    """

    name: str = ""
    preferences: list[str] = field(default_factory=list)
    emotional_patterns: list[dict[str, Any]] = field(default_factory=list)
    recent_triggers: list[str] = field(default_factory=list)
    expertise_level: str = "intermediate"
    communication_style: str = "neutral"


@dataclass
class SceneInfo:
    """场景信息。

    Attributes:
        type: 场景类型 (coding/analysis/conversation/search/automation/general)
        confidence: 置信度
        keywords: 检测到的关键词
    """

    type: str = "general"
    confidence: float = 0.0
    keywords: list[str] = field(default_factory=list)


@dataclass
class UnifiedContext:
    """统一上下文数据结构。

    对标 TS 侧 UnifiedContext 接口。

    Attributes:
        scene: 场景信息
        emotion: 情感信息
        time_context: 时间上下文
        memories: 记忆列表
        user_profile: 用户画像
        sovereignty_score: 数据主权评分
    """

    scene: SceneInfo = field(default_factory=SceneInfo)
    emotion: EmotionInfo = field(default_factory=EmotionInfo)
    time_context: TimeContext = field(default_factory=TimeContext)
    memories: list[dict[str, Any]] = field(default_factory=list)
    user_profile: UserProfile = field(default_factory=UserProfile)
    sovereignty_score: float = 1.0


class UnifiedContextPipeline:
    """统一上下文管道。

    对标 TS 侧 UnifiedContextPipeline。

    负责分析用户输入，生成场景、情感、时间、画像等上下文数据。

    Usage:
        pipeline = UnifiedContextPipeline()
        context = await pipeline.build_context(user_input="你好", user_id="user_1")
        logger.info("场景: {context.scene.type}, 情感: {context.emotion.type}")
    """

    _SCENE_KEYWORDS: dict[str, list[str]] = {
        "coding": [
            "代码", "code", "编程", "programming", "函数", "function", "bug", "debug",
            "编译", "compile", "测试", "test", "重构", "refactor", "部署", "deploy",
            "git", "commit", "merge", "review", "写一个", "实现", "修改",
        ],
        "analysis": [
            "分析", "analysis", "报告", "report", "数据", "data", "统计", "statistics",
            "图表", "chart", "趋势", "trend", "对比", "compare", "评估", "evaluate",
            "总结", "summary", "帮我看看", "帮我分析",
        ],
        "conversation": [
            "聊天", "chat", "对话", "conversation", "你好", "hello", "hi", "谢谢",
            "thank", "再见", "bye", "怎么样", "感觉", "情绪", "mood",
        ],
        "search": [
            "搜索", "search", "查找", "find", "找一下", "查询", "query", "检索",
            "浏览", "browse", "在哪", "where", "什么是", "what is",
        ],
        "automation": [
            "自动", "automation", "定时", "schedule", "计划", "plan", "提醒", "remind",
            "执行", "execute", "运行", "run", "启动", "start", "停止", "stop",
        ],
    }

    _EMOTION_KEYWORDS: dict[str, list[str]] = {
        "happy": ["开心", "高兴", "happy", "棒", "great", "好", "nice", "太好了", "喜欢"],
        "sad": ["难过", "伤心", "sad", "失望", "disappointed", "遗憾", "可惜"],
        "angry": ["生气", "愤怒", "angry", "恼火", "烦", "annoying", "讨厌"],
        "anxious": ["焦虑", "担心", "anxious", "紧张", "nervous", "害怕", "afraid", "不确定"],
        "curious": ["好奇", "curious", "想知道", "wonder", "什么", "为什么", "how", "怎么"],
        "frustrated": ["沮丧", "frustrated", "不行", "不能", "can't", "失败", "fail", "又错了"],
        "satisfied": ["满意", "满足", "satisfied", "完成", "done", "搞定", "解决了"],
    }

    def __init__(self) -> None:
        self._memory_engine: Any = None
        self._sovereignty_pipeline: Any = None

    def set_memory_engine(self, engine: Any) -> None:
        """设置记忆引擎。

        Args:
            engine: 记忆引擎实例。
        """
        self._memory_engine = engine

    def set_sovereignty_pipeline(self, pipeline: Any) -> None:
        """设置数据主权管道。

        Args:
            pipeline: 数据主权管道实例。
        """
        self._sovereignty_pipeline = pipeline

    async def build_context(
        self,
        user_input: str,
        user_id: str = "",
    ) -> UnifiedContext:
        """构建统一上下文。

        Args:
            user_input: 用户输入文本。
            user_id: 用户ID。

        Returns:
            UnifiedContext: 统一上下文。
        """
        scene = self.detect_scene(user_input)
        emotion = self.detect_emotion(user_input)
        time_context = self.build_time_context()
        memories = await self.retrieve_memories(user_input, scene.type, emotion.type)
        user_profile = self.build_user_profile(user_id)
        sovereignty_score = self.get_sovereignty_score()

        return UnifiedContext(
            scene=scene,
            emotion=emotion,
            time_context=time_context,
            memories=memories,
            user_profile=user_profile,
            sovereignty_score=sovereignty_score,
        )

    def build_context_sync(self, user_input: str, user_id: str = "") -> UnifiedContext:
        """同步构建统一上下文。"""
        scene = self.detect_scene(user_input)
        emotion = self.detect_emotion(user_input)
        time_context = self.build_time_context()
        memories = self.retrieve_memories_sync(user_input, scene.type, emotion.type)
        user_profile = self.build_user_profile(user_id)
        sovereignty_score = self.get_sovereignty_score()

        return UnifiedContext(
            scene=scene,
            emotion=emotion,
            time_context=time_context,
            memories=memories,
            user_profile=user_profile,
            sovereignty_score=sovereignty_score,
        )

    def detect_scene(self, user_input: str) -> SceneInfo:
        """检测场景类型。

        基于关键词匹配检测用户输入的场景类型。

        Args:
            user_input: 用户输入文本。

        Returns:
            SceneInfo: 场景信息。
        """
        input_lower = user_input.lower()
        scores: dict[str, float] = {}
        all_keywords: list[str] = []

        for scene_type, keywords in self._SCENE_KEYWORDS.items():
            matched = 0
            matched_words: list[str] = []
            for kw in keywords:
                if kw.lower() in input_lower:
                    matched += 1
                    matched_words.append(kw)

            if matched > 0:
                scores[scene_type] = matched / len(keywords)
                all_keywords.extend(matched_words)

        if not scores:
            return SceneInfo(type="general", confidence=0.3, keywords=[])

        best_scene = max(scores, key=lambda k: scores[k])
        confidence = min(scores[best_scene] * 3.0, 1.0)

        return SceneInfo(
            type=best_scene,
            confidence=confidence,
            keywords=list(set(all_keywords)),
        )

    def detect_emotion(self, user_input: str) -> EmotionInfo:
        """检测情感。

        基于关键词匹配检测用户输入的情感倾向。

        Args:
            user_input: 用户输入文本。

        Returns:
            EmotionInfo: 情感信息。
        """
        input_lower = user_input.lower()
        scores: dict[str, float] = {}

        for emotion_type, keywords in self._EMOTION_KEYWORDS.items():
            matched = 0
            for kw in keywords:
                if kw.lower() in input_lower:
                    matched += 1

            if matched > 0:
                scores[emotion_type] = matched / len(keywords)

        if not scores:
            return EmotionInfo(type="neutral", intensity=0.1, confidence=0.5)

        best_emotion = max(scores, key=lambda k: scores[k])
        intensity = min(scores[best_emotion] * 2.0, 1.0)
        confidence = min(scores[best_emotion] * 2.0, 1.0)

        return EmotionInfo(
            type=best_emotion,
            intensity=intensity,
            confidence=confidence,
        )

    def build_time_context(self) -> TimeContext:
        """构建时间上下文。

        Returns:
            TimeContext: 时间上下文。
        """
        now = datetime.now()
        hour = now.hour
        day_of_week = now.strftime("%A")

        if 5 <= hour < 12:
            time_slot = "morning"
        elif 12 <= hour < 14:
            time_slot = "noon"
        elif 14 <= hour < 18:
            time_slot = "afternoon"
        elif 18 <= hour < 22:
            time_slot = "evening"
        else:
            time_slot = "night"

        is_weekend = now.weekday() >= 5

        return TimeContext(
            hour=hour,
            time_slot=time_slot,
            day_of_week=day_of_week,
            is_weekend=is_weekend,
            timestamp=time.time(),
        )

    async def retrieve_memories(
        self,
        user_input: str,
        scene: str,
        emotion: str,
    ) -> list[dict[str, Any]]:
        """检索相关记忆。

        Args:
            user_input: 用户输入。
            scene: 场景类型。
            emotion: 情感类型。

        Returns:
            记忆列表。
        """
        if self._memory_engine is None:
            return []

        try:
            return await self._memory_engine.search(
                user_input,
                limit=8,
                scene=scene,
            )
        except Exception as e:
            logger.warning("unified_context_pipeline.retrieve_memories 记忆检索失败", error=str(e))
            return []

    def retrieve_memories_sync(
        self,
        user_input: str,
        scene: str,
        emotion: str,
    ) -> list[dict[str, Any]]:
        """同步检索相关记忆。"""
        return []

    def build_user_profile(self, user_id: str) -> UserProfile:
        """构建用户画像。

        Args:
            user_id: 用户ID。

        Returns:
            UserProfile: 用户画像。
        """
        return UserProfile(
            name=user_id,
            preferences=[],
            emotional_patterns=[],
            recent_triggers=[],
            expertise_level="intermediate",
            communication_style="neutral",
        )

    def get_sovereignty_score(self) -> float:
        """获取数据主权评分。

        Returns:
            float: 主权评分 (0.0 ~ 1.0)。
        """
        if self._sovereignty_pipeline is None:
            return 1.0

        try:
            return self._sovereignty_pipeline.get_score()
        except Exception as e:
            logger.warning("unified_context_pipeline.get_sovereignty_score 主权评分获取失败", error=str(e))
            return 1.0