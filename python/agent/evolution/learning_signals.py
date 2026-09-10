"""多维度学习信号模块。

从多个维度收集学习信号，为系统进化和优化提供丰富的反馈。

主要功能：
- 多维度信号采集（结果、过程、隐式反馈等）
- 信号质量评估和过滤
- 信号聚合和分析
- 学习信号可视化和报告

Usage:
    collector = LearningSignalCollector()
    collector.record_signal("task_success", value=1.0, source="execution")
    insights = collector.analyze_signals()
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("learning_signals")



class SignalType(str):
    """信号类型。"""

    # 结果信号
    TASK_SUCCESS = "task_success"
    TASK_FAILURE = "task_failure"
    TASK_PARTIAL = "task_partial"

    # 过程信号
    STEP_SUCCESS = "step_success"
    STEP_FAILURE = "step_failure"
    TOOL_USAGE = "tool_usage"
    PLAN_EFFICIENCY = "plan_efficiency"

    # 质量信号
    OUTPUT_QUALITY = "output_quality"
    CODE_QUALITY = "code_quality"
    RESPONSE_QUALITY = "response_quality"

    # 隐式反馈
    USER_RETRY = "user_retry"
    USER_CORRECTION = "user_correction"
    USER_ENGAGEMENT = "user_engagement"

    # 性能信号
    RESPONSE_TIME = "response_time"
    TOKEN_USAGE = "token_usage"
    MEMORY_USAGE = "memory_usage"

    # 学习信号
    KNOWLEDGE_ACQUISITION = "knowledge_acquisition"
    SKILL_IMPROVEMENT = "skill_improvement"
    PATTERN_RECOGNITION = "pattern_recognition"
    # 闭环信号（U1 × U3）：感知→行动→验证 命中率，作为进化适应度反馈
    PERCEPTION_ACTION_HIT_RATE = "perception_action_hit_rate"


class SignalSource(str):
    """信号来源。"""

    EXECUTION = "execution"  # 执行结果
    EVALUATION = "evaluation"  # 评估结果
    USER_FEEDBACK = "user_feedback"  # 用户反馈
    MONITORING = "monitoring"  # 监控数据
    REFLECTION = "reflection"  # 反思结果
    EVOLUTION = "evolution"  # 进化结果


@dataclass
class LearningSignal:
    """学习信号。"""

    signal_id: str
    signal_type: str
    source: str
    value: float  # 标准化值 -1.0 到 1.0
    timestamp: float
    context: dict[str, Any] = field(default_factory=dict)
    confidence: float = 1.0  # 信号置信度
    weight: float = 1.0  # 信号权重
    tags: list[str] = field(default_factory=list)


@dataclass
class SignalAnalysisResult:
    """信号分析结果。"""

    total_signals: int = 0
    positive_signals: int = 0
    negative_signals: int = 0
    neutral_signals: int = 0
    avg_signal_value: float = 0.0
    signal_trend: str = "stable"  # "improving", "declining", "stable"
    key_insights: list[str] = field(default_factory=list)
    weak_areas: list[str] = field(default_factory=list)
    strong_areas: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)


@dataclass
class SignalCollectorConfig:
    """信号收集器配置。"""

    # 信号保留时间（秒）
    retention_period: int = 86400 * 7  # 7天

    # 最大信号数量
    max_signals: int = 10000

    # 信号采样率（0.0-1.0），用于高频率信号
    sampling_rate: float = 1.0

    # 是否启用信号聚合
    enable_aggregation: bool = True

    # 聚合窗口大小（秒）
    aggregation_window: int = 300  # 5分钟


class LearningSignalCollector:
    """多维度学习信号收集器。

    从多个维度收集学习信号，进行质量评估、
    聚合和分析，为系统优化提供数据支撑。
    """

    def __init__(
        self,
        config: SignalCollectorConfig | None = None,
        enabled: bool = True,
    ) -> None:
        """初始化学习信号收集器。

        Args:
            config: 配置。
            enabled: 是否启用。
        """
        self._MAX_STATS = 500
        self._config = config or SignalCollectorConfig()
        self._enabled = enabled

        # 信号存储
        self._signals: list[LearningSignal] = []

        # 按类型和来源的索引
        self._by_type: dict[str, list[LearningSignal]] = defaultdict(list)
        self._by_source: dict[str, list[LearningSignal]] = defaultdict(list)

        # 统计
        self._stats = {
            "total_signals_recorded": 0,
            "signals_dropped": 0,
            "analysis_count": 0,
        }

        log.info(
            "LearningSignalCollector initialized",
            enabled=enabled,
            max_signals=self._config.max_signals,
            retention_period=self._config.retention_period,
        )

    def record_signal(
        self,
        signal_type: str,
        value: float,
        source: str = SignalSource.EXECUTION,
        context: dict[str, Any] | None = None,
        confidence: float = 1.0,
        weight: float = 1.0,
        tags: list[str] | None = None,
    ) -> str | None:
        """记录学习信号。

        Args:
            signal_type: 信号类型。
            value: 信号值（-1.0到1.0）。
            source: 信号来源。
            context: 上下文信息。
            confidence: 置信度。
            weight: 权重。
            tags: 标签列表。

        Returns:
            str | None: 信号ID，失败返回None。
        """
        if not self._enabled:
            return None

        # 采样（高频率信号）
        import random

        if self._config.sampling_rate < 1.0:
            if random.random() > self._config.sampling_rate:
                self._stats["signals_dropped"] += 1
                return None

        # 标准化值
        normalized_value = max(-1.0, min(1.0, value))

        # 创建信号
        signal = LearningSignal(
            signal_id=f"sig-{int(time.time())}-{id(self) % 10000:04d}",
            signal_type=signal_type,
            source=source,
            value=normalized_value,
            timestamp=time.time(),
            context=context or {},
            confidence=max(0.0, min(1.0, confidence)),
            weight=max(0.0, weight),
            tags=tags or [],
        )

        # 存储信号
        self._signals.append(signal)
        self._by_type[signal_type].append(signal)
        self._by_source[source].append(signal)
        self._stats["total_signals_recorded"] += 1

        # 清理过期信号
        self._cleanup_old_signals()

        # 限制最大数量
        if len(self._signals) > self._config.max_signals:
            # 移除最旧的信号
            excess = len(self._signals) - self._config.max_signals
            removed = self._signals[:excess]
            self._signals = self._signals[excess:]

            # 从索引中移除
            for sig in removed:
                if sig in self._by_type[sig.signal_type]:
                    self._by_type[sig.signal_type].remove(sig)
                if sig in self._by_source[sig.source]:
                    self._by_source[sig.source].remove(sig)

            self._stats["signals_dropped"] += excess

        log.debug(
            "Signal recorded",
            type=signal_type,
            value=normalized_value,
            source=source,
        )

        return signal.signal_id

    def analyze_signals(
        self,
        signal_type: str | None = None,
        source: str | None = None,
        time_window: int | None = None,
    ) -> SignalAnalysisResult:
        """分析学习信号。

        Args:
            signal_type: 按类型过滤。
            source: 按来源过滤。
            time_window: 时间窗口（秒）。

        Returns:
            SignalAnalysisResult: 分析结果。
        """
        if not self._enabled:
            return SignalAnalysisResult()

        self._stats["analysis_count"] += 1

        # 过滤信号
        filtered = self._filter_signals(signal_type, source, time_window)

        if not filtered:
            return SignalAnalysisResult()

        # 基本统计
        total = len(filtered)
        positive = sum(1 for s in filtered if s.value > 0.1)
        negative = sum(1 for s in filtered if s.value < -0.1)
        neutral = total - positive - negative

        # 加权平均值
        weighted_sum = sum(s.value * s.weight * s.confidence for s in filtered)
        total_weight = sum(s.weight * s.confidence for s in filtered)
        avg_value = weighted_sum / total_weight if total_weight > 0 else 0.0

        # 趋势分析
        trend = self._analyze_trend(filtered)

        # 按类型分析强弱项
        by_type_stats = self._analyze_by_type(filtered)
        strong_areas = [t for t, s in by_type_stats.items() if s > 0.3]
        weak_areas = [t for t, s in by_type_stats.items() if s < -0.3]

        # 生成洞察和建议
        insights = self._generate_insights(filtered, by_type_stats)
        recommendations = self._generate_recommendations(
            by_type_stats, trend
        )

        result = SignalAnalysisResult(
            total_signals=total,
            positive_signals=positive,
            negative_signals=negative,
            neutral_signals=neutral,
            avg_signal_value=avg_value,
            signal_trend=trend,
            key_insights=insights,
            weak_areas=weak_areas,
            strong_areas=strong_areas,
            recommendations=recommendations,
        )

        log.debug(
            "Signal analysis completed",
            total=total,
            avg_value=avg_value,
            trend=trend,
        )

        return result

    def get_signals(
        self,
        signal_type: str | None = None,
        source: str | None = None,
        limit: int = 100,
    ) -> list[LearningSignal]:
        """获取信号列表。

        Args:
            signal_type: 按类型过滤。
            source: 按来源过滤。
            limit: 返回数量限制。

        Returns:
            list[LearningSignal]: 信号列表。
        """
        filtered = self._filter_signals(signal_type, source)

        # 按时间倒序
        filtered.sort(key=lambda s: s.timestamp, reverse=True)

        return filtered[:limit]

    def _filter_signals(
        self,
        signal_type: str | None = None,
        source: str | None = None,
        time_window: int | None = None,
    ) -> list[LearningSignal]:
        """过滤信号。

        Args:
            signal_type: 按类型过滤。
            source: 按来源过滤。
            time_window: 时间窗口（秒）。

        Returns:
            list[LearningSignal]: 过滤后的信号列表。
        """
        filtered = self._signals

        if signal_type:
            filtered = [s for s in filtered if s.signal_type == signal_type]

        if source:
            filtered = [s for s in filtered if s.source == source]

        if time_window:
            cutoff = time.time() - time_window
            filtered = [s for s in filtered if s.timestamp >= cutoff]

        return filtered

    def _analyze_trend(self, signals: list[LearningSignal]) -> str:
        """分析信号趋势。

        Args:
            signals: 信号列表。

        Returns:
            str: 趋势描述。
        """
        if len(signals) < 10:
            return "stable"  # 数据不足

        # 按时间排序
        sorted_signals = sorted(signals, key=lambda s: s.timestamp)

        # 分成前后两半
        mid = len(sorted_signals) // 2
        first_half = sorted_signals[:mid]
        second_half = sorted_signals[mid:]

        # 计算两半的平均值
        first_avg = sum(s.value for s in first_half) / len(first_half)
        second_avg = sum(s.value for s in second_half) / len(second_half)

        # 比较差异
        diff = second_avg - first_avg
        if diff > 0.1:
            return "improving"
        elif diff < -0.1:
            return "declining"
        else:
            return "stable"

    def _analyze_by_type(
        self, signals: list[LearningSignal]
    ) -> dict[str, float]:
        """按类型分析信号。

        Args:
            signals: 信号列表。

        Returns:
            dict[str, float]: 各类型的平均分数。
        """
        by_type: dict[str, list[float]] = defaultdict(list)

        for sig in signals:
            by_type[sig.signal_type].append(sig.value)

        result = {}
        for sig_type, values in by_type.items():
            if values:
                result[sig_type] = sum(values) / len(values)

        return result

    def _generate_insights(
        self,
        signals: list[LearningSignal],
        by_type_stats: dict[str, float],
    ) -> list[str]:
        """生成洞察。

        Args:
            signals: 信号列表。
            by_type_stats: 按类型的统计。

        Returns:
            list[str]: 洞察列表。
        """
        insights = []

        # 总体表现
        if by_type_stats:
            avg = sum(by_type_stats.values()) / len(by_type_stats)
            if avg > 0.5:
                insights.append("整体学习信号积极，系统表现良好")
            elif avg < -0.3:
                insights.append("整体学习信号消极，需要关注系统表现")
            else:
                insights.append("整体学习信号中性，系统表现稳定")

        # 最佳和最差维度
        if len(by_type_stats) >= 3:
            sorted_types = sorted(by_type_stats.items(), key=lambda x: x[1], reverse=True)
            best_type, best_score = sorted_types[0]
            worst_type, worst_score = sorted_types[-1]

            if best_score > 0.3:
                insights.append(f"表现最佳的维度: {best_type}（{best_score:.2f}）")
            if worst_score < -0.1:
                insights.append(f"需要改进的维度: {worst_type}（{worst_score:.2f}）")

        return insights[:5]

    def _generate_recommendations(
        self,
        by_type_stats: dict[str, float],
        trend: str,
    ) -> list[str]:
        """生成建议。

        Args:
            by_type_stats: 按类型的统计。
            trend: 趋势。

        Returns:
            list[str]: 建议列表。
        """
        recommendations = []

        # 基于趋势的建议
        if trend == "declining":
            recommendations.append("信号趋势下降，建议触发进化或优化")
        elif trend == "improving":
            recommendations.append("信号趋势上升，继续保持当前策略")

        # 基于弱项的建议
        weak_types = [t for t, s in by_type_stats.items() if s < -0.2]
        for weak_type in weak_types[:3]:
            recommendations.append(f"建议重点改进 {weak_type} 维度")

        # 基于强项的建议
        strong_types = [t for t, s in by_type_stats.items() if s > 0.4]
        if strong_types:
            recommendations.append(
                f"可以将 {', '.join(strong_types[:3])} 的成功经验推广到其他维度"
            )

        return recommendations[:5]

    def _cleanup_old_signals(self) -> None:
        """清理过期信号。"""
        cutoff = time.time() - self._config.retention_period

        # 找出过期信号
        expired = [s for s in self._signals if s.timestamp < cutoff]
        if not expired:
            return

        # 从主列表移除
        self._signals = [s for s in self._signals if s.timestamp >= cutoff]

        # 从索引移除
        for sig in expired:
            if sig in self._by_type[sig.signal_type]:
                self._by_type[sig.signal_type].remove(sig)
            if sig in self._by_source[sig.source]:
                self._by_source[sig.source].remove(sig)

        log.debug("Cleaned up expired signals", count=len(expired))

    def get_stats(self) -> dict[str, Any]:
        """获取统计信息。

        Returns:
            dict: 统计信息。
        """
        return {
            "total_signals_recorded": self._stats["total_signals_recorded"],
            "current_signals": len(self._signals),
            "signals_dropped": self._stats["signals_dropped"],
            "analysis_count": self._stats["analysis_count"],
            "signal_types": len(self._by_type),
            "signal_sources": len(self._by_source),
            "enabled": self._enabled,
        }

    def reset(self) -> None:
        """重置收集器。"""
        self._signals.clear()
        self._by_type.clear()
        self._by_source.clear()
        self._stats = {
            "total_signals_recorded": 0,
            "signals_dropped": 0,
            "analysis_count": 0,
        }
        log.info("LearningSignalCollector reset")

    @property
    def enabled(self) -> bool:
        """是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态。"""
        self._enabled = value
        log.info("LearningSignalCollector enabled state changed", enabled=value)
