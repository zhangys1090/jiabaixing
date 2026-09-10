"""
隐式反馈收集器

【功能】
从用户行为中提取隐式反馈信号，解决学习信号稀疏问题

【设计原则】
- 静默收集：后台运行，不打扰用户
- 隐私安全：只统计行为模式，不存储敏感内容
- 轻量级：不影响主循环性能
- 可配置：可开关和调整敏感度

【反馈信号类型】
✅ 正向信号：
- 用户复制了 AI 输出
- 用户表示满意/认可
- 用户采纳建议并执行
- 用户连续使用同一功能
- 用户停留时间长且无修改

⚠️ 负向信号：
- 用户修改了 AI 输出
- 用户重试同一问题
- 用户连续追问（表示没理解或不满意）
- 用户快速切换话题
- 用户删除了 AI 生成的内容

🤔 中性信号：
- 用户长时间不回复
- 用户切换话题
- 用户只看不互动

【应用场景】
- 为进化引擎提供轻量级学习信号
- 分析用户行为模式，优化交互体验
- 识别高价值交互，重点学习

@module implicit_feedback
@version 0.1.0
@status Beta - 功能基本完成，测试中
@since 2026-06-24
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("implicit_feedback")


# ========== 常量定义 ==========

# 最大历史记录数
MAX_HISTORY_SIZE = 1000

# 追问检测的时间窗口（秒）
FOLLOW_UP_TIME_WINDOW_SEC = 5 * 60  # 5 分钟

# 连续追问阈值 - 超过这个数视为负向信号
FOLLOW_UP_NEGATIVE_THRESHOLD = 2

# 复制信号的置信度
COPY_SIGNAL_CONFIDENCE = 0.7

# 修改信号的置信度
MODIFY_SIGNAL_CONFIDENCE = 0.8

# 删除信号的置信度
DELETE_SIGNAL_CONFIDENCE = 0.9

# 满意度表达的置信度
SATISFACTION_SIGNAL_CONFIDENCE = 0.9

# 重试信号的置信度
RETRY_SIGNAL_CONFIDENCE = 0.7

# 话题切换信号的置信度
SWITCH_TOPIC_CONFIDENCE = 0.6

# 话题切换检测的最小内容长度
TOPIC_SWITCH_MIN_CONTENT_LENGTH = 10

# 关键词提取的最大数量
MAX_KEYWORDS_COUNT = 5

# 关键词提取的最小词长
MIN_KEYWORD_LENGTH = 2


class FeedbackType(str, Enum):
    """反馈信号类型"""
    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL = "neutral"


class FeedbackStrength(str, Enum):
    """反馈信号强度"""
    WEAK = "weak"
    MEDIUM = "medium"
    STRONG = "strong"


class FeedbackSource(str, Enum):
    """反馈信号来源"""
    COPY = "copy"              # 复制
    MODIFY = "modify"          # 修改
    RETRY = "retry"            # 重试
    FOLLOW_UP = "follow_up"    # 追问
    SATISFACTION = "satisfaction"  # 满意度表达
    ADOPTION = "adoption"      # 采纳执行
    SWITCH_TOPIC = "switch_topic"  # 切换话题
    IDLE = "idle"              # 空闲不回复
    DELETE = "delete"          # 删除
    ENGAGEMENT = "engagement"  # 参与度


@dataclass
class FeedbackSignal:
    """反馈信号"""
    id: str = ""
    type: FeedbackType = FeedbackType.NEUTRAL
    strength: FeedbackStrength = FeedbackStrength.WEAK
    source: FeedbackSource = FeedbackSource.ENGAGEMENT
    message_id: str | None = None
    timestamp: float = 0.0
    confidence: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class FeedbackStatistics:
    """反馈统计"""
    total_signals: int = 0
    positive_count: int = 0
    negative_count: int = 0
    neutral_count: int = 0
    by_source: dict[str, int] = field(default_factory=dict)
    session_count: int = 0
    average_confidence: float = 0.0
    error_count: int = 0


class ImplicitFeedbackCollector:
    """隐式反馈收集器"""

    _instance: ImplicitFeedbackCollector | None = None

    def __init__(self) -> None:
        # 是否启用
        self._enabled = True

        # 反馈信号历史
        self._signal_history: list[FeedbackSignal] = []

        # 最大历史记录数
        self._max_history_size = MAX_HISTORY_SIZE

        # 统计数据
        self._statistics = FeedbackStatistics()

        # 会话开始时间
        self._session_start_time = time.time()

        # 上一条用户消息时间
        self._last_user_message_time = 0.0

        # 上一条 AI 消息时间
        self._last_ai_message_time = 0.0

        # 连续追问计数
        self._consecutive_follow_ups = 0

        # 重试计数（同一话题）
        self._retry_count = 0

        # 当前话题关键词
        self._current_topic_keywords: list[str] = []
        self._MAX_CURRENT_TOPIC_KEYWORDS = 200

        log.debug("隐式反馈收集器已初始化")

    @classmethod
    def get_instance(cls) -> ImplicitFeedbackCollector:
        """获取单例实例"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """重置单例实例（测试用）"""
        cls._instance = None

    @classmethod
    def create_test_instance(cls) -> ImplicitFeedbackCollector:
        """创建测试用独立实例（测试用）"""
        return cls()

    # ========== 消息处理 ==========

    def on_user_message(self, content: str, message_id: str | None = None) -> None:
        """
        处理用户消息

        【错误隔离设计】
        每个检测逻辑都有独立的 try-catch 保护，
        确保一个检测失败不会影响其他检测的执行，
        也不会影响主消息循环。
        """
        if not self._enabled:
            return

        now = time.time()

        # ========== 1. 检测满意度表达 ==========
        try:
            if self._is_satisfaction_expression(content):
                self.record_signal(
                    signal_type=FeedbackType.POSITIVE,
                    strength=FeedbackStrength.STRONG,
                    source=FeedbackSource.SATISFACTION,
                    message_id=message_id,
                    confidence=SATISFACTION_SIGNAL_CONFIDENCE,
                )
        except Exception as e:
            log.debug("implicit_feedback 异常处理", error=str(e))
            self._statistics.error_count += 1
            log.warning(f"满意度检测失败: {e}")

        # ========== 2. 检测追问 ==========
        try:
            if (self._last_ai_message_time > 0 and
                    now - self._last_ai_message_time < FOLLOW_UP_TIME_WINDOW_SEC):
                if self._is_follow_up(content):
                    self._consecutive_follow_ups += 1

                    # 连续追问超过 2 次，视为负向信号
                    if self._consecutive_follow_ups >= 2:
                        strength = (
                            FeedbackStrength.STRONG
                            if self._consecutive_follow_ups >= 3
                            else FeedbackStrength.WEAK
                        )
                        confidence = min(
                            0.5 + self._consecutive_follow_ups * 0.1, 0.9
                        )
                        self.record_signal(
                            signal_type=FeedbackType.NEGATIVE,
                            strength=strength,
                            source=FeedbackSource.FOLLOW_UP,
                            confidence=confidence,
                            metadata={
                                "follow_up_count": self._consecutive_follow_ups
                            },
                        )
                else:
                    self._consecutive_follow_ups = 0
        except Exception as e:
            log.debug("implicit_feedback 异常处理", error=str(e))
            self._statistics.error_count += 1
            log.warning(f"追问检测失败: {e}")

        # ========== 3. 检测话题切换 ==========
        try:
            if self._is_topic_switch(content):
                self.record_signal(
                    signal_type=FeedbackType.NEUTRAL,
                    strength=FeedbackStrength.WEAK,
                    source=FeedbackSource.SWITCH_TOPIC,
                    confidence=SWITCH_TOPIC_CONFIDENCE,
                )
                self._current_topic_keywords = self._extract_keywords(content)
        except Exception as e:
            log.debug("implicit_feedback 异常处理", error=str(e))
            self._statistics.error_count += 1
            log.warning(f"话题切换检测失败: {e}")

        # ========== 4. 检测重试 ==========
        try:
            if self._is_retry(content):
                self._retry_count += 1
                self.record_signal(
                    signal_type=FeedbackType.NEGATIVE,
                    strength=FeedbackStrength.MEDIUM,
                    source=FeedbackSource.RETRY,
                    confidence=RETRY_SIGNAL_CONFIDENCE,
                    metadata={"retry_count": self._retry_count},
                )
        except Exception as e:
            log.debug("implicit_feedback 异常处理", error=str(e))
            self._statistics.error_count += 1
            log.warning(f"重试检测失败: {e}")

        # ========== 5. 更新状态（确保总能执行） ==========
        try:
            self._last_user_message_time = now
        except Exception as e:
            log.debug("implicit_feedback 异常处理", error=str(e))
            self._statistics.error_count += 1
            log.warning(f"状态更新失败: {e}")

    def on_ai_message(self, content: str = "", message_id: str | None = None) -> None:
        """处理 AI 消息"""
        if not self._enabled:
            return

        self._last_ai_message_time = time.time()
        self._retry_count = 0

    # ========== 信号记录 ==========

    def record_signal(
        self,
        signal_type: FeedbackType,
        strength: FeedbackStrength,
        source: FeedbackSource,
        message_id: str | None = None,
        confidence: float = 0.5,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """记录反馈信号"""
        if not self._enabled:
            return

        signal = FeedbackSignal(
            id=f"fb_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}",
            type=signal_type,
            strength=strength,
            source=source,
            message_id=message_id,
            timestamp=time.time(),
            confidence=confidence,
            metadata=metadata or {},
        )

        # 添加到历史
        self._signal_history.append(signal)
        if len(self._signal_history) > self._max_history_size:
            self._signal_history.pop(0)

        # 更新统计
        self._update_statistics(signal)

        log.debug(
            f"隐式反馈: {signal_type.value} ({source.value}, "
            f"强度: {strength.value}, 置信度: {confidence * 100:.0f}%)"
        )

    def _update_statistics(self, signal: FeedbackSignal) -> None:
        """更新统计数据"""
        self._statistics.total_signals += 1

        if signal.type == FeedbackType.POSITIVE:
            self._statistics.positive_count += 1
        elif signal.type == FeedbackType.NEGATIVE:
            self._statistics.negative_count += 1
        elif signal.type == FeedbackType.NEUTRAL:
            self._statistics.neutral_count += 1

        # 按来源统计
        source_key = signal.source.value
        if source_key not in self._statistics.by_source:
            self._statistics.by_source[source_key] = 0
        self._statistics.by_source[source_key] += 1

        # 会话内计数
        self._statistics.session_count += 1

        # 平均置信度
        total = self._statistics.total_signals
        self._statistics.average_confidence = (
            self._statistics.average_confidence * (total - 1) + signal.confidence
        ) / total

    # ========== 查询方法 ==========

    def get_statistics(self) -> FeedbackStatistics:
        """获取统计数据"""
        return FeedbackStatistics(
            total_signals=self._statistics.total_signals,
            positive_count=self._statistics.positive_count,
            negative_count=self._statistics.negative_count,
            neutral_count=self._statistics.neutral_count,
            by_source=dict(self._statistics.by_source),
            session_count=self._statistics.session_count,
            average_confidence=self._statistics.average_confidence,
            error_count=self._statistics.error_count,
        )

    def get_recent_signals(self, limit: int = 20) -> list[FeedbackSignal]:
        """获取近期反馈信号"""
        return list(self._signal_history[-limit:])

    def get_positive_ratio(self) -> float:
        """获取正向反馈比例"""
        if self._statistics.total_signals == 0:
            return 0.5
        return self._statistics.positive_count / self._statistics.total_signals

    # ========== 控制方法 ==========

    def set_enabled(self, enabled: bool) -> None:
        """启用/禁用收集器"""
        self._enabled = enabled
        log.info(f"隐式反馈收集器已{'启用' if enabled else '禁用'}")

    def is_enabled(self) -> bool:
        """检查是否启用"""
        return self._enabled

    # ========== 辅助检测方法 ==========

    def _is_satisfaction_expression(self, content: str) -> bool:
        """检测是否为满意度表达"""
        positive_patterns = [
            r"^(好的|好|ok|OK|对|是的|没错|谢谢|感谢|赞|厉害|牛|完美|太棒了|真不错|满意|可以)$",
            r"谢谢|感谢|太棒了|真不错|很满意|非常好",
        ]

        return any(re.search(pattern, content.strip(), re.IGNORECASE) for pattern in positive_patterns)

    def _is_follow_up(self, content: str) -> bool:
        """检测是否为追问"""
        follow_up_patterns = [
            r"为什么|怎么|如何|什么|哪里|哪个|谁|何时|多少",
            r"请解释|请说明|详细说|再说说|继续",
            r"不太懂|不理解|没明白|没听懂",
            r"然后呢|接下来|之后",
        ]

        return any(re.search(pattern, content) for pattern in follow_up_patterns)

    def _is_topic_switch(self, content: str) -> bool:
        """检测是否为话题切换"""
        # 简化实现：如果内容与当前话题关键词重叠度低，视为切换话题
        if len(self._current_topic_keywords) == 0:
            return False

        content_lower = content.lower()
        overlap = sum(
            1 for kw in self._current_topic_keywords
            if kw.lower() in content_lower
        )

        return overlap == 0 and len(content) > TOPIC_SWITCH_MIN_CONTENT_LENGTH

    def _is_retry(self, content: str) -> bool:
        """检测是否为重试"""
        retry_patterns = [
            r"再试一次|重新来|再来一次|不对|错了|不是",
            r"重新|再一次|重来",
        ]

        return any(re.search(pattern, content) for pattern in retry_patterns)

    def _extract_keywords(self, content: str) -> list[str]:
        """提取关键词（简化实现）"""
        # 简化实现：提取长度大于 2 的词
        words = re.split(r"[\s，。！？、；：\"\"''（）【】\[\].,!?;:'\"()]+", content)
        return [w for w in words if len(w) >= MIN_KEYWORD_LENGTH][:MAX_KEYWORDS_COUNT]

    def reset_session(self) -> None:
        """重置会话状态"""
        self._session_start_time = time.time()
        self._last_user_message_time = 0.0
        self._last_ai_message_time = 0.0
        self._consecutive_follow_ups = 0
        self._retry_count = 0
        self._current_topic_keywords = []

        log.debug("会话状态已重置")
