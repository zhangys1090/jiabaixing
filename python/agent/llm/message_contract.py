"""LLM 消息契约守卫 —— 在**唯一漏斗**处保证 OpenAI tool_calls 契约。

为什么放这里（2026-09-17 架构修正）:
    全仓有 **80+ 个** ``llm.chat(...)`` 调用点
    （conversation_loop / delegate_tool / loop/executor / api/plan / api/llm /
    loop/{planner,mcts_planner,hierarchical_planner,tot_planner,reflection,...}）。
    最初只在主循环的两个调用点做 tool_calls 对账 —— 那是打地鼠：
    任何**其他**带 tools 的调用路径（如子代理 delegate_tool.py:464）
    依然会产生悬空 tool_call_id 并触发::

        BadRequestError: An assistant message with 'tool_calls' must be followed
        by tool messages responding to each 'tool_call_id'.

    唯一可靠的收口点是 **LLMProvider** —— 所有 80+ 个调用最终都汇到
    ``_do_chat``。在这里做契约对账，覆盖现有与未来的全部调用方。

设计:
    - ``reconcile_tool_messages(messages)`` 就地修改并返回补齐条数。
    - 幂等：已有对应 tool 消息的 id 不会重复补。
    - 占位消息**明确说明**动作未执行及原因，让模型据此重新决策，
      而不是以为动作已生效。
    - 绝不抛异常（契约守卫失败不应让请求直接崩掉）。
"""
from __future__ import annotations

from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("llm_message_contract")

#: 占位 tool 消息的内容模板
_PLACEHOLDER_CONTENT = (
    "[not executed] 该动作未被执行：DecisionAuthority 未接受此候选"
    "（fail-closed / 姿态拒绝 / 候选被拒 / 执行中断）。"
    "请根据当前状态重新决策，不要假设该动作已产生效果。"
)


def collect_dangling_tool_call_ids(messages: list[dict[str, Any]]) -> list[str]:
    """找出悬空的 tool_call_id（只读，供诊断/测试）。"""
    present: set[str] = set()
    for m in messages or []:
        if isinstance(m, dict) and m.get("role") == "tool" and m.get("tool_call_id"):
            present.add(str(m["tool_call_id"]))
    dangling: list[str] = []
    for m in messages or []:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        calls = m.get("tool_calls") or []
        if not isinstance(calls, list):
            continue
        for c in calls:
            cid = str(c.get("id") or "") if isinstance(c, dict) else ""
            if cid and cid not in present and cid not in dangling:
                dangling.append(cid)
    return dangling


def reconcile_tool_messages(messages: list[dict[str, Any]]) -> int:
    """补齐悬空的 tool_call_id（就地修改，幂等）。

    Args:
        messages: 将要发给 LLM 的消息列表。

    Returns:
        补齐的条数（诊断用）；输入非法时返回 0。
    """
    if not messages or not isinstance(messages, list):
        return 0

    try:
        dangling = collect_dangling_tool_call_ids(messages)
        if not dangling:
            return 0

        for cid in dangling:
            messages.append({
                "role": "tool",
                "tool_call_id": cid,
                "content": _PLACEHOLDER_CONTENT,
            })

        if dangling:
            log.warning(
                "tool_calls 契约对账：补齐悬空的 tool 消息",
                patched=len(dangling),
                ids=dangling[:8],
            )
        return len(dangling)
    except Exception as e:  # 契约守卫绝不抛
        log.debug("reconcile skipped", error=str(e))
        return 0
