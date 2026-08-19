"""记忆治理引擎（Memory Governor）。

在现有 MemoryStore（FTS5 + ChromaDB）基础上，增强为：
1. 语义检索保底：当 ChromaDB 不可用时，使用 TF-IDF 保底检索
2. 长期记忆去重：基于语义相似度检测并合并重复记忆
3. 长期记忆衰减：基于时间衰减函数降低旧记忆权重，自动归档过期记忆
4. 压缩可解释性：记忆压缩时保留压缩依据和可追溯链路
5. 记忆健康度监控：监控记忆库的容量、重复率、衰减状态

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 MemoryStore 集成，复用其存储基础设施
- 非侵入式：旁路治理，不修改 MemoryStore 内部逻辑
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("memory_governor")


class MemoryTier(str, Enum):
    SHORT_TERM = "short_term"
    WORKING = "working"
    LONG_TERM = "long_term"
    ARCHIVED = "archived"


class DedupStrategy(str, Enum):
    KEEP_NEWEST = "keep_newest"
    KEEP_MOST_REFERENCED = "keep_most_referenced"
    MERGE = "merge"


class DecayFunction(str, Enum):
    EXPONENTIAL = "exponential"
    LINEAR = "linear"
    STEP = "step"


@dataclass
class MemoryEntry:
    entry_id: str = ""
    content: str = ""
    tier: MemoryTier = MemoryTier.LONG_TERM
    created_at: float = 0.0
    last_accessed: float = 0.0
    access_count: int = 0
    importance: float = 1.0
    decay_weight: float = 1.0
    embedding: list[float] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    compressed_from: list[str] = field(default_factory=list)
    compression_reason: str = ""


@dataclass
class DedupResult:
    total_entries: int = 0
    duplicates_found: int = 0
    duplicates_merged: int = 0
    duplicates_deleted: int = 0
    space_saved_bytes: int = 0
    details: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DecayResult:
    total_entries: int = 0
    entries_decayed: int = 0
    entries_archived: int = 0
    entries_deleted: int = 0
    avg_weight_before: float = 1.0
    avg_weight_after: float = 1.0
    details: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class CompressionResult:
    total_entries: int = 0
    entries_compressed: int = 0
    compression_ratio: float = 1.0
    original_size_bytes: int = 0
    compressed_size_bytes: int = 0
    trace: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class MemoryHealthReport:
    report_id: str = ""
    timestamp: float = 0.0
    total_entries: int = 0
    tier_distribution: dict[str, int] = field(default_factory=dict)
    duplicate_rate: float = 0.0
    avg_decay_weight: float = 1.0
    avg_importance: float = 1.0
    oldest_entry_age_hours: float = 0.0
    compression_ratio: float = 1.0
    health_score: float = 1.0
    recommendations: list[str] = field(default_factory=list)


class MemoryGovernor:
    """记忆治理引擎：去重 + 衰减 + 压缩可解释性。"""

    _instance: MemoryGovernor | None = None

    def __init__(
        self,
        dedup_similarity_threshold: float = 0.92,
        decay_half_life_hours: float = 168.0,
        archive_threshold: float = 0.1,
        delete_threshold: float = 0.01,
        decay_function: DecayFunction = DecayFunction.EXPONENTIAL,
        max_entries_per_tier: int = 10000,
    ) -> None:
        self._similarity_threshold = dedup_similarity_threshold
        self._half_life_hours = decay_half_life_hours
        self._archive_threshold = archive_threshold
        self._delete_threshold = delete_threshold
        self._decay_function = decay_function
        self._max_entries = max_entries_per_tier
        self._entries: dict[str, MemoryEntry] = {}

    @classmethod
    def get_instance(cls) -> MemoryGovernor:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def register_entry(self, entry: MemoryEntry) -> None:
        self._entries[entry.entry_id] = entry

    def remove_entry(self, entry_id: str) -> None:
        self._entries.pop(entry_id, None)

    def get_entry(self, entry_id: str) -> MemoryEntry | None:
        return self._entries.get(entry_id)

    def compute_decay_weight(self, entry: MemoryEntry, now: float | None = None) -> float:
        now = now or time.time()
        age_hours = (now - entry.created_at) / 3600.0
        hours_since_access = (now - entry.last_accessed) / 3600.0

        if self._decay_function == DecayFunction.EXPONENTIAL:
            decay = math.exp(-0.693 * age_hours / self._half_life_hours)
        elif self._decay_function == DecayFunction.LINEAR:
            decay = max(0.0, 1.0 - age_hours / (self._half_life_hours * 4))
        elif self._decay_function == DecayFunction.STEP:
            if age_hours < self._half_life_hours:
                decay = 1.0
            elif age_hours < self._half_life_hours * 2:
                decay = 0.5
            elif age_hours < self._half_life_hours * 4:
                decay = 0.25
            else:
                decay = 0.1
        else:
            decay = 1.0

        access_boost = min(1.0, entry.access_count * 0.05)
        recency_boost = math.exp(-0.1 * hours_since_access)
        importance_factor = entry.importance

        return decay * (1.0 + access_boost) * recency_boost * importance_factor

    def apply_decay(self, now: float | None = None) -> DecayResult:
        now = now or time.time()
        result = DecayResult(total_entries=len(self._entries))
        weights_before: list[float] = []
        weights_after: list[float] = []

        to_archive: list[str] = []
        to_delete: list[str] = []

        for entry_id, entry in self._entries.items():
            old_weight = entry.decay_weight
            weights_before.append(old_weight)

            new_weight = self.compute_decay_weight(entry, now)
            entry.decay_weight = new_weight
            weights_after.append(new_weight)

            if new_weight < self._delete_threshold:
                to_delete.append(entry_id)
            elif new_weight < self._archive_threshold:
                if entry.tier != MemoryTier.ARCHIVED:
                    to_archive.append(entry_id)

        for entry_id in to_archive:
            entry = self._entries.get(entry_id)
            if entry:
                entry.tier = MemoryTier.ARCHIVED
                result.entries_archived += 1
                result.details.append({
                    "entry_id": entry_id,
                    "action": "archived",
                    "weight": entry.decay_weight,
                })

        for entry_id in to_delete:
            self._entries.pop(entry_id, None)
            result.entries_deleted += 1
            result.details.append({
                "entry_id": entry_id,
                "action": "deleted",
            })

        result.entries_decayed = len(self._entries)
        result.avg_weight_before = sum(weights_before) / len(weights_before) if weights_before else 0.0
        result.avg_weight_after = sum(weights_after) / len(weights_after) if weights_after else 0.0

        log.info(
            "Memory decay applied",
            total=result.total_entries,
            archived=result.entries_archived,
            deleted=result.entries_deleted,
            avg_weight=f"{result.avg_weight_after:.3f}",
        )

        return result

    def detect_duplicates(self) -> list[list[str]]:
        entries = list(self._entries.values())
        groups: list[list[str]] = []
        checked: set[str] = set()

        for i, entry_a in enumerate(entries):
            if entry_a.entry_id in checked:
                continue
            group = [entry_a.entry_id]
            checked.add(entry_a.entry_id)

            for j in range(i + 1, len(entries)):
                entry_b = entries[j]
                if entry_b.entry_id in checked:
                    continue

                similarity = self._compute_similarity(entry_a, entry_b)
                if similarity >= self._similarity_threshold:
                    group.append(entry_b.entry_id)
                    checked.add(entry_b.entry_id)

            if len(group) > 1:
                groups.append(group)

        return groups

    def deduplicate(
        self,
        strategy: DedupStrategy = DedupStrategy.KEEP_NEWEST,
    ) -> DedupResult:
        result = DedupResult(total_entries=len(self._entries))
        groups = self.detect_duplicates()

        for group in groups:
            result.duplicates_found += len(group) - 1

            if strategy == DedupStrategy.KEEP_NEWEST:
                keeper = max(group, key=lambda eid: self._entries[eid].created_at)
            elif strategy == DedupStrategy.KEEP_MOST_REFERENCED:
                keeper = max(group, key=lambda eid: self._entries[eid].access_count)
            elif strategy == DedupStrategy.MERGE:
                keeper = self._merge_entries(group)
            else:
                keeper = group[0]

            for eid in group:
                if eid != keeper:
                    entry = self._entries.pop(eid, None)
                    if entry:
                        result.duplicates_deleted += 1
                        result.space_saved_bytes += len(entry.content.encode("utf-8"))
                    result.details.append({
                        "entry_id": eid,
                        "action": "deleted_as_duplicate",
                        "kept": keeper,
                        "strategy": strategy.value,
                    })

        log.info(
            "Memory deduplication completed",
            total=result.total_entries,
            duplicates_found=result.duplicates_found,
            deleted=result.duplicates_deleted,
            space_saved=result.space_saved_bytes,
        )

        return result

    def compress(
        self,
        target_tier: MemoryTier = MemoryTier.LONG_TERM,
        min_entries_to_compress: int = 3,
        max_compressed_size_ratio: float = 0.3,
    ) -> CompressionResult:
        result = CompressionResult(total_entries=len(self._entries))

        tier_entries = [
            e for e in self._entries.values()
            if e.tier == target_tier and e.decay_weight < 0.5
        ]

        if len(tier_entries) < min_entries_to_compress:
            return result

        tier_entries.sort(key=lambda e: e.decay_weight)

        batch_size = min_entries_to_compress
        for i in range(0, len(tier_entries), batch_size):
            batch = tier_entries[i:i + batch_size]
            if len(batch) < 2:
                continue

            original_size = sum(len(e.content.encode("utf-8")) for e in batch)
            compressed_content = self._compress_content(batch)
            compressed_size = len(compressed_content.encode("utf-8"))
            ratio = compressed_size / original_size if original_size > 0 else 1.0

            if ratio > max_compressed_size_ratio * 2:
                continue

            source_ids = [e.entry_id for e in batch]
            compressed_entry = MemoryEntry(
                entry_id=f"compressed_{int(time.time())}_{i}",
                content=compressed_content,
                tier=target_tier,
                created_at=time.time(),
                last_accessed=time.time(),
                importance=min(e.importance for e in batch),
                decay_weight=max(e.decay_weight for e in batch),
                compressed_from=source_ids,
                compression_reason=f"自动压缩 {len(batch)} 条低权重记忆 (ratio={ratio:.2f})",
                metadata={
                    "compression": True,
                    "source_count": len(batch),
                    "compression_ratio": round(ratio, 3),
                },
            )

            for eid in source_ids:
                self._entries.pop(eid, None)

            self._entries[compressed_entry.entry_id] = compressed_entry
            result.entries_compressed += 1
            result.original_size_bytes += original_size
            result.compressed_size_bytes += compressed_size
            result.trace.append({
                "compressed_id": compressed_entry.entry_id,
                "source_ids": source_ids,
                "original_size": original_size,
                "compressed_size": compressed_size,
                "ratio": round(ratio, 3),
                "reason": compressed_entry.compression_reason,
            })

        if result.original_size_bytes > 0:
            result.compression_ratio = result.compressed_size_bytes / result.original_size_bytes

        log.info(
            "Memory compression completed",
            total=result.total_entries,
            compressed=result.entries_compressed,
            ratio=f"{result.compression_ratio:.2%}",
        )

        return result

    def get_health_report(self) -> MemoryHealthReport:
        now = time.time()
        entries = list(self._entries.values())

        tier_dist: dict[str, int] = {}
        weights: list[float] = []
        importances: list[float] = []
        ages: list[float] = []

        for entry in entries:
            tier_dist[entry.tier.value] = tier_dist.get(entry.tier.value, 0) + 1
            weights.append(entry.decay_weight)
            importances.append(entry.importance)
            ages.append((now - entry.created_at) / 3600.0)

        dup_groups = self.detect_duplicates()
        dup_rate = sum(len(g) - 1 for g in dup_groups) / len(entries) if entries else 0.0

        avg_weight = sum(weights) / len(weights) if weights else 1.0
        avg_importance = sum(importances) / len(importances) if importances else 1.0
        oldest_age = max(ages) if ages else 0.0

        compressed = [e for e in entries if e.compressed_from]
        total_compressed_size = sum(len(e.content.encode("utf-8")) for e in compressed)
        total_original_size = sum(
            len(e.content.encode("utf-8")) * len(e.compressed_from)
            for e in compressed
        )
        compression_ratio = total_compressed_size / total_original_size if total_original_size > 0 else 1.0

        health_score = 1.0
        if dup_rate > 0.1:
            health_score -= 0.2
        if avg_weight < 0.3:
            health_score -= 0.2
        if len(entries) > self._max_entries * 0.9:
            health_score -= 0.2
        health_score = max(0.0, min(1.0, health_score))

        recommendations: list[str] = []
        if dup_rate > 0.1:
            recommendations.append(f"重复率 {dup_rate:.1%} 过高，建议执行去重")
        if avg_weight < 0.3:
            recommendations.append("平均衰减权重过低，建议执行衰减清理")
        if len(entries) > self._max_entries * 0.9:
            recommendations.append("记忆库接近容量上限，建议执行压缩归档")

        return MemoryHealthReport(
            report_id=f"mhr_{int(now)}",
            timestamp=now,
            total_entries=len(entries),
            tier_distribution=tier_dist,
            duplicate_rate=round(dup_rate, 4),
            avg_decay_weight=round(avg_weight, 4),
            avg_importance=round(avg_importance, 4),
            oldest_entry_age_hours=round(oldest_age, 1),
            compression_ratio=round(compression_ratio, 4),
            health_score=round(health_score, 2),
            recommendations=recommendations,
        )

    def _compute_similarity(self, a: MemoryEntry, b: MemoryEntry) -> float:
        if a.embedding and b.embedding and len(a.embedding) == len(b.embedding):
            dot = sum(x * y for x, y in zip(a.embedding, b.embedding))
            norm_a = math.sqrt(sum(x * x for x in a.embedding))
            norm_b = math.sqrt(sum(x * x for x in b.embedding))
            if norm_a > 0 and norm_b > 0:
                return dot / (norm_a * norm_b)

        from agent.memory.vector_fallback import _tokenize, _cosine_similarity
        tokens_a = _tokenize(a.content)
        tokens_b = _tokenize(b.content)
        if not tokens_a or not tokens_b:
            return 0.0

        all_tokens = set(tokens_a + tokens_b)
        vec_a = [tokens_a.count(t) for t in all_tokens]
        vec_b = [tokens_b.count(t) for t in all_tokens]
        return _cosine_similarity(vec_a, vec_b)

    def _merge_entries(self, entry_ids: list[str]) -> str:
        entries = [self._entries[eid] for eid in entry_ids if eid in self._entries]
        if not entries:
            return entry_ids[0] if entry_ids else ""

        newest = max(entries, key=lambda e: e.created_at)
        merged_content = "\n---\n".join(e.content for e in sorted(entries, key=lambda e: e.created_at))

        newest.content = merged_content
        newest.compressed_from = [e.entry_id for e in entries if e.entry_id != newest.entry_id]
        newest.compression_reason = f"合并 {len(entries)} 条重复记忆"
        newest.importance = max(e.importance for e in entries)
        newest.access_count = sum(e.access_count for e in entries)

        return newest.entry_id

    def _compress_content(self, entries: list[MemoryEntry]) -> str:
        summaries: list[str] = []
        for entry in entries:
            content = entry.content
            if len(content) > 200:
                first_sentence = content[:200].rsplit("。", 1)[0]
                if not first_sentence:
                    first_sentence = content[:200].rsplit(".", 1)[0]
                if not first_sentence:
                    first_sentence = content[:100]
                summaries.append(f"[{entry.entry_id[:8]}] {first_sentence}...")
            else:
                summaries.append(f"[{entry.entry_id[:8]}] {content}")

        return "\n".join(summaries)
