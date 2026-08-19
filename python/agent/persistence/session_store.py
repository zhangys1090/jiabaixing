from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.persistence.database import get_sync_connection
from agent.core.logger import log_ignored
from agent.infrastructure.safe_json import safe_json_loads

# P1 修复：FTS5 中文分词 — jieba 可选加载，失败则回退空格分词
_jieba_available = False
try:
    import jieba
    _jieba_available = True
except ImportError:
    pass


@dataclass
class SessionMessage:
    role: str
    content: str
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Session:
    session_id: str
    user_id: str = "default"
    title: str = ""
    messages: list[SessionMessage] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SearchResult:
    session_id: str
    title: str
    snippet: str
    rank: float
    role: str
    timestamp: float


class SessionSearchEngine:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "session_search.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = get_sync_connection(db_path=str(self._path), check_same_thread=False)
        self._lock = __import__("threading").Lock()
        self._init_tables()

    def _init_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS messages_fts (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp REAL NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_index USING fts5(
                session_id,
                role,
                content,
                content=messages_fts,
                content_rowid=rowid
            );
            CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages_fts BEGIN
                INSERT INTO messages_index(rowid, session_id, role, content)
                VALUES (new.rowid, new.session_id, new.role, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages_fts BEGIN
                INSERT INTO messages_index(messages_index, rowid, session_id, role, content)
                VALUES ('delete', old.rowid, old.session_id, old.role, old.content);
            END;
            CREATE INDEX IF NOT EXISTS idx_msgs_session ON messages_fts(session_id);
        """)
        self._conn.commit()

    def index_message(self, session_id: str, role: str, content: str, timestamp: float) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO messages_fts (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                (session_id, role, content, timestamp),
            )
            self._conn.commit()

    def index_session_messages(self, session_id: str, messages: list[SessionMessage]) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM messages_fts WHERE session_id = ?", (session_id,))
            for msg in messages:
                self._conn.execute(
                    "INSERT INTO messages_fts (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                    (session_id, msg.role, msg.content, msg.timestamp),
                )
            self._conn.commit()

    def search(
        self,
        query: str,
        limit: int = 20,
        session_id: str | None = None,
        role_filter: str | None = None,
    ) -> list[SearchResult]:
        if not query.strip():
            return []

        fts_query = self._build_fts_query(query)
        results = self._execute_search(fts_query, limit, session_id, role_filter)

        if not results:
            fts_query = self._build_fts_query_fallback(query)
            if fts_query:
                results = self._execute_search(fts_query, limit, session_id, role_filter)

        if not results:
            results = self._search_like(query, limit, session_id, role_filter)

        return results

    def _execute_search(
        self,
        fts_query: str,
        limit: int,
        session_id: str | None,
        role_filter: str | None,
    ) -> list[SearchResult]:
        sql = """
            SELECT m.session_id, m.role, m.content, m.timestamp,
                   snippet(messages_index, 2, '<<', '>>', '...', 30) as snippet,
                   rank
            FROM messages_index
            JOIN messages_fts m ON messages_index.rowid = m.rowid
            WHERE messages_index MATCH ?
        """
        params: list[Any] = [fts_query]

        if session_id:
            sql += " AND m.session_id = ?"
            params.append(session_id)
        if role_filter:
            sql += " AND m.role = ?"
            params.append(role_filter)

        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        try:
            with self._lock:
                rows = self._conn.execute(sql, params).fetchall()
        except Exception:
            return []

        results = []
        for row in rows:
            session_title = self._get_session_title(row[0])
            results.append(SearchResult(
                session_id=row[0],
                title=session_title,
                snippet=row[4] or row[2][:100],
                rank=row[5],
                role=row[1],
                timestamp=row[3],
            ))
        return results

    def _search_like(
        self,
        query: str,
        limit: int,
        session_id: str | None,
        role_filter: str | None,
    ) -> list[SearchResult]:
        """LIKE 回退搜索，用于 FTS5 无结果时（如中文无分词器场景）。

        注意：LIKE '%query%' 为全表扫描，大数据量下性能较差。
        限制：查询长度不超过 100 字符，结果数不超过 limit（默认 20）。
        """
        if len(query) > 100:
            query = query[:100]
        effective_limit = min(limit, 50)
        sql = """
            SELECT session_id, role, content, timestamp
            FROM messages_fts
            WHERE content LIKE ?
        """
        params: list[Any] = [f"%{query}%"]

        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if role_filter:
            sql += " AND role = ?"
            params.append(role_filter)

        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(effective_limit)

        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        results = []
        for row in rows:
            session_title = self._get_session_title(row[0])
            results.append(SearchResult(
                session_id=row[0],
                title=session_title,
                snippet=row[2][:100],
                rank=0.0,
                role=row[1],
                timestamp=row[3],
            ))
        return results

    def search_sessions(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        results = self.search(query, limit=limit * 5)
        session_map: dict[str, dict[str, Any]] = {}
        for r in results:
            if r.session_id not in session_map:
                session_map[r.session_id] = {
                    "session_id": r.session_id,
                    "title": r.title,
                    "match_count": 0,
                    "best_rank": r.rank,
                    "snippets": [],
                }
            session_map[r.session_id]["match_count"] += 1
            session_map[r.session_id]["snippets"].append(r.snippet)
            if len(session_map) >= limit:
                break
        return sorted(session_map.values(), key=lambda x: x["best_rank"])

    def delete_session(self, session_id: str) -> int:
        with self._lock:
            cursor = self._conn.execute("DELETE FROM messages_fts WHERE session_id = ?", (session_id,))
            self._conn.commit()
            return cursor.rowcount

    def get_stats(self) -> dict[str, int]:
        with self._lock:
            count = self._conn.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0]
        return {"indexed_messages": count}

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    @staticmethod
    def _build_fts_query(query: str) -> str:
        # P1 修复：使用 jieba 中文分词，此前 split() 对中文整句只产生一个 token
        tokens: list[str] = []
        if _jieba_available:
            tokens = [t.strip() for t in jieba.cut(query) if t.strip() and len(t.strip()) > 0]
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
        """构建宽松的 FTS5 查询，用于前缀查询无结果时的回退。"""
        tokens = query.strip().split()
        escaped = [t.replace('"', '""') for t in tokens if t]
        if not escaped:
            return ""
        if len(escaped) == 1:
            return f'"{escaped[0]}"'
        return " AND ".join(f'"{t}"' for t in escaped)

    def _get_session_title(self, session_id: str) -> str:
        with self._lock:
            row = self._conn.execute(
                "SELECT content FROM messages_fts WHERE session_id = ? AND role = 'user' ORDER BY timestamp ASC LIMIT 1",
                (session_id,),
            ).fetchone()
        if row:
            return row[0][:50] + ("..." if len(row[0]) > 50 else "")
        return session_id


class SessionStore:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "sessions.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, Session] = {}
        self._search_engine: SessionSearchEngine | None = None
        self._search_index: Any = None
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        json_path = self._path.with_suffix(".json")
        if json_path.exists():
            try:
                data = safe_json_loads(
                    json_path.read_text(encoding="utf-8"), {}, context="session_store.load"
                )
                if not isinstance(data, dict):
                    # sessions.json 被覆盖为数组/标量（版本错配或外部工具写入）时，
                    # 旧代码会在 data.items() 抛 AttributeError 逃逸构造器 → SessionStore() 崩溃。
                    data = {}
                for sid, sdata in data.items():
                    if not isinstance(sdata, dict):
                        continue
                    msgs = [
                        SessionMessage(
                            role=m.get("role", ""),
                            content=m.get("content", ""),
                            timestamp=m.get("timestamp", 0.0),
                        )
                        for m in sdata.get("messages", [])
                    ]
                    self._sessions[sid] = Session(
                        session_id=sid,
                        user_id=sdata.get("user_id", "default"),
                        title=sdata.get("title", ""),
                        messages=msgs,
                        created_at=sdata.get("created_at", 0.0),
                        updated_at=sdata.get("updated_at", 0.0),
                        metadata=sdata.get("metadata", {}),
                    )
            except Exception as _exc:
                log_ignored(None, "session_store.SessionStore._load", _exc)

    def _save(self) -> None:
        json_path = self._path.with_suffix(".json")
        tmp_path = json_path.with_suffix(".json.tmp")
        data = {}
        for sid, session in self._sessions.items():
            data[sid] = {
                "user_id": session.user_id,
                "title": session.title,
                "messages": [
                    {"role": m.role, "content": m.content, "timestamp": m.timestamp}
                    for m in session.messages
                ],
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "metadata": session.metadata,
            }
        tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(json_path)

    def create_session(self, user_id: str = "default", title: str = "") -> Session:
        sid = str(uuid.uuid4())
        now = time.time()
        session = Session(
            session_id=sid,
            user_id=user_id,
            title=title or f"会话 {sid}",
            created_at=now,
            updated_at=now,
        )
        self._sessions[sid] = session
        with self._lock:
            self._save()
        return session

    def get_session(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    def list_sessions(self, user_id: str | None = None) -> list[Session]:
        sessions = list(self._sessions.values())
        if user_id:
            sessions = [s for s in sessions if s.user_id == user_id]
        return sorted(sessions, key=lambda s: s.updated_at, reverse=True)

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> bool:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return False
            now = time.time()
            session.messages.append(
                SessionMessage(role=role, content=content, timestamp=now)
            )
            session.updated_at = now
            self._save()
        if self._search_engine:
            self._search_engine.index_message(session_id, role, content, now)
        if self._search_index:
            self._search_index.index_message(session_id, role, content, now)
        return True

    def get_messages(
        self,
        session_id: str,
        limit: int | None = None,
    ) -> list[SessionMessage]:
        session = self._sessions.get(session_id)
        if not session:
            return []
        msgs = session.messages
        if limit:
            msgs = msgs[-limit:]
        return msgs

    def delete_session(self, session_id: str) -> bool:
        with self._lock:
            if session_id not in self._sessions:
                return False
            del self._sessions[session_id]
            self._save()
        if self._search_engine:
            self._search_engine.delete_session(session_id)
        if self._search_index:
            self._search_index.delete_session(session_id)
        return True

    def get_stats(self) -> dict[str, Any]:
        total_msgs = sum(len(s.messages) for s in self._sessions.values())
        stats: dict[str, Any] = {
            "total_sessions": len(self._sessions),
            "total_messages": total_msgs,
        }
        if self._search_engine:
            stats["search_engine"] = self._search_engine.get_stats()
        return stats

    def enable_search(self) -> None:
        if self._search_engine is None:
            self._search_engine = SessionSearchEngine()
            for sid, session in self._sessions.items():
                self._search_engine.index_session_messages(sid, session.messages)

    def set_search_index(self, index: Any) -> None:
        self._search_index = index

    def search(
        self,
        query: str,
        limit: int = 20,
        session_id: str | None = None,
        role_filter: str | None = None,
    ) -> list[SearchResult]:
        if not self._search_engine:
            self.enable_search()
        return self._search_engine.search(query, limit, session_id, role_filter)

    def search_sessions(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        if not self._search_engine:
            self.enable_search()
        return self._search_engine.search_sessions(query, limit)

    def get_metadata(self, key: str) -> Any:
        with self._lock:
            json_path = self._path.with_suffix(".meta.json")
            if not json_path.exists():
                return None
            try:
                data = json.loads(json_path.read_text(encoding="utf-8"))
                return data.get(key)
            except (json.JSONDecodeError, OSError):
                return None

    def set_metadata(self, key: str, value: Any) -> None:
        with self._lock:
            json_path = self._path.with_suffix(".meta.json")
            try:
                data = json.loads(json_path.read_text(encoding="utf-8")) if json_path.exists() else {}
            except (json.JSONDecodeError, OSError):
                data = {}
            data[key] = value
            tmp_path = json_path.with_suffix(".meta.json.tmp")
            tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(json_path)

    def close(self) -> None:
        self._save()
        if self._search_engine:
            self._search_engine.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
