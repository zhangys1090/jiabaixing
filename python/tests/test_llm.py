import pytest
from agent.llm.cache import LLMCache
from agent.llm.queue import RequestQueue
from agent.llm.router import ProviderConfig, ProviderManager


def test_cache_set_get():
    cache = LLMCache()
    messages = [{"role": "user", "content": "hello"}]
    cache.set(messages, "world", "test-model")
    result = cache.get(messages, "test-model")
    assert result == "world"


def test_cache_miss():
    cache = LLMCache()
    messages = [{"role": "user", "content": "hello"}]
    result = cache.get(messages, "test-model")
    assert result is None


def test_cache_different_model():
    cache = LLMCache()
    messages = [{"role": "user", "content": "hello"}]
    cache.set(messages, "world", "model-a")
    result = cache.get(messages, "model-b")
    assert result is None


def test_cache_size():
    cache = LLMCache(max_size=2)
    for i in range(5):
        cache.set([{"role": "user", "content": f"msg-{i}"}], f"resp-{i}", "model")
    assert cache.size <= 2


def test_cache_clear():
    cache = LLMCache()
    messages = [{"role": "user", "content": "hello"}]
    cache.set(messages, "world", "model")
    cache.clear()
    assert cache.size == 0


@pytest.mark.anyio
async def test_queue_submit():
    queue = RequestQueue(max_concurrent=2)

    async def fake_llm_call(x: str) -> str:
        return f"response-{x}"

    result = await queue.submit(fake_llm_call, "test")
    assert result == "response-test"


@pytest.mark.anyio
async def test_queue_concurrent():
    import asyncio

    queue = RequestQueue(max_concurrent=2)
    order: list[str] = []

    async def slow_task(name: str) -> str:
        order.append(f"start-{name}")
        await asyncio.sleep(0.05)
        order.append(f"end-{name}")
        return name

    import asyncio
    results = await asyncio.gather(
        queue.submit(slow_task, "a"),
        queue.submit(slow_task, "b"),
        queue.submit(slow_task, "c"),
    )
    assert set(results) == {"a", "b", "c"}


def test_provider_manager_register():
    import tempfile
    import os

    with tempfile.TemporaryDirectory() as tmpdir:
        mgr = ProviderManager(data_dir=tmpdir)
        cfg = ProviderConfig(
            name="test",
            display_name="Test Provider",
            base_url="https://api.test.com",
            api_key="sk-test",
            model="test-model",
            priority=0,
        )
        mgr.register(cfg)
        assert mgr.get_primary() is not None
        assert mgr.get_primary().name == "test"


def test_provider_manager_fallback():
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        mgr = ProviderManager(data_dir=tmpdir)
        mgr.register(ProviderConfig(name="primary", model="m1", priority=0))
        mgr.register(ProviderConfig(name="backup", model="m2", priority=1))
        fallback = mgr.get_fallback(exclude="primary")
        assert fallback is not None
        assert fallback.name == "backup"


def test_provider_manager_unregister():
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        mgr = ProviderManager(data_dir=tmpdir)
        mgr.register(ProviderConfig(name="p1", model="m1", priority=0))
        mgr.register(ProviderConfig(name="p2", model="m2", priority=1))
        mgr.set_primary("p1")
        removed = mgr.unregister("p1")
        assert removed is True
        assert mgr.get_primary().name == "p2"
