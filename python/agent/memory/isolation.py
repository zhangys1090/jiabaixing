"""子 Agent 记忆隔离 (Sub-Agent Memory Isolation)。

解决子Agent扇出时共享 memoryEngine 导致的记忆污染问题。
每个子Agent持有独立的 MemorySnapshot，写操作先到本地，
聚合时按策略合并到主记忆。

隔离级别:
  - FULL:     完全隔离，子Agent不可见主记忆
  - READ_ONLY: 子Agent可读主记忆但不可写
  - SNAPSHOT:  子Agent获得主记忆快照，写操作到本地，聚合时合并

Usage:
    isolator = SubAgentMemoryIsolator(main_memory=governor)
    snapshot = isolator.create_snapshot(agent_id="researcher")
    # ... 子Agent运行，写入 snapshot ...
    isolator.merge_snapshot("researcher", strategy=MergeStrategy.APPEND)
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("memory_isolation")


class IsolationLevel(str, Enum):
    FULL = "full"
    READ_ONLY = "read_only"
    SNAPSHOT = "snapshot"


class MergeStrategy(str, Enum):
    APPEND = "append"
    MERGE_DEDUP = "merge_dedup"
    PRIORITY = "priority"
    VOTE = "vote"


@dataclass
class MemoryEntry:
    entry_id: str = ""
    content: str = ""
    importance: float = 1.0
    source_agent: str = ""
    timestamp: float = 0.0
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class MemorySnapshot:
    snapshot_id: str = ""
    agent_id: str = ""
    isolation_level: IsolationLevel = IsolationLevel.SNAPSHOT
    entries: list[MemoryEntry] = field(default_factory=list)
    read_only_entries: list[MemoryEntry] = field(default_factory=list)
    write_log: list[dict[str, Any]] = field(default_factory=list)
    created_at: float = 0.0
    merged: bool = False


@dataclass
class MergeResult:
    snapshot_id: str = ""
    agent_id: str = ""
    strategy: MergeStrategy = MergeStrategy.APPEND
    entries_merged: int = 0
    entries_deduped: int = 0
    entries_conflict: int = 0
    conflicts: list[dict[str, Any]] = field(default_factory=list)


class SubAgentMemoryIsolator:
    """子 Agent 记忆隔离器。

    Args:
        main_memory: 主记忆引擎实例（需支持 add_entry / search 接口）。
        default_isolation: 默认隔离级别。
        dedup_similarity_threshold: 去重相似度阈值。
    """

    def __init__(
        self,
        main_memory: Any = None,
        default_isolation: IsolationLevel = IsolationLevel.SNAPSHOT,
        dedup_similarity_threshold: float = 0.85,
    ) -> None:
        self._main_memory = main_memory
        self._default_isolation = default_isolation
        self._dedup_threshold = dedup_similarity_threshold
        self._snapshots: dict[str, MemorySnapshot] = {}

    def create_snapshot(
        self,
        agent_id: str,
        isolation_level: IsolationLevel | None = None,
        tags: list[str] | None = None,
    ) -> MemorySnapshot:
        level = isolation_level or self._default_isolation
        snapshot_id = f"snap_{uuid.uuid4().hex[:10]}"

        read_only_entries: list[MemoryEntry] = []
        if level in (IsolationLevel.READ_ONLY, IsolationLevel.SNAPSHOT):
            read_only_entries = self._read_main_memory(tags)

        snapshot = MemorySnapshot(
            snapshot_id=snapshot_id,
            agent_id=agent_id,
            isolation_level=level,
            read_only_entries=read_only_entries,
            created_at=time.time(),
        )

        self._snapshots[agent_id] = snapshot

        log.info(
            "创建子Agent记忆快照",
            agent_id=agent_id,
            snapshot_id=snapshot_id,
            isolation=level.value,
            read_only_count=len(read_only_entries),
        )
        return snapshot

    def write_to_snapshot(
        self,
        agent_id: str,
        content: str,
        importance: float = 1.0,
        tags: list[str] | None = None,
    ) -> MemoryEntry | None:
        snapshot = self._snapshots.get(agent_id)
        if not snapshot:
            log.warning("子Agent快照不存在", agent_id=agent_id)
            return None

        if snapshot.isolation_level == IsolationLevel.READ_ONLY:
            log.warning("只读隔离级别，写入被拒绝", agent_id=agent_id)
            return None

        if snapshot.merged:
            log.warning("快照已合并，写入被拒绝", agent_id=agent_id)
            return None

        entry = MemoryEntry(
            entry_id=f"me_{uuid.uuid4().hex[:8]}",
            content=content,
            importance=importance,
            source_agent=agent_id,
            timestamp=time.time(),
            tags=tags or [],
        )

        snapshot.entries.append(entry)
        snapshot.write_log.append({
            "action": "write",
            "entry_id": entry.entry_id,
            "timestamp": entry.timestamp,
        })

        return entry

    def read_from_snapshot(
        self,
        agent_id: str,
        query: str = "",
        limit: int = 10,
    ) -> list[MemoryEntry]:
        snapshot = self._snapshots.get(agent_id)
        if not snapshot:
            return []

        all_entries = list(snapshot.entries)

        if snapshot.isolation_level in (IsolationLevel.READ_ONLY, IsolationLevel.SNAPSHOT):
            all_entries.extend(snapshot.read_only_entries)

        if query:
            scored = []
            query_lower = query.lower()
            for entry in all_entries:
                score = 0.0
                if query_lower in entry.content.lower():
                    score += 0.5
                for tag in entry.tags:
                    if query_lower in tag.lower():
                        score += 0.3
                score += entry.importance * 0.2
                if score > 0:
                    scored.append((entry, score))

            scored.sort(key=lambda x: x[1], reverse=True)
            return [e for e, _ in scored[:limit]]

        return all_entries[-limit:]

    def merge_snapshot(
        self,
        agent_id: str,
        strategy: MergeStrategy = MergeStrategy.MERGE_DEDUP,
        priority_map: dict[str, float] | None = None,
    ) -> MergeResult:
        snapshot = self._snapshots.get(agent_id)
        if not snapshot:
            return MergeResult(agent_id=agent_id)

        if snapshot.merged:
            log.warning("快照已合并，跳过", agent_id=agent_id)
            return MergeResult(agent_id=agent_id)

        entries_to_merge = list(snapshot.entries)
        if not entries_to_merge:
            snapshot.merged = True
            return MergeResult(snapshot_id=snapshot.snapshot_id, agent_id=agent_id)

        merged_count = 0
        deduped_count = 0
        conflict_count = 0
        conflicts: list[dict[str, Any]] = []

        if strategy == MergeStrategy.APPEND:
            for entry in entries_to_merge:
                self._write_to_main(entry)
                merged_count += 1

        elif strategy == MergeStrategy.MERGE_DEDUP:
            for entry in entries_to_merge:
                is_dup = self._check_duplicate(entry)
                if is_dup:
                    deduped_count += 1
                else:
                    self._write_to_main(entry)
                    merged_count += 1

        elif strategy == MergeStrategy.PRIORITY:
            priorities = priority_map or {}
            for entry in entries_to_merge:
                agent_priority = priorities.get(entry.source_agent, 0.5)
                if agent_priority >= 0.5:
                    self._write_to_main(entry)
                    merged_count += 1
                else:
                    conflict_count += 1
                    conflicts.append({
                        "entry_id": entry.entry_id,
                        "reason": f"低优先级agent({entry.source_agent}): {agent_priority}",
                    })

        elif strategy == MergeStrategy.VOTE:
            content_groups: dict[str, list[MemoryEntry]] = {}
            for entry in entries_to_merge:
                key = entry.content[:50]
                content_groups.setdefault(key, []).append(entry)

            for key, group in content_groups.items():
                if len(group) >= 2:
                    best = max(group, key=lambda e: e.importance)
                    self._write_to_main(best)
                    merged_count += 1
                    deduped_count += len(group) - 1
                else:
                    self._write_to_main(group[0])
                    merged_count += 1

        snapshot.merged = True

        result = MergeResult(
            snapshot_id=snapshot.snapshot_id,
            agent_id=agent_id,
            strategy=strategy,
            entries_merged=merged_count,
            entries_deduped=deduped_count,
            entries_conflict=conflict_count,
            conflicts=conflicts,
        )

        log.info(
            "子Agent记忆合并完成",
            agent_id=agent_id,
            strategy=strategy.value,
            merged=merged_count,
            deduped=deduped_count,
            conflicts=conflict_count,
        )
        return result

    def merge_all(
        self,
        strategy: MergeStrategy = MergeStrategy.MERGE_DEDUP,
    ) -> list[MergeResult]:
        results: list[MergeResult] = []
        for agent_id in list(self._snapshots.keys()):
            if not self._snapshots[agent_id].merged:
                result = self.merge_snapshot(agent_id, strategy)
                results.append(result)
        return results

    def discard_snapshot(self, agent_id: str) -> bool:
        snapshot = self._snapshots.pop(agent_id, None)
        if snapshot and not snapshot.merged and snapshot.entries:
            log.info("丢弃子Agent未合并记忆", agent_id=agent_id, entries=len(snapshot.entries))
            return True
        return False

    def get_snapshot_info(self, agent_id: str) -> dict[str, Any] | None:
        snapshot = self._snapshots.get(agent_id)
        if not snapshot:
            return None
        return {
            "snapshot_id": snapshot.snapshot_id,
            "agent_id": snapshot.agent_id,
            "isolation_level": snapshot.isolation_level.value,
            "local_entries": len(snapshot.entries),
            "read_only_entries": len(snapshot.read_only_entries),
            "write_count": len(snapshot.write_log),
            "merged": snapshot.merged,
        }

    def _read_main_memory(self, tags: list[str] | None = None) -> list[MemoryEntry]:
        if not self._main_memory:
            return []

        try:
            search_fn = getattr(self._main_memory, "search", None)
            if callable(search_fn):
                query = " ".join(tags) if tags else ""
                results = search_fn(query=query, limit=50)
                if isinstance(results, list):
                    return [
                        MemoryEntry(
                            entry_id=str(i),
                            content=str(r.get("content", r)) if isinstance(r, dict) else str(r),
                            importance=float(r.get("importance", 1.0)) if isinstance(r, dict) else 1.0,
                        )
                        for i, r in enumerate(results)
                    ]
        except Exception as exc:
            log.warning("读取主记忆失败", error=str(exc))

        return []

    def _write_to_main(self, entry: MemoryEntry) -> None:
        if not self._main_memory:
            return

        try:
            add_fn = getattr(self._main_memory, "add_entry", None)
            if callable(add_fn):
                add_fn(
                    content=entry.content,
                    importance=entry.importance,
                    tags=entry.tags,
                    metadata={"source_agent": entry.source_agent, "entry_id": entry.entry_id},
                )
        except Exception as exc:
            log.warning("写入主记忆失败", entry_id=entry.entry_id, error=str(exc))

    def _check_duplicate(self, entry: MemoryEntry) -> bool:
        if not self._main_memory:
            return False

        try:
            search_fn = getattr(self._main_memory, "search", None)
            if callable(search_fn):
                results = search_fn(query=entry.content[:50], limit=5)
                if isinstance(results, list) and len(results) > 0:
                    for r in results:
                        existing = str(r.get("content", r)) if isinstance(r, dict) else str(r)
                        similarity = self._simple_similarity(entry.content, existing)
                        if similarity >= self._dedup_threshold:
                            return True
        except Exception:
            pass

        return False

    @staticmethod
    def _simple_similarity(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        a_words = set(a.lower().split())
        b_words = set(b.lower().split())
        if not a_words or not b_words:
            return 0.0
        intersection = a_words & b_words
        union = a_words | b_words
        return len(intersection) / len(union)
