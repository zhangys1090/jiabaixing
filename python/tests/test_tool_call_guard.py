from __future__ import annotations

import time

import pytest

from agent.tools.tool_call_guard import ToolCallGuard


# ─── Basic check ───


def test_check_allowed_first_call():
    guard = ToolCallGuard()
    result = guard.check("web_search", {"query": "Python"})
    assert result.blocked is False


def test_check_duplicate_blocked():
    guard = ToolCallGuard()
    guard.record("web_search", {"query": "Python"}, {"success": True, "output": "result"})
    result = guard.check("web_search", {"query": "Python"})
    assert result.blocked is True
    assert result.result is not None


def test_check_different_args_allowed():
    guard = ToolCallGuard()
    guard.record("web_search", {"query": "Python"}, {"success": True, "output": "res1"})
    result = guard.check("web_search", {"query": "TypeScript"})
    assert result.blocked is False


# ─── Cache ───


def test_cache_hit():
    guard = ToolCallGuard()
    guard.record("web_search", {"query": "Python"}, {"success": True, "output": "cached_result"})
    result = guard.check("web_search", {"query": "Python"})
    assert result.blocked is True
    assert "cached_result" in str(result.result) if result.result else False


def test_cache_key_order():
    guard = ToolCallGuard()
    guard.record("web_search", {"b": 2, "a": 1}, {"success": True, "output": "ordered"})
    result = guard.check("web_search", {"a": 1, "b": 2})
    assert result.blocked is True


# ─── Rate limiting ───


def test_rate_limit():
    guard = ToolCallGuard()
    guard.record("web_search", {"query": "Python"}, {"success": True, "output": "r1"})
    guard.record("web_search", {"query": "TypeScript"}, {"success": True, "output": "r2"})
    result = guard.check("web_search", {"query": "Go"})
    assert result.blocked is True
    assert "速率限制" in str(result.result) if result.result else False


def test_rate_limit_reset():
    guard = ToolCallGuard()
    guard.record("tool_a", {"q": "1"}, {"success": True, "output": "r1"})
    guard.record("tool_a", {"q": "2"}, {"success": True, "output": "r2"})
    guard.reset_round()
    result = guard.check("tool_a", {"q": "3"})
    assert result.blocked is False


# ─── Stats ───


def test_get_stats():
    guard = ToolCallGuard()
    guard.record("tool_a", {"q": "1"}, {"success": True, "output": "r1"})
    guard.record("tool_a", {"q": "2"}, {"success": True, "output": "r2"})
    guard.record("tool_b", {"q": "1"}, {"success": True, "output": "r3"})

    stats = guard.get_stats()
    assert stats["total_calls"] == 3
    assert "tool_a" in stats["per_tool"]
    assert stats["per_tool"]["tool_a"] == 2


def test_get_stats_empty():
    guard = ToolCallGuard()
    stats = guard.get_stats()
    assert stats["total_calls"] == 0
    assert stats["cache_size"] == 0


# ─── Reset ───


def test_reset_round_clears():
    guard = ToolCallGuard()
    guard.record("tool_a", {"q": "1"}, {"success": True, "output": "r1"})
    guard.reset_round()
    stats = guard.get_stats()
    assert stats["total_calls"] == 0


# ─── Failed results not cached ───


def test_failed_result_not_cached():
    guard = ToolCallGuard()
    guard.record("bad_tool", {"q": "1"}, {"success": False, "output": "failed"})
    result = guard.check("bad_tool", {"q": "different_query"})
    assert result.blocked is False


# ─── Unhashable args ───


def test_unhashable_args():
    guard = ToolCallGuard()
    guard.record("tool", {"callback": str}, {"success": True, "output": "r"})
    result = guard.check("tool", {"callback": int})
    assert result.blocked is False
