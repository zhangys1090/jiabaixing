"""持续反馈闭环（ContinuousFeedbackLoop）。

将用户反馈转化为学习信号，驱动进化引擎持续优化：

工作流:
    1. 采集用户反馈（positive/negative/correction/reuse）
    2. 转化为学习信号（LearningSignal，含质量分数）
    3. 写入 EvolutionEngine 的训练数据（collect_feedback）
    4. 触发策略优化（阈值触发：每 N 条反馈或超过时间窗口）
    5. 应用优化结果到运行时（通过 CanaryReleaseManager）

设计原则:
    - 复用现有 EvolutionEngine.collect_feedback，不重复造轮子
    - 失败静默：进化引擎缺失或失败时不影响反馈采集
    - 阈值触发：避免每条反馈都触发昂贵的进化计算

Usage:
    from agent.evolution.feedback_loop import ContinuousFeedbackLoop

    loop = ContinuousFeedbackLoop(
        evolution_engine=engine.evolution,
        canary_manager=engine.canary_manager,
        optimize_threshold=100,
    )
    await loop.collect_feedback(session_id="s1", feedback_type="positive")
    result = await loop.check_and_optimize()
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from agent.core.logger import StructuredLogger

log = StructuredLogger("feedback_loop")

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

        将学习信号转化为 FeedbackSignal 并调用 EvolutionEngine.collect_feedback。
        进化引擎缺失或失败时静默降级，不抛异常。

        Args:
            signal: 学习信号。
        """
        if self._evolution_engine is None:
            log.debug("EvolutionEngine 未配置，跳过写入")
            return

        try:
            from agent.evolution.types import EvolutionCause, FeedbackSignal

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

            fb_signal = FeedbackSignal(
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
