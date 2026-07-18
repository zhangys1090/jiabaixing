"""TODO 规划工具——管理结构化的待办事项列表。

提供带依赖关系的 TODO 管理能力，支持添加、更新、查询、进度统计等
操作。TodoManager 可独立使用，不依赖 AgentEngine。

Usage:
    from agent.tools.todo_tool import register_todo_tool
    register_todo_tool(registry)
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
    ToolRegistry,
)


# ==================== 数据模型 ====================


@dataclass
class TodoItem:
    """待办事项条目。

    Attributes:
        id: 唯一标识。
        title: 标题。
        description: 详细描述。
        status: 当前状态（pending/in_progress/completed/cancelled）。
        priority: 优先级（low/medium/high）。
        dependencies: 依赖的 TodoItem ID 列表。
        created_at: 创建时间戳。
    """

    id: str = ""
    title: str = ""
    description: str = ""
    status: str = "pending"
    priority: str = "medium"
    dependencies: list[str] = field(default_factory=list)
    created_at: float = 0.0


# ==================== TodoManager ====================


class TodoManager:
    """TODO 列表管理器。

    管理带依赖关系的待办事项，支持增删改查、依赖检查和进度统计。
    可独立使用，不依赖 AgentEngine。

    Usage:
        mgr = TodoManager()
        t1 = mgr.add_todo("任务A", "描述A", "high")
        t2 = mgr.add_todo("任务B", "描述B", "medium", dependencies=[t1.id])
        next_item = mgr.get_next_todo()  # 返回 t1（t2 依赖 t1）
    """

    VALID_STATUSES = ("pending", "in_progress", "completed", "cancelled")
    VALID_PRIORITIES = ("low", "medium", "high")
    PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}

    def __init__(self) -> None:
        self._todos: dict[str, TodoItem] = {}

    def add_todo(
        self,
        title: str,
        description: str = "",
        priority: str = "medium",
        dependencies: list[str] | None = None,
    ) -> TodoItem:
        """添加一条待办事项。

        Args:
            title: 标题。
            description: 详细描述。
            priority: 优先级（low/medium/high）。
            dependencies: 依赖的 TodoItem ID 列表。

        Returns:
            TodoItem: 新创建的待办事项。

        Raises:
            ValueError: priority 不合法时抛出。
        """
        if priority not in self.VALID_PRIORITIES:
            raise ValueError(f"无效优先级: {priority}，有效值: {self.VALID_PRIORITIES}")

        item = TodoItem(
            id=uuid.uuid4().hex[:12],
            title=title,
            description=description,
            status="pending",
            priority=priority,
            dependencies=dependencies or [],
            created_at=time.time(),
        )
        self._todos[item.id] = item
        return item

    def update_todo(self, todo_id: str, status: str) -> TodoItem | None:
        """更新待办事项状态。

        Args:
            todo_id: 待办事项 ID。
            status: 新状态（pending/in_progress/completed/cancelled）。

        Returns:
            TodoItem | None: 更新后的待办事项，未找到则返回 None。

        Raises:
            ValueError: status 不合法时抛出。
        """
        if status not in self.VALID_STATUSES:
            raise ValueError(f"无效状态: {status}，有效值: {self.VALID_STATUSES}")

        item = self._todos.get(todo_id)
        if item is None:
            return None
        item.status = status
        return item

    def get_todo(self, todo_id: str) -> TodoItem | None:
        """获取指定 ID 的待办事项。

        Args:
            todo_id: 待办事项 ID。

        Returns:
            TodoItem | None: 对应的待办事项，未找到则返回 None。
        """
        return self._todos.get(todo_id)

    def list_todos(self, status_filter: str | None = None) -> list[TodoItem]:
        """列出待办事项，可按状态过滤。

        Args:
            status_filter: 状态过滤，None 表示全部。

        Returns:
            list[TodoItem]: 待办事项列表，按优先级排序。
        """
        items = list(self._todos.values())
        if status_filter:
            items = [i for i in items if i.status == status_filter]
        items.sort(key=lambda i: (self.PRIORITY_ORDER.get(i.priority, 1), i.created_at))
        return items

    def get_next_todo(self) -> TodoItem | None:
        """获取下一个可执行的待办事项。

        可执行条件：状态为 pending 且所有依赖项均已完成或已取消。

        Returns:
            TodoItem | None: 下一个可执行的待办事项，无则返回 None。
        """
        completed_statuses = {"completed", "cancelled"}
        candidates: list[TodoItem] = []
        for item in self._todos.values():
            if item.status != "pending":
                continue
            # 检查依赖是否全部完成
            deps_met = all(
                self._todos.get(dep_id) is not None
                and self._todos[dep_id].status in completed_statuses
                for dep_id in item.dependencies
            )
            if deps_met:
                candidates.append(item)

        if not candidates:
            return None
        candidates.sort(key=lambda i: (self.PRIORITY_ORDER.get(i.priority, 1), i.created_at))
        return candidates[0]

    def get_progress(self) -> dict[str, Any]:
        """获取进度统计。

        Returns:
            dict: 包含 total/pending/in_progress/completed/cancelled 的计数
                及 completion_rate 百分比。
        """
        total = len(self._todos)
        counts: dict[str, int] = {"pending": 0, "in_progress": 0, "completed": 0, "cancelled": 0}
        for item in self._todos.values():
            if item.status in counts:
                counts[item.status] += 1

        completion_rate = 0.0
        if total > 0:
            completion_rate = round(counts["completed"] / total * 100, 1)

        return {
            "total": total,
            **counts,
            "completion_rate": completion_rate,
        }

    def format_todos(self) -> str:
        """将 TODO 列表格式化为可读文本。

        Returns:
            str: 格式化后的文本。
        """
        items = self.list_todos()
        if not items:
            return "（暂无待办事项）"

        status_icons = {
            "pending": "⬜",
            "in_progress": "🔄",
            "completed": "✅",
            "cancelled": "❌",
        }
        priority_labels = {
            "high": "🔴高",
            "medium": "🟡中",
            "low": "🟢低",
        }

        lines: list[str] = []
        for item in items:
            icon = status_icons.get(item.status, "⬜")
            pri = priority_labels.get(item.priority, "🟡中")
            dep_str = ""
            if item.dependencies:
                dep_str = f" ← 依赖[{', '.join(item.dependencies)}]"
            lines.append(
                f"  {icon} [{item.id}] {item.title} ({pri}){dep_str}"
            )
        return "\n".join(lines)


# ==================== 全局单例 ====================

_global_todo_manager: TodoManager | None = None


def _get_todo_manager() -> TodoManager:
    """获取全局 TodoManager 单例。

    Returns:
        TodoManager: 全局唯一的 TodoManager 实例。
    """
    global _global_todo_manager
    if _global_todo_manager is None:
        _global_todo_manager = TodoManager()
    return _global_todo_manager


# ==================== 工具定义 ====================

TODO_DEF = ToolDefinition(
    name="todo",
    description=(
        "TODO 规划工具——管理带依赖关系的结构化待办事项。"
        "支持添加、更新、列表、获取下一个可执行项、进度统计。"
        "适用场景：任务拆解、多步规划、依赖管理。不适用：简单一次性任务。"
    ),
    short_desc="TODO 规划管理",
    category=ToolCategory.COGNITION,
    tags=["todo", "plan", "task", "dependency"],
    scenes=["coding", "work", "daily", "research"],
    capability_level=1,
    parameters=[
        ToolParameterDef(
            name="action",
            type="string",
            required=True,
            description="操作类型",
            enum=["add", "update", "list", "next", "progress"],
        ),
        ToolParameterDef(
            name="title",
            type="string",
            required=False,
            description="待办标题（add 时使用）",
        ),
        ToolParameterDef(
            name="description",
            type="string",
            required=False,
            description="待办描述（add 时使用）",
        ),
        ToolParameterDef(
            name="todo_id",
            type="string",
            required=False,
            description="待办 ID（update 时使用）",
        ),
        ToolParameterDef(
            name="status",
            type="string",
            required=False,
            description="目标状态（update 时使用）",
            enum=["pending", "in_progress", "completed", "cancelled"],
        ),
        ToolParameterDef(
            name="priority",
            type="string",
            required=False,
            description="优先级（add 时使用）",
            enum=["low", "medium", "high"],
        ),
    ],
    risk_level="low",
)


# ==================== 执行器 ====================


async def todo_executor(params: dict[str, Any]) -> ToolResult:
    """执行 TODO 工具操作。

    Args:
        params: 工具参数字典，包含 action 及对应参数。

    Returns:
        ToolResult: 操作结果。
    """
    start = time.time()
    action = str(params.get("action", "")).strip()
    mgr = _get_todo_manager()

    if action == "add":
        title = str(params.get("title", "")).strip()
        if not title:
            return ToolResult(success=False, error="添加 TODO 需要提供 title", duration=time.time() - start)
        description = str(params.get("description", "")).strip()
        priority = str(params.get("priority", "medium")).strip()
        try:
            item = mgr.add_todo(title=title, description=description, priority=priority)
        except ValueError as e:
            return ToolResult(success=False, error=str(e), duration=time.time() - start)
        return ToolResult(
            success=True,
            output=f"已添加 TODO [{item.id}]: {item.title} ({item.priority})",
            duration=time.time() - start,
            metadata={"todo_id": item.id},
        )

    elif action == "update":
        todo_id = str(params.get("todo_id", "")).strip()
        status = str(params.get("status", "")).strip()
        if not todo_id:
            return ToolResult(success=False, error="更新 TODO 需要提供 todo_id", duration=time.time() - start)
        if not status:
            return ToolResult(success=False, error="更新 TODO 需要提供 status", duration=time.time() - start)
        try:
            item = mgr.update_todo(todo_id, status)
        except ValueError as e:
            return ToolResult(success=False, error=str(e), duration=time.time() - start)
        if item is None:
            return ToolResult(success=False, error=f"未找到 TODO: {todo_id}", duration=time.time() - start)
        return ToolResult(
            success=True,
            output=f"已更新 TODO [{item.id}] 状态为: {item.status}",
            duration=time.time() - start,
        )

    elif action == "list":
        status_filter = params.get("status")
        if status_filter:
            status_filter = str(status_filter).strip()
        items = mgr.list_todos(status_filter=status_filter)
        formatted = mgr.format_todos()
        progress = mgr.get_progress()
        return ToolResult(
            success=True,
            output=formatted,
            duration=time.time() - start,
            metadata={"count": len(items), "progress": progress},
        )

    elif action == "next":
        item = mgr.get_next_todo()
        if item is None:
            return ToolResult(
                success=True,
                output="没有可执行的待办事项（全部已完成或存在未满足的依赖）",
                duration=time.time() - start,
            )
        return ToolResult(
            success=True,
            output=f"下一个可执行: [{item.id}] {item.title} ({item.priority})",
            duration=time.time() - start,
            metadata={"todo_id": item.id, "title": item.title},
        )

    elif action == "progress":
        progress = mgr.get_progress()
        lines = [
            f"总计: {progress['total']}",
            f"  ⬜ 待处理: {progress['pending']}",
            f"  🔄 进行中: {progress['in_progress']}",
            f"  ✅ 已完成: {progress['completed']}",
            f"  ❌ 已取消: {progress['cancelled']}",
            f"完成率: {progress['completion_rate']}%",
        ]
        return ToolResult(
            success=True,
            output="\n".join(lines),
            duration=time.time() - start,
            metadata=progress,
        )

    else:
        return ToolResult(
            success=False,
            error=f"未知操作: {action}，有效值: add/update/list/next/progress",
            duration=time.time() - start,
        )


# ==================== 注册函数 ====================


def register_todo_tool(registry: ToolRegistry) -> None:
    """注册 todo 工具到工具注册中心。

    Args:
        registry: 工具注册中心实例。
    """
    registry.register(TODO_DEF, todo_executor)
