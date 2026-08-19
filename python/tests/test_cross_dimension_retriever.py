"""测试 CrossDimensionRetriever 跨维度记忆检索器。"""

from __future__ import annotations

import time

import pytest

from agent.memory.cross_dimension_retriever import (
    CrossDimensionResult,
    CrossDimensionRetriever,
)


class _FakeMemoryItem:
    def __init__(self, id, content, importance=0.5, tags=None, created_at=None, accessed_at=None, access_count=0):
        self.id = id
        self.content = content
        self.importance = importance
        self.tags = tags or []
        self.created_at = created_at or time.time()
        self.accessed_at = accessed_at or time.time()
        self.access_count = access_count


class _FakeMemoryManager:
    def __init__(self, items=None):
        self._items = items or []

    async def retrieve(self, **kwargs):
        from agent.memory.memory_manager import RetrievalResult
        return RetrievalResult(items=self._items, total=len(self._items), query=kwargs.get("query", ""))


class _FakeSemanticEngine:
    def __init__(self):
        self._embeddings = {}

    async def get_embedding(self, text: str):
        import hashlib
        h = int(hashlib.md5(text.encode()).hexdigest()[:8], 16)
        return [((h >> i) & 0xFF) / 255.0 for i in range(0, 128, 8)]


def _make_items():
    return [
        _FakeMemoryItem(id="1", content="用户喜欢 Python 编程", importance=0.8, tags=["coding", "python"]),
        _FakeMemoryItem(id="2", content="用户最近在学习 Rust", importance=0.6, tags=["coding", "rust"]),
        _FakeMemoryItem(id="3", content="用户偏好函数式编程风格", importance=0.7, tags=["coding", "fp"]),
        _FakeMemoryItem(id="4", content="用户的工作是数据分析师", importance=0.5, tags=["career", "analysis"]),
        _FakeMemoryItem(id="5", content="用户每周三下午有空", importance=0.3, tags=["schedule"]),
        _FakeMemoryItem(id="6", content="用户的代码仓库地址是 github.com/user", importance=0.4, tags=["github"]),
        _FakeMemoryItem(id="7", content="用户喜欢使用 VSCode 编辑器", importance=0.6, tags=["tool", "editor"]),
        _FakeMemoryItem(id="8", content="用户最近在做一个 Web 项目", importance=0.7, tags=["project", "web"]),
    ]


# ═══════════════════════════════════════════════════════════════════════════
# 基础功能测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_retrieve_keyword_only():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="Python",
        dimensions=["keyword"],
        limit=5,
    )

    assert isinstance(result, CrossDimensionResult)
    assert len(result.items) > 0
    assert result.query == "Python"


@pytest.mark.anyio
async def test_retrieve_temporal_only():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="",
        dimensions=["temporal"],
        limit=5,
    )

    assert isinstance(result, CrossDimensionResult)
    assert result.total == len(items)
    assert len(result.items) == 5


@pytest.mark.anyio
async def test_retrieve_all_dimensions():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    engine = _FakeSemanticEngine()
    retriever = CrossDimensionRetriever(memory_manager=mgr, semantic_engine=engine)

    result = await retriever.retrieve(
        user_id="user_1",
        query="编程",
        dimensions=["keyword", "semantic", "temporal"],
        limit=5,
    )

    assert len(result.items) > 0
    assert "keyword" in result.fusion_info["dimensions"]
    assert "semantic" in result.fusion_info["dimensions"]
    assert "temporal" in result.fusion_info["dimensions"]


@pytest.mark.anyio
async def test_retrieve_returns_scores():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    engine = _FakeSemanticEngine()
    retriever = CrossDimensionRetriever(memory_manager=mgr, semantic_engine=engine)

    result = await retriever.retrieve(
        user_id="user_1",
        query="Python",
        dimensions=["keyword", "semantic", "temporal"],
        limit=5,
    )

    for item in result.items:
        assert "score" in item
        assert isinstance(item["score"], float)
        assert "dimension_contributions" in item


@pytest.mark.anyio
async def test_retrieve_empty_candidates():
    mgr = _FakeMemoryManager([])
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="something",
        limit=5,
    )

    assert result.total == 0
    assert len(result.items) == 0


@pytest.mark.anyio
async def test_retrieve_sort_by_relevance():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    engine = _FakeSemanticEngine()
    retriever = CrossDimensionRetriever(memory_manager=mgr, semantic_engine=engine)

    result = await retriever.retrieve(
        user_id="user_1",
        query="Python",
        dimensions=["keyword", "semantic", "temporal"],
        limit=5,
    )

    scores = [item["score"] for item in result.items]
    for i in range(len(scores) - 1):
        assert scores[i] >= scores[i + 1]


# ═══════════════════════════════════════════════════════════════════════════
# 任务类型权重测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_coding_task_weights_keyword_higher():
    items = _make_items()
    engine = _FakeSemanticEngine()
    mgr = _FakeMemoryManager(items)

    general = CrossDimensionRetriever(mgr, engine, task_type="general")
    coding = CrossDimensionRetriever(mgr, engine, task_type="coding")

    assert coding._DIMENSION_WEIGHTS_BY_TASK["coding"]["keyword"] > \
           coding._DIMENSION_WEIGHTS_BY_TASK["general"]["keyword"]


@pytest.mark.anyio
async def test_analysis_task_weights_semantic_higher():
    weights = CrossDimensionRetriever._DIMENSION_WEIGHTS_BY_TASK["analysis"]
    assert weights["semantic"] > weights["keyword"]
    assert weights["semantic"] > weights["temporal"]


@pytest.mark.anyio
async def test_conversation_task_weights_temporal_higher():
    weights = CrossDimensionRetriever._DIMENSION_WEIGHTS_BY_TASK["conversation"]
    assert weights["temporal"] > weights["keyword"]


# ═══════════════════════════════════════════════════════════════════════════
# 更新方法测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_update_task_type():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(mgr, task_type="general")

    retriever.update_task_type("coding")
    assert retriever._task_type == "coding"


# ═══════════════════════════════════════════════════════════════════════════
# 边界条件测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_retrieve_with_tags_filter():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="coding",
        dimensions=["keyword"],
        tags=["coding"],
        limit=5,
    )

    assert isinstance(result, CrossDimensionResult)


@pytest.mark.anyio
async def test_retrieve_with_min_importance():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="",
        dimensions=["temporal"],
        min_importance=0.5,
        limit=5,
    )

    assert isinstance(result, CrossDimensionResult)


@pytest.mark.anyio
async def test_retrieve_no_memory_manager():
    retriever = CrossDimensionRetriever(memory_manager=None)

    result = await retriever.retrieve(
        user_id="user_1",
        query="test",
        limit=5,
    )

    assert result.total == 0
    assert len(result.items) == 0


@pytest.mark.anyio
async def test_retrieve_no_semantic_engine():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr, semantic_engine=None)

    result = await retriever.retrieve(
        user_id="user_1",
        query="Python",
        dimensions=["keyword", "semantic", "temporal"],
        limit=5,
    )

    assert len(result.items) > 0


@pytest.mark.anyio
async def test_retrieve_respects_limit():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    for limit in [1, 3, 5]:
        result = await retriever.retrieve(
            user_id="user_1",
            query="",
            dimensions=["temporal"],
            limit=limit,
        )
        assert len(result.items) <= limit


@pytest.mark.anyio
async def test_fusion_info_contains_metadata():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    engine = _FakeSemanticEngine()
    retriever = CrossDimensionRetriever(memory_manager=mgr, semantic_engine=engine)

    result = await retriever.retrieve(
        user_id="user_1",
        query="Python",
        dimensions=["keyword", "semantic", "temporal"],
        limit=5,
    )

    assert "dimensions" in result.fusion_info
    assert "candidates" in result.fusion_info
    assert "rrf_k" in result.fusion_info
    assert "weights" in result.fusion_info


@pytest.mark.anyio
async def test_keyword_scoring_exact_match():
    items = [
        _FakeMemoryItem(id="1", content="Python 编程", importance=0.8),
        _FakeMemoryItem(id="2", content="Java 学习", importance=0.8),
        _FakeMemoryItem(id="3", content="Python 框架", importance=0.8),
    ]
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="Python",
        dimensions=["keyword"],
        limit=3,
    )

    python_items = [i for i in result.items if "Python" in i["content"]]
    assert len(python_items) >= 1
    if python_items:
        java_items = [i for i in result.items if "Java" in i["content"]]
        if java_items:
            assert python_items[0]["score"] >= java_items[0]["score"]


@pytest.mark.anyio
async def test_retrieve_with_memory_type():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="",
        dimensions=["temporal"],
        memory_type="ltm",
        limit=5,
    )

    assert isinstance(result, CrossDimensionResult)


@pytest.mark.anyio
async def test_cross_dimension_result_fields():
    items = _make_items()
    mgr = _FakeMemoryManager(items)
    retriever = CrossDimensionRetriever(memory_manager=mgr)

    result = await retriever.retrieve(
        user_id="user_1",
        query="测试查询",
        limit=5,
    )

    assert result.query == "测试查询"
    assert isinstance(result.total, int)
    assert isinstance(result.dimension_scores, dict)
    assert isinstance(result.fusion_info, dict)
