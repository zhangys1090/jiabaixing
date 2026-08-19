"""WorkflowInstance 状态机 + 步骤调度。

管理工作流实例的生命周期：
- 状态转换：PENDING→RUNNING→DONE/FAILED/PAUSED/CANCELLED
- 步骤调度：根据 DAG 依赖关系确定可执行步骤
- 条件评估：根据条件表达式决定步骤是否跳过
- 变量绑定：跨步骤变量传递
"""

from __future__ import annotations

import re
import time
from typing import Any

from agent.core.logger import StructuredLogger
from agent.workflow.types import (
    WorkflowDefinition,
    WorkflowInstance,
    WorkflowStep,
    StepState,
    StepStatus,
    WorkflowStatus,
)

log = StructuredLogger("workflow_instance")


class WorkflowStateMachine:
    """工作流状态机 — 管理实例的状态转换和步骤调度。"""

    VALID_TRANSITIONS: dict[str, set[str]] = {
        WorkflowStatus.PENDING: {WorkflowStatus.RUNNING, WorkflowStatus.CANCELLED},
        WorkflowStatus.RUNNING: {WorkflowStatus.PAUSED, WorkflowStatus.DONE, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED},
        WorkflowStatus.PAUSED: {WorkflowStatus.RUNNING, WorkflowStatus.CANCELLED},
        WorkflowStatus.DONE: set(),
        WorkflowStatus.FAILED: {WorkflowStatus.PENDING},
        WorkflowStatus.CANCELLED: set(),
    }

    def __init__(self, instance: WorkflowInstance, definition: WorkflowDefinition) -> None:
        self._instance = instance
        self._definition = definition
        self._instance.definition = definition
        self._init_step_states()

    def _init_step_states(self) -> None:
        for step in self._definition.steps:
            if step.id not in self._instance.step_states:
                self._instance.step_states[step.id] = StepState(step_id=step.id)

    @property
    def instance(self) -> WorkflowInstance:
        return self._instance

    def can_transition(self, target: str) -> bool:
        return target in self.VALID_TRANSITIONS.get(self._instance.status, set())

    def transition(self, target: str) -> bool:
        if not self.can_transition(target):
            log.warning("非法状态转换", current=self._instance.status, target=target)
            return False
        old = self._instance.status
        self._instance.status = target
        self._instance.updated_at = time.time()
        log.info("工作流状态转换", instance=self._instance.id, old=old, new=target)
        return True

    def get_ready_steps(self) -> list[WorkflowStep]:
        """获取当前可执行的步骤（依赖已完成且自身未开始）。"""
        ready = []
        for step in self._definition.steps:
            ss = self._instance.step_states.get(step.id)
            if not ss or ss.status not in (StepStatus.PENDING,):
                continue
            deps_met = True
            for dep_id in step.depends_on:
                dep_state = self._instance.step_states.get(dep_id)
                if not dep_state or dep_state.status != StepStatus.DONE:
                    deps_met = False
                    break
            if deps_met:
                if self._evaluate_condition(step):
                    ready.append(step)
                else:
                    ss.status = StepStatus.SKIPPED
                    log.info("步骤条件不满足，跳过", step=step.id, condition=step.condition)
        return ready

    def _evaluate_condition(self, step: WorkflowStep) -> bool:
        if step.condition is None:
            return True
        try:
            return self._eval_expr(step.condition)
        except Exception as e:
            log.warning("条件评估失败，默认跳过", step=step.id, condition=step.condition, error=str(e))
            return False

    def _eval_expr(self, expr: str) -> bool:
        ctx = self._build_eval_context()
        safe_expr = expr
        for var_name, var_val in ctx.items():
            if isinstance(var_val, bool):
                safe_expr = safe_expr.replace(f"${var_name}", str(var_val))
            elif isinstance(var_val, (int, float)):
                safe_expr = safe_expr.replace(f"${var_name}", str(var_val))
            elif isinstance(var_val, str):
                safe_expr = safe_expr.replace(f"${var_name}", f'"{var_val}"')
            elif isinstance(var_val, dict):
                for k, v in var_val.items():
                    safe_expr = safe_expr.replace(f"${var_name}.{k}", f'"{v}"' if isinstance(v, str) else str(v))

        safe_expr = re.sub(r'\$\w+(?:\.\w+)*', 'False', safe_expr)

        if "==" in safe_expr:
            parts = safe_expr.split("==", 1)
            return parts[0].strip().strip('"') == parts[1].strip().strip('"')
        if "!=" in safe_expr:
            parts = safe_expr.split("!=", 1)
            return parts[0].strip().strip('"') != parts[1].strip().strip('"')
        if safe_expr.strip().lower() in ("true", "1", "yes"):
            return True
        if safe_expr.strip().lower() in ("false", "0", "no"):
            return False

        return bool(ctx.get(expr.lstrip("$"), False))

    def _build_eval_context(self) -> dict[str, Any]:
        ctx: dict[str, Any] = {}
        ctx.update(self._instance.variables)
        for step_id, ss in self._instance.step_states.items():
            if ss.result:
                ctx[step_id] = ss.result
                if isinstance(ss.result, dict):
                    ctx[step_id].update(ss.result)
        return ctx

    def start_step(self, step_id: str) -> None:
        ss = self._instance.step_states.get(step_id)
        if ss:
            ss.status = StepStatus.RUNNING
            ss.started_at = time.time()
            ss.attempts += 1

    def complete_step(self, step_id: str, result: dict[str, Any] | None = None) -> None:
        ss = self._instance.step_states.get(step_id)
        if ss:
            ss.status = StepStatus.DONE
            ss.completed_at = time.time()
            ss.result = result
            ss.duration_ms = (ss.completed_at - ss.started_at) * 1000 if ss.started_at else 0
            self._apply_step_outputs(step_id, result)

    def fail_step(self, step_id: str, error: str = "") -> None:
        ss = self._instance.step_states.get(step_id)
        if ss:
            ss.status = StepStatus.FAILED
            ss.completed_at = time.time()
            ss.error = error
            ss.duration_ms = (ss.completed_at - ss.started_at) * 1000 if ss.started_at else 0

    def _apply_step_outputs(self, step_id: str, result: dict[str, Any] | None) -> None:
        if not result:
            return
        step = next((s for s in self._definition.steps if s.id == step_id), None)
        if not step:
            return
        for var_name, result_key in step.variables_output.items():
            if isinstance(result, dict) and result_key in result:
                self._instance.variables[var_name] = result[result_key]

    def is_all_done(self) -> bool:
        # FAILED 步骤不计入"全部完成"——失败的步骤表示该工作流未真正成功，
        # 必须让引擎在 run() 中经由 has_failed_steps() 收尾为 FAILED 而非 DONE。
        for step in self._definition.steps:
            ss = self._instance.step_states.get(step.id)
            if not ss or ss.status in (
                StepStatus.PENDING,
                StepStatus.RUNNING,
                StepStatus.FAILED,
            ):
                return False
        return True

    def has_failed_steps(self) -> bool:
        return any(
            ss.status == StepStatus.FAILED
            for ss in self._instance.step_states.values()
        )

    def get_failed_steps(self) -> list[str]:
        return [
            ss.step_id
            for ss in self._instance.step_states.values()
            if ss.status == StepStatus.FAILED
        ]

    def get_progress(self) -> dict[str, Any]:
        total = len(self._definition.steps)
        done = sum(1 for ss in self._instance.step_states.values() if ss.status == StepStatus.DONE)
        failed = sum(1 for ss in self._instance.step_states.values() if ss.status == StepStatus.FAILED)
        skipped = sum(1 for ss in self._instance.step_states.values() if ss.status == StepStatus.SKIPPED)
        running = sum(1 for ss in self._instance.step_states.values() if ss.status == StepStatus.RUNNING)
        return {
            "total": total,
            "done": done,
            "failed": failed,
            "skipped": skipped,
            "running": running,
            "pending": total - done - failed - skipped - running,
            "progress_pct": round(done / total * 100, 1) if total > 0 else 0,
        }
