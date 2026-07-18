import pytest
import time
from unittest.mock import AsyncMock, MagicMock

from agent.core.turn_types import (
    ConversationResult,
    IterationBudget,
    ToolCall,
    ToolResult,
    TurnContext,
    TurnState,
)
from agent.core.conversation_loop import ConversationLoop
from agent.core.context_compressor import ContextCompressor, CompressionResult
from agent.memory.curator import Curator
from agent.tools.registry import ToolRegistry, ToolDefinition, register_default_tools


def test_turn_state_values():
    assert TurnState.PENDING == "pending"
    assert TurnState.TOOL_CALLING == "tool_calling"
    assert TurnState.COMPLETED == "completed"


def test_tool_call_parse_arguments():
    tc = ToolCall(id="tc1", name="test", arguments='{"key": "value"}')
    parsed = tc.parse_arguments()
    assert parsed == {"key": "value"}


def test_tool_call_parse_invalid():
    tc = ToolCall(id="tc2", name="test", arguments="invalid json")
    parsed = tc.parse_arguments()
    assert parsed == {}


def test_turn_context_duration():
    ctx = TurnContext(start_time=100.0, end_time=105.0)
    assert ctx.duration == 5.0


def test_turn_context_add_messages():
    ctx = TurnContext()
    ctx.add_user_message("hello")
    ctx.add_assistant_message("hi")
    assert len(ctx.messages) == 2
    assert ctx.messages[0]["role"] == "user"
    assert ctx.messages[1]["role"] == "assistant"


def test_iteration_budget():
    budget = IterationBudget(max_tool_rounds=5)
    assert budget.remaining_rounds == 5
    assert budget.is_exhausted is False

    for _ in range(5):
        budget.increment()
    assert budget.is_exhausted is True
    assert budget.remaining_rounds == 0


def test_iteration_budget_tokens():
    budget = IterationBudget()
    budget.add_tokens(100)
    budget.add_tokens(50)
    assert budget.total_tokens_used == 150


@pytest.mark.anyio
async def test_conversation_loop_simple():
    llm = MagicMock()
    llm.chat = AsyncMock(return_value={
        "content": "你好！有什么可以帮你的？",
        "role": "assistant",
        "finish_reason": "stop",
    })

    loop = ConversationLoop(llm=llm, max_tool_rounds=5)
    result = await loop.run("你好", use_tools=False)

    assert isinstance(result, ConversationResult)
    assert result.content == "你好！有什么可以帮你的？"
    assert result.finish_reason == "stop"
    assert result.rounds_used == 1


@pytest.mark.anyio
async def test_conversation_loop_with_tool_call():
    llm = MagicMock()

    first_response = {
        "content": "",
        "role": "assistant",
        "finish_reason": "tool_calls",
        "tool_calls": [
            {
                "id": "tc_1",
                "type": "function",
                "function": {
                    "name": "memory_recall",
                    "arguments": '{"query": "test"}',
                },
            }
        ],
    }

    second_response = {
        "content": "根据记忆，你之前提到过...",
        "role": "assistant",
        "finish_reason": "stop",
    }

    llm.chat = AsyncMock(side_effect=[first_response, second_response])

    registry = ToolRegistry()
    register_default_tools(registry)

    loop = ConversationLoop(llm=llm, tool_registry=registry, max_tool_rounds=5)
    result = await loop.run("我之前说过什么？")

    assert result.content == "根据记忆，你之前提到过..."
    assert result.tool_calls_made == 1
    assert result.rounds_used == 2


@pytest.mark.anyio
async def test_conversation_loop_retry():
    llm = MagicMock()
    llm.chat = AsyncMock(side_effect=[
        Exception("API Error"),
        {"content": "重试成功", "role": "assistant", "finish_reason": "stop"},
    ])

    loop = ConversationLoop(llm=llm, max_tool_rounds=5, max_retries=2)
    result = await loop.run("测试重试", use_tools=False)

    assert result.content == "重试成功"


@pytest.mark.anyio
async def test_conversation_loop_all_retries_failed():
    llm = MagicMock()
    llm.chat = AsyncMock(side_effect=Exception("Persistent Error"))

    loop = ConversationLoop(llm=llm, max_tool_rounds=5, max_retries=1)
    result = await loop.run("测试失败", use_tools=False)

    assert "失败" in result.content
    assert result.finish_reason == "error"


def test_context_compressor_no_compression_needed():
    compressor = ContextCompressor(max_context_tokens=10000)
    messages = [
        {"role": "system", "content": "系统提示"},
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "你好！"},
    ]
    result = compressor.compress(messages)
    assert result.strategy == "none_needed"
    assert result.ratio == 1.0


def test_context_compressor_truncate_tool_output():
    compressor = ContextCompressor(max_context_tokens=100)
    messages = [
        {"role": "system", "content": "系统提示"},
        {"role": "user", "content": "运行命令"},
        {"role": "assistant", "content": "执行中"},
        {"role": "tool", "content": "x" * 5000, "tool_call_id": "tc1"},
    ]
    result = compressor.compress(messages)
    assert result.compressed_tokens < result.original_tokens


def test_context_compressor_summarize_history():
    compressor = ContextCompressor(max_context_tokens=200)
    messages = [
        {"role": "system", "content": "系统提示"},
    ]
    for i in range(10):
        messages.append({"role": "user", "content": f"用户消息 {i} " * 20})
        messages.append({"role": "assistant", "content": f"助手回复 {i} " * 20})

    result = compressor.compress(messages)
    assert result.compressed_tokens < result.original_tokens
    assert result.removed_messages > 0


def test_context_compressor_keep_recent_only():
    compressor = ContextCompressor(max_context_tokens=100)
    messages = [
        {"role": "system", "content": "系统提示"},
    ]
    for i in range(20):
        messages.append({"role": "user", "content": f"消息 {i} " * 30})
        messages.append({"role": "assistant", "content": f"回复 {i} " * 30})

    result = compressor.compress(messages)
    assert result.compressed_tokens < result.original_tokens


def test_context_compressor_empty():
    compressor = ContextCompressor()
    result = compressor.compress([])
    assert result.strategy == "empty"


@pytest.mark.anyio
async def test_curator_review():
    from agent.memory.engine import MemoryEngine

    memory = MemoryEngine(db_path=":memory:")
    await memory.initialize()

    for i in range(6):
        await memory.store(f"测试记忆内容 {i}", memory_type="short_term", scene="test")

    curator = Curator(memory=memory)
    result = await curator.review()

    assert result.reviewed >= 0


def test_context_compressor_extract_attention_keywords():
    compressor = ContextCompressor()
    messages = [
        {"role": "user", "content": "帮我写一个Python函数"},
        {"role": "assistant", "content": "好的，我来帮你写Python代码"},
        {"role": "user", "content": "这个Python函数需要处理异常"},
    ]
    keywords = compressor.extract_attention_keywords(messages)
    assert isinstance(keywords, list)
    assert len(keywords) > 0


def test_context_compressor_extract_attention_keywords_empty():
    compressor = ContextCompressor()
    keywords = compressor.extract_attention_keywords([])
    assert keywords == []


def test_context_compressor_compress_with_attention_no_memory():
    compressor = ContextCompressor(max_context_tokens=10000)
    messages = [
        {"role": "user", "content": "帮我写代码"},
        {"role": "assistant", "content": "好的，我来帮你"},
    ]
    result = compressor.compress_with_attention(messages)
    assert result.ratio > 0
    assert isinstance(result.attention_keywords, list)


def test_context_compressor_compress_with_attention_with_memory():
    compressor = ContextCompressor(max_context_tokens=10000)
    messages = [
        {"role": "user", "content": "帮我写Python代码"},
        {"role": "assistant", "content": "好的，Python代码如下"},
    ]
    memory_results = [
        {"content": "Python是一种编程语言", "relevance_score": 0.8},
        {"content": "代码调试技巧", "relevance_score": 0.5},
    ]
    result = compressor.compress_with_attention(messages, memory_results=memory_results)
    assert result.ratio > 0
    assert isinstance(result.attention_keywords, list)


def test_context_compressor_compress_with_attention_empty():
    compressor = ContextCompressor()
    result = compressor.compress_with_attention([])
    assert result.strategy == "empty"


@pytest.mark.anyio
async def test_curator_self_reminder():
    from agent.memory.engine import MemoryEngine

    memory = MemoryEngine(db_path=":memory:")
    await memory.initialize()

    await memory.store("明天下午3点有会议提醒", memory_type="short_term", scene="schedule")
    await memory.store("待办：提交周报", memory_type="short_term", scene="task")

    curator = Curator(memory=memory)
    reminder = await curator.generate_self_reminder()

    assert reminder is not None


@pytest.mark.anyio
async def test_curator_no_reminders():
    from agent.memory.engine import MemoryEngine

    memory = MemoryEngine(db_path=":memory:")
    await memory.initialize()

    await memory.store("今天天气不错", memory_type="short_term", scene="daily")
    await memory.store("Python 是一门好语言", memory_type="short_term", scene="tech")

    curator = Curator(memory=memory)
    reminder = await curator.generate_self_reminder(context="天气")

    assert reminder is None
