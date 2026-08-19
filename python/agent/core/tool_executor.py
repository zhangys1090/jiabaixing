"""并行工具执行管道 (Parallel Tool Executor)。

将无依赖关系的工具调用并行执行，大幅降低多工具调用的总延迟。
支持：依赖分析、并行执行、超时控制、取消传播、结果聚合。

核心算法：
1. 分析工具调用列表，构建依赖图
2. 拓扑排序，识别可并行执行的分组
3. 每个分组内并发执行，组间串行
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine


class FailurePolicy(str, Enum):
    FAIL_FAST = "fail_fast"
    CONTINUE = "continue"
    CANCEL_REMAINING = "cancel_remaining"


@dataclass
class ToolCallItem:
    id: str
    name: str
    arguments: dict[str, Any]
    depends_on: list[str] = field(default_factory=list)
    timeout: float = 30.0
    retry_count: int = 0


@dataclass
class ToolCallResult:
    id: str
    name: str
    success: bool
    output: str = ""
    error: str = ""
    duration_ms: float = 0.0
    attempt: int = 1


@dataclass
class ParallelExecConfig:
    max_parallel: int = 8
    default_timeout: float = 30.0
    failure_policy: FailurePolicy = FailurePolicy.FAIL_FAST
    enabled: bool = True


@dataclass
class ParallelExecStats:
    total_calls: int = 0
    parallel_groups: int = 0
    total_duration_ms: float = 0.0
    serial_duration_ms: float = 0.0
    speedup_ratio: float = 0.0
    successes: int = 0
    failures: int = 0


class ParallelToolExecutor:
    def __init__(self, config: ParallelExecConfig | None = None) -> None:
        self._config = config or ParallelExecConfig()

    async def execute(
        self,
        tool_calls: list[ToolCallItem],
        executor_fn: Callable[[ToolCallItem], Coroutine[Any, Any, ToolCallResult]],
    ) -> tuple[list[ToolCallResult], ParallelExecStats]:
        if not tool_calls:
            return [], ParallelExecStats()
        if not self._config.enabled or len(tool_calls) == 1:
            return await self._execute_sequential(tool_calls, executor_fn)

        groups = self._build_parallel_groups(tool_calls)
        start_time = time.time()
        results_map: dict[str, ToolCallResult] = {}
        cancelled: set[str] = set()
        total_successes = 0
        total_failures = 0
        should_stop = False

        for group in groups:
            if cancelled or should_stop:
                for tc in group:
                    results_map[tc.id] = ToolCallResult(
                        id=tc.id, name=tc.name, success=False,
                        error="Cancelled due to previous failure",
                    )
                continue

            sem = asyncio.Semaphore(self._config.max_parallel)

            async def _run_one(
                tc: ToolCallItem,
                _sem: asyncio.Semaphore = sem,
            ) -> None:
                async with _sem:
                    result = await self._execute_with_timeout(tc, executor_fn)
                    results_map[tc.id] = result

            tasks = [asyncio.create_task(_run_one(tc)) for tc in group]
            gather_results = await asyncio.gather(*tasks, return_exceptions=True)

            for idx, gr in enumerate(gather_results):
                if isinstance(gr, BaseException):
                    tc = group[idx]
                    results_map[tc.id] = ToolCallResult(
                        id=tc.id, name=tc.name, success=False,
                        error=f"Task exception: {gr}",
                    )

            for tc in group:
                r = results_map.get(tc.id)
                if r:
                    if r.success:
                        total_successes += 1
                    else:
                        total_failures += 1
                        if self._config.failure_policy == FailurePolicy.FAIL_FAST:
                            cancelled.update(
                                tc.id for tc in tool_calls if tc.id not in results_map
                            )
                            should_stop = True
                            break
                        elif self._config.failure_policy == FailurePolicy.CANCEL_REMAINING:
                            for remaining_tc in tool_calls:
                                if remaining_tc.id not in results_map:
                                    cancelled.add(remaining_tc.id)
                            should_stop = True
                            break

        total_duration = (time.time() - start_time) * 1000
        serial_estimate = sum(r.duration_ms for r in results_map.values() if r.success)
        ordered_results = [results_map[tc.id] for tc in tool_calls]

        return ordered_results, ParallelExecStats(
            total_calls=len(tool_calls),
            parallel_groups=len(groups),
            total_duration_ms=total_duration,
            serial_duration_ms=serial_estimate,
            speedup_ratio=serial_estimate / max(total_duration, 1),
            successes=total_successes,
            failures=total_failures,
        )

    async def _execute_sequential(
        self, tool_calls: list[ToolCallItem], executor_fn: Callable,
    ) -> tuple[list[ToolCallResult], ParallelExecStats]:
        start = time.time()
        results: list[ToolCallResult] = []
        successes = 0
        failures = 0
        for tc in tool_calls:
            result = await self._execute_with_timeout(tc, executor_fn)
            results.append(result)
            if result.success:
                successes += 1
            else:
                failures += 1
                if self._config.failure_policy == FailurePolicy.FAIL_FAST:
                    for remaining in tool_calls[len(results):]:
                        results.append(ToolCallResult(
                            id=remaining.id, name=remaining.name,
                            success=False, error="Skipped due to previous failure",
                        ))
                    break
        total = (time.time() - start) * 1000
        return results, ParallelExecStats(
            total_calls=len(tool_calls), parallel_groups=1,
            total_duration_ms=total, serial_duration_ms=total,
            speedup_ratio=1.0, successes=successes, failures=failures,
        )

    async def _execute_with_timeout(
        self, tc: ToolCallItem, executor_fn: Callable,
    ) -> ToolCallResult:
        timeout = tc.timeout or self._config.default_timeout
        start = time.time()
        for attempt in range(tc.retry_count + 1):
            try:
                result = await asyncio.wait_for(executor_fn(tc), timeout=timeout)
                result.duration_ms = (time.time() - start) * 1000
                result.attempt = attempt + 1
                return result
            except asyncio.TimeoutError:
                if attempt >= tc.retry_count:
                    return ToolCallResult(
                        id=tc.id, name=tc.name, success=False,
                        error=f"Timeout after {timeout}s",
                        duration_ms=timeout * 1000, attempt=attempt + 1,
                    )
            except Exception as e:
                if attempt >= tc.retry_count:
                    return ToolCallResult(
                        id=tc.id, name=tc.name, success=False, error=str(e),
                        duration_ms=(time.time() - start) * 1000,
                        attempt=attempt + 1,
                    )
        return ToolCallResult(
            id=tc.id, name=tc.name, success=False,
            error="Max retries exceeded",
            duration_ms=(time.time() - start) * 1000,
            attempt=tc.retry_count + 1,
        )

    def _build_parallel_groups(
        self, tool_calls: list[ToolCallItem],
    ) -> list[list[ToolCallItem]]:
        completed: set[str] = set()
        remaining = list(tool_calls)
        groups: list[list[ToolCallItem]] = []
        while remaining:
            group: list[ToolCallItem] = []
            still_waiting: list[ToolCallItem] = []
            for tc in remaining:
                if all(dep in completed for dep in tc.depends_on):
                    group.append(tc)
                else:
                    still_waiting.append(tc)
            if not group:
                still_waiting.sort(key=lambda tc: len(tc.depends_on))
                group = [still_waiting[0]]
                still_waiting = still_waiting[1:]
            groups.append(group)
            for tc in group:
                completed.add(tc.id)
            remaining = still_waiting
        return groups

    @staticmethod
    def analyze_dependencies(
        tool_calls: list[ToolCallItem],
    ) -> dict[str, list[str]]:
        deps: dict[str, list[str]] = {}
        for tc in tool_calls:
            deps[tc.id] = list(tc.depends_on)
        return deps
