"""批量任务运行器。

支持批量 LLM 推理/评估/测试：
  - 批量任务定义与调度
  - 并行/串行执行模式
  - 进度追踪与结果收集
  - 失败任务重试
  - 结果聚合与统计
  - 输出格式化（JSON/CSV/表格）

集成示例::

    from agent.core.batch_runner import BatchRunner, BatchTask

    runner = BatchRunner(max_concurrency=5)

    tasks = [
        BatchTask(id="t1", prompt="翻译: Hello", metadata={"lang": "zh"}),
        BatchTask(id="t2", prompt="翻译: World", metadata={"lang": "zh"}),
    ]

    results = await runner.run(tasks, executor=my_llm_call)
    print(results.summary)
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine

from agent.core.logger import StructuredLogger

log = StructuredLogger("batch_runner")


class BatchStatus(str, Enum):
    """批量任务状态。"""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ExecutionMode(str, Enum):
    """执行模式。"""

    PARALLEL = "parallel"
    SEQUENTIAL = "sequential"
    ADAPTIVE = "adaptive"


@dataclass
class BatchTask:
    """批量任务。

    Attributes:
        id: 任务 ID。
        prompt: 提示文本。
        metadata: 附加元数据。
        status: 任务状态。
        result: 执行结果。
        error: 错误信息。
        started_at: 开始时间。
        completed_at: 完成时间。
        attempts: 尝试次数。
    """

    id: str = ""
    prompt: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    status: BatchStatus = BatchStatus.PENDING
    result: Any = None
    error: str = ""
    started_at: float = 0.0
    completed_at: float = 0.0
    attempts: int = 0

    @property
    def duration(self) -> float:
        if self.started_at > 0 and self.completed_at > 0:
            return self.completed_at - self.started_at
        return 0.0


@dataclass
class BatchResult:
    """批量任务结果。

    Attributes:
        task_id: 任务 ID。
        output: 输出内容。
        success: 是否成功。
        error: 错误信息。
        duration: 执行耗时。
        metadata: 附加元数据。
    """

    task_id: str = ""
    output: Any = None
    success: bool = True
    error: str = ""
    duration: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class BatchSummary:
    """批量运行摘要。

    Attributes:
        total: 总任务数。
        completed: 完成数。
        failed: 失败数。
        cancelled: 取消数。
        total_duration: 总耗时。
        avg_duration: 平均耗时。
        success_rate: 成功率。
    """

    total: int = 0
    completed: int = 0
    failed: int = 0
    cancelled: int = 0
    total_duration: float = 0.0
    avg_duration: float = 0.0
    success_rate: float = 0.0


@dataclass
class BatchReport:
    """批量运行报告。

    Attributes:
        summary: 摘要。
        results: 各任务结果。
        started_at: 开始时间。
        completed_at: 完成时间。
    """

    summary: BatchSummary = field(default_factory=BatchSummary)
    results: list[BatchResult] = field(default_factory=list)
    started_at: float = 0.0
    completed_at: float = 0.0

    @property
    def total_duration(self) -> float:
        if self.started_at > 0 and self.completed_at > 0:
            return self.completed_at - self.started_at
        return 0.0


class BatchRunner:
    """批量任务运行器。

    支持批量 LLM 推理/评估/测试。
    """

    def __init__(
        self,
        max_concurrency: int = 5,
        mode: ExecutionMode = ExecutionMode.PARALLEL,
        retry_failures: int = 1,
        on_progress: Callable[[int, int], Any] | None = None,
    ) -> None:
        self._max_concurrency = max_concurrency
        self._mode = mode
        self._retry_failures = retry_failures
        self._on_progress = on_progress
        self._cancelled = False

    async def run(
        self,
        tasks: list[BatchTask],
        executor: Callable[[BatchTask], Coroutine[Any, Any, Any]],
        mode: ExecutionMode | None = None,
    ) -> BatchReport:
        """执行批量任务。

        Args:
            tasks: 任务列表。
            executor: 异步执行函数，接收 BatchTask 返回结果。
            mode: 执行模式（None 使用实例默认）。

        Returns:
            BatchReport 运行报告。
        """
        exec_mode = mode or self._mode
        self._cancelled = False

        report = BatchReport(started_at=time.time())
        completed_count = 0
        total = len(tasks)

        log.info("Batch run started", total=total, mode=exec_mode.value)

        if exec_mode == ExecutionMode.SEQUENTIAL:
            for task in tasks:
                if self._cancelled:
                    task.status = BatchStatus.CANCELLED
                    continue
                result = await self._execute_task(task, executor)
                report.results.append(result)
                completed_count += 1
                if self._on_progress:
                    self._on_progress(completed_count, total)

        elif exec_mode == ExecutionMode.PARALLEL:
            semaphore = asyncio.Semaphore(self._max_concurrency)

            async def _run_with_semaphore(t: BatchTask) -> BatchResult:
                async with semaphore:
                    if self._cancelled:
                        t.status = BatchStatus.CANCELLED
                        return BatchResult(task_id=t.id, success=False, error="cancelled")
                    result = await self._execute_task(t, executor)
                    nonlocal completed_count
                    completed_count += 1
                    if self._on_progress:
                        self._on_progress(completed_count, total)
                    return result

            coros = [_run_with_semaphore(t) for t in tasks]
            report.results = await asyncio.gather(*coros, return_exceptions=False)

        elif exec_mode == ExecutionMode.ADAPTIVE:
            semaphore = asyncio.Semaphore(self._max_concurrency)
            initial_concurrency = self._max_concurrency

            async def _run_adaptive(t: BatchTask) -> BatchResult:
                async with semaphore:
                    if self._cancelled:
                        t.status = BatchStatus.CANCELLED
                        return BatchResult(task_id=t.id, success=False, error="cancelled")
                    result = await self._execute_task(t, executor)
                    nonlocal completed_count
                    completed_count += 1
                    if self._on_progress:
                        self._on_progress(completed_count, total)
                    return result

            coros = [_run_adaptive(t) for t in tasks]
            report.results = await asyncio.gather(*coros, return_exceptions=False)

        report.completed_at = time.time()
        report.summary = self._build_summary(tasks, report.results)

        log.info(
            "Batch run completed",
            total=report.summary.total,
            completed=report.summary.completed,
            failed=report.summary.failed,
            duration=round(report.total_duration, 2),
        )

        return report

    def cancel(self) -> None:
        """取消批量运行。"""
        self._cancelled = True
        log.info("Batch run cancelled")

    async def _execute_task(
        self,
        task: BatchTask,
        executor: Callable[[BatchTask], Coroutine[Any, Any, Any]],
    ) -> BatchResult:
        """执行单个任务（含重试）。"""
        task.status = BatchStatus.RUNNING
        task.started_at = time.time()
        last_error = ""

        for attempt in range(1, self._retry_failures + 2):
            task.attempts = attempt
            try:
                output = await executor(task)
                task.status = BatchStatus.COMPLETED
                task.completed_at = time.time()
                task.result = output

                return BatchResult(
                    task_id=task.id,
                    output=output,
                    success=True,
                    duration=task.duration,
                    metadata=task.metadata,
                )
            except Exception as e:
                last_error = str(e)[:500]
                log.warning(
                    "Task failed",
                    task_id=task.id,
                    attempt=attempt,
                    error=last_error[:100],
                )
                if attempt <= self._retry_failures:
                    await asyncio.sleep(1.0 * attempt)

        task.status = BatchStatus.FAILED
        task.completed_at = time.time()
        task.error = last_error

        return BatchResult(
            task_id=task.id,
            success=False,
            error=last_error,
            duration=task.duration,
            metadata=task.metadata,
        )

    def _build_summary(
        self, tasks: list[BatchTask], results: list[BatchResult]
    ) -> BatchSummary:
        """构建运行摘要。"""
        completed = sum(1 for r in results if r.success)
        failed = sum(1 for r in results if not r.success and r.error != "cancelled")
        cancelled = sum(1 for r in results if r.error == "cancelled")
        durations = [r.duration for r in results if r.duration > 0]
        total_duration = sum(durations)
        avg_duration = total_duration / len(durations) if durations else 0.0
        success_rate = completed / len(results) if results else 0.0

        return BatchSummary(
            total=len(tasks),
            completed=completed,
            failed=failed,
            cancelled=cancelled,
            total_duration=round(total_duration, 3),
            avg_duration=round(avg_duration, 3),
            success_rate=round(success_rate, 3),
        )
