"""P1-6 验证：并行工具执行器接线后的行为契约。

覆盖：
- _build_parallel_executor 的环境开关（PARALLEL_TOOL_EXECUTION / MAX_PARALLEL_TOOLS）
- _dispatch_tool_calls 在单工具时走串行、>1 工具时并发
- 并发时结果顺序与原 LLM 返回顺序一致，且工具真正重叠执行
- 失败策略 CONTINUE：单工具失败不中断同轮其他工具
- 关闭开关时回退串行，行为等价
"""

import asyncio
import os

import pytest
from unittest.mock import AsyncMock, MagicMock

from agent.core.turn_types import IterationBudget, ToolCall, ToolResult, TurnContext
from agent.core.conversation_loop import ConversationLoop


def test_build_parallel_executor_default(monkeypatch):
    monkeypatch.delenv("PARALLEL_TOOL_EXECUTION", raising=False)
    monkeypatch.delenv("MAX_PARALLEL_TOOLS", raising=False)
    ex = ConversationLoop._build_parallel_executor()
    assert ex is not None
    assert ex._config.failure_policy.value == "continue"
    assert ex._config.max_parallel == 8
    assert ex._config.enabled is True


def test_build_parallel_executor_disabled(monkeypatch):
    monkeypatch.setenv("PARALLEL_TOOL_EXECUTION", "false")
    assert ConversationLoop._build_parallel_executor() is None


@pytest.mark.parametrize(
    "env_val,expected",
    [("4", 4), ("1", 1), ("abc", 8), ("0", 1)],
)
def test_build_parallel_executor_max_parallel_env(monkeypatch, env_val, expected):
    monkeypatch.delenv("PARALLEL_TOOL_EXECUTION", raising=False)
    monkeypatch.setenv("MAX_PARALLEL_TOOLS", env_val)
    ex = ConversationLoop._build_parallel_executor()
    assert ex is not None
    assert ex._config.max_parallel == expected


@pytest.mark.anyio
async def test_dispatch_serial_when_single_tool(monkeypatch):
    monkeypatch.delenv("PARALLEL_TOOL_EXECUTION", raising=False)
    loop = ConversationLoop(llm=MagicMock())
    calls = []

    async def fake(tc: ToolCall) -> ToolResult:
        calls.append(tc.id)
        return ToolResult(tool_call_id=tc.id, name=tc.name, output="ok", success=True)

    loop._execute_tool_with_retry = fake

    tc = ToolCall(id="a", name="t", arguments='{"x":1}')
    turn = TurnContext()
    budget = IterationBudget()
    await loop._dispatch_tool_calls([tc], turn, budget)

    assert calls == ["a"]
    assert [r.tool_call_id for r in turn.tool_results] == ["a"]
    assert len(turn.messages) == 1
    assert turn.messages[0]["role"] == "tool"
    assert budget.total_tool_calls == 1
    assert budget.consecutive_failures == 0


@pytest.mark.anyio
async def test_dispatch_parallel_multiple_tools_overlap(monkeypatch):
    monkeypatch.delenv("PARALLEL_TOOL_EXECUTION", raising=False)
    loop = ConversationLoop(llm=MagicMock())
    events: list[tuple[str, str]] = []

    async def fake(tc: ToolCall) -> ToolResult:
        events.append(("start", tc.id))
        await asyncio.sleep(0.03)
        events.append(("end", tc.id))
        return ToolResult(tool_call_id=tc.id, name=tc.name, output=f"ok-{tc.id}", success=True)

    loop._execute_tool_with_retry = fake

    calls = [ToolCall(id="a", name="t", arguments="{}"), ToolCall(id="b", name="t", arguments="{}")]
    turn = TurnContext()
    budget = IterationBudget()
    await loop._dispatch_tool_calls(calls, turn, budget)

    # 结果顺序与原 LLM 返回顺序一致
    assert [r.tool_call_id for r in turn.tool_results] == ["a", "b"]
    # 并发：b 在 a 结束前已开始
    starts = {n: i for i, (ev, n) in enumerate(events) if ev == "start"}
    ends = {n: i for i, (ev, n) in enumerate(events) if ev == "end"}
    assert starts["b"] < ends["a"]
    # 每个工具都有 tool 消息回注
    assert [m["tool_call_id"] for m in turn.messages if m["role"] == "tool"] == ["a", "b"]
    assert budget.consecutive_failures == 0
    assert budget.total_tool_calls == 2


@pytest.mark.anyio
async def test_dispatch_parallel_failure_continues(monkeypatch):
    monkeypatch.delenv("PARALLEL_TOOL_EXECUTION", raising=False)
    loop = ConversationLoop(llm=MagicMock())

    async def fake(tc: ToolCall) -> ToolResult:
        ok = tc.id != "bad"
        return ToolResult(
            tool_call_id=tc.id, name=tc.name,
            output="ok" if ok else "", success=ok,
            error="" if ok else "boom",
        )

    loop._execute_tool_with_retry = fake

    calls = [
        ToolCall(id="good1", name="t", arguments="{}"),
        ToolCall(id="bad", name="t", arguments="{}"),
        ToolCall(id="good2", name="t", arguments="{}"),
    ]
    turn = TurnContext()
    budget = IterationBudget()
    await loop._dispatch_tool_calls(calls, turn, budget)

    # CONTINUE：失败不中断，三个工具全部执行
    assert [r.tool_call_id for r in turn.tool_results] == ["good1", "bad", "good2"]
    assert [r.success for r in turn.tool_results] == [True, False, True]
    # 预算侧：1 次失败 + 2 次成功
    assert budget.total_failures == 1
    assert budget.total_tool_calls == 3


@pytest.mark.anyio
async def test_dispatch_parallel_disabled_falls_back_serial(monkeypatch):
    monkeypatch.setenv("PARALLEL_TOOL_EXECUTION", "false")
    loop = ConversationLoop(llm=MagicMock())
    order = []

    async def fake(tc: ToolCall) -> ToolResult:
        order.append(tc.id)
        return ToolResult(tool_call_id=tc.id, name=tc.name, output="ok", success=True)

    loop._execute_tool_with_retry = fake

    calls = [ToolCall(id="a", name="t", arguments="{}"), ToolCall(id="b", name="t", arguments="{}")]
    turn = TurnContext()
    budget = IterationBudget()
    await loop._dispatch_tool_calls(calls, turn, budget)

    # 串行回退：a 先于 b
    assert order == ["a", "b"]
    assert [r.tool_call_id for r in turn.tool_results] == ["a", "b"]


@pytest.mark.anyio
async def test_run_multi_tool_parallel_end_to_end(monkeypatch):
    monkeypatch.delenv("PARALLEL_TOOL_EXECUTION", raising=False)
    llm = MagicMock()
    first = {
        "content": "",
        "role": "assistant",
        "finish_reason": "tool_calls",
        "tool_calls": [
            {"id": "a", "type": "function", "function": {"name": "f1", "arguments": '{"x":1}'}},
            {"id": "b", "type": "function", "function": {"name": "f2", "arguments": '{"y":2}'}},
        ],
    }
    second = {"content": "两段工具结果已汇总", "role": "assistant", "finish_reason": "stop"}
    llm.chat = AsyncMock(side_effect=[first, second])

    loop = ConversationLoop(llm=llm, tool_registry=None, max_tool_rounds=5)

    async def fake(tc: ToolCall) -> ToolResult:
        return ToolResult(tool_call_id=tc.id, name=tc.name, output=f"out-{tc.name}", success=True)

    loop._execute_tool_with_retry = fake

    result = await loop.run("并行跑两个工具")

    assert result.tool_calls_made == 2
    assert result.rounds_used == 2
    assert result.content == "两段工具结果已汇总"
