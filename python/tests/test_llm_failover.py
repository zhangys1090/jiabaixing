"""P0-2 回归测试：LLM 故障转移（跨厂商 failover）与重试。

核心覆盖：
1. ``ProviderManager.get_fallback`` / ``fallback_chain`` 在 ``exclude=None`` / 单名 / 集合
   下都能稳定跳过已失败的 primary —— 修复旧实现「回退到同一失败 primary」的致命缺陷。
2. ``LLMProvider._do_chat_via_litellm`` 在 primary 失败时真实切换到次优 provider（不再选中自身）。
3. ``chat()`` 的 transport 路径失败时回退到 litellm 路径（修复 transport 路径无 failover）。
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.llm.provider import LLMProvider
from agent.llm.router import ProviderConfig, ProviderManager


def _make_manager(tmp_path) -> ProviderManager:
    m = ProviderManager(data_dir=str(tmp_path))
    m._providers.clear()
    m._primary = None
    m.register(ProviderConfig(name="p_primary", model="primary-model", api_key="k1", priority=0, enabled=True))
    m.register(ProviderConfig(name="p_secondary", model="secondary-model", api_key="k2", priority=10, enabled=True))
    m.register(ProviderConfig(name="p_tertiary", model="tertiary-model", api_key="k3", priority=20, enabled=True))
    return m


def test_get_fallback_excludes_failed_primary(tmp_path):
    m = _make_manager(tmp_path)
    assert m.get_fallback(exclude=None).name == "p_primary"
    assert m.get_fallback(exclude="p_primary").name == "p_secondary"
    assert m.get_fallback(exclude={"p_primary"}).name == "p_secondary"
    chain = [p.name for p in m.fallback_chain(exclude="p_primary")]
    assert chain == ["p_secondary", "p_tertiary"]
    chain2 = [p.name for p in m.fallback_chain(exclude={"p_primary", "p_secondary"})]
    assert chain2 == ["p_tertiary"]


class _FakeBreaker:
    async def call(self, fn):
        return await fn()


class _FakeRateLimiter:
    async def acquire(self):
        return True

    async def record_result(self, ok):
        return None


class _FakeCache:
    def get(self, *a, **k):
        return None

    def set(self, *a, **k):
        return None


def test_litellm_failover_switches_provider(tmp_path):
    mgr = _make_manager(tmp_path)
    prov = LLMProvider()
    prov.provider_manager = mgr
    prov.model = "primary-model"
    prov.credential_pool = None
    prov.rate_limiter = _FakeRateLimiter()
    prov.tiered_cache = _FakeCache()
    prov.failover_base_backoff = 0.0
    prov.failover_max_backoff = 0.0
    prov.max_failover_attempts = 4
    prov.get_circuit_breaker = lambda name="": _FakeBreaker()  # type: ignore[assignment]

    calls: list[str] = []

    async def fake_acompletion(**kwargs):
        calls.append(kwargs.get("model"))
        if kwargs.get("model") == "primary-model":
            raise RuntimeError("primary down")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(role="assistant", content="ok", tool_calls=None), finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
        )

    with patch("agent.llm.provider.acompletion", fake_acompletion):
        result = asyncio.get_event_loop().run_until_complete(
            prov._do_chat_via_litellm([{"role": "user", "content": "hi"}], tools=None, stream=False)
        )

    assert result["content"] == "ok"
    assert "primary-model" in calls, "primary 应被首先尝试"
    assert "secondary-model" in calls, "primary 失败后必须切换到次优 provider（真实 failover）"


def test_litellm_failover_falls_through_chain(tmp_path):
    mgr = _make_manager(tmp_path)
    # 把 secondary 从候选链中排除（模拟「已失败/已禁用」），验证链式跳过到 tertiary
    prov = LLMProvider()
    prov.provider_manager = mgr
    prov.model = "primary-model"
    prov.credential_pool = None
    prov.rate_limiter = _FakeRateLimiter()
    prov.tiered_cache = _FakeCache()
    prov.failover_base_backoff = 0.0
    prov.failover_max_backoff = 0.0
    prov.max_failover_attempts = 4
    prov.get_circuit_breaker = lambda name="": _FakeBreaker()  # type: ignore[assignment]

    calls: list[str] = []

    async def fake_acompletion(**kwargs):
        calls.append(kwargs.get("model"))
        if kwargs.get("model") in ("primary-model", "secondary-model"):
            raise RuntimeError("down")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(role="assistant", content="ok", tool_calls=None), finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
        )

    with patch("agent.llm.provider.acompletion", fake_acompletion):
        result = asyncio.get_event_loop().run_until_complete(
            prov._do_chat_via_litellm([{"role": "user", "content": "hi"}], tools=None, stream=False)
        )

    assert result["content"] == "ok"
    # primary 与 secondary 均失败，必须沿候选链落到 tertiary（验证链式跳过）
    assert calls == ["primary-model", "secondary-model", "tertiary-model"]


def test_chat_transport_falls_back_to_litellm(tmp_path):
    mgr = _make_manager(tmp_path)
    prov = LLMProvider()
    prov.provider_manager = mgr
    prov.model = "primary-model"
    prov.credential_pool = None
    prov.rate_limiter = _FakeRateLimiter()
    prov.tiered_cache = _FakeCache()
    prov.get_circuit_breaker = lambda name="": _FakeBreaker()  # type: ignore[assignment]

    async def boom(*a, **k):
        raise RuntimeError("transport down")

    async def litellm_ok(*a, **k):
        return {"content": "LITELLM_OK", "role": "assistant", "finish_reason": "stop"}

    with patch.object(prov, "_resolve_transport", return_value=object()), patch.object(
        prov, "_do_chat_via_transport", boom
    ), patch.object(prov, "_do_chat_via_litellm", litellm_ok):
        out = asyncio.get_event_loop().run_until_complete(prov.chat([{"role": "user", "content": "hi"}]))

    assert out["content"] == "LITELLM_OK"
