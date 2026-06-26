"""增量重规划模块。

当执行过程中遇到变化时，只调整受影响的部分，
而不是全量重新规划，提高规划效率。

主要功能：
- 检测计划变更影响范围
- 增量调整计划步骤
- 保持未受影响步骤的稳定性
- 计划变更回滚机制

Usage:
    planner = IncrementalPlanner()
    new_plan = planner.incremental_replan(original_plan, changed_step, reason)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("incremental_planner")


@dataclass
class PlanStep:
    """计划步骤。"""

    step_id: str
    description: str
    tool_name: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    status: str = "pending"  # pending, running, completed, failed, skipped
    dependencies: list[str] = field(default_factory=list)
    result: str = ""
    order: int = 0


@dataclass
class PlanChange:
    """计划变更。"""

    change_type: str  # "add", "remove", "modify", "reorder"
    step_id: str
    old_value: Any = None
    new_value: Any = None
    reason: str = ""
    timestamp: float = 0.0


@dataclass
class IncrementalReplanResult:
    """增量重规划结果。"""

    success: bool
    new_plan: list[PlanStep]
    changes: list[PlanChange] = field(default_factory=list)
    affected_steps: list[str] = field(default_factory=list)
    preserved_steps: int = 0
    reason: str = ""
    duration_ms: float = 0.0


class IncrementalPlanner:
    """增量重规划器。

    当执行过程中遇到变化时，只调整受影响的部分，
    而不是全量重新规划，提高规划效率和稳定性。
    """

    def __init__(
        self,
        max_changes_per_replan: int = 5,
        preserve_completed_steps: bool = True,
        enabled: bool = True,
    ) -> None:
        """初始化增量规划器。

        Args:
            max_changes_per_replan: 每次重规划的最大变更数。
            preserve_completed_steps: 是否保留已完成步骤。
            enabled: 是否启用。
        """
        self._max_changes = max_changes_per_replan
        self._preserve_completed = preserve_completed_steps
        self._enabled = enabled

        # 统计
        self._stats = {
            "total_replans": 0,
            "successful_replans": 0,
            "total_steps_preserved": 0,
            "total_steps_modified": 0,
            "avg_changes_per_replan": 0.0,
        }

        log.info(
            "IncrementalPlanner initialized",
            enabled=enabled,
            max_changes=max_changes_per_replan,
        )

    def incremental_replan(
        self,
        original_plan: list[PlanStep],
        trigger_step_id: str,
        reason: str = "",
        new_steps: list[PlanStep] | None = None,
    ) -> IncrementalReplanResult:
        """执行增量重规划。

        Args:
            original_plan: 原始计划。
            trigger_step_id: 触发重规划的步骤ID。
            reason: 重规划原因。
            new_steps: 新的步骤（可选）。

        Returns:
            IncrementalReplanResult: 重规划结果。
        """
        if not self._enabled:
            return IncrementalReplanResult(
                success=False,
                new_plan=original_plan,
                reason="增量重规划未启用",
            )

        start_time = time.time()
        self._stats["total_replans"] += 1

        try:
            # 1. 找到触发步骤的位置
            trigger_index = self._find_step_index(original_plan, trigger_step_id)
            if trigger_index is None:
                return IncrementalReplanResult(
                    success=False,
                    new_plan=original_plan,
                    reason=f"触发步骤不存在: {trigger_step_id}",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 2. 分析影响范围
            affected_ids = self._analyze_impact(original_plan, trigger_step_id)

            # 3. 保留未受影响的步骤
            preserved_steps = []
            affected_steps = []
            for step in original_plan:
                if step.step_id in affected_ids:
                    affected_steps.append(step)
                else:
                    preserved_steps.append(step)

            # 4. 重新规划受影响的部分
            if new_steps:
                # 使用提供的新步骤
                replanned_steps = new_steps
            else:
                # 简单策略：标记失败步骤，后续步骤重新排序
                replanned_steps = self._replan_affected_steps(
                    affected_steps, trigger_step_id, reason
                )

            # 5. 合并计划
            new_plan = self._merge_plan(preserved_steps, replanned_steps, trigger_index)

            # 6. 记录变更
            changes = self._record_changes(original_plan, new_plan, reason)

            # 更新统计
            self._stats["successful_replans"] += 1
            self._stats["total_steps_preserved"] += len(preserved_steps)
            self._stats["total_steps_modified"] += len(affected_steps)

            result = IncrementalReplanResult(
                success=True,
                new_plan=new_plan,
                changes=changes,
                affected_steps=list(affected_ids),
                preserved_steps=len(preserved_steps),
                reason=reason,
                duration_ms=(time.time() - start_time) * 1000,
            )

            log.info(
                "Incremental replan completed",
                trigger=trigger_step_id,
                preserved=len(preserved_steps),
                affected=len(affected_steps),
                changes=len(changes),
            )

            return result

        except Exception as e:
            log.error("Incremental replan failed", error=str(e))
            return IncrementalReplanResult(
                success=False,
                new_plan=original_plan,
                reason=f"重规划失败: {str(e)}",
                duration_ms=(time.time() - start_time) * 1000,
            )

    def _find_step_index(
        self, plan: list[PlanStep], step_id: str
    ) -> int | None:
        """查找步骤在计划中的索引。

        Args:
            plan: 计划列表。
            step_id: 步骤ID。

        Returns:
            int | None: 索引，不存在返回None。
        """
        for i, step in enumerate(plan):
            if step.step_id == step_id:
                return i
        return None

    def _analyze_impact(
        self, plan: list[PlanStep], trigger_step_id: str
    ) -> set[str]:
        """分析变更的影响范围。

        找出所有依赖于触发步骤的后续步骤。

        Args:
            plan: 计划列表。
            trigger_step_id: 触发步骤ID。

        Returns:
            set[str]: 受影响的步骤ID集合。
        """
        affected = {trigger_step_id}

        # 构建依赖图
        dependents: dict[str, list[str]] = {}
        for step in plan:
            for dep in step.dependencies:
                if dep not in dependents:
                    dependents[dep] = []
                dependents[dep].append(step.step_id)

        # 广度优先搜索所有受影响的步骤
        queue = [trigger_step_id]
        while queue:
            current = queue.pop(0)
            if current in dependents:
                for dep in dependents[current]:
                    if dep not in affected:
                        affected.add(dep)
                        queue.append(dep)

        # 如果保留已完成步骤，从受影响集合中移除
        if self._preserve_completed:
            completed_ids = {
                s.step_id for s in plan if s.status == "completed"
            }
            affected = affected - completed_ids

        return affected

    def _replan_affected_steps(
        self,
        affected_steps: list[PlanStep],
        trigger_step_id: str,
        reason: str,
    ) -> list[PlanStep]:
        """重新规划受影响的步骤。

        简单实现：标记触发步骤为需要重试，后续步骤保持不变但重置状态。

        Args:
            affected_steps: 受影响的步骤列表。
            trigger_step_id: 触发步骤ID。
            reason: 原因。

        Returns:
            list[PlanStep]: 重新规划后的步骤。
        """
        replanned = []
        for step in affected_steps:
            new_step = PlanStep(
                step_id=f"{step.step_id}-replan-{int(time.time())}",
                description=f"[重规划] {step.description}",
                tool_name=step.tool_name,
                params=dict(step.params),
                status="pending",
                dependencies=[d for d in step.dependencies if d != trigger_step_id],
                result="",
                order=step.order,
            )

            # 触发步骤标记为重试
            if step.step_id == trigger_step_id:
                new_step.description = f"[重试] {step.description} ({reason})"
                new_step.params["_retry_reason"] = reason

            replanned.append(new_step)

        # 重新排序
        replanned.sort(key=lambda s: s.order)

        return replanned

    def _merge_plan(
        self,
        preserved: list[PlanStep],
        replanned: list[PlanStep],
        trigger_index: int,
    ) -> list[PlanStep]:
        """合并保留的步骤和重新规划的步骤。

        Args:
            preserved: 保留的步骤。
            replanned: 重新规划的步骤。
            trigger_index: 触发索引。

        Returns:
            list[PlanStep]: 合并后的计划。
        """
        # 按原始顺序合并
        # 保留触发索引之前的步骤
        before_trigger = [s for s in preserved if s.order < trigger_index]
        before_trigger.sort(key=lambda s: s.order)

        # 保留触发索引之后的未受影响步骤
        after_trigger = [s for s in preserved if s.order > trigger_index]
        after_trigger.sort(key=lambda s: s.order)

        # 重新设置顺序
        order = 0
        result = []

        for step in before_trigger:
            step.order = order
            result.append(step)
            order += 1

        for step in replanned:
            step.order = order
            result.append(step)
            order += 1

        for step in after_trigger:
            step.order = order
            result.append(step)
            order += 1

        return result

    def _record_changes(
        self,
        original: list[PlanStep],
        new: list[PlanStep],
        reason: str,
    ) -> list[PlanChange]:
        """记录计划变更。

        Args:
            original: 原始计划。
            new: 新计划。
            reason: 原因。

        Returns:
            list[PlanChange]: 变更列表。
        """
        changes: list[PlanChange] = []
        original_ids = {s.step_id for s in original}
        new_ids = {s.step_id for s in new}

        # 新增的步骤
        added = new_ids - original_ids
        for step_id in added:
            step = next(s for s in new if s.step_id == step_id)
            changes.append(PlanChange(
                change_type="add",
                step_id=step_id,
                new_value=step.description,
                reason=reason,
                timestamp=time.time(),
            ))

        # 删除的步骤
        removed = original_ids - new_ids
        for step_id in removed:
            step = next(s for s in original if s.step_id == step_id)
            changes.append(PlanChange(
                change_type="remove",
                step_id=step_id,
                old_value=step.description,
                reason=reason,
                timestamp=time.time(),
            ))

        # 修改的步骤（相同ID但内容不同）
        common = original_ids & new_ids
        for step_id in common:
            orig_step = next(s for s in original if s.step_id == step_id)
            new_step = next(s for s in new if s.step_id == step_id)

            if orig_step.status != new_step.status:
                changes.append(PlanChange(
                    change_type="modify",
                    step_id=step_id,
                    old_value=f"status={orig_step.status}",
                    new_value=f"status={new_step.status}",
                    reason=reason,
                    timestamp=time.time(),
                ))

        # 限制变更数量
        if len(changes) > self._max_changes:
            changes = changes[: self._max_changes]

        return changes

    def get_stats(self) -> dict[str, Any]:
        """获取统计信息。

        Returns:
            dict: 统计信息。
        """
        total = self._stats["total_replans"]
        avg_changes = (
            self._stats["total_steps_modified"] / total if total > 0 else 0.0
        )

        return {
            "total_replans": total,
            "successful_replans": self._stats["successful_replans"],
            "success_rate": (
                self._stats["successful_replans"] / total if total > 0 else 0.0
            ),
            "total_steps_preserved": self._stats["total_steps_preserved"],
            "total_steps_modified": self._stats["total_steps_modified"],
            "avg_preserved_per_replan": (
                self._stats["total_steps_preserved"] / total if total > 0 else 0.0
            ),
            "avg_changes_per_replan": avg_changes,
            "enabled": self._enabled,
        }

    def reset_stats(self) -> None:
        """重置统计。"""
        self._stats = {
            "total_replans": 0,
            "successful_replans": 0,
            "total_steps_preserved": 0,
            "total_steps_modified": 0,
            "avg_changes_per_replan": 0.0,
        }

    @property
    def enabled(self) -> bool:
        """是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态。"""
        self._enabled = value
        log.info("IncrementalPlanner enabled state changed", enabled=value)
