"""长任务编排器 — Codex Harness 风格的长任务生命周期管理。

参考 Codex Harness 的 Agent Loop 设计：
1. TaskLifecycle: 任务状态机 (pending→running→completed/failed/cancelled)
2. SubAgent spawn: 长任务拆分为子Agent并行执行
3. Progressive checkpoint: 每步自动checkpoint，失败可从任意步恢复
4. Budget enforcement: token/time/iteration 三维预算硬限制
5. Sandbox isolation: 每个子任务在独立沙箱中执行

与 ConversationLoop 的关系：
- ConversationLoop 管理单轮对话的 ReAct 循环
- LongTaskOrchestrator 管理跨多轮对话的长任务生命周期
- LongTaskOrchestrator 内部创建 ConversationLoop 实例执行子任务

Usage:
    orchestrator = LongTaskOrchestrator(engine)
    task_id = await orchestrator.submit(
        "重构整个认证模块，添加OAuth2支持",
        mode="decompose",
        budget=TaskBudget(max_tokens=200000, max_time=600, max_iterations=50),
    )
    # 后续可查询进度、取消、从checkpoint恢复
    status = orchestrator.get_status(task_id)
    await orchestrator.cancel(task_id)
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.turn_types import CancellationToken, LoopCheckpoint
from agent.core.dynamic_priority import DynamicPriorityScorer, TaskInfo, PriorityScore

log = StructuredLogger("long_task")


class TaskPhase(str, Enum):
    PENDING = "pending"
    DECOMPOSING = "decomposing"
    RUNNING = "running"
    CHECKPOINTING = "checkpointing"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused"


class SubTaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class ExecutionMode(str, Enum):
    SEQUENTIAL = "sequential"
    DECOMPOSE = "decompose"
    PARALLEL = "parallel"
    ADAPTIVE = "adaptive"


TASK_TEMPLATES: dict[str, list[dict[str, Any]]] = {
    "refactor": [
        {"name": "analyze", "description": "分析现有代码结构和依赖关系", "dependencies": []},
        {"name": "plan", "description": "制定重构计划，确定修改范围和顺序", "dependencies": ["analyze"]},
        {"name": "implement", "description": "按计划执行代码修改", "dependencies": ["plan"]},
        {"name": "test", "description": "运行测试验证重构正确性", "dependencies": ["implement"]},
        {"name": "review", "description": "代码审查，检查遗漏和风格问题", "dependencies": ["test"]},
    ],
    "feature": [
        {"name": "design", "description": "功能设计：接口定义、数据模型、交互流程", "dependencies": []},
        {"name": "implement_core", "description": "实现核心逻辑", "dependencies": ["design"]},
        {"name": "implement_ui", "description": "实现UI/接口层", "dependencies": ["design"]},
        {"name": "integrate", "description": "集成核心逻辑与UI层", "dependencies": ["implement_core", "implement_ui"]},
        {"name": "test", "description": "编写和运行测试", "dependencies": ["integrate"]},
    ],
    "debug": [
        {"name": "reproduce", "description": "复现问题，收集错误信息和日志", "dependencies": []},
        {"name": "locate", "description": "定位根因，分析调用链和状态", "dependencies": ["reproduce"]},
        {"name": "fix", "description": "实施修复", "dependencies": ["locate"]},
        {"name": "verify", "description": "验证修复，确认问题不再复现", "dependencies": ["fix"]},
    ],
    "migration": [
        {"name": "audit", "description": "审计现有系统，梳理迁移范围", "dependencies": []},
        {"name": "prepare", "description": "准备目标环境，配置依赖", "dependencies": ["audit"]},
        {"name": "migrate_data", "description": "迁移数据和配置", "dependencies": ["prepare"]},
        {"name": "migrate_code", "description": "迁移代码和适配接口", "dependencies": ["prepare"]},
        {"name": "validate", "description": "验证迁移结果，运行测试", "dependencies": ["migrate_data", "migrate_code"]},
    ],
    "document": [
        {"name": "collect", "description": "收集文档素材（代码、接口、流程）", "dependencies": []},
        {"name": "draft", "description": "撰写文档初稿", "dependencies": ["collect"]},
        {"name": "review", "description": "审阅文档，补充遗漏", "dependencies": ["draft"]},
    ],
}

_TEMPLATE_KEYWORDS: dict[str, list[str]] = {
    "refactor": ["重构", "refactor", "重写", "rewrite", "优化结构", "restructure"],
    "feature": ["添加", "新增", "实现", "add", "feature", "implement", "开发"],
    "debug": ["修复", "调试", "解决", "fix", "debug", "bug", "排错", "troubleshoot"],
    "migration": ["迁移", "升级", "migration", "migrate", "upgrade", "移植", "port"],
    "document": ["文档", "说明", "document", "docs", "readme", "写文档"],
}


def match_template(task_description: str) -> list[dict[str, Any]] | None:
    """根据任务描述匹配预定义模板。

    Returns:
        匹配的模板步骤列表，无匹配返回 None。
    """
    desc_lower = task_description.lower()
    for template_name, keywords in _TEMPLATE_KEYWORDS.items():
        if any(kw in desc_lower for kw in keywords):
            return TASK_TEMPLATES.get(template_name)
    return None


@dataclass
class SubTaskRetryPolicy:
    """子任务重试策略。

    控制子任务失败后的重试行为：
    - max_retries: 最大重试次数（0=不重试）
    - backoff_base: 指数退避基础秒数
    - retryable_errors: 可重试的错误关键字（子串匹配）
    - non_retryable_errors: 不可重试的错误关键字（优先级高于 retryable）
    """

    max_retries: int = 2
    backoff_base: float = 2.0
    retryable_errors: list[str] = field(default_factory=lambda: [
        "timeout", "timed out", "connection", "network", "临时", "rate_limit",
        "429", "503", "502", "internal_error",
    ])
    non_retryable_errors: list[str] = field(default_factory=lambda: [
        "permission", "权限", "auth", "unauthorized", "forbidden",
        "not_found", "不存在", "invalid", "无效", "syntax_error",
    ])

    def should_retry(self, error: str, attempt: int) -> bool:
        if attempt >= self.max_retries:
            return False
        err_lower = error.lower()
        for nr in self.non_retryable_errors:
            if nr in err_lower:
                return False
        for r in self.retryable_errors:
            if r in err_lower:
                return True
        return attempt < self.max_retries

    def get_delay(self, attempt: int) -> float:
        return self.backoff_base * (2 ** attempt)


@dataclass
class TaskBudget:
    max_tokens: int = 100000
    max_time: float = 300.0
    max_iterations: int = 30
    tokens_used: int = 0
    time_used: float = 0.0
    iterations_used: int = 0

    @property
    def is_exhausted(self) -> bool:
        return (
            self.tokens_used >= self.max_tokens
            or self.time_used >= self.max_time
            or self.iterations_used >= self.max_iterations
        )

    @property
    def token_ratio(self) -> float:
        return self.tokens_used / self.max_tokens if self.max_tokens > 0 else 0.0

    @property
    def time_ratio(self) -> float:
        return self.time_used / self.max_time if self.max_time > 0 else 0.0

    @property
    def iteration_ratio(self) -> float:
        return self.iterations_used / self.max_iterations if self.max_iterations > 0 else 0.0

    @property
    def overall_ratio(self) -> float:
        return max(self.token_ratio, self.time_ratio, self.iteration_ratio)


@dataclass
class SubTask:
    subtask_id: str
    name: str
    description: str
    status: SubTaskStatus = SubTaskStatus.PENDING
    dependencies: list[str] = field(default_factory=list)
    checkpoint: LoopCheckpoint | None = None
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    duration: float = 0.0
    tokens_used: int = 0
    metadata: dict[str, Any] | None = None


@dataclass
class TaskProgress:
    task_id: str
    phase: TaskPhase
    total_subtasks: int = 0
    completed_subtasks: int = 0
    failed_subtasks: int = 0
    running_subtasks: int = 0
    budget: TaskBudget = field(default_factory=TaskBudget)
    started_at: float = 0.0
    updated_at: float = 0.0
    error: str | None = None

    @property
    def progress_ratio(self) -> float:
        if self.total_subtasks == 0:
            return 0.0
        return self.completed_subtasks / self.total_subtasks

    @property
    def elapsed(self) -> float:
        return time.time() - self.started_at if self.started_at > 0 else 0.0


class CheckpointBackend(str, Enum):
    JSON = "json"
    SQLITE = "sqlite"


@dataclass
class TaskCheckpointStore:
    """检查点持久化存储 — 双后端（JSON文件 + SQLite）。

    默认使用 SQLite 后端（高性能、单文件、支持并发读写），
    JSON 文件后端作为降级备选（无 sqlite3 标准库时）。

    SQLite schema:
        CREATE TABLE IF NOT EXISTS checkpoints (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id   TEXT NOT NULL,
            saved_at  INTEGER NOT NULL,
            round_num INTEGER DEFAULT 0,
            turn_id   TEXT DEFAULT '',
            data      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cp_task ON checkpoints(task_id, saved_at);
    """

    base_dir: str = ""
    backend: CheckpointBackend = CheckpointBackend.SQLITE

    def __post_init__(self) -> None:
        if not self.base_dir:
            try:
                from agent.config import DATA_ROOT
                self.base_dir = str(Path(str(DATA_ROOT)) / "checkpoints")
            except Exception:
                self.base_dir = str(Path.home() / ".jiabaixing" / "checkpoints")
        os.makedirs(self.base_dir, exist_ok=True)

        if self.backend == CheckpointBackend.SQLITE:
            try:
                import sqlite3
                self._db_path = os.path.join(self.base_dir, "checkpoints.db")
                self._init_sqlite()
            except Exception as exc:
                log.warning("SQLite backend init failed, falling back to JSON", error=str(exc))
                self.backend = CheckpointBackend.JSON

    def _init_sqlite(self) -> None:
        import sqlite3
        conn = sqlite3.connect(self._db_path)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS checkpoints ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "task_id TEXT NOT NULL, "
                "saved_at INTEGER NOT NULL, "
                "round_num INTEGER DEFAULT 0, "
                "turn_id TEXT DEFAULT '', "
                "data TEXT NOT NULL)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_cp_task ON checkpoints(task_id, saved_at)"
            )
            conn.commit()
        finally:
            conn.close()

    def save(self, task_id: str, checkpoint: LoopCheckpoint) -> str:
        ts = int(time.time() * 1000)
        data = checkpoint.serialize()
        data["_task_id"] = task_id
        data["_saved_at"] = ts

        if self.backend == CheckpointBackend.SQLITE:
            return self._save_sqlite(task_id, ts, data)
        return self._save_json(task_id, ts, data)

    def _save_sqlite(self, task_id: str, ts: int, data: dict[str, Any]) -> str:
        import sqlite3
        conn = None
        try:
            conn = sqlite3.connect(self._db_path)
            conn.execute(
                "INSERT INTO checkpoints (task_id, saved_at, round_num, turn_id, data) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    task_id,
                    ts,
                    data.get("current_round", 0),
                    data.get("turn_id", ""),
                    json.dumps(data, ensure_ascii=False),
                ),
            )
            conn.commit()
            row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            log.info("Checkpoint saved (sqlite)", task_id=task_id, row_id=row_id)
            return f"sqlite://{self._db_path}#{row_id}"
        except Exception as exc:
            log.warning("SQLite save failed, falling back to JSON", error=str(exc))
            return self._save_json(task_id, ts, data)
        finally:
            if conn:
                conn.close()

    def _save_json(self, task_id: str, ts: int, data: dict[str, Any]) -> str:
        filename = f"{task_id}_{ts}.json"
        filepath = os.path.join(self.base_dir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        log.info("Checkpoint saved (json)", task_id=task_id, filepath=filepath)
        return filepath

    def load_latest(self, task_id: str) -> LoopCheckpoint | None:
        if self.backend == CheckpointBackend.SQLITE:
            result = self._load_latest_sqlite(task_id)
            if result is not None:
                return result
            return self._load_latest_json(task_id)
        return self._load_latest_json(task_id)

    def _load_latest_sqlite(self, task_id: str) -> LoopCheckpoint | None:
        import sqlite3
        conn = None
        try:
            conn = sqlite3.connect(self._db_path)
            row = conn.execute(
                "SELECT data FROM checkpoints WHERE task_id = ? ORDER BY saved_at DESC LIMIT 1",
                (task_id,),
            ).fetchone()
            if row is None:
                return None
            data = json.loads(row[0])
            data.pop("_task_id", None)
            data.pop("_saved_at", None)
            return LoopCheckpoint.deserialize(data)
        except Exception as exc:
            log.warning("SQLite load failed", error=str(exc))
            return None
        finally:
            if conn:
                conn.close()

    def _load_latest_json(self, task_id: str) -> LoopCheckpoint | None:
        files = sorted(
            [f for f in os.listdir(self.base_dir) if f.startswith(f"{task_id}_") and f.endswith(".json")],
            reverse=True,
        )
        if not files:
            return None
        filepath = os.path.join(self.base_dir, files[0])
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            data.pop("_task_id", None)
            data.pop("_saved_at", None)
            return LoopCheckpoint.deserialize(data)
        except Exception as exc:
            log.warning("Failed to load checkpoint", filepath=filepath, error=str(exc))
            return None

    def list_checkpoints(self, task_id: str) -> list[dict[str, Any]]:
        if self.backend == CheckpointBackend.SQLITE:
            sqlite_results = self._list_checkpoints_sqlite(task_id)
            if sqlite_results:
                return sqlite_results
            return self._list_checkpoints_json(task_id)
        return self._list_checkpoints_json(task_id)

    def _list_checkpoints_sqlite(self, task_id: str) -> list[dict[str, Any]]:
        import sqlite3
        conn = None
        try:
            conn = sqlite3.connect(self._db_path)
            rows = conn.execute(
                "SELECT id, saved_at, round_num, turn_id FROM checkpoints "
                "WHERE task_id = ? ORDER BY saved_at DESC LIMIT 10",
                (task_id,),
            ).fetchall()
            return [
                {
                    "id": row[0],
                    "saved_at": row[1],
                    "round": row[2],
                    "turn_id": row[3],
                    "backend": "sqlite",
                }
                for row in rows
            ]
        except Exception as exc:
            log.warning("SQLite list failed", error=str(exc))
            return []
        finally:
            if conn:
                conn.close()

    def _list_checkpoints_json(self, task_id: str) -> list[dict[str, Any]]:
        files = sorted(
            [f for f in os.listdir(self.base_dir) if f.startswith(f"{task_id}_") and f.endswith(".json")],
            reverse=True,
        )
        results = []
        for fname in files[:10]:
            filepath = os.path.join(self.base_dir, fname)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                results.append({
                    "filename": fname,
                    "saved_at": data.get("_saved_at", 0),
                    "round": data.get("current_round", 0),
                    "turn_id": data.get("turn_id", ""),
                    "backend": "json",
                })
            except Exception as exc:
                log.debug("Checkpoint JSON parse skipped", filepath=filepath, error=str(exc))
        return results


@dataclass
class TaskPersistenceStore:
    """跨会话任务持久化 — SQLite后端.

    将 TaskProgress 和 SubTask 元数据持久化到 SQLite，
    使长任务在进程重启后可恢复。

    Schema:
        tasks: task_id, phase, budget_json, started_at, updated_at, error, total/completed/failed/running_subtasks
        subtasks: subtask_id, task_id, name, description, status, dependencies_json, result_json, error, duration, tokens_used, metadata_json
    """

    db_path: str = ""

    def __post_init__(self) -> None:
        if not self.db_path:
            try:
                from agent.config import DATA_ROOT
                self.db_path = str(Path(str(DATA_ROOT)) / "tasks.db")
            except Exception:
                self.db_path = str(Path.home() / ".jiabaixing" / "tasks.db")
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS tasks ("
                "task_id TEXT PRIMARY KEY, "
                "phase TEXT NOT NULL, "
                "budget_json TEXT DEFAULT '{}', "
                "started_at REAL NOT NULL, "
                "updated_at REAL NOT NULL, "
                "error TEXT DEFAULT '', "
                "total_subtasks INTEGER DEFAULT 0, "
                "completed_subtasks INTEGER DEFAULT 0, "
                "failed_subtasks INTEGER DEFAULT 0, "
                "running_subtasks INTEGER DEFAULT 0)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS subtasks ("
                "subtask_id TEXT PRIMARY KEY, "
                "task_id TEXT NOT NULL, "
                "name TEXT DEFAULT '', "
                "description TEXT DEFAULT '', "
                "status TEXT NOT NULL, "
                "dependencies_json TEXT DEFAULT '[]', "
                "result_json TEXT DEFAULT '{}', "
                "error TEXT DEFAULT '', "
                "duration REAL DEFAULT 0, "
                "tokens_used INTEGER DEFAULT 0, "
                "metadata_json TEXT DEFAULT '{}', "
                "FOREIGN KEY(task_id) REFERENCES tasks(task_id))"
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_st_task ON subtasks(task_id)")
            conn.commit()
        finally:
            conn.close()

    def save_task(self, progress: TaskProgress, subtasks: list[SubTask] | None = None) -> None:
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        try:
            budget_json = json.dumps({
                "max_tokens": progress.budget.max_tokens,
                "max_time": progress.budget.max_time,
                "max_iterations": progress.budget.max_iterations,
                "tokens_used": progress.budget.tokens_used,
                "time_used": progress.budget.time_used,
                "iterations_used": progress.budget.iterations_used,
            }, ensure_ascii=False)
            conn.execute(
                "INSERT OR REPLACE INTO tasks "
                "(task_id, phase, budget_json, started_at, updated_at, error, "
                "total_subtasks, completed_subtasks, failed_subtasks, running_subtasks) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    progress.task_id,
                    progress.phase.value,
                    budget_json,
                    progress.started_at,
                    progress.updated_at,
                    progress.error or "",
                    progress.total_subtasks,
                    progress.completed_subtasks,
                    progress.failed_subtasks,
                    progress.running_subtasks,
                ),
            )
            if subtasks is not None:
                for st in subtasks:
                    self._save_subtask(conn, progress.task_id, st)
            conn.commit()
        except Exception as exc:
            log.warning("Task persistence save failed", error=str(exc))
        finally:
            conn.close()

    def _save_subtask(self, conn: Any, task_id: str, st: SubTask) -> None:
        conn.execute(
            "INSERT OR REPLACE INTO subtasks "
            "(subtask_id, task_id, name, description, status, dependencies_json, "
            "result_json, error, duration, tokens_used, metadata_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                st.subtask_id,
                task_id,
                st.name,
                st.description,
                st.status.value,
                json.dumps(st.dependencies, ensure_ascii=False),
                json.dumps(st.result or {}, ensure_ascii=False),
                st.error or "",
                st.duration,
                st.tokens_used,
                json.dumps(st.metadata or {}, ensure_ascii=False),
            ),
        )

    def load_all_tasks(self) -> dict[str, tuple[TaskProgress, list[SubTask]]]:
        import sqlite3
        result: dict[str, tuple[TaskProgress, list[SubTask]]] = {}
        conn = None
        try:
            conn = sqlite3.connect(self.db_path)
            rows = conn.execute(
                "SELECT task_id, phase, budget_json, started_at, updated_at, error, "
                "total_subtasks, completed_subtasks, failed_subtasks, running_subtasks "
                "FROM tasks"
            ).fetchall()
            for row in rows:
                progress = self._row_to_progress(row)
                st_rows = conn.execute(
                    "SELECT subtask_id, name, description, status, dependencies_json, "
                    "result_json, error, duration, tokens_used, metadata_json "
                    "FROM subtasks WHERE task_id = ?",
                    (progress.task_id,),
                ).fetchall()
                subtask_list = [self._row_to_subtask(r) for r in st_rows]
                result[progress.task_id] = (progress, subtask_list)
        except Exception as exc:
            log.warning("Task persistence load failed", error=str(exc))
        finally:
            if conn:
                conn.close()
        return result

    def _row_to_progress(self, row: tuple) -> TaskProgress:
        budget_data = json.loads(row[2])
        budget = TaskBudget(
            max_tokens=budget_data.get("max_tokens", 100000),
            max_time=budget_data.get("max_time", 300),
            max_iterations=budget_data.get("max_iterations", 30),
            tokens_used=budget_data.get("tokens_used", 0),
            time_used=budget_data.get("time_used", 0.0),
            iterations_used=budget_data.get("iterations_used", 0),
        )
        return TaskProgress(
            task_id=row[0],
            phase=TaskPhase(row[1]),
            budget=budget,
            started_at=row[3],
            updated_at=row[4],
            error=row[5],
            total_subtasks=row[6],
            completed_subtasks=row[7],
            failed_subtasks=row[8],
            running_subtasks=row[9],
        )

    @staticmethod
    def _row_to_subtask(row: tuple) -> SubTask:
        return SubTask(
            subtask_id=row[0],
            name=row[1],
            description=row[2],
            status=SubTaskStatus(row[3]),
            dependencies=json.loads(row[4]),
            result=json.loads(row[5]) if row[5] else {},
            error=row[6],
            duration=row[7],
            tokens_used=row[8],
            metadata=json.loads(row[9]) if row[9] else {},
        )

    def delete_task(self, task_id: str) -> None:
        import sqlite3
        conn = None
        try:
            conn = sqlite3.connect(self.db_path)
            conn.execute("DELETE FROM subtasks WHERE task_id = ?", (task_id,))
            conn.execute("DELETE FROM tasks WHERE task_id = ?", (task_id,))
            conn.commit()
        except Exception as exc:
            log.warning("Task persistence delete failed", error=str(exc))
        finally:
            if conn:
                conn.close()

    def cleanup_completed(self, max_age_hours: float = 168.0) -> int:
        import sqlite3
        cutoff = time.time() - max_age_hours * 3600
        conn = None
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.execute(
                "DELETE FROM tasks WHERE phase IN ('completed', 'cancelled') AND updated_at < ?",
                (cutoff,),
            )
            deleted = cursor.rowcount
            conn.execute(
                "DELETE FROM subtasks WHERE task_id NOT IN (SELECT task_id FROM tasks)"
            )
            conn.commit()
            if deleted > 0:
                log.info("Cleaned up completed tasks", deleted=deleted)
            return deleted
        except Exception as exc:
            log.warning("Task cleanup failed", error=str(exc))
            return 0
        finally:
            if conn:
                conn.close()


class LongTaskOrchestrator:
    """Codex Harness 风格长任务编排器。

    核心能力：
    1. 任务分解：将长任务分解为子任务DAG（decompose模式）
    2. 并行执行：无依赖子任务并行，有依赖子任务按DAG拓扑排序
    3. 渐进式检查点：每步自动保存checkpoint，失败可从任意步恢复
    4. 预算硬限制：token/time/iteration三维预算，超限自动暂停
    5. 取消支持：CancellationToken外部中断
    6. 沙箱隔离：每个子任务在独立沙箱中执行（通过ActionSandbox）
    """

    def __init__(self, engine: Any = None, persistence_enabled: bool = True) -> None:
        self._engine = engine
        self._tasks: dict[str, TaskProgress] = {}
        self._subtasks: dict[str, list[SubTask]] = {}
        self._cancellation_tokens: dict[str, CancellationToken] = {}
        self._checkpoint_store = TaskCheckpointStore()
        self._active_loops: dict[str, Any] = {}
        self._retry_policy = SubTaskRetryPolicy()
        self._priority_scorer = DynamicPriorityScorer()
        self._persistence_enabled = persistence_enabled
        self._persistence: TaskPersistenceStore | None = None
        if persistence_enabled:
            try:
                self._persistence = TaskPersistenceStore()
                self._restore_from_persistence()
            except Exception as exc:
                log.warning("Task persistence init failed, running without persistence", error=str(exc))

    def _restore_from_persistence(self) -> None:
        if not self._persistence:
            return
        saved = self._persistence.load_all_tasks()
        restored = 0
        for task_id, (progress, subtasks) in saved.items():
            if progress.phase in (TaskPhase.PENDING, TaskPhase.RUNNING, TaskPhase.PAUSED):
                progress.phase = TaskPhase.PAUSED
                self._tasks[task_id] = progress
                self._subtasks[task_id] = subtasks
                self._cancellation_tokens[task_id] = CancellationToken()
                restored += 1
        if restored > 0:
            log.info("Restored tasks from persistence", count=restored)

    def _persist_task(self, task_id: str) -> None:
        if not self._persistence:
            return
        progress = self._tasks.get(task_id)
        if not progress:
            return
        subtasks = self._subtasks.get(task_id, [])
        try:
            self._persistence.save_task(progress, subtasks)
        except Exception as exc:
            log.warning("Task persist failed", task_id=task_id, error=str(exc))

    async def submit(
        self,
        task_description: str,
        mode: ExecutionMode = ExecutionMode.DECOMPOSE,
        budget: TaskBudget | None = None,
        parent_task_id: str | None = None,
        sandbox_enabled: bool = True,
    ) -> str:
        task_id = f"lt_{uuid.uuid4().hex[:8]}"
        token = CancellationToken()
        self._cancellation_tokens[task_id] = token

        progress = TaskProgress(
            task_id=task_id,
            phase=TaskPhase.PENDING,
            budget=budget or TaskBudget(),
            started_at=time.time(),
            updated_at=time.time(),
        )
        self._tasks[task_id] = progress

        if mode == ExecutionMode.DECOMPOSE:
            progress.phase = TaskPhase.DECOMPOSING
            subtasks = await self._decompose_task(task_id, task_description)
            self._subtasks[task_id] = subtasks
            progress.total_subtasks = len(subtasks)
            progress.phase = TaskPhase.RUNNING
            asyncio.create_task(self._run_decomposed(task_id, token, sandbox_enabled))
        elif mode == ExecutionMode.SEQUENTIAL:
            subtask = SubTask(
                subtask_id=f"st_{uuid.uuid4().hex[:8]}",
                name="main",
                description=task_description,
            )
            self._subtasks[task_id] = [subtask]
            progress.total_subtasks = 1
            progress.phase = TaskPhase.RUNNING
            asyncio.create_task(self._run_sequential(task_id, task_description, token, sandbox_enabled))
        elif mode == ExecutionMode.PARALLEL:
            subtasks = await self._decompose_task(task_id, task_description)
            for st in subtasks:
                st.dependencies = []
            self._subtasks[task_id] = subtasks
            progress.total_subtasks = len(subtasks)
            progress.phase = TaskPhase.RUNNING
            asyncio.create_task(self._run_decomposed(task_id, token, sandbox_enabled))
        else:
            subtasks = await self._decompose_task(task_id, task_description)
            self._subtasks[task_id] = subtasks
            progress.total_subtasks = len(subtasks)
            progress.phase = TaskPhase.RUNNING
            asyncio.create_task(self._run_decomposed(task_id, token, sandbox_enabled))

        log.info(
            "Long task submitted",
            task_id=task_id,
            mode=mode.value,
            subtasks=progress.total_subtasks,
        )
        return task_id

    async def _decompose_task(self, task_id: str, description: str) -> list[SubTask]:
        template_steps = match_template(description)
        if template_steps:
            log.info("Task matched template, using template decomposition", task_id=task_id, steps=len(template_steps))
            name_to_id: dict[str, str] = {}
            subtasks = []
            for step in template_steps:
                subtask_id = f"st_{uuid.uuid4().hex[:8]}"
                name_to_id[step["name"]] = subtask_id
                subtasks.append(SubTask(
                    subtask_id=subtask_id,
                    name=step.get("name", ""),
                    description=step.get("description", ""),
                    dependencies=[],
                ))
            for i, step in enumerate(template_steps):
                dep_ids = [name_to_id[d] for d in step.get("dependencies", []) if d in name_to_id]
                if i < len(subtasks):
                    subtasks[i].dependencies = dep_ids
            return subtasks

        if not self._engine:
            return [SubTask(
                subtask_id=f"st_{uuid.uuid4().hex[:8]}",
                name="main",
                description=description,
            )]

        try:
            loop = self._engine.conversation_loop
            result = await loop.run(
                user_input=(
                    f"将以下长任务分解为可独立执行的子任务列表。"
                    f"每个子任务需包含：name（简短名称）、description（详细描述）、"
                    f"dependencies（依赖的子任务名称列表）。\n\n"
                    f"长任务：{description}\n\n"
                    f"请以JSON数组格式输出，例如：\n"
                    f'[{{"name": "step1", "description": "...", "dependencies": []}}]'
                ),
                session_id=f"{task_id}_decompose",
            )
            subtasks = self._parse_decomposition(result.content)
            if subtasks:
                return subtasks
        except Exception as exc:
            log.warning("Task decomposition failed, falling back to single task", error=str(exc))

        return [SubTask(
            subtask_id=f"st_{uuid.uuid4().hex[:8]}",
            name="main",
            description=description,
        )]

    def _parse_decomposition(self, content: str) -> list[SubTask]:
        import re
        json_match = re.search(r'\[[\s\S]*\]', content)
        if not json_match:
            return []

        try:
            items = json.loads(json_match.group())
        except json.JSONDecodeError:
            return []

        name_to_id: dict[str, str] = {}
        subtasks = []
        for item in items:
            if not isinstance(item, dict) or "name" not in item:
                continue
            subtask_id = f"st_{uuid.uuid4().hex[:8]}"
            name_to_id[item["name"]] = subtask_id
            subtasks.append(SubTask(
                subtask_id=subtask_id,
                name=item.get("name", ""),
                description=item.get("description", ""),
                dependencies=[],
            ))

        for i, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            deps = item.get("dependencies", [])
            dep_ids = [name_to_id[d] for d in deps if d in name_to_id]
            if i < len(subtasks):
                subtasks[i].dependencies = dep_ids

        return subtasks

    async def _run_sequential(
        self,
        task_id: str,
        description: str,
        token: CancellationToken,
        sandbox_enabled: bool,
    ) -> None:
        progress = self._tasks[task_id]
        start = time.time()

        try:
            checkpoint = self._checkpoint_store.load_latest(task_id)
            loop = self._get_or_create_loop(task_id)

            result = await loop.run(
                user_input=description,
                session_id=task_id,
                cancellation_token=token,
                checkpoint=checkpoint,
            )

            progress.budget.tokens_used = result.total_tokens
            progress.budget.time_used = time.time() - start
            progress.budget.iterations_used = result.rounds_used

            if loop.last_checkpoint:
                self._checkpoint_store.save(task_id, loop.last_checkpoint)

            if result.finish_reason == "cancelled":
                progress.phase = TaskPhase.CANCELLED
            elif result.finish_reason == "budget_exhausted":
                progress.phase = TaskPhase.PAUSED
                progress.error = "Budget exhausted, task paused for resume"
            else:
                progress.phase = TaskPhase.COMPLETED
                progress.completed_subtasks = 1

            self._subtasks[task_id][0].status = SubTaskStatus.COMPLETED
            self._subtasks[task_id][0].result = {"content": result.content}

        except Exception as exc:
            log.error("Sequential task failed", task_id=task_id, error=str(exc))
            progress.phase = TaskPhase.FAILED
            progress.error = str(exc)
            if self._subtasks.get(task_id):
                self._subtasks[task_id][0].status = SubTaskStatus.FAILED
                self._subtasks[task_id][0].error = str(exc)

        finally:
            progress.updated_at = time.time()
            self._persist_task(task_id)
            self._active_loops.pop(task_id, None)

    async def _run_decomposed(
        self,
        task_id: str,
        token: CancellationToken,
        sandbox_enabled: bool,
    ) -> None:
        progress = self._tasks[task_id]
        subtasks = self._subtasks.get(task_id, [])
        start = time.time()
        completed_ids: set[str] = set()
        failed_ids: set[str] = set()

        while len(completed_ids) + len(failed_ids) < len(subtasks):
            if token.is_cancelled:
                progress.phase = TaskPhase.CANCELLED
                break

            if progress.budget.is_exhausted:
                progress.phase = TaskPhase.PAUSED
                progress.error = "Budget exhausted"
                break

            ready = [
                st for st in subtasks
                if st.status == SubTaskStatus.PENDING
                and all(dep in completed_ids for dep in st.dependencies)
            ]

            if not ready:
                pending = [st for st in subtasks if st.status == SubTaskStatus.PENDING]
                if pending and not ready:
                    blocked = [st for st in pending if any(dep in failed_ids for dep in st.dependencies)]
                    for st in blocked:
                        st.status = SubTaskStatus.SKIPPED
                        st.error = "Dependency failed"
                    failed_ids.update(st.subtask_id for st in blocked)
                    continue
                break

            ready = self._sort_by_priority(ready)

            runnable = ready[:3]
            coros = [self._run_subtask(task_id, st, token, sandbox_enabled) for st in runnable]
            results = await asyncio.gather(*coros, return_exceptions=True)

            for st, result in zip(runnable, results):
                if isinstance(result, Exception):
                    st.status = SubTaskStatus.FAILED
                    st.error = str(result)
                    failed_ids.add(st.subtask_id)
                    progress.failed_subtasks += 1
                else:
                    st.status = SubTaskStatus.COMPLETED
                    st.result = result or {}
                    completed_ids.add(st.subtask_id)
                    progress.completed_subtasks += 1
                    if st.checkpoint:
                        self._checkpoint_store.save(task_id, st.checkpoint)

                progress.running_subtasks = sum(
                    1 for s in subtasks if s.status == SubTaskStatus.RUNNING
                )
                progress.updated_at = time.time()

            progress.budget.time_used = time.time() - start

        if progress.phase == TaskPhase.RUNNING:
            if failed_ids and len(failed_ids) > len(subtasks) // 2:
                progress.phase = TaskPhase.FAILED
                progress.error = f"{len(failed_ids)}/{len(subtasks)} subtasks failed"
            else:
                progress.phase = TaskPhase.COMPLETED

        progress.updated_at = time.time()
        self._persist_task(task_id)

    async def _run_subtask(
        self,
        task_id: str,
        subtask: SubTask,
        token: CancellationToken,
        sandbox_enabled: bool,
    ) -> dict[str, Any]:
        subtask.status = SubTaskStatus.RUNNING
        start = time.time()
        last_error: str | None = None

        for attempt in range(self._retry_policy.max_retries + 1):
            if token.is_cancelled:
                subtask.status = SubTaskStatus.FAILED
                subtask.error = "Cancelled"
                raise RuntimeError("Cancelled")

            if attempt > 0:
                delay = self._retry_policy.get_delay(attempt - 1)
                log.info(
                    "Retrying subtask",
                    task_id=task_id,
                    subtask=subtask.name,
                    attempt=attempt,
                    delay=delay,
                )
                await asyncio.sleep(delay)

            checkpoint = self._checkpoint_store.load_latest(task_id)
            loop = self._get_or_create_loop(f"{task_id}_{subtask.subtask_id}")

            try:
                result = await loop.run(
                    user_input=subtask.description,
                    session_id=f"{task_id}_{subtask.subtask_id}",
                    cancellation_token=token,
                    checkpoint=checkpoint,
                )

                subtask.duration = time.time() - start
                subtask.tokens_used = result.total_tokens
                subtask.checkpoint = loop.last_checkpoint

                progress = self._tasks[task_id]
                progress.budget.tokens_used += result.total_tokens
                progress.budget.iterations_used += result.rounds_used

                return {"content": result.content, "rounds": result.rounds_used}

            except Exception as exc:
                last_error = str(exc)
                if not self._retry_policy.should_retry(last_error, attempt):
                    subtask.status = SubTaskStatus.FAILED
                    subtask.error = last_error
                    raise
                log.warning(
                    "Subtask failed, will retry",
                    task_id=task_id,
                    subtask=subtask.name,
                    attempt=attempt,
                    error=last_error[:80],
                )

        subtask.status = SubTaskStatus.FAILED
        subtask.error = last_error or "Max retries exceeded"
        raise RuntimeError(subtask.error)

    def _get_or_create_loop(self, session_key: str) -> Any:
        if session_key in self._active_loops:
            return self._active_loops[session_key]

        if self._engine and hasattr(self._engine, "conversation_loop"):
            loop = self._engine.conversation_loop
        else:
            from agent.core.conversation_loop import ConversationLoop
            from agent.llm.provider import LLMProvider
            from agent.tools.registry import ToolRegistry, register_default_tools

            registry = ToolRegistry()
            register_default_tools(registry)
            provider = LLMProvider()
            loop = ConversationLoop(llm=provider, tool_registry=registry)

        self._active_loops[session_key] = loop
        return loop

    def get_status(self, task_id: str) -> TaskProgress | None:
        return self._tasks.get(task_id)

    def get_subtasks(self, task_id: str) -> list[SubTask]:
        return self._subtasks.get(task_id, [])

    async def cancel(self, task_id: str) -> bool:
        token = self._cancellation_tokens.get(task_id)
        if not token:
            return False
        token.cancel()
        progress = self._tasks.get(task_id)
        if progress:
            progress.phase = TaskPhase.CANCELLED
            progress.updated_at = time.time()
        self._persist_task(task_id)
        log.info("Long task cancelled", task_id=task_id)
        return True

    async def resume(self, task_id: str) -> bool:
        progress = self._tasks.get(task_id)
        if not progress or progress.phase not in (TaskPhase.PAUSED, TaskPhase.FAILED):
            return False

        checkpoint = self._checkpoint_store.load_latest(task_id)
        if not checkpoint:
            log.warning("No checkpoint found for resume", task_id=task_id)
            return False

        new_token = CancellationToken()
        self._cancellation_tokens[task_id] = new_token
        progress.phase = TaskPhase.RUNNING
        progress.updated_at = time.time()
        self._persist_task(task_id)

        subtasks = self._subtasks.get(task_id, [])
        pending = [st for st in subtasks if st.status in (SubTaskStatus.PENDING, SubTaskStatus.FAILED)]

        if pending:
            asyncio.create_task(self._run_decomposed(task_id, new_token, True))
        else:
            loop = self._get_or_create_loop(task_id)
            asyncio.create_task(
                self._run_sequential(task_id, progress.error or "resumed", new_token, True)
            )

        log.info("Long task resumed from checkpoint", task_id=task_id)
        return True

    def _sort_by_priority(self, subtasks: list[SubTask]) -> list[SubTask]:
        """按动态优先级排序子任务，高优先级先执行."""
        if not subtasks:
            return subtasks
        task_infos = [
            TaskInfo(
                title=st.name or st.subtask_id,
                base_priority=self._map_subtask_priority(st),
            )
            for st in subtasks
        ]
        scores = self._priority_scorer.rank(task_infos)
        score_by_title = {s.task_title: s.total for s in scores}
        return sorted(
            subtasks,
            key=lambda st: -score_by_title.get(st.name or st.subtask_id, 0.5),
        )

    @staticmethod
    def _map_subtask_priority(subtask: SubTask) -> Any:
        """将子任务元数据中的priority映射为Priority枚举."""
        from agent.core.dynamic_priority import Priority
        prio_str = (subtask.metadata or {}).get("priority", "medium")
        mapping = {
            "critical": Priority.CRITICAL,
            "high": Priority.HIGH,
            "medium": Priority.MEDIUM,
            "low": Priority.LOW,
            "none": Priority.NONE,
        }
        return mapping.get(str(prio_str).lower(), Priority.MEDIUM)

    def set_subtask_priority(
        self,
        task_id: str,
        subtask_name: str,
        priority: str,
    ) -> bool:
        """为指定子任务设置优先级.

        Args:
            task_id: 长任务ID.
            subtask_name: 子任务名称.
            priority: 优先级（critical/high/medium/low/none）.

        Returns:
            是否设置成功.
        """
        subtasks = self._subtasks.get(task_id, [])
        for st in subtasks:
            if st.name == subtask_name:
                if st.metadata is None:
                    st.metadata = {}
                st.metadata["priority"] = priority
                log.info("Subtask priority set", task_id=task_id, subtask=subtask_name, priority=priority)
                return True
        return False

    def list_tasks(self) -> list[TaskProgress]:
        return list(self._tasks.values())

    def get_checkpoints(self, task_id: str) -> list[dict[str, Any]]:
        return self._checkpoint_store.list_checkpoints(task_id)
