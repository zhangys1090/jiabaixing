from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)

log = StructuredLogger("daily_tools")


TASK_MANAGE_DEF = ToolDefinition(
    name="task_manage",
    description="管理任务和待办事项。支持创建、查看、完成、删除和更新任务。适用场景：用户需要记录待办、管理任务列表、追踪任务进度。",
    short_desc="管理待办任务",
    category=ToolCategory.DAILY,
    tags=["task", "todo", "manage", "schedule"],
    scenes=["daily", "work", "coding"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["create", "list", "complete", "delete", "update"]),
        ToolParameterDef(name="task_id", type="string", required=False, description="任务ID"),
        ToolParameterDef(name="title", type="string", required=False, description="任务标题"),
        ToolParameterDef(name="description", type="string", required=False, description="任务描述"),
        ToolParameterDef(name="priority", type="string", required=False, description="优先级", enum=["low", "medium", "high"]),
        ToolParameterDef(name="due_date", type="string", required=False, description="截止日期"),
        ToolParameterDef(name="tags", type="string", required=False, description="标签(逗号分隔)"),
    ],
    risk_level="low",
)

CALENDAR_DEF = ToolDefinition(
    name="calendar",
    description="日历日程管理。支持创建日程、查看日程、设置提醒、查询日程冲突等操作。适用场景：会议安排、日程管理、时间规划。",
    short_desc="管理日历日程",
    category=ToolCategory.DAILY,
    tags=["calendar", "event", "schedule", "meeting"],
    scenes=["daily", "work"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["create_event", "list_events", "get_today", "get_week", "delete_event"]),
        ToolParameterDef(name="event_id", type="string", required=False, description="日程ID"),
        ToolParameterDef(name="title", type="string", required=False, description="日程标题"),
        ToolParameterDef(name="start_time", type="string", required=False, description="开始时间"),
        ToolParameterDef(name="end_time", type="string", required=False, description="结束时间"),
        ToolParameterDef(name="location", type="string", required=False, description="地点"),
        ToolParameterDef(name="description", type="string", required=False, description="日程描述"),
    ],
    risk_level="low",
)

REMINDER_SET_DEF = ToolDefinition(
    name="reminder_set",
    description='设置和管理定时提醒。仅在用户要求"定时提醒"、"到时间提醒我"等需要时间触发的场景使用。不适用：单纯记住信息（用memory_store）。',
    short_desc="设置定时提醒",
    category=ToolCategory.DAILY,
    tags=["reminder", "alarm", "timer", "schedule"],
    scenes=["daily", "work"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["set", "list", "cancel"]),
        ToolParameterDef(name="reminder_id", type="string", required=False, description="提醒ID"),
        ToolParameterDef(name="message", type="string", required=False, description="提醒内容"),
        ToolParameterDef(name="trigger_time", type="string", required=False, description="触发时间"),
        ToolParameterDef(name="repeat", type="string", required=False, description="重复方式", enum=["none", "daily", "weekly", "monthly"]),
    ],
    risk_level="low",
)

NOTE_TAKE_DEF = ToolDefinition(
    name="note_take",
    description="快速记录和管理笔记。支持写入、读取、列表、删除和搜索笔记。适用场景：用户需要快速记录想法、备忘、会议纪要等。",
    short_desc="快速记录笔记",
    category=ToolCategory.DAILY,
    tags=["note", "memo", "write", "record"],
    scenes=["daily", "work", "research", "coding"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["write", "read", "list", "delete", "search"]),
        ToolParameterDef(name="note_id", type="string", required=False, description="笔记ID"),
        ToolParameterDef(name="title", type="string", required=False, description="笔记标题"),
        ToolParameterDef(name="content", type="string", required=False, description="笔记内容"),
        ToolParameterDef(name="tags", type="string", required=False, description="标签(逗号分隔)"),
        ToolParameterDef(name="query", type="string", required=False, description="搜索关键词"),
    ],
    risk_level="low",
)

SYSTEM_STATUS_DEF = ToolDefinition(
    name="system_status",
    description="查询系统各组件的运行状态。支持查看内存、工具、进化引擎等组件状态。适用场景：用户想了解系统运行情况、排查问题。",
    short_desc="查询系统状态",
    category=ToolCategory.DAILY,
    tags=["system", "status", "health", "monitor"],
    scenes=["daily", "coding"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="component", type="string", required=False, description="查询的组件", enum=["all", "memory", "tools", "evolution", "scheduler"]),
        ToolParameterDef(name="detail_level", type="string", required=False, description="详情级别", enum=["summary", "detailed"]),
    ],
    risk_level="low",
)

TASK_PRIORITY_DEF = ToolDefinition(
    name="task_priority",
    description="管理任务优先级。支持提升/降低优先级、按优先级列出任务、设置截止日期等。适用场景：按优先级排序任务、处理紧急任务。",
    short_desc="管理任务优先级",
    category=ToolCategory.DAILY,
    tags=["task", "priority", "urgent", "schedule"],
    scenes=["daily", "work"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["promote", "demote", "set", "list_by_priority", "set_deadline", "urgent"]),
        ToolParameterDef(name="task_id", type="string", required=False, description="任务ID"),
        ToolParameterDef(name="priority", type="string", required=False, description="目标优先级", enum=["low", "medium", "high", "urgent"]),
        ToolParameterDef(name="deadline", type="string", required=False, description="截止日期"),
    ],
    risk_level="low",
)

TASK_DEPENDENCY_DEF = ToolDefinition(
    name="task_dependency",
    description="管理任务之间的依赖关系。支持设置前置任务、查看依赖链、检查阻塞状态等。适用场景：项目管理、任务编排、工作流管理。",
    short_desc="管理任务依赖",
    category=ToolCategory.DAILY,
    tags=["task", "dependency", "workflow", "project"],
    scenes=["work", "coding"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["add_dependency", "remove_dependency", "list_dependencies", "check_blocked", "get_dependency_chain"]),
        ToolParameterDef(name="task_id", type="string", description="任务ID"),
        ToolParameterDef(name="depends_on", type="string", required=False, description="依赖的前置任务ID"),
    ],
    risk_level="low",
)

BATCH_TASK_DEF = ToolDefinition(
    name="batch_task",
    description="批量操作任务。支持批量创建、批量完成、批量删除等。适用场景：一次性处理多个任务。",
    short_desc="批量操作任务",
    category=ToolCategory.DAILY,
    tags=["task", "batch", "bulk"],
    scenes=["work", "daily"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["create_batch", "complete_batch", "delete_batch", "list_by_status"]),
        ToolParameterDef(name="titles", type="string", required=False, description="任务标题列表(逗号分隔,create_batch时使用)"),
        ToolParameterDef(name="task_ids", type="string", required=False, description="任务ID列表(逗号分隔)"),
        ToolParameterDef(name="status", type="string", required=False, description="任务状态过滤", enum=["pending", "completed"]),
    ],
    risk_level="low",
)

TASK_ANALYTICS_DEF = ToolDefinition(
    name="task_analytics",
    description="任务统计分析。支持统计完成情况、生成日报/周报、分析趋势、识别瓶颈。适用场景：项目进度跟踪、效率分析。",
    short_desc="任务统计分析",
    category=ToolCategory.DAILY,
    tags=["task", "analytics", "report", "statistics"],
    scenes=["work", "briefing", "daily"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["summary", "daily_report", "weekly_report", "trend", "bottleneck"]),
        ToolParameterDef(name="days", type="number", required=False, description="统计天数"),
    ],
    risk_level="low",
)


@dataclass
class TaskEntry:
    id: str = ""
    title: str = ""
    description: str = ""
    priority: str = "medium"
    status: str = "pending"
    due_date: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: float = 0.0
    completed_at: float | None = None
    dependencies: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "description": self.description,
            "priority": self.priority, "status": self.status, "due_date": self.due_date,
            "tags": self.tags, "created_at": self.created_at,
            "completed_at": self.completed_at, "dependencies": self.dependencies,
        }


@dataclass
class CalendarEvent:
    id: str = ""
    title: str = ""
    description: str = ""
    start_time: str = ""
    end_time: str = ""
    location: str = ""
    created_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "description": self.description,
            "start_time": self.start_time, "end_time": self.end_time,
            "location": self.location, "created_at": self.created_at,
        }


@dataclass
class ReminderEntry:
    id: str = ""
    message: str = ""
    trigger_time: str = ""
    repeat: str = "none"
    status: str = "pending"
    created_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "message": self.message, "trigger_time": self.trigger_time,
            "repeat": self.repeat, "status": self.status, "created_at": self.created_at,
        }


@dataclass
class NoteEntry:
    id: str = ""
    title: str = ""
    content: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "content": self.content,
            "tags": self.tags, "created_at": self.created_at, "updated_at": self.updated_at,
        }


def _gen_id() -> str:
    import random
    return f"{int(time.time()):x}{random.randint(0, 0xfff):03x}"


class DailyStore:
    _instance: DailyStore | None = None

    def __init__(self, data_dir: str | Path | None = None) -> None:
        if data_dir is None:
            from agent.config import DATA_DIR
            data_dir = DATA_DIR
        self._dir = Path(data_dir) / "daily"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._tasks: dict[str, TaskEntry] = {}
        self._events: dict[str, CalendarEvent] = {}
        self._reminders: dict[str, ReminderEntry] = {}
        self._notes: dict[str, NoteEntry] = {}
        self._load()

    @classmethod
    def get_instance(cls) -> DailyStore:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _load(self) -> None:
        for name, store, cls_type in [
            ("tasks", self._tasks, TaskEntry),
            ("events", self._events, CalendarEvent),
            ("reminders", self._reminders, ReminderEntry),
            ("notes", self._notes, NoteEntry),
        ]:
            fp = self._dir / f"{name}.json"
            if fp.exists():
                try:
                    data = json.loads(fp.read_text(encoding="utf-8"))
                    for item in data:
                        entry = cls_type(**{k: v for k, v in item.items() if k in cls_type.__dataclass_fields__})
                        store[entry.id] = entry
                except Exception as _exc:
                    log_ignored(log, "daily_tools.DailyStore._load", _exc)

    def _save(self, name: str, store: dict) -> None:
        fp = self._dir / f"{name}.json"
        data = [v.to_dict() for v in store.values()]
        fp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # Task operations
    def get_tasks(self) -> list[TaskEntry]:
        return list(self._tasks.values())

    def save_task(self, task: TaskEntry) -> None:
        self._tasks[task.id] = task
        self._save("tasks", self._tasks)

    def delete_task(self, task_id: str) -> bool:
        if task_id in self._tasks:
            del self._tasks[task_id]
            self._save("tasks", self._tasks)
            return True
        return False

    def get_task(self, task_id: str) -> TaskEntry | None:
        return self._tasks.get(task_id)

    # Event operations
    def get_events(self) -> list[CalendarEvent]:
        return list(self._events.values())

    def save_event(self, event: CalendarEvent) -> None:
        self._events[event.id] = event
        self._save("events", self._events)

    def delete_event(self, event_id: str) -> bool:
        if event_id in self._events:
            del self._events[event_id]
            self._save("events", self._events)
            return True
        return False

    # Reminder operations
    def get_reminders(self) -> list[ReminderEntry]:
        return list(self._reminders.values())

    def save_reminder(self, reminder: ReminderEntry) -> None:
        self._reminders[reminder.id] = reminder
        self._save("reminders", self._reminders)

    def delete_reminder(self, reminder_id: str) -> bool:
        if reminder_id in self._reminders:
            del self._reminders[reminder_id]
            self._save("reminders", self._reminders)
            return True
        return False

    # Note operations
    def get_notes(self) -> list[NoteEntry]:
        return list(self._notes.values())

    def save_note(self, note: NoteEntry) -> None:
        self._notes[note.id] = note
        self._save("notes", self._notes)

    def delete_note(self, note_id: str) -> bool:
        if note_id in self._notes:
            del self._notes[note_id]
            self._save("notes", self._notes)
            return True
        return False


def _get_store() -> DailyStore:
    return DailyStore.get_instance()


_PRIORITY_ORDER = ["low", "medium", "high", "urgent"]


async def task_manage_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    log.info("task_manage", action=action)
    store = _get_store()

    if action == "create":
        title = str(params.get("title", ""))
        if not title:
            return ToolResult(success=False, error="任务标题不能为空")
        task = TaskEntry(
            id=_gen_id(), title=title,
            description=str(params.get("description", "")),
            priority=str(params.get("priority", "medium")),
            due_date=str(params.get("due_date", "")),
            tags=[t.strip() for t in str(params.get("tags", "")).split(",") if t.strip()],
            created_at=time.time(),
        )
        store.save_task(task)
        return ToolResult(success=True, output=f"✅ 任务已创建: [{task.id}] {task.title} (优先级: {task.priority})", duration=time.time() - start)

    elif action == "list":
        tasks = store.get_tasks()
        if not tasks:
            return ToolResult(success=True, output="暂无任务", duration=time.time() - start)
        lines = []
        for t in tasks:
            icon = "✅" if t.status == "completed" else "⏳"
            lines.append(f"{icon} [{t.id}] {t.title} — 优先级: {t.priority}" + (f" (截止: {t.due_date})" if t.due_date else ""))
        return ToolResult(success=True, output=f"共 {len(tasks)} 个任务:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "complete":
        task_id = str(params.get("task_id", ""))
        task = store.get_task(task_id)
        if not task:
            return ToolResult(success=False, error=f"任务不存在: {task_id}")
        task.status = "completed"
        task.completed_at = time.time()
        store.save_task(task)
        return ToolResult(success=True, output=f"✅ 任务已完成: [{task.id}] {task.title}", duration=time.time() - start)

    elif action == "delete":
        task_id = str(params.get("task_id", ""))
        if store.delete_task(task_id):
            return ToolResult(success=True, output=f"🗑️ 任务已删除: {task_id}", duration=time.time() - start)
        return ToolResult(success=False, error=f"任务不存在: {task_id}")

    elif action == "update":
        task_id = str(params.get("task_id", ""))
        task = store.get_task(task_id)
        if not task:
            return ToolResult(success=False, error=f"任务不存在: {task_id}")
        if params.get("title"):
            task.title = str(params["title"])
        if params.get("description"):
            task.description = str(params["description"])
        if params.get("priority"):
            task.priority = str(params["priority"])
        if params.get("due_date"):
            task.due_date = str(params["due_date"])
        if params.get("tags"):
            task.tags = [t.strip() for t in str(params["tags"]).split(",") if t.strip()]
        store.save_task(task)
        return ToolResult(success=True, output=f"✏️ 任务已更新: [{task.id}] {task.title}", duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}")


async def calendar_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    store = _get_store()

    if action == "create_event":
        title = str(params.get("title", ""))
        if not title:
            return ToolResult(success=False, error="日程标题不能为空")
        event = CalendarEvent(
            id=_gen_id(), title=title,
            description=str(params.get("description", "")),
            start_time=str(params.get("start_time", "")),
            end_time=str(params.get("end_time", "")),
            location=str(params.get("location", "")),
            created_at=time.time(),
        )
        store.save_event(event)
        return ToolResult(success=True, output=f"📅 日程已创建: [{event.id}] {event.title}" + (f" @ {event.start_time}" if event.start_time else ""), duration=time.time() - start)

    elif action in ("list_events", "get_today", "get_week"):
        events = store.get_events()
        if action == "get_today":
            import datetime
            today = datetime.date.today().isoformat()
            events = [e for e in events if today in e.start_time]
        if not events:
            return ToolResult(success=True, output="暂无日程", duration=time.time() - start)
        lines = [f"📅 [{e.id}] {e.title} — {e.start_time}" + (f" → {e.end_time}" if e.end_time else "") + (f" @ {e.location}" if e.location else "") for e in events]
        return ToolResult(success=True, output=f"共 {len(events)} 个日程:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "delete_event":
        event_id = str(params.get("event_id", ""))
        if store.delete_event(event_id):
            return ToolResult(success=True, output=f"🗑️ 日程已删除: {event_id}", duration=time.time() - start)
        return ToolResult(success=False, error=f"日程不存在: {event_id}")

    return ToolResult(success=False, error=f"未知操作: {action}")


def _parse_trigger_time(expr: str) -> str:
    import re
    m = re.search(r"(\d+)\s*分钟后", expr)
    if m:
        from datetime import datetime, timedelta
        return (datetime.now() + timedelta(minutes=int(m.group(1)))).isoformat()
    m = re.search(r"(\d+)\s*点", expr)
    if m:
        from datetime import datetime
        h = int(m.group(1))
        d = datetime.now().replace(hour=h, minute=0, second=0, microsecond=0)
        if d < datetime.now():
            from datetime import timedelta
            d += timedelta(days=1)
        return d.isoformat()
    return expr


async def reminder_set_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    store = _get_store()

    if action == "set":
        message = str(params.get("message", ""))
        trigger_time = str(params.get("trigger_time", ""))
        if not message:
            return ToolResult(success=False, error="提醒内容不能为空")
        parsed_time = _parse_trigger_time(trigger_time) if trigger_time else ""
        reminder = ReminderEntry(
            id=_gen_id(), message=message,
            trigger_time=parsed_time,
            repeat=str(params.get("repeat", "none")),
            created_at=time.time(),
        )
        store.save_reminder(reminder)
        return ToolResult(success=True, output=f"⏰ 提醒已设置: [{reminder.id}] {message}" + (f" — {parsed_time}" if parsed_time else ""), duration=time.time() - start)

    elif action == "list":
        reminders = store.get_reminders()
        pending = [r for r in reminders if r.status == "pending"]
        if not pending:
            return ToolResult(success=True, output="暂无待触发提醒", duration=time.time() - start)
        lines = [f"⏰ [{r.id}] {r.message} — {r.trigger_time} ({r.repeat})" for r in pending]
        return ToolResult(success=True, output=f"共 {len(pending)} 个提醒:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "cancel":
        reminder_id = str(params.get("reminder_id", ""))
        if store.delete_reminder(reminder_id):
            return ToolResult(success=True, output=f"🗑️ 提醒已取消: {reminder_id}", duration=time.time() - start)
        return ToolResult(success=False, error=f"提醒不存在: {reminder_id}")

    return ToolResult(success=False, error=f"未知操作: {action}")


async def note_take_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    store = _get_store()

    if action == "write":
        title = str(params.get("title", ""))
        content = str(params.get("content", ""))
        if not title and not content:
            return ToolResult(success=False, error="标题或内容不能都为空")
        note = NoteEntry(
            id=_gen_id(), title=title or "无标题",
            content=content,
            tags=[t.strip() for t in str(params.get("tags", "")).split(",") if t.strip()],
            created_at=time.time(), updated_at=time.time(),
        )
        store.save_note(note)
        return ToolResult(success=True, output=f"📝 笔记已保存: [{note.id}] {note.title}", duration=time.time() - start)

    elif action == "read":
        note_id = str(params.get("note_id", ""))
        notes = store.get_notes()
        note = next((n for n in notes if n.id == note_id), None)
        if not note:
            return ToolResult(success=False, error=f"笔记不存在: {note_id}")
        output = f"📝 {note.title}\n{'─' * 30}\n{note.content}"
        if note.tags:
            output += f"\n标签: {', '.join(note.tags)}"
        return ToolResult(success=True, output=output, duration=time.time() - start)

    elif action == "list":
        notes = store.get_notes()
        if not notes:
            return ToolResult(success=True, output="暂无笔记", duration=time.time() - start)
        lines = [f"📝 [{n.id}] {n.title}" + (f" — {', '.join(n.tags)}" if n.tags else "") for n in notes]
        return ToolResult(success=True, output=f"共 {len(notes)} 条笔记:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "delete":
        note_id = str(params.get("note_id", ""))
        if store.delete_note(note_id):
            return ToolResult(success=True, output=f"🗑️ 笔记已删除: {note_id}", duration=time.time() - start)
        return ToolResult(success=False, error=f"笔记不存在: {note_id}")

    elif action == "search":
        query = str(params.get("query", "")).lower()
        notes = store.get_notes()
        matched = [n for n in notes if query in n.title.lower() or query in n.content.lower()]
        if not matched:
            return ToolResult(success=True, output="未找到匹配笔记", duration=time.time() - start)
        lines = [f"📝 [{n.id}] {n.title}" for n in matched]
        return ToolResult(success=True, output=f"找到 {len(matched)} 条笔记:\n" + "\n".join(lines), duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}")


async def system_status_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    component = str(params.get("component", "all"))
    detail_level = str(params.get("detail_level", "summary"))
    lines: list[str] = []

    try:
        from agent.main import engine
        if not engine:
            return ToolResult(success=True, output="⚠️ 引擎未初始化", duration=time.time() - start)

        if component in ("all", "memory"):
            if engine.memory:
                stats = await engine.memory.get_stats()
                lines.append(f"✅ 记忆: {stats.get('total_entries', 0)} 条")
                if detail_level == "detailed":
                    by_type = stats.get("by_type", {})
                    for t, c in by_type.items():
                        lines.append(f"   {t}: {c} 条")
            else:
                lines.append("⚠️ 记忆: 未初始化")

        if component in ("all", "tools"):
            if engine.tool_registry:
                defs = engine.tool_registry.get_all_definitions()
                by_cat: dict[str, int] = {}
                for d in defs:
                    by_cat[d.category.value] = by_cat.get(d.category.value, 0) + 1
                lines.append(f"✅ 工具: {len(defs)} 个")
                if detail_level == "detailed":
                    for cat, cnt in sorted(by_cat.items()):
                        lines.append(f"   {cat}: {cnt} 个")
            else:
                lines.append("⚠️ 工具: 未初始化")

        if component in ("all", "evolution"):
            if engine.evolution:
                metrics = engine.evolution.get_metrics()
                lines.append(f"✅ 进化: {metrics.total_interactions} 次交互, 质量={metrics.average_quality:.2f}")
            else:
                lines.append("⚠️ 进化: 未初始化")

        if component in ("all", "scheduler"):
            lines.append("✅ 调度器: 运行中")
    except Exception as e:
        lines.append(f"⚠️ 查询异常: {e}")

    return ToolResult(success=True, output="\n".join(lines), duration=time.time() - start)


async def task_priority_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    store = _get_store()

    if action == "list_by_priority":
        tasks = store.get_tasks()
        tasks.sort(key=lambda t: _PRIORITY_ORDER.index(t.priority) if t.priority in _PRIORITY_ORDER else 1, reverse=True)
        if not tasks:
            return ToolResult(success=True, output="暂无任务", duration=time.time() - start)
        lines = [f"{'🔴' if t.priority == 'urgent' else '🟡' if t.priority == 'high' else '🔵' if t.priority == 'medium' else '⚪'} [{t.priority}] [{t.id}] {t.title}" for t in tasks]
        return ToolResult(success=True, output="\n".join(lines), duration=time.time() - start)

    task_id = str(params.get("task_id", ""))
    task = store.get_task(task_id)
    if not task:
        return ToolResult(success=False, error=f"任务不存在: {task_id}")

    if action == "promote":
        idx = _PRIORITY_ORDER.index(task.priority) if task.priority in _PRIORITY_ORDER else 1
        if idx < len(_PRIORITY_ORDER) - 1:
            task.priority = _PRIORITY_ORDER[idx + 1]
        store.save_task(task)
        return ToolResult(success=True, output=f"⬆️ 优先级提升: [{task.id}] → {task.priority}", duration=time.time() - start)

    elif action == "demote":
        idx = _PRIORITY_ORDER.index(task.priority) if task.priority in _PRIORITY_ORDER else 1
        if idx > 0:
            task.priority = _PRIORITY_ORDER[idx - 1]
        store.save_task(task)
        return ToolResult(success=True, output=f"⬇️ 优先级降低: [{task.id}] → {task.priority}", duration=time.time() - start)

    elif action == "set":
        priority = str(params.get("priority", "medium"))
        if priority not in _PRIORITY_ORDER:
            return ToolResult(success=False, error=f"无效优先级: {priority}")
        task.priority = priority
        store.save_task(task)
        return ToolResult(success=True, output=f"🎯 优先级设置: [{task.id}] → {task.priority}", duration=time.time() - start)

    elif action == "set_deadline":
        deadline = str(params.get("deadline", ""))
        task.due_date = deadline
        store.save_task(task)
        return ToolResult(success=True, output=f"📅 截止日期设置: [{task.id}] → {deadline}", duration=time.time() - start)

    elif action == "urgent":
        task.priority = "urgent"
        store.save_task(task)
        return ToolResult(success=True, output=f"🔴 标记紧急: [{task.id}] {task.title}", duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}")


async def task_dependency_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    task_id = str(params.get("task_id", ""))
    store = _get_store()

    task = store.get_task(task_id)
    if not task:
        return ToolResult(success=False, error=f"任务不存在: {task_id}")

    if action == "add_dependency":
        depends_on = str(params.get("depends_on", ""))
        if not depends_on:
            return ToolResult(success=False, error="依赖任务ID不能为空")
        dep_task = store.get_task(depends_on)
        if not dep_task:
            return ToolResult(success=False, error=f"依赖任务不存在: {depends_on}")
        if depends_on not in task.dependencies:
            task.dependencies.append(depends_on)
            store.save_task(task)
        return ToolResult(success=True, output=f"🔗 依赖已添加: [{task_id}] → [{depends_on}]", duration=time.time() - start)

    elif action == "remove_dependency":
        depends_on = str(params.get("depends_on", ""))
        if depends_on in task.dependencies:
            task.dependencies.remove(depends_on)
            store.save_task(task)
        return ToolResult(success=True, output=f"🔓 依赖已移除: [{task_id}] ✕ [{depends_on}]", duration=time.time() - start)

    elif action == "list_dependencies":
        if not task.dependencies:
            return ToolResult(success=True, output=f"任务 [{task_id}] 无依赖", duration=time.time() - start)
        lines = []
        for dep_id in task.dependencies:
            dep = store.get_task(dep_id)
            icon = "✅" if dep and dep.status == "completed" else "⏳"
            title = dep.title if dep else "未知"
            lines.append(f"  {icon} [{dep_id}] {title}")
        return ToolResult(success=True, output=f"任务 [{task_id}] 的依赖:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "check_blocked":
        blocked = []
        for dep_id in task.dependencies:
            dep = store.get_task(dep_id)
            if not dep or dep.status != "completed":
                blocked.append(dep_id)
        if blocked:
            return ToolResult(success=True, output=f"🚫 任务 [{task_id}] 被阻塞，未完成依赖: {', '.join(blocked)}", duration=time.time() - start)
        return ToolResult(success=True, output=f"✅ 任务 [{task_id}] 无阻塞，所有依赖已完成", duration=time.time() - start)

    elif action == "get_dependency_chain":
        chain: list[str] = []
        visited: set[str] = set()

        def _walk(tid: str, depth: int) -> None:
            if tid in visited:
                return
            visited.add(tid)
            t = store.get_task(tid)
            if not t:
                return
            icon = "✅" if t.status == "completed" else "⏳"
            indent = "  " * depth
            chain.append(f"{indent}{icon} [{tid}] {t.title}")
            for dep_id in t.dependencies:
                _walk(dep_id, depth + 1)

        _walk(task_id, 0)
        return ToolResult(success=True, output="依赖链:\n" + "\n".join(chain), duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}")


async def batch_task_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    store = _get_store()

    if action == "create_batch":
        titles_str = str(params.get("titles", ""))
        if not titles_str:
            return ToolResult(success=False, error="任务标题列表不能为空")
        titles = [t.strip() for t in titles_str.split(",") if t.strip()]
        created: list[str] = []
        for title in titles:
            task = TaskEntry(id=_gen_id(), title=title, priority="medium", created_at=time.time())
            store.save_task(task)
            created.append(f"[{task.id}] {task.title}")
        return ToolResult(success=True, output=f"✅ 批量创建 {len(created)} 个任务:\n" + "\n".join(created), duration=time.time() - start)

    elif action == "complete_batch":
        ids_str = str(params.get("task_ids", ""))
        ids = [i.strip() for i in ids_str.split(",") if i.strip()]
        completed = 0
        for tid in ids:
            task = store.get_task(tid)
            if task:
                task.status = "completed"
                task.completed_at = time.time()
                store.save_task(task)
                completed += 1
        return ToolResult(success=True, output=f"✅ 批量完成 {completed}/{len(ids)} 个任务", duration=time.time() - start)

    elif action == "delete_batch":
        ids_str = str(params.get("task_ids", ""))
        ids = [i.strip() for i in ids_str.split(",") if i.strip()]
        deleted = sum(1 for tid in ids if store.delete_task(tid))
        return ToolResult(success=True, output=f"🗑️ 批量删除 {deleted}/{len(ids)} 个任务", duration=time.time() - start)

    elif action == "list_by_status":
        status = str(params.get("status", "pending"))
        tasks = [t for t in store.get_tasks() if t.status == status]
        if not tasks:
            return ToolResult(success=True, output=f"暂无{status}状态的任务", duration=time.time() - start)
        lines = [f"{'✅' if t.status == 'completed' else '⏳'} [{t.id}] {t.title}" for t in tasks]
        return ToolResult(success=True, output=f"共 {len(tasks)} 个{status}任务:\n" + "\n".join(lines), duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}")


async def task_analytics_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", "summary"))
    days = int(params.get("days", 7))
    store = _get_store()
    tasks = store.get_tasks()

    if action == "summary":
        total = len(tasks)
        completed = sum(1 for t in tasks if t.status == "completed")
        pending = total - completed
        by_priority: dict[str, int] = {}
        for t in tasks:
            by_priority[t.priority] = by_priority.get(t.priority, 0) + 1
        lines = [
            f"📊 任务统计 (共 {total} 个)",
            f"  ✅ 已完成: {completed}",
            f"  ⏳ 待处理: {pending}",
            f"  完成率: {completed / total * 100:.0f}%" if total else "  完成率: N/A",
        ]
        for p in _PRIORITY_ORDER:
            if p in by_priority:
                lines.append(f"  {p}: {by_priority[p]} 个")
        return ToolResult(success=True, output="\n".join(lines), duration=time.time() - start)

    elif action in ("daily_report", "weekly_report"):
        period = "今日" if action == "daily_report" else f"近 {days} 天"
        cutoff = time.time() - days * 86400
        recent = [t for t in tasks if t.created_at >= cutoff]
        completed = sum(1 for t in recent if t.status == "completed")
        lines = [
            f"📋 {period}报告",
            f"  新增任务: {len(recent)}",
            f"  已完成: {completed}",
            f"  待处理: {len(recent) - completed}",
        ]
        return ToolResult(success=True, output="\n".join(lines), duration=time.time() - start)

    elif action == "trend":
        lines = [f"📈 任务趋势 (近 {days} 天)"]
        for i in range(min(days, 7)):
            day_start = time.time() - (days - i) * 86400
            day_end = day_start + 86400
            day_tasks = [t for t in tasks if day_start <= t.created_at < day_end]
            day_completed = sum(1 for t in day_tasks if t.status == "completed")
            import datetime
            date_str = datetime.date.fromtimestamp(day_start).isoformat()
            bar = "█" * len(day_tasks)
            lines.append(f"  {date_str}: {bar} ({len(day_tasks)} 新增, {day_completed} 完成)")
        return ToolResult(success=True, output="\n".join(lines), duration=time.time() - start)

    elif action == "bottleneck":
        blocked = []
        for t in tasks:
            if t.status == "pending" and t.dependencies:
                for dep_id in t.dependencies:
                    dep = store.get_task(dep_id)
                    if not dep or dep.status != "completed":
                        blocked.append(f"🚫 [{t.id}] {t.title} — 等待 [{dep_id}]")
        if not blocked:
            return ToolResult(success=True, output="✅ 无瓶颈任务", duration=time.time() - start)
        return ToolResult(success=True, output=f"瓶颈任务 ({len(blocked)} 个):\n" + "\n".join(blocked), duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}")
