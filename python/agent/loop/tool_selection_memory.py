"""R2: 工具选择记忆 — 记录工具选择历史，优化未来选择。

记录每个工具的调用频次、成功率、平均耗时，并据此推荐工具。
数据持久化到 SQLite，支持跨会话复用。
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("tool_selection_memory")


@dataclass
class ToolStats:
    name: str = ""
    call_count: int = 0
    success_count: int = 0
    total_duration_ms: float = 0.0
    last_used_at: float = 0.0

    @property
    def success_rate(self) -> float:
        return self.success_count / self.call_count if self.call_count > 0 else 0.0

    @property
    def avg_duration_ms(self) -> float:
        return self.total_duration_ms / self.call_count if self.call_count > 0 else 0.0


class ToolSelectionMemory:
    def __init__(self, db_path: str | Path | None = None) -> None:
        if db_path is None:
            from agent.config import DATA_DIR
            db_path = DATA_DIR / "tool_selection_memory.db"
        self._path = Path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        from agent.persistence.database import get_sync_connection
        self._conn = get_sync_connection(db_path=str(self._path))
        self._conn.row_factory = sqlite3.Row
        self._init_tables()
        self._cache: dict[str, ToolStats] = {}

    def _init_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS tool_stats (
                name TEXT PRIMARY KEY,
                call_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                total_duration_ms REAL NOT NULL DEFAULT 0.0,
                last_used_at REAL NOT NULL DEFAULT 0
            );
        """)
        self._conn.commit()

    def record(
        self,
        tool_name: str,
        success: bool,
        duration_ms: float = 0.0,
    ) -> None:
        now = time.time()
        cur = self._conn.execute(
            "SELECT call_count, success_count, total_duration_ms FROM tool_stats WHERE name = ?",
            (tool_name,),
        )
        row = cur.fetchone()
        if row:
            new_count = row[0] + 1
            new_success = row[1] + (1 if success else 0)
            new_duration = row[2] + duration_ms
            self._conn.execute(
                """UPDATE tool_stats
                   SET call_count=?, success_count=?, total_duration_ms=?, last_used_at=?
                   WHERE name=?""",
                (new_count, new_success, new_duration, now, tool_name),
            )
        else:
            self._conn.execute(
                """INSERT INTO tool_stats (name, call_count, success_count, total_duration_ms, last_used_at)
                   VALUES (?, 1, ?, ?, ?)""",
                (tool_name, 1 if success else 0, duration_ms, now),
            )
        self._conn.commit()

        if tool_name in self._cache:
            s = self._cache[tool_name]
            s.call_count += 1
            s.success_count += 1 if success else 0
            s.total_duration_ms += duration_ms
            s.last_used_at = now
        else:
            self._cache[tool_name] = ToolStats(
                name=tool_name,
                call_count=1,
                success_count=1 if success else 0,
                total_duration_ms=duration_ms,
                last_used_at=now,
            )

    def get_stats(self, tool_name: str) -> ToolStats | None:
        if tool_name in self._cache:
            return self._cache[tool_name]
        cur = self._conn.execute(
            "SELECT name, call_count, success_count, total_duration_ms, last_used_at FROM tool_stats WHERE name = ?",
            (tool_name,),
        )
        row = cur.fetchone()
        if row:
            stats = ToolStats(
                name=row[0], call_count=row[1], success_count=row[2],
                total_duration_ms=row[3], last_used_at=row[4],
            )
            self._cache[tool_name] = stats
            return stats
        return None

    def get_preferred_tools(self, limit: int = 5) -> list[str]:
        cur = self._conn.execute(
            """SELECT name FROM tool_stats
               WHERE call_count > 0
               ORDER BY success_count * 1.0 / call_count DESC, call_count DESC
               LIMIT ?""",
            (limit,),
        )
        return [row[0] for row in cur.fetchall()]

    def get_tools_for_task(self, task_keywords: list[str], limit: int = 5) -> list[str]:
        cur = self._conn.execute(
            """SELECT name FROM tool_stats
               WHERE call_count > 0
               ORDER BY last_used_at DESC, success_count * 1.0 / call_count DESC
               LIMIT ?""",
            (limit * 2,),
        )
        candidates = [row[0] for row in cur.fetchall()]
        scored: list[tuple[str, float]] = []
        for name in candidates:
            stats = self.get_stats(name)
            if stats is None:
                continue
            score = stats.success_rate * 0.7 + min(stats.call_count / 10.0, 1.0) * 0.3
            scored.append((name, score))
        scored.sort(key=lambda x: x[1], reverse=True)
        return [name for name, _ in scored[:limit]]

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
