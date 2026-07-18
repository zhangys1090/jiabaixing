from __future__ import annotations

import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.persistence.database import get_sync_connection
from agent.memory.tokenizer import ChineseTokenizer


class SemanticSearchEngine:

    def __init__(self, llm=None) -> None:
        self._llm = llm
        self._embedding_cache: dict[str, list[float]] = {}

    async def get_embedding(self, text: str) -> list[float] | None:
        if text in self._embedding_cache:
            return self._embedding_cache[text]

        if not self._llm:
            return None

        try:
            if hasattr(self._llm, "embed"):
                embedding = await self._llm.embed(text)
                if embedding:
                    self._embedding_cache[text] = embedding
                    if len(self._embedding_cache) > 500:
                        oldest_key = next(iter(self._embedding_cache))
                        del self._embedding_cache[oldest_key]
                    return embedding
        except Exception:
            pass

        return None

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)


_semantic_engine: SemanticSearchEngine | None = None


def get_semantic_engine() -> SemanticSearchEngine:
    global _semantic_engine
    if _semantic_engine is None:
        _semantic_engine = SemanticSearchEngine()
    return _semantic_engine


def set_semantic_engine_llm(llm: Any) -> None:
    global _semantic_engine
    if _semantic_engine is None:
        _semantic_engine = SemanticSearchEngine(llm=llm)
    else:
        _semantic_engine._llm = llm


class MemoryStore:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "memory.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = get_sync_connection(db_path=str(self._path))
        self._conn.row_factory = sqlite3.Row
        self._init_tables()
        self._counts: dict[str, int] = self._compute_counts()

    def _init_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tokens TEXT NOT NULL DEFAULT '',
                memory_type TEXT NOT NULL DEFAULT 'short_term',
                scene TEXT NOT NULL DEFAULT '',
                emotion TEXT NOT NULL DEFAULT 'neutral',
                timestamp REAL NOT NULL DEFAULT 0,
                metadata TEXT NOT NULL DEFAULT '{}'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content,
                tokens,
                memory_type,
                scene,
                content='memories',
                content_rowid='rowid'
            );

            CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
            CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
        """)
        self._conn.commit()

    def _compute_counts(self) -> dict[str, int]:
        cur = self._conn.execute(
            "SELECT memory_type, COUNT(*) as cnt FROM memories GROUP BY memory_type"
        )
        counts: dict[str, int] = {"instant": 0, "short_term": 0, "long_term": 0}
        for row in cur:
            counts[row[0]] = row[1]
        return counts

    def store(
        self,
        content: str,
        memory_type: str = "short_term",
        scene: str = "",
        emotion: str = "neutral",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        import json

        mem_id = str(uuid.uuid4())
        tokens = ChineseTokenizer.tokenize(content)
        token_str = " ".join(tokens)
        ts = time.time()
        meta_json = json.dumps(metadata or {}, ensure_ascii=False)

        self._conn.execute(
            """INSERT INTO memories (id, content, tokens, memory_type, scene, emotion, timestamp, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (mem_id, content, token_str, memory_type, scene, emotion, ts, meta_json),
        )
        self._conn.execute(
            """INSERT INTO memories_fts (rowid, content, tokens, memory_type, scene)
               VALUES (last_insert_rowid(), ?, ?, ?, ?)""",
            (content, token_str, memory_type, scene),
        )
        self._conn.commit()
        self._counts[memory_type] = self._counts.get(memory_type, 0) + 1
        return mem_id

    def search(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.0,
        scene_filter: str | None = None,
        time_weight: float = 0.0,
        recent_hours: float = 0.0,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        import json

        query_tokens = ChineseTokenizer.tokenize_for_search(query)
        fts_query = " OR ".join(f'"{t}"' for t in query_tokens if len(t) > 1)
        # 空查询、纯单字 token 或通配符（如 "" / "*"）无法构成合法 FTS5 MATCH，
        # 直接返回空结果，避免触发 sqlite3.OperationalError（审计 M-01）
        if not fts_query:
            return []

        type_filter = ""
        params: list[Any] = [fts_query]
        if memory_type:
            type_filter = "AND m.memory_type = ?"
            params.append(memory_type)
        if scene_filter:
            type_filter += " AND m.scene = ?"
            params.append(scene_filter)
        if recent_hours > 0:
            cutoff = time.time() - recent_hours * 3600
            type_filter += " AND m.timestamp >= ?"
            params.append(cutoff)
        params.append(limit)

        sql = f"""
            SELECT m.id, m.content, m.memory_type, m.scene, m.emotion,
                   m.timestamp, m.metadata, f.rank as score
            FROM memories_fts f
            JOIN memories m ON m.rowid = f.rowid
            WHERE memories_fts MATCH ? {type_filter}
            ORDER BY f.rank
            LIMIT ?
        """
        cur = self._conn.execute(sql, params)

        items: list[dict[str, Any]] = []
        now = time.time()
        for row in cur:
            score = row["score"]
            relevance = min(1.0, max(0.0, 1.0 + score / 10.0))
            if relevance < min_relevance:
                continue

            if time_weight > 0:
                age_hours = (now - row["timestamp"]) / 3600
                recency_bonus = max(0.0, 1.0 - age_hours / 168) * time_weight
                relevance = min(1.0, relevance * (1 - time_weight) + recency_bonus)

            meta = {}
            try:
                meta = json.loads(row["metadata"])
            except (json.JSONDecodeError, TypeError):
                pass

            if user_id and meta.get("user_id") != user_id:
                continue

            items.append({
                "id": row["id"],
                "content": row["content"],
                "memory_type": row["memory_type"],
                "scene": row["scene"],
                "emotion": row["emotion"],
                "timestamp": row["timestamp"],
                "relevance_score": round(relevance, 4),
                "metadata": meta,
            })

        items.sort(key=lambda x: x["relevance_score"], reverse=True)
        return items[:limit]

    def search_semantic(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.7,
    ) -> list[dict[str, Any]]:
        import json as _json

        query_tokens = set(ChineseTokenizer.tokenize_for_search(query))
        if not query_tokens:
            return []

        query_keywords = set(ChineseTokenizer.extract_tags(query, top_k=15))

        sql = """
            SELECT id, content, tokens, memory_type, scene, emotion, timestamp, metadata
            FROM memories
        """
        conditions = []
        params: list[Any] = []
        if memory_type:
            conditions.append("memory_type = ?")
            params.append(memory_type)

        if conditions:
            sql += " WHERE " + " AND ".join(conditions)

        cur = self._conn.execute(sql, params)
        scored_items: list[tuple[dict[str, Any], float]] = []
        now = time.time()

        for row in cur:
            mem_tokens_str = row[2]
            try:
                mem_tokens = set(mem_tokens_str.split())
            except Exception:
                mem_tokens = set()

            if not mem_tokens:
                continue

            overlap = len(query_tokens & mem_tokens)
            keyword_overlap = 0
            for kw in query_keywords:
                content_lower = row[1].lower()
                if kw.lower() in content_lower:
                    keyword_overlap += 2

            total_score = overlap + keyword_overlap
            if total_score == 0:
                continue

            jaccard = overlap / len(query_tokens | mem_tokens) if (query_tokens | mem_tokens) else 0
            # P2-1优化: 提高combined分数计算,增加精确匹配权重
            combined = jaccard * 0.5 + min(1.0, total_score / 6) * 0.5

            age_hours = (now - row[6]) / 3600 if row[6] > 0 else 1000
            recency_factor = max(0.3, 1.0 - age_hours / 720)
            final_score = combined * recency_factor

            if final_score < min_relevance:
                continue

            meta = {}
            try:
                meta = _json.loads(row[7])
            except (_json.JSONDecodeError, TypeError):
                pass

            scored_items.append(({
                "id": row[0],
                "content": row[1],
                "memory_type": row[3],
                "scene": row[4],
                "emotion": row[5],
                "timestamp": row[6],
                "relevance_score": round(final_score, 4),
                "metadata": meta,
            }, final_score))

        scored_items.sort(key=lambda x: x[1], reverse=True)
        return [item[0] for item in scored_items[:limit]]

    async def search_semantic_async(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.7,
    ) -> list[dict[str, Any]]:
        """异步语义搜索: 优先使用向量嵌入，回退到增强关键词搜索。"""
        engine = get_semantic_engine()
        query_embedding = await engine.get_embedding(query)

        if query_embedding is not None:
            return await self._search_by_embedding(
                query_embedding, query, limit, memory_type, min_relevance,
            )

        return self._search_enhanced_keyword(query, limit, memory_type, min_relevance)

    async def _search_by_embedding(
        self,
        query_embedding: list[float],
        query: str,
        limit: int,
        memory_type: str | None,
        min_relevance: float,
    ) -> list[dict[str, Any]]:
        """使用向量嵌入进行真正的语义搜索。"""
        import json as _json

        engine = get_semantic_engine()

        sql = """
            SELECT id, content, tokens, memory_type, scene, emotion, timestamp, metadata
            FROM memories
        """
        conditions = []
        params: list[Any] = []
        if memory_type:
            conditions.append("memory_type = ?")
            params.append(memory_type)

        if conditions:
            sql += " WHERE " + " AND ".join(conditions)

        cur = self._conn.execute(sql, params)
        scored_items: list[tuple[dict[str, Any], float]] = []
        now = time.time()

        for row in cur:
            content = row[1]
            mem_embedding = await engine.get_embedding(content)

            if mem_embedding is not None:
                similarity = engine.cosine_similarity(query_embedding, mem_embedding)
            else:
                query_tokens = set(ChineseTokenizer.tokenize_for_search(query))
                mem_tokens = set(row[2].split()) if row[2] else set()
                if not mem_tokens:
                    continue
                overlap = len(query_tokens & mem_tokens)
                jaccard = overlap / len(query_tokens | mem_tokens) if (query_tokens | mem_tokens) else 0
                similarity = jaccard * 0.6

            age_hours = (now - row[6]) / 3600 if row[6] > 0 else 1000
            recency_factor = max(0.2, 1.0 - age_hours / 720)
            final_score = similarity * recency_factor

            if final_score < min_relevance:
                continue

            meta = {}
            try:
                meta = _json.loads(row[7])
            except (_json.JSONDecodeError, TypeError):
                pass

            scored_items.append(({
                "id": row[0],
                "content": content,
                "memory_type": row[3],
                "scene": row[4],
                "emotion": row[5],
                "timestamp": row[6],
                "relevance_score": round(final_score, 4),
                "metadata": meta,
                "search_method": "embedding" if mem_embedding else "keyword_fallback",
            }, final_score))

        scored_items.sort(key=lambda x: x[1], reverse=True)
        return [item[0] for item in scored_items[:limit]]

    def _search_enhanced_keyword(
        self,
        query: str,
        limit: int,
        memory_type: str | None,
        min_relevance: float,
    ) -> list[dict[str, Any]]:
        """增强的关键词搜索: 使用 FTS5 全文检索 + 关键词加权。"""
        import json as _json

        query_tokens = set(ChineseTokenizer.tokenize_for_search(query))
        if not query_tokens:
            return []

        query_keywords = set(ChineseTokenizer.extract_tags(query, top_k=15))

        fts_query = " OR ".join(query_tokens)
        sql = """
            SELECT m.id, m.content, m.tokens, m.memory_type, m.scene, m.emotion, m.timestamp, m.metadata
            FROM memories m
            WHERE m.id IN (
                SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
            )
        """
        params: list[Any] = [fts_query]

        if memory_type:
            sql += " AND m.memory_type = ?"
            params.append(memory_type)

        try:
            cur = self._conn.execute(sql, params)
        except Exception:
            return self.search_semantic(query, limit, memory_type, min_relevance)

        scored_items: list[tuple[dict[str, Any], float]] = []
        now = time.time()

        for row in cur:
            mem_tokens = set(row[2].split()) if row[2] else set()
            if not mem_tokens:
                continue

            overlap = len(query_tokens & mem_tokens)
            keyword_overlap = sum(
                2 for kw in query_keywords if kw.lower() in row[1].lower()
            )

            total_score = overlap + keyword_overlap
            if total_score == 0:
                continue

            jaccard = overlap / len(query_tokens | mem_tokens) if (query_tokens | mem_tokens) else 0
            # P2-1优化: 提高combined分数计算,增加精确匹配权重
            combined = jaccard * 0.5 + min(1.0, total_score / 6) * 0.5

            age_hours = (now - row[6]) / 3600 if row[6] > 0 else 1000
            recency_factor = max(0.3, 1.0 - age_hours / 720)
            final_score = combined * recency_factor

            if final_score < min_relevance:
                continue

            meta = {}
            try:
                meta = _json.loads(row[7])
            except (_json.JSONDecodeError, TypeError):
                pass

            scored_items.append(({
                "id": row[0],
                "content": row[1],
                "memory_type": row[3],
                "scene": row[4],
                "emotion": row[5],
                "timestamp": row[6],
                "relevance_score": round(final_score, 4),
                "metadata": meta,
                "search_method": "enhanced_keyword",
            }, final_score))

        scored_items.sort(key=lambda x: x[1], reverse=True)
        return [item[0] for item in scored_items[:limit]]

    def get_recent(
        self,
        hours: float = 24.0,
        memory_type: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        import json as _json

        cutoff = time.time() - hours * 3600
        params: list[Any] = [cutoff]
        type_sql = ""
        if memory_type:
            type_sql = " AND memory_type = ?"
            params.append(memory_type)
        params.append(limit)

        cur = self._conn.execute(
            f"SELECT id, content, memory_type, scene, emotion, timestamp, metadata "
            f"FROM memories WHERE timestamp >= ?{type_sql} "
            f"ORDER BY timestamp DESC LIMIT ?",
            params,
        )

        items: list[dict[str, Any]] = []
        for row in cur:
            meta = {}
            try:
                meta = _json.loads(row[6])
            except (_json.JSONDecodeError, TypeError):
                pass
            items.append({
                "id": row[0],
                "content": row[1],
                "memory_type": row[2],
                "scene": row[3],
                "emotion": row[4],
                "timestamp": row[5],
                "metadata": meta,
            })
        return items

    def get_stats(self) -> dict[str, Any]:
        total = self._conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        return {
            "total_entries": total,
            "short_term_count": self._counts.get("short_term", 0),
            "long_term_count": self._counts.get("long_term", 0),
            "instant_count": self._counts.get("instant", 0),
        }

    def delete_by_type(self, memory_type: str) -> int:
        rows = self._conn.execute(
            "SELECT rowid FROM memories WHERE memory_type = ?", (memory_type,)
        ).fetchall()
        if not rows:
            return 0
        rowids = [r[0] for r in rows]
        self._conn.execute("DELETE FROM memories WHERE memory_type = ?", (memory_type,))
        placeholders = ",".join("?" * len(rowids))
        self._conn.execute(
            f"DELETE FROM memories_fts WHERE rowid IN ({placeholders})", rowids
        )
        self._conn.commit()
        self._counts[memory_type] = 0
        return len(rowids)

    def update(
        self,
        memory_id: str,
        content: str | None = None,
        scene: str | None = None,
        emotion: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        import json

        row = self._conn.execute(
            "SELECT id FROM memories WHERE id = ?", (memory_id,)
        ).fetchone()
        if not row:
            return False

        sets: list[str] = []
        params: list[Any] = []
        if content is not None:
            sets.append("content = ?")
            params.append(content)
            tokens = ChineseTokenizer.tokenize(content)
            sets.append("tokens = ?")
            params.append(" ".join(tokens))
        if scene is not None:
            sets.append("scene = ?")
            params.append(scene)
        if emotion is not None:
            sets.append("emotion = ?")
            params.append(emotion)
        if metadata is not None:
            sets.append("metadata = ?")
            params.append(json.dumps(metadata, ensure_ascii=False))

        if not sets:
            return True

        params.append(memory_id)
        self._conn.execute(
            f"UPDATE memories SET {', '.join(sets)} WHERE id = ?", params
        )
        self._conn.commit()

        if content is not None or scene is not None:
            fts_row = self._conn.execute(
                "SELECT rowid FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
            if fts_row:
                current = self._conn.execute(
                    "SELECT content, tokens, memory_type, scene FROM memories WHERE id = ?",
                    (memory_id,),
                ).fetchone()
                if current:
                    self._conn.execute(
                        "UPDATE memories_fts SET content=?, tokens=?, memory_type=?, scene=? WHERE rowid=?",
                        (current[0], current[1], current[2], current[3], fts_row[0]),
                    )
                    self._conn.commit()
        return True

    def close(self) -> None:
        self._conn.close()
