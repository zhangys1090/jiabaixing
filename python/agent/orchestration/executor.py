from __future__ import annotations

import asyncio
import copy
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from agent.core.logger import StructuredLogger
log = StructuredLogger("executor")



class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"
    PARTIALLY_COMPLETED = "partially_completed"


class TaskPriority(int, Enum):
    CRITICAL = 0
    HIGH = 1
    NORMAL = 2
    LOW = 3


@dataclass
class TaskNode:
    task_id: str
    name: str
    executor: Callable[..., Awaitable[Any]]
    dependencies: list[str] = field(default_factory=list)
    priority: TaskPriority = TaskPriority.NORMAL
    timeout_ms: int = 60000
    retry_count: int = 0
    max_retries: int = 0
    status: TaskStatus = TaskStatus.PENDING
    result: Any = None
    error: str | None = None
    duration_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class OrchestrationResult:
    orchestration_id: str
    status: TaskStatus
    tasks: dict[str, TaskNode]
    total_duration_ms: int
    completed_count: int = 0
    failed_count: int = 0
    skipped_count: int = 0
    aggregated_result: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


@dataclass
class OrchestrationConfig:
    max_concurrent: int = 5
    default_timeout_ms: int = 60000
    default_max_retries: int = 0
    fail_fast: bool = False
    collect_results: bool = True


class DAGValidationError(Exception):
    pass


class OrchestrationExecutor:
    def __init__(self, config: OrchestrationConfig | None = None) -> None:
        self.config = config or OrchestrationConfig()
        self._tasks: dict[str, TaskNode] = {}
        self._semaphore: asyncio.Semaphore | None = None
        self._MAX_TASKS = 10000

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
        task_id = f"task_{uuid.uuid4().hex[:8]}"
        if len(self._tasks) > self._MAX_TASKS:
            oldest_keys = list(self._tasks.keys())[: len(self._tasks) - (self._MAX_TASKS * 3 // 4)]
            for tid in oldest_keys:
                del self._tasks[tid]
        self._tasks[task_id] = TaskNode(
            task_id=task_id,
            name=name,
            executor=executor,
            dependencies=dependencies or [],
            priority=priority,
            timeout_ms=timeout_ms or self.config.default_timeout_ms,
            max_retries=max_retries if max_retries is not None else self.config.default_max_retries,
            metadata=metadata or {},
        )
        return task_id

    def add_task_with_id(
        self,
        task_id: str,
        name: str,
        executor: Callable[..., Awaitable[Any]],
        dependencies: list[str] | None = None,
        priority: TaskPriority = TaskPriority.NORMAL,
        timeout_ms: int | None = None,
        max_retries: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        self._tasks[task_id] = TaskNode(
            task_id=task_id,
            name=name,
            executor=executor,
            dependencies=dependencies or [],
            priority=priority,
            timeout_ms=timeout_ms or self.config.default_timeout_ms,
            max_retries=max_retries if max_retries is not None else self.config.default_max_retries,
            metadata=metadata or {},
        )
        if len(self._tasks) > self._MAX_TASKS:
            oldest_keys = list(self._tasks.keys())[: len(self._tasks) - (self._MAX_TASKS * 3 // 4)]
            for tid in oldest_keys:
                if tid != task_id:
                    del self._tasks[tid]
        return task_id

    def validate_dag(self) -> list[str]:
        errors: list[str] = []
        reported_cycles: set[str] = set()

        all_ids = set(self._tasks.keys())
        for task_id, task in self._tasks.items():
            for dep in task.dependencies:
                if dep not in all_ids:
                    errors.append(f"任务 {task_id} 依赖不存在的任务 {dep}")

        visited: set[str] = set()
        path: set[str] = set()

        def _check_cycle(tid: str) -> None:
            if tid in path:
                cycle_key = tid
                if cycle_key not in reported_cycles:
                    errors.append(f"检测到循环依赖: {tid}")
                    reported_cycles.add(cycle_key)
                return
            if tid in visited:
                return
            path.add(tid)
            task = self._tasks.get(tid)
            if task:
                for dep in task.dependencies:
                    _check_cycle(dep)
            path.discard(tid)
            visited.add(tid)

        for tid in self._tasks:
            _check_cycle(tid)

        return errors

    async def execute(self) -> OrchestrationResult:
        orchestration_id = f"orch_{uuid.uuid4().hex[:8]}"
        start = time.time()

        dag_errors = self.validate_dag()
        if dag_errors:
            return OrchestrationResult(
                orchestration_id=orchestration_id,
                status=TaskStatus.FAILED,
                tasks=self._tasks,
                total_duration_ms=int((time.time() - start) * 1000),
                errors=dag_errors,
            )

        self._semaphore = asyncio.Semaphore(self.config.max_concurrent)
        completed_results: dict[str, Any] = {}
        running_tasks: dict[str, asyncio.Task[None]] = {}
        task_done_event = asyncio.Event()

        def _get_ready_tasks() -> list[TaskNode]:
            ready: list[TaskNode] = []
            for task in self._tasks.values():
                if task.status != TaskStatus.PENDING:
                    continue
                all_deps_done = all(
                    self._tasks[dep].status
                    in (TaskStatus.COMPLETED, TaskStatus.SKIPPED)
                    for dep in task.dependencies
                    if dep in self._tasks
                )
                any_dep_failed = any(
                    self._tasks[dep].status
                    in (TaskStatus.FAILED, TaskStatus.CANCELLED)
                    for dep in task.dependencies
                    if dep in self._tasks
                )
                if any_dep_failed:
                    task.status = TaskStatus.SKIPPED
                    continue
                if all_deps_done:
                    ready.append(task)
            ready.sort(key=lambda t: t.priority.value)
            return ready

        async def _run_task(task: TaskNode) -> None:
            try:
                async with self._semaphore or asyncio.Semaphore(999):
                    task.status = TaskStatus.RUNNING
                    task_start = time.time()
                    attempts = 0

                    while attempts <= task.max_retries:
                        try:
                            timeout_sec = task.timeout_ms / 1000
                            result = await asyncio.wait_for(
                                task.executor(completed_results),
                                timeout=timeout_sec,
                            )
                            task.status = TaskStatus.COMPLETED
                            task.result = result
                            task.retry_count = attempts
                            task.duration_ms = int((time.time() - task_start) * 1000)
                            if self.config.collect_results:
                                completed_results[task.task_id] = result
                            return
                        except asyncio.TimeoutError:
                            task.error = f"任务超时 ({task.timeout_ms}ms)"
                            attempts += 1
                        except Exception as e:
                            log.debug("executor 异常处理", error=str(e))
                            task.error = str(e)
                            attempts += 1

                        if attempts <= task.max_retries:
                            await asyncio.sleep(0.5 * attempts)

                    task.status = TaskStatus.FAILED
                    task.duration_ms = int((time.time() - task_start) * 1000)

                    if self.config.fail_fast:
                        for t in self._tasks.values():
                            if t.status == TaskStatus.PENDING:
                                t.status = TaskStatus.CANCELLED
            finally:
                task_done_event.set()

        try:
            while True:
                ready = _get_ready_tasks()
                for task in ready:
                    if task.task_id not in running_tasks:
                        running_tasks[task.task_id] = asyncio.create_task(
                            _run_task(task)
                        )

                all_terminal = all(
                    t.status
                    in (
                        TaskStatus.COMPLETED,
                        TaskStatus.FAILED,
                        TaskStatus.CANCELLED,
                        TaskStatus.SKIPPED,
                    )
                    for t in self._tasks.values()
                )
                if all_terminal:
                    break

                if not running_tasks:
                    break

                done_task_ids: list[str] = []
                for tid, atask in list(running_tasks.items()):
                    if atask.done():
                        done_task_ids.append(tid)
                        if atask.cancelled():
                            log.warning("Task was cancelled", task_id=tid)
                        elif atask.exception() and not isinstance(
                            atask.exception(), (asyncio.TimeoutError, Exception)
                        ):
                            log.error(
                                "Task unexpected error",
                                task_id=tid,
                                error=str(atask.exception()),
                            )

                for tid in done_task_ids:
                    running_tasks.pop(tid, None)

                if not done_task_ids:
                    task_done_event.clear()
                    try:
                        await asyncio.wait_for(task_done_event.wait(), timeout=1.0)
                    except asyncio.TimeoutError:
                        pass
                    continue

        finally:
            for atask in running_tasks.values():
                if not atask.done():
                    atask.cancel()
            if running_tasks:
                await asyncio.gather(*running_tasks.values(), return_exceptions=True)

        completed_count = sum(
            1 for t in self._tasks.values() if t.status == TaskStatus.COMPLETED
        )
        failed_count = sum(
            1 for t in self._tasks.values() if t.status == TaskStatus.FAILED
        )
        skipped_count = sum(
            1 for t in self._tasks.values() if t.status == TaskStatus.SKIPPED
        )

        overall_status = TaskStatus.COMPLETED
        if failed_count > 0:
            overall_status = TaskStatus.PARTIALLY_COMPLETED if completed_count > 0 else TaskStatus.FAILED
        elif skipped_count > 0 and completed_count == 0:
            overall_status = TaskStatus.SKIPPED

        errors = [
            f"{tid}: {t.error}"
            for tid, t in self._tasks.items()
            if t.error
        ]

        return OrchestrationResult(
            orchestration_id=orchestration_id,
            status=overall_status,
            tasks={tid: copy.deepcopy(t) for tid, t in self._tasks.items()},
            total_duration_ms=int((time.time() - start) * 1000),
            completed_count=completed_count,
            failed_count=failed_count,
            skipped_count=skipped_count,
            aggregated_result=completed_results,
            errors=errors,
        )

    def reset(self) -> None:
        for task in self._tasks.values():
            task.status = TaskStatus.PENDING
            task.result = None
            task.error = None
            task.duration_ms = 0
            task.retry_count = 0

    def clear(self) -> None:
        self._tasks.clear()

    def get_task(self, task_id: str) -> TaskNode | None:
        return self._tasks.get(task_id)

    def get_all_tasks(self) -> dict[str, TaskNode]:
        return dict(self._tasks)

    def get_execution_order(self) -> list[list[str]]:
        dag_errors = self.validate_dag()
        if dag_errors:
            log.warning("Cannot compute execution order: DAG has errors", errors=dag_errors)
            return []

        if not self._tasks:
            return []

        remaining = set(self._tasks.keys())
        order: list[list[str]] = []

        while remaining:
            level: list[str] = []
            for tid in sorted(remaining):
                task = self._tasks[tid]
                if all(dep not in remaining for dep in task.dependencies):
                    level.append(tid)
            if not level:
                log.error("Execution order computation stuck: possible unreported cycle", remaining=remaining)
                break
            order.append(level)
            remaining -= set(level)

        return order
