"""会话搜索索引模块。

在 FTS5 全文索引基础上提供增强搜索能力，包括时间范围过滤、
标签搜索、BM25 排序以及相关会话推荐。

与 SessionSearchEngine 共享 messages_fts/messages_index 表结构，
但扩展了时间范围和标签过滤能力，并集成 SessionLineageTracker
提供血缘感知的相关会话推荐。

Usage::

    from agent.persistence.session_search_index import SessionSearchIndex
    from agent.persistence.session_store import SessionStore

    store = SessionStore()
    index = SessionSearchIndex()
    index.build_index(store)
    results = index.search("Python 编程", limit=5, time_start=1700000000.0)
    related = index.get_related("sess_abc", limit=3)
    index.close()
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import StructuredLogger
from agent.persistence.database import get_sync_connection
from agent.persistence.session_lineage import SessionLineageTracker
from agent.persistence.session_store import Session, SessionStore

# jieba 可选加载
_jieba_available = False
try:
    import jieba
    _jieba_available = True
except ImportError:
    pass

log = StructuredLogger("session_search_index")


class SessionSearchIndex:
    """增强会话搜索索引，支持时间范围、标签过滤和相关会话推荐。

    基于 FTS5 的 BM25 排序，叠加时间范围过滤和标签匹配，
    并利用 SessionLineageTracker 提供血缘感知的会话推荐。

    Usage::

        index = SessionSearchIndex()
        index.build_index(session_store)
        results = index.search("测试", limit=10, tags=["unit-test"])
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "session_search_index.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = get_sync_connection(db_path=str(self._path), check_same_thread=False)
        self._lineage_tracker: SessionLineageTracker | None = None
        self._init_tables()

    def _init_tables(self) -> None:
        """初始化搜索索引表结构，包含消息内容和会话标签。"""
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS search_messages (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp REAL NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS search_messages_index USING fts5(
                session_id,
                role,
                content,
                content=search_messages,
                content_rowid=rowid
            );
            CREATE TRIGGER IF NOT EXISTS search_msgs_ai AFTER INSERT ON search_messages BEGIN
                INSERT INTO search_messages_index(rowid, session_id, role, content)
                VALUES (new.rowid, new.session_id, new.role, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS search_msgs_ad AFTER DELETE ON search_messages BEGIN
                INSERT INTO search_messages_index(search_messages_index, rowid, session_id, role, content)
                VALUES ('delete', old.rowid, old.session_id, old.role, old.content);
            END;
            CREATE INDEX IF NOT EXISTS idx_sm_session ON search_messages(session_id);
            CREATE INDEX IF NOT EXISTS idx_sm_timestamp ON search_messages(timestamp);

            CREATE TABLE IF NOT EXISTS session_tags (
                session_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (session_id, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_st_tag ON session_tags(tag);
        """)
        self._conn.commit()

    def set_lineage_tracker(self, tracker: SessionLineageTracker) -> None:
        """设置血缘追踪器，用于相关会话推荐。

        Args:
            tracker: SessionLineageTracker 实例。
        """
        self._lineage_tracker = tracker

    def build_index(self, session_store: SessionStore) -> int:
        """从现有会话存储构建搜索索引。

        清除已有索引数据后，重新导入所有会话消息。
        同时从 SessionLineageTracker 同步标签（如已设置）。

        Args:
            session_store: SessionStore 实例，包含所有会话数据。

        Returns:
            int: 索引的消息总数。
        """
        # 清除已有数据
        self._conn.execute("DELETE FROM search_messages")
        self._conn.execute("DELETE FROM session_tags")
        self._conn.commit()

        count = 0
        for session in session_store.list_sessions():
            sid = session.session_id
            for msg in session.messages:
                self._conn.execute(
                    "INSERT INTO search_messages (session_id, role, content, timestamp) "
                    "VALUES (?, ?, ?, ?)",
                    (sid, msg.role, msg.content, msg.timestamp),
                )
                count += 1

            # 同步血缘标签
            if self._lineage_tracker:
                lineage = self._lineage_tracker.get_lineage(sid)
                if lineage and lineage.tags:
                    for tag in lineage.tags:
                        self._conn.execute(
                            "INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)",
                            (sid, tag),
                        )

        self._conn.commit()
        log.info("Search index built", indexed_messages=count)
        return count

    def index_message(
        self,
        session_id: str,
        role: str,
        content: str,
        timestamp: float,
    ) -> None:
        """索引单条消息。

        Args:
            session_id: 会话唯一标识。
            role: 消息角色（user/assistant/system）。
            content: 消息内容。
            timestamp: 消息时间戳。
        """
        self._conn.execute(
            "INSERT INTO search_messages (session_id, role, content, timestamp) "
            "VALUES (?, ?, ?, ?)",
            (session_id, role, content, timestamp),
        )
        self._conn.commit()

    def index_session_tags(self, session_id: str, tags: list[str]) -> None:
        """索引会话标签。

        Args:
            session_id: 会话唯一标识。
            tags: 标签列表。
        """
        self._conn.execute(
            "DELETE FROM session_tags WHERE session_id = ?",
            (session_id,),
        )
        for tag in tags:
            self._conn.execute(
                "INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)",
                (session_id, tag),
            )
        self._conn.commit()

    def search(
        self,
        query: str,
        limit: int = 10,
        time_start: float | None = None,
        time_end: float | None = None,
        tags: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """增强搜索，支持时间范围和标签过滤，使用 BM25 排序。

        Args:
            query: 搜索关键词。
            limit: 返回结果数量上限。
            time_start: 起始时间戳（包含），None 表示不限。
            time_end: 结束时间戳（包含），None 表示不限。
            tags: 标签过滤列表，匹配任一标签即包含。

        Returns:
            list[dict[str, Any]]: 搜索结果列表，每项包含
                session_id, title, snippet, rank, role, timestamp。
        """
        if not query.strip():
            return []

        # 先按标签过滤会话
        tag_filtered_sessions: set[str] | None = None
        if tags:
            tag_filtered_sessions = self._get_sessions_by_tags(tags)
            if not tag_filtered_sessions:
                return []

        # FTS5 BM25 搜索
        fts_query = self._build_fts_query(query)
        results = self._execute_search(
            fts_query, limit, time_start, time_end, tag_filtered_sessions,
        )

        # 回退：宽松 FTS 查询
        if not results:
            fts_query = self._build_fts_query_fallback(query)
            if fts_query:
                results = self._execute_search(
                    fts_query, limit, time_start, time_end, tag_filtered_sessions,
                )

        # 最终回退：LIKE 搜索
        if not results:
            results = self._search_like(
                query, limit, time_start, time_end, tag_filtered_sessions,
            )

        return results

    def get_related(self, session_id: str, limit: int = 5) -> list[dict[str, Any]]:
        """获取与指定会话相关的会话推荐。

        相关性来源：
        1. 血缘关系（兄弟会话、子会话）
        2. 内容相似性（共享 FTS5 关键词）

        Args:
            session_id: 目标会话唯一标识。
            limit: 返回结果数量上限。

        Returns:
            list[dict[str, Any]]: 相关会话列表，每项包含
                session_id, title, relation_type, relevance。
        """
        related: list[dict[str, Any]] = []
        seen_ids: set[str] = {session_id}

        # 1. 血缘相关
        if self._lineage_tracker:
            # 兄弟会话
            siblings = self._lineage_tracker.get_siblings(session_id)
            for sib in siblings:
                if sib.session_id not in seen_ids:
                    seen_ids.add(sib.session_id)
                    related.append({
                        "session_id": sib.session_id,
                        "title": sib.summary or sib.session_id,
                        "relation_type": "sibling",
                        "relevance": 0.8,
                    })

            # 子会话
            children = self._lineage_tracker.get_children(session_id)
            for child in children:
                if child.session_id not in seen_ids:
                    seen_ids.add(child.session_id)
                    related.append({
                        "session_id": child.session_id,
                        "title": child.summary or child.session_id,
                        "relation_type": "child",
                        "relevance": 0.7,
                    })

            # 父会话
            lineage = self._lineage_tracker.get_lineage(session_id)
            if lineage and lineage.parent_id:
                parent = self._lineage_tracker.get_lineage(lineage.parent_id)
                if parent and parent.session_id not in seen_ids:
                    seen_ids.add(parent.session_id)
                    related.append({
                        "session_id": parent.session_id,
                        "title": parent.summary or parent.session_id,
                        "relation_type": "parent",
                        "relevance": 0.9,
                    })

        # 2. 内容相似：从目标会话提取关键词，搜索共享关键词的会话
        content_related = self._get_content_related(session_id, limit)
        for item in content_related:
            if item["session_id"] not in seen_ids:
                seen_ids.add(item["session_id"])
                related.append(item)

        related.sort(key=lambda x: x.get("relevance", 0.0), reverse=True)
        return related[:limit]

    def delete_session(self, session_id: str) -> int:
        """删除指定会话的所有索引数据。

        Args:
            session_id: 会话唯一标识。

        Returns:
            int: 删除的消息数量。
        """
        cursor = self._conn.execute(
            "DELETE FROM search_messages WHERE session_id = ?",
            (session_id,),
        )
        self._conn.execute(
            "DELETE FROM session_tags WHERE session_id = ?",
            (session_id,),
        )
        self._conn.commit()
        return cursor.rowcount

    def get_stats(self) -> dict[str, int]:
        """获取索引统计信息。

        Returns:
            dict[str, int]: 包含 indexed_messages 和 tagged_sessions 的统计。
        """
        msg_count = self._conn.execute(
            "SELECT COUNT(*) FROM search_messages"
        ).fetchone()[0]
        tag_count = self._conn.execute(
            "SELECT COUNT(DISTINCT session_id) FROM session_tags"
        ).fetchone()[0]
        return {"indexed_messages": msg_count, "tagged_sessions": tag_count}

    def close(self) -> None:
        """关闭数据库连接。"""
        self._conn.close()

    # ------------------------------------------------------------------
    # 内部方法
    # ------------------------------------------------------------------

    def _get_sessions_by_tags(self, tags: list[str]) -> set[str]:
        """获取包含任一指定标签的会话 ID 集合。

        Args:
            tags: 标签列表。

        Returns:
            set[str]: 匹配的会话 ID 集合。
        """
        if not tags:
            return set()

        placeholders = ",".join("?" for _ in tags)
        rows = self._conn.execute(
            f"SELECT DISTINCT session_id FROM session_tags WHERE tag IN ({placeholders})",
            tags,
        ).fetchall()
        return {r[0] for r in rows}

    def _execute_search(
        self,
        fts_query: str,
        limit: int,
        time_start: float | None,
        time_end: float | None,
        tag_filtered_sessions: set[str] | None,
    ) -> list[dict[str, Any]]:
        """执行 FTS5 搜索并应用过滤条件。

        Args:
            fts_query: FTS5 查询表达式。
            limit: 返回结果数量上限。
            time_start: 起始时间戳。
            time_end: 结束时间戳。
            tag_filtered_sessions: 标签过滤后的会话 ID 集合。

        Returns:
            list[dict[str, Any]]: 搜索结果列表。
        """
        sql = """
            SELECT m.session_id, m.role, m.content, m.timestamp,
                   snippet(search_messages_index, 2, '<<', '>>', '...', 30) as snippet,
                   rank
            FROM search_messages_index
            JOIN search_messages m ON search_messages_index.rowid = m.rowid
            WHERE search_messages_index MATCH ?
        """
        params: list[Any] = [fts_query]

        if time_start is not None:
            sql += " AND m.timestamp >= ?"
            params.append(time_start)
        if time_end is not None:
            sql += " AND m.timestamp <= ?"
            params.append(time_end)
        if tag_filtered_sessions is not None:
            placeholders = ",".join("?" for _ in tag_filtered_sessions)
            sql += f" AND m.session_id IN ({placeholders})"
            params.extend(tag_filtered_sessions)

        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        try:
            rows = self._conn.execute(sql, params).fetchall()
        except Exception:
            log.warning("FTS5 search failed", fts_query=fts_query)
            return []

        results = []
        for row in rows:
            session_title = self._get_session_title(row[0])
            results.append({
                "session_id": row[0],
                "title": session_title,
                "snippet": row[4] or row[2][:100],
                "rank": row[5],
                "role": row[1],
                "timestamp": row[3],
            })
        return results

    def _search_like(
        self,
        query: str,
        limit: int,
        time_start: float | None,
        time_end: float | None,
        tag_filtered_sessions: set[str] | None,
    ) -> list[dict[str, Any]]:
        """LIKE 回退搜索，用于 FTS5 无结果时。

        Args:
            query: 搜索关键词。
            limit: 返回结果数量上限。
            time_start: 起始时间戳。
            time_end: 结束时间戳。
            tag_filtered_sessions: 标签过滤后的会话 ID 集合。

        Returns:
            list[dict[str, Any]]: 搜索结果列表。
        """
        sql = """
            SELECT session_id, role, content, timestamp
            FROM search_messages
            WHERE content LIKE ?
        """
        params: list[Any] = [f"%{query}%"]

        if time_start is not None:
            sql += " AND timestamp >= ?"
            params.append(time_start)
        if time_end is not None:
            sql += " AND timestamp <= ?"
            params.append(time_end)
        if tag_filtered_sessions is not None:
            placeholders = ",".join("?" for _ in tag_filtered_sessions)
            sql += f" AND session_id IN ({placeholders})"
            params.extend(tag_filtered_sessions)

        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        rows = self._conn.execute(sql, params).fetchall()
        results = []
        for row in rows:
            session_title = self._get_session_title(row[0])
            results.append({
                "session_id": row[0],
                "title": session_title,
                "snippet": row[2][:100],
                "rank": 0.0,
                "role": row[1],
                "timestamp": row[3],
            })
        return results

    def _get_content_related(
        self, session_id: str, limit: int,
    ) -> list[dict[str, Any]]:
        """基于内容关键词获取相关会话。

        提取目标会话最近消息的关键词，搜索共享这些关键词的其他会话。

        Args:
            session_id: 目标会话唯一标识。
            limit: 返回结果数量上限。

        Returns:
            list[dict[str, Any]]: 相关会话列表。
        """
        # 获取目标会话的关键消息
        rows = self._conn.execute(
            "SELECT content FROM search_messages "
            "WHERE session_id = ? AND role = 'user' "
            "ORDER BY timestamp DESC LIMIT 3",
            (session_id,),
        ).fetchall()
        if not rows:
            return []

        # 使用最近消息作为搜索内容
        combined = " ".join(r[0][:100] for r in rows)
        results = self.search(combined, limit=limit)
        # 排除自身
        return [r for r in results if r["session_id"] != session_id]

    def _get_session_title(self, session_id: str) -> str:
        """获取会话标题（取第一条用户消息的前 50 字符）。

        Args:
            session_id: 会话唯一标识。

        Returns:
            str: 会话标题。
        """
        row = self._conn.execute(
            "SELECT content FROM search_messages "
            "WHERE session_id = ? AND role = 'user' "
            "ORDER BY timestamp ASC LIMIT 1",
            (session_id,),
        ).fetchone()
        if row:
            return row[0][:50] + ("..." if len(row[0]) > 50 else "")
        return session_id

    @staticmethod
    def _build_fts_query(query: str) -> str:
        """构建 FTS5 前缀查询，使用 jieba 中文分词。

        Args:
            query: 原始搜索词。

        Returns:
            str: FTS5 查询表达式。
        """
        tokens: list[str] = []
        if _jieba_available:
            tokens = [t.strip() for t in jieba.cut(query) if t.strip()]
        if not tokens:
            tokens = query.strip().split()

        escaped = [t.replace('"', '""') for t in tokens if t]
        if not escaped:
            return ""
        if len(escaped) == 1:
            return f"{escaped[0]}*"
        return " AND ".join(f"{t}*" for t in escaped)

    @staticmethod
    def _build_fts_query_fallback(query: str) -> str:
        """构建宽松的 FTS5 查询，用于前缀查询无结果时的回退。

        Args:
            query: 原始搜索词。

        Returns:
            str: FTS5 精确匹配查询表达式。
        """
        tokens = query.strip().split()
        escaped = [t.replace('"', '""') for t in tokens if t]
        if not escaped:
            return ""
        if len(escaped) == 1:
            return f'"{escaped[0]}"'
        return " AND ".join(f'"{t}"' for t in escaped)
