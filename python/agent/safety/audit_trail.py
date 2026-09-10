"""AuditTrail — 审计日志。

不可篡改的操作审计日志，记录所有 Agent 操作的完整轨迹。
存储在 SQLite 中，仅支持追加，不支持删除或修改。

审计条目维度：
- 谁：哪个 Agent/工具/工作流
- 何时：时间戳
- 做了什么：工具名 + 参数
- 结果：成功/失败/已回滚
- 关联：还原点/作用域/回滚记录

Usage:
    from agent.safety.audit_trail import AuditTrail, AuditEntry

    trail = AuditTrail()
    trail.record(tool_name="file_write", params={"path": "/tmp/test.txt"}, risk_level="medium")
    entries = trail.query(tool_name="file_write", limit=10)
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger
from agent.core.types import BaseAuditEntry

log = StructuredLogger("audit_trail")


_DB_PATH = DATA_ROOT / "safety" / "audit.db"


@dataclass
class AuditEntry(BaseAuditEntry):
    """审计条目 — 继承 core.types.BaseAuditEntry。

    Attributes:
        id: 唯一标识。
        tool_name: 工具名称。
        params: 工具参数。
        risk_level: 风险等级。
        result: 执行结果（success/failed/rolled_back）。
        checkpoint_id: 关联的还原点 ID。
        scope_id: 关联的作用域 ID。
        rollback_id: 关联的回滚记录 ID。
        duration_ms: 执行耗时（毫秒）。
        error: 错误信息。
        session_id: 会话 ID。
        workflow_id: 工作流 ID（如有）。
    """

    id: str = ""
    tool_name: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    risk_level: str = "low"
    result: str = ""
    checkpoint_id: str = ""
    scope_id: str = ""
    rollback_id: str = ""
    duration_ms: float = 0.0
    error: str = ""
    session_id: str = ""
    workflow_id: str = ""


class AuditTrail:
    """审计日志 — 不可篡改的操作记录。

    所有 Agent 工具调用都会被记录，支持按时间/工具/风险等级/结果检索。
    日志仅支持追加（INSERT），不支持删除或修改（UPDATE/DELETE）。
    """

    def __init__(self, db_path: str | None = None) -> None:
        self._db_path = db_path or str(_DB_PATH)
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    id TEXT PRIMARY KEY,
                    timestamp REAL NOT NULL,
                    tool_name TEXT NOT NULL,
                    params TEXT NOT NULL DEFAULT '{}',
                    risk_level TEXT NOT NULL DEFAULT 'low',
                    result TEXT NOT NULL DEFAULT '',
                    checkpoint_id TEXT NOT NULL DEFAULT '',
                    scope_id TEXT NOT NULL DEFAULT '',
                    rollback_id TEXT NOT NULL DEFAULT '',
                    duration_ms REAL NOT NULL DEFAULT 0,
                    error TEXT NOT NULL DEFAULT '',
                    session_id TEXT NOT NULL DEFAULT '',
                    workflow_id TEXT NOT NULL DEFAULT ''
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool_name)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_risk ON audit_log(risk_level)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result)")

    def record(
        self,
        tool_name: str,
        params: dict[str, Any] | None = None,
        risk_level: str = "low",
        result: str = "success",
        checkpoint_id: str = "",
        scope_id: str = "",
        rollback_id: str = "",
        duration_ms: float = 0.0,
        error: str = "",
        session_id: str = "",
        workflow_id: str = "",
    ) -> AuditEntry:
        """记录一条审计日志。

        Args:
            tool_name: 工具名称。
            params: 工具参数。
            risk_level: 风险等级。
            result: 执行结果。
            checkpoint_id: 关联的还原点。
            scope_id: 关联的作用域。
            rollback_id: 关联的回滚记录。
            duration_ms: 执行耗时。
            error: 错误信息。
            session_id: 会话 ID。
            workflow_id: 工作流 ID。

        Returns:
            AuditEntry: 记录的审计条目。
        """
        entry = AuditEntry(
            id=uuid.uuid4().hex[:12],
            timestamp=time.time(),
            tool_name=tool_name,
            params=params or {},
            risk_level=risk_level,
            result=result,
            checkpoint_id=checkpoint_id,
            scope_id=scope_id,
            rollback_id=rollback_id,
            duration_ms=duration_ms,
            error=error,
            session_id=session_id,
            workflow_id=workflow_id,
        )

        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                """INSERT INTO audit_log
                   (id, timestamp, tool_name, params, risk_level, result,
                    checkpoint_id, scope_id, rollback_id, duration_ms,
                    error, session_id, workflow_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    entry.id, entry.timestamp, entry.tool_name,
                    json.dumps(entry.params, ensure_ascii=False),
                    entry.risk_level, entry.result,
                    entry.checkpoint_id, entry.scope_id, entry.rollback_id,
                    entry.duration_ms, entry.error, entry.session_id,
                    entry.workflow_id,
                ),
            )

        return entry

    def query(
        self,
        tool_name: str | None = None,
        risk_level: str | None = None,
        result: str | None = None,
        session_id: str | None = None,
        workflow_id: str | None = None,
        since: float | None = None,
        until: float | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[AuditEntry]:
        """查询审计日志。

        Args:
            tool_name: 按工具名过滤。
            risk_level: 按风险等级过滤。
            result: 按结果过滤。
            session_id: 按会话 ID 过滤。
            workflow_id: 按工作流 ID 过滤。
            since: 起始时间戳。
            until: 结束时间戳。
            limit: 返回条数上限。
            offset: 偏移量。

        Returns:
            list[AuditEntry]: 匹配的审计条目列表。
        """
        conditions = []
        params_list: list[Any] = []

        if tool_name:
            conditions.append("tool_name = ?")
            params_list.append(tool_name)
        if risk_level:
            conditions.append("risk_level = ?")
            params_list.append(risk_level)
        if result:
            conditions.append("result = ?")
            params_list.append(result)
        if session_id:
            conditions.append("session_id = ?")
            params_list.append(session_id)
        if workflow_id:
            conditions.append("workflow_id = ?")
            params_list.append(workflow_id)
        if since is not None:
            conditions.append("timestamp >= ?")
            params_list.append(since)
        if until is not None:
            conditions.append("timestamp <= ?")
            params_list.append(until)

        where = " AND ".join(conditions) if conditions else "1=1"
        sql = f"SELECT * FROM audit_log WHERE {where} ORDER BY timestamp DESC LIMIT ? OFFSET ?"
        params_list.extend([limit, offset])

        entries = []
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute(sql, params_list).fetchall()
            for row in rows:
                entries.append(AuditEntry(
                    id=row[0], timestamp=row[1], tool_name=row[2],
                    params=safe_json_loads(row[3], {}, context="safety.audit_trail.params"), risk_level=row[4], result=row[5],
                    checkpoint_id=row[6], scope_id=row[7], rollback_id=row[8],
                    duration_ms=row[9], error=row[10], session_id=row[11],
                    workflow_id=row[12],
                ))
        return entries

    def count(
        self,
        tool_name: str | None = None,
        risk_level: str | None = None,
        result: str | None = None,
        since: float | None = None,
    ) -> int:
        """统计审计日志条数。"""
        conditions = []
        params_list: list[Any] = []

        if tool_name:
            conditions.append("tool_name = ?")
            params_list.append(tool_name)
        if risk_level:
            conditions.append("risk_level = ?")
            params_list.append(risk_level)
        if result:
            conditions.append("result = ?")
            params_list.append(result)
        if since is not None:
            conditions.append("timestamp >= ?")
            params_list.append(since)

        where = " AND ".join(conditions) if conditions else "1=1"
        sql = "SELECT COUNT(*) FROM audit_log WHERE " + where
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute(sql, params_list).fetchone()
            return row[0] if row else 0

    def stats(self, since: float | None = None) -> dict[str, Any]:
        """获取审计统计摘要。"""
        since = since or (time.time() - 86400)
        with sqlite3.connect(self._db_path) as conn:
            total = conn.execute("SELECT COUNT(*) FROM audit_log WHERE timestamp >= ?", (since,)).fetchone()[0]
            by_result = dict(conn.execute(
                "SELECT result, COUNT(*) FROM audit_log WHERE timestamp >= ? GROUP BY result", (since,)
            ).fetchall())
            by_risk = dict(conn.execute(
                "SELECT risk_level, COUNT(*) FROM audit_log WHERE timestamp >= ? GROUP BY risk_level", (since,)
            ).fetchall())
            by_tool = dict(conn.execute(
                "SELECT tool_name, COUNT(*) FROM audit_log WHERE timestamp >= ? GROUP BY tool_name ORDER BY COUNT(*) DESC LIMIT 10", (since,)
            ).fetchall())
            rolled_back = conn.execute(
                "SELECT COUNT(*) FROM audit_log WHERE timestamp >= ? AND result = 'rolled_back'", (since,)
            ).fetchone()[0]

        return {
            "total": total,
            "by_result": by_result,
            "by_risk": by_risk,
            "top_tools": by_tool,
            "rolled_back": rolled_back,
            "since": since,
        }
