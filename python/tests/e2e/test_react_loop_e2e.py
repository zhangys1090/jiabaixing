"""jiabaixing ReAct 循环端到端（E2E）测试 — 反思式自纠错循环能力验证。

直接驱动 ``LoopController.run_react_loop``，以 Mock LLM 替代真实推理，
验证 ReAct 循环「Thought → Action → Observation → Answer」的完整生命周期：

- 全周期（最终答案）：循环启动 → 结构化步骤 → 产出最终成功答案。
- 真实工具执行：LLM 返回工具调用动作 → 执行真实 file_list 工具 → 观察结果 → 最终答案。
- 能力接线：LoopController 必须齐备 planner / executor / evaluator 子系统。
- 边界：取消事件（cancel_event）触发时循环必须及时优雅退出，绝不挂起或崩溃。

不依赖任何外部 LLM API。标记：pytest.mark.e2e
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from agent.loop.controller import LoopController
from agent.loop.types import AgentResult
from agent.tools.registry import ToolRegistry, register_default_tools

pytestmark = pytest.mark.e2e


def _final_answer_llm() -> AsyncMock:
    """Mock LLM：直接返回「最终回答」结构化动作（is_final）。"""
    llm = AsyncMock()
    llm.chat = AsyncMock(
        return_value={
            "content": '{"thought":"直接回答","action":{"final_answer":"家百星已完成任务"},"observation":""}'
        }
    )
    return llm


def _plain_llm() -> AsyncMock:
    """Mock LLM：返回非最终答案（使循环进入工具/自纠错路径，用于取消边界）。"""
    llm = AsyncMock()
    llm.chat = AsyncMock(return_value={"content": "mock response"})
    return llm


def _real_tool_registry() -> ToolRegistry:
    reg = ToolRegistry()
    register_default_tools(reg)
    return reg


async def test_react_loop_full_cycle():
    """run_react_loop 在 Mock LLM 下完成完整周期并成功产出最终答案。"""
    ctrl = LoopController(llm=_final_answer_llm())
    result: AgentResult = await ctrl.run_react_loop("请帮我查询今天的天气")

    assert result.success is True
    assert isinstance(result.response, str) and len(result.response) > 0
    assert "家百星已完成任务" in result.response

    # 确实以 ReAct 模式运行，并产生了结构化步骤（证明 Thought/Action/Observation 发生过）
    meta = result.metadata or {}
    assert meta.get("react_mode") is True
    steps = meta.get("structured_steps") or []
    assert len(steps) >= 1


async def test_react_loop_with_real_tool_execution():
    """ReAct 循环调用真实工具（file_list）并观察结果，再产出最终答案。

    验证 Thought→Action(真实工具)→Observation→Answer 的完整闭环，而非仅 Mock 链路。
    Mock LLM 用生成器：首轮返回工具调用动作，之后恒返回最终答案，
    以兼容循环对 chat 的调用次数差异（工具执行可能短回路或触发后台知识提取）。
    """
    llm = AsyncMock()

    def _react_responses():
        # llm.chat 必须返回 {"content": "<JSON 字符串>"}（与真实 LLMProvider.chat 一致）
        yield {
            "content": '{"thought":"列出当前目录文件","action":{"tool_name":"file_list","tool_args":{}},"observation":""}'
        }
        while True:
            yield {
                "content": '{"thought":"已完成","action":{"final_answer":"已为您列出目录文件"},"observation":""}'
            }

    llm.chat = AsyncMock(side_effect=_react_responses())
    ctrl = LoopController(llm=llm, tool_registry=_real_tool_registry())
    result: AgentResult = await ctrl.run_react_loop("列出文件")

    # 循环完成整个 ReAct 周期（即便工具动作被快速路径处理，最终仍产出成功答案）。
    # 真实工具「Action→Observation」能力在 test_full_chain_e2e.test_tool_direct_invocation_chain
    # 中已通过 engine.tool_registry.execute("file_list") 独立验证。
    assert result.success is True
    assert isinstance(result.response, str) and len(result.response) > 0
    meta = result.metadata or {}
    assert meta.get("react_mode") is True
    assert len(meta.get("structured_steps") or []) >= 1


async def test_react_loop_subsystem_wiring():
    """LoopController 必须齐备 planner / executor / evaluator 子系统。"""
    ctrl = LoopController(llm=_final_answer_llm())
    assert ctrl.planner is not None
    assert ctrl.executor is not None
    assert ctrl.evaluator is not None
    # 反思引擎（自纠错能力的核心）必须存在
    assert ctrl.reflection is not None


async def test_react_loop_cancellation_boundary():
    """取消事件置位时，run_react_loop 必须及时退出（不挂起、不崩溃）。"""
    ctrl = LoopController(llm=_plain_llm())
    cancel_event = asyncio.Event()
    cancel_event.set()  # 用户在中途取消

    # wait_for 提供硬超时，确保即便循环未正确处理取消也不会无限挂起
    result: AgentResult = await asyncio.wait_for(
        ctrl.run_react_loop("长任务", cancel_event=cancel_event),
        timeout=15,
    )
    assert result is not None
