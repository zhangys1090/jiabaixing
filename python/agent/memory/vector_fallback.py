"""向量检索保底引擎（Vector Search Fallback）。

当 ChromaDB 和/或 litellm 不可用时，提供纯 Python 的本地向量检索保底方案：
1. TF-IDF 向量化：使用纯 Python 实现 TF-IDF，无需外部依赖
2. 余弦相似度检索：基于 TF-IDF 向量计算余弦相似度
3. 与 VectorStore 接口对齐：实现相同的 add/search/hybrid_search 接口
4. 自动降级：VectorStore 不可用时自动切换到保底引擎
5. 缓存默认策略：内置 LRU 缓存，避免重复计算

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 零外部依赖，纯标准库实现
- 与 VectorStore 接口兼容，可透明替换
"""

from __future__ import annotations

import math
import re
import time
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("vector_fallback")



def _tokenize(text: str) -> list[str]:
    text = text.lower()
    tokens = re.findall(r"[a-z\u4e00-\u9fff][a-z\u4e00-\u9fff0-9_]*", text)
    return tokens


class TfidfVectorizer:
    """纯 Python TF-IDF 向量化器。"""

    def __init__(self, max_features: int = 5000) -> None:
        self._max_features = max_features
        self._vocab: dict[str, int] = {}
        self._idf: dict[str, float] = {}
        self._doc_count = 0
        self._doc_freq: Counter[str] = Counter()

    def fit(self, documents: list[str]) -> TfidfVectorizer:
        self._doc_count = len(documents)
        self._doc_freq = Counter()
        self._vocab = {}

        for doc in documents:
            tokens = set(_tokenize(doc))
            for token in tokens:
                self._doc_freq[token] += 1

        sorted_tokens = sorted(
            self._doc_freq.keys(),
            key=lambda t: self._doc_freq[t],
            reverse=True,
        )[: self._max_features]

        self._vocab = {token: idx for idx, token in enumerate(sorted_tokens)}
        self._idf = {}
        for token in self._vocab:
            df = self._doc_freq[token]
            self._idf[token] = math.log((self._doc_count + 1) / (df + 1)) + 1.0

        return self

    def transform(self, documents: list[str]) -> list[list[float]]:
        results: list[list[float]] = []
        for doc in documents:
            tokens = _tokenize(doc)
            tf = Counter(tokens)
            total = len(tokens) if tokens else 1
            vec = [0.0] * len(self._vocab)
            for token, count in tf.items():
                if token in self._vocab:
                    idx = self._vocab[token]
                    vec[idx] = (count / total) * self._idf.get(token, 1.0)
            norm = math.sqrt(sum(v * v for v in vec))
            if norm > 0:
                vec = [v / norm for v in vec]
            results.append(vec)
        return results

    def vocab_size(self) -> int:
        return len(self._vocab)


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


@dataclass
class CacheEntry:
    query_hash: str = ""
    results: list[dict[str, Any]] = field(default_factory=list)
    timestamp: float = 0.0
    ttl_seconds: float = 300.0

    @property
    def is_expired(self) -> bool:
        return time.time() - self.timestamp > self.ttl_seconds


class LRUSearchCache:
    """LRU 缓存：避免重复计算相同查询的向量检索结果。"""

    def __init__(self, max_size: int = 100, ttl_seconds: float = 300.0) -> None:
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()

    def get(self, query: str) -> list[dict[str, Any]] | None:
        key = self._make_key(query)
        entry = self._cache.get(key)
        if entry is None:
            return None
        if entry.is_expired:
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        return entry.results

    def put(self, query: str, results: list[dict[str, Any]]) -> None:
        key = self._make_key(query)
        if key in self._cache:
            self._cache.move_to_end(key)
        self._cache[key] = CacheEntry(
            query_hash=key,
            results=results,
            timestamp=time.time(),
            ttl_seconds=self._ttl,
        )
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

    def invalidate(self, query: str | None = None) -> None:
        if query:
            self._cache.pop(self._make_key(query), None)
        else:
            self._cache.clear()

    def size(self) -> int:
        return len(self._cache)

    @staticmethod
    def _make_key(query: str) -> str:
        return str(hash(query))


class VectorSearchFallback:
    """向量检索保底引擎：当 ChromaDB 不可用时提供本地 TF-IDF 检索。"""

    _instance: VectorSearchFallback | None = None

    def __init__(
        self,
        max_features: int = 5000,
        cache_max_size: int = 100,
        cache_ttl_seconds: float = 300.0,
    ) -> None:
        self._vectorizer = TfidfVectorizer(max_features=max_features)
        self._documents: dict[str, str] = {}
        self._metadatas: dict[str, dict[str, Any]] = {}
        self._vectors: dict[str, list[float]] = {}
        self._fitted = False
        self._cache = LRUSearchCache(max_size=cache_max_size, ttl_seconds=cache_ttl_seconds)
        self._MAX_DOCUMENTS = 50000

    @classmethod
    def get_instance(cls) -> VectorSearchFallback:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def is_available(self) -> bool:
        return True

    async def add(
        self,
        ids: list[str],
        documents: list[str],
        metadatas: list[dict[str, Any]] | None = None,
    ) -> int:
        added = 0
        for i, doc_id in enumerate(ids):
            if doc_id in self._documents:
                continue
            self._documents[doc_id] = documents[i]
            if metadatas and i < len(metadatas):
                self._metadatas[doc_id] = metadatas[i]
            added += 1
            if len(self._documents) > self._MAX_DOCUMENTS:
                oldest_ids = list(self._documents.keys())[: len(self._documents) - (self._MAX_DOCUMENTS * 3 // 4)]
                for oid in oldest_ids:
                    self._documents.pop(oid, None)
                    self._metadatas.pop(oid, None)
                    self._vectors.pop(oid, None)

        if added > 0:
            self._refit()
            self._cache.invalidate()

        return added

    async def delete(self, ids: list[str]) -> int:
        deleted = 0
        for doc_id in ids:
            if doc_id in self._documents:
                del self._documents[doc_id]
                self._vectors.pop(doc_id, None)
                self._metadatas.pop(doc_id, None)
                deleted += 1

        if deleted > 0:
            self._refit()
            self._cache.invalidate()

        return deleted

    async def search(
        self,
        query: str,
        n_results: int = 10,
        filter: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        cached = self._cache.get(query)
        if cached is not None:
            filtered = self._apply_filter(cached, filter)
            return filtered[:n_results]

        if not self._documents:
            return []

        query_vec = self._vectorizer.transform([query])
        if not query_vec or not query_vec[0]:
            return []

        results: list[dict[str, Any]] = []
        for doc_id, doc_vec in self._vectors.items():
            score = _cosine_similarity(query_vec[0], doc_vec)
            if score > 0.01:
                results.append({
                    "id": doc_id,
                    "content": self._documents.get(doc_id, ""),
                    "score": round(score, 4),
                    "metadata": self._metadatas.get(doc_id, {}),
                })

        results.sort(key=lambda x: x["score"], reverse=True)
        self._cache.put(query, results)

        filtered = self._apply_filter(results, filter)
        return filtered[:n_results]

    async def hybrid_search(
        self,
        query: str,
        fts_results: list[dict[str, Any]],
        n_results: int = 10,
        rrf_k: int = 60,
    ) -> list[dict[str, Any]]:
        vector_results = await self.search(query, n_results=n_results * 2)

        merged = self._rrf_merge(vector_results, fts_results, k=rrf_k)

        doc_map: dict[str, dict[str, Any]] = {}
        for item in vector_results:
            doc_map[item["id"]] = item
        for item in fts_results:
            if item["id"] not in doc_map:
                doc_map[item["id"]] = item

        results: list[dict[str, Any]] = []
        for doc_id, score in merged[:n_results]:
            entry = doc_map.get(doc_id, {"id": doc_id})
            entry["score"] = round(score, 4)
            entry["search_method"] = "hybrid_rrf_fallback"
            results.append(entry)

        return results

    def _refit(self) -> None:
        if not self._documents:
            self._fitted = False
            return

        doc_ids = list(self._documents.keys())
        doc_texts = [self._documents[did] for did in doc_ids]
        self._vectorizer.fit(doc_texts)
        vectors = self._vectorizer.transform(doc_texts)
        self._vectors = {
            doc_id: vec for doc_id, vec in zip(doc_ids, vectors)
        }
        self._fitted = True

    @staticmethod
    def _apply_filter(
        results: list[dict[str, Any]],
        filter: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        if not filter:
            return results
        filtered = []
        for item in results:
            meta = item.get("metadata", {})
            match = all(meta.get(k) == v for k, v in filter.items())
            if match:
                filtered.append(item)
        return filtered

    @staticmethod
    def _rrf_merge(
        vector_results: list[dict[str, Any]],
        fts_results: list[dict[str, Any]],
        k: int = 60,
    ) -> list[tuple[str, float]]:
        scores: dict[str, float] = {}
        for rank, item in enumerate(vector_results, start=1):
            doc_id = item["id"]
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
        for rank, item in enumerate(fts_results, start=1):
            doc_id = item["id"]
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
        return sorted(scores.items(), key=lambda x: x[1], reverse=True)


class ResilientVectorStore:
    """弹性向量存储：自动在 ChromaDB 和 TF-IDF 保底之间切换。

    用法：
        store = ResilientVectorStore(persist_dir="/path/to/chroma")
        # 自动选择可用后端
        await store.add(ids, documents, metadatas)
        results = await store.search(query, n_results=10)
    """

    def __init__(
        self,
        persist_dir: str,
        collection_name: str = "memory",
        fallback_max_features: int = 5000,
        cache_max_size: int = 100,
        cache_ttl_seconds: float = 300.0,
    ) -> None:
        from agent.memory.vector_store import VectorStore
        self._primary = VectorStore(persist_dir, collection_name)
        self._fallback = VectorSearchFallback(
            max_features=fallback_max_features,
            cache_max_size=cache_max_size,
            cache_ttl_seconds=cache_ttl_seconds,
        )
        self._use_primary = self._primary.is_available()
        if self._use_primary:
            log.info("ResilientVectorStore: 使用 ChromaDB 主后端")
        else:
            log.info("ResilientVectorStore: ChromaDB 不可用，切换到 TF-IDF 保底后端")

    def is_available(self) -> bool:
        return True

    @property
    def backend(self) -> str:
        return "chromadb" if self._use_primary else "tfidf_fallback"

    async def add(
        self,
        ids: list[str],
        documents: list[str],
        metadatas: list[dict[str, Any]] | None = None,
    ) -> int:
        if self._use_primary:
            try:
                result = await self._primary.add(ids, documents, metadatas)
                return result
            except Exception as exc:
                log.warning("ChromaDB add 失败，降级到 TF-IDF", error=str(exc))
                self._use_primary = False
        return await self._fallback.add(ids, documents, metadatas)

    async def delete(self, ids: list[str]) -> int:
        if self._use_primary:
            try:
                return await self._primary.delete(ids)
            except Exception as exc:
                log.warning("ChromaDB delete 失败，降级到 TF-IDF", error=str(exc))
                self._use_primary = False
        return await self._fallback.delete(ids)

    async def search(
        self,
        query: str,
        n_results: int = 10,
        filter: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        if self._use_primary:
            try:
                results = await self._primary.search(query, n_results, filter)
                if results:
                    return results
            except Exception as exc:
                log.warning("ChromaDB search 失败，降级到 TF-IDF", error=str(exc))
                self._use_primary = False
        return await self._fallback.search(query, n_results, filter)

    async def hybrid_search(
        self,
        query: str,
        fts_results: list[dict[str, Any]],
        n_results: int = 10,
        rrf_k: int = 60,
    ) -> list[dict[str, Any]]:
        if self._use_primary:
            try:
                results = await self._primary.hybrid_search(query, fts_results, n_results, rrf_k)
                if results:
                    return results
            except Exception as exc:
                log.warning("ChromaDB hybrid_search 失败，降级到 TF-IDF", error=str(exc))
                self._use_primary = False
        return await self._fallback.hybrid_search(query, fts_results, n_results, rrf_k)
