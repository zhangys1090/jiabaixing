"""灰度发布机制（Canary Release）。

提供基于用户哈希分桶的流量分配、健康监测和自动回滚能力。
集成到 LLMProvider.chat 中，在每次 LLM 调用前决定使用稳定版本还是灰度版本。

Usage:
    manager = CanaryReleaseManager()
    await manager.create_strategy(CanaryStrategy(
        name="v2-rollout",
        stable_version="gpt-4o-mini",
        canary_version="gpt-4o",
        canary_percentage=5,
        rollout_strategy=RolloutStrategy.AUTO,
    ))
    assignment = await manager.select_version("user-123", "v2-rollout")
    version = assignment.selected_version  # "gpt-4o" 或 "gpt-4o-mini"
"""
from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any
from agent.core.logger import log_ignored


class RolloutStrategy(str, Enum):
    """灰度发布模式。

    AUTO: 自动模式，指标超阈值时自动回滚。
    MANUAL: 手动模式，仅响应人工 promote/rollback/pause 操作。
    """

    AUTO = "auto"
    MANUAL = "manual"


class ReleaseStatus(str, Enum):
    """灰度发布状态。

    IDLE: 空闲，未开始灰度（canary_percentage=0）。
    CANARY: 灰度中，按百分比分配流量。
    PROMOTED: 已全量发布，所有流量使用灰度版本。
    ROLLED_BACK: 已回滚，所有流量使用稳定版本。
    PAUSED: 已暂停，灰度分配停止但保留配置以便恢复。
    """

    IDLE = "idle"
    CANARY = "canary"
    PROMOTED = "promoted"
    ROLLED_BACK = "rolled_back"
    PAUSED = "paused"


@dataclass
class CanaryStrategy:
    """灰度发布策略定义。

    描述一个灰度发布任务的完整配置，包括稳定版本、灰度版本、
    流量分配比例和健康检查阈值。

    Attributes:
        name: 策略名称（唯一标识）。
        stable_version: 稳定版本标识（如模型名 "gpt-4o-mini"）。
        canary_version: 灰度版本标识（如模型名 "gpt-4o"）。
        canary_percentage: 灰度流量百分比（0-100）。
        rollout_strategy: 发布模式（AUTO 自动 / MANUAL 手动）。
        target_metric: 监控目标指标名称。
        error_threshold: 错误率阈值（0-1），默认 0.05（5%）。
        latency_threshold: 延迟阈值（毫秒），默认 2000ms。
    """

    name: str
    stable_version: str
    canary_version: str
    canary_percentage: int = 0
    rollout_strategy: RolloutStrategy = RolloutStrategy.MANUAL
    target_metric: str = "error_rate"
    error_threshold: float = 0.05
    latency_threshold: float = 2000.0


@dataclass
class BucketAssignment:
    """用户分桶分配结果。

    记录用户在灰度发布中的分桶信息，确保同一用户始终命中同一版本。

    Attributes:
        user_id: 用户标识。
        stable_version: 稳定版本标识。
        canary_version: 灰度版本标识。
        hash_bucket: 哈希分桶值（0-99）。
        is_canary: 是否命中灰度版本。
    """

    user_id: str
    stable_version: str
    canary_version: str
    hash_bucket: int
    is_canary: bool

    @property
    def selected_version(self) -> str:
        """当前分配的版本标识。

        Returns:
            str: 命中灰度时返回 canary_version，否则返回 stable_version。
        """
        return self.canary_version if self.is_canary else self.stable_version


@dataclass
class HealthMetrics:
    """灰度版本健康指标。

    Attributes:
        error_rate: 错误率（0-1）。
        avg_latency: 平均延迟（毫秒）。
        sample_count: 样本总数。
        feedback_score: 平均反馈评分（None 表示无反馈数据）。
    """

    error_rate: float = 0.0
    avg_latency: float = 0.0
    sample_count: int = 0
    feedback_score: float | None = None


@dataclass
class _OutcomeRecord:
    """单次请求结果记录（内部使用）。

    Attributes:
        success: 请求是否成功。
        latency_ms: 请求延迟（毫秒）。
        feedback_score: 用户反馈评分（可选）。
        timestamp: 记录时间戳。
        is_canary: 是否为灰度版本请求。
    """

    success: bool
    latency_ms: float
    feedback_score: float | None
    timestamp: float
    is_canary: bool


class CanaryReleaseManager:
    """灰度发布管理器。

    管理灰度发布策略，提供基于用户哈希分桶的流量分配、
    健康监测和自动回滚能力。所有状态修改操作使用 asyncio.Lock
    保护，确保并发安全。

    集成方式：在 LLMProvider.chat 调用前调用 select_version 决定版本，
    调用完成后调用 record_outcome 记录结果用于健康监测。
    """

    # 触发自动回滚所需的最小灰度样本数
    _MIN_SAMPLES_FOR_ROLLBACK = 5
    _MIN_TIME_WINDOW_SECONDS = 600
    _MIN_SAMPLES_IN_WINDOW = 3
    _MAX_OUTCOMES_PER_STRATEGY = 1000
    _MAX_ASSIGNMENTS_PER_STRATEGY = 10000

    def __init__(self) -> None:
        """初始化灰度发布管理器。"""
        self._strategies: dict[str, CanaryStrategy] = {}
        self._statuses: dict[str, ReleaseStatus] = {}
        self._assignments: dict[str, dict[str, BucketAssignment]] = {}
        self._outcomes: dict[str, list[_OutcomeRecord]] = {}
        self._lock = asyncio.Lock()

    async def create_strategy(self, strategy: CanaryStrategy) -> None:
        """创建灰度发布策略。

        Args:
            strategy: 灰度策略配置。

        Raises:
            ValueError: 策略名称已存在，或 canary_percentage 不在 0-100 范围内。
        """
        if not 0 <= strategy.canary_percentage <= 100:
            raise ValueError("canary_percentage 必须在 0-100 范围内")
        async with self._lock:
            if strategy.name in self._strategies:
                raise ValueError(f"策略 '{strategy.name}' 已存在")
            self._strategies[strategy.name] = strategy
            self._statuses[strategy.name] = (
                ReleaseStatus.CANARY
                if strategy.canary_percentage > 0
                else ReleaseStatus.IDLE
            )
            self._assignments[strategy.name] = {}
            self._outcomes[strategy.name] = []

    async def update_strategy(
        self, name: str, updates: dict[str, Any]
    ) -> CanaryStrategy:
        """更新灰度发布策略字段。

        Args:
            name: 策略名称。
            updates: 要更新的字段字典（不支持修改 name 字段）。

        Returns:
            CanaryStrategy: 更新后的策略对象。

        Raises:
            KeyError: 策略不存在。
            ValueError: canary_percentage 不在 0-100 范围内。
        """
        if "canary_percentage" in updates and not 0 <= updates["canary_percentage"] <= 100:
            raise ValueError("canary_percentage 必须在 0-100 范围内")
        async with self._lock:
            if name not in self._strategies:
                raise KeyError(f"策略 '{name}' 不存在")
            strategy = self._strategies[name]
            for key, value in updates.items():
                if key == "name":
                    continue  # 不允许通过 update 修改名称
                if hasattr(strategy, key):
                    setattr(strategy, key, value)
            # 同步状态：IDLE/CANARY/PAUSED 状态下根据百分比切换
            if "canary_percentage" in updates:
                current_status = self._statuses.get(name, ReleaseStatus.IDLE)
                if current_status in (ReleaseStatus.IDLE, ReleaseStatus.CANARY, ReleaseStatus.PAUSED):
                    self._statuses[name] = (
                        ReleaseStatus.CANARY
                        if strategy.canary_percentage > 0
                        else ReleaseStatus.IDLE
                    )
            return strategy

    async def delete_strategy(self, name: str) -> None:
        """删除灰度发布策略。

        Args:
            name: 策略名称。

        Raises:
            KeyError: 策略不存在。
        """
        async with self._lock:
            if name not in self._strategies:
                raise KeyError(f"策略 '{name}' 不存在")
            del self._strategies[name]
            self._statuses.pop(name, None)
            self._assignments.pop(name, None)
            self._outcomes.pop(name, None)

    async def select_version(
        self, user_id: str, strategy_name: str
    ) -> BucketAssignment:
        """基于哈希分桶选择版本。

        使用 SHA-256 对 "{user_id}:{strategy_name}" 哈希后取模 100 得到分桶值，
        确保同一用户始终命中同一版本。根据策略状态决定分配：
        - PROMOTED: 全部分配到灰度版本
        - ROLLED_BACK / PAUSED / IDLE: 全部分配到稳定版本
        - CANARY: 按百分比哈希分桶

        Args:
            user_id: 用户标识。
            strategy_name: 策略名称。

        Returns:
            BucketAssignment: 分桶分配结果。

        Raises:
            KeyError: 策略不存在。
        """
        async with self._lock:
            if strategy_name not in self._strategies:
                raise KeyError(f"策略 '{strategy_name}' 不存在")
            strategy = self._strategies[strategy_name]
            status = self._statuses.get(strategy_name, ReleaseStatus.IDLE)

            # 哈希分桶：SHA-256 取模 100
            bucket = int(
                hashlib.sha256(
                    f"{user_id}:{strategy_name}".encode()
                ).hexdigest(),
                16,
            ) % 100

            if status == ReleaseStatus.PROMOTED:
                is_canary = True
            elif status in (
                ReleaseStatus.ROLLED_BACK,
                ReleaseStatus.PAUSED,
                ReleaseStatus.IDLE,
            ):
                is_canary = False
            else:  # CANARY 状态：按百分比分桶
                is_canary = bucket < strategy.canary_percentage

            assignment = BucketAssignment(
                user_id=user_id,
                stable_version=strategy.stable_version,
                canary_version=strategy.canary_version,
                hash_bucket=bucket,
                is_canary=is_canary,
            )
            assignments = self._assignments.setdefault(strategy_name, {})
            assignments[user_id] = assignment
            if len(assignments) > self._MAX_ASSIGNMENTS_PER_STRATEGY:
                oldest_keys = list(assignments.keys())[: len(assignments) - self._MAX_ASSIGNMENTS_PER_STRATEGY]
                for k in oldest_keys:
                    assignments.pop(k, None)
            return assignment

    async def record_outcome(
        self,
        user_id: str,
        strategy_name: str,
        success: bool,
        latency_ms: float,
        feedback_score: float | None = None,
    ) -> None:
        """记录请求结果用于健康监测。

        记录灰度用户的请求结果，并在 AUTO 模式下自动检查健康指标，
        超过阈值时触发自动回滚。仅灰度版本（is_canary=True）的样本
        会纳入健康指标统计。

        Args:
            user_id: 用户标识。
            strategy_name: 策略名称。
            success: 请求是否成功。
            latency_ms: 请求延迟（毫秒）。
            feedback_score: 用户反馈评分（可选）。

        Raises:
            KeyError: 策略不存在。
        """
        async with self._lock:
            if strategy_name not in self._strategies:
                raise KeyError(f"策略 '{strategy_name}' 不存在")

            strategy = self._strategies[strategy_name]
            # 查找用户分桶分配，判断是否为灰度样本
            assignment = self._assignments.get(strategy_name, {}).get(user_id)
            is_canary = assignment.is_canary if assignment else False

            record = _OutcomeRecord(
                success=success,
                latency_ms=latency_ms,
                feedback_score=feedback_score,
                timestamp=time.time(),
                is_canary=is_canary,
            )
            outcomes = self._outcomes.setdefault(strategy_name, [])
            outcomes.append(record)
            if len(outcomes) > self._MAX_OUTCOMES_PER_STRATEGY:
                self._outcomes[strategy_name] = outcomes[-self._MAX_OUTCOMES_PER_STRATEGY:]

            # AUTO 模式下自动检查健康并回滚
            if strategy.rollout_strategy == RolloutStrategy.AUTO:
                status = self._statuses.get(strategy_name, ReleaseStatus.IDLE)
                if status == ReleaseStatus.CANARY:
                    metrics = self._compute_health_locked(strategy_name)
                    should_rollback = False
                    if metrics.sample_count >= self._MIN_SAMPLES_FOR_ROLLBACK:
                        if (
                            metrics.error_rate > strategy.error_threshold
                            or metrics.avg_latency > strategy.latency_threshold
                        ):
                            should_rollback = True
                    else:
                        now = time.time()
                        canary_outcomes = [
                            o for o in self._outcomes.get(strategy_name, [])
                            if o.is_canary and (now - o.timestamp) < self._MIN_TIME_WINDOW_SECONDS
                        ]
                        if len(canary_outcomes) >= self._MIN_SAMPLES_IN_WINDOW:
                            window_errors = sum(1 for o in canary_outcomes if not o.success)
                            if window_errors / len(canary_outcomes) > strategy.error_threshold:
                                should_rollback = True
                    if should_rollback:
                        self._statuses[strategy_name] = ReleaseStatus.ROLLED_BACK

    def check_health(self, strategy_name: str) -> HealthMetrics:
        """检查灰度版本健康指标。

        Args:
            strategy_name: 策略名称。

        Returns:
            HealthMetrics: 健康指标（仅统计灰度用户的样本）。

        Raises:
            KeyError: 策略不存在。
        """
        if strategy_name not in self._strategies:
            raise KeyError(f"策略 '{strategy_name}' 不存在")
        return self._compute_health_locked(strategy_name)

    def _compute_health_locked(self, strategy_name: str) -> HealthMetrics:
        """计算健康指标（调用方需持有锁或确保无并发修改）。

        Args:
            strategy_name: 策略名称。

        Returns:
            HealthMetrics: 仅统计灰度样本的健康指标。
        """
        outcomes = self._outcomes.get(strategy_name, [])
        canary_outcomes = [o for o in outcomes if o.is_canary]
        if not canary_outcomes:
            return HealthMetrics()

        total = len(canary_outcomes)
        failed = sum(1 for o in canary_outcomes if not o.success)
        avg_latency = sum(o.latency_ms for o in canary_outcomes) / total

        feedback_scores = [
            o.feedback_score for o in canary_outcomes if o.feedback_score is not None
        ]
        feedback_score = (
            sum(feedback_scores) / len(feedback_scores) if feedback_scores else None
        )

        return HealthMetrics(
            error_rate=failed / total,
            avg_latency=avg_latency,
            sample_count=total,
            feedback_score=feedback_score,
        )

    async def promote(self, strategy_name: str) -> None:
        """全量发布：将所有流量切换到灰度版本。

        Args:
            strategy_name: 策略名称。

        Raises:
            KeyError: 策略不存在。
        """
        async with self._lock:
            if strategy_name not in self._strategies:
                raise KeyError(f"策略 '{strategy_name}' 不存在")
            self._strategies[strategy_name].canary_percentage = 100
            self._statuses[strategy_name] = ReleaseStatus.PROMOTED

    async def rollback(self, strategy_name: str) -> None:
        """立即回滚：将所有流量切换到稳定版本。

        Args:
            strategy_name: 策略名称。

        Raises:
            KeyError: 策略不存在。
        """
        async with self._lock:
            if strategy_name not in self._strategies:
                raise KeyError(f"策略 '{strategy_name}' 不存在")
            self._strategies[strategy_name].canary_percentage = 0
            self._statuses[strategy_name] = ReleaseStatus.ROLLED_BACK

    async def pause(self, strategy_name: str) -> None:
        """暂停灰度：停止灰度版本分配，保留配置以便恢复。

        与 rollback 的区别：pause 保留 canary_percentage 配置，
        后续可通过 update_strategy 恢复灰度；rollback 将百分比清零。

        Args:
            strategy_name: 策略名称。

        Raises:
            KeyError: 策略不存在。
        """
        async with self._lock:
            if strategy_name not in self._strategies:
                raise KeyError(f"策略 '{strategy_name}' 不存在")
            self._statuses[strategy_name] = ReleaseStatus.PAUSED

    def get_status(self, strategy_name: str) -> ReleaseStatus:
        """获取策略当前状态。

        Args:
            strategy_name: 策略名称。

        Returns:
            ReleaseStatus: 发布状态。

        Raises:
            KeyError: 策略不存在。
        """
        if strategy_name not in self._strategies:
            raise KeyError(f"策略 '{strategy_name}' 不存在")
        return self._statuses.get(strategy_name, ReleaseStatus.IDLE)

    def list_strategies(self) -> list[CanaryStrategy]:
        """列出所有灰度发布策略。

        Returns:
            list[CanaryStrategy]: 策略列表。
        """
        return list(self._strategies.values())


async def safe_record_outcome(
    manager: CanaryReleaseManager | None,
    user_id: str | None,
    strategy_name: str | None,
    success: bool,
    latency_ms: float,
) -> None:
    """记录灰度发布请求结果（失败时静默降级，不影响主流程）.

    Args:
        manager: 灰度发布管理器实例，None 时直接返回.
        user_id: 用户标识.
        strategy_name: 策略名称.
        success: 请求是否成功.
        latency_ms: 请求延迟（毫秒）.
    """
    if not manager or not user_id or not strategy_name:
        return
    try:
        await manager.record_outcome(
            user_id, strategy_name, success=success, latency_ms=latency_ms
        )
    except Exception as _exc:
        log_ignored(None, "canary_release.safe_record_outcome", _exc)
