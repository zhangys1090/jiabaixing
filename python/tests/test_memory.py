import pytest
import tempfile
import os

from agent.memory.tokenizer import ChineseTokenizer
from agent.memory.store import MemoryStore
from agent.memory.engine import MemoryEngine


def test_tokenizer_basic():
    tokens = ChineseTokenizer.tokenize("你好世界")
    assert isinstance(tokens, list)
    assert len(tokens) > 0


def test_tokenizer_search_mode():
    tokens = ChineseTokenizer.tokenize_for_search("人工智能技术")
    assert isinstance(tokens, list)


def test_tokenizer_keywords():
    keywords = ChineseTokenizer.extract_keywords("Python是一种流行的编程语言", top_k=3)
    assert isinstance(keywords, list)


def test_memory_store_and_search():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_memory.db")
        store = MemoryStore(db_path=db_path)
        mem_id = store.store(
            content="今天天气很好",
            memory_type="short_term",
            scene="daily",
            emotion="happy",
        )
        assert mem_id is not None

        results = store.search(query="天气", limit=5)
        assert isinstance(results, list)
        store.close()


def test_memory_store_different_types():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_memory.db")
        store = MemoryStore(db_path=db_path)
        store.store("瞬时记忆", memory_type="instant")
        store.store("短期记忆", memory_type="short_term")
        store.store("长期记忆", memory_type="long_term")

        stats = store.get_stats()
        assert stats["total_entries"] == 3
        store.close()


def test_memory_search_with_type_filter():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_memory.db")
        store = MemoryStore(db_path=db_path)
        store.store("短期内容", memory_type="short_term")
        store.store("长期内容", memory_type="long_term")

        results = store.search(query="内容", limit=10, memory_type="long_term")
        assert all(r["memory_type"] == "long_term" for r in results)
        store.close()


def test_memory_stats():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_memory.db")
        store = MemoryStore(db_path=db_path)
        stats = store.get_stats()
        assert "total_entries" in stats
        assert "short_term_count" in stats
        store.close()


def test_memory_delete_by_type():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_memory.db")
        store = MemoryStore(db_path=db_path)
        store.store("瞬时1", memory_type="instant")
        store.store("瞬时2", memory_type="instant")
        store.store("长期1", memory_type="long_term")

        deleted = store.delete_by_type("instant")
        assert deleted == 2

        stats = store.get_stats()
        assert stats["instant_count"] == 0
        assert stats["long_term_count"] == 1
        store.close()


@pytest.mark.anyio
async def test_memory_engine():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_memory.db")
        engine = MemoryEngine(db_path=db_path)
        await engine.initialize()

        mem_id = await engine.store("测试记忆内容", memory_type="short_term")
        assert mem_id is not None

        results = await engine.search("测试")
        assert isinstance(results, list)

        stats = await engine.get_stats()
        assert stats["total_entries"] >= 1

        engine._store.close()


@pytest.mark.anyio
async def test_memory_engine_convenience_methods():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_memory.db")
        engine = MemoryEngine(db_path=db_path)

        id1 = await engine.store_instant("瞬时")
        id2 = await engine.store_short_term("短期")
        id3 = await engine.store_long_term("长期")

        assert all(x is not None for x in [id1, id2, id3])

        engine._store.close()
