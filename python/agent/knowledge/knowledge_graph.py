"""KnowledgeGraph — 知识图谱关联检索。

在向量语义检索基础上增加图结构关联检索：
- 实体提取：从知识条目中自动提取实体
- 关系构建：建立实体间的语义关系
- 图遍历检索：从查询实体出发，沿关系边扩展相关实体
- 与向量检索融合：图检索结果与向量检索结果加权合并

Usage:
    from agent.knowledge.knowledge_graph import KnowledgeGraph
    graph = KnowledgeGraph(store)
    await graph.initialize()
    await graph.add_entry(entry_id, content)
    results = await graph.search("DeepSeek", max_depth=2)
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("knowledge_graph")




@dataclass
class Entity:
    """知识实体。

    Attributes:
        id: 实体唯一标识。
        name: 实体名称。
        type: 实体类型（concept/tool/person/project/technology）。
        mention_count: 被提及次数。
        created_at: 创建时间戳。
    """

    id: str = ""
    name: str = ""
    type: str = "concept"
    mention_count: int = 1
    created_at: float = 0.0


@dataclass
class Relation:
    """实体间关系。

    Attributes:
        id: 关系唯一标识。
        source_id: 源实体 ID。
        target_id: 目标实体 ID。
        relation_type: 关系类型（related_to/depends_on/part_of/used_by）。
        weight: 关系权重 (0-1)。
        evidence: 关系证据（原文片段）。
        created_at: 创建时间戳。
    """

    id: str = ""
    source_id: str = ""
    target_id: str = ""
    relation_type: str = "related_to"
    weight: float = 0.5
    evidence: str = ""
    created_at: float = 0.0


@dataclass
class GraphSearchResult:
    """图检索结果。

    Attributes:
        entity: 目标实体。
        score: 关联分数 (0-1)。
        path: 从查询实体到目标实体的路径。
        distance: 路径跳数。
    """

    entity: Entity = field(default_factory=Entity)
    score: float = 0.0
    path: list[str] = field(default_factory=list)
    distance: int = 0


_ENTITY_PATTERNS: list[tuple[str, str]] = [
    (r'(?:使用|用|采用|基于)\s*[`""]?([A-Za-z][\w\-\./]+)[`""]?', "technology"),
    (r'([A-Z][a-z]+(?:[A-Z][a-z]+)+)', "concept"),
    (r'([A-Z]{2,}(?:_[A-Z]+)*)', "tool"),
    (r'[\u4e00-\u9fff]{2,8}(?:模型|引擎|框架|系统|服务|工具|平台|协议)', "technology"),
    (r'[\u4e00-\u9fff]{2,6}(?:项目|任务|流程|方案)', "project"),
]

_RELATION_PATTERNS: list[tuple[str, str]] = [
    (r'(\S+)\s*(?:依赖|基于|使用|调用)\s*(\S+)', "depends_on"),
    (r'(\S+)\s*(?:属于|包含在|是\s*\S+\s*的\s*一部分)\s*(\S+)', "part_of"),
    (r'(\S+)\s*(?:替代|取代|升级|迁移到)\s*(\S+)', "replaces"),
    (r'(\S+)\s*(?:与|和|跟)\s*(\S+)\s*(?:相关|关联|配合|集成)', "related_to"),
]

_ENTITY_TYPE_ENUM = "concept,technology,tool,person,project,organization,location,event"

_RELATION_TYPE_ENUM = "related_to,depends_on,part_of,replaces,used_by,co_mentioned"

_LLM_EXTRACT_PROMPT = (
    "你是一个知识图谱实体关系提取专家。从以下文本中提取实体和关系。\n\n"
    "实体类型可选: {_entity_types}\n"
    "关系类型可选: {_relation_types}\n\n"
    "请严格按以下 JSON 格式返回，不要添加任何其他文字：\n"
    '{{"entities": [{{"name": "实体名", "type": "实体类型"}}], '
    '"relations": [{{"source": "源实体名", "target": "目标实体名", "type": "关系类型", "evidence": "原文片段"}}]}}\n\n'
    "文本:\n{text}"
)


class KnowledgeGraph:
    """知识图谱 — 实体关系图检索。

    在 KnowledgeStore 基础上增加图结构层，
    支持实体提取、关系构建、图遍历检索。

    实体提取策略：
    - regex: 基于正则模式匹配（快速、零成本）
    - llm: 基于 LLM 语义理解（精确、有 API 成本）
    - hybrid: 先 regex 快速提取，再 LLM 补充（推荐）

    成本控制：
    - min_length: 低于此长度的文本跳过 LLM 提取
    - batch_size: 批量提取时每批最大条目数
    - cache_ttl: 提取结果缓存时间（秒），0 表示不缓存
    - daily_budget: 每日 LLM 提取调用次数上限
    """

    def __init__(
        self,
        store: Any,
        extract_strategy: str = "regex",
        min_length: int = 50,
        batch_size: int = 10,
        cache_ttl: int = 3600,
        daily_budget: int = 200,
    ) -> None:
        self._store = store
        self._conn: sqlite3.Connection | None = None
        self._extract_strategy = extract_strategy
        self._min_length = min_length
        self._batch_size = batch_size
        self._cache_ttl = cache_ttl
        self._daily_budget = daily_budget
        self._llm_call_count: int = 0
        self._llm_call_date: str = ""
        self._extract_cache: dict[str, tuple[float, tuple]] = {}

    async def initialize(self) -> None:
        """初始化图谱数据库。"""
        if self._store and hasattr(self._store, "_conn") and self._store._conn:
            self._conn = self._store._conn
        else:
            return
        self._create_tables()
        log.debug("KnowledgeGraph 初始化完成")

    async def close(self) -> None:
        """关闭图谱数据库。"""
        self._conn = None

    async def get_stats(self) -> dict[str, Any]:
        """获取知识图谱统计信息。"""
        if self._conn is None:
            return {"entities": 0, "relations": 0, "by_type": {}}
        entity_count = self._conn.execute("SELECT COUNT(*) FROM kg_entities").fetchone()[0]
        relation_count = self._conn.execute("SELECT COUNT(*) FROM kg_relations").fetchone()[0]
        type_rows = self._conn.execute(
            "SELECT type, COUNT(*) FROM kg_entities GROUP BY type"
        ).fetchall()
        by_type = {row[0]: row[1] for row in type_rows}
        return {
            "entities": entity_count,
            "relations": relation_count,
            "by_type": by_type,
        }

    def _create_tables(self) -> None:
        if self._conn is None:
            return
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS kg_entities (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'concept',
                mention_count INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_kge_name ON kg_entities(name);
            CREATE INDEX IF NOT EXISTS idx_kge_type ON kg_entities(type);
            CREATE TABLE IF NOT EXISTS kg_relations (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                relation_type TEXT NOT NULL DEFAULT 'related_to',
                weight REAL NOT NULL DEFAULT 0.5,
                evidence TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                FOREIGN KEY (source_id) REFERENCES kg_entities(id),
                FOREIGN KEY (target_id) REFERENCES kg_entities(id)
            );
            CREATE INDEX IF NOT EXISTS idx_kgr_source ON kg_relations(source_id);
            CREATE INDEX IF NOT EXISTS idx_kgr_target ON kg_relations(target_id);
            CREATE TABLE IF NOT EXISTS kg_entry_entities (
                entry_id TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                PRIMARY KEY (entry_id, entity_id)
            );
            CREATE INDEX IF NOT EXISTS idx_kgee_entry ON kg_entry_entities(entry_id);
            CREATE INDEX IF NOT EXISTS idx_kgee_entity ON kg_entry_entities(entity_id);
        """)

    async def add_entry(self, entry_id: str, content: str) -> list[str]:
        """从知识条目中提取实体和关系。

        根据 _extract_strategy 选择提取策略：
        - regex: 纯正则提取（默认，零成本）
        - llm: 纯 LLM 提取（精确，有 API 成本）
        - hybrid: 先 regex 快速提取，再 LLM 补充遗漏实体

        Args:
            entry_id: 知识条目 ID。
            content: 知识内容。

        Returns:
            提取的实体 ID 列表。
        """
        if self._conn is None:
            return []

        use_llm = self._extract_strategy in ("llm", "hybrid")
        if use_llm and len(content) < self._min_length:
            use_llm = False
            log.debug("文本过短，跳过 LLM 提取", length=len(content), min_length=self._min_length)

        if use_llm and not self._check_budget():
            use_llm = False
            log.debug("LLM 提取预算耗尽，降级为 regex", count=self._llm_call_count, budget=self._daily_budget)

        if use_llm and self._extract_strategy == "llm":
            entities, relations = await self._extract_by_llm(content)
        elif use_llm and self._extract_strategy == "hybrid":
            regex_entities = self._extract_entities(content)
            regex_relations = self._extract_relations(content, regex_entities)
            llm_entities, llm_relations = await self._extract_by_llm(content)
            entities = self._merge_entities(regex_entities, llm_entities)
            relations = self._merge_relations(regex_relations, llm_relations)
        else:
            entities = self._extract_entities(content)
            relations = self._extract_relations(content, entities)

        entity_ids: list[str] = []

        for name, etype in entities:
            eid = self._entity_id(name)
            self._upsert_entity(eid, name, etype)
            entity_ids.append(eid)

            self._conn.execute(
                "INSERT OR IGNORE INTO kg_entry_entities (entry_id, entity_id) VALUES (?, ?)",
                (entry_id, eid),
            )

        for src_name, tgt_name, rtype, evidence in relations:
            src_id = self._entity_id(src_name)
            tgt_id = self._entity_id(tgt_name)
            if src_id != tgt_id:
                self._upsert_relation(src_id, tgt_id, rtype, evidence)

        for i, (n1, _) in enumerate(entities):
            for n2, _ in entities[i + 1:]:
                eid1 = self._entity_id(n1)
                eid2 = self._entity_id(n2)
                if eid1 != eid2:
                    self._upsert_relation(eid1, eid2, "co_mentioned", content[:100])

        self._conn.commit()
        return entity_ids

    async def search(
        self,
        query: str,
        max_depth: int = 2,
        max_results: int = 10,
        min_score: float = 0.2,
    ) -> list[GraphSearchResult]:
        """图遍历检索 — 从查询中提取实体，沿关系边扩展。

        Args:
            query: 查询文本。
            max_depth: 最大遍历深度。
            max_results: 最大返回数量。
            min_score: 最低关联分数。

        Returns:
            图检索结果列表。
        """
        if self._conn is None:
            return []

        query_entities = self._extract_entities(query)
        if not query_entities:
            return []

        start_ids = {self._entity_id(name) for name, _ in query_entities}

        visited: set[str] = set()
        results: list[GraphSearchResult] = []
        frontier: list[tuple[str, int, list[str], float]] = [
            (sid, 0, [sid], 1.0) for sid in start_ids
        ]

        while frontier and len(results) < max_results * 3:
            current_id, depth, path, score = frontier.pop(0)

            if current_id in visited:
                continue
            visited.add(current_id)

            entity = self._load_entity(current_id)
            if entity is None:
                continue

            if current_id not in start_ids:
                decay = 0.7 ** depth
                final_score = score * decay
                if final_score >= min_score:
                    results.append(GraphSearchResult(
                        entity=entity,
                        score=final_score,
                        path=path,
                        distance=depth,
                    ))

            if depth < max_depth:
                neighbors = self._get_neighbors(current_id)
                for nid, rtype, weight in neighbors:
                    if nid not in visited:
                        frontier.append((
                            nid,
                            depth + 1,
                            path + [f"--{rtype}-->", nid],
                            score * weight,
                        ))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:max_results]

    async def get_related_entries(
        self,
        entity_name: str,
        limit: int = 10,
    ) -> list[str]:
        """获取与实体关联的知识条目 ID 列表。"""
        if self._conn is None:
            return []

        eid = self._entity_id(entity_name)
        rows = self._conn.execute(
            "SELECT entry_id FROM kg_entry_entities WHERE entity_id = ? LIMIT ?",
            (eid, limit),
        ).fetchall()
        return [r[0] for r in rows]

    async def hybrid_search(
        self,
        query: str,
        vector_results: list[Any],
        top_k: int = 5,
        graph_weight: float = 0.3,
        vector_weight: float = 0.7,
    ) -> list[Any]:
        """混合检索 — 融合图检索与向量检索结果。

        Args:
            query: 查询文本。
            vector_results: 向量检索结果列表（SearchResult）。
            top_k: 返回数量。
            graph_weight: 图检索权重。
            vector_weight: 向量检索权重。

        Returns:
            加权合并后的检索结果。
        """
        graph_results = await self.search(query, max_results=top_k * 2)
        graph_entity_ids: set[str] = set()
        graph_scores: dict[str, float] = {}
        for gr in graph_results:
            entry_ids = await self.get_related_entries(gr.entity.name, limit=5)
            for eid in entry_ids:
                graph_entity_ids.add(eid)
                graph_scores[eid] = max(graph_scores.get(eid, 0), gr.score)

        merged: dict[str, float] = {}
        for vr in vector_results:
            entry_id = vr.entry.id if hasattr(vr, "entry") else ""
            score = vr.score if hasattr(vr, "score") else 0
            merged[entry_id] = score * vector_weight

        for eid, gscore in graph_scores.items():
            if eid in merged:
                merged[eid] += gscore * graph_weight
            else:
                merged[eid] = gscore * graph_weight

        sorted_ids = sorted(merged, key=merged.get, reverse=True)[:top_k]
        id_to_result = {}
        for vr in vector_results:
            eid = vr.entry.id if hasattr(vr, "entry") else ""
            id_to_result[eid] = vr

        final = []
        for eid in sorted_ids:
            if eid in id_to_result:
                final.append(id_to_result[eid])
        return final

    def _extract_entities(self, text: str) -> list[tuple[str, str]]:
        """从文本中提取实体。"""
        seen: set[str] = set()
        entities: list[tuple[str, str]] = []
        for pattern, etype in _ENTITY_PATTERNS:
            for match in re.finditer(pattern, text):
                name = match.group(1).strip()
                if name and len(name) >= 2 and name not in seen:
                    seen.add(name)
                    entities.append((name, etype))
        return entities[:20]

    async def _extract_by_llm(
        self, text: str,
    ) -> tuple[list[tuple[str, str]], list[tuple[str, str, str, str]]]:
        """使用 LLM 提取实体和关系。

        通过 litellm 调用 LLM，解析结构化 JSON 输出。
        失败时降级为空结果（不影响主流程）。

        成本控制：
        - 缓存：相同文本在 cache_ttl 内直接返回缓存结果
        - 预算：每日调用次数不超过 daily_budget

        Args:
            text: 待提取文本。

        Returns:
            (entities, relations) 二元组。
        """
        cache_key = str(hash(text[:500]))
        now = time.time()

        if self._cache_ttl > 0 and cache_key in self._extract_cache:
            cached_at, cached_result = self._extract_cache[cache_key]
            if now - cached_at < self._cache_ttl:
                log.debug("LLM 提取命中缓存", key=cache_key[:8])
                return cached_result

        truncated = text[:2000] if len(text) > 2000 else text
        prompt = _LLM_EXTRACT_PROMPT.format(
            _entity_types=_ENTITY_TYPE_ENUM,
            _relation_types=_RELATION_TYPE_ENUM,
            text=truncated,
        )

        try:
            from litellm import acompletion
            import os

            model = os.getenv("KG_EXTRACT_MODEL", os.getenv("LLM_MODEL", "gpt-4o-mini"))
            response = await acompletion(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=1000,
                temperature=0.0,
            )

            self._increment_budget()

            raw = response.choices[0].message.content.strip()
            parsed = self._parse_llm_extraction(raw)

            if self._cache_ttl > 0:
                self._extract_cache[cache_key] = (time.time(), parsed)
                self._evict_cache()

            return parsed

        except ImportError:
            log.debug("litellm 未安装，跳过 LLM 实体提取")
            return [], []
        except Exception as e:
            log.warning("LLM 实体提取失败，降级为空", error=str(e))
            return [], []

    def _parse_llm_extraction(
        self, raw: str,
    ) -> tuple[list[tuple[str, str]], list[tuple[str, str, str, str]]]:
        """解析 LLM 返回的 JSON 提取结果。

        Args:
            raw: LLM 原始输出文本。

        Returns:
            (entities, relations) 二元组。
        """
        entities: list[tuple[str, str]] = []
        relations: list[tuple[str, str, str, str]] = []

        json_str = raw
        json_match = re.search(r'\{[\s\S]*\}', raw)
        if json_match:
            json_str = json_match.group(0)

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            log.warning("LLM 提取结果 JSON 解析失败", raw=raw[:200])
            return entities, relations

        valid_types = set(_ENTITY_TYPE_ENUM.split(","))
        valid_rtypes = set(_RELATION_TYPE_ENUM.split(","))

        for ent in data.get("entities", []):
            name = ent.get("name", "").strip()
            etype = ent.get("type", "concept").strip()
            if name and len(name) >= 2:
                if etype not in valid_types:
                    etype = "concept"
                entities.append((name, etype))

        for rel in data.get("relations", []):
            src = rel.get("source", "").strip()
            tgt = rel.get("target", "").strip()
            rtype = rel.get("type", "related_to").strip()
            evidence = rel.get("evidence", "")[:100]
            if src and tgt and src != tgt:
                if rtype not in valid_rtypes:
                    rtype = "related_to"
                relations.append((src, tgt, rtype, evidence))

        return entities[:30], relations[:20]

    def _merge_entities(
        self,
        base: list[tuple[str, str]],
        supplement: list[tuple[str, str]],
    ) -> list[tuple[str, str]]:
        """合并 regex 和 LLM 提取的实体（去重，LLM 结果补充）。

        Args:
            base: regex 提取的实体列表。
            supplement: LLM 提取的实体列表。

        Returns:
            合并后的实体列表。
        """
        seen: dict[str, str] = {}
        for name, etype in base:
            seen[name.lower()] = etype

        for name, etype in supplement:
            key = name.lower()
            if key not in seen:
                seen[key] = etype

        return list(seen.items())

    def _merge_relations(
        self,
        base: list[tuple[str, str, str, str]],
        supplement: list[tuple[str, str, str, str]],
    ) -> list[tuple[str, str, str, str]]:
        """合并 regex 和 LLM 提取的关系（去重，LLM 结果补充）。

        Args:
            base: regex 提取的关系列表。
            supplement: LLM 提取的关系列表。

        Returns:
            合并后的关系列表。
        """
        seen: set[str] = set()
        merged: list[tuple[str, str, str, str]] = []

        for src, tgt, rtype, evidence in base:
            key = f"{src.lower()}|{rtype}|{tgt.lower()}"
            if key not in seen:
                seen.add(key)
                merged.append((src, tgt, rtype, evidence))

        for src, tgt, rtype, evidence in supplement:
            key = f"{src.lower()}|{rtype}|{tgt.lower()}"
            if key not in seen:
                seen.add(key)
                merged.append((src, tgt, rtype, evidence))

        return merged

    def _extract_relations(
        self,
        text: str,
        entities: list[tuple[str, str]],
    ) -> list[tuple[str, str, str, str]]:
        """从文本中提取关系。"""
        relations: list[tuple[str, str, str, str]] = []
        entity_names = {name for name, _ in entities}
        for pattern, rtype in _RELATION_PATTERNS:
            for match in re.finditer(pattern, text):
                src = match.group(1).strip()
                tgt = match.group(2).strip()
                if src in entity_names and tgt in entity_names:
                    relations.append((src, tgt, rtype, match.group(0)[:100]))
        return relations

    def _entity_id(self, name: str) -> str:
        """生成实体 ID。"""
        import hashlib
        return hashlib.md5(name.encode("utf-8")).hexdigest()[:12]

    def _upsert_entity(self, eid: str, name: str, etype: str) -> None:
        """插入或更新实体。"""
        if self._conn is None:
            return
        existing = self._conn.execute(
            "SELECT mention_count FROM kg_entities WHERE id = ?", (eid,),
        ).fetchone()
        if existing:
            self._conn.execute(
                "UPDATE kg_entities SET mention_count = mention_count + 1 WHERE id = ?",
                (eid,),
            )
        else:
            self._conn.execute(
                "INSERT INTO kg_entities (id, name, type, mention_count, created_at) VALUES (?, ?, ?, 1, ?)",
                (eid, name, etype, time.time()),
            )

    def _upsert_relation(
        self,
        src_id: str,
        tgt_id: str,
        rtype: str,
        evidence: str,
    ) -> None:
        """插入或更新关系。"""
        if self._conn is None:
            return
        rid = f"{src_id}_{rtype}_{tgt_id}"
        existing = self._conn.execute(
            "SELECT id FROM kg_relations WHERE id = ?", (rid,),
        ).fetchone()
        if not existing:
            self._conn.execute(
                "INSERT INTO kg_relations (id, source_id, target_id, relation_type, weight, evidence, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (rid, src_id, tgt_id, rtype, 0.5, evidence[:200], time.time()),
            )

    def _load_entity(self, eid: str) -> Entity | None:
        """加载实体。"""
        if self._conn is None:
            return None
        row = self._conn.execute(
            "SELECT id, name, type, mention_count, created_at FROM kg_entities WHERE id = ?",
            (eid,),
        ).fetchone()
        if not row:
            return None
        return Entity(id=row[0], name=row[1], type=row[2], mention_count=row[3], created_at=row[4])

    def _get_neighbors(self, eid: str) -> list[tuple[str, str, float]]:
        """获取实体的邻居（双向查询）。"""
        if self._conn is None:
            return []
        rows = self._conn.execute(
            "SELECT target_id, relation_type, weight FROM kg_relations WHERE source_id = ?",
            (eid,),
        ).fetchall()
        neighbors = [(r[0], r[1], r[2]) for r in rows]
        reverse_rows = self._conn.execute(
            "SELECT source_id, relation_type, weight FROM kg_relations WHERE target_id = ?",
            (eid,),
        ).fetchall()
        for r in reverse_rows:
            reverse_type = f"rev_{r[1]}"
            neighbors.append((r[0], reverse_type, r[2]))
        return neighbors

    def _check_budget(self) -> bool:
        """检查 LLM 提取预算是否充足。

        每日重置计数器，超过 daily_budget 则返回 False。

        Returns:
            是否可以继续调用 LLM。
        """
        today = time.strftime("%Y-%m-%d")
        if self._llm_call_date != today:
            self._llm_call_date = today
            self._llm_call_count = 0
        return self._llm_call_count < self._daily_budget

    def _increment_budget(self) -> None:
        """递增 LLM 调用计数。"""
        self._llm_call_count += 1

    def _evict_cache(self) -> None:
        """清理过期缓存条目。"""
        if self._cache_ttl <= 0:
            return
        now = time.time()
        expired = [k for k, (t, _) in self._extract_cache.items() if now - t >= self._cache_ttl]
        for k in expired:
            del self._extract_cache[k]

    async def batch_extract(
        self,
        entries: list[tuple[str, str]],
    ) -> dict[str, list[str]]:
        """批量提取实体和关系。

        按 batch_size 分批调用 LLM，避免一次性消耗过多预算。

        Args:
            entries: (entry_id, content) 列表。

        Returns:
            entry_id -> entity_ids 映射。
        """
        results: dict[str, list[str]] = {}

        for i in range(0, len(entries), self._batch_size):
            batch = entries[i:i + self._batch_size]
            for entry_id, content in batch:
                entity_ids = await self.add_entry(entry_id, content)
                results[entry_id] = entity_ids

            if i + self._batch_size < len(entries):
                log.debug("批量提取暂停", batch=i // self._batch_size + 1, total=(len(entries) + self._batch_size - 1) // self._batch_size)

        return results

    def get_budget_status(self) -> dict[str, Any]:
        """获取 LLM 提取预算状态。

        Returns:
            预算使用情况字典。
        """
        return {
            "daily_budget": self._daily_budget,
            "calls_today": self._llm_call_count,
            "remaining": max(0, self._daily_budget - self._llm_call_count),
            "cache_size": len(self._extract_cache),
            "cache_ttl": self._cache_ttl,
        }
