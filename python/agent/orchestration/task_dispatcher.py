"""
task_dispatcher.py — DAG 任务调度器（已合并到 OrchestrationExecutor）

⚠️ 此文件为兼容性重导出层。实际实现在 orchestration/executor.py。
所有新代码请直接使用 OrchestrationExecutor。
"""
from __future__ import annotations

import warnings
from typing import Any

from agent.orchestration.executor import (
    DAGValidationError,
    OrchestrationConfig,
    OrchestrationExecutor,
    OrchestrationResult,
    TaskNode,
    TaskPriority,
    TaskStatus,
)

warnings.warn(
    "task_dispatcher.TaskDispatcher is deprecated. Use orchestration.executor.OrchestrationExecutor instead.",
    DeprecationWarning,
    stacklevel=2,
)

__all__ = [
    "DAGValidationError",
    "OrchestrationConfig",
    "OrchestrationExecutor",
    "OrchestrationResult",
    "TaskNode",
    "TaskPriority",
    "TaskStatus",
    "TaskDispatcher",
]


class TaskDispatcher:
    """已弃用 — 请使用 OrchestrationExecutor。"""
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._inner = OrchestrationExecutor(
            config=kwargs.get("config", OrchestrationConfig(
                max_concurrent=kwargs.get("max_concurrent_per_layer", 3),
                default_timeout_ms=kwargs.get("default_timeout_ms", 30000),
                default_max_retries=kwargs.get("max_retries", 2),
            ))
        )

    async def dispatch(self, tasks: list[dict[str, Any]]) -> dict[str, Any]:
        """兼容旧 dispatch 接口。"""
        for t in tasks:
            deps = t.get("dependencies", []) or []
            self._inner.add_task(
                name=t.get("goal", t.get("id", "")),
                executor=lambda _: {"task_id": t.get("id", ""), "result": None},
                dependencies=deps,
                metadata={"task_id": t.get("id", "")},
            )
        result = await self._inner.execute()
        return result.aggregated_result or {}

    def cancel_task(self, task_id: str) -> None:
        pass
