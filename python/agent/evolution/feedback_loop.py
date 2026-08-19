"""进化反馈闭环模块。

本模块承载**两套互补**的反馈闭环实现，二者面向不同层次，互不替代：

1. :class:`ContinuousFeedbackLoop` —— **用户反馈 → 进化引擎**（会话层）
   采集用户显式反馈（点赞/点踩/修正/复用/工具失败），转化为
   :class:`LearningSignal` 写入 EvolutionEngine，并按阈值批量触发策略优化。
   消费方：``agent.core.engine``（``engine.feedback_loop``）、``agent/api/feedback.py``。

2. :class:`FeedbackLoop` —— **执行信号 → 进化建议**（运行时层）
   聚合工具/任务/场景的执行成败与延迟信号，做模式识别（连续失败、失败率、
   延迟飙升、工具退化、场景质量下降），产出 :class:`EvolutionSuggestion`。
   消费方：``agent.p3_supervisor.P3Supervisor``。

.. note::
   历史上第 2 套实现曾整体覆盖本文件、删除了第 1 套，导致
   ``agent.core.engine`` 悬空导入 ``ContinuousFeedbackLoop`` 而整包无法 import
   （见审计报告 §1.6 接线断裂）。二者符号零冲突，此处合并共存，
   **不要再用单侧实现覆盖本文件**。

工作流（ContinuousFeedbackLoop）:
    1. 采集用户反馈（positive/negative/correction/reuse/tool_failure）
    2. 转化为学习信号（LearningSignal，含质量分数）
    3. 写入 EvolutionEngine 的训练数据（collect_feedback）
    4. 触发策略优化（阈值触发：每 N 条反馈或超过时间窗口）
    5. 应用优化结果到运行时（通过 CanaryReleaseManager）

Usage:
    from agent.evolution.feedback_loop import ContinuousFeedbackLoop, FeedbackLoop

    # 会话层
    loop = ContinuousFeedbackLoop(
        evolution_engine=engine.evolution,
        canary_manager=engine.canary_manager,
        optimize_threshold=100,
    )
    await loop.collect_feedback(session_id="s1", feedback_type="positive")
    result = await loop.check_and_optimize()

    # 运行时层
    rt = FeedbackLoop(evolution_engine=engine.evolution)
    rt.collect_signal(FeedbackSignal(signal_type=FeedbackSignalType.TOOL_FAILURE, ...))
    for suggestion in rt.check_and_evolve():
        rt.apply_plan(suggestion)
"""
from __future__ import annotations

import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from agent.core.logger import StructuredLogger

log = StructuredLogger("feedback_loop")

__all__ = [
    # --- 会话层：用户反馈 → 进化引擎 ---
    "FEEDBACK_TYPE_POSITIVE",
    "FEEDBACK_TYPE_NEGATIVE",
    "FEEDBACK_TYPE_CORRECTION",
    "FEEDBACK_TYPE_REUSE",
    "FEEDBACK_TYPE_TOOL_FAILURE",
    "FeedbackEntry",
    "LearningSignal",
    "OptimizeResult",
    "ContinuousFeedbackLoop",
    # --- 运行时层：执行信号 → 进化建议 ---
    "FeedbackSignalType",
    "TriggerCondition",
    "FeedbackSignal",
    "EvolutionSuggestion",
    "FeedbackLoopStats",
    "FeedbackLoop",
]


# ===========================================================================
# Part 1：ContinuousFeedbackLoop —— 用户反馈 → 进化引擎（会话层）
# ===========================================================================

# 反馈类型常量
FEEDBACK_TYPE_POSITIVE = "positive"
"""正向反馈：用户点赞/满意。"""

FEEDBACK_TYPE_NEGATIVE = "negative"
"""负向反馈：用户点踩/不满意。"""

FEEDBACK_TYPE_CORRECTION = "correction"
"""修正反馈：用户修改了 AI 输出。"""

FEEDBACK_TYPE_REUSE = "reuse"
"""复用反馈：用户复用了历史答案。"""

FEEDBACK_TYPE_TOOL_FAILURE = "tool_failure"
"""工具失败反馈：工具执行失败。"""

_VALID_FEEDBACK_TYPES = frozenset(
    {FEEDBACK_TYPE_POSITIVE, FEEDBACK_TYPE_NEGATIVE, FEEDBACK_TYPE_CORRECTION, FEEDBACK_TYPE_REUSE, FEEDBACK_TYPE_TOOL_FAILURE}
)
"""合法的反馈类型集合。"""

# 各反馈类型映射的质量分数（默认值，可被 metadata.quality_score 覆盖）
_DEFAULT_QUALITY_BY_TYPE: dict[str, float] = {
    FEEDBACK_TYPE_POSITIVE: 0.9,
    FEEDBACK_TYPE_NEGATIVE: 0.1,
    FEEDBACK_TYPE_CORRECTION: 0.5,
    FEEDBACK_TYPE_REUSE: 0.85,
    FEEDBACK_TYPE_TOOL_FAILURE: 0.0,
}
"""各反馈类型的默认质量分数映射。"""


@dataclass
class FeedbackEntry:
    """反馈条目，记录一次用户反馈的原始数据。

    Attributes:
        entry_id: 反馈条目唯一 ID。
        session_id: 关联的会话 ID。
        feedback_type: 反馈类型（positive/negative/correction/reuse）。
        timestamp: 采集时间戳（Unix 秒）。
        metadata: 附加元数据（如 quality_score、reason、original/corrected）。
    """

    entry_id: str = ""
    session_id: str = ""
    feedback_type: str = ""
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class LearningSignal:
    """学习信号，由反馈转化而来，供进化引擎消费。

    Attributes:
        signal_type: 信号类型（positive/negative/correction/reuse）。
        quality: 标准化质量分数 [0.0, 1.0]。
        session_id: 关联会话 ID。
        metadata: 附加元数据。
        timestamp: 创建时间戳。
    """

    signal_type: str = "positive"
    quality: float = 0.5
    session_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0


@dataclass
class OptimizeResult:
    """优化触发结果。

    Attributes:
        triggered: 是否触发了优化。
        optimized_count: 实际执行的优化动作数。
        reason: 触发原因或未触发原因。
        timestamp: 检查时间戳。
    """

    triggered: bool = False
    optimized_count: int = 0
    reason: str = ""
    timestamp: float = 0.0


class ContinuousFeedbackLoop:
    """持续反馈闭环。

    将用户反馈转化为学习信号，驱动进化引擎持续优化策略。
    通过阈值（反馈数量或时间窗口）触发批量优化，避免每条反馈
    都触发昂贵的进化计算。

    Attributes:
        _evolution_engine: 进化引擎实例（可为 None，此时只采集不优化）。
        _canary_manager: 灰度发布管理器（可为 None，跳过运行时应用）。
        _optimize_threshold: 触发优化的反馈数量阈值。
        _time_window_seconds: 触发优化的时间窗口（秒）。
        _feedback_buffer: 已采集但未优化的反馈条目缓冲区。
        _last_optimize_time: 上次优化时间戳。
        _stats: 反馈统计计数器。
    """

    def __init__(
        self,
        evolution_engine: Any = None,
        canary_manager: Any = None,
        optimize_threshold: int = 100,
        time_window_seconds: int = 86400,
    ) -> None:
        """初始化持续反馈闭环。

        Args:
            evolution_engine: EvolutionEngine 实例，None 时只采集不写入。
            canary_manager: CanaryReleaseManager 实例，None 时跳过运行时应用。
            optimize_threshold: 触发优化的反馈数量阈值（默认 100）。
            time_window_seconds: 触发优化的时间窗口秒数（默认 86400 = 1 天）。
        """
        self._evolution_engine = evolution_engine
        self._canary_manager = canary_manager
        self._optimize_threshold = max(1, int(optimize_threshold))
        self._time_window_seconds = max(60, int(time_window_seconds))
        self._feedback_buffer: list[FeedbackEntry] = []
        self._last_optimize_time: float = time.time()
        self._stats: dict[str, int] = {
            "total": 0,
            "positive": 0,
            "negative": 0,
            "correction": 0,
            "reuse": 0,
        }
        log.info(
            "ContinuousFeedbackLoop initialized",
            threshold=self._optimize_threshold,
            time_window=self._time_window_seconds,
            has_evolution=evolution_engine is not None,
            has_canary=canary_manager is not None,
        )

    async def collect_feedback(
        self,
        session_id: str,
        feedback_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> FeedbackEntry:
        """采集用户反馈。

        Args:
            session_id: 关联的会话 ID。
            feedback_type: 反馈类型，必须是 positive/negative/correction/reuse 之一。
            metadata: 附加元数据（如 quality_score、reason、original/corrected）。

        Returns:
            FeedbackEntry: 已记录的反馈条目。

        Raises:
            ValueError: feedback_type 不是合法类型时。
        """
        if feedback_type not in _VALID_FEEDBACK_TYPES:
            raise ValueError(
                f"非法 feedback_type: {feedback_type}，"
                f"必须是 {sorted(_VALID_FEEDBACK_TYPES)} 之一"
            )

        entry = FeedbackEntry(
            entry_id=f"fb_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}",
            session_id=session_id,
            feedback_type=feedback_type,
            timestamp=time.time(),
            metadata=dict(metadata) if metadata else {},
        )
        self._feedback_buffer.append(entry)
        self._stats["total"] += 1
        if feedback_type in self._stats:
            self._stats[feedback_type] += 1

        log.debug(
            "反馈已采集",
            entry_id=entry.entry_id,
            session_id=session_id,
            feedback_type=feedback_type,
        )
        return entry

    async def convert_to_learning_signal(
        self, feedback: FeedbackEntry
    ) -> LearningSignal:
        """将反馈转化为学习信号。

        转化规则:
            - positive: quality=0.9（或 metadata.quality_score）
            - negative: quality=0.1
            - correction: quality=0.5
            - reuse: quality=0.85

        Args:
            feedback: 反馈条目。

        Returns:
            LearningSignal: 转化后的学习信号。
        """
        # 优先使用 metadata 中的 quality_score，否则使用默认值
        default_quality = _DEFAULT_QUALITY_BY_TYPE.get(feedback.feedback_type, 0.5)
        quality = float(feedback.metadata.get("quality_score", default_quality))
        # 钳制到 [0.0, 1.0]
        quality = max(0.0, min(1.0, quality))

        signal = LearningSignal(
            signal_type=feedback.feedback_type,
            quality=quality,
            session_id=feedback.session_id,
            metadata=feedback.metadata,
            timestamp=time.time(),
        )
        return signal

    async def feed_to_evolution_engine(
        self, signal: LearningSignal
    ) -> None:
        """写入进化引擎。

        将学习信号转化为 ``agent.evolution.types.FeedbackSignal`` 并调用
        ``EvolutionEngine.collect_feedback``。进化引擎缺失或失败时静默降级，不抛异常。

        .. note::
           这里的 ``EvolutionFeedbackSignal`` 是 ``agent.evolution.types`` 中的类型，
           与本模块运行时层的 :class:`FeedbackSignal` **不是同一个类**，故显式别名以免混淆。

        Args:
            signal: 学习信号。
        """
        if self._evolution_engine is None:
            log.debug("EvolutionEngine 未配置，跳过写入")
            return

        try:
            from agent.evolution.types import EvolutionCause
            from agent.evolution.types import FeedbackSignal as EvolutionFeedbackSignal

            _SIGNAL_TYPE_TO_CAUSE = {
                "positive": EvolutionCause.PROACTIVE,
                "negative": EvolutionCause.LOW_QUALITY,
                "correction": EvolutionCause.USER_CORRECTION,
                "reuse": EvolutionCause.REPEATED_QUESTION,
                "tool_failure": EvolutionCause.TOOL_FAILURE,
            }
            cause = _SIGNAL_TYPE_TO_CAUSE.get(
                signal.signal_type, EvolutionCause.LOW_QUALITY
            )

            fb_signal = EvolutionFeedbackSignal(
                interaction_id=signal.session_id or "feedback_loop",
                quality_score=signal.quality,
                cause=cause.value if isinstance(cause, EvolutionCause) else str(cause),
                timestamp=signal.timestamp or time.time(),
                session_id=signal.session_id,
            )
            await self._evolution_engine.collect_feedback(fb_signal)
        except Exception as exc:
            log.warning("写入 EvolutionEngine 失败（已忽略）", error=str(exc))

    async def check_and_optimize(self) -> OptimizeResult:
        """检查是否达到优化阈值，触发策略优化。

        触发条件（任一满足）:
            - 缓冲区反馈数 >= optimize_threshold
            - 距上次优化时间 >= time_window_seconds

        优化动作:
            1. 调用 EvolutionEngine.should_evolve() 检查是否需要进化
            2. 若有进化计划，调用 execute_evolution() 执行
            3. 重置缓冲区与计数器

        Returns:
            OptimizeResult: 触发结果。
        """
        now = time.time()
        buffer_size = len(self._feedback_buffer)
        time_since_last = now - self._last_optimize_time

        triggered_by_count = buffer_size >= self._optimize_threshold
        triggered_by_time = time_since_last >= self._time_window_seconds

        if not (triggered_by_count or triggered_by_time):
            return OptimizeResult(
                triggered=False,
                reason=(
                    f"未达阈值（{buffer_size}/{self._optimize_threshold}，"
                    f"{int(time_since_last)}s/{self._time_window_seconds}s）"
                ),
                timestamp=now,
            )

        reason = "count_threshold" if triggered_by_count else "time_window"
        optimized_count = await self._run_optimization()

        # 重置计数器
        self._feedback_buffer.clear()
        self._last_optimize_time = now

        return OptimizeResult(
            triggered=True,
            optimized_count=optimized_count,
            reason=reason,
            timestamp=now,
        )

    async def _run_optimization(self) -> int:
        """执行优化（调用进化引擎）。

        Returns:
            int: 执行的优化动作数。
        """
        if self._evolution_engine is None:
            log.debug("EvolutionEngine 未配置，跳过优化")
            return 0

        optimized = 0
        try:
            plan = await self._evolution_engine.should_evolve()
            if plan is not None:
                result = await self._evolution_engine.execute_evolution(plan)
                optimized = result.executed_actions
                log.info(
                    "进化已执行",
                    plan_id=plan.plan_id,
                    actions=result.executed_actions,
                    success=result.success,
                )
            else:
                log.debug("进化引擎判定无需进化")
        except Exception as exc:
            log.warning("优化执行失败（已忽略）", error=str(exc))

        return optimized

    def get_stats(self) -> dict[str, int]:
        """获取反馈统计。

        Returns:
            dict[str, int]: 各类反馈计数（total/positive/negative/correction/reuse）。
        """
        return dict(self._stats)


# ===========================================================================
# Part 2：FeedbackLoop —— 执行信号 → 进化建议（运行时层）
# ===========================================================================


class FeedbackSignalType(str, Enum):
    """反馈信号类型。"""

    TOOL_SUCCESS = "tool_success"
    TOOL_FAILURE = "tool_failure"
    TOOL_TIMEOUT = "tool_timeout"
    TASK_SUCCESS = "task_success"
    TASK_FAILURE = "task_failure"
    USER_CORRECTION = "user_correction"
    USER_SATISFACTION = "user_satisfaction"
    SKILL_DEGRADATION = "skill_degradation"
    KNOWLEDGE_GAP = "knowledge_gap"
    PATTERN_DETECTED = "pattern_detected"


class TriggerCondition(str, Enum):
    """触发条件。"""

    CONSECUTIVE_FAILURES = "consecutive_failures"
    FAILURE_RATE_THRESHOLD = "failure_rate_threshold"
    LATENCY_SPIKE = "latency_spike"
    TOOL_DEGRADATION = "tool_degradation"
    SKILL_INACCURACY = "skill_inaccuracy"
    USER_DISSATISFACTION = "user_dissatisfaction"
    SCENE_QUALITY_DROP = "scene_quality_drop"


@dataclass
class FeedbackSignal:
    """运行时反馈信号。

    .. warning::
       与 ``agent.evolution.types.FeedbackSignal`` 同名但**不同类**：本类描述
       一次执行观测（工具/任务成败与耗时），后者描述一次交互的质量评分。

    Attributes:
        signal_type: 信号类型。
        agent_name: Agent名称。
        tool_name: 工具名称（可选）。
        scene: 场景。
        success: 是否成功。
        duration_ms: 耗时。
        error: 错误信息。
        user_feedback: 用户反馈文本。
        context: 附加上下文。
        timestamp: 时间戳。
    """

    signal_type: FeedbackSignalType = FeedbackSignalType.TASK_SUCCESS
    agent_name: str = ""
    tool_name: str = ""
    scene: str = "general"
    success: bool = True
    duration_ms: float = 0.0
    error: str = ""
    user_feedback: str = ""
    context: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0


@dataclass
class EvolutionSuggestion:
    """进化建议。

    Attributes:
        trigger: 触发条件。
        severity: 严重程度（0-1）。
        action: 建议操作。
        target: 目标（工具/技能/Agent名称）。
        reason: 建议原因。
        auto_apply: 是否自动应用。
    """

    trigger: TriggerCondition = TriggerCondition.CONSECUTIVE_FAILURES
    severity: float = 0.0
    action: str = ""
    target: str = ""
    reason: str = ""
    auto_apply: bool = False


@dataclass
class FeedbackLoopStats:
    """反馈闭环统计。

    Attributes:
        total_signals: 总信号数。
        signals_by_type: 按类型分组的信号数。
        suggestions_generated: 生成的建议数。
        actions_applied: 已应用的操作数。
        success_rate_improvement: 成功率提升（百分比）。
    """

    total_signals: int = 0
    signals_by_type: dict[str, int] = field(default_factory=dict)
    suggestions_generated: int = 0
    actions_applied: int = 0
    success_rate_improvement: float = 0.0


class FeedbackLoop:
    """运行时反馈闭环。

    收集执行信号，识别模式，自动触发进化。
    """

    _CONSECUTIVE_FAILURE_THRESHOLD = 3
    _FAILURE_RATE_THRESHOLD = 0.3
    _LATENCY_SPIKE_MULTIPLIER = 3.0
    _TOOL_DEGRADATION_RATE = 0.2
    _SKILL_INACCURACY_RATE = 0.25

    def __init__(self, evolution_engine: Any = None) -> None:
        self._engine = evolution_engine
        self._signals: list[FeedbackSignal] = []
        self._suggestions: list[EvolutionSuggestion] = []
        self._applied_actions: list[dict] = []
        self._tool_performance: dict[str, dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
        self._scene_performance: dict[str, list[bool]] = defaultdict(list)
        self._agent_performance: dict[str, list[bool]] = defaultdict(list)
        self._baseline_latency: dict[str, float] = {}

    def collect_signal(self, signal: FeedbackSignal) -> None:
        """收集反馈信号。

        Args:
            signal: 反馈信号。
        """
        if signal.timestamp == 0:
            signal.timestamp = time.time()

        self._signals.append(signal)
        if len(self._signals) > 2000:
            self._signals = self._signals[-2000:]

        if signal.tool_name:
            self._tool_performance[signal.tool_name][signal.agent_name].append(signal.success)

        self._scene_performance[signal.scene].append(signal.success)
        self._agent_performance[signal.agent_name].append(signal.success)

        if signal.signal_type == FeedbackSignalType.TOOL_SUCCESS and signal.tool_name:
            if signal.tool_name not in self._baseline_latency:
                self._baseline_latency[signal.tool_name] = signal.duration_ms
            else:
                current = self._baseline_latency[signal.tool_name]
                self._baseline_latency[signal.tool_name] = current * 0.9 + signal.duration_ms * 0.1

    def check_and_evolve(self) -> list[EvolutionSuggestion]:
        """检查信号并生成进化建议。

        Returns:
            list[EvolutionSuggestion]: 进化建议列表。
        """
        self._suggestions = []
        recent = self._signals[-200:]

        self._check_consecutive_failures(recent)
        self._check_failure_rates()
        self._check_latency_spikes(recent)
        self._check_tool_degradation()
        self._check_skill_inaccuracy(recent)
        self._check_user_dissatisfaction(recent)
        self._check_scene_quality_drop()

        return self._suggestions

    def apply_plan(self, suggestion: EvolutionSuggestion) -> bool:
        """应用进化建议。

        Args:
            suggestion: 进化建议。

        Returns:
            bool: 是否成功应用。
        """
        if self._engine is None:
            return False

        try:
            if suggestion.action == "adjust_tool_weight":
                if hasattr(self._engine, "_tool_weights"):
                    current = self._engine._tool_weights.get(suggestion.target, 0.5)
                    new_weight = max(0.1, current - 0.1)
                    self._engine._tool_weights[suggestion.target] = new_weight

            elif suggestion.action == "generate_correction_rule":
                if hasattr(self._engine, "_correction_rules"):
                    self._engine._correction_rules.append({
                        "pattern": suggestion.target,
                        "reason": suggestion.reason,
                    })

            elif suggestion.action == "add_knowledge_nudge":
                if hasattr(self._engine, "_knowledge_nudges"):
                    self._engine._knowledge_nudges.append(suggestion.reason)

            elif suggestion.action == "degrade_skill":
                if hasattr(self._engine, "_skills") and suggestion.target in self._engine._skills:
                    old_quality = self._engine._skills[suggestion.target].get("quality", 0.5)
                    self._engine._skills[suggestion.target]["quality"] = max(0.1, old_quality - 0.1)

            elif suggestion.action == "save_state":
                if hasattr(self._engine, "_save_state"):
                    self._engine._save_state()

            self._applied_actions.append({
                "action": suggestion.action,
                "target": suggestion.target,
                "reason": suggestion.reason,
                "timestamp": time.time(),
            })
            return True

        except Exception:
            return False

    def get_stats(self) -> FeedbackLoopStats:
        """获取反馈闭环统计。

        Returns:
            FeedbackLoopStats: 统计信息。
        """
        signals_by_type: dict[str, int] = {}
        for s in self._signals:
            signals_by_type[s.signal_type.value] = signals_by_type.get(s.signal_type.value, 0) + 1

        recent_success = sum(1 for s in self._signals[-100:] if s.success)
        early_success = sum(1 for s in self._signals[:100] if s.success)
        early_count = min(100, len(self._signals))
        recent_count = min(100, len(self._signals[-100:]))

        improvement = 0.0
        if early_count > 0 and recent_count > 0:
            early_rate = early_success / early_count
            recent_rate = recent_success / recent_count
            improvement = (recent_rate - early_rate) * 100

        return FeedbackLoopStats(
            total_signals=len(self._signals),
            signals_by_type=signals_by_type,
            suggestions_generated=len(self._suggestions),
            actions_applied=len(self._applied_actions),
            success_rate_improvement=improvement,
        )

    def reset(self) -> None:
        self._signals.clear()
        self._suggestions.clear()
        self._applied_actions.clear()
        self._tool_performance.clear()
        self._scene_performance.clear()
        self._agent_performance.clear()
        self._baseline_latency.clear()

    def _check_consecutive_failures(self, recent: list[FeedbackSignal]) -> None:
        tool_failures: dict[str, list[FeedbackSignal]] = defaultdict(list)
        for s in recent:
            if s.signal_type == FeedbackSignalType.TOOL_FAILURE and s.tool_name:
                tool_failures[s.tool_name].append(s)

        for tool_name, failures in tool_failures.items():
            if len(failures) >= self._CONSECUTIVE_FAILURE_THRESHOLD:
                consecutive = self._count_consecutive(failures, tool_name)
                if consecutive >= self._CONSECUTIVE_FAILURE_THRESHOLD:
                    self._suggestions.append(EvolutionSuggestion(
                        trigger=TriggerCondition.CONSECUTIVE_FAILURES,
                        severity=min(1.0, consecutive / 10.0),
                        action="adjust_tool_weight",
                        target=tool_name,
                        reason=f"工具 '{tool_name}' 连续失败 {consecutive} 次",
                        auto_apply=consecutive >= 5,
                    ))

    def _check_failure_rates(self) -> None:
        for tool_name, agents in self._tool_performance.items():
            all_results = [r for results in agents.values() for r in results]
            if len(all_results) < 5:
                continue
            failure_rate = 1.0 - (sum(all_results) / len(all_results))
            if failure_rate > self._FAILURE_RATE_THRESHOLD:
                self._suggestions.append(EvolutionSuggestion(
                    trigger=TriggerCondition.FAILURE_RATE_THRESHOLD,
                    severity=failure_rate,
                    action="adjust_tool_weight",
                    target=tool_name,
                    reason=f"工具 '{tool_name}' 失败率 {failure_rate:.0%} 超过阈值 {self._FAILURE_RATE_THRESHOLD:.0%}",
                    auto_apply=failure_rate > 0.5,
                ))

    def _check_latency_spikes(self, recent: list[FeedbackSignal]) -> None:
        for s in recent:
            if s.tool_name and s.tool_name in self._baseline_latency:
                baseline = self._baseline_latency[s.tool_name]
                if baseline > 0 and s.duration_ms > baseline * self._LATENCY_SPIKE_MULTIPLIER:
                    self._suggestions.append(EvolutionSuggestion(
                        trigger=TriggerCondition.LATENCY_SPIKE,
                        severity=min(1.0, s.duration_ms / (baseline * 10)),
                        action="adjust_tool_weight",
                        target=s.tool_name,
                        reason=f"工具 '{s.tool_name}' 延迟飙升: {s.duration_ms:.0f}ms (基线: {baseline:.0f}ms)",
                        auto_apply=False,
                    ))

    def _check_tool_degradation(self) -> None:
        for tool_name, agents in self._tool_performance.items():
            all_results = [r for results in agents.values() for r in results]
            if len(all_results) < 20:
                continue
            first_half = all_results[:len(all_results)//2]
            second_half = all_results[len(all_results)//2:]
            first_rate = sum(first_half) / len(first_half) if first_half else 1.0
            second_rate = sum(second_half) / len(second_half) if second_half else 1.0
            if first_rate - second_rate > self._TOOL_DEGRADATION_RATE:
                self._suggestions.append(EvolutionSuggestion(
                    trigger=TriggerCondition.TOOL_DEGRADATION,
                    severity=first_rate - second_rate,
                    action="adjust_tool_weight",
                    target=tool_name,
                    reason=f"工具 '{tool_name}' 性能退化: {first_rate:.0%} → {second_rate:.0%}",
                    auto_apply=False,
                ))

    def _check_skill_inaccuracy(self, recent: list[FeedbackSignal]) -> None:
        corrections = [s for s in recent if s.signal_type == FeedbackSignalType.USER_CORRECTION]
        if len(corrections) >= 3:
            self._suggestions.append(EvolutionSuggestion(
                trigger=TriggerCondition.SKILL_INACCURACY,
                severity=min(1.0, len(corrections) / 10.0),
                action="generate_correction_rule",
                target="correction_rules",
                reason=f"用户修正信号频繁: {len(corrections)} 次",
                auto_apply=True,
            ))

    def _check_user_dissatisfaction(self, recent: list[FeedbackSignal]) -> None:
        dissatisfaction = [s for s in recent
                           if s.signal_type == FeedbackSignalType.USER_SATISFACTION and not s.success]
        if len(dissatisfaction) >= 3:
            self._suggestions.append(EvolutionSuggestion(
                trigger=TriggerCondition.USER_DISSATISFACTION,
                severity=min(1.0, len(dissatisfaction) / 5.0),
                action="add_knowledge_nudge",
                target="knowledge_nudges",
                reason=f"用户不满意信号: {len(dissatisfaction)} 次",
                auto_apply=True,
            ))

    def _check_scene_quality_drop(self) -> None:
        for scene, results in self._scene_performance.items():
            if len(results) < 20:
                continue
            first_half = results[:len(results)//2]
            second_half = results[len(results)//2:]
            first_rate = sum(first_half) / len(first_half) if first_half else 1.0
            second_rate = sum(second_half) / len(second_half) if second_half else 1.0
            if first_rate - second_rate > 0.15:
                self._suggestions.append(EvolutionSuggestion(
                    trigger=TriggerCondition.SCENE_QUALITY_DROP,
                    severity=first_rate - second_rate,
                    action="save_state",
                    target=scene,
                    reason=f"场景 '{scene}' 质量下降: {first_rate:.0%} → {second_rate:.0%}",
                    auto_apply=False,
                ))

    def _count_consecutive(self, signals: list[FeedbackSignal], tool_name: str) -> int:
        if not signals:
            return 0
        sorted_signals = sorted(signals, key=lambda s: s.timestamp)
        max_consecutive = 0
        current = 0
        for s in sorted_signals:
            if s.tool_name == tool_name and s.signal_type == FeedbackSignalType.TOOL_FAILURE:
                current += 1
                max_consecutive = max(max_consecutive, current)
            else:
                current = 0
        return max_consecutive
