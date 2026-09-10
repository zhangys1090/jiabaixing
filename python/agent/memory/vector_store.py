"""向量存储引擎，基于 ChromaDB 实现持久化向量检索。

支持与 FTS5 全文搜索协同的混合检索策略：
- 向量检索：基于 embedding 相似度
- 关键词检索：基于 FTS5
- 混合检索：RRF(Reciprocal Rank Fusion) 融合两路结果
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

from agent.core.logger import StructuredLogger
log = StructuredLogger("vector_store")


# ChromaDB 为可选依赖，缺失时 graceful 降级
_chromadb_available: bool = False
_chromadb_client_type: Any = None
try:
    import chromadb
    _chromadb_available = True
    _chromadb_client_type = chromadb.Client
except ImportError:
    pass


def _get_embedding_via_litellm(texts: list[str]) -> list[list[float]]:
    """通过 litellm.embedding() 生成文本向量。

    默认使用 OpenAI text-embedding-3-small 模型，
    可通过 VECTOR_EMBEDDING_MODEL 环境变量覆盖。

    Args:
        texts: 待编码的文本列表。

    Returns:
        与 texts 等长的向量列表，每项为 float 列表。
        编码失败时返回空列表占位。
    """
    import litellm

    model = os.getenv("VECTOR_EMBEDDING_MODEL", "text-embedding-3-small")
    try:
        resp = litellm.embedding(model=model, input=texts)
        return [d["embedding"] for d in resp.data]
    except Exception as exc:
        log.warning("litellm embedding 调用失败，回退空向量", error=str(exc))
        return []


class VectorStore:
    """向量存储引擎，基于 ChromaDB 实现持久化向量检索。

    支持与 FTS5 全文搜索协同的混合检索策略：
    - 向量检索：基于 embedding 相似度
    - 关键词检索：基于 FTS5
    - 混合检索：RRF(Reciprocal Rank Fusion) 融合两路结果

    当 chromadb 未安装时，所有方法 graceful 降级返回空结果，
    不影响 MemoryStore 的 FTS5 基础能力。

    Attributes:
        _client: ChromaDB 客户端实例（降级时为 None）。
        _collection: ChromaDB 集合（降级时为 None）。
        _embedding_fn: embedding 生成函数。
        _available: ChromaDB 是否可用。
    """

    def __init__(
        self,
        persist_dir: str,
        collection_name: str = "memory",
        embedding_fn: Callable[[list[str]], list[list[float]]] | None = None,
    ) -> None:
        """初始化 ChromaDB 持久化向量存储。

        Args:
            persist_dir: ChromaDB 数据持久化目录。
            collection_name: 集合名称，默认 "memory"。
            embedding_fn: 自定义 embedding 函数，默认使用 litellm.embedding()。
        """
        self._available: bool = False
        self._client: Any = None
        self._collection: Any = None
        self._embedding_fn = embedding_fn or _get_embedding_via_litellm

        if not _chromadb_available:
            log.info("chromadb 未安装，VectorStore 降级为空操作")
            return

        try:
            persist_path = Path(persist_dir)
            persist_path.mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(path=str(persist_path))
            self._collection = self._client.get_or_create_collection(
                name=collection_name,
                metadata={"hnsw:space": "cosine"},
            )
            self._available = True
            log.info(
                "VectorStore 初始化成功",
                persist_dir=persist_dir,
                collection=collection_name,
                existing_count=self._collection.count(),
            )
        except Exception as exc:
            log.warning("ChromaDB 初始化失败，降级为空操作", error=str(exc))

    @staticmethod
    def _chromadb_available_static() -> bool:
        """P0-3: 静态方法，检查 chromadb 包是否可导入（无需实例化 VectorStore）。

        用于 MemoryStore 在初始化时判断是否应自动启用向量存储。
        """
        return _chromadb_available

    def is_available(self) -> bool:
        """检查 ChromaDB 是否可用。

        Returns:
            True 表示向量存储可用，False 表示已降级。
        """
        return self._available

    async def add(
        self,
        ids: list[str],
        documents: list[str],
        metadatas: list[dict[str, Any]] | None = None,
    ) -> int:
        """添加文档向量到 ChromaDB。

        对文档文本调用 embedding 函数生成向量后写入集合。
        已存在的 ID 会被跳过（upsert 语义但跳过已有条目以节省 embedding 计算）。

        Args:
            ids: 文档唯一标识列表。
            documents: 文档文本列表。
            metadatas: 可选的元数据列表，与 ids 等长。

        Returns:
            实际写入的文档数量。
        """
        if not self._available or not ids:
            return 0

        # 过滤已存在的 ID，避免重复计算 embedding
        existing = self._collection.get(ids=ids)
        existing_ids = set(existing["ids"]) if existing else set()
        new_indices = [i for i, mid in enumerate(ids) if mid not in existing_ids]

        if not new_indices:
            return 0

        new_ids = [ids[i] for i in new_indices]
        new_docs = [documents[i] for i in new_indices]
        new_metas = (
            [metadatas[i] for i in new_indices] if metadatas else None
        )

        try:
            embeddings = self._embedding_fn(new_docs)
            if not embeddings or len(embeddings) != len(new_ids):
                log.warning("embedding 生成数量不匹配，跳过写入", expected=len(new_ids), got=len(embeddings))
                return 0

            # ChromaDB metadata 值必须为 str/int/float/bool，过滤非法类型
            safe_metas: list[dict[str, Any]] | None = None
            if new_metas:
                safe_metas = [
                    {k: v for k, v in m.items() if isinstance(v, (str, int, float, bool))}
                    for m in new_metas
                ]

            self._collection.add(
                ids=new_ids,
                embeddings=embeddings,
                documents=new_docs,
                metadatas=safe_metas,
            )
            log.debug("VectorStore 写入成功", count=len(new_ids))
            return len(new_ids)
        except Exception as exc:
            log.warning("VectorStore 写入失败", error=str(exc))
            return 0

    async def delete(self, ids: list[str]) -> int:
        """删除指定 ID 的文档向量。

        Args:
            ids: 待删除的文档 ID 列表。

        Returns:
            实际删除的文档数量。
        """
        if not self._available or not ids:
            return 0

        try:
            existing = self._collection.get(ids=ids)
            existing_ids = existing["ids"] if existing else []
            if not existing_ids:
                return 0
            self._collection.delete(ids=existing_ids)
            return len(existing_ids)
        except Exception as exc:
            log.warning("VectorStore 删除失败", error=str(exc))
            return 0

    async def search(
        self,
        query: str,
        n_results: int = 10,
        filter: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """向量检索：基于 embedding 相似度返回最相近的文档。

        Args:
            query: 查询文本。
            n_results: 最大返回数量。
            filter: ChromaDB 元数据过滤条件（可选）。

        Returns:
            按相似度降序排列的结果列表，每项含 id/content/score/metadata。
        """
        if not self._available or not query:
            return []

        try:
            embeddings = self._embedding_fn([query])
            if not embeddings or not embeddings[0]:
                return []

            query_kwargs: dict[str, Any] = {
                "query_embeddings": embeddings,
                "n_results": n_results,
            }
            if filter:
                query_kwargs["where"] = filter

            results = self._collection.query(**query_kwargs)

            items: list[dict[str, Any]] = []
            ids = results.get("ids", [[]])[0]
            docs = results.get("documents", [[]])[0]
            distances = results.get("distances", [[]])[0]
            metas = results.get("metadatas", [[]])[0]

            for i, doc_id in enumerate(ids):
                # cosine 距离转相似度：similarity = 1 - distance
                distance = distances[i] if i < len(distances) else 1.0
                score = max(0.0, 1.0 - distance)
                meta = metas[i] if i < len(metas) and metas[i] else {}
                items.append({
                    "id": doc_id,
                    "content": docs[i] if i < len(docs) else "",
                    "score": round(score, 4),
                    "metadata": meta,
                })

            return items
        except Exception as exc:
            log.warning("VectorStore 向量检索失败", error=str(exc))
            return []

    async def hybrid_search(
        self,
        query: str,
        fts_results: list[dict[str, Any]],
        n_results: int = 10,
        rrf_k: int = 60,
    ) -> list[dict[str, Any]]:
        """混合检索：RRF(Reciprocal Rank Fusion) 融合向量检索与 FTS5 结果。

        RRF 算法原理：
            对每个文档 d，其融合分数为：
                score(d) = Σ 1/(k + rank_i(d))
            其中 rank_i(d) 是文档 d 在第 i 路检索中的排名（从 1 开始），
            k 为平滑常数（默认 60），越大则排名差异对分数的影响越小。
            最终按融合分数降序排列，取前 n_results 个。

        两路召回策略：
            1. 向量检索（VectorStore.search）：语义相似度召回
            2. FTS5 检索（fts_results 参数）：关键词精确匹配召回

        Args:
            query: 查询文本。
            fts_results: FTS5 全文检索结果列表，每项需含 "id" 键。
            n_results: 最大返回数量。
            rrf_k: RRF 平滑常数，默认 60。值越大排名影响越平滑。

        Returns:
            按 RRF 融合分数降序排列的结果列表，
            每项含 id/content/score/metadata/search_method。
        """
        if not self._available:
            # ChromaDB 不可用时直接返回 FTS 结果
            return fts_results[:n_results]

        # 向量检索
        vector_results = await self.search(query, n_results=n_results * 2)

        # RRF 融合
        merged = self._rrf_merge(vector_results, fts_results, k=rrf_k)

        # 构建完整的文档映射（优先向量检索结果，因其含 content）
        doc_map: dict[str, dict[str, Any]] = {}
        for item in vector_results:
            doc_map[item["id"]] = item
        for item in fts_results:
            if item["id"] not in doc_map:
                doc_map[item["id"]] = item

        # 组装最终结果
        results: list[dict[str, Any]] = []
        for doc_id, score in merged[:n_results]:
            entry = doc_map.get(doc_id, {"id": doc_id})
            entry["score"] = round(score, 4)
            entry["search_method"] = "hybrid_rrf"
            results.append(entry)

        return results

    @staticmethod
    def _rrf_merge(
        vector_results: list[dict[str, Any]],
        fts_results: list[dict[str, Any]],
        k: int = 60,
    ) -> list[tuple[str, float]]:
        """Reciprocal Rank Fusion：融合两路检索的排名结果。

        算法：
            score(d) = Σ_i 1 / (k + rank_i(d))

        其中：
            - d 为文档，i 为检索路数（此处固定为 2 路：向量 + FTS）
            - rank_i(d) 为文档 d 在第 i 路中的排名（1-based）
            - k 为平滑常数，控制排名差异的敏感度
              - k 越小：排名靠前的文档优势越明显（"赢家通吃"）
              - k 越大：排名差异被平滑，更多文档有机会入选
              - 经验值 k=60 在大多数场景下表现良好

        示例（k=60）：
            文档 A: 向量排名第1, FTS 排名第3
                score = 1/(60+1) + 1/(60+3) = 0.01639 + 0.01587 = 0.03226
            文档 B: 向量排名第5, FTS 排名第1
                score = 1/(60+5) + 1/(60+1) = 0.01538 + 0.01639 = 0.03177
            → A 的融合分数更高，排在前面

        Args:
            vector_results: 向量检索结果列表，每项需含 "id" 键。
            fts_results: FTS 检索结果列表，每项需含 "id" 键。
            k: 平滑常数，默认 60。

        Returns:
            按 RRF 融合分数降序排列的 (id, score) 元组列表。
        """
        scores: dict[str, float] = {}

        # 向量检索路：按原始顺序赋予排名
        for rank, item in enumerate(vector_results, start=1):
            doc_id = item["id"]
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)

        # FTS 检索路：按原始顺序赋予排名
        for rank, item in enumerate(fts_results, start=1):
            doc_id = item["id"]
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)

        return sorted(scores.items(), key=lambda x: x[1], reverse=True)

    def close(self) -> None:
        """关闭 ChromaDB 客户端，释放持久化连接资源。"""
        if self._client is not None:
            try:
                if hasattr(self._client, "clear"):
                    self._client.clear()
            except Exception as _exc:
                log.warning("ChromaDB 清理失败", error=str(_exc))
            self._client = None
        self._collection = None
        self._available = False

    def __del__(self) -> None:
        try:
            self.close()
        except Exception as _exc:
            log.debug("vector_store __del__ close 失败", error=str(_exc))

    def __enter__(self) -> "VectorStore":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
