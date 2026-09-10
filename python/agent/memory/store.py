from __future__ import annotations

import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.persistence.database import get_sync_connection
from agent.memory.tokenizer import ChineseTokenizer
from agent.memory.vector_store import VectorStore

log = StructuredLogger("memory_store")


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
        except Exception as _exc:
            log.debug("store 异常处理", error=str(_exc))
            log_ignored(log, "store.SemanticSearchEngine.get_embedding", _exc)

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
    """记忆存储，基于 SQLite FTS5 + 可选 ChromaDB 向量存储的混合检索引擎。

    Attributes:
        _path: SQLite 数据库文件路径。
        _conn: SQLite 连接实例。
        _vector_store: ChromaDB 向量存储实例（可选）。
        _counts: 各类型记忆的计数缓存。
    """

    def __init__(
        self,
        db_path: str | Path | None = None,
        vector_store: VectorStore | None = None,
    ) -> None:
        """初始化记忆存储。

        Args:
            db_path: SQLite 数据库路径，默认使用 DATA_DIR/memory.db。
            vector_store: 可选的 VectorStore 实例，提供向量检索能力。
                若不传入且环境变量 VECTOR_STORE_DIR 已设置，则自动初始化。
        """
        self._path = Path(db_path) if db_path else DATA_DIR / "memory.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = get_sync_connection(db_path=str(self._path))
        self._conn.row_factory = sqlite3.Row
        self._init_tables()
        self._counts: dict[str, int] = self._compute_counts()

        # 向量存储：显式传入优先，否则按环境变量自动初始化
        # P0-3 增强：当 VECTOR_STORE_DIR 未设置但 ChromaDB 可用时，
        # 自动使用 DATA_DIR 下的 vector_store 子目录，使向量检索默认启用。
        self._vector_store: VectorStore | None = vector_store
        if self._vector_store is None:
            vs_dir = os.getenv("VECTOR_STORE_DIR")
            if not vs_dir:
                if VectorStore._chromadb_available_static():
                    vs_dir = str(DATA_DIR / "vector_store")
                    log.info(
                        "P0-3: VECTOR_STORE_DIR 未设置，ChromaDB 可用，自动启用向量存储",
                        auto_dir=vs_dir,
                    )
            if vs_dir:
                self._vector_store = VectorStore(persist_dir=vs_dir)

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

        # 同步写入向量存储（异步方法在同步上下文中用 fire-and-forget）
        if self._vector_store and self._vector_store.is_available():
            try:
                import asyncio
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # 已在异步上下文中，创建 Task fire-and-forget
                    loop.create_task(
                        self._vector_store.add(
                            ids=[mem_id], documents=[content],
                            metadatas=[{"memory_type": memory_type, "scene": scene, "emotion": emotion}],
                        )
                    )
                else:
                    loop.run_until_complete(
                        self._vector_store.add(
                            ids=[mem_id], documents=[content],
                            metadatas=[{"memory_type": memory_type, "scene": scene, "emotion": emotion}],
                        )
                    )
            except Exception as exc:
                log.debug("向量存储同步写入失败（不影响主流程）", error=str(exc))

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

        # P0-3 增强：当向量存储可用时，自动升级为混合检索（FTS5 + 向量 RRF 融合），
        # 将 O(N) 全表扫描升级为 O(log N) 向量近似最近邻 + FTS5 精确匹配。
        if self._vector_store and self._vector_store.is_available():
            try:
                import asyncio
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    import concurrent.futures
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                        future = pool.submit(
                            asyncio.run,
                            self.search_hybrid(
                                query, limit=limit, memory_type=memory_type,
                                min_relevance=min_relevance, scene_filter=scene_filter,
                                time_weight=time_weight, recent_hours=recent_hours,
                                user_id=user_id,
                            ),
                        )
                        return future.result(timeout=5.0)
                else:
                    return loop.run_until_complete(
                        self.search_hybrid(
                            query, limit=limit, memory_type=memory_type,
                            min_relevance=min_relevance, scene_filter=scene_filter,
                            time_weight=time_weight, recent_hours=recent_hours,
                            user_id=user_id,
                        ),
                    )
            except Exception as exc:
                log.debug("P0-3: 混合检索失败，回退到纯 FTS5", error=str(exc))

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
            except (json.JSONDecodeError, TypeError) as _exc:
                log_ignored(log, "store.MemoryStore.search", _exc)

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

    async def search_hybrid(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.0,
        scene_filter: str | None = None,
        time_weight: float = 0.0,
        recent_hours: float = 0.0,
        user_id: str | None = None,
        rrf_k: int = 60,
    ) -> list[dict[str, Any]]:
        """混合检索：FTS5 全文搜索 + ChromaDB 向量检索，RRF 融合排序。

        当 VectorStore 不可用时，回退到纯 FTS5 搜索（等同 search 方法）。

        Args:
            query: 搜索查询文本。
            limit: 最大返回数量。
            memory_type: 记忆类型过滤。
            min_relevance: 最小相关度阈值。
            scene_filter: 场景过滤。
            time_weight: 时间权重。
            recent_hours: 仅搜索最近 N 小时。
            user_id: 用户 ID 过滤。
            rrf_k: RRF 平滑常数，默认 60。

        Returns:
            按混合相关性排序的记忆列表。
        """
        fts_results = self.search(
            query, limit=limit * 2, memory_type=memory_type,
            min_relevance=min_relevance, scene_filter=scene_filter,
            time_weight=time_weight, recent_hours=recent_hours,
            user_id=user_id,
        )

        if self._vector_store and self._vector_store.is_available():
            return await self._vector_store.hybrid_search(
                query=query,
                fts_results=fts_results,
                n_results=limit,
                rrf_k=rrf_k,
            )

        return fts_results[:limit]

    def search_semantic(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.7,
        scene_filter: str | None = None,
        recent_hours: float = 0.0,
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
        if scene_filter:
            conditions.append("scene = ?")
            params.append(scene_filter)
        if recent_hours and recent_hours > 0:
            conditions.append("timestamp >= ?")
            params.append(time.time() - recent_hours * 3600)

        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        # P1-5（审计 §3.2）：避免对 memories 全表做 Python 端 O(N) 打分扫描。
        # 先以 LIMIT 限定候选集上限（limit*5，封顶 1000），再在内存中排序取前 limit。
        cap = int(min(limit * 5, 1000)) if limit and limit > 0 else 1000
        sql += " LIMIT ?"
        params.append(cap)

        cur = self._conn.execute(sql, params)
        scored_items: list[tuple[dict[str, Any], float]] = []
        now = time.time()

        for row in cur:
            mem_tokens_str = row[2]
            try:
                mem_tokens = set(mem_tokens_str.split())
            except Exception as _exc:
                log.debug("store 异常处理", error=str(_exc))
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
            except (_json.JSONDecodeError, TypeError) as _exc:
                log_ignored(log, "store.MemoryStore.search_semantic", _exc)

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
        scene_filter: str | None = None,
        recent_hours: float = 0.0,
    ) -> list[dict[str, Any]]:
        """异步语义搜索: 优先使用向量嵌入，回退到增强关键词搜索。"""
        engine = get_semantic_engine()
        query_embedding = await engine.get_embedding(query)

        if query_embedding is not None:
            return await self._search_by_embedding(
                query_embedding, query, limit, memory_type, min_relevance,
                scene_filter=scene_filter, recent_hours=recent_hours,
            )

        return self._search_enhanced_keyword(
            query, limit, memory_type, min_relevance,
            scene_filter=scene_filter, recent_hours=recent_hours,
        )

    async def _search_by_embedding(
        self,
        query_embedding: list[float],
        query: str,
        limit: int,
        memory_type: str | None,
        min_relevance: float,
        scene_filter: str | None = None,
        recent_hours: float = 0.0,
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
        if scene_filter:
            conditions.append("scene = ?")
            params.append(scene_filter)
        if recent_hours and recent_hours > 0:
            conditions.append("timestamp >= ?")
            params.append(time.time() - recent_hours * 3600)

        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        # P1-5（审计 §3.2）：embedding 检索原先对全表逐行算向量相似度（O(N) 且每行一次嵌入调用），
        # 必须先以 LIMIT 限定候选集上限（limit*5，封顶 1000），避免对大表做全量嵌入。
        cap = int(min(limit * 5, 1000)) if limit and limit > 0 else 1000
        sql += " LIMIT ?"
        params.append(cap)

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
            except (_json.JSONDecodeError, TypeError) as _exc:
                log_ignored(log, "store.MemoryStore._search_by_embedding", _exc)

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
        scene_filter: str | None = None,
        recent_hours: float = 0.0,
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
        # 与 search_semantic / _search_by_embedding 保持同一套预筛语义，
        # 否则「回退到关键词搜索」会静默丢掉调用方指定的过滤条件。
        if scene_filter:
            sql += " AND m.scene = ?"
            params.append(scene_filter)
        if recent_hours and recent_hours > 0:
            sql += " AND m.timestamp >= ?"
            params.append(time.time() - recent_hours * 3600)

        try:
            cur = self._conn.execute(sql, params)
        except Exception as _exc:
            log.debug("store 异常处理", error=str(_exc))
            return self.search_semantic(
                query, limit, memory_type, min_relevance,
                scene_filter=scene_filter, recent_hours=recent_hours,
            )

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
            except (_json.JSONDecodeError, TypeError) as _exc:
                log_ignored(log, "store.MemoryStore._search_enhanced_keyword", _exc)

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
            except (_json.JSONDecodeError, TypeError) as _exc:
                log_ignored(log, "store.MemoryStore.get_recent", _exc)
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

    def delete_by_id(self, memory_id: str) -> bool:
        """删除指定 ID 的记忆条目。用于批量操作回滚。"""
        row = self._conn.execute(
            "SELECT rowid FROM memories WHERE id = ?", (memory_id,)
        ).fetchone()
        if not row:
            return False
        self._conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        self._conn.execute("DELETE FROM memories_fts WHERE rowid = ?", (row[0],))
        self._conn.commit()
        return True

    def update(
        self,
        memory_id: str,
        content: str | None = None,
        scene: str | None = None,
        emotion: str | None = None,
        metadata: dict[str, Any] | None = None,
        expected_version: int | None = None,
    ) -> bool:
        """更新记忆条目。支持乐观锁版本检查（审计 P1-3：外部漂移保护）。

        Args:
            memory_id: 记忆 ID。
            content: 新内容（可选）。
            scene: 新场景（可选）。
            emotion: 新情绪（可选）。
            metadata: 新元数据（可选）。
            expected_version: 期望的版本号，不匹配则拒绝更新。

        Returns:
            是否更新成功。
        """
        import json

        row = self._conn.execute(
            "SELECT id, metadata FROM memories WHERE id = ?", (memory_id,)
        ).fetchone()
        if not row:
            return False

        # ─── 审计 P1-3：外部漂移保护 — 乐观锁版本检查 ───
        if expected_version is not None:
            current_meta = row["metadata"]
            try:
                current_meta_dict = json.loads(current_meta) if current_meta else {}
            except (json.JSONDecodeError, TypeError):
                current_meta_dict = {}
            current_version = current_meta_dict.get("_version", 0)
            if current_version != expected_version:
                log.warning(
                    "外部漂移检测：版本不匹配，更新被拒绝",
                    memory_id=memory_id,
                    expected=expected_version,
                    actual=current_version,
                )
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
            # 递增版本号
            import copy
            meta_copy = copy.deepcopy(metadata)
            meta_copy["_version"] = meta_copy.get("_version", 0) + 1
            sets.append("metadata = ?")
            params.append(json.dumps(meta_copy, ensure_ascii=False))

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

    # ═══════════════════════════════════════════════════════════
    # P2-8: 记忆整理质量驱动
    # ═══════════════════════════════════════════════════════════

    def consolidate_by_quality(
        self,
        quality_threshold: float = 0.6,
        max_consolidation: int = 50,
    ) -> dict[str, Any]:
        """P2-8: 质量驱动记忆整理 — 低质量记忆降级/合并，高质量记忆升级。

        整理策略：
        1. 识别低质量短期记忆（访问次数少 + 时效过期）→ 删除
        2. 识别高质量短期记忆（访问次数多 + 近期活跃）→ 升级为长期记忆
        3. 合并内容高度相似的重复记忆

        Args:
            quality_threshold: 质量阈值，低于此值的记忆被标记为低质量。
            max_consolidation: 单次整理最大处理条目数。

        Returns:
            整理报告 {deleted, promoted, merged, skipped}.
        """
        import json

        report: dict[str, Any] = {
            "deleted": 0,
            "promoted": 0,
            "merged": 0,
            "skipped": 0,
        }

        now = time.time()
        short_term_max_age = 3600.0 * 24 * 7  # 7 天
        min_access_count = 2

        # ─── 阶段 1: 低质量短期记忆清理 ───
        rows = self._conn.execute(
            """SELECT id, content, memory_type, timestamp, metadata
               FROM memories
               WHERE memory_type = 'short_term'
               ORDER BY timestamp ASC
               LIMIT ?""",
            (max_consolidation,),
        ).fetchall()

        for row in rows:
            mem_id = row["id"]
            ts = row["timestamp"] or 0
            meta_raw = row["metadata"] or "{}"

            try:
                meta = json.loads(meta_raw) if isinstance(meta_raw, str) else {}
            except (json.JSONDecodeError, TypeError):
                meta = {}

            access_count = meta.get("access_count", 0)
            age = now - ts

            # 低质量判定：过期 + 低访问
            if age > short_term_max_age and access_count < min_access_count:
                quality_score = self._estimate_memory_quality(
                    content=row["content"],
                    access_count=access_count,
                    age=age,
                )
                if quality_score < quality_threshold:
                    if self.delete_by_id(mem_id):
                        report["deleted"] += 1
                        log.info(
                            "P2-8: 低质量记忆已删除",
                            memory_id=mem_id,
                            quality=quality_score,
                            age_days=age / 86400,
                        )
                    continue

            report["skipped"] += 1

        # ─── 阶段 2: 高质量短期记忆升级为长期记忆 ───
        rows = self._conn.execute(
            """SELECT id, content, memory_type, timestamp, metadata
               FROM memories
               WHERE memory_type = 'short_term'
               ORDER BY timestamp DESC
               LIMIT ?""",
            (max_consolidation,),
        ).fetchall()

        for row in rows:
            meta_raw = row["metadata"] or "{}"
            try:
                meta = json.loads(meta_raw) if isinstance(meta_raw, str) else {}
            except (json.JSONDecodeError, TypeError):
                meta = {}

            access_count = meta.get("access_count", 0)
            age = now - (row["timestamp"] or 0)

            quality_score = self._estimate_memory_quality(
                content=row["content"],
                access_count=access_count,
                age=age,
            )

            # 高质量判定：高频访问 + 质量分高
            if quality_score >= 0.8 and access_count >= 3:
                self._conn.execute(
                    "UPDATE memories SET memory_type = 'long_term' WHERE id = ?",
                    (row["id"],),
                )
                report["promoted"] += 1
                log.info(
                    "P2-8: 高质量记忆升级为长期记忆",
                    memory_id=row["id"],
                    quality=quality_score,
                    access_count=access_count,
                )

        self._conn.commit()

        # ─── 阶段 3: 相似记忆合并 ───
        report["merged"] = self._merge_similar_memories(max_merge=max_consolidation // 5)

        log.info(
            "P2-8: 记忆整理完成",
            deleted=report["deleted"],
            promoted=report["promoted"],
            merged=report["merged"],
            skipped=report["skipped"],
        )

        self._counts = self._compute_counts()
        return report

    def _estimate_memory_quality(
        self,
        content: str,
        access_count: int,
        age: float,
    ) -> float:
        """P2-8: 估算记忆质量分。

        质量分 = 内容丰富度 × 访问频率因子 × 时效因子

        Args:
            content: 记忆内容.
            access_count: 访问次数.
            age: 记忆年龄（秒）.

        Returns:
            质量分 0.0 ~ 1.0.
        """
        # 内容丰富度：基于长度和信息密度
        content_richness = min(1.0, len(content) / 200.0) if content else 0.0

        # 访问频率因子：访问越多质量越高
        access_factor = min(1.0, access_count / 5.0)

        # 时效因子：越新质量越高（7 天半衰期）
        recency_factor = max(0.1, 0.5 ** (age / (3600.0 * 24 * 7)))

        quality = content_richness * 0.4 + access_factor * 0.35 + recency_factor * 0.25
        return min(1.0, max(0.0, quality))

    def _merge_similar_memories(self, max_merge: int = 10) -> int:
        """P2-8: 合并内容高度相似的重复记忆。

        使用 token 集合 Jaccard 相似度检测重复，合并时保留较早的条目并扩展内容。

        Args:
            max_merge: 最大合并次数.

        Returns:
            合并的记忆对数.
        """
        merged_count = 0

        rows = self._conn.execute(
            """SELECT id, content, tokens, memory_type, scene
               FROM memories
               WHERE memory_type = 'short_term'
               ORDER BY timestamp DESC
               LIMIT 100"""
        ).fetchall()

        merged_ids: set[str] = set()

        for i in range(len(rows)):
            if merged_count >= max_merge:
                break
            if rows[i]["id"] in merged_ids:
                continue

            tokens_i = set(rows[i]["tokens"].split()) if rows[i]["tokens"] else set()
            if len(tokens_i) < 3:
                continue

            for j in range(i + 1, len(rows)):
                if rows[j]["id"] in merged_ids:
                    continue

                tokens_j = set(rows[j]["tokens"].split()) if rows[j]["tokens"] else set()
                if len(tokens_j) < 3:
                    continue

                # Jaccard 相似度
                intersection = len(tokens_i & tokens_j)
                union = len(tokens_i | tokens_j)
                if union == 0:
                    continue
                similarity = intersection / union

                if similarity > 0.8:
                    # 合并：保留 i，删除 j，将 j 的内容追加到 i
                    combined = rows[i]["content"] + "\n[合并] " + rows[j]["content"]
                    self.update(rows[i]["id"], content=combined)
                    self.delete_by_id(rows[j]["id"])
                    merged_ids.add(rows[j]["id"])
                    merged_count += 1
                    log.info(
                        "P2-8: 相似记忆已合并",
                        kept=rows[i]["id"],
                        removed=rows[j]["id"],
                        similarity=similarity,
                    )
                    break

        return merged_count

    def close(self) -> None:
        if self._vector_store is not None:
            try:
                self._vector_store.close()
            except Exception as _exc:
                log_ignored(log, "store.MemoryStore.close.vector_store", _exc)
            self._vector_store = None
        if self._conn:
            try:
                self._conn.close()
            except Exception as _exc:
                log_ignored(log, "store.MemoryStore.close.conn", _exc)
            self._conn = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception as _exc:
            log_ignored(log, "store.MemoryStore.__del__", _exc)
