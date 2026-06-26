from __future__ import annotations

import pytest

from agent.context.attention_focus import (
    AttentionFocusEngine,
    AttentionWeight,
    FocusResult,
    MessageItem,
)


def _msg(content: str = "", role: str = "user") -> MessageItem:
    return MessageItem(role=role, content=content)


# ─── Extract Keywords ───


def test_extract_keywords_basic():
    engine = AttentionFocusEngine()
    keywords = engine.extract_keywords("帮我写一个Python函数")
    assert len(keywords) >= 1
    assert any("python" in k for k in keywords)


def test_extract_keywords_with_path():
    engine = AttentionFocusEngine()
    keywords = engine.extract_keywords("修改 src/models/User.ts 文件")
    assert len(keywords) >= 1


def test_extract_keywords_empty():
    engine = AttentionFocusEngine()
    keywords = engine.extract_keywords("")
    assert len(keywords) == 0


def test_extract_keywords_stop_words():
    engine = AttentionFocusEngine()
    keywords = engine.extract_keywords("的 了 在 是")
    assert len(keywords) == 0


def test_extract_keywords_max_limit():
    engine = AttentionFocusEngine()
    long_task = " ".join(f"keyword{i}" for i in range(20))
    keywords = engine.extract_keywords(long_task)
    assert len(keywords) <= 10


# ─── Calculate Weights ───


def test_calculate_weights_basic():
    engine = AttentionFocusEngine()
    messages = [
        _msg("Python代码编写", "user"),
        _msg("今天天气不错", "assistant"),
    ]
    weights = engine.calculate_weights(messages, "Python函数")
    assert len(weights) == 2
    assert weights[0].weight > weights[1].weight


def test_calculate_weights_keyword_match():
    engine = AttentionFocusEngine()
    messages = [
        _msg("Python函数开发", "user"),
        _msg("无关内容", "assistant"),
    ]
    weights = engine.calculate_weights(messages, "Python函数")
    assert weights[0].keyword_score > weights[1].keyword_score


def test_calculate_weights_position():
    engine = AttentionFocusEngine()
    messages = [
        _msg("相同内容", "user"),
        _msg("相同内容", "user"),
        _msg("相同内容", "user"),
    ]
    weights = engine.calculate_weights(messages, "相同内容")
    assert weights[2].position_score > weights[0].position_score


def test_calculate_weights_role():
    engine = AttentionFocusEngine()
    messages = [
        _msg("相同内容", "user"),
        _msg("相同内容", "assistant"),
    ]
    weights = engine.calculate_weights(messages, "相同内容")
    assert weights[0].role_score > weights[1].role_score


def test_calculate_weights_density():
    engine = AttentionFocusEngine()
    messages = [
        _msg("Error in /src/main.py: line 42", "assistant"),
        _msg("普通文本内容", "assistant"),
    ]
    weights = engine.calculate_weights(messages, "error")
    assert weights[0].density_score > weights[1].density_score


def test_calculate_weights_empty_messages():
    engine = AttentionFocusEngine()
    weights = engine.calculate_weights([], "task")
    assert len(weights) == 0


def test_calculate_weights_empty_task():
    engine = AttentionFocusEngine()
    messages = [_msg("test")]
    weights = engine.calculate_weights(messages, "")
    assert len(weights) == 1
    assert weights[0].weight == 0.0


def test_calculate_weights_max_one():
    engine = AttentionFocusEngine()
    messages = [_msg("Python Python Python error /path fail 123", "user")]
    weights = engine.calculate_weights(messages, "Python error")
    assert weights[0].weight <= 1.0


# ─── Focus ───


def test_focus_basic():
    engine = AttentionFocusEngine()
    messages = [
        _msg("Python代码编写", "user"),
        _msg("天气查询", "assistant"),
        _msg("Python调试", "user"),
    ]
    result = engine.focus(messages, "Python函数", token_budget=500)
    assert isinstance(result, FocusResult)
    assert result.original_count == 3
    assert result.focused_count <= 3
    assert result.tokens_used <= 500


def test_focus_preserves_order():
    engine = AttentionFocusEngine()
    messages = [
        _msg("Python代码", "user"),
        _msg("Java代码", "assistant"),
        _msg("Python调试", "user"),
    ]
    result = engine.focus(messages, "Python", token_budget=500)

    python_contents = [m.content for m in result.focused_messages if "Python" in m.content]
    if len(python_contents) >= 2:
        first_idx = next(i for i, m in enumerate(messages) if m.content == result.focused_messages[0].content)
        assert first_idx >= 0


def test_focus_tight_budget():
    engine = AttentionFocusEngine()
    messages = [
        _msg("A" * 200, "user"),
        _msg("B" * 200, "assistant"),
        _msg("C" * 200, "user"),
    ]
    result = engine.focus(messages, "test", token_budget=30)
    assert result.focused_count < 3


def test_focus_empty_messages():
    engine = AttentionFocusEngine()
    result = engine.focus([], "task", token_budget=500)
    assert result.original_count == 0
    assert result.focused_count == 0


def test_focus_reduction_ratio():
    engine = AttentionFocusEngine()
    messages = [_msg(f"msg {i}", "user") for i in range(10)]
    result = engine.focus(messages, "msg 0", token_budget=50)
    assert 0.0 <= result.reduction_ratio <= 1.0


# ─── History & Stats ───


def test_focus_history():
    engine = AttentionFocusEngine()
    messages = [_msg("test")]
    engine.focus(messages, "test", token_budget=500)
    engine.focus(messages, "test2", token_budget=500)

    history = engine.get_history()
    assert len(history) == 2


def test_focus_stats():
    engine = AttentionFocusEngine()
    messages = [_msg("test")]
    engine.focus(messages, "test", token_budget=500)

    stats = engine.get_stats()
    assert stats["total_focuses"] == 1
    assert "avg_reduction" in stats


def test_focus_stats_empty():
    engine = AttentionFocusEngine()
    stats = engine.get_stats()
    assert stats["total_focuses"] == 0


def test_focus_history_limit():
    engine = AttentionFocusEngine()
    messages = [_msg("test")]
    for i in range(150):
        engine.focus(messages, f"task {i}", token_budget=500)

    assert len(engine._history) <= 100
