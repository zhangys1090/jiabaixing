"""WorkflowEngine SQLite 持久化存储。

存储工作流定义、实例状态、步骤结果、变量绑定。
仅支持追加和更新，不支持物理删除（软删除）。

数据库表：
- workflow_definitions: 工作流定义
- workflow_instances: 工作流实例
- step_states: 步骤状态
- workflow_variables: 工作流变量
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from agent.infrastructure.safe_json import safe_json_loads

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger
from agent.workflow.types import (
    WorkflowDefinition,
    WorkflowStep,
    WorkflowInstance,
    StepState,
    TriggerConfig,
)

log = StructuredLogger("workflow_store")

_DB_PATH = DATA_ROOT / "workflow" / "workflow.db"


class WorkflowStore:
    """工作流持久化存储。"""

    def __init__(self, db_path: str | None = None) -> None:
        self._db_path = db_path or str(_DB_PATH)
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS workflow_definitions (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    steps_json TEXT NOT NULL DEFAULT '[]',
                    variables_json TEXT NOT NULL DEFAULT '{}',
                    trigger_json TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    deleted INTEGER NOT NULL DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS workflow_instances (
                    id TEXT PRIMARY KEY,
                    definition_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    variables_json TEXT NOT NULL DEFAULT '{}',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    started_at REAL NOT NULL DEFAULT 0,
                    completed_at REAL NOT NULL DEFAULT 0,
                    checkpoint_id TEXT NOT NULL DEFAULT '',
                    parent_instance_id TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (definition_id) REFERENCES workflow_definitions(id)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS step_states (
                    instance_id TEXT NOT NULL,
                    step_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    started_at REAL NOT NULL DEFAULT 0,
                    completed_at REAL NOT NULL DEFAULT 0,
                    result_json TEXT,
                    error TEXT NOT NULL DEFAULT '',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    duration_ms REAL NOT NULL DEFAULT 0,
                    PRIMARY KEY (instance_id, step_id),
                    FOREIGN KEY (instance_id) REFERENCES workflow_instances(id)
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_instances_status ON workflow_instances(status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_instances_definition ON workflow_instances(definition_id)")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS workflow_definition_versions (
                    id TEXT PRIMARY KEY,
                    definition_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    FOREIGN KEY (definition_id) REFERENCES workflow_definitions(id)
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_versions_def ON workflow_definition_versions(definition_id)")

    def save_definition(self, definition: WorkflowDefinition) -> None:
        steps_json = json.dumps(
            [{"id": s.id, "name": s.name, "type": s.type, "prompt": s.prompt,
              "tool_name": s.tool_name, "subflow_id": s.subflow_id,
              "depends_on": s.depends_on, "condition": s.condition,
              "timeout_seconds": s.timeout_seconds, "retry_count": s.retry_count,
              "on_failure": s.on_failure, "variables_input": s.variables_input,
              "variables_output": s.variables_output}
             for s in definition.steps],
            ensure_ascii=False,
        )
        trigger_json = json.dumps(
            {"type": definition.trigger.type,
             "cron_expression": definition.trigger.cron_expression,
             "watch_paths": definition.trigger.watch_paths,
             "watch_patterns": definition.trigger.watch_patterns,
             "webhook_path": definition.trigger.webhook_path,
             "webhook_method": definition.trigger.webhook_method,
             "message_pattern": definition.trigger.message_pattern,
             "enabled": definition.trigger.enabled},
            ensure_ascii=False,
        ) if definition.trigger else None

        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO workflow_definitions
                (id, name, description, steps_json, variables_json, trigger_json,
                 created_at, updated_at, version, tags_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                definition.id, definition.name, definition.description,
                steps_json, json.dumps(definition.variables, ensure_ascii=False),
                trigger_json, definition.created_at, definition.updated_at,
                definition.version, json.dumps(definition.tags, ensure_ascii=False),
            ))
            self._save_version_snapshot(conn, definition, steps_json, trigger_json)

    def _save_version_snapshot(
        self,
        conn: sqlite3.Connection,
        definition: WorkflowDefinition,
        steps_json: str,
        trigger_json: str | None,
    ) -> None:
        """P2: 保存定义版本快照到 workflow_definition_versions。"""
        snapshot = json.dumps({
            "name": definition.name,
            "description": definition.description,
            "steps_json": steps_json,
            "variables_json": json.dumps(definition.variables, ensure_ascii=False),
            "trigger_json": trigger_json,
            "tags_json": json.dumps(definition.tags, ensure_ascii=False),
        }, ensure_ascii=False)
        version_id = f"{definition.id}_v{definition.version}"
        conn.execute("""
            INSERT OR REPLACE INTO workflow_definition_versions
            (id, definition_id, version, snapshot_json, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, (version_id, definition.id, definition.version, snapshot, definition.updated_at))

    def load_definition(self, definition_id: str) -> WorkflowDefinition | None:
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute(
                "SELECT * FROM workflow_definitions WHERE id = ? AND deleted = 0",
                (definition_id,),
            ).fetchone()
            if not row:
                return None
            return self._row_to_definition(row)

    def list_definitions(self, limit: int = 50) -> list[WorkflowDefinition]:
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute(
                "SELECT * FROM workflow_definitions WHERE deleted = 0 ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [self._row_to_definition(r) for r in rows]

    def delete_definition(self, definition_id: str) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "UPDATE workflow_definitions SET deleted = 1, updated_at = ? WHERE id = ?",
                (time.time(), definition_id),
            )

    def save_instance(self, instance: WorkflowInstance) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO workflow_instances
                (id, definition_id, status, variables_json, created_at, updated_at,
                 started_at, completed_at, checkpoint_id, parent_instance_id, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                instance.id, instance.definition_id, instance.status,
                json.dumps(instance.variables, ensure_ascii=False),
                instance.created_at, instance.updated_at,
                instance.started_at, instance.completed_at,
                instance.checkpoint_id, instance.parent_instance_id,
                instance.error,
            ))
            for ss in instance.step_states.values():
                conn.execute("""
                    INSERT OR REPLACE INTO step_states
                    (instance_id, step_id, status, started_at, completed_at,
                     result_json, error, attempts, duration_ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    instance.id, ss.step_id, ss.status,
                    ss.started_at, ss.completed_at,
                    json.dumps(ss.result, ensure_ascii=False) if ss.result else None,
                    ss.error, ss.attempts, ss.duration_ms,
                ))

    def load_instance(self, instance_id: str) -> WorkflowInstance | None:
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute(
                "SELECT * FROM workflow_instances WHERE id = ?", (instance_id,),
            ).fetchone()
            if not row:
                return None
            instance = WorkflowInstance(
                id=row[0], definition_id=row[1], status=row[2],
                variables=safe_json_loads(row[3], {}, context="checkpoint.variables"),
                created_at=row[4], updated_at=row[5],
                started_at=row[6], completed_at=row[7],
                checkpoint_id=row[8], parent_instance_id=row[9],
                error=row[10],
            )
            ss_rows = conn.execute(
                "SELECT step_id, status, started_at, completed_at, result_json, error, attempts, duration_ms FROM step_states WHERE instance_id = ?",
                (instance_id,),
            ).fetchall()
            for sr in ss_rows:
                instance.step_states[sr[0]] = StepState(
                    step_id=sr[0], status=sr[1],
                    started_at=sr[2], completed_at=sr[3],
                    result=safe_json_loads(sr[4], None, context="checkpoint.step_result"),
                    error=sr[5] or "", attempts=sr[6], duration_ms=sr[7],
                )
            return instance

    def list_instances(
        self,
        definition_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[WorkflowInstance]:
        conditions = []
        params: list[Any] = []
        if definition_id:
            conditions.append("definition_id = ?")
            params.append(definition_id)
        if status:
            conditions.append("status = ?")
            params.append(status)
        where = " AND ".join(conditions) if conditions else "1=1"
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute(
                f"SELECT * FROM workflow_instances WHERE {where} ORDER BY created_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
            results = []
            for row in rows:
                instance = WorkflowInstance(
                    id=row[0], definition_id=row[1], status=row[2],
                    variables=safe_json_loads(row[3], {}, context="checkpoint.variables"),
                    created_at=row[4], updated_at=row[5],
                    started_at=row[6], completed_at=row[7],
                    checkpoint_id=row[8], parent_instance_id=row[9],
                    error=row[10],
                )
                ss_rows = conn.execute(
                    "SELECT step_id, status, started_at, completed_at, result_json, error, attempts, duration_ms FROM step_states WHERE instance_id = ?",
                    (instance.id,),
                ).fetchall()
                for sr in ss_rows:
                    instance.step_states[sr[0]] = StepState(
                        step_id=sr[0], status=sr[1],
                        started_at=sr[2], completed_at=sr[3],
                        result=safe_json_loads(sr[4], None, context="checkpoint.step_result"),
                        error=sr[5] or "", attempts=sr[6], duration_ms=sr[7],
                    )
                results.append(instance)
            return results

    def update_step_state(
        self,
        instance_id: str,
        step_id: str,
        status: str,
        result: dict[str, Any] | None = None,
        error: str = "",
        duration_ms: float = 0.0,
    ) -> None:
        now = time.time()
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO step_states
                (instance_id, step_id, status, started_at, completed_at, result_json, error, attempts, duration_ms)
                VALUES (?, ?, ?,
                    COALESCE((SELECT started_at FROM step_states WHERE instance_id = ? AND step_id = ?), ?),
                    ?, ?, ?, ?, ?)
            """, (
                instance_id, step_id, status,
                instance_id, step_id, now if status == "running" else 0,
                now if status in ("done", "failed", "skipped") else 0,
                json.dumps(result, ensure_ascii=False) if result else None,
                error, 0, duration_ms,
            ))
            conn.execute(
                "UPDATE workflow_instances SET updated_at = ? WHERE id = ?",
                (now, instance_id),
            )

    def update_instance_status(
        self,
        instance_id: str,
        status: str,
        error: str = "",
    ) -> None:
        now = time.time()
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "UPDATE workflow_instances SET status = ?, updated_at = ?, error = ? WHERE id = ?",
                (status, now, error, instance_id),
            )
            if status == "running":
                conn.execute(
                    "UPDATE workflow_instances SET started_at = ? WHERE id = ? AND started_at = 0",
                    (now, instance_id),
                )
            if status in ("done", "failed", "cancelled"):
                conn.execute(
                    "UPDATE workflow_instances SET completed_at = ? WHERE id = ?",
                    (now, instance_id),
                )

    def _row_to_definition(self, row: tuple) -> WorkflowDefinition:
        steps_data = safe_json_loads(row[3], [], context="checkpoint.definition_steps")
        steps = []
        for sd in steps_data:
            steps.append(WorkflowStep(
                id=sd["id"], name=sd["name"], type=sd.get("type", "llm"),
                prompt=sd.get("prompt", ""), tool_name=sd.get("tool_name", ""),
                subflow_id=sd.get("subflow_id", ""),
                depends_on=sd.get("depends_on", []),
                condition=sd.get("condition"),
                timeout_seconds=sd.get("timeout_seconds", 300.0),
                retry_count=sd.get("retry_count", 0),
                on_failure=sd.get("on_failure", "fail"),
                variables_input=sd.get("variables_input", {}),
                variables_output=sd.get("variables_output", {}),
            ))
        trigger = None
        if row[5]:
            td = safe_json_loads(row[5], {}, context="checkpoint.definition_trigger")
            trigger = TriggerConfig(
                type=td.get("type", "manual"),
                cron_expression=td.get("cron_expression"),
                watch_paths=td.get("watch_paths"),
                watch_patterns=td.get("watch_patterns"),
                webhook_path=td.get("webhook_path"),
                webhook_method=td.get("webhook_method", "POST"),
                message_pattern=td.get("message_pattern"),
                enabled=td.get("enabled", True),
            )
        return WorkflowDefinition(
            id=row[0], name=row[1], description=row[2],
            steps=steps, variables=safe_json_loads(row[4], {}, context="checkpoint.definition_variables"),
            trigger=trigger, created_at=row[6], updated_at=row[7],
            version=row[8], tags=safe_json_loads(row[9], [], context="checkpoint.definition_tags"),
        )

    def list_versions(
        self,
        definition_id: str,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """P2: 列出工作流定义的版本历史。"""
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute(
                "SELECT version, created_at FROM workflow_definition_versions "
                "WHERE definition_id = ? ORDER BY version DESC LIMIT ?",
                (definition_id, limit),
            ).fetchall()
            return [{"version": r[0], "created_at": r[1]} for r in rows]

    def load_version(
        self,
        definition_id: str,
        version: int,
    ) -> WorkflowDefinition | None:
        """P2: 加载指定版本的工作流定义快照。"""
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute(
                "SELECT snapshot_json FROM workflow_definition_versions "
                "WHERE definition_id = ? AND version = ?",
                (definition_id, version),
            ).fetchone()
            if not row:
                return None
            snapshot = safe_json_loads(row[0], {}, context="checkpoint.version_snapshot")
            current = self.load_definition(definition_id)
            if not current:
                return None
            restored = WorkflowDefinition(
                id=definition_id,
                name=snapshot.get("name", current.name),
                description=snapshot.get("description", current.description),
                steps=self._parse_steps_json(snapshot.get("steps_json", "[]")),
                variables=safe_json_loads(snapshot.get("variables_json", "{}"), {}, context="checkpoint.version_variables"),
                trigger=self._parse_trigger_json(snapshot.get("trigger_json")),
                created_at=current.created_at,
                updated_at=time.time(),
                version=version,
                tags=safe_json_loads(snapshot.get("tags_json", "[]"), [], context="checkpoint.version_tags"),
            )
            return restored

    def _parse_steps_json(self, steps_json: str) -> list[WorkflowStep]:
        """从 JSON 解析步骤列表。"""
        steps_data = safe_json_loads(steps_json, [], context="checkpoint.steps")
        steps = []
        for sd in steps_data:
            steps.append(WorkflowStep(
                id=sd["id"], name=sd["name"], type=sd.get("type", "llm"),
                prompt=sd.get("prompt", ""), tool_name=sd.get("tool_name", ""),
                subflow_id=sd.get("subflow_id", ""),
                depends_on=sd.get("depends_on", []),
                condition=sd.get("condition"),
                timeout_seconds=sd.get("timeout_seconds", 300.0),
                retry_count=sd.get("retry_count", 0),
                on_failure=sd.get("on_failure", "fail"),
                variables_input=sd.get("variables_input", {}),
                variables_output=sd.get("variables_output", {}),
            ))
        return steps

    def _parse_trigger_json(self, trigger_json: str | None) -> TriggerConfig | None:
        """从 JSON 解析触发配置。"""
        if not trigger_json:
            return None
        td = safe_json_loads(trigger_json, {}, context="checkpoint.trigger")
        return TriggerConfig(
            type=td.get("type", "manual"),
            cron_expression=td.get("cron_expression"),
            watch_paths=td.get("watch_paths"),
            watch_patterns=td.get("watch_patterns"),
            webhook_path=td.get("webhook_path"),
            webhook_method=td.get("webhook_method", "POST"),
            message_pattern=td.get("message_pattern"),
            enabled=td.get("enabled", True),
        )
