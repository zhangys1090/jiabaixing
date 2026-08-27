"""跨维度记忆检索器。

融合关键字、语义、时间三个维度的检索结果，通过倒数排序融合（RRF）
和加权评分实现跨维度记忆检索。

核心策略:
- 关键字维度（FTS5/精确匹配）: 高分精确匹配
- 语义维度（向量嵌入）: 语义相似度匹配
- 时间维度（访问频率/衰减）: 最近/经常访问的记忆优先级更高
- 融合: RRF 算法 + 加权线性组合，确保多维度互补

Usage:
    retriever = CrossDimensionRetriever(memory_manager, semantic_engine)
    results = await retriever.retrieve(
        user_id="user_1",
        query="Python编程偏好",
        dimensions=["keyword", "semantic", "temporal"],
        limit=10,
    )
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
log = StructuredLogger("cross_dimension_retriever")



@dataclass
class CrossDimensionResult:
    """跨维度检索结果。

    Attributes:
        items: 检索到的记忆条目列表。
        total: 候选总数。
        query: 原始查询。
        dimension_scores: 各维度的贡献分数。
        fusion_info: 融合信息说明。
    """

    items: list[dict] = field(default_factory=list)
    total: int = 0
    query: str = ""
    dimension_scores: dict[str, float] = field(default_factory=dict)
    fusion_info: dict[str, Any] = field(default_factory=dict)


class CrossDimensionRetriever:
    """跨维度记忆检索器。

    融合关键字、语义、时间三个维度的检索结果，通过 RRF
    和加权评分实现更精准的记忆检索。

    支持维度:
    - keyword: 关键字匹配（FTS5 全文搜索 + 精确匹配）
    - semantic: 语义向量相似度检索
    - temporal: 时间衰减/访问频率评分
    """

    _DEFAULT_WEIGHTS = {
        "keyword": 0.40,
        "semantic": 0.35,
        "temporal": 0.25,
    }

    _DIMENSION_WEIGHTS_BY_TASK = {
        "coding": {"keyword": 0.45, "semantic": 0.30, "temporal": 0.25},
        "analysis": {"keyword": 0.25, "semantic": 0.50, "temporal": 0.25},
        "conversation": {"keyword": 0.25, "semantic": 0.35, "temporal": 0.40},
        "search": {"keyword": 0.50, "semantic": 0.30, "temporal": 0.20},
        "general": {"keyword": 0.40, "semantic": 0.35, "temporal": 0.25},
    }

    def __init__(
        self,
        memory_manager: Any = None,
        semantic_engine: Any = None,
        rrf_k: int = 60,
        task_type: str = "general",
    ) -> None:
        self._memory_manager = memory_manager
        self._semantic_engine = semantic_engine
        self._rrf_k = rrf_k
        self._task_type = task_type

    async def retrieve(
        self,
        user_id: str,
        query: str = "",
        dimensions: list[str] | None = None,
        limit: int = 10,
        min_importance: float = 0.0,
        tags: list[str] | None = None,
        memory_type: str | None = None,
    ) -> CrossDimensionResult:
        """跨维度检索记忆。

        Args:
            user_id: 用户 ID。
            query: 查询文本。
            dimensions: 使用的维度列表，默认全部。
            limit: 最大返回数。
            min_importance: 最小重要性阈值。
            tags: 过滤标签。
            memory_type: 记忆类型过滤。

        Returns:
            CrossDimensionResult: 检索结果。
        """
        if dimensions is None:
            dimensions = ["keyword", "semantic", "temporal"]

        weights = self._DIMENSION_WEIGHTS_BY_TASK.get(
            self._task_type, self._DEFAULT_WEIGHTS
        )

        active_weights = {
            d: weights.get(d, 0.0) for d in dimensions
        }
        weight_sum = sum(active_weights.values())
        if weight_sum > 0:
            active_weights = {k: v / weight_sum for k, v in active_weights.items()}

        candidates = await self._collect_candidates(
            user_id, memory_type, min_importance, tags
        )

        if not candidates:
            return CrossDimensionResult(
                items=[],
                total=0,
                query=query,
                dimension_scores={},
                fusion_info={"dimensions": dimensions, "candidates": 0},
            )

        dimension_scores = {
            "keyword": {},
            "semantic": {},
            "temporal": {},
        }
        fusion_info = {
            "dimensions": dimensions,
            "candidates": len(candidates),
            "rrf_k": self._rrf_k,
            "weights": active_weights,
        }

        if "keyword" in dimensions and query:
            dimension_scores["keyword"] = self._score_keyword(candidates, query)
            fusion_info["keyword_scored"] = len(dimension_scores["keyword"])

        if "semantic" in dimensions and query and self._semantic_engine:
            dimension_scores["semantic"] = await self._score_semantic(candidates, query)
            fusion_info["semantic_scored"] = len(dimension_scores["semantic"])

        if "temporal" in dimensions:
            dimension_scores["temporal"] = self._score_temporal(candidates)
            fusion_info["temporal_scored"] = len(dimension_scores["temporal"])

        merged = self._merge_scores(
            candidates,
            dimension_scores,
            active_weights,
            dimensions,
        )

        merged.sort(key=lambda x: x[1], reverse=True)
        top_items = merged[:limit]

        items = []
        for candidate, final_score in top_items:
            item_dict = {
                "id": getattr(candidate, "id", ""),
                "content": getattr(candidate, "content", ""),
                "importance": getattr(candidate, "importance", 0.5),
                "tags": getattr(candidate, "tags", []),
                "created_at": getattr(candidate, "created_at", 0),
                "accessed_at": getattr(candidate, "accessed_at", 0),
                "score": round(final_score, 4),
                "dimension_contributions": {
                    d: round(dimension_scores.get(d, {}).get(id(candidate), 0), 4)
                    for d in dimensions
                },
            }
            items.append(item_dict)

        return CrossDimensionResult(
            items=items,
            total=len(candidates),
            query=query,
            dimension_scores={
                d: sum(dimension_scores.get(d, {}).values())
                for d in dimensions
            },
            fusion_info=fusion_info,
        )

    def update_task_type(self, task_type: str) -> None:
        self._task_type = task_type

    async def _collect_candidates(
        self,
        user_id: str,
        memory_type: str | None,
        min_importance: float,
        tags: list[str] | None,
    ) -> list[Any]:
        if self._memory_manager is None:
            return []

        import time
        from agent.memory.memory_manager import MemoryType, RetrievalMode

        mtype = None
        if memory_type:
            try:
                mtype = MemoryType(memory_type)
            except ValueError as _exc:
                log_ignored(log, "cross_dimension_retriever.CrossDimensionRetriever._collect_candidates", _exc)

        result = await self._memory_manager.retrieve(
            user_id=user_id,
            query="",
            memory_type=mtype,
            mode=RetrievalMode.KEYWORD,
            limit=1000,
            min_importance=min_importance,
            tags=tags,
        )
        return result.items

    def _score_keyword(
        self,
        candidates: list[Any],
        query: str,
    ) -> dict[int, float]:
        scores: dict[int, float] = {}
        q_lower = query.lower()
        q_terms = q_lower.split()

        for c in candidates:
            content = getattr(c, "content", "").lower()
            tags = [t.lower() for t in getattr(c, "tags", [])]
            score = 0.0

            if q_lower in content:
                score += 2.0

            for term in q_terms:
                if len(term) >= 2 and term in content:
                    score += 0.5

            for tag in tags:
                if q_lower in tag or any(term in tag for term in q_terms if len(term) >= 2):
                    score += 0.3

            importance = max(0.1, getattr(c, "importance", 0.5))
            score *= importance

            if score > 0:
                scores[id(c)] = score

        return scores

    async def _score_semantic(
        self,
        candidates: list[Any],
        query: str,
    ) -> dict[int, float]:
        scores: dict[int, float] = {}

        if not self._semantic_engine:
            return scores

        try:
            query_embedding = await self._semantic_engine.get_embedding(query)
            if not query_embedding:
                return scores

            for c in candidates:
                content = getattr(c, "content", "")
                if not content:
                    continue

                content_embedding = await self._semantic_engine.get_embedding(content)
                if not content_embedding:
                    continue

                similarity = self._compute_cosine(query_embedding, content_embedding)
                importance = max(0.1, getattr(c, "importance", 0.5))
                scores[id(c)] = similarity * importance

        except Exception as e:
            log.warning("Semantic scoring failed", error=str(e))

        return scores

    def _score_temporal(self, candidates: list[Any]) -> dict[int, float]:
        import time
        scores: dict[int, float] = {}
        now = time.time()

        if not candidates:
            return scores

        half_lives = [max(0.01, (now - getattr(c, "accessed_at", now))) for c in candidates]
        max_half_life = max(half_lives) if half_lives else 1.0

        for c in candidates:
            accessed = getattr(c, "accessed_at", now)
            created = getattr(c, "created_at", now)
            access_count = getattr(c, "access_count", 0)
            importance = max(0.1, getattr(c, "importance", 0.5))

            elapsed = max(0.01, now - accessed)

            recency_score = math.exp(-elapsed / (max_half_life * 0.5 if max_half_life > 0 else 3600))

            freq_score = min(1.0, math.log(1 + access_count) / math.log(1 + 10))

            creation_bonus = 0.2 if (now - created) < 3600 else 0.0

            score = (0.5 * recency_score + 0.3 * freq_score + 0.2 * importance) + creation_bonus
            score = max(0.0, min(1.0, score))

            scores[id(c)] = score

        return scores

    def _merge_scores(
        self,
        candidates: list[Any],
        dimension_scores: dict[str, dict[int, float]],
        weights: dict[str, float],
        dimensions: list[str],
    ) -> list[tuple[Any, float]]:
        """使用 RRF + 加权线性组合融合多维度分数。"""
        rrf_ranks: dict[str, dict[int, float]] = {}

        for dim in dimensions:
            raw_scores = dimension_scores.get(dim, {})
            if not raw_scores:
                rrf_ranks[dim] = {}
                continue

            sorted_items = sorted(raw_scores.items(), key=lambda x: x[1], reverse=True)
            rrf_ranks[dim] = {
                cid: 1.0 / (self._rrf_k + rank + 1)
                for rank, (cid, _) in enumerate(sorted_items)
            }

        merged: list[tuple[Any, float]] = []
        for c in candidates:
            cid = id(c)

            linear_score = 0.0
            rrf_score = 0.0

            for dim in dimensions:
                w = weights.get(dim, 0.0)
                if w > 0:
                    linear_score += w * dimension_scores.get(dim, {}).get(cid, 0.0)
                    rrf_score += w * rrf_ranks.get(dim, {}).get(cid, 0.0)

            final_score = 0.5 * linear_score + 0.5 * rrf_score

            if final_score > 0:
                merged.append((c, final_score))

        return merged

    @staticmethod
    def _compute_cosine(a: list[float], b: list[float]) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)
