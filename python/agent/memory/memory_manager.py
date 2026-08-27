"""统一记忆管理器。

跨 LTM/STM/Episodic 的统一记忆管理：
  - 短期记忆（STM）：当前会话上下文，自动过期
  - 长期记忆（LTM）：跨会话持久化，按用户/主题索引
  - 情景记忆（Episodic）：事件序列，时间线组织
  - 统一读写接口
  - 记忆检索（语义/关键词/时间）
  - 记忆衰减与合并

与 MemoryProvider 的关系：
  - MemoryProvider 提供底层存储（Builtin/Honcho/Mem0）
  - MemoryManager 提供上层管理（分类/检索/衰减）
  - 两者分层协作

集成示例::

    from agent.memory.memory_manager import MemoryManager

    mgr = MemoryManager()
    await mgr.store("user_1", "用户喜欢 Python", memory_type="ltm")
    results = await mgr.retrieve("user_1", query="编程偏好", memory_type="ltm")
    logger.info(results[0].content)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("memory_manager")




class MemoryType(str, Enum):
    """记忆类型。"""

    STM = "stm"
    LTM = "ltm"
    EPISODIC = "episodic"


class RetrievalMode(str, Enum):
    """检索模式。"""

    SEMANTIC = "semantic"
    KEYWORD = "keyword"
    TEMPORAL = "temporal"
    HYBRID = "hybrid"


@dataclass
class MemoryItem:
    """记忆条目。

    Attributes:
        id: 条目 ID。
        user_id: 用户 ID。
        content: 内容。
        memory_type: 记忆类型。
        importance: 重要性（0-1）。
        tags: 标签。
        created_at: 创建时间。
        accessed_at: 最后访问时间。
        access_count: 访问次数。
        decay_factor: 衰减因子。
        metadata: 附加元数据。
    """

    id: str = ""
    user_id: str = ""
    content: str = ""
    memory_type: MemoryType = MemoryType.LTM
    importance: float = 0.5
    tags: list[str] = field(default_factory=list)
    created_at: float = 0.0
    accessed_at: float = 0.0
    access_count: int = 0
    decay_factor: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        now = time.time()
        if self.created_at == 0.0:
            self.created_at = now
        if self.accessed_at == 0.0:
            self.accessed_at = now

    @property
    def effective_importance(self) -> float:
        """有效重要性（考虑衰减）。"""
        return self.importance * self.decay_factor


@dataclass
class RetrievalResult:
    """检索结果。"""

    items: list[MemoryItem] = field(default_factory=list)
    total: int = 0
    query: str = ""


@dataclass
class MemoryStats:
    """记忆统计。"""

    stm_count: int = 0
    ltm_count: int = 0
    episodic_count: int = 0
    total_count: int = 0
    total_size_bytes: int = 0


STM_TTL: float = 3600.0
DECAY_RATE: float = 0.01
MAX_STM_PER_USER: int = 50
MAX_LTM_PER_USER: int = 500


class MemoryManager:
    """统一记忆管理器。

    跨 LTM/STM/Episodic 的统一记忆管理。
    """

    def __init__(self) -> None:
        self._stm: dict[str, list[MemoryItem]] = {}
        self._ltm: dict[str, list[MemoryItem]] = {}
        self._episodic: dict[str, list[MemoryItem]] = {}
        self._next_id = 1
        self._MAX_USERS = 5000
        self._MAX_ITEMS_PER_USER = 10000

    async def store(
        self,
        user_id: str,
        content: str,
        memory_type: MemoryType = MemoryType.LTM,
        importance: float = 0.5,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> MemoryItem:
        """存储记忆。

        Args:
            user_id: 用户 ID。
            content: 内容。
            memory_type: 记忆类型。
            importance: 重要性。
            tags: 标签。
            metadata: 附加元数据。

        Returns:
            MemoryItem 存储的记忆条目。
        """
        item_id = f"mem_{self._next_id}"
        self._next_id += 1

        item = MemoryItem(
            id=item_id,
            user_id=user_id,
            content=content,
            memory_type=memory_type,
            importance=importance,
            tags=tags or [],
            metadata=metadata or {},
        )

        store = self._get_store(memory_type)
        user_items = store.setdefault(user_id, [])
        if len(store) > self._MAX_USERS:
            oldest_users = list(store.keys())[: len(store) - (self._MAX_USERS * 3 // 4)]
            for uid in oldest_users:
                del store[uid]
        user_items.append(item)

        max_count = MAX_STM_PER_USER if memory_type == MemoryType.STM else MAX_LTM_PER_USER
        if len(user_items) > max_count:
            removed = user_items[: len(user_items) - max_count]
            store[user_id] = user_items[len(user_items) - max_count :]
            log.debug("Memory evicted", type=memory_type.value, count=len(removed))

        log.info("Memory stored", id=item_id, type=memory_type.value, user=user_id)
        return item

    async def retrieve(
        self,
        user_id: str,
        query: str = "",
        memory_type: MemoryType | None = None,
        mode: RetrievalMode = RetrievalMode.KEYWORD,
        limit: int = 10,
        min_importance: float = 0.0,
        tags: list[str] | None = None,
    ) -> RetrievalResult:
        """检索记忆。

        Args:
            user_id: 用户 ID。
            query: 查询文本。
            memory_type: 记忆类型（None 搜索全部）。
            mode: 检索模式。
            limit: 最大返回数。
            min_importance: 最小重要性。
            tags: 过滤标签。

        Returns:
            RetrievalResult 检索结果。
        """
        candidates: list[MemoryItem] = []

        if memory_type:
            store = self._get_store(memory_type)
            candidates = list(store.get(user_id, []))
        else:
            for store in (self._stm, self._ltm, self._episodic):
                candidates.extend(store.get(user_id, []))

        now = time.time()
        candidates = [c for c in candidates if self._is_valid(c, now)]

        if min_importance > 0:
            candidates = [c for c in candidates if c.effective_importance >= min_importance]

        if tags:
            tag_set = set(tags)
            candidates = [c for c in candidates if tag_set & set(c.tags)]

        if query and mode in (RetrievalMode.KEYWORD, RetrievalMode.HYBRID):
            scored: list[tuple[float, MemoryItem]] = []
            q_lower = query.lower()
            for c in candidates:
                score = 0.0
                if q_lower in c.content.lower():
                    score += 1.0
                for t in c.tags:
                    if q_lower in t.lower():
                        score += 0.5
                score *= c.effective_importance
                if score > 0:
                    scored.append((score, c))
            scored.sort(key=lambda x: x[0], reverse=True)
            candidates = [c for _, c in scored]
        else:
            candidates.sort(key=lambda c: c.effective_importance, reverse=True)

        results = candidates[:limit]

        for item in results:
            item.accessed_at = now
            item.access_count += 1

        return RetrievalResult(items=results, total=len(candidates), query=query)

    async def delete(self, user_id: str, item_id: str) -> bool:
        """删除记忆条目。"""
        for store in (self._stm, self._ltm, self._episodic):
            items = store.get(user_id, [])
            before = len(items)
            store[user_id] = [i for i in items if i.id != item_id]
            if len(store[user_id]) < before:
                return True
        return False

    async def decay(self, user_id: str) -> int:
        """执行记忆衰减。

        Returns:
            衰减的条目数。
        """
        now = time.time()
        decayed = 0

        for store in (self._stm, self._ltm, self._episodic):
            for item in store.get(user_id, []):
                elapsed = now - item.accessed_at
                item.decay_factor = max(0.01, item.decay_factor * (1 - DECAY_RATE * (elapsed / 86400)))
                if item.decay_factor < 0.05:
                    decayed += 1

        return decayed

    def get_stats(self, user_id: str = "") -> MemoryStats:
        """获取记忆统计。"""
        stm_count = sum(len(v) for v in self._stm.values()) if not user_id else len(self._stm.get(user_id, []))
        ltm_count = sum(len(v) for v in self._ltm.values()) if not user_id else len(self._ltm.get(user_id, []))
        epi_count = sum(len(v) for v in self._episodic.values()) if not user_id else len(self._episodic.get(user_id, []))

        return MemoryStats(
            stm_count=stm_count,
            ltm_count=ltm_count,
            episodic_count=epi_count,
            total_count=stm_count + ltm_count + epi_count,
        )

    def _get_store(self, memory_type: MemoryType) -> dict[str, list[MemoryItem]]:
        """获取对应类型的存储。"""
        if memory_type == MemoryType.STM:
            return self._stm
        elif memory_type == MemoryType.LTM:
            return self._ltm
        return self._episodic

    def _is_valid(self, item: MemoryItem, now: float) -> bool:
        """检查条目是否有效。"""
        if item.memory_type == MemoryType.STM:
            return (now - item.created_at) < STM_TTL
        return True