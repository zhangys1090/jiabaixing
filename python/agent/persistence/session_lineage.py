"""会话血缘追踪模块。

管理会话之间的父子/兄弟关系，支持会话树的遍历与标签搜索。

使用 SQLite 存储血缘数据，独立于主会话存储。

Usage::

    from agent.persistence.session_lineage import SessionLineageTracker

    tracker = SessionLineageTracker()
    lineage = tracker.add_session("sess_1", parent_id="sess_0", summary="初始对话")
    ancestors = tracker.get_ancestors("sess_1")
    children = tracker.get_children("sess_0")
    tracker.close()
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.persistence.database import get_sync_connection


@dataclass
class SessionLineage:
    """会话血缘记录，描述一个会话在血缘树中的位置。

    Attributes:
        session_id: 会话唯一标识。
        parent_id: 父会话 ID，顶层会话为 None。
        child_ids: 子会话 ID 列表。
        created_at: 创建时间戳。
        summary: 会话摘要。
        tags: 语义标签列表。
    """

    session_id: str
    parent_id: str | None = None
    child_ids: list[str] = field(default_factory=list)
    created_at: float = 0.0
    summary: str = ""
    tags: list[str] = field(default_factory=list)


class SessionLineageTracker:
    """会话血缘追踪器，管理会话间的父子关系与标签。

    使用独立的 SQLite 数据库存储血缘数据，通过 parent_id 构建
    会话树结构，支持祖先链、子会话、兄弟会话的查询以及标签搜索。

    Usage::

        tracker = SessionLineageTracker()
        tracker.add_session("a", summary="根会话")
        tracker.add_session("b", parent_id="a", summary="子会话")
        ancestors = tracker.get_ancestors("b")  # [SessionLineage(session_id="a", ...)]
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "session_lineage.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = get_sync_connection(db_path=str(self._path), check_same_thread=False)
        self._init_tables()

    def _init_tables(self) -> None:
        """初始化血缘数据库表结构。"""
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS session_lineage (
                session_id TEXT PRIMARY KEY,
                parent_id TEXT,
                created_at REAL NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_lineage_parent
                ON session_lineage(parent_id);
        """)
        self._conn.commit()

    def add_session(
        self,
        session_id: str,
        parent_id: str | None = None,
        summary: str = "",
        tags: list[str] | None = None,
    ) -> SessionLineage:
        """记录新会话的血缘关系。

        Args:
            session_id: 会话唯一标识。
            parent_id: 父会话 ID，顶层会话为 None。
            summary: 会话摘要。
            tags: 语义标签列表。

        Returns:
            SessionLineage: 创建的血缘记录。

        Raises:
            ValueError: parent_id 指向不存在的会话时抛出。
        """
        if parent_id is not None:
            row = self._conn.execute(
                "SELECT 1 FROM session_lineage WHERE session_id = ?",
                (parent_id,),
            ).fetchone()
            if row is None:
                raise ValueError(f"父会话不存在: {parent_id}")

        now = time.time()
        tags_json = json.dumps(tags or [], ensure_ascii=False)
        self._conn.execute(
            "INSERT OR REPLACE INTO session_lineage (session_id, parent_id, created_at, summary, tags) "
            "VALUES (?, ?, ?, ?, ?)",
            (session_id, parent_id, now, summary, tags_json),
        )
        self._conn.commit()

        return SessionLineage(
            session_id=session_id,
            parent_id=parent_id,
            child_ids=self._get_child_ids(session_id),
            created_at=now,
            summary=summary,
            tags=tags or [],
        )

    def get_lineage(self, session_id: str) -> SessionLineage | None:
        """获取指定会话的血缘信息。

        Args:
            session_id: 会话唯一标识。

        Returns:
            SessionLineage | None: 血缘记录，不存在时返回 None。
        """
        row = self._conn.execute(
            "SELECT session_id, parent_id, created_at, summary, tags "
            "FROM session_lineage WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_lineage(row)

    def get_children(self, session_id: str) -> list[SessionLineage]:
        """获取指定会话的所有子会话。

        Args:
            session_id: 父会话唯一标识。

        Returns:
            list[SessionLineage]: 子会话血缘列表，按创建时间升序排列。
        """
        rows = self._conn.execute(
            "SELECT session_id, parent_id, created_at, summary, tags "
            "FROM session_lineage WHERE parent_id = ? ORDER BY created_at ASC",
            (session_id,),
        ).fetchall()
        return [self._row_to_lineage(r) for r in rows]

    def get_ancestors(self, session_id: str) -> list[SessionLineage]:
        """获取指定会话的祖先链（从父到根，按层级排列）。

        沿 parent_id 向上遍历直到根会话，返回路径上所有祖先。

        Args:
            session_id: 起始会话唯一标识。

        Returns:
            list[SessionLineage]: 祖先链列表，最近的父会话在前，根会话在末。
        """
        ancestors: list[SessionLineage] = []
        visited: set[str] = set()
        current_id = session_id

        while True:
            row = self._conn.execute(
                "SELECT session_id, parent_id, created_at, summary, tags "
                "FROM session_lineage WHERE session_id = ?",
                (current_id,),
            ).fetchone()
            if row is None or row[1] is None:
                break
            parent_id = row[1]
            if parent_id in visited:
                break
            visited.add(parent_id)
            parent_row = self._conn.execute(
                "SELECT session_id, parent_id, created_at, summary, tags "
                "FROM session_lineage WHERE session_id = ?",
                (parent_id,),
            ).fetchone()
            if parent_row is None:
                break
            ancestors.append(self._row_to_lineage(parent_row))
            current_id = parent_id

        return ancestors

    def get_siblings(self, session_id: str) -> list[SessionLineage]:
        """获取指定会话的兄弟会话（同一父会话下的其他子会话）。

        Args:
            session_id: 会话唯一标识。

        Returns:
            list[SessionLineage]: 兄弟会话列表（不含自身），按创建时间升序排列。
        """
        row = self._conn.execute(
            "SELECT parent_id FROM session_lineage WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None or row[0] is None:
            return []

        parent_id = row[0]
        siblings = self._conn.execute(
            "SELECT session_id, parent_id, created_at, summary, tags "
            "FROM session_lineage WHERE parent_id = ? AND session_id != ? "
            "ORDER BY created_at ASC",
            (parent_id, session_id),
        ).fetchall()
        return [self._row_to_lineage(r) for r in siblings]

    def add_tag(self, session_id: str, tag: str) -> bool:
        """为指定会话添加标签。

        若会话不存在或标签已存在则不做任何操作。

        Args:
            session_id: 会话唯一标识。
            tag: 要添加的标签。

        Returns:
            bool: 是否成功添加（True=新增标签，False=会话不存在或标签已存在）。
        """
        row = self._conn.execute(
            "SELECT tags FROM session_lineage WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            return False

        tags: list[str] = safe_json_loads(row[0], [], context="session_lineage.tags")
        if tag in tags:
            return False

        tags.append(tag)
        self._conn.execute(
            "UPDATE session_lineage SET tags = ? WHERE session_id = ?",
            (json.dumps(tags, ensure_ascii=False), session_id),
        )
        self._conn.commit()
        return True

    def search_by_tags(self, tags: list[str]) -> list[SessionLineage]:
        """按标签搜索会话，返回包含任一指定标签的会话。

        Args:
            tags: 标签列表，匹配任一标签即返回。

        Returns:
            list[SessionLineage]: 匹配的会话血缘列表，按创建时间降序排列。
        """
        if not tags:
            return []

        results: list[SessionLineage] = []
        rows = self._conn.execute(
            "SELECT session_id, parent_id, created_at, summary, tags "
            "FROM session_lineage ORDER BY created_at DESC"
        ).fetchall()

        for row in rows:
            lineage = self._row_to_lineage(row)
            if any(t in lineage.tags for t in tags):
                results.append(lineage)

        return results

    def delete_session(self, session_id: str) -> bool:
        """删除会话的血缘记录。

        删除后子会话的 parent_id 将被置为 NULL，变为根会话。

        Args:
            session_id: 要删除的会话唯一标识。

        Returns:
            bool: 是否成功删除。
        """
        row = self._conn.execute(
            "SELECT 1 FROM session_lineage WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            return False

        # 子会话的 parent_id 置为 NULL
        self._conn.execute(
            "UPDATE session_lineage SET parent_id = NULL WHERE parent_id = ?",
            (session_id,),
        )
        self._conn.execute(
            "DELETE FROM session_lineage WHERE session_id = ?",
            (session_id,),
        )
        self._conn.commit()
        return True

    def close(self) -> None:
        """关闭数据库连接。"""
        self._conn.close()

    def _get_child_ids(self, session_id: str) -> list[str]:
        """获取指定会话的直接子会话 ID 列表。

        Args:
            session_id: 父会话唯一标识。

        Returns:
            list[str]: 子会话 ID 列表。
        """
        rows = self._conn.execute(
            "SELECT session_id FROM session_lineage WHERE parent_id = ? "
            "ORDER BY created_at ASC",
            (session_id,),
        ).fetchall()
        return [r[0] for r in rows]

    def _row_to_lineage(self, row: tuple[Any, ...]) -> SessionLineage:
        """将数据库行转换为 SessionLineage 对象。

        Args:
            row: 数据库查询结果行。

        Returns:
            SessionLineage: 转换后的血缘对象。
        """
        session_id = row[0]
        return SessionLineage(
            session_id=session_id,
            parent_id=row[1],
            child_ids=self._get_child_ids(session_id),
            created_at=row[2],
            summary=row[3],
            tags=safe_json_loads(row[4], [], context="session_lineage.tags4"),
        )
