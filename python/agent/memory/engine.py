from __future__ import annotations

import hashlib
import os
import time
from typing import Any, Optional

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.memory.multimodal_encoder import (
    EncodedVector,
    ModalityType,
    MultimodalEncoder,
    MultimodalEncoderConfig,
)
from agent.memory.redis_cache import (
    RedisCache,
    get_redis_cache,
    is_redis_enabled,
)

log = StructuredLogger("memory_engine")

# 缓存键前缀与默认 TTL
_MEMORY_ITEM_PREFIX = "memory:item:"
_SEARCH_CACHE_PREFIX = "memory:search:"
_MEMORY_ITEM_TTL = 3600  # 单条记忆缓存 1 小时
_SEARCH_CACHE_TTL = 300  # 搜索结果缓存 5 分钟
_EPISODIC_CACHE_PREFIX = "memory:episodic:"  # 情景记忆缓存前缀
_RECENT_CACHE_PREFIX = "memory:recent:"  # 最近记忆缓存前缀


class MemoryEngine:
    """记忆引擎，统一管理短期/长期/情景记忆的存取与检索。

    集成 SQLite FTS5 + 语义向量检索 + 情景记忆 + 知识图谱，
    并可选挂载 Redis 缓存层加速热数据访问。

    Attributes:
        _store: 底层 SQLite 记忆存储。
        _episodic_store: 情景记忆存储（可选）。
        _redis_cache: Redis 缓存层（仅当 REDIS_ENABLED=true 时启用）。
        _multimodal_encoder: 多模态编码器实例（惰性初始化，默认降级模式）。
    """

    def __init__(self, db_path: str | None = None, llm: Any = None, vector_store: Any = None) -> None:
        """初始化记忆引擎。

        Args:
            db_path: SQLite 数据库路径，默认使用 MemoryStore 内部默认路径。
            llm: 可选的 LLM 实例，用于语义引擎增强。
            vector_store: 可选的 VectorStore 实例，用于混合检索增强。
        """
        # 惰性导入以打破循环依赖：agent.memory.store → agent.persistence
        # → agent.persistence.service → agent.memory.engine → agent.memory.store
        from agent.memory.store import MemoryStore

        self._store = MemoryStore(db_path=db_path, vector_store=vector_store) if (db_path or vector_store) else MemoryStore()
        self._episodic_store: Any | None = None
        # 仅当环境变量启用时挂载 Redis 缓存层
        self._redis_cache: Optional[RedisCache] = (
            get_redis_cache() if is_redis_enabled() else None
        )
        # 多模态编码器：默认 fallback 模式，避免无模型环境报错
        # 通过 MULTIMODAL_MODEL 环境变量可切换到真实 CLIP 模型
        self._multimodal_encoder = MultimodalEncoder(
            MultimodalEncoderConfig(
                model_name=os.getenv("MULTIMODAL_MODEL", "fallback")
            )
        )
        if llm is not None:
            from agent.memory.store import set_semantic_engine_llm

            set_semantic_engine_llm(llm)

    def _build_search_cache_key(
        self, prefix: str, *args: Any
    ) -> str:
        """根据搜索参数构建缓存键。

        Args:
            prefix: 缓存键前缀（如 memory:search:）。
            *args: 参与哈希的参数列表。

        Returns:
            str: 16 字符哈希的缓存键名。
        """
        raw = "|".join(str(a) for a in args)
        h = hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]
        return f"{prefix}{h}"

    def set_episodic_store(self, store: Any) -> None:
        """P2-3: 注册 EpisodicMemoryStore，使其结果可被 search_with_context 发现。"""
        self._episodic_store = store

    async def initialize(self) -> None:
        stats = self._store.get_stats()
        log.debug("Memory Engine initialized", **stats)

    async def store(
        self,
        content: str,
        memory_type: str = "short_term",
        scene: str = "",
        emotion: str = "neutral",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """写入记忆到 SQLite，并同步回填 Redis 缓存（若启用）。

        审计 P0-2：写入审批门开启时，暂存到 pending_writes，需人工审批。
        """
        if not content or not content.strip():
            raise ValueError("记忆内容不能为空")
        if len(content) > 500000:
            raise ValueError(f"记忆内容过长: {len(content)} > 500000 字符")

        # ─── 审计 P0-2：写入审批门 ───
        if self._write_gate_enabled:
            import uuid as _uuid
            write_id = _uuid.uuid4().hex[:12]
            self._pending_writes.append({
                "id": write_id,
                "content": content,
                "memory_type": memory_type,
                "scene": scene,
                "emotion": emotion,
                "metadata": metadata,
                "submitted_at": time.time(),
            })
            if len(self._pending_writes) > self._MAX_PENDING_WRITES:
                self._pending_writes = self._pending_writes[-self._MAX_PENDING_WRITES * 3 // 4:]
            log.info("记忆写入已暂存待审批", write_id=write_id, memory_type=memory_type)
            return write_id

        mem_id = self._store.store(content, memory_type, scene, emotion, metadata)
        # 写入 SQLite 后同步写入 Redis 缓存
        if self._redis_cache is not None and mem_id:
            try:
                cache_key = f"{_MEMORY_ITEM_PREFIX}{mem_id}"
                cache_value = {
                    "id": mem_id,
                    "content": content,
                    "memory_type": memory_type,
                    "scene": scene,
                    "emotion": emotion,
                    "metadata": metadata or {},
                    "stored_at": time.time(),
                }
                await self._redis_cache.set(
                    cache_key, cache_value, ttl=_MEMORY_ITEM_TTL
                )
            except Exception as exc:
                log.warning("Redis 缓存写入失败", error=str(exc))

        if self._redis_cache is not None:
            try:
                await self._redis_cache.delete_by_prefix(_SEARCH_CACHE_PREFIX)
            except Exception as exc:
                log.warning("搜索缓存失效失败", error=str(exc))

        return mem_id

    async def search(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.0,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """检索记忆：先查 Redis 缓存，未命中再查 SQLite 并回填。"""
        cache_key: Optional[str] = None
        if self._redis_cache is not None:
            try:
                cache_key = self._build_search_cache_key(
                    _SEARCH_CACHE_PREFIX,
                    "fts",
                    query,
                    limit,
                    memory_type,
                    min_relevance,
                    user_id,
                )
                cached = await self._redis_cache.get(cache_key)
                if cached is not None:
                    log.debug("Redis 缓存命中 fts search", query=query[:50])
                    return cached
            except Exception as exc:
                log.warning("Redis 缓存读取失败", error=str(exc))

        results = self._store.search(query, limit, memory_type, min_relevance, user_id=user_id)
        results.sort(key=lambda r: r.get("relevance", 0.0), reverse=True)

        if self._redis_cache is not None and cache_key and results:
            try:
                await self._redis_cache.set(
                    cache_key, results, ttl=_SEARCH_CACHE_TTL
                )
            except Exception as exc:
                log.warning("Redis 缓存回填失败", error=str(exc))

        return results

    async def search_semantic(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.3,
    ) -> list[dict[str, Any]]:
        """语义检索记忆：先查 Redis 缓存，未命中再查向量库并回填。"""
        cache_key: Optional[str] = None
        if self._redis_cache is not None:
            try:
                cache_key = self._build_search_cache_key(
                    _SEARCH_CACHE_PREFIX,
                    "semantic",
                    query,
                    limit,
                    memory_type,
                    min_relevance,
                )
                cached = await self._redis_cache.get(cache_key)
                if cached is not None:
                    log.debug("Redis 缓存命中 semantic search", query=query[:50])
                    return cached
            except Exception as exc:
                log.warning("Redis 缓存读取失败", error=str(exc))

        results = self._store.search_semantic(query, limit, memory_type, min_relevance)
        results.sort(key=lambda r: r.get("relevance", 0.0), reverse=True)

        if self._redis_cache is not None and cache_key and results:
            try:
                await self._redis_cache.set(
                    cache_key, results, ttl=_SEARCH_CACHE_TTL
                )
            except Exception as exc:
                log.warning("Redis 缓存回填失败", error=str(exc))

        return results

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
        """混合检索：FTS5 + ChromaDB 向量检索，RRF 融合排序。

        先查 Redis 缓存，未命中再执行混合检索并回填。
        当 VectorStore 不可用时回退到纯 FTS5 搜索。

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
        # Redis 缓存：先查
        cache_key: Optional[str] = None
        if self._redis_cache is not None:
            try:
                cache_key = self._build_search_cache_key(
                    _SEARCH_CACHE_PREFIX,
                    "hybrid",
                    query,
                    limit,
                    memory_type,
                    min_relevance,
                    scene_filter,
                    rrf_k,
                )
                cached = await self._redis_cache.get(cache_key)
                if cached is not None:
                    log.debug("Redis 缓存命中 hybrid search", query=query[:50])
                    return cached
            except Exception as exc:
                log.warning("Redis 缓存读取失败", error=str(exc))

        results = await self._store.search_hybrid(
            query=query, limit=limit, memory_type=memory_type,
            min_relevance=min_relevance, scene_filter=scene_filter,
            time_weight=time_weight, recent_hours=recent_hours,
            user_id=user_id, rrf_k=rrf_k,
        )

        # Redis 缓存：未命中则回填
        if self._redis_cache is not None and cache_key and results:
            try:
                await self._redis_cache.set(
                    cache_key, results, ttl=_SEARCH_CACHE_TTL
                )
            except Exception as exc:
                log.warning("Redis 缓存回填失败", error=str(exc))

        return results

    async def search_with_context(
        self,
        query: str,
        scene: str | None = None,
        recent_hours: float = 0.0,
        limit: int = 10,
        use_recency_decay: bool = True,
        use_knowledge_graph: bool = True,
        include_multimodal: bool = True,
        fts_time_weight: float = 0.3,
        episodic_time_weight: float = 0.2,
        episodic_relevance: float = 0.6,
        decay_window_days: float = 7.0,
        decay_boost_max: float = 0.3,
        kg_relevance_factor: float = 0.7,
    ) -> list[dict[str, Any]]:
        """P1-3: 混合召回 — FTS + 语义向量 + 情境记忆 + 时效衰减 + 知识图谱。

        遵循"不重复造轮子"原则，复用已有的 search/search_semantic/search_multimodal
        能力，按相关性融合排序。Redis 启用时，先查缓存，未命中再回填。

        Args:
            query: 搜索查询。
            scene: 场景过滤。
            recent_hours: 仅搜索最近 N 小时的记忆。
            limit: 最大返回数。
            use_recency_decay: 是否应用时效衰减权重。
            use_knowledge_graph: 是否使用知识图谱增强。
            include_multimodal: 是否合并多模态记忆搜索结果（默认 True）。

        Returns:
            按相关性排序的记忆列表。
        """
        # Redis 缓存：先查缓存
        cache_key: Optional[str] = None
        if self._redis_cache is not None:
            try:
                cache_key = self._build_search_cache_key(
                    _SEARCH_CACHE_PREFIX,
                    "ctx",
                    query,
                    scene,
                    recent_hours,
                    limit,
                    use_recency_decay,
                    use_knowledge_graph,
                    include_multimodal,
                    fts_time_weight,
                    episodic_time_weight,
                    episodic_relevance,
                    decay_window_days,
                    decay_boost_max,
                    kg_relevance_factor,
                )
                cached = await self._redis_cache.get(cache_key)
                if cached is not None:
                    log.debug("Redis 缓存命中 search_with_context", query=query[:50])
                    return cached
            except Exception as exc:
                log.warning("Redis 缓存读取失败", error=str(exc))

        # 混合检索：VectorStore 可用时用 hybrid_search，否则回退到 FTS + semantic
        fts_results: list[dict[str, Any]] = []
        semantic_results: list[dict[str, Any]] = []
        if self._store._vector_store and self._store._vector_store.is_available():
            # 混合检索路径：FTS5 + ChromaDB 向量，RRF 融合
            fts_results = await self._store.search_hybrid(
                query, limit=limit * 2, scene_filter=scene,
                recent_hours=recent_hours,
                time_weight=fts_time_weight if recent_hours > 0 else 0.0,
            )
            # 混合检索已融合语义信息，semantic_results 置空避免重复
        else:
            # 原始路径：FTS + 语义搜索分别召回
            fts_results = self._store.search(
                query, limit=limit * 2, scene_filter=scene, recent_hours=recent_hours,
                time_weight=fts_time_weight if recent_hours > 0 else 0.0,
            )
            semantic_results = self._store.search_semantic(query, limit=limit * 2)
        episodic_results: list[dict[str, Any]] = []
        if scene != "episodic":
            try:
                episodic_results = self._store.search(
                    query, limit=3, scene_filter="episodic",
                    time_weight=episodic_time_weight,
                )
            except Exception as _exc:
                log.debug("engine 异常处理", error=str(_exc))
                log_ignored(log, "engine.MemoryEngine.search_with_context", _exc)

        # P2-3: 同时查询 EpisodicMemoryStore (情景记忆)
        if self._episodic_store:
            try:
                em_result = self._episodic_store.retrieve(
                    query=query, limit=3,
                )
                for em in (em_result.episodes if hasattr(em_result, 'episodes') else []):
                    episodic_results.append({
                        "id": em.id,
                        "content": em.content,
                        "memory_type": "episodic",
                        "scene": em.scene.value if hasattr(em.scene, 'value') else str(em.scene),
                        "emotion": em.emotion.value if hasattr(em.emotion, 'value') else str(em.emotion),
                        "timestamp": em.timestamp,
                        "importance": em.importance,
                        "tags": em.tags,
                        "relevance_score": episodic_relevance,
                        "source": "episodic_store",
                    })
            except Exception as _exc:
                log.debug("engine 异常处理", error=str(_exc))
                log_ignored(log, "engine.MemoryEngine.search_with_context", _exc)

        merged: dict[str, dict[str, Any]] = {}
        for item in fts_results:
            merged[item["id"]] = {**item, "source": "fts"}
        for item in semantic_results:
            if item["id"] in merged:
                existing = merged[item["id"]]
                existing["relevance_score"] = max(
                    existing["relevance_score"], item["relevance_score"]
                )
                if "semantic" not in existing.get("sources", ""):
                    existing["sources"] = existing.get("sources", "fts") + ",semantic"
            else:
                merged[item["id"]] = {**item, "source": "semantic"}
        for item in episodic_results:
            eid = item.get("id")
            if eid and eid not in merged:
                merged[eid] = {**item, "source": "episodic"}

        # P2-12: 多模态联合召回 — 跨模态记忆通过向量相似度合并
        multimodal_results: list[dict[str, Any]] = []
        if include_multimodal:
            try:
                multimodal_results = await self.search_multimodal(
                    query=query, limit=min(limit, 5)
                )
            except Exception as exc:
                log.debug("多模态召回失败，跳过", error=str(exc))
        for item in multimodal_results:
            mid = item.get("id")
            if not mid:
                continue
            if mid in merged:
                # 已存在的项取较高分数并标记多模态来源
                existing = merged[mid]
                existing["relevance_score"] = max(
                    existing["relevance_score"],
                    float(item.get("relevance_score", 0.0)),
                )
                if "multimodal" not in existing.get("sources", ""):
                    existing["sources"] = existing.get("sources", "") + ",multimodal"
            else:
                merged[mid] = {**item, "source": "multimodal"}

        results = sorted(merged.values(), key=lambda x: x["relevance_score"], reverse=True)

        deduped: list[dict[str, Any]] = []
        seen_content_hashes: set[str] = set()
        for r in results:
            content = r.get("content", "")
            content_hash = hashlib.md5(content.strip().lower().encode("utf-8")).hexdigest()
            if content_hash not in seen_content_hashes:
                seen_content_hashes.add(content_hash)
                deduped.append(r)
        results = deduped

        # ─── 审计 D-01：TTL 过期过滤 — 即时/短期记忆按 expires_at 过滤 ───
        now = time.time()
        results = [
            r for r in results
            if self._is_memory_fresh(r, now)
        ]

        # P1-3: 时效衰减 — 近期记忆获得权重提升
        if use_recency_decay and results:
            now = time.time()
            decay_window = 86400 * decay_window_days
            for r in results:
                ts = r.get("timestamp", now)
                age_hours = (now - ts) / 3600 if ts else 0
                if age_hours > 0 and age_hours < decay_window_days * 24:
                    decay_boost = 1.0 + decay_boost_max * (1.0 - age_hours / (decay_window_days * 24))
                    r["relevance_score"] = min(r["relevance_score"] * decay_boost, 1.0)
                    r["decay_boost"] = round(decay_boost, 2)

            # 按调整后的分数重新排序
            results = sorted(results, key=lambda x: x["relevance_score"], reverse=True)

        # M2: 记忆分层加权 — 短期记忆时效性高权重，长期记忆稳定性高权重，情景记忆情境相关性高权重
        _TIER_WEIGHTS = {
            "instant": {"recency": 1.5, "stability": 0.5, "contextuality": 0.8},
            "short_term": {"recency": 1.3, "stability": 0.7, "contextuality": 0.9},
            "episodic": {"recency": 0.8, "stability": 0.6, "contextuality": 1.4},
            "long_term": {"recency": 0.5, "stability": 1.3, "contextuality": 1.0},
            "knowledge": {"recency": 0.3, "stability": 1.5, "contextuality": 0.8},
        }
        for r in results:
            _mt = r.get("memory_type", "long_term")
            _tier_w = _TIER_WEIGHTS.get(_mt, _TIER_WEIGHTS["long_term"])
            _recency_factor = 1.0
            _ts = r.get("timestamp", 0)
            if _ts:
                _age_hours = (time.time() - _ts) / 3600
                _recency_factor = max(0.5, 1.0 - _age_hours / 168)
            _scene_match = 1.0
            if scene and r.get("scene"):
                _scene_match = 1.3 if scene == r.get("scene") else 0.9
            _layered_score = r["relevance_score"] * (
                _tier_w["recency"] * _recency_factor
                + _tier_w["stability"] * (1.0 - _recency_factor * 0.3)
                + _tier_w["contextuality"] * (_scene_match - 0.7)
            ) / 2.0
            r["relevance_score"] = min(_layered_score, 1.0)
            r["tier_weight_applied"] = True
        results = sorted(results, key=lambda x: x["relevance_score"], reverse=True)

        # P1-3: 知识图谱增强 — 展开关联记忆
        if use_knowledge_graph and results:
            try:
                kg_entries = self._store.get_related_entries(
                    [r["id"] for r in results[:3]],
                    max_depth=1,
                    limit=5,
                )
                for kg_entry in kg_entries:
                    eid = kg_entry.get("id")
                    if eid and eid not in merged:
                        kg_entry["relevance_score"] = kg_entry.get("relevance_score", 0.4) * kg_relevance_factor
                        kg_entry["source"] = "knowledge_graph"
                        results.append(kg_entry)
            except Exception as _exc:
                log.debug("engine 异常处理", error=str(_exc))
                log_ignored(log, "engine.MemoryEngine.search_with_context", _exc)

        for r in results[:limit]:
            log.debug(
                "Memory result",
                id=r["id"][:8],
                score=r["relevance_score"],
                source=r.get("source", ""),
                type=r.get("memory_type", ""),
            )

        final_results = results[:limit]

        # 审计 P1-4：快照冻结 — 追加 frozen_at 时间戳
        final_results = self._with_frozen_at(final_results)

        # Redis 缓存：未命中则回填
        if self._redis_cache is not None and cache_key and final_results:
            try:
                await self._redis_cache.set(
                    cache_key, final_results, ttl=_SEARCH_CACHE_TTL
                )
            except Exception as exc:
                log.warning("Redis 缓存回填失败", error=str(exc))

        return final_results

    async def get_recent(
        self,
        hours: float = 24.0,
        memory_type: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """获取最近 N 小时的记忆，启用 Redis 时先查缓存再回填。

        Args:
            hours: 时间窗口（小时）。
            memory_type: 可选的记忆类型过滤。
            limit: 最大返回数。

        Returns:
            list[dict[str, Any]]: 按时间倒序排列的记忆列表。
        """
        # Redis 缓存：先查
        cache_key: Optional[str] = None
        if self._redis_cache is not None:
            try:
                cache_key = self._build_search_cache_key(
                    _RECENT_CACHE_PREFIX,
                    hours,
                    memory_type,
                    limit,
                )
                cached = await self._redis_cache.get(cache_key)
                if cached is not None:
                    log.debug("Redis 缓存命中 get_recent", hours=hours)
                    return cached
            except Exception as exc:
                log.warning("Redis 缓存读取失败", error=str(exc))

        results = self._store.get_recent(hours, memory_type, limit)

        # Redis 缓存：未命中则回填
        if self._redis_cache is not None and cache_key and results:
            try:
                await self._redis_cache.set(
                    cache_key, results, ttl=_SEARCH_CACHE_TTL
                )
            except Exception as exc:
                log.warning("Redis 缓存回填失败", error=str(exc))

        return results

    async def store_episodic(
        self,
        event: str,
        participants: list[str] | None = None,
        outcome: str = "",
        emotion: str = "neutral",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """存储情景记忆，写入 SQLite 后同步到 Redis 缓存。

        Args:
            event: 事件描述。
            participants: 参与者列表。
            outcome: 事件结果。
            emotion: 情绪标签。
            metadata: 额外元数据。

        Returns:
            str: 新建记忆条目的 ID。
        """
        parts = [f"事件: {event}"]
        if participants:
            parts.append(f"参与者: {', '.join(participants)}")
        if outcome:
            parts.append(f"结果: {outcome}")
        content = " | ".join(parts)

        meta = metadata or {}
        meta["episodic"] = True
        meta["participants"] = participants or []
        meta["outcome"] = outcome
        meta["stored_at"] = time.time()

        mem_id = self._store.store(content, "long_term", "episodic", emotion, meta)

        # 写入 SQLite 后同步写入 Redis 单条记忆缓存
        if self._redis_cache is not None and mem_id:
            try:
                cache_key = f"{_MEMORY_ITEM_PREFIX}{mem_id}"
                cache_value = {
                    "id": mem_id,
                    "content": content,
                    "memory_type": "long_term",
                    "scene": "episodic",
                    "emotion": emotion,
                    "metadata": meta,
                    "stored_at": time.time(),
                }
                await self._redis_cache.set(
                    cache_key, cache_value, ttl=_MEMORY_ITEM_TTL
                )
                # 失效相关搜索缓存（保守做法：删除情景搜索缓存键）
                # 由于缓存键使用哈希，无法精确删除，依靠 TTL 自然过期
            except Exception as exc:
                log.warning("Redis 缓存写入失败", error=str(exc))

        return mem_id

    async def search_episodic(
        self,
        query: str,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        """搜索情景记忆，启用 Redis 时先查缓存再回填。

        Args:
            query: 搜索查询。
            limit: 最大返回数。

        Returns:
            list[dict[str, Any]]: 匹配的情景记忆列表。
        """
        # Redis 缓存：先查
        cache_key: Optional[str] = None
        if self._redis_cache is not None:
            try:
                cache_key = self._build_search_cache_key(
                    _EPISODIC_CACHE_PREFIX,
                    query,
                    limit,
                )
                cached = await self._redis_cache.get(cache_key)
                if cached is not None:
                    log.debug("Redis 缓存命中 search_episodic", query=query[:50])
                    return cached
            except Exception as exc:
                log.warning("Redis 缓存读取失败", error=str(exc))

        results = self._store.search(
            query, limit=limit, scene_filter="episodic", time_weight=0.2,
        )
        filtered = [r for r in results if r.get("metadata", {}).get("episodic")]

        # Redis 缓存：未命中则回填
        if self._redis_cache is not None and cache_key and filtered:
            try:
                await self._redis_cache.set(
                    cache_key, filtered, ttl=_SEARCH_CACHE_TTL
                )
            except Exception as exc:
                log.warning("Redis 缓存回填失败", error=str(exc))

        return filtered

    async def get_stats(self) -> dict[str, Any]:
        stats = self._store.get_stats()
        if self._episodic_store:
            try:
                episodic_stats = self._episodic_store.get_stats()
                stats["episodic"] = episodic_stats
            except Exception as _exc:
                log.debug("engine 异常处理", error=str(_exc))
                log_ignored(log, "engine.MemoryEngine.get_stats", _exc)
        return stats

    # ─── 记忆 TTL 配置（审计 D-01：即时/短期记忆边界模糊） ───
    _MEMORY_TTL_MAP: dict[str, int] = {
        "instant": 300,       # 即时记忆：5 分钟
        "short_term": 86400,  # 短期记忆：24 小时
        "long_term": 0,       # 长期记忆：永不过期（0 = 无 TTL）
    }

    # ─── 审计 P0-2：记忆写入审批门 ───
    _write_gate_enabled: bool = False
    _pending_writes: list[dict[str, Any]] = []
    _MAX_PENDING_WRITES: int = 1000

    @classmethod
    def enable_write_gate(cls) -> None:
        """开启写入审批门。Agent 写入暂存，需人工审批。"""
        cls._write_gate_enabled = True
        log.info("记忆写入审批门已开启")

    @classmethod
    def disable_write_gate(cls) -> None:
        """关闭写入审批门。Agent 写入直通。"""
        cls._write_gate_enabled = False
        cls._pending_writes.clear()
        log.info("记忆写入审批门已关闭")

    @classmethod
    def is_write_gate_enabled(cls) -> bool:
        return cls._write_gate_enabled

    @classmethod
    def get_pending_writes(cls) -> list[dict[str, Any]]:
        """获取待审批的写入列表。"""
        return list(cls._pending_writes)

    @classmethod
    def approve_write(cls, write_id: str) -> dict[str, Any] | None:
        """审批通过一条写入。"""
        for i, w in enumerate(cls._pending_writes):
            if w.get("id") == write_id:
                return cls._pending_writes.pop(i)
        return None

    @classmethod
    def reject_write(cls, write_id: str, reason: str = "") -> dict[str, Any] | None:
        """拒绝一条写入。"""
        for i, w in enumerate(cls._pending_writes):
            if w.get("id") == write_id:
                rejected = cls._pending_writes.pop(i)
                log.info("记忆写入被拒绝", write_id=write_id, reason=reason)
                return rejected
        return None

    @classmethod
    def approve_all_writes(cls) -> list[dict[str, Any]]:
        """审批通过所有待审批写入。"""
        approved = list(cls._pending_writes)
        cls._pending_writes.clear()
        return approved

    @staticmethod
    def _is_memory_fresh(item: dict[str, Any], now: float) -> bool:
        """检查记忆是否在 TTL 内有效。"""
        metadata = item.get("metadata")
        if not metadata:
            return True
        if isinstance(metadata, str):
            import json
            try:
                metadata = json.loads(metadata)
            except (json.JSONDecodeError, TypeError):
                return True
        expires_at = metadata.get("expires_at")
        if expires_at is None:
            return True
        return now < float(expires_at)

    # ─── 审计 P1-2：批量原子记忆操作 ───

    async def store_batch(
        self,
        items: list[dict[str, Any]],
    ) -> list[str]:
        """批量原子写入记忆。全部成功或全部回滚。

        Args:
            items: 记忆列表，每项含 content/memory_type/scene/emotion/metadata。

        Returns:
            写入成功的记忆 ID 列表。

        Raises:
            ValueError: 当 items 为空或某条 content 为空时。
        """
        if not items:
            raise ValueError("批量写入列表不能为空")

        for item in items:
            if not item.get("content", "").strip():
                raise ValueError("批量写入中某条记忆内容为空")

        ids = []
        try:
            for item in items:
                mem_id = await self.store(
                    content=item["content"],
                    memory_type=item.get("memory_type", "short_term"),
                    scene=item.get("scene", ""),
                    emotion=item.get("emotion", "neutral"),
                    metadata=item.get("metadata"),
                )
                ids.append(mem_id)
            log.info("批量记忆写入成功", count=len(ids))
            return ids
        except Exception as _exc:
            log.debug("engine 异常处理", error=str(_exc))
            # 删除已写入的条目
            for mid in ids:
                try:
                    self._store.delete_by_id(mid)
                except Exception as _exc:
                    log.debug("engine 异常处理", error=str(_exc))
                    log_ignored(log, "engine.MemoryEngine.store_batch", _exc)
            raise

    # ─── 审计 P1-4：记忆快照冻结 ───

    _snapshot_frozen_at: float | None = None

    @classmethod
    def freeze_snapshot(cls) -> None:
        """冻结当前记忆快照。后续修改不影响已搜索的结果。"""
        cls._snapshot_frozen_at = time.time()
        log.info("记忆快照已冻结", frozen_at=cls._snapshot_frozen_at)

    @classmethod
    def unfreeze_snapshot(cls) -> None:
        """解冻快照。"""
        cls._snapshot_frozen_at = None
        log.info("记忆快照已解冻")

    @classmethod
    def _with_frozen_at(cls, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """为搜索结果追加冻结时间戳。"""
        if cls._snapshot_frozen_at is not None:
            for r in results:
                r["frozen_at"] = cls._snapshot_frozen_at
        return results

    async def store_short_term(self, content: str, scene: str = "", emotion: str = "neutral") -> str:
        ttl = self._MEMORY_TTL_MAP.get("short_term", 0)
        meta = {"ttl_seconds": ttl, "expires_at": int(time.time() + ttl)} if ttl else {}
        return self._store.store(content, "short_term", scene, emotion, metadata=meta if meta else None)

    async def store_long_term(self, content: str, scene: str = "", emotion: str = "neutral") -> str:
        return self._store.store(content, "long_term", scene, emotion)

    async def store_instant(self, content: str, scene: str = "", emotion: str = "neutral") -> str:
        ttl = self._MEMORY_TTL_MAP.get("instant", 0)
        meta = {"ttl_seconds": ttl, "expires_at": int(time.time() + ttl)}
        return self._store.store(content, "instant", scene, emotion, metadata=meta)

    async def update(
        self,
        memory_id: str,
        content: str | None = None,
        scene: str | None = None,
        emotion: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        ok = self._store.update(memory_id, content=content, scene=scene, emotion=emotion, metadata=metadata)
        if not ok:
            raise ValueError(f"Memory {memory_id} not found")

        if self._redis_cache is not None:
            try:
                cache_key = f"{_MEMORY_ITEM_PREFIX}{memory_id}"
                await self._redis_cache.delete(cache_key)
                await self._redis_cache.delete_by_prefix(_SEARCH_CACHE_PREFIX)
            except Exception as exc:
                log.warning("Redis 缓存失效失败", error=str(exc))

    def get_user_profile(self) -> dict[str, Any]:
        results = self._store.search("用户偏好 用户画像 喜好", limit=50)
        profile: dict[str, Any] = {
            "preferences": [],
            "facts": [],
            "interaction_count": 0,
        }
        for r in results:
            content = r.get("content", "")
            mt = r.get("memory_type", "")
            if mt == "long_term" or "偏好" in content or "喜欢" in content or "讨厌" in content:
                profile["preferences"].append(content)
            else:
                profile["facts"].append(content)
        profile["interaction_count"] = self._store.get_stats().get("total_entries", 0)
        return profile

    # ─── P2 #12: 多模态联合编码集成 ───

    async def store_multimodal(
        self,
        content: str,
        image_path: str | None = None,
        memory_type: str = "long_term",
        scene: str = "multimodal",
        emotion: str = "neutral",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """存储多模态记忆，将文本与图像联合编码后写入存储。

        集成 MultimodalEncoder 将内容编码为向量，向量与图像路径写入 metadata，
        供后续 search_multimodal 进行跨模态检索。遵循"Python 主实现"原则，
        真正的跨模态向量编码在 Python 端完成，TS 侧仅做 HTTP 入口路由。

        Args:
            content: 文本内容。
            image_path: 可选的图像本地路径，提供时进行联合编码。
            memory_type: 记忆类型，默认 long_term。
            scene: 场景标签，默认 multimodal。
            emotion: 情绪标签。
            metadata: 额外元数据。

        Returns:
            str: 新建记忆条目的 ID。

        Raises:
            ValueError: 当 content 为空时抛出。
        """
        if not content:
            raise ValueError("content 不能为空")

        # 文本编码（始终执行）
        text_vec = self._multimodal_encoder.encode_text(content)
        meta = metadata or {}
        meta["multimodal"] = True
        meta["text_vector"] = text_vec.vector
        meta["text_model"] = text_vec.model_name
        meta["text_hash"] = text_vec.content_hash

        # 若提供图像，编码图像并记录路径
        if image_path:
            img_vec = self._multimodal_encoder.encode_image(image_path)
            meta["image_vector"] = img_vec.vector
            meta["image_model"] = img_vec.model_name
            meta["image_hash"] = img_vec.content_hash
            meta["image_path"] = image_path

        return await self.store(
            content=content,
            memory_type=memory_type,
            scene=scene,
            emotion=emotion,
            metadata=meta,
        )

    async def search_multimodal(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.0,
    ) -> list[dict[str, Any]]:
        """跨模态搜索：用文本查询在多模态记忆中检索最相似项。

        编码查询文本后，遍历带 multimodal 标记的记忆，对文本向量计算余弦相似度，
        兼顾图像向量（若存在则取文本/图像相似度的最大值）。

        Args:
            query: 查询文本。
            limit: 最大返回数。
            memory_type: 可选的记忆类型过滤。
            min_relevance: 最小相关度阈值。

        Returns:
            list[dict[str, Any]]: 按相关度降序的记忆列表，每项含 relevance_score。
        """
        if not query:
            return []

        query_vec = self._multimodal_encoder.encode_text(query)
        cos = MultimodalEncoder.cosine_similarity

        def _score(r: dict[str, Any]) -> float:
            """计算单条记忆与查询向量的跨模态相似度。"""
            meta = r.get("metadata", {}) or {}
            text_sim = cos(query_vec.vector, meta.get("text_vector", [])) \
                if meta.get("text_vector") else 0.0
            image_sim = cos(query_vec.vector, meta.get("image_vector", [])) \
                if meta.get("image_vector") else 0.0
            return max(text_sim, image_sim)

        def _accepts(r: dict[str, Any]) -> bool:
            """判断记忆是否为合格的多模态候选。"""
            meta = r.get("metadata", {}) or {}
            if not meta.get("multimodal"):
                return False
            if memory_type and r.get("memory_type") != memory_type:
                return False
            return True

        # 先用 FTS 召回带 multimodal 标记的候选（粗筛）
        candidates: list[dict[str, Any]] = []
        for r in self._store.search(query, limit=limit * 5, scene_filter=None):
            if not _accepts(r):
                continue
            score = _score(r)
            if score < min_relevance:
                continue
            r["relevance_score"] = round(float(score), 4)
            r["search_method"] = "multimodal"
            candidates.append(r)

        # 若 FTS 召回不足，扫描全部 multimodal 记忆计算向量相似度
        if len(candidates) < limit:
            seen_ids = {c["id"] for c in candidates}
            for r in self._store.get_recent(hours=87600, limit=500):
                if r["id"] in seen_ids or not _accepts(r):
                    continue
                score = _score(r)
                if score < min_relevance:
                    continue
                r["relevance_score"] = round(float(score), 4)
                r["search_method"] = "multimodal_fullscan"
                candidates.append(r)
                seen_ids.add(r["id"])

        candidates.sort(key=lambda x: x["relevance_score"], reverse=True)
        return candidates[:limit]

    # ═══════════════════════════════════════════════════════════
    # Memory 高级特性 — 衰减/做梦/知识图谱/加密/traceId
    # ═══════════════════════════════════════════════════════════

    # ─── 衰减计算 ─────────────────────────────────────────────

    DECAY_CONFIG = {
        "SHORT_TERM_HALF_LIFE": 24,
        "LONG_TERM_HALF_LIFE": 720,
        "ACCESS_BOOST": 0.15,
        "MAX_ACCESS_BOOST": 2.0,
        "DECAY_CLEANUP_THRESHOLD": 0.1,
        "DREAM_INTERVAL": 30 * 60,
        "DREAM_BATCH_SIZE": 100,
        "DEDUP_SIMILARITY_THRESHOLD": 0.8,
    }

    def calculate_decay_score(
        self,
        memory_type: str,
        timestamp: float,
        access_count: int = 0,
        importance: float = 5.0,
    ) -> float:
        now = time.time()
        age_hours = (now - timestamp) / 3600 if timestamp > 0 else 0

        half_life = (
            self.DECAY_CONFIG["LONG_TERM_HALF_LIFE"]
            if memory_type == "long_term"
            else self.DECAY_CONFIG["SHORT_TERM_HALF_LIFE"]
        )

        import math
        time_decay = math.exp(-0.693 * age_hours / half_life) if half_life > 0 else 1.0
        access_boost = min(
            1 + math.log1p(access_count) * self.DECAY_CONFIG["ACCESS_BOOST"],
            self.DECAY_CONFIG["MAX_ACCESS_BOOST"],
        )
        importance_boost = 1 + (importance / 10) * 0.5

        return min(1.0, time_decay * access_boost * importance_boost)

    async def update_decay_scores(self, batch_size: int = 100) -> int:
        updated = 0
        for mt in ("short_term", "long_term"):
            rows = self._store.search("", limit=batch_size, memory_type=mt)
            for r in rows:
                ts = r.get("timestamp", 0)
                if ts <= 0:
                    continue
                score = self.calculate_decay_score(mt, ts)
                meta = r.get("metadata", {}) or {}
                old_score = meta.get("decay_score")
                if old_score != score:
                    meta["decay_score"] = score
                    self._store.update(r["id"], metadata=meta)
                    updated += 1
        return updated

    # ─── 做梦机制（记忆整理）─────────────────────────────────

    _dream_stats: dict[str, Any] = {
        "total_dreams": 0,
        "memories_consolidated": 0,
        "memories_deduplicated": 0,
        "memories_decayed": 0,
        "last_dream_time": None,
    }

    async def perform_dream(self) -> dict[str, int]:
        import math as _math

        start = time.time()
        decayed = await self.update_decay_scores(self.DECAY_CONFIG["DREAM_BATCH_SIZE"])
        deduped = await self._dream_deduplication()
        consolidated = await self._dream_consolidation()
        cleaned = await self._dream_cleanup()

        self._dream_stats["total_dreams"] += 1
        self._dream_stats["memories_consolidated"] += consolidated
        self._dream_stats["memories_deduplicated"] += deduped
        self._dream_stats["memories_decayed"] += decayed
        self._dream_stats["last_dream_time"] = time.time()

        duration_ms = int((time.time() - start) * 1000)
        log.info(
            "Dream completed",
            decayed=decayed,
            deduped=deduped,
            consolidated=consolidated,
            cleaned=cleaned,
            duration_ms=duration_ms,
        )
        return {
            "decayed": decayed,
            "deduplicated": deduped,
            "consolidated": consolidated,
            "cleaned": cleaned,
            "duration_ms": duration_ms,
        }

    async def _dream_deduplication(self) -> int:
        deduped = 0
        stm = self._store.search("", limit=self.DECAY_CONFIG["DREAM_BATCH_SIZE"], memory_type="short_term")
        merged_ids: set[str] = set()

        for i, mem_a in enumerate(stm):
            if mem_a["id"] in merged_ids:
                continue
            text_a = mem_a.get("content", "")
            if not text_a:
                continue
            for j in range(i + 1, len(stm)):
                mem_b = stm[j]
                if mem_b["id"] in merged_ids:
                    continue
                text_b = mem_b.get("content", "")
                if not text_b:
                    continue
                sim = self._compute_text_similarity(text_a, text_b)
                if sim > self.DECAY_CONFIG["DEDUP_SIMILARITY_THRESHOLD"]:
                    older_id = mem_a["id"] if mem_a.get("timestamp", 0) < mem_b.get("timestamp", 0) else mem_b["id"]
                    merged_ids.add(older_id)
                    deduped += 1
                    if deduped >= 20:
                        break
            if deduped >= 20:
                break

        for mid in merged_ids:
            self._store.update(mid, metadata={"is_compressed": True, "merged_into": "dedup"})

        return deduped

    async def _dream_consolidation(self) -> int:
        consolidated = 0
        stm = self._store.search("", limit=self.DECAY_CONFIG["DREAM_BATCH_SIZE"], memory_type="short_term")
        for r in stm:
            meta = r.get("metadata", {}) or {}
            if meta.get("is_compressed"):
                continue
            ts = r.get("timestamp", 0)
            importance = meta.get("importance", 5.0)
            decay = self.calculate_decay_score("short_term", ts, importance=importance)
            if decay > 0.5 and importance >= 7:
                try:
                    await self.store_long_term(r.get("content", ""), r.get("scene", ""), r.get("emotion", "neutral"))
                    consolidated += 1
                except Exception as _exc:
                    log.debug("engine 异常处理", error=str(_exc))
                    log_ignored(log, "engine.MemoryEngine._dream_consolidation", _exc)
        return consolidated

    async def _dream_cleanup(self) -> int:
        cleaned = 0
        for mt in ("instant", "short_term"):
            rows = self._store.search("", limit=500, memory_type=mt)
            for r in rows:
                ts = r.get("timestamp", 0)
                if ts <= 0:
                    continue
                decay = self.calculate_decay_score(mt, ts)
                if decay < self.DECAY_CONFIG["DECAY_CLEANUP_THRESHOLD"]:
                    self._store.update(r["id"], metadata={"decay_score": decay, "pending_cleanup": True})
                    cleaned += 1
        return cleaned

    def _compute_text_similarity(self, a: str, b: str) -> float:
        if a == b:
            return 1.0
        if not a or not b:
            return 0.0
        tokens_a = set(self._tokenize_for_similarity(a))
        tokens_b = set(self._tokenize_for_similarity(b))
        if not tokens_a or not tokens_b:
            return 0.0
        intersection = tokens_a & tokens_b
        union = tokens_a | tokens_b
        return len(intersection) / len(union) if union else 0.0

    @staticmethod
    def _tokenize_for_similarity(text: str) -> list[str]:
        import re
        tokens: list[str] = []
        chinese = re.findall(r"[\u4e00-\u9fa5]{2,4}", text)
        tokens.extend(chinese)
        english = re.findall(r"[a-zA-Z]{2,}", text)
        tokens.extend(w.lower() for w in english)
        clean = re.sub(r"\s+", "", text)
        for i in range(len(clean) - 1):
            tokens.append(clean[i : i + 2])
        return tokens

    def get_dream_stats(self) -> dict[str, Any]:
        return dict(self._dream_stats)

    # ─── 知识图谱 ─────────────────────────────────────────────

    async def build_knowledge_graph(self, limit: int = 100) -> dict[str, Any]:
        rows = self._store.search("", limit=limit, memory_type="long_term")
        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []

        for r in rows:
            content = r.get("content", "")
            rid = r.get("id", "")
            nodes.append({
                "id": rid,
                "label": content[:50],
                "type": "entity",
                "weight": r.get("relevance", 0.5),
            })

        for i, na in enumerate(nodes):
            for nb in nodes[i + 1 :]:
                sim = self._compute_text_similarity(na["label"], nb["label"])
                if sim > 0.3:
                    edges.append({
                        "source": na["id"],
                        "target": nb["id"],
                        "label": f"sim:{sim:.2f}",
                        "weight": round(sim, 2),
                    })

        return {"nodes": nodes, "edges": edges}

    # ─── 加密存储 ─────────────────────────────────────────────

    _encryption_key: bytes | None = None

    def _get_encryption_key(self) -> bytes:
        if self._encryption_key is None:
            key_str = os.environ.get("MEMORY_ENCRYPTION_KEY", "default-memory-encryption-key-32b")
            self._encryption_key = hashlib.sha256(key_str.encode()).digest()
        return self._encryption_key

    def encrypt_content(self, plaintext: str) -> str:
        key = self._get_encryption_key()
        import base64
        xored = bytes(b ^ key[i % len(key)] for i, b in enumerate(plaintext.encode("utf-8")))
        return base64.b64encode(xored).decode("ascii")

    def decrypt_content(self, ciphertext: str) -> str:
        key = self._get_encryption_key()
        import base64
        xored = base64.b64decode(ciphertext)
        decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(xored))
        return decrypted.decode("utf-8")

    async def store_encrypted(self, content: str, memory_type: str = "long_term", scene: str = "", emotion: str = "neutral") -> str:
        encrypted = self.encrypt_content(content)
        return await self.store(content=encrypted, memory_type=memory_type, scene=scene, emotion=emotion, metadata={"encrypted": True})

    # ─── traceId 追踪 ─────────────────────────────────────────

    async def store_with_trace(
        self,
        content: str,
        trace_id: str,
        memory_type: str = "short_term",
        scene: str = "",
        emotion: str = "neutral",
    ) -> str:
        return await self.store(
            content=content,
            memory_type=memory_type,
            scene=scene,
            emotion=emotion,
            metadata={"trace_id": trace_id},
        )

    async def search_by_trace(self, trace_id: str) -> list[dict[str, Any]]:
        rows = self._store.get_recent(hours=87600, limit=500)
        results = []
        for r in rows:
            meta = r.get("metadata", {}) or {}
            if meta.get("trace_id") == trace_id:
                results.append(r)
        return results
