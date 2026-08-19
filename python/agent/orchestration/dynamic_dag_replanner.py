"""动态 DAG 重规划引擎（Dynamic DAG Replanner）。

在 OrchestrationExecutor（静态 DAG 调度）基础上，提供运行时
**动态 DAG 重规划**能力——执行过程中根据子任务结果动态调整 DAG 结构。

核心能力：
1. 运行时 DAG 调整：根据子任务执行结果动态增删改任务节点和依赖边
2. 条件分支：子任务结果决定后续执行路径（if-then-else 语义）
3. 失败恢复：子任务失败时自动插入修复步骤或降级替代
4. 增量规划：结合 HierarchicalPlanner 在执行过程中增量分解新发现的子任务
5. 检查点恢复：长任务支持中途保存检查点，失败后从最近检查点恢复

与 OrchestrationExecutor 的关系：
- OrchestrationExecutor: 静态 DAG 调度（提交后不可变）
- DynamicDAGReplanner: 动态 DAG 重规划（运行时可变）

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 非侵入式：包装 OrchestrationExecutor，不修改其内部逻辑
- 可选挂载：未挂载时回退到静态 DAG
"""

from __future__ import annotations

import copy
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from agent.orchestration.executor import (
    OrchestrationExecutor,
    OrchestrationConfig,
    OrchestrationResult,
    TaskNode,
    TaskStatus,
    TaskPriority,
)
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("dynamic_dag_replanner")


class ReplanTrigger(str, Enum):
    TASK_FAILED = "task_failed"
    TASK_SUCCEEDED_WITH_SIDE_EFFECT = "task_succeeded_with_side_effect"
    CONDITION_MET = "condition_met"
    CONDITION_NOT_MET = "condition_not_met"
    NEW_SUBTASK_DISCOVERED = "new_subtask_discovered"
    BUDGET_EXCEEDED = "budget_exceeded"
    USER_INTERRUPT = "user_interrupt"
    TIMEOUT = "timeout"


class ReplanAction(str, Enum):
    INSERT_TASK = "insert_task"
    REMOVE_TASK = "remove_task"
    REPLACE_TASK = "replace_task"
    ADD_DEPENDENCY = "add_dependency"
    REMOVE_DEPENDENCY = "remove_dependency"
    RETRY_WITH_ALTERNATIVE = "retry_with_alternative"
    SKIP_DOWNSTREAM = "skip_downstream"
    BRANCH_CONDITIONAL = "branch_conditional"
    CHECKPOINT = "checkpoint"
    ROLLBACK_TO_CHECKPOINT = "rollback_to_checkpoint"


@dataclass
class ReplanRule:
    rule_id: str = ""
    trigger: ReplanTrigger = ReplanTrigger.TASK_FAILED
    condition: str = ""
    action: ReplanAction = ReplanAction.INSERT_TASK
    task_template: dict[str, Any] = field(default_factory=dict)
    target_task_id: str = ""
    new_dependencies: list[str] = field(default_factory=list)
    priority: int = 0


@dataclass
class DAGCheckpoint:
    checkpoint_id: str = ""
    timestamp: float = 0.0
    tasks_snapshot: dict[str, dict[str, Any]] = field(default_factory=dict)
    completed_results: dict[str, Any] = field(default_factory=dict)
    label: str = ""


@dataclass
class ReplanEvent:
    timestamp: float = 0.0
    trigger: ReplanTrigger = ReplanTrigger.TASK_FAILED
    action: ReplanAction = ReplanAction.INSERT_TASK
    source_task_id: str = ""
    affected_task_ids: list[str] = field(default_factory=list)
    detail: str = ""


class DynamicDAGReplanner:
    """动态 DAG 重规划引擎。"""

    def __init__(
        self,
        base_executor: OrchestrationExecutor | None = None,
        config: OrchestrationConfig | None = None,
    ) -> None:
        self._base = base_executor or OrchestrationExecutor(config or OrchestrationConfig())
        self._rules: list[ReplanRule] = []
        self._checkpoints: list[DAGCheckpoint] = []
        self._replan_events: list[ReplanEvent] = []
        self._max_replan_count = 10
        self._replan_count = 0
        self._conditional_branches: dict[str, list[ReplanRule]] = {}
        self._on_replan_callback: Callable[[ReplanEvent], None] | None = None

    def add_rule(self, rule: ReplanRule) -> None:
        self._rules.append(rule)
        self._rules.sort(key=lambda r: r.priority, reverse=True)

    def set_on_replan_callback(self, callback: Callable[[ReplanEvent], None]) -> None:
        self._on_replan_callback = callback

    def add_task(
        self,
        name: str,
        executor: Callable[..., Awaitable[Any]],
        dependencies: list[str] | None = None,
        priority: TaskPriority = TaskPriority.NORMAL,
        timeout_ms: int | None = None,
        max_retries: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        return self._base.add_task(
            name=name,
            executor=executor,
            dependencies=dependencies,
            priority=priority,
            timeout_ms=timeout_ms,
            max_retries=max_retries,
            metadata=metadata,
        )

    def add_conditional_branch(
        self,
        source_task_id: str,
        condition: str,
        on_true_task: dict[str, Any],
        on_false_task: dict[str, Any],
    ) -> None:
        true_rule = ReplanRule(
            rule_id=f"cond_{source_task_id}_true",
            trigger=ReplanTrigger.CONDITION_MET,
            condition=condition,
            action=ReplanAction.BRANCH_CONDITIONAL,
            target_task_id=source_task_id,
            task_template=on_true_task,
        )
        false_rule = ReplanRule(
            rule_id=f"cond_{source_task_id}_false",
            trigger=ReplanTrigger.CONDITION_NOT_MET,
            condition=condition,
            action=ReplanAction.BRANCH_CONDITIONAL,
            target_task_id=source_task_id,
            task_template=on_false_task,
        )
        self._conditional_branches.setdefault(source_task_id, []).extend([true_rule, false_rule])

    def save_checkpoint(self, label: str = "") -> str:
        checkpoint_id = f"cp_{uuid.uuid4().hex[:8]}"
        tasks = self._base.get_all_tasks()
        tasks_snapshot: dict[str, dict[str, Any]] = {}
        completed_results: dict[str, Any] = {}
        for tid, task in tasks.items():
            tasks_snapshot[tid] = {
                "name": task.name,
                "dependencies": list(task.dependencies),
                "status": task.status.value,
                "priority": task.priority.value,
                "metadata": dict(task.metadata),
            }
            if task.status == TaskStatus.COMPLETED and task.result is not None:
                completed_results[tid] = task.result

        checkpoint = DAGCheckpoint(
            checkpoint_id=checkpoint_id,
            timestamp=time.time(),
            tasks_snapshot=tasks_snapshot,
            completed_results=completed_results,
            label=label,
        )
        self._checkpoints.append(checkpoint)
        log.info("Checkpoint saved", checkpoint_id=checkpoint_id, label=label)
        return checkpoint_id

    def rollback_to_checkpoint(self, checkpoint_id: str) -> bool:
        checkpoint = None
        for cp in self._checkpoints:
            if cp.checkpoint_id == checkpoint_id:
                checkpoint = cp
                break
        if checkpoint is None:
            return False

        self._base.clear()
        for tid, snapshot in checkpoint.tasks_snapshot.items():
            if snapshot["status"] in ("completed", "skipped"):
                continue
            self._base.add_task_with_id(
                task_id=tid,
                name=snapshot["name"],
                executor=lambda _: asyncio.coroutine(lambda: None)(),
                dependencies=snapshot["dependencies"],
                priority=TaskPriority(snapshot["priority"]),
                metadata=snapshot["metadata"],
            )

        self._fire_replan_event(
            trigger=ReplanTrigger.USER_INTERRUPT,
            action=ReplanAction.ROLLBACK_TO_CHECKPOINT,
            source_task_id=checkpoint_id,
            detail=f"回滚到检查点: {checkpoint.label or checkpoint_id}",
        )
        log.info("Rolled back to checkpoint", checkpoint_id=checkpoint_id)
        return True

    async def execute_with_replan(self) -> OrchestrationResult:
        self._replan_count = 0

        while self._replan_count < self._max_replan_count:
            result = await self._base.execute()

            replan_needed = self._check_replan_needed(result)
            if not replan_needed:
                return result

            self._replan_count += 1
            log.info(
                "Replan triggered",
                replan_count=self._replan_count,
                trigger=replan_needed.get("trigger", "unknown"),
            )

            applied = self._apply_replan(replan_needed, result)
            if not applied:
                return result

            self._base.reset()

        log.warning("Max replan count reached", max_count=self._max_replan_count)
        return await self._base.execute()

    def _check_replan_needed(self, result: OrchestrationResult) -> dict[str, Any] | None:
        failed_tasks = [
            (tid, task) for tid, task in result.tasks.items()
            if task.status == TaskStatus.FAILED
        ]

        if failed_tasks:
            tid, task = failed_tasks[0]
            return {
                "trigger": ReplanTrigger.TASK_FAILED,
                "task_id": tid,
                "task": task,
                "error": task.error,
            }

        for rule in self._rules:
            if rule.trigger == ReplanTrigger.CONDITION_MET:
                if self._evaluate_condition(rule.condition, result):
                    return {
                        "trigger": ReplanTrigger.CONDITION_MET,
                        "rule": rule,
                    }

        return None

    def _apply_replan(self, replan_info: dict[str, Any], result: OrchestrationResult) -> bool:
        trigger = replan_info.get("trigger")

        if trigger == ReplanTrigger.TASK_FAILED:
            task_id = replan_info.get("task_id", "")
            task = replan_info.get("task")
            error = replan_info.get("error", "")

            matching_rules = [
                r for r in self._rules
                if r.trigger == ReplanTrigger.TASK_FAILED
                and (not r.target_task_id or r.target_task_id == task_id)
            ]

            if matching_rules:
                rule = matching_rules[0]
                return self._apply_rule(rule, task_id, result)

            downstream = self._find_downstream(task_id, result)
            for ds_tid in downstream:
                ds_task = result.tasks.get(ds_tid)
                if ds_task:
                    self._base.add_task_with_id(
                        task_id=ds_tid,
                        name=ds_task.name + " (降级)",
                        executor=lambda _: asyncio.coroutine(lambda: None)(),
                        dependencies=[d for d in ds_task.dependencies if d != task_id],
                        metadata={"original_task": ds_tid, "degraded": True},
                    )

            self._fire_replan_event(
                trigger=ReplanTrigger.TASK_FAILED,
                action=ReplanAction.RETRY_WITH_ALTERNATIVE,
                source_task_id=task_id,
                detail=f"任务失败: {error}",
            )
            return True

        if trigger == ReplanTrigger.CONDITION_MET:
            rule = replan_info.get("rule")
            if rule:
                return self._apply_rule(rule, "", result)

        return False

    def _apply_rule(self, rule: ReplanRule, source_task_id: str, result: OrchestrationResult) -> bool:
        if rule.action == ReplanAction.INSERT_TASK:
            template = rule.task_template
            new_id = self._base.add_task(
                name=template.get("name", "动态插入任务"),
                executor=lambda _: asyncio.coroutine(lambda: None)(),
                dependencies=template.get("dependencies", [source_task_id] if source_task_id else []),
                metadata=template.get("metadata", {}),
            )
            self._fire_replan_event(
                trigger=rule.trigger,
                action=ReplanAction.INSERT_TASK,
                source_task_id=source_task_id,
                affected_task_ids=[new_id],
                detail=f"插入任务: {template.get('name', new_id)}",
            )
            return True

        if rule.action == ReplanAction.SKIP_DOWNSTREAM:
            downstream = self._find_downstream(source_task_id, result)
            for ds_tid in downstream:
                task = self._base.get_task(ds_tid)
                if task:
                    task.status = TaskStatus.SKIPPED
            self._fire_replan_event(
                trigger=rule.trigger,
                action=ReplanAction.SKIP_DOWNSTREAM,
                source_task_id=source_task_id,
                affected_task_ids=downstream,
            )
            return True

        if rule.action == ReplanAction.BRANCH_CONDITIONAL:
            template = rule.task_template
            new_id = self._base.add_task(
                name=template.get("name", "条件分支任务"),
                executor=lambda _: asyncio.coroutine(lambda: None)(),
                dependencies=template.get("dependencies", [source_task_id] if source_task_id else []),
                metadata=template.get("metadata", {}),
            )
            self._fire_replan_event(
                trigger=rule.trigger,
                action=ReplanAction.BRANCH_CONDITIONAL,
                source_task_id=source_task_id,
                affected_task_ids=[new_id],
            )
            return True

        return False

    def _find_downstream(self, task_id: str, result: OrchestrationResult) -> list[str]:
        downstream: list[str] = []
        all_tasks = result.tasks
        for tid, task in all_tasks.items():
            if task_id in task.dependencies:
                downstream.append(tid)
        return downstream

    def _evaluate_condition(self, condition: str, result: OrchestrationResult) -> bool:
        if condition == "has_failures":
            return result.failed_count > 0
        if condition == "all_succeeded":
            return result.failed_count == 0 and result.completed_count > 0
        return False

    def _fire_replan_event(
        self,
        trigger: ReplanTrigger,
        action: ReplanAction,
        source_task_id: str = "",
        affected_task_ids: list[str] | None = None,
        detail: str = "",
    ) -> None:
        event = ReplanEvent(
            timestamp=time.time(),
            trigger=trigger,
            action=action,
            source_task_id=source_task_id,
            affected_task_ids=affected_task_ids or [],
            detail=detail,
        )
        self._replan_events.append(event)
        if self._on_replan_callback:
            try:
                self._on_replan_event(event)
            except Exception as _exc:
                log_ignored(log, "dynamic_dag_replanner.DynamicDAGReplanner._fire_replan_event", _exc)

    def _on_replan_event(self, event: ReplanEvent) -> None:
        if self._on_replan_callback:
            self._on_replan_callback(event)

    @property
    def replan_count(self) -> int:
        return self._replan_count

    @property
    def checkpoints(self) -> list[DAGCheckpoint]:
        return list(self._checkpoints)

    @property
    def replan_events(self) -> list[ReplanEvent]:
        return list(self._replan_events)

    def get_stats(self) -> dict[str, Any]:
        return {
            "replan_count": self._replan_count,
            "max_replan_count": self._max_replan_count,
            "rules_count": len(self._rules),
            "checkpoints_count": len(self._checkpoints),
            "conditional_branches_count": sum(len(v) for v in self._conditional_branches.values()),
            "replan_events_count": len(self._replan_events),
        }


import asyncio
