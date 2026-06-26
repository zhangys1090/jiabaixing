from __future__ import annotations

import os
import tempfile
import time

import pytest

from agent.llm.credential_pool import (
    CostGuard,
    CredentialEntry,
    CredentialPool,
    CredentialState,
    RotationStrategy,
    UsageRecord,
)
from agent.llm.prompt_cache import CacheResult, PromptCacheManager, PromptCacheStore


class TestCredentialEntry:
    def test_masked_short_key(self):
        entry = CredentialEntry(key="abc")
        assert entry.masked == "***"

    def test_masked_long_key(self):
        entry = CredentialEntry(key="sk-1234567890abcdef")
        assert entry.masked == "sk-1...cdef"


class TestCredentialPool:
    def _make_pool(self, keys: list[str], strategy: RotationStrategy = RotationStrategy.FILL_FIRST) -> CredentialPool:
        entries = [CredentialEntry(key=k, weight=1.0) for k in keys]
        return CredentialPool("test-provider", entries, strategy)

    def test_fill_first_always_returns_first(self):
        pool = self._make_pool(["key-1", "key-2", "key-3"])
        results = [pool.get_next().key for _ in range(5)]
        assert all(k == "key-1" for k in results)

    def test_round_robin_rotates(self):
        pool = self._make_pool(["key-1", "key-2", "key-3"], RotationStrategy.ROUND_ROBIN)
        results = [pool.get_next().key for _ in range(6)]
        assert results == ["key-1", "key-2", "key-3", "key-1", "key-2", "key-3"]

    def test_least_used(self):
        pool = self._make_pool(["key-1", "key-2"], RotationStrategy.LEAST_USED)
        pool.report_success("key-1")
        pool.report_success("key-1")
        pool.report_success("key-1")
        next_key = pool.get_next()
        assert next_key.key == "key-2"

    def test_report_rate_limit(self):
        pool = self._make_pool(["key-1", "key-2"])
        pool.report_rate_limit("key-1", time.time() + 3600)
        available = pool.get_available_credentials()
        assert len(available) == 1
        assert available[0].key == "key-2"

    def test_report_failure(self):
        pool = self._make_pool(["key-1", "key-2"])
        for _ in range(3):
            pool.report_failure("key-1")
        available = pool.get_available_credentials()
        assert len(available) == 1
        assert available[0].key == "key-2"

    def test_report_success_resets_failures(self):
        pool = self._make_pool(["key-1", "key-2"])
        pool.report_failure("key-1")
        pool.report_failure("key-1")
        pool.report_success("key-1")
        available = pool.get_available_credentials()
        assert any(c.key == "key-1" for c in available)

    def test_force_reset_when_all_unavailable(self):
        pool = self._make_pool(["key-1"])
        for _ in range(3):
            pool.report_failure("key-1")
        next_key = pool.get_next()
        assert next_key is not None
        assert next_key.key == "key-1"

    def test_size_properties(self):
        pool = self._make_pool(["key-1", "key-2", "key-3"])
        assert pool.size == 3
        assert pool.available_size == 3
        pool.report_rate_limit("key-1", time.time() + 3600)
        assert pool.available_size == 2

    def test_get_stats(self):
        pool = self._make_pool(["key-1", "key-2"])
        stats = pool.get_stats()
        assert stats["provider"] == "test-provider"
        assert stats["total"] == 2
        assert stats["available"] == 2
        assert len(stats["credentials"]) == 2

    def test_rate_limit_expiry(self):
        pool = self._make_pool(["key-1", "key-2"])
        pool.report_rate_limit("key-1", time.time() - 1)
        available = pool.get_available_credentials()
        assert len(available) == 2

    def test_random_strategy_uses_all_keys(self):
        pool = self._make_pool(["key-1", "key-2", "key-3"], RotationStrategy.RANDOM)
        used = set()
        for _ in range(100):
            used.add(pool.get_next().key)
        assert len(used) == 3


class TestCostGuard:
    def test_calculate_cost_known_model(self):
        guard = CostGuard()
        cost = guard.calculate_cost("gpt-4o", 1000, 500)
        assert cost > 0

    def test_calculate_cost_unknown_model(self):
        guard = CostGuard()
        cost = guard.calculate_cost("unknown-model", 1000, 500)
        assert cost > 0

    def test_record_usage(self):
        guard = CostGuard()
        record = guard.record_usage("gpt-4o", 1000, 500)
        assert record.input_tokens == 1000
        assert record.output_tokens == 500
        assert record.cost_usd > 0

    def test_check_budget_within(self):
        guard = CostGuard(daily_budget_usd=1.0, per_request_budget_usd=0.05)
        assert guard.check_budget(0.01) is True

    def test_check_budget_exceeds_per_request(self):
        guard = CostGuard(daily_budget_usd=1.0, per_request_budget_usd=0.05)
        assert guard.check_budget(0.10) is False

    def test_check_budget_exceeds_daily(self):
        guard = CostGuard(daily_budget_usd=0.001, per_request_budget_usd=1.0)
        guard.record_usage("gpt-4o", 100000, 50000)
        assert guard.check_budget(0.01) is False

    def test_get_daily_stats(self):
        guard = CostGuard()
        guard.record_usage("gpt-4o", 1000, 500)
        guard.record_usage("claude-3.5-sonnet", 2000, 1000)
        stats = guard.get_daily_stats()
        assert stats["request_count"] == 2
        assert "gpt-4o" in stats["by_model"]
        assert "claude-3.5-sonnet" in stats["by_model"]
        assert stats["total_cost_usd"] > 0
        assert stats["budget_remaining_usd"] > 0

    def test_set_daily_budget(self):
        guard = CostGuard(daily_budget_usd=1.0)
        guard.set_daily_budget(5.0)
        stats = guard.get_daily_stats()
        assert stats["daily_budget_usd"] == 5.0


class TestPromptCacheStore:
    def test_set_and_get(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = PromptCacheStore(os.path.join(tmpdir, "test.db"))
            store.set_entry("key1", "value1", 60000)
            entry = store.get_entry("key1")
            assert entry is not None
            assert entry.value == "value1"
            store.close()

    def test_expired_entry(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = PromptCacheStore(os.path.join(tmpdir, "test.db"))
            store.set_entry("key1", "value1", 1)
            time.sleep(0.01)
            entry = store.get_entry("key1")
            assert entry is None
            store.close()

    def test_hit_count_increment(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = PromptCacheStore(os.path.join(tmpdir, "test.db"))
            store.set_entry("key1", "value1", 60000)
            store.get_entry("key1")
            store.get_entry("key1")
            entry = store.get_entry("key1")
            assert entry is not None
            assert entry.hit_count == 3
            store.close()

    def test_prefix_entries(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = PromptCacheStore(os.path.join(tmpdir, "test.db"))
            store.set_prefix_entry("pk1", "hash1", "user input", "1", 60000)
            results = store.get_by_prefix_hash("hash1")
            assert len(results) == 1
            assert results[0].user_input == "user input"
            store.close()

    def test_cleanup_expired(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = PromptCacheStore(os.path.join(tmpdir, "test.db"))
            store.set_entry("expired", "val", 1)
            store.set_entry("valid", "val2", 60000)
            time.sleep(0.01)
            removed = store.cleanup_expired()
            assert removed >= 1
            assert store.get_entry("valid") is not None
            store.close()


class TestPromptCacheManager:
    _db_counter = 0

    def _make_manager(
        self,
        enabled: bool = True,
        similarity_threshold: float = 0.7,
        min_word_count: int = 3,
    ) -> PromptCacheManager:
        TestPromptCacheManager._db_counter += 1
        tmpdir = os.path.join(tempfile.gettempdir(), "jbx_pcache_test")
        os.makedirs(tmpdir, exist_ok=True)
        db_path = os.path.join(tmpdir, f"cache_{TestPromptCacheManager._db_counter}_{int(time.time()*1000)}.db")
        store = PromptCacheStore(db_path)
        mgr = PromptCacheManager(
            enabled=enabled,
            default_ttl_ms=60000,
            similarity_threshold=similarity_threshold,
            min_word_count=min_word_count,
        )
        mgr._store.close()
        mgr._store = store
        return mgr

    def test_exact_hit(self):
        mgr = self._make_manager()
        params = {
            "system_prompt": "你是一个助手",
            "messages": [{"role": "user", "content": "你好"}],
            "model_name": "test-model",
        }
        mgr.store_exact(params, "你好！有什么可以帮你的？")
        result = mgr.try_get_exact(params)
        assert result.hit is True
        assert result.value == "你好！有什么可以帮你的？"
        assert result.match_type == "exact"
        mgr.close()

    def test_exact_miss(self):
        mgr = self._make_manager()
        params = {
            "system_prompt": "你是一个助手",
            "messages": [{"role": "user", "content": "你好"}],
            "model_name": "test-model",
        }
        result = mgr.try_get_exact(params)
        assert result.hit is False
        assert result.match_type == "none"
        mgr.close()

    def test_prefix_miss(self):
        mgr = self._make_manager()
        params1 = {
            "system_prompt": "你是一个助手",
            "messages": [{"role": "user", "content": "分析代码"}],
            "model_name": "test-model",
        }
        mgr.store_exact(params1, "代码分析结果已完成")

        params2 = {
            "system_prompt": "你是一个助手",
            "messages": [{"role": "user", "content": "重构代码"}],
            "model_name": "test-model",
        }
        result = mgr.try_get_exact(params2)
        assert result.hit is False
        assert result.match_type == "prefix_miss"
        mgr.close()

    def test_semantic_hit(self):
        mgr = self._make_manager(similarity_threshold=0.3, min_word_count=2)
        params1 = {
            "system_prompt": "你是一个助手",
            "messages": [{"role": "user", "content": "帮我分析这段代码的性能问题"}],
            "model_name": "test-model",
        }
        mgr.store_exact(params1, "性能分析结果已完成")

        params2 = {
            "system_prompt": "你是一个助手",
            "messages": [{"role": "user", "content": "帮我分析这段代码的性能瓶颈"}],
            "model_name": "test-model",
        }
        result = mgr.try_get_exact(params2)
        assert result.hit is True
        assert result.match_type == "semantic"
        mgr.close()

    def test_disabled_cache(self):
        mgr = PromptCacheManager(enabled=False)
        params = {
            "system_prompt": "sys",
            "messages": [{"role": "user", "content": "hi"}],
            "model_name": "m",
        }
        mgr.store_exact(params, "response")
        result = mgr.try_get_exact(params)
        assert result.hit is False
        assert result.match_type == "disabled"
        mgr.close()

    def test_short_response_not_cached(self):
        mgr = self._make_manager()
        params = {
            "system_prompt": "sys",
            "messages": [{"role": "user", "content": "hi"}],
            "model_name": "m",
        }
        mgr.store_exact(params, "ok")
        result = mgr.try_get_exact(params)
        assert result.hit is False
        mgr.close()

    def test_get_stats(self):
        mgr = self._make_manager()
        params = {
            "system_prompt": "sys",
            "messages": [{"role": "user", "content": "hi"}],
            "model_name": "m",
        }
        mgr.store_exact(params, "hello world response that is long enough")
        mgr.try_get_exact(params)
        stats = mgr.get_stats()
        assert stats["enabled"] is True
        assert stats["session_hits"] == 1
        assert stats["session_misses"] == 0
        mgr.close()

    def test_cleanup(self):
        mgr = PromptCacheManager(default_ttl_ms=1)
        params = {
            "system_prompt": "sys",
            "messages": [{"role": "user", "content": "hi"}],
            "model_name": "m",
        }
        mgr.store_exact(params, "hello world response that is long enough")
        time.sleep(0.01)
        removed = mgr.cleanup()
        assert removed >= 1
        mgr.close()


class TestLLMProviderIntegration:
    def test_setup_credential_pool(self):
        from agent.llm.provider import LLMProvider
        provider = LLMProvider()
        provider.setup_credential_pool(["key-1", "key-2", "key-3"], RotationStrategy.ROUND_ROBIN)
        assert provider.credential_pool is not None
        assert provider.credential_pool.size == 3

    def test_cost_guard_default(self):
        from agent.llm.provider import LLMProvider
        provider = LLMProvider()
        stats = provider.get_cost_stats()
        assert "total_cost_usd" in stats
        assert "daily_budget_usd" in stats

    def test_cache_stats(self):
        from agent.llm.provider import LLMProvider
        provider = LLMProvider()
        stats = provider.get_cache_stats()
        assert "enabled" in stats

    def test_credential_stats_no_pool(self):
        from agent.llm.provider import LLMProvider
        provider = LLMProvider()
        stats = provider.get_credential_stats()
        assert stats["total"] == 0
