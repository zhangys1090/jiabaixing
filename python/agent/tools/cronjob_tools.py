"""审计 P2-3：Cronjob 自动化模板。

提供定时任务的定义、调度和监控能力。
Agent 可以创建"每天早上9点汇总新闻"类的定时任务蓝图。

Usage:
    from agent.tools.cronjob_tools import CronjobManager, CronjobBlueprint

    manager = CronjobManager()
    blueprint = CronjobBlueprint(
        name="每日新闻汇总",
        schedule="0 9 * * *",
        task="搜索今日头条新闻并生成摘要",
        enabled=True,
    )
    manager.register(blueprint)
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
from agent.core.logger import StructuredLogger
log = StructuredLogger("cronjob_tools")



class CronjobStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    DISABLED = "disabled"


@dataclass
class CronjobBlueprint:
    """定时任务蓝图。

    Attributes:
        name: 任务名称。
        schedule: cron 表达式（如 "0 9 * * *"）。
        task: 任务描述（给 Agent 的 prompt）。
        enabled: 是否启用。
        tags: 分类标签。
        timeout: 超时秒数。
        max_retries: 失败重试次数。
    """
    name: str
    schedule: str
    task: str
    enabled: bool = True
    tags: list[str] = field(default_factory=list)
    timeout: float = 300.0
    max_retries: int = 2

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    created_at: float = field(default_factory=time.time)


@dataclass
class CronjobRun:
    """定时任务执行记录。"""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    blueprint_id: str = ""
    status: CronjobStatus = CronjobStatus.ACTIVE
    started_at: float = 0.0
    completed_at: float = 0.0
    result: str = ""
    error: str = ""
    retry_count: int = 0


class CronjobManager:
    """定时任务管理器。

    管理定时任务蓝图的注册、调度、执行和监控。
    """

    _instance: CronjobManager | None = None

    @classmethod
    def get_instance(cls) -> CronjobManager:
        if cls._instance is None:
            cls._instance = CronjobManager()
        return cls._instance

    def __init__(self) -> None:
        self._blueprints: dict[str, CronjobBlueprint] = {}
        self._runs: dict[str, CronjobRun] = {}
        self._executor: Callable[..., Awaitable[str]] | None = None
        self._scheduler_task: asyncio.Task[None] | None = None
        self._stats = {"total_runs": 0, "total_success": 0, "total_failure": 0}
        self._MAX_STATS = 500

    def set_executor(self, executor: Callable[..., Awaitable[str]]) -> None:
        """设置任务执行器（Agent 核心）。"""
        self._executor = executor

    def register(self, blueprint: CronjobBlueprint) -> str:
        self._blueprints[blueprint.id] = blueprint
        log.debug("定时任务已注册", name=blueprint.name, schedule=blueprint.schedule)
        return blueprint.id

    def unregister(self, blueprint_id: str) -> bool:
        if blueprint_id in self._blueprints:
            del self._blueprints[blueprint_id]
            return True
        return False

    def get_blueprint(self, blueprint_id: str) -> CronjobBlueprint | None:
        return self._blueprints.get(blueprint_id)

    def list_blueprints(self, enabled_only: bool = False) -> list[CronjobBlueprint]:
        result = list(self._blueprints.values())
        if enabled_only:
            result = [b for b in result if b.enabled]
        return result

    def enable(self, blueprint_id: str) -> bool:
        bp = self._blueprints.get(blueprint_id)
        if bp:
            bp.enabled = True
            return True
        return False

    def disable(self, blueprint_id: str) -> bool:
        bp = self._blueprints.get(blueprint_id)
        if bp:
            bp.enabled = False
            return True
        return False

    async def execute_blueprint(self, blueprint_id: str) -> CronjobRun:
        """执行指定蓝图。"""
        bp = self._blueprints.get(blueprint_id)
        run = CronjobRun(blueprint_id=blueprint_id, started_at=time.time())
        self._runs[run.id] = run
        self._stats["total_runs"] += 1

        if not bp:
            run.status = CronjobStatus.FAILED
            run.error = "蓝图不存在"
            run.completed_at = time.time()
            return run

        if not self._executor:
            run.status = CronjobStatus.FAILED
            run.error = "未设置执行器"
            run.completed_at = time.time()
            return run

        for attempt in range(bp.max_retries + 1):
            try:
                result = await asyncio.wait_for(
                    self._executor(bp.task),
                    timeout=bp.timeout,
                )
                run.status = CronjobStatus.COMPLETED
                run.result = result
                run.completed_at = time.time()
                self._stats["total_success"] += 1
                log.info("定时任务执行成功", name=bp.name, attempt=attempt + 1)
                return run
            except asyncio.TimeoutError:
                run.retry_count = attempt + 1
                if attempt < bp.max_retries:
                    log.warning("定时任务超时，重试中", name=bp.name, attempt=attempt + 1)
                else:
                    run.status = CronjobStatus.FAILED
                    run.error = f"超时（{bp.timeout}s），已重试{bp.max_retries}次"
                    run.completed_at = time.time()
                    self._stats["total_failure"] += 1
            except Exception as e:
                log.debug("cronjob_tools 异常处理", error=str(e))
                run.retry_count = attempt + 1
                if attempt < bp.max_retries:
                    log.warning("定时任务失败，重试中", name=bp.name, error=str(e))
                else:
                    run.status = CronjobStatus.FAILED
                    run.error = str(e)
                    run.completed_at = time.time()
                    self._stats["total_failure"] += 1

        return run

    def get_run_history(self, blueprint_id: str | None = None, limit: int = 20) -> list[CronjobRun]:
        runs = list(self._runs.values())
        if blueprint_id:
            runs = [r for r in runs if r.blueprint_id == blueprint_id]
        runs.sort(key=lambda r: r.started_at, reverse=True)
        return runs[:limit]

    def get_stats(self) -> dict[str, Any]:
        return {
            "blueprints": len(self._blueprints),
            "enabled_blueprints": len([b for b in self._blueprints.values() if b.enabled]),
            **self._stats,
        }


# ==================== 工具定义 ====================

CRONJOB_CREATE_DEF = ToolDefinition(
    name="cronjob_create",
    description="创建定时任务蓝图。Agent 可定义周期性自动执行的任务，如每日新闻汇总、每周报告生成。",
    short_desc="创建定时任务",
    category=ToolCategory.SYSTEM,
    tags=["cronjob", "schedule", "automation", "template"],
    scenes=["daily", "work", "briefing"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="name", type="string", required=True, description="任务名称"),
        ToolParameterDef(name="schedule", type="string", required=True, description="cron 表达式，如 '0 9 * * *'"),
        ToolParameterDef(name="task", type="string", required=True, description="任务描述（给 Agent 的 prompt）"),
        ToolParameterDef(name="tags", type="string", required=False, description="标签，逗号分隔"),
    ],
    risk_level="medium",
)

CRONJOB_LIST_DEF = ToolDefinition(
    name="cronjob_list",
    description="列出所有已注册的定时任务蓝图。",
    short_desc="列出定时任务",
    category=ToolCategory.SYSTEM,
    tags=["cronjob", "list", "schedule"],
    scenes=["daily", "work"],
    capability_level=1,
    parameters=[],
    risk_level="low",
)

CRONJOB_EXECUTE_DEF = ToolDefinition(
    name="cronjob_execute",
    description="手动执行指定定时任务。",
    short_desc="执行定时任务",
    category=ToolCategory.SYSTEM,
    tags=["cronjob", "execute", "manual"],
    scenes=["daily", "work"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="blueprint_id", type="string", required=True, description="任务蓝图 ID"),
    ],
    risk_level="medium",
)


async def cronjob_create_executor(params: dict[str, Any]) -> ToolResult:
    import time as _time
    start = _time.time()
    name = str(params.get("name", ""))
    schedule = str(params.get("schedule", ""))
    task = str(params.get("task", ""))
    tags_str = str(params.get("tags", ""))

    if not name or not schedule or not task:
        return ToolResult(success=False, error="name/schedule/task 不能为空")

    tags = [t.strip() for t in tags_str.split(",") if t.strip()] if tags_str else []
    blueprint = CronjobBlueprint(name=name, schedule=schedule, task=task, tags=tags)

    manager = CronjobManager.get_instance()
    bid = manager.register(blueprint)

    return ToolResult(
        success=True,
        output=f"定时任务已创建: {name} (ID: {bid})\n调度: {schedule}\n任务: {task[:200]}",
        duration=_time.time() - start,
        metadata={"blueprint_id": bid, "name": name, "schedule": schedule},
    )


async def cronjob_list_executor(params: dict[str, Any]) -> ToolResult:
    import time as _time
    start = _time.time()
    manager = CronjobManager.get_instance()
    blueprints = manager.list_blueprints()

    if not blueprints:
        return ToolResult(success=True, output="暂无定时任务", duration=_time.time() - start)

    lines = []
    for bp in blueprints:
        status = "启用" if bp.enabled else "禁用"
        lines.append(f"- [{status}] {bp.name} (ID: {bp.id}) | {bp.schedule} | {bp.task[:80]}")

    return ToolResult(
        success=True,
        output="定时任务列表:\n" + "\n".join(lines),
        duration=_time.time() - start,
        metadata={"count": len(blueprints)},
    )


async def cronjob_execute_executor(params: dict[str, Any]) -> ToolResult:
    import time as _time
    start = _time.time()
    blueprint_id = str(params.get("blueprint_id", ""))

    if not blueprint_id:
        return ToolResult(success=False, error="blueprint_id 不能为空")

    manager = CronjobManager.get_instance()
    run = await manager.execute_blueprint(blueprint_id)

    if run.status == CronjobStatus.COMPLETED:
        return ToolResult(
            success=True,
            output=f"定时任务执行成功:\n{run.result[:5000]}",
            duration=_time.time() - start,
            metadata={"run_id": run.id, "status": run.status.value},
        )
    else:
        return ToolResult(
            success=False,
            error=run.error or "执行失败",
            duration=_time.time() - start,
            metadata={"run_id": run.id, "status": run.status.value},
        )


def register_cronjob_tools(registry: Any) -> None:
    """注册 Cronjob 工具到工具注册中心。"""
    registry.register(CRONJOB_CREATE_DEF, cronjob_create_executor)
    registry.register(CRONJOB_LIST_DEF, cronjob_list_executor)
    registry.register(CRONJOB_EXECUTE_DEF, cronjob_execute_executor)
