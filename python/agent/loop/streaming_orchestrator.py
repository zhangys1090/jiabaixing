"""流式编排器（Streaming Orchestrator）—— 边执行边规划。

在 IncrementalPlanner（增量重规划）基础上，增强为：
1. 流式规划-执行：长任务边规划边执行，已规划步骤立即执行，后续步骤并行规划
2. 执行反馈驱动规划：根据已执行步骤的结果动态调整后续规划
3. 规划-执行流水线：规划和执行并行运行，通过队列传递步骤
4. 自适应规划深度：根据执行速度动态调整规划提前量
5. 流式结果聚合：逐步返回执行结果，支持流式输出

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 LoopController 集成，替代串行规划→执行流程
- 非侵入式：未挂载时回退到 IncrementalPlanner
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger
log = StructuredLogger("streaming_orchestrator")



class StreamPhase(str, Enum):
    PLANNING = "planning"
    EXECUTING = "executing"
    WAITING = "waiting"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PlanAheadStrategy(str, Enum):
    FIXED_DEPTH = "fixed_depth"
    ADAPTIVE = "adaptive"
    AGGRESSIVE = "aggressive"
    CONSERVATIVE = "conservative"


@dataclass
class StreamStep:
    step_id: str = ""
    description: str = ""
    tool_name: str = ""
    tool_params: dict[str, Any] = field(default_factory=dict)
    dependencies: list[str] = field(default_factory=list)
    priority: int = 2
    estimated_tokens: int = 0
    status: str = "pending"
    result: Any = None
    error: str | None = None
    duration_ms: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class StreamResult:
    step_id: str = ""
    success: bool = False
    content: str = ""
    error: str | None = None
    duration_ms: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class StreamCheckpoint:
    checkpoint_id: str = ""
    timestamp: float = 0.0
    planned_steps: int = 0
    executed_steps: int = 0
    failed_steps: int = 0
    phase: StreamPhase = StreamPhase.PLANNING
    plan_ahead_depth: int = 3


@dataclass
class StreamMetrics:
    total_steps_planned: int = 0
    total_steps_executed: int = 0
    total_steps_failed: int = 0
    planning_time_ms: float = 0.0
    execution_time_ms: float = 0.0
    parallelism_efficiency: float = 1.0
    avg_plan_ahead_depth: float = 3.0
    avg_step_duration_ms: float = 0.0
    total_duration_ms: float = 0.0


class StreamingOrchestrator:
    """流式编排器：边规划边执行，规划-执行流水线。"""

    _instance: StreamingOrchestrator | None = None

    def __init__(
        self,
        plan_ahead_depth: int = 3,
        plan_ahead_strategy: PlanAheadStrategy = PlanAheadStrategy.ADAPTIVE,
        max_parallel_execution: int = 2,
        planning_timeout_ms: float = 30000.0,
        execution_timeout_ms: float = 60000.0,
    ) -> None:
        self._plan_ahead_depth = plan_ahead_depth
        self._strategy = plan_ahead_strategy
        self._max_parallel = max_parallel_execution
        self._planning_timeout = planning_timeout_ms
        self._execution_timeout = execution_timeout_ms
        self._plan_queue: asyncio.Queue[StreamStep] | None = None
        self._result_queue: asyncio.Queue[StreamResult] | None = None
        self._planned_steps: dict[str, StreamStep] = {}
        self._executed_steps: dict[str, StreamStep] = {}
        self._phase = StreamPhase.WAITING
        self._metrics = StreamMetrics()
        self._executor_fn: Callable[[StreamStep], Awaitable[StreamResult]] | None = None
        self._planner_fn: Callable[[list[StreamResult], int], Awaitable[list[StreamStep]]] | None = None
        self._cancel_event = asyncio.Event()
        self._checkpoints: list[StreamCheckpoint] = []
        self._MAX_PLANNED_STEPS = 5000
        self._MAX_EXECUTED_STEPS = 5000
        self._MAX_CHECKPOINTS = 200

    @classmethod
    def get_instance(cls) -> StreamingOrchestrator:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def set_executor(self, fn: Callable[[StreamStep], Awaitable[StreamResult]]) -> None:
        self._executor_fn = fn

    def set_planner(self, fn: Callable[[list[StreamResult], int], Awaitable[list[StreamStep]]]) -> None:
        self._planner_fn = fn

    async def run_streaming(
        self,
        initial_steps: list[StreamStep] | None = None,
        max_total_steps: int = 50,
    ) -> list[StreamResult]:
        self._plan_queue = asyncio.Queue()
        self._result_queue = asyncio.Queue()
        self._cancel_event.clear()
        self._phase = StreamPhase.PLANNING
        self._metrics = StreamMetrics()
        start = time.time()

        all_results: list[StreamResult] = []

        if initial_steps:
            for step in initial_steps:
                self._planned_steps[step.step_id] = step
                if len(self._planned_steps) > self._MAX_PLANNED_STEPS:
                    oldest_keys = list(self._planned_steps.keys())[: len(self._planned_steps) - (self._MAX_PLANNED_STEPS * 3 // 4)]
                    for k in oldest_keys:
                        del self._planned_steps[k]
                await self._plan_queue.put(step)
                self._metrics.total_steps_planned += 1

        try:
            planning_task = asyncio.create_task(
                self._planning_loop(max_total_steps),
            )
            execution_task = asyncio.create_task(
                self._execution_loop(max_total_steps),
            )

            done, pending = await asyncio.wait(
                {planning_task, execution_task},
                return_when=asyncio.ALL_COMPLETED,
            )

            for task in pending:
                task.cancel()

            while not self._result_queue.empty():
                result = self._result_queue.get_nowait()
                all_results.append(result)

        except asyncio.CancelledError:
            self._phase = StreamPhase.CANCELLED
            log.info("Streaming orchestration cancelled")
        except Exception as e:
            log.debug("streaming_orchestrator 异常处理", error=str(e))
            self._phase = StreamPhase.FAILED
            log.error("Streaming orchestration failed", error=str(e))

        self._metrics.total_duration_ms = (time.time() - start) * 1000
        if self._metrics.total_steps_executed > 0:
            self._metrics.avg_step_duration_ms = (
                self._metrics.execution_time_ms / self._metrics.total_steps_executed
            )

        self._phase = StreamPhase.COMPLETED
        return all_results

    async def _planning_loop(self, max_steps: int) -> None:
        self._phase = StreamPhase.PLANNING
        plan_start = time.time()

        while not self._cancel_event.is_set():
            if self._metrics.total_steps_planned >= max_steps:
                break

            if self._planner_fn is None:
                if self._plan_queue.empty():
                    break
                await asyncio.sleep(0.1)
                continue

            executed_results = list({
                r.step_id: r for r in self._get_all_results()
            }.values())

            depth = self._compute_plan_ahead_depth()
            try:
                new_steps = await asyncio.wait_for(
                    self._planner_fn(executed_results, depth),
                    timeout=self._planning_timeout / 1000.0,
                )
                for step in new_steps:
                    if step.step_id not in self._planned_steps:
                        self._planned_steps[step.step_id] = step
                        if len(self._planned_steps) > self._MAX_PLANNED_STEPS:
                            oldest_keys = list(self._planned_steps.keys())[: len(self._planned_steps) - (self._MAX_PLANNED_STEPS * 3 // 4)]
                            for k in oldest_keys:
                                del self._planned_steps[k]
                        await self._plan_queue.put(step)
                        self._metrics.total_steps_planned += 1

            except asyncio.TimeoutError:
                log.warning("Planning timeout")
            except Exception as e:
                log.error("Planning error", error=str(e))

            self._metrics.planning_time_ms += (time.time() - plan_start) * 1000
            plan_start = time.time()

            if not new_steps and self._plan_queue.empty():
                break

            await asyncio.sleep(0.05)

    async def _execution_loop(self, max_steps: int) -> None:
        self._phase = StreamPhase.EXECUTING
        running_tasks: dict[str, asyncio.Task] = {}

        while not self._cancel_event.is_set():
            if self._metrics.total_steps_executed >= max_steps:
                break

            while len(running_tasks) < self._max_parallel:
                try:
                    step = self._plan_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

                if self._executor_fn is None:
                    result = StreamResult(
                        step_id=step.step_id,
                        success=False,
                        error="执行器未挂载",
                    )
                    await self._result_queue.put(result)
                    self._metrics.total_steps_executed += 1
                    continue

                task = asyncio.create_task(self._execute_step(step))
                running_tasks[step.step_id] = task

            if not running_tasks:
                if self._plan_queue.empty() and self._metrics.total_steps_planned > 0:
                    break
                await asyncio.sleep(0.1)
                continue

            done, _ = await asyncio.wait(
                running_tasks.values(),
                return_first=True,
            )

            for task in done:
                step_id = None
                for sid, t in running_tasks.items():
                    if t == task:
                        step_id = sid
                        break
                if step_id:
                    running_tasks.pop(step_id, None)

            await asyncio.sleep(0.01)

        for task in running_tasks.values():
            task.cancel()

    async def _execute_step(self, step: StreamStep) -> None:
        exec_start = time.time()
        step.status = "running"

        try:
            result = await asyncio.wait_for(
                self._executor_fn(step),
                timeout=self._execution_timeout / 1000.0,
            )

            step.status = "completed" if result.success else "failed"
            step.result = result.content
            step.error = result.error
            step.duration_ms = (time.time() - exec_start) * 1000

            self._executed_steps[step.step_id] = step
            if len(self._executed_steps) > self._MAX_EXECUTED_STEPS:
                oldest_keys = list(self._executed_steps.keys())[: len(self._executed_steps) - (self._MAX_EXECUTED_STEPS * 3 // 4)]
                for k in oldest_keys:
                    del self._executed_steps[k]
            await self._result_queue.put(result)

            if result.success:
                self._metrics.total_steps_executed += 1
            else:
                self._metrics.total_steps_failed += 1

            self._metrics.execution_time_ms += (time.time() - exec_start) * 1000

        except asyncio.TimeoutError:
            step.status = "timeout"
            step.error = f"执行超时 ({self._execution_timeout}ms)"
            step.duration_ms = (time.time() - exec_start) * 1000
            self._metrics.total_steps_failed += 1

            result = StreamResult(
                step_id=step.step_id,
                success=False,
                error=step.error,
                duration_ms=step.duration_ms,
            )
            await self._result_queue.put(result)

        except Exception as e:
            log.debug("streaming_orchestrator 异常处理", error=str(e))
            step.status = "error"
            step.error = str(e)
            step.duration_ms = (time.time() - exec_start) * 1000
            self._metrics.total_steps_failed += 1

            result = StreamResult(
                step_id=step.step_id,
                success=False,
                error=str(e),
                duration_ms=step.duration_ms,
            )
            await self._result_queue.put(result)

    def _compute_plan_ahead_depth(self) -> int:
        if self._strategy == PlanAheadStrategy.FIXED_DEPTH:
            return self._plan_ahead_depth

        if self._strategy == PlanAheadStrategy.ADAPTIVE:
            if self._metrics.avg_step_duration_ms > 0 and self._metrics.planning_time_ms > 0:
                ratio = self._metrics.execution_time_ms / max(self._metrics.planning_time_ms, 1.0)
                if ratio > 3.0:
                    return min(self._plan_ahead_depth * 2, 10)
                if ratio < 0.5:
                    return max(self._plan_ahead_depth // 2, 1)
            return self._plan_ahead_depth

        if self._strategy == PlanAheadStrategy.AGGRESSIVE:
            return min(self._plan_ahead_depth * 3, 15)

        if self._strategy == PlanAheadStrategy.CONSERVATIVE:
            return max(self._plan_ahead_depth // 2, 1)

        return self._plan_ahead_depth

    def _get_all_results(self) -> list[StreamResult]:
        results: list[StreamResult] = []
        if self._result_queue:
            temp = []
            while not self._result_queue.empty():
                try:
                    r = self._result_queue.get_nowait()
                    results.append(r)
                    temp.append(r)
                except asyncio.QueueEmpty:
                    break
            for r in temp:
                self._result_queue.put_nowait(r)
        return results

    def cancel(self) -> None:
        self._cancel_event.set()
        self._phase = StreamPhase.CANCELLED

    def get_metrics(self) -> StreamMetrics:
        return self._metrics

    def get_phase(self) -> StreamPhase:
        return self._phase

    def get_progress(self) -> dict[str, Any]:
        return {
            "phase": self._phase.value,
            "planned": self._metrics.total_steps_planned,
            "executed": self._metrics.total_steps_executed,
            "failed": self._metrics.total_steps_failed,
            "plan_ahead_depth": self._compute_plan_ahead_depth(),
            "duration_ms": round(self._metrics.total_duration_ms),
        }
