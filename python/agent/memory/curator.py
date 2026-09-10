from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("memory_curator")


@dataclass
class CuratorConfig:
    forget_threshold: float = 0.2
    max_memories: int = 10000
    consolidation_threshold: float = 0.5
    enable_auto_curate: bool = True


@dataclass
class ImportanceScore:
    total_score: float = 0.0
    frequency_score: float = 0.0
    recency_score: float = 0.0
    content_score: float = 0.0
    category: str = "normal"


class MemoryCurator:
    def __init__(self, config: CuratorConfig | None = None, memory: Any = None) -> None:
        self._config = config or CuratorConfig()
        self._memory = memory
        self._enabled = True
        self._usage_counts: dict[str, int] = {}
        self._last_access: dict[str, float] = {}
        self._importance_cache: dict[str, ImportanceScore] = {}
        self._last_curate_time: float = 0.0
        self._curate_interval: float = 60.0
        self._forgotten: set[str] = set()
        self._logger = log
        self._MAX_CACHED_IDS = 10000

    @property
    def enabled(self) -> bool:
        return self._enabled

    def record_usage(self, memory_id: str) -> None:
        self._usage_counts[memory_id] = self._usage_counts.get(memory_id, 0) + 1
        self._last_access[memory_id] = time.time()
        if len(self._usage_counts) > self._MAX_CACHED_IDS:
            sorted_ids = sorted(self._last_access.items(), key=lambda x: x[1])
            to_remove = sorted_ids[: len(self._usage_counts) - (self._MAX_CACHED_IDS * 3 // 4)]
            for mid, _ in to_remove:
                self._usage_counts.pop(mid, None)
                self._last_access.pop(mid, None)
                self._importance_cache.pop(mid, None)

    def assess_importance(
        self,
        memory_id: str = "",
        memory_content: str = "",
        memory_type: str = "general",
        metadata: dict[str, Any] | None = None,
    ) -> ImportanceScore:
        metadata = metadata or {}

        frequency = self._usage_counts.get(memory_id, 0)
        frequency_score = min(frequency / 10.0, 1.0)

        last_access = self._last_access.get(memory_id, 0)
        if last_access > 0:
            age_hours = (time.time() - last_access) / 3600
            recency_score = max(0.0, 1.0 - age_hours / 168)
        else:
            recency_score = 0.1

        content_score = 0.2
        if memory_type == "episodic":
            content_score += 0.15
        if metadata.get("important"):
            content_score += 0.25
        if len(memory_content) > 50:
            content_score += 0.1

        total_score = (frequency_score * 0.25 + recency_score * 0.15 + content_score * 0.6)

        if total_score >= 0.8:
            category = "critical"
        elif total_score >= 0.55:
            category = "important"
        elif total_score >= 0.3:
            category = "normal"
        elif total_score >= 0.1:
            category = "low"
        else:
            category = "obsolete"

        score = ImportanceScore(
            total_score=total_score,
            frequency_score=frequency_score,
            recency_score=recency_score,
            content_score=content_score,
            category=category,
        )
        self._importance_cache[memory_id] = score
        return score

    def curate(
        self,
        memories: list[dict[str, Any]],
        force: bool = False,
    ) -> dict[str, Any]:
        if not self._enabled and not force:
            return {"curated": False, "reason": "disabled"}

        if not force:
            elapsed = time.time() - self._last_curate_time
            if elapsed < self._curate_interval:
                return {"curated": False, "reason": "interval_not_reached"}

        self._last_curate_time = time.time()

        total = len(memories)
        to_consolidate = 0
        to_forget = 0
        importance_scores: list[float] = []

        forgotten_ids: list[str] = []
        consolidated_ids: list[str] = []

        for mem in memories:
            mem_id = mem.get("id", "")
            mem_type = mem.get("memory_type", mem.get("type", "general"))
            mem_content = mem.get("content", "")
            mem_metadata = mem.get("metadata", {})

            score = self.assess_importance(
                memory_id=mem_id,
                memory_content=mem_content,
                memory_type=mem_type,
                metadata=mem_metadata,
            )
            importance_scores.append(score.total_score)

            if score.total_score >= self._config.consolidation_threshold:
                to_consolidate += 1
                if self.consolidate_memory(mem_id):
                    consolidated_ids.append(mem_id)

            if score.total_score < self._config.forget_threshold:
                to_forget += 1
                if self.forget_memory(mem_id):
                    forgotten_ids.append(mem_id)

        avg_score = sum(importance_scores) / len(importance_scores) if importance_scores else 0.0

        self._logger.info(
            "Memory curation completed",
            total=total,
            consolidate=to_consolidate,
            forget=to_forget,
            avg_score=round(avg_score, 2),
        )

        return {
            "curated": True,
            "total_memories": total,
            "to_consolidate": to_consolidate,
            "to_forget": to_forget,
            "consolidated_ids": consolidated_ids,
            "forgotten_ids": forgotten_ids,
            "avg_importance_score": avg_score,
        }

    def consolidate_memory(self, memory_id: str) -> bool:
        self.record_usage(memory_id)
        if self._memory:
            try:
                store = getattr(self._memory, "_store", None)
                if store and hasattr(store, "update_memory_type"):
                    store.update_memory_type(memory_id, "long_term")
                    return True
            except Exception as _exc:
                log.debug("curator 异常处理", error=str(_exc))
                log_ignored(log, "curator.MemoryCurator.consolidate_memory", _exc)
        return True

    def forget_memory(self, memory_id: str) -> bool:
        if memory_id in self._forgotten:
            return False
        self._forgotten.add(memory_id)
        if len(self._forgotten) > self._MAX_CACHED_IDS:
            self._forgotten = set(list(self._forgotten)[len(self._forgotten) - (self._MAX_CACHED_IDS * 3 // 4):])
        self._usage_counts.pop(memory_id, None)
        self._last_access.pop(memory_id, None)
        self._importance_cache.pop(memory_id, None)
        if self._memory:
            try:
                store = getattr(self._memory, "_store", None)
                if store and hasattr(store, "delete"):
                    store.delete(memory_id)
            except Exception as _exc:
                log.debug("curator 异常处理", error=str(_exc))
                log_ignored(log, "curator.MemoryCurator.forget_memory", _exc)
        return True

    async def review(self) -> Any:
        """审查记忆库，返回审查结果。"""
        import dataclasses

        @dataclasses.dataclass
        class ReviewResult:
            reviewed: int = 0
            consolidated: int = 0
            forgotten: int = 0

        result = ReviewResult()
        if not self._memory:
            return result

        try:
            memories = await self._memory.search("", limit=1000)
            if not memories:
                return result

            result.reviewed = len(memories)
            curate_result = self.curate(memories, force=True)
            result.consolidated = curate_result.get("to_consolidate", 0)
            result.forgotten = curate_result.get("to_forget", 0)
        except Exception as e:
            self._logger.error("Review failed", error=str(e))

        return result

    async def generate_self_reminder(self, context: str = "") -> str | None:
        """根据记忆库内容生成自我提醒。

        Args:
            context: 上下文关键词，用于筛选相关记忆

        Returns:
            提醒文本，如果没有需要提醒的内容则返回 None
        """
        if not self._memory:
            return None

        try:
            if context:
                memories = await self._memory.search(context, limit=20)
            else:
                store = getattr(self._memory, "_store", None)
                if store and hasattr(store, "get_recent"):
                    memories = store.get_recent(hours=168, limit=20)
                else:
                    memories = await self._memory.search("*", limit=20)

            reminder_items: list[str] = []
            for mem in memories:
                content = mem.get("content", "")
                scene = mem.get("scene", "")
                if scene in ("schedule", "task", "reminder"):
                    reminder_items.append(content)
                elif any(kw in content for kw in ("提醒", "会议", "待办", "deadline", "重要")):
                    reminder_items.append(content)

            if not reminder_items:
                return None

            return "自我提醒：\n" + "\n".join(f"- {item}" for item in reminder_items[:5])
        except Exception as e:
            self._logger.error("Generate self reminder failed", error=str(e))
            return None


Curator = MemoryCurator
