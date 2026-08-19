"""KnowledgeStore — 知识存储与语义检索。

基于 SQLite + 向量索引的知识库，支持：
- 知识条目的 CRUD
- 语义向量检索（余弦相似度）
- 标签分类与过滤
- 知识来源追踪

Usage:
    from agent.knowledge.knowledge_store import KnowledgeStore
    store = KnowledgeStore()
    await store.initialize()
    kid = await store.add("DeepSeek V4 Flash 支持 agent_native", tags=["model", "deepseek"])
    results = await store.search("agent能力")
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("knowledge_store")


@dataclass
class KnowledgeEntry:
    """知识条目。

    Attributes:
        id: 知识唯一标识（内容哈希）。
        content: 知识内容。
        tags: 标签列表。
        source: 来源（dialog/operation/document/imported）。
        source_id: 来源标识（会话ID/操作ID等）。
        confidence: 置信度 (0-1)。
        access_count: 访问次数。
        last_accessed: 最后访问时间戳。
        created_at: 创建时间戳。
        updated_at: 更新时间戳。
        metadata: 额外元数据。
        embedding: 向量嵌入。
    """

    id: str = ""
    content: str = ""
    tags: list[str] = field(default_factory=list)
    source: str = "dialog"
    source_id: str = ""
    confidence: float = 1.0
    access_count: int = 0
    last_accessed: float = 0.0
    created_at: float = 0.0
    updated_at: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)
    embedding: list[float] = field(default_factory=list)


@dataclass
class SearchResult:
    """检索结果。

    Attributes:
        entry: 知识条目。
        score: 相似度分数 (0-1)。
    """

    entry: KnowledgeEntry = field(default_factory=KnowledgeEntry)
    score: float = 0.0


class KnowledgeStore:
    """知识存储与语义检索。

    使用 SQLite 存储知识条目，支持向量语义检索。
    向量嵌入通过 LLM API 生成，降级时使用关键词匹配。

    Usage:
        store = KnowledgeStore()
        await store.initialize()
        kid = await store.add("知识内容", tags=["tag1"])
        results = await store.search("查询", top_k=5)
    """

    def __init__(self, db_path: str = "") -> None:
        if not db_path:
            data_dir = os.environ.get("DATA_DIR", "data")
            db_path = os.path.join(data_dir, "knowledge", "knowledge.db")
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None

    async def initialize(self) -> None:
        """初始化数据库连接和表结构。"""
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row
        self._create_tables()
        log.info("KnowledgeStore 初始化完成", db=self._db_path)

    async def close(self) -> None:
        """关闭数据库连接。"""
        if self._conn:
            self._conn.close()
            self._conn = None

    async def add(
        self,
        content: str,
        tags: list[str] | None = None,
        source: str = "dialog",
        source_id: str = "",
        confidence: float = 1.0,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """添加知识条目。

        Args:
            content: 知识内容。
            tags: 标签列表。
            source: 来源类型。
            source_id: 来源标识。
            confidence: 置信度。
            metadata: 额外元数据。

        Returns:
            知识条目 ID。
        """
        if self._conn is None:
            await self.initialize()

        entry_id = self._compute_id(content)
        now = time.time()

        tags = tags or []
        metadata = metadata or {}

        embedding = await self._generate_embedding(content)

        self._conn.execute(
            """INSERT OR REPLACE INTO knowledge_entries
               (id, content, tags, source, source_id, confidence,
                access_count, last_accessed, created_at, updated_at, metadata, embedding)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry_id, content, json.dumps(tags, ensure_ascii=False),
                source, source_id, confidence,
                0, 0.0, now, now,
                json.dumps(metadata, ensure_ascii=False),
                json.dumps(embedding),
            ),
        )
        self._conn.commit()

        log.info("知识添加", id=entry_id[:8], source=source, tags=tags)
        return entry_id

    async def get(self, entry_id: str) -> KnowledgeEntry | None:
        """获取知识条目。

        Args:
            entry_id: 知识条目 ID。

        Returns:
            知识条目或 None。
        """
        if self._conn is None:
            return None

        row = self._conn.execute(
            "SELECT * FROM knowledge_entries WHERE id = ?", (entry_id,),
        ).fetchone()

        if row is None:
            return None

        self._conn.execute(
            "UPDATE knowledge_entries SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
            (time.time(), entry_id),
        )
        self._conn.commit()

        return self._row_to_entry(row)

    async def search(
        self,
        query: str,
        top_k: int = 5,
        tags: list[str] | None = None,
        source: str = "",
        min_confidence: float = 0.0,
    ) -> list[SearchResult]:
        """语义检索知识。

        Args:
            query: 查询文本。
            top_k: 返回最大数量。
            tags: 过滤标签（AND 逻辑）。
            source: 过滤来源。
            min_confidence: 最低置信度。

        Returns:
            检索结果列表。
        """
        if self._conn is None:
            return []

        query_embedding = await self._generate_embedding(query)

        sql = "SELECT * FROM knowledge_entries WHERE confidence >= ?"
        params: list[Any] = [min_confidence]

        if source:
            sql += " AND source = ?"
            params.append(source)

        if tags:
            for tag in tags:
                sql += " AND tags LIKE ?"
                params.append(f'%"{tag}"%')

        rows = self._conn.execute(sql, params).fetchall()

        results: list[SearchResult] = []
        for row in rows:
            entry = self._row_to_entry(row)
            if query_embedding and entry.embedding:
                score = self._cosine_similarity(query_embedding, entry.embedding)
            else:
                score = self._keyword_similarity(query, entry.content)

            if score > 0.1:
                results.append(SearchResult(entry=entry, score=score))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]

    async def update(self, entry_id: str, **kwargs: Any) -> bool:
        """更新知识条目。

        Args:
            entry_id: 知识条目 ID。
            **kwargs: 要更新的字段。

        Returns:
            是否更新成功。
        """
        if self._conn is None:
            return False

        allowed = {"content", "tags", "confidence", "metadata"}
        updates: list[str] = []
        values: list[Any] = []

        for key, value in kwargs.items():
            if key in allowed:
                if key in ("tags", "metadata"):
                    value = json.dumps(value, ensure_ascii=False)
                updates.append(f"{key} = ?")
                values.append(value)

        if not updates:
            return False

        updates.append("updated_at = ?")
        values.append(time.time())
        values.append(entry_id)

        cursor = self._conn.execute(
            f"UPDATE knowledge_entries SET {', '.join(updates)} WHERE id = ?",
            values,
        )
        self._conn.commit()
        return cursor.rowcount > 0

    async def delete(self, entry_id: str) -> bool:
        """删除知识条目。

        Args:
            entry_id: 知识条目 ID。

        Returns:
            是否删除成功。
        """
        if self._conn is None:
            return False

        cursor = self._conn.execute(
            "DELETE FROM knowledge_entries WHERE id = ?", (entry_id,),
        )
        self._conn.commit()
        return cursor.rowcount > 0

    async def list_entries(
        self,
        tags: list[str] | None = None,
        source: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> list[KnowledgeEntry]:
        """列出知识条目。

        Args:
            tags: 过滤标签。
            source: 过滤来源。
            limit: 最大返回数量。
            offset: 偏移量。

        Returns:
            知识条目列表。
        """
        if self._conn is None:
            return []

        sql = "SELECT * FROM knowledge_entries WHERE 1=1"
        params: list[Any] = []

        if source:
            sql += " AND source = ?"
            params.append(source)

        if tags:
            for tag in tags:
                sql += " AND tags LIKE ?"
                params.append(f'%"{tag}"%')

        sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        rows = self._conn.execute(sql, params).fetchall()
        return [self._row_to_entry(row) for row in rows]

    async def count(self, source: str = "") -> int:
        """统计知识条目数量。"""
        if self._conn is None:
            return 0

        if source:
            row = self._conn.execute(
                "SELECT COUNT(*) FROM knowledge_entries WHERE source = ?", (source,),
            ).fetchone()
        else:
            row = self._conn.execute("SELECT COUNT(*) FROM knowledge_entries").fetchone()

        return row[0] if row else 0

    async def get_stale_entries(self, max_age_days: float = 90.0, min_access: int = 0) -> list[KnowledgeEntry]:
        """获取过时知识条目。

        Args:
            max_age_days: 最大年龄（天）。
            min_access: 最小访问次数（低于此值视为过时）。

        Returns:
            过时条目列表。
        """
        if self._conn is None:
            return []

        cutoff = time.time() - max_age_days * 86400
        rows = self._conn.execute(
            "SELECT * FROM knowledge_entries WHERE updated_at < ? AND access_count <= ?",
            (cutoff, min_access),
        ).fetchall()

        return [self._row_to_entry(row) for row in rows]

    def _create_tables(self) -> None:
        """创建数据库表。"""
        if self._conn is None:
            return

        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS knowledge_entries (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tags TEXT DEFAULT '[]',
                source TEXT DEFAULT 'dialog',
                source_id TEXT DEFAULT '',
                confidence REAL DEFAULT 1.0,
                access_count INTEGER DEFAULT 0,
                last_accessed REAL DEFAULT 0,
                created_at REAL DEFAULT 0,
                updated_at REAL DEFAULT 0,
                metadata TEXT DEFAULT '{}',
                embedding TEXT DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_ke_source ON knowledge_entries(source);
            CREATE INDEX IF NOT EXISTS idx_ke_updated ON knowledge_entries(updated_at);
            CREATE INDEX IF NOT EXISTS idx_ke_confidence ON knowledge_entries(confidence);
        """)

    def _compute_id(self, content: str) -> str:
        """计算知识条目 ID（内容哈希）。"""
        return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]

    async def _generate_embedding(self, text: str) -> list[float]:
        """生成文本向量嵌入。

        优先使用 embedding API，降级为简单哈希向量。
        """
        try:
            from agent.core.engine import get_engine
            engine = get_engine()
            if engine and hasattr(engine, "embedding_provider"):
                result = await engine.embedding_provider.embed(text)
                if result:
                    return result
        except Exception as _exc:
            log_ignored(log, "knowledge_store._embed_with_engine", _exc)

        return self._simple_hash_embedding(text)

    def _simple_hash_embedding(self, text: str, dim: int = 64) -> list[float]:
        """简单哈希向量（降级方案）。

        统一切词，保证查询与内容使用同一套 token 语义，使余弦相似度可比：
        - 按空白分词；含 CJK 字符的词展开为单字（兼顾中英混合与纯中文）。
        - 纯无空格串（如单个 CJK 词）退化为字符级切分。

        修复：此前无空格文本走字符级、多词文本走词级，二者 token 空间错位，
        导致英文单词查询与含该词的内容余弦恒为 0（检索彻底失效）。统一后
        英文单词查询与中文按字检索均可正常命中。
        """
        import re

        vec = [0.0] * dim
        lowered = text.lower()
        tokens: list[str] = []
        for word in lowered.split():
            if re.search(r"[\u4e00-\u9fff]", word):
                tokens.extend(list(word))  # CJK 词展开为字符
            else:
                tokens.append(word)
        if not tokens:
            tokens = list(lowered)  # 纯无空格串退化为字符级

        for tok in tokens:
            h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
            idx = h % dim
            vec[idx] += 1.0

        norm = sum(v * v for v in vec) ** 0.5
        if norm > 0:
            vec = [v / norm for v in vec]
        return vec

    def _cosine_similarity(self, a: list[float], b: list[float]) -> float:
        """计算余弦相似度。"""
        if not a or not b or len(a) != len(b):
            return 0.0

        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5

        if norm_a == 0 or norm_b == 0:
            return 0.0

        return dot / (norm_a * norm_b)

    def _keyword_similarity(self, query: str, content: str) -> float:
        """关键词相似度（降级方案）。

        优先使用英文分词重叠；对中文等无空格语言降级为子串命中与字符级重叠，
        避免降级检索完全失效。
        """
        query = query.lower().strip()
        content = content.lower()
        if not query:
            return 0.0
        query_words = set(query.split())
        content_words = set(content.split())
        if query_words:
            overlap = query_words & content_words
            if overlap:
                return len(overlap) / len(query_words)
        # 降级: 子串命中（兼容中文无空格场景）
        if query in content:
            return max(0.3, len(query) / max(len(content), 1))
        # 字符级重叠（CJK）
        q_chars = set(query)
        c_chars = set(content)
        if q_chars and c_chars:
            char_overlap = q_chars & c_chars
            return len(char_overlap) / len(q_chars)
        return 0.0

    def _row_to_entry(self, row: sqlite3.Row) -> KnowledgeEntry:
        """将数据库行转换为 KnowledgeEntry。"""
        return KnowledgeEntry(
            id=row["id"],
            content=row["content"],
            tags=safe_json_loads(row["tags"], [], context="knowledge.tags"),
            source=row["source"],
            source_id=row["source_id"],
            confidence=row["confidence"],
            access_count=row["access_count"],
            last_accessed=row["last_accessed"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            metadata=safe_json_loads(row["metadata"], {}, context="knowledge.metadata"),
            embedding=json.loads(row["embedding"]),
        )
