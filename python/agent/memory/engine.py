from __future__ import annotations

import time
from typing import Any

from agent.core.logger import StructuredLogger
from agent.memory.store import MemoryStore, set_semantic_engine_llm

log = StructuredLogger("memory_engine")


class MemoryEngine:
    def __init__(self, db_path: str | None = None, llm: Any = None) -> None:
        self._store = MemoryStore(db_path=db_path) if db_path else MemoryStore()
        self._episodic_store: Any | None = None
        if llm is not None:
            set_semantic_engine_llm(llm)

    def set_episodic_store(self, store: Any) -> None:
        """P2-3: 注册 EpisodicMemoryStore，使其结果可被 search_with_context 发现。"""
        self._episodic_store = store

    async def initialize(self) -> None:
        stats = self._store.get_stats()
        log.info("Memory Engine initialized", **stats)

    async def store(
        self,
        content: str,
        memory_type: str = "short_term",
        scene: str = "",
        emotion: str = "neutral",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        return self._store.store(content, memory_type, scene, emotion, metadata)

    async def search(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.0,
    ) -> list[dict[str, Any]]:
        return self._store.search(query, limit, memory_type, min_relevance)

    async def search_semantic(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        min_relevance: float = 0.3,
    ) -> list[dict[str, Any]]:
        return self._store.search_semantic(query, limit, memory_type, min_relevance)

    async def search_with_context(
        self,
        query: str,
        scene: str | None = None,
        recent_hours: float = 0.0,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        fts_results = self._store.search(
            query, limit=limit * 2, scene_filter=scene, recent_hours=recent_hours,
            time_weight=0.3 if recent_hours > 0 else 0.0,
        )
        semantic_results = self._store.search_semantic(query, limit=limit * 2)
        episodic_results: list[dict[str, Any]] = []
        if scene != "episodic":
            try:
                episodic_results = self._store.search(
                    query, limit=3, scene_filter="episodic", time_weight=0.2,
                )
            except Exception:
                pass

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
                        "relevance_score": 0.6,
                        "source": "episodic_store",
                    })
            except Exception:
                pass

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

        results = sorted(merged.values(), key=lambda x: x["relevance_score"], reverse=True)

        for r in results[:limit]:
            log.debug(
                "Memory result",
                id=r["id"][:8],
                score=r["relevance_score"],
                source=r.get("source", ""),
                type=r.get("memory_type", ""),
            )

        return results[:limit]

    async def get_recent(
        self,
        hours: float = 24.0,
        memory_type: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        return self._store.get_recent(hours, memory_type, limit)

    async def store_episodic(
        self,
        event: str,
        participants: list[str] | None = None,
        outcome: str = "",
        emotion: str = "neutral",
        metadata: dict[str, Any] | None = None,
    ) -> str:
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

        return self._store.store(content, "long_term", "episodic", emotion, meta)

    async def search_episodic(
        self,
        query: str,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        results = self._store.search(
            query, limit=limit, scene_filter="episodic", time_weight=0.2,
        )
        return [r for r in results if r.get("metadata", {}).get("episodic")]

    async def get_stats(self) -> dict[str, Any]:
        return self._store.get_stats()

    async def store_short_term(self, content: str, scene: str = "", emotion: str = "neutral") -> str:
        return self._store.store(content, "short_term", scene, emotion)

    async def store_long_term(self, content: str, scene: str = "", emotion: str = "neutral") -> str:
        return self._store.store(content, "long_term", scene, emotion)

    async def store_instant(self, content: str, scene: str = "", emotion: str = "neutral") -> str:
        return self._store.store(content, "instant", scene, emotion)
