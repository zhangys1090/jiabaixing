"""KnowledgeDecay — 知识衰减与淘汰机制。

根据时间衰减、访问频率、验证状态等维度，自动降低
过时知识的置信度，淘汰无效知识。

衰减策略：
- 时间衰减：知识越旧，置信度越低
- 访问增强：频繁访问的知识保持高置信度
- 验证强化：被后续操作验证的知识保持高置信度
- 冲突降级：与后续知识冲突的条目降低置信度

Usage:
    from agent.knowledge.knowledge_decay import KnowledgeDecay
    decay = KnowledgeDecay(store)
    pruned = await decay.run_decay_cycle()
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.knowledge.knowledge_store import KnowledgeStore
from agent.core.logger import StructuredLogger

log = StructuredLogger("knowledge_decay")



@dataclass
class DecayConfig:
    """衰减配置。

    Attributes:
        half_life_days: 置信度半衰期（天）。
        access_boost: 每次访问的置信度提升。
        max_access_boost: 访问提升上限。
        prune_threshold: 淘汰阈值（低于此值删除）。
        stale_threshold: 过时阈值（低于此值标记过时）。
        min_age_days: 最小年龄（天），低于此不衰减。
    """

    half_life_days: float = 90.0
    access_boost: float = 0.05
    max_access_boost: float = 0.3
    prune_threshold: float = 0.1
    stale_threshold: float = 0.3
    min_age_days: float = 7.0


@dataclass
class DecayResult:
    """衰减周期结果。

    Attributes:
        total: 总条目数。
        decayed: 衰减条目数。
        pruned: 淘汰条目数。
        boosted: 增强条目数。
        duration_ms: 耗时（毫秒）。
    """

    total: int = 0
    decayed: int = 0
    pruned: int = 0
    boosted: int = 0
    duration_ms: float = 0.0


class KnowledgeDecay:
    """知识衰减与淘汰管理器。

    定期运行衰减周期，根据时间和访问频率调整知识置信度，
    淘汰无效知识。

    Usage:
        decay = KnowledgeDecay(store)
        result = await decay.run_decay_cycle()
    """

    def __init__(
        self,
        store: KnowledgeStore,
        config: DecayConfig | None = None,
    ) -> None:
        self._store = store
        self._config = config or DecayConfig()
        self._last_decay_time: float = 0.0

    async def run_decay_cycle(self) -> DecayResult:
        """运行一次衰减周期。

        Returns:
            DecayResult: 衰减结果。
        """
        import asyncio
        start = asyncio.get_event_loop().time()

        total = await self._store.count()
        if total == 0:
            return DecayResult()

        entries = await self._store.list_entries(limit=total)
        now = time.time()

        decayed = 0
        pruned = 0
        boosted = 0

        for entry in entries:
            age_days = (now - entry.created_at) / 86400

            if age_days < self._config.min_age_days:
                continue

            new_confidence = self._compute_decayed_confidence(entry, now)

            access_boost = min(
                entry.access_count * self._config.access_boost,
                self._config.max_access_boost,
            )
            new_confidence = min(new_confidence + access_boost, 1.0)

            if new_confidence < self._config.prune_threshold:
                await self._store.delete(entry.id)
                pruned += 1
                continue

            if new_confidence < self._config.stale_threshold:
                await self._store.update(entry.id, confidence=new_confidence)
                decayed += 1
                continue

            if access_boost > 0.01:
                await self._store.update(entry.id, confidence=new_confidence)
                boosted += 1

        self._last_decay_time = now

        elapsed = (asyncio.get_event_loop().time() - start) * 1000
        result = DecayResult(
            total=total,
            decayed=decayed,
            pruned=pruned,
            boosted=boosted,
            duration_ms=elapsed,
        )

        log.info(
            "知识衰减周期完成",
            total=total, decayed=decayed, pruned=pruned,
            boosted=boosted, duration_ms=elapsed,
        )

        return result

    async def boost_knowledge(self, entry_id: str, amount: float = 0.1) -> bool:
        """手动增强知识置信度。

        Args:
            entry_id: 知识条目 ID。
            amount: 增强量。

        Returns:
            是否成功。
        """
        entry = await self._store.get(entry_id)
        if entry is None:
            return False

        new_confidence = min(entry.confidence + amount, 1.0)
        return await self._store.update(entry_id, confidence=new_confidence)

    async def decay_knowledge(self, entry_id: str, amount: float = 0.1) -> bool:
        """手动降低知识置信度。

        Args:
            entry_id: 知识条目 ID。
            amount: 降低量。

        Returns:
            是否成功。
        """
        entry = await self._store.get(entry_id)
        if entry is None:
            return False

        new_confidence = max(entry.confidence - amount, 0.0)
        if new_confidence < self._config.prune_threshold:
            return await self._store.delete(entry_id)

        return await self._store.update(entry_id, confidence=new_confidence)

    async def get_decay_candidates(self) -> list[dict[str, Any]]:
        """获取待衰减的知识条目。

        Returns:
            待衰减条目列表（含预测衰减后置信度）。
        """
        entries = await self._store.get_stale_entries(
            max_age_days=self._config.min_age_days,
        )

        now = time.time()
        candidates: list[dict[str, Any]] = []

        for entry in entries:
            predicted = self._compute_decayed_confidence(entry, now)
            if predicted < entry.confidence:
                candidates.append({
                    "id": entry.id,
                    "content": entry.content[:100],
                    "current_confidence": entry.confidence,
                    "predicted_confidence": predicted,
                    "age_days": (now - entry.created_at) / 86400,
                    "access_count": entry.access_count,
                })

        return candidates

    def _compute_decayed_confidence(self, entry: Any, now: float) -> float:
        """计算衰减后的置信度。

        使用指数衰减模型：
        confidence(t) = confidence_0 * 2^(-t / half_life)

        Args:
            entry: 知识条目。
            now: 当前时间戳。

        Returns:
            衰减后置信度。
        """
        age_days = (now - entry.created_at) / 86400
        half_life = self._config.half_life_days

        decay_factor = 2.0 ** (-age_days / half_life)
        return entry.confidence * decay_factor
