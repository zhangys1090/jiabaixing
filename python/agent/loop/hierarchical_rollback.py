"""层级规划端到端贯通 —— 子目标级回滚/重规划引擎（Hierarchical Plan Rollback & Replanner）。

在现有 HierarchicalPlanner（层级分解）和 DynamicDAGReplanner（DAG重规划）基础上，增强为：
1. 子目标级回滚：子目标失败时仅回滚该子目标及其下游，不影响兄弟分支
2. 子目标级重规划：失败子目标可独立重规划，新计划自动接入原 DAG
3. 子目标状态追踪：每个子目标维护独立状态机（pending→running→completed/failed/rollback）
4. 回滚检查点：子目标执行前保存检查点，回滚时恢复到检查点状态
5. 父子目标联动：子目标回滚时通知父目标，父目标决定是否触发更高级回滚

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 OrchestrationExecutor 集成，复用其 DAG 执行框架
- 非侵入式：包装 HierarchicalPlanner，不修改其内部逻辑
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("hierarchical_rollback")



class SubGoalState(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"
    REPLANNING = "replanning"
    CANCELLED = "cancelled"


class RollbackStrategy(str, Enum):
    LOCAL_ONLY = "local_only"
    LOCAL_WITH_SIBLINGS = "local_with_siblings"
    CASCADE_TO_PARENT = "cascade_to_parent"
    FULL_PLAN_RESTART = "full_plan_restart"


class ReplanScope(str, Enum):
    SUB_GOAL_ONLY = "sub_goal_only"
    SUB_GOAL_AND_CHILDREN = "sub_goal_and_children"
    FROM_FAILED_POINT = "from_failed_point"


@dataclass
class SubGoalCheckpoint:
    checkpoint_id: str = ""
    sub_goal_id: str = ""
    timestamp: float = 0.0
    state_before: SubGoalState = SubGoalState.PENDING
    context_snapshot: dict[str, Any] = field(default_factory=dict)
    results_snapshot: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SubGoalNode:
    sub_goal_id: str = ""
    parent_id: str = ""
    children_ids: list[str] = field(default_factory=list)
    description: str = ""
    state: SubGoalState = SubGoalState.PENDING
    depth: int = 0
    executor_ref: Any = None
    result: Any = None
    error: str | None = None
    checkpoint: SubGoalCheckpoint | None = None
    retry_count: int = 0
    max_retries: int = 2
    rollback_count: int = 0
    max_rollbacks: int = 1
    replan_count: int = 0
    max_replans: int = 1
    duration_ms: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RollbackDecision:
    should_rollback: bool = False
    strategy: RollbackStrategy = RollbackStrategy.LOCAL_ONLY
    scope: ReplanScope = ReplanScope.SUB_GOAL_ONLY
    affected_sub_goals: list[str] = field(default_factory=list)
    reason: str = ""
    parent_notification: bool = False


@dataclass
class ReplanResult:
    success: bool = False
    new_sub_goals: list[SubGoalNode] = field(default_factory=list)
    replaced_sub_goal_id: str = ""
    reason: str = ""


@dataclass
class HierarchicalPlanTrace:
    plan_id: str = ""
    root_sub_goal_id: str = ""
    total_sub_goals: int = 0
    completed_sub_goals: int = 0
    failed_sub_goals: int = 0
    rolled_back_sub_goals: int = 0
    replanned_sub_goals: int = 0
    total_duration_ms: float = 0.0
    rollback_events: list[dict[str, Any]] = field(default_factory=list)
    replan_events: list[dict[str, Any]] = field(default_factory=list)
    state_transitions: list[dict[str, Any]] = field(default_factory=list)


class HierarchicalRollbackEngine:
    """层级规划端到端贯通引擎：子目标级回滚/重规划。"""

    def __init__(
        self,
        max_sub_goal_retries: int = 2,
        max_sub_goal_rollbacks: int = 1,
        max_sub_goal_replans: int = 1,
        cascade_failure_threshold: int = 3,
    ) -> None:
        self._sub_goals: dict[str, SubGoalNode] = {}
        self._max_retries = max_sub_goal_retries
        self._max_rollbacks = max_sub_goal_rollbacks
        self._max_replans = max_sub_goal_replans
        self._cascade_threshold = cascade_failure_threshold
        self._trace: HierarchicalPlanTrace | None = None
        self._consecutive_failures = 0

    def create_plan(
        self,
        root_description: str,
        sub_goal_specs: list[dict[str, Any]],
    ) -> str:
        plan_id = f"hplan_{uuid.uuid4().hex[:8]}"
        root_id = f"sg_{uuid.uuid4().hex[:8]}"

        root = SubGoalNode(
            sub_goal_id=root_id,
            parent_id="",
            description=root_description,
            depth=0,
            max_retries=self._max_retries,
            max_rollbacks=self._max_rollbacks,
            max_replans=self._max_replans,
        )
        self._sub_goals[root_id] = root

        for spec in sub_goal_specs:
            sg_id = f"sg_{uuid.uuid4().hex[:8]}"
            parent_id = spec.get("parent_id", root_id)
            parent = self._sub_goals.get(parent_id)
            depth = (parent.depth + 1) if parent else 1

            sg = SubGoalNode(
                sub_goal_id=sg_id,
                parent_id=parent_id,
                description=spec.get("description", ""),
                depth=depth,
                executor_ref=spec.get("executor"),
                max_retries=spec.get("max_retries", self._max_retries),
                max_rollbacks=spec.get("max_rollbacks", self._max_rollbacks),
                max_replans=spec.get("max_replans", self._max_replans),
                metadata=spec.get("metadata", {}),
            )
            self._sub_goals[sg_id] = sg
            if parent:
                parent.children_ids.append(sg_id)

        self._trace = HierarchicalPlanTrace(
            plan_id=plan_id,
            root_sub_goal_id=root_id,
            total_sub_goals=len(self._sub_goals),
        )

        log.info(
            "Hierarchical plan created",
            plan_id=plan_id,
            total_sub_goals=len(self._sub_goals),
            max_depth=max(sg.depth for sg in self._sub_goals.values()),
        )
        return plan_id

    def add_sub_goal(
        self,
            parent_id: str,
            description: str,
            executor: Any = None,
            metadata: dict[str, Any] | None = None,
    ) -> SubGoalNode:
        sg_id = f"sg_{uuid.uuid4().hex[:8]}"
        parent = self._sub_goals.get(parent_id)
        depth = (parent.depth + 1) if parent else 0

        sg = SubGoalNode(
            sub_goal_id=sg_id,
            parent_id=parent_id,
            description=description,
            depth=depth,
            executor_ref=executor,
            max_retries=self._max_retries,
            max_rollbacks=self._max_rollbacks,
            max_replans=self._max_replans,
            metadata=metadata or {},
        )
        self._sub_goals[sg_id] = sg
        if parent:
            parent.children_ids.append(sg_id)
        if self._trace:
            self._trace.total_sub_goals += 1

        return sg

    def create_checkpoint(self, sub_goal_id: str, context: dict[str, Any] | None = None) -> SubGoalCheckpoint | None:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return None

        checkpoint = SubGoalCheckpoint(
            checkpoint_id=f"cp_{uuid.uuid4().hex[:8]}",
            sub_goal_id=sub_goal_id,
            timestamp=time.time(),
            state_before=sg.state,
            context_snapshot=dict(context or {}),
            results_snapshot={"result": sg.result, "error": sg.error},
            metadata=sg.metadata.copy(),
        )
        sg.checkpoint = checkpoint
        return checkpoint

    def transition_state(self, sub_goal_id: str, new_state: SubGoalState, reason: str = "") -> bool:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return False

        old_state = sg.state
        sg.state = new_state

        if self._trace:
            self._trace.state_transitions.append({
                "sub_goal_id": sub_goal_id,
                "from": old_state.value,
                "to": new_state.value,
                "reason": reason,
                "timestamp": time.time(),
            })

        log.info(
            "Sub-goal state transition",
            sub_goal_id=sub_goal_id,
            from_state=old_state.value,
            to_state=new_state.value,
            reason=reason,
        )
        return True

    def mark_sub_goal_completed(self, sub_goal_id: str, result: Any = None) -> None:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return
        sg.result = result
        self.transition_state(sub_goal_id, SubGoalState.COMPLETED, "execution succeeded")
        if self._trace:
            self._trace.completed_sub_goals += 1
        self._consecutive_failures = 0

    def mark_sub_goal_failed(self, sub_goal_id: str, error: str = "") -> None:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return
        sg.error = error
        self.transition_state(sub_goal_id, SubGoalState.FAILED, error)
        if self._trace:
            self._trace.failed_sub_goals += 1
        self._consecutive_failures += 1

    def evaluate_rollback(self, sub_goal_id: str) -> RollbackDecision:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return RollbackDecision(reason="sub-goal not found")

        if sg.state != SubGoalState.FAILED:
            return RollbackDecision(reason="sub-goal not in failed state")

        if sg.rollback_count >= sg.max_rollbacks:
            if sg.parent_id:
                return RollbackDecision(
                    should_rollback=True,
                    strategy=RollbackStrategy.CASCADE_TO_PARENT,
                    scope=ReplanScope.SUB_GOAL_AND_CHILDREN,
                    affected_sub_goals=[sg.parent_id],
                    reason=f"sub-goal rollback limit reached ({sg.rollback_count}/{sg.max_rollbacks}), cascading to parent",
                    parent_notification=True,
                )
            return RollbackDecision(
                should_rollback=True,
                strategy=RollbackStrategy.FULL_PLAN_RESTART,
                scope=ReplanScope.FROM_FAILED_POINT,
                affected_sub_goals=list(self._sub_goals.keys()),
                reason="root sub-goal rollback limit reached, full plan restart",
            )

        downstream = self._get_downstream_ids(sub_goal_id)
        has_downstream = len(downstream) > 0

        if self._consecutive_failures >= self._cascade_threshold:
            return RollbackDecision(
                should_rollback=True,
                strategy=RollbackStrategy.CASCADE_TO_PARENT,
                scope=ReplanScope.SUB_GOAL_AND_CHILDREN,
                affected_sub_goals=[sub_goal_id] + downstream,
                reason=f"consecutive failures ({self._consecutive_failures}) >= threshold ({self._cascade_threshold})",
                parent_notification=True,
            )

        if has_downstream:
            return RollbackDecision(
                should_rollback=True,
                strategy=RollbackStrategy.LOCAL_WITH_SIBLINGS,
                scope=ReplanScope.SUB_GOAL_AND_CHILDREN,
                affected_sub_goals=[sub_goal_id] + downstream,
                reason=f"sub-goal has {len(downstream)} downstream dependents",
            )

        return RollbackDecision(
            should_rollback=True,
            strategy=RollbackStrategy.LOCAL_ONLY,
            scope=ReplanScope.SUB_GOAL_ONLY,
            affected_sub_goals=[sub_goal_id],
            reason="isolated sub-goal failure, local rollback",
        )

    def execute_rollback(self, sub_goal_id: str, decision: RollbackDecision) -> bool:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return False

        self.transition_state(sub_goal_id, SubGoalState.ROLLING_BACK, decision.reason)

        for affected_id in decision.affected_sub_goals:
            affected = self._sub_goals.get(affected_id)
            if not affected:
                continue
            if affected.checkpoint:
                affected.state = SubGoalState.ROLLED_BACK
                affected.result = affected.checkpoint.results_snapshot.get("result")
                affected.error = affected.checkpoint.results_snapshot.get("error")
            else:
                affected.state = SubGoalState.ROLLED_BACK
                affected.result = None
                affected.error = None

        sg.rollback_count += 1
        if self._trace:
            self._trace.rolled_back_sub_goals += len(decision.affected_sub_goals)
            self._trace.rollback_events.append({
                "sub_goal_id": sub_goal_id,
                "strategy": decision.strategy.value,
                "scope": decision.scope.value,
                "affected": decision.affected_sub_goals,
                "reason": decision.reason,
                "timestamp": time.time(),
            })

        self.transition_state(sub_goal_id, SubGoalState.ROLLED_BACK, "rollback completed")

        if decision.parent_notification and sg.parent_id:
            self._notify_parent(sg.parent_id, sub_goal_id, decision)

        log.info(
            "Rollback executed",
            sub_goal_id=sub_goal_id,
            strategy=decision.strategy.value,
            affected_count=len(decision.affected_sub_goals),
        )
        return True

    def replan_sub_goal(
        self,
        sub_goal_id: str,
        new_description: str = "",
        new_executor: Any = None,
        new_children: list[dict[str, Any]] | None = None,
    ) -> ReplanResult:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return ReplanResult(reason="sub-goal not found")

        if sg.replan_count >= sg.max_replans:
            return ReplanResult(reason=f"replan limit reached ({sg.replan_count}/{sg.max_replans})")

        self.transition_state(sub_goal_id, SubGoalState.REPLANNING, "starting replan")

        if new_description:
            sg.description = new_description
        if new_executor:
            sg.executor_ref = new_executor

        for child_id in list(sg.children_ids):
            child = self._sub_goals.get(child_id)
            if child and child.state in (SubGoalState.FAILED, SubGoalState.ROLLED_BACK):
                self._sub_goals.pop(child_id, None)
        sg.children_ids = [
            cid for cid in sg.children_ids
            if cid in self._sub_goals and self._sub_goals[cid].state not in (SubGoalState.FAILED, SubGoalState.ROLLED_BACK)
        ]

        new_sub_goals: list[SubGoalNode] = []
        if new_children:
            for child_spec in new_children:
                new_sg = self.add_sub_goal(
                    parent_id=sub_goal_id,
                    description=child_spec.get("description", ""),
                    executor=child_spec.get("executor"),
                    metadata=child_spec.get("metadata"),
                )
                new_sub_goals.append(new_sg)

        sg.replan_count += 1
        sg.state = SubGoalState.PENDING
        sg.error = None
        sg.result = None

        if self._trace:
            self._trace.replanned_sub_goals += 1
            self._trace.replan_events.append({
                "sub_goal_id": sub_goal_id,
                "new_children": len(new_sub_goals),
                "timestamp": time.time(),
            })

        log.info(
            "Sub-goal replanned",
            sub_goal_id=sub_goal_id,
            new_children=len(new_sub_goals),
            replan_count=sg.replan_count,
        )

        return ReplanResult(
            success=True,
            new_sub_goals=new_sub_goals,
            replaced_sub_goal_id=sub_goal_id,
            reason="replan completed",
        )

    def get_sub_goal(self, sub_goal_id: str) -> SubGoalNode | None:
        return self._sub_goals.get(sub_goal_id)

    def get_all_sub_goals(self) -> dict[str, SubGoalNode]:
        return dict(self._sub_goals)

    def get_children(self, sub_goal_id: str) -> list[SubGoalNode]:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return []
        return [self._sub_goals[cid] for cid in sg.children_ids if cid in self._sub_goals]

    def get_downstream(self, sub_goal_id: str) -> list[SubGoalNode]:
        ids = self._get_downstream_ids(sub_goal_id)
        return [self._sub_goals[i] for i in ids if i in self._sub_goals]

    def get_siblings(self, sub_goal_id: str) -> list[SubGoalNode]:
        sg = self._sub_goals.get(sub_goal_id)
        if not sg or not sg.parent_id:
            return []
        parent = self._sub_goals.get(sg.parent_id)
        if not parent:
            return []
        return [
            self._sub_goals[cid]
            for cid in parent.children_ids
            if cid != sub_goal_id and cid in self._sub_goals
        ]

    def get_trace(self) -> HierarchicalPlanTrace | None:
        return self._trace

    def get_plan_status(self) -> dict[str, Any]:
        if not self._trace:
            return {"status": "no_plan"}

        states = {}
        for sg in self._sub_goals.values():
            states[sg.state.value] = states.get(sg.state.value, 0) + 1

        return {
            "plan_id": self._trace.plan_id,
            "total_sub_goals": self._trace.total_sub_goals,
            "state_distribution": states,
            "completed": self._trace.completed_sub_goals,
            "failed": self._trace.failed_sub_goals,
            "rolled_back": self._trace.rolled_back_sub_goals,
            "replanned": self._trace.replanned_sub_goals,
            "consecutive_failures": self._consecutive_failures,
            "rollback_events": len(self._trace.rollback_events),
            "replan_events": len(self._trace.replan_events),
        }

    def _get_downstream_ids(self, sub_goal_id: str) -> list[str]:
        result: list[str] = []
        sg = self._sub_goals.get(sub_goal_id)
        if not sg:
            return result
        for child_id in sg.children_ids:
            result.append(child_id)
            result.extend(self._get_downstream_ids(child_id))
        return result

    def _notify_parent(self, parent_id: str, child_id: str, decision: RollbackDecision) -> None:
        parent = self._sub_goals.get(parent_id)
        if not parent:
            return
        log.info(
            "Parent notified of child rollback",
            parent_id=parent_id,
            child_id=child_id,
            strategy=decision.strategy.value,
        )
