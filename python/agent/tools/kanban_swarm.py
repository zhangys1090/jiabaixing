"""审计 P2-1：Kanban 多代理可视化。

提供看板式多 Agent 任务可视化后端。
追踪每个 Agent 的任务状态，支持列式展示（待办/进行中/审查/完成）。

Usage:
    from agent.tools.kanban_swarm import KanbanSwarm

    swarm = KanbanSwarm()
    swarm.add_task("agent_1", "搜索文档", "todo")
    swarm.move_task("task_123", "in_progress")
    board = swarm.get_board()
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("kanban_swarm")




class KanbanColumn(str, Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    DONE = "done"
    BLOCKED = "blocked"


COLUMN_ORDER: list[KanbanColumn] = [
    KanbanColumn.TODO,
    KanbanColumn.IN_PROGRESS,
    KanbanColumn.REVIEW,
    KanbanColumn.DONE,
    KanbanColumn.BLOCKED,
]


@dataclass
class KanbanTask:
    """看板任务。"""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    agent_id: str = ""
    title: str = ""
    description: str = ""
    column: KanbanColumn = KanbanColumn.TODO
    priority: int = 0
    tags: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    assigned_to: str = ""
    parent_task_id: str = ""
    subtask_ids: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class KanbanAgent:
    """看板上的 Agent 卡片。"""
    id: str = ""
    name: str = ""
    role: str = "leaf"
    status: str = "idle"
    current_task_id: str = ""
    completed_count: int = 0
    blocked_count: int = 0
    avg_duration_ms: float = 0.0


class KanbanSwarm:
    """Kanban 多代理看板。

    管理看板上的任务和 Agent 状态，提供列式可视化数据。
    """

    _instance: KanbanSwarm | None = None

    @classmethod
    def get_instance(cls) -> KanbanSwarm:
        if cls._instance is None:
            cls._instance = KanbanSwarm()
        return cls._instance

    def __init__(self) -> None:
        self._tasks: dict[str, KanbanTask] = {}
        self._agents: dict[str, KanbanAgent] = {}
        self._board_name: str = "主看板"

    def register_agent(self, agent_id: str, name: str = "", role: str = "leaf") -> None:
        self._agents[agent_id] = KanbanAgent(id=agent_id, name=name or agent_id, role=role)
        log.debug("Agent 已注册到看板", agent_id=agent_id, name=name)

    def unregister_agent(self, agent_id: str) -> None:
        self._agents.pop(agent_id, None)

    def update_agent_status(self, agent_id: str, status: str, current_task_id: str = "") -> None:
        agent = self._agents.get(agent_id)
        if agent:
            agent.status = status
            if current_task_id:
                agent.current_task_id = current_task_id

    def add_task(
        self,
        agent_id: str,
        title: str,
        column: KanbanColumn = KanbanColumn.TODO,
        description: str = "",
        priority: int = 0,
        parent_task_id: str = "",
        tags: list[str] | None = None,
    ) -> KanbanTask:
        task = KanbanTask(
            agent_id=agent_id,
            title=title,
            description=description,
            column=column,
            priority=priority,
            parent_task_id=parent_task_id,
            tags=tags or [],
        )
        self._tasks[task.id] = task

        if parent_task_id and parent_task_id in self._tasks:
            parent = self._tasks[parent_task_id]
            parent.subtask_ids.append(task.id)

        if agent_id not in self._agents:
            self.register_agent(agent_id)

        log.info("看板任务已添加", task_id=task.id, title=title, column=column.value)
        return task

    def move_task(self, task_id: str, column: KanbanColumn) -> bool:
        task = self._tasks.get(task_id)
        if not task:
            return False

        old_column = task.column
        task.column = column
        task.updated_at = time.time()

        if column == KanbanColumn.DONE:
            agent = self._agents.get(task.agent_id)
            if agent:
                agent.completed_count += 1

        log.info("看板任务已移动", task_id=task_id, from_col=old_column.value, to_col=column.value)
        return True

    def assign_task(self, task_id: str, agent_id: str) -> bool:
        task = self._tasks.get(task_id)
        if not task:
            return False
        task.assigned_to = agent_id
        task.updated_at = time.time()

        if agent_id not in self._agents:
            self.register_agent(agent_id)

        return True

    def block_task(self, task_id: str, reason: str = "") -> bool:
        task = self._tasks.get(task_id)
        if not task:
            return False
        task.column = KanbanColumn.BLOCKED
        task.metadata["block_reason"] = reason
        task.updated_at = time.time()

        agent = self._agents.get(task.agent_id)
        if agent:
            agent.blocked_count += 1

        return True

    def get_task(self, task_id: str) -> KanbanTask | None:
        return self._tasks.get(task_id)

    def get_column_tasks(self, column: KanbanColumn) -> list[KanbanTask]:
        return sorted(
            [t for t in self._tasks.values() if t.column == column],
            key=lambda t: (-t.priority, t.created_at),
        )

    def get_agent_tasks(self, agent_id: str) -> list[KanbanTask]:
        return [t for t in self._tasks.values() if t.agent_id == agent_id]

    def get_board(self) -> dict[str, Any]:
        """获取完整看板数据。"""
        columns: dict[str, list[dict[str, Any]]] = {}
        for col in COLUMN_ORDER:
            columns[col.value] = [
                {
                    "id": t.id,
                    "title": t.title,
                    "agent_id": t.agent_id,
                    "priority": t.priority,
                    "tags": t.tags,
                    "assigned_to": t.assigned_to,
                    "parent_task_id": t.parent_task_id,
                    "subtask_count": len(t.subtask_ids),
                    "created_at": t.created_at,
                    "updated_at": t.updated_at,
                }
                for t in self.get_column_tasks(col)
            ]

        return {
            "board_name": self._board_name,
            "columns": columns,
            "agents": [
                {
                    "id": a.id,
                    "name": a.name,
                    "role": a.role,
                    "status": a.status,
                    "current_task_id": a.current_task_id,
                    "completed_count": a.completed_count,
                    "blocked_count": a.blocked_count,
                }
                for a in self._agents.values()
            ],
            "stats": {
                "total_tasks": len(self._tasks),
                "todo": len(self.get_column_tasks(KanbanColumn.TODO)),
                "in_progress": len(self.get_column_tasks(KanbanColumn.IN_PROGRESS)),
                "review": len(self.get_column_tasks(KanbanColumn.REVIEW)),
                "done": len(self.get_column_tasks(KanbanColumn.DONE)),
                "blocked": len(self.get_column_tasks(KanbanColumn.BLOCKED)),
                "total_agents": len(self._agents),
            },
        }

    def remove_task(self, task_id: str) -> bool:
        """从看板中移除任务。"""
        if task_id not in self._tasks:
            return False
        task = self._tasks.pop(task_id)
        if task.parent_task_id and task.parent_task_id in self._tasks:
            parent = self._tasks[task.parent_task_id]
            if task_id in parent.subtask_ids:
                parent.subtask_ids.remove(task_id)
        log.info("看板任务已移除", task_id=task_id)
        return True

    def get_agent_summary(self) -> list[dict[str, Any]]:
        """获取 Agent 摘要。"""
        return [
            {
                "id": a.id,
                "name": a.name,
                "role": a.role,
                "status": a.status,
                "current_task": self._tasks[a.current_task_id].title if a.current_task_id in self._tasks else "",
                "completed": a.completed_count,
                "blocked": a.blocked_count,
            }
            for a in self._agents.values()
        ]

    def clear_done(self) -> int:
        """清理已完成的任务。"""
        done_ids = [t.id for t in self._tasks.values() if t.column == KanbanColumn.DONE]
        for tid in done_ids:
            del self._tasks[tid]
        return len(done_ids)


# ==================== 工具注册 ====================

import json as _json
from agent.tools.registry import ToolDefinition, ToolParameterDef, ToolCategory, ToolResult, ToolExecutor


async def _kanban_get_board_executor(params: dict[str, Any]) -> ToolResult:
    """获取当前看板完整状态。"""
    swarm = KanbanSwarm.get_instance()
    board = swarm.get_board()
    return ToolResult(
        success=True,
        output=_json.dumps(board, ensure_ascii=False, indent=2),
        metadata={"total_tasks": board["stats"]["total_tasks"], "total_agents": board["stats"]["total_agents"]},
    )


async def _kanban_add_task_executor(params: dict[str, Any]) -> ToolResult:
    """在看板中新增一个任务。"""
    swarm = KanbanSwarm.get_instance()
    title = params.get("title", "")
    agent_id = params.get("agent_id", "default")
    column_str = params.get("column", "todo")
    priority = int(params.get("priority", 0))
    description = params.get("description", "")
    tags = [t.strip() for t in params.get("tags", "").split(",") if t.strip()]

    try:
        column = KanbanColumn(column_str)
    except ValueError:
        column = KanbanColumn.TODO

    task = swarm.add_task(
        agent_id=agent_id,
        title=title,
        column=column,
        description=description,
        priority=priority,
        tags=tags,
    )
    return ToolResult(
        success=True,
        output=f"任务已创建: {task.id} - {title}",
        metadata={"task_id": task.id, "column": column.value},
    )


async def _kanban_move_task_executor(params: dict[str, Any]) -> ToolResult:
    """在看板中移动任务到指定列。"""
    swarm = KanbanSwarm.get_instance()
    task_id = params.get("task_id", "")
    column_str = params.get("column", "in_progress")

    try:
        column = KanbanColumn(column_str)
    except ValueError:
        return ToolResult(success=False, error=f"无效的列名: {column_str}")

    ok = swarm.move_task(task_id, column)
    if ok:
        return ToolResult(
            success=True,
            output=f"任务 {task_id} 已移动到 {column.value}",
            metadata={"task_id": task_id, "column": column.value},
        )
    return ToolResult(success=False, error=f"任务 {task_id} 不存在")


KANBAN_GET_BOARD_DEF = ToolDefinition(
    name="kanban_get_board",
    description="获取 Kanban 多代理看板的完整状态，包括所有列的任务和 Agent 状态。用于多 Agent 任务调试与可视化。",
    short_desc="获取看板状态",
    category=ToolCategory.SYSTEM,
    tags=["kanban", "visualization", "debug", "multi-agent"],
    scenes=["multi_agent", "debugging", "work"],
    capability_level=1,
    parameters=[],
    risk_level="low",
)

KANBAN_ADD_TASK_DEF = ToolDefinition(
    name="kanban_add_task",
    description="在 Kanban 看板中新增一个任务。Agent 委派任务后可记录到看板进行追踪。",
    short_desc="新增看板任务",
    category=ToolCategory.SYSTEM,
    tags=["kanban", "task", "multi-agent"],
    scenes=["multi_agent", "work"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="title", type="string", required=True, description="任务标题"),
        ToolParameterDef(name="agent_id", type="string", required=False, description="Agent ID，默认 'default'"),
        ToolParameterDef(name="column", type="string", required=False, description="目标列: todo/in_progress/review/done/blocked"),
        ToolParameterDef(name="priority", type="integer", required=False, description="优先级，数字越大越优先"),
        ToolParameterDef(name="description", type="string", required=False, description="任务描述"),
        ToolParameterDef(name="tags", type="string", required=False, description="标签，逗号分隔"),
    ],
    risk_level="low",
)

KANBAN_MOVE_TASK_DEF = ToolDefinition(
    name="kanban_move_task",
    description="将看板中的任务移动到指定列（如从 todo 移动到 in_progress）。",
    short_desc="移动看板任务",
    category=ToolCategory.SYSTEM,
    tags=["kanban", "task", "flow"],
    scenes=["multi_agent", "work"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="task_id", type="string", required=True, description="任务 ID"),
        ToolParameterDef(name="column", type="string", required=True, description="目标列: todo/in_progress/review/done/blocked"),
    ],
    risk_level="low",
)


def register_kanban_tools(registry: Any) -> None:
    """注册 Kanban 看板工具到工具注册中心。"""
    registry.register(KANBAN_GET_BOARD_DEF, _kanban_get_board_executor)
    registry.register(KANBAN_ADD_TASK_DEF, _kanban_add_task_executor)
    registry.register(KANBAN_MOVE_TASK_DEF, _kanban_move_task_executor)
