from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Literal

from agent.core.logger import StructuredLogger

log = StructuredLogger("fanout")

FanoutStrategy = Literal["parallel", "sequential", "adaptive"]


@dataclass
class SubTaskResult:
    """子任务执行结果。

    Attributes:
        task_id: 任务ID。
        success: 是否成功。
        result: 执行结果。
        error: 错误信息。
        duration_ms: 耗时（毫秒）。
        agent_id: 执行的Agent ID。
    """

    task_id: str
    success: bool
    result: Any = None
    error: str | None = None
    duration_ms: float = 0.0
    agent_id: str = ""


@dataclass
class FanoutResult:
    """扇出执行结果。

    Attributes:
        all_succeeded: 是否全部成功。
        total_count: 总任务数。
        success_count: 成功数。
        failed_count: 失败数。
        sub_results: 子任务结果列表。
        duration_ms: 总耗时（毫秒）。
    """

    all_succeeded: bool = False
    total_count: int = 0
    success_count: int = 0
    failed_count: int = 0
    sub_results: list[SubTaskResult] = field(default_factory=list)
    duration_ms: float = 0.0


@dataclass
class FanoutConfig:
    """扇出配置。

    Attributes:
        max_fanout: 最大并行数。
        strategy: 执行策略（parallel/sequential/adaptive）。
        task_timeout_ms: 单个任务超时（毫秒）。
        continue_on_partial_failure: 部分失败时是否继续。
    """

    max_fanout: int = 5
    strategy: FanoutStrategy = "adaptive"
    task_timeout_ms: float = 30_000.0
    continue_on_partial_failure: bool = True


@dataclass
class TaskNode:
    """DAG任务节点。

    Attributes:
        id: 任务ID。
        goal: 任务目标。
        dependencies: 依赖的任务ID列表。
        status: 任务状态（pending/running/completed/failed）。
        result: 执行结果。
        error: 错误信息。
        assigned_to: 分配的Agent ID。
    """

    id: str
    goal: str
    dependencies: list[str] = field(default_factory=list)
    status: str = "pending"
    result: Any = None
    error: str | None = None
    assigned_to: str | None = None


class SubAgentFanout:
    """Sub-Agent扇出机制——管理多Agent并行/顺序执行。

    支持三种策略：
    - parallel: 所有子任务并行执行（无依赖时）
    - sequential: 顺序执行（有依赖时）
    - adaptive: 根据任务依赖关系自动选择

    每个Sub-Agent独立上下文，通过信号量控制并发数。

    Usage:
        fanout = SubAgentFanout(FanoutConfig(max_fanout=3, strategy="adaptive"))
        tasks = [TaskNode(id="1", goal="分析代码"), TaskNode(id="2", goal="写测试")]
        result = await fanout.fanout(tasks, executor_fn)
        print(f"成功: {result.success_count}/{result.total_count}")
    """

    def __init__(self, config: FanoutConfig | None = None) -> None:
        self._config = config or FanoutConfig()
        self._semaphore = asyncio.Semaphore(self._config.max_fanout)

    async def fanout(
        self,
        tasks: list[TaskNode],
        executor: Any,
        parent_id: str = "",
    ) -> FanoutResult:
        """扇出执行任务列表。

        Args:
            tasks: 任务节点列表。
            executor: 任务执行器，需实现execute(task)方法。
            parent_id: 父任务ID。

        Returns:
            FanoutResult: 扇出执行结果。
        """
        import time

        start = time.time()

        if not tasks:
            return FanoutResult(all_succeeded=True)

        strategy = self._resolve_strategy(tasks)

        if strategy == "parallel":
            sub_results = await self._execute_parallel(tasks, executor)
        else:
            sub_results = await self._execute_sequential(tasks, executor)

        duration = (time.time() - start) * 1000
        success_count = sum(1 for r in sub_results if r.success)
        failed_count = len(sub_results) - success_count

        log.info(
            f"扇出完成: {success_count}/{len(tasks)} 成功",
            strategy=strategy,
            duration_ms=duration,
            parent_id=parent_id,
        )

        return FanoutResult(
            all_succeeded=failed_count == 0,
            total_count=len(tasks),
            success_count=success_count,
            failed_count=failed_count,
            sub_results=sub_results,
            duration_ms=duration,
        )

    async def _execute_parallel(
        self, tasks: list[TaskNode], executor: Any
    ) -> list[SubTaskResult]:
        sem_tasks = [self._execute_with_semaphore(task, executor) for task in tasks]
        return list(await asyncio.gather(*sem_tasks))

    async def _execute_sequential(
        self, tasks: list[TaskNode], executor: Any
    ) -> list[SubTaskResult]:
        results: list[SubTaskResult] = []
        for task in tasks:
            if task.dependencies:
                dep_failed = any(
                    not r.success
                    for r in results
                    if r.task_id in task.dependencies
                )
                if dep_failed and not self._config.continue_on_partial_failure:
                    results.append(
                        SubTaskResult(
                            task_id=task.id,
                            success=False,
                            error=f"依赖任务失败: {task.dependencies}",
                        )
                    )
                    break

            result = await self._execute_with_semaphore(task, executor)
            results.append(result)

            if not result.success and not self._config.continue_on_partial_failure:
                break

        return results

    async def _execute_with_semaphore(
        self, task: TaskNode, executor: Any
    ) -> SubTaskResult:
        import time

        async with self._semaphore:
            task.status = "running"
            start = time.time()

            try:
                result = await asyncio.wait_for(
                    self._execute_task(task, executor),
                    timeout=self._config.task_timeout_ms / 1000.0,
                )
                task.status = "completed"
                task.result = result
                return SubTaskResult(
                    task_id=task.id,
                    success=True,
                    result=result,
                    duration_ms=(time.time() - start) * 1000,
                    agent_id=task.assigned_to or "",
                )
            except asyncio.TimeoutError:
                task.status = "failed"
                task.error = f"超时 ({self._config.task_timeout_ms}ms)"
                return SubTaskResult(
                    task_id=task.id,
                    success=False,
                    error=task.error,
                    duration_ms=(time.time() - start) * 1000,
                    agent_id=task.assigned_to or "",
                )
            except Exception as e:
                task.status = "failed"
                task.error = str(e)
                return SubTaskResult(
                    task_id=task.id,
                    success=False,
                    error=str(e),
                    duration_ms=(time.time() - start) * 1000,
                    agent_id=task.assigned_to or "",
                )

    async def _execute_task(self, task: TaskNode, executor: Any) -> Any:
        if hasattr(executor, "execute"):
            return await executor.execute(task)
        if callable(executor):
            result = executor(task)
            if asyncio.iscoroutine(result):
                return await result
            return result
        raise ValueError(f"无效的执行器: {type(executor)}")

    def _resolve_strategy(self, tasks: list[TaskNode]) -> FanoutStrategy:
        if self._config.strategy != "adaptive":
            return self._config.strategy
        return "sequential" if self._has_dependencies(tasks) else "parallel"

    @staticmethod
    def _has_dependencies(tasks: list[TaskNode]) -> bool:
        return any(task.dependencies for task in tasks)

    def update_config(self, config: FanoutConfig) -> None:
        """更新配置并重建信号量。

        Args:
            config: 新的扇出配置。
        """
        self._config = config
        self._semaphore = asyncio.Semaphore(config.max_fanout)
