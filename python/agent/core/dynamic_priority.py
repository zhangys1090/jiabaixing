"""动态优先级评分 — 多因子任务优先级排序。

综合考虑以下因子:
    1. 紧急度 (urgency): 基于截止日期，越近越紧急
    2. 影响度 (impact): 基于标签数量/关联人数
    3. 等待时间 (wait_time): 等待越久优先级越高
    4. 基础优先级 (base_priority): 用户/系统设定的优先级

最终评分 = w1*urgency + w2*impact + w3*wait_time + w4*base_priority

Usage:
    scorer = DynamicPriorityScorer()
    score = scorer.score(task)
    ranked = scorer.rank([task1, task2, task3])
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("dynamic_priority")



class Priority(IntEnum):
    CRITICAL = 4
    HIGH = 3
    MEDIUM = 2
    LOW = 1
    NONE = 0


@dataclass
class TaskInfo:
    """任务信息，用于动态优先级评分的输入。

    Attributes:
        title: 任务标题（同时作为缓存键）。
        due_date: 截止日期（Unix 时间戳），None 表示无截止日期。
        tags: 标签列表，标签越多影响度越高。
        created_at: 创建时间（Unix 时间戳），用于计算等待时间。
        base_priority: 基础优先级（用户/系统设定）。
        assignee_count: 关联人数，人数越多影响度越高。
        metadata: 扩展元数据。
    """

    title: str
    due_date: float | None = None
    tags: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    base_priority: Priority = Priority.MEDIUM
    assignee_count: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PriorityScore:
    """优先级评分结果。

    Attributes:
        task_title: 任务标题。
        total: 综合评分（0-1，越高越优先）。
        urgency: 紧急度因子（0-1）。
        impact: 影响度因子（0-1）。
        wait_time: 等待时间因子（0-1）。
        base: 基础优先级因子（0-1）。
        priority_level: 离散优先级等级。
    """

    task_title: str
    total: float
    urgency: float
    impact: float
    wait_time: float
    base: float
    priority_level: Priority

    def __lt__(self, other: PriorityScore) -> bool:
        return self.total < other.total


@dataclass
class ScorerConfig:
    """评分器配置。

    Attributes:
        w_urgency: 紧急度权重（默认 0.35）。
        w_impact: 影响度权重（默认 0.25）。
        w_wait_time: 等待时间权重（默认 0.20）。
        w_base: 基础优先级权重（默认 0.20）。
        urgency_half_life_hours: 紧急度半衰期（小时），越近截止日期衰减越快。
        max_wait_hours: 最大等待时间（小时），超过此值 wait_time 因子为 1.0。
    """

    w_urgency: float = 0.35
    w_impact: float = 0.25
    w_wait_time: float = 0.20
    w_base: float = 0.20
    urgency_half_life_hours: float = 24.0
    max_wait_hours: float = 168.0


class DynamicPriorityScorer:
    """动态优先级评分器。

    综合紧急度、影响度、等待时间和基础优先级四个因子，
    计算任务的综合优先级评分。支持评分缓存和批量排序。

    Usage:
        scorer = DynamicPriorityScorer()
        score = scorer.score(TaskInfo(title="紧急任务", due_date=time.time()+3600))
        ranked = scorer.rank([task1, task2, task3])
    """

    _CACHE_MAX = 500

    def __init__(self, config: ScorerConfig | None = None) -> None:
        self._config = config or ScorerConfig()
        self._score_cache: dict[str, PriorityScore] = {}

    def _trim_cache(self) -> None:
        if len(self._score_cache) <= self._CACHE_MAX:
            return
        sorted_items = sorted(
            self._score_cache.items(),
            key=lambda x: x[1].total,
        )
        to_remove = sorted_items[: len(self._score_cache) - (self._CACHE_MAX * 3 // 4)]
        for key, _ in to_remove:
            del self._score_cache[key]

    def _calc_urgency(self, task: TaskInfo) -> float:
        """计算紧急度因子（0-1）。

        基于截止日期的指数衰减：距截止日期越近，紧急度越高。
        无截止日期时返回默认值 0.3，已过期时返回 1.0。

        Args:
            task: 任务信息。

        Returns:
            float: 紧急度因子（0-1）。
        """
        if task.due_date is None:
            return 0.3
        hours_remaining = (task.due_date - time.time()) / 3600.0
        if hours_remaining <= 0:
            return 1.0
        half_life = self._config.urgency_half_life_hours
        return math.exp(-math.log(2) * hours_remaining / half_life)

    def _calc_impact(self, task: TaskInfo) -> float:
        """计算影响度因子（0-1）。

        基于标签数量（权重 0.6）和关联人数（权重 0.4）的加权平均。

        Args:
            task: 任务信息。

        Returns:
            float: 影响度因子（0-1）。
        """
        tag_score = min(len(task.tags) / 5.0, 1.0)
        assignee_score = min(task.assignee_count / 3.0, 1.0)
        return (tag_score * 0.6 + assignee_score * 0.4)

    def _calc_wait_time(self, task: TaskInfo) -> float:
        """计算等待时间因子（0-1）。

        等待时间越长，因子越高。超过 max_wait_hours 后为 1.0。

        Args:
            task: 任务信息。

        Returns:
            float: 等待时间因子（0-1）。
        """
        hours_waited = (time.time() - task.created_at) / 3600.0
        return min(hours_waited / self._config.max_wait_hours, 1.0)

    def _calc_base(self, task: TaskInfo) -> float:
        """计算基础优先级因子（0-1）。

        将离散优先级归一化到 0-1 范围。

        Args:
            task: 任务信息。

        Returns:
            float: 基础优先级因子（0-1）。
        """
        return task.base_priority / Priority.CRITICAL

    def _determine_level(self, total: float) -> Priority:
        """根据综合评分确定离散优先级等级。

        Args:
            total: 综合评分（0-1）。

        Returns:
            Priority: 离散优先级等级。
        """
        if total >= 0.8:
            return Priority.CRITICAL
        if total >= 0.6:
            return Priority.HIGH
        if total >= 0.4:
            return Priority.MEDIUM
        if total >= 0.2:
            return Priority.LOW
        return Priority.NONE

    def score(self, task: TaskInfo) -> PriorityScore:
        """计算单个任务的优先级评分。

        Args:
            task: 任务信息。

        Returns:
            PriorityScore: 评分结果（同时缓存）。
        """
        urgency = self._calc_urgency(task)
        impact = self._calc_impact(task)
        wait_time = self._calc_wait_time(task)
        base = self._calc_base(task)

        total = (
            self._config.w_urgency * urgency
            + self._config.w_impact * impact
            + self._config.w_wait_time * wait_time
            + self._config.w_base * base
        )

        ps = PriorityScore(
            task_title=task.title,
            total=round(total, 4),
            urgency=round(urgency, 4),
            impact=round(impact, 4),
            wait_time=round(wait_time, 4),
            base=round(base, 4),
            priority_level=self._determine_level(total),
        )
        self._score_cache[task.title] = ps
        self._trim_cache()
        return ps

    def rank(self, tasks: list[TaskInfo]) -> list[PriorityScore]:
        """批量评分并按优先级降序排列。

        Args:
            tasks: 任务列表。

        Returns:
            list[PriorityScore]: 按综合评分降序排列的评分结果。
        """
        scores = [self.score(t) for t in tasks]
        return sorted(scores, key=lambda s: s.total, reverse=True)

    def get_score(self, task_title: str) -> PriorityScore | None:
        """从缓存获取评分结果。

        Args:
            task_title: 任务标题（缓存键）。

        Returns:
            PriorityScore | None: 缓存的评分结果，不存在时返回 None。
        """
        return self._score_cache.get(task_title)

    def clear_cache(self) -> None:
        """清空评分缓存。"""
        self._score_cache.clear()
