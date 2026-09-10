"""会话级认知信号缓冲与回灌 (D2, P2 第4轮)。

TS 侧认知工具 (emotion_detect / self_reflect / scene_analyze) 完成后, 经
PythonAgentBridge 把 cognition_result 转发到 Python ``POST /v1/cognition/signal``。
本模块负责:

  - ``store_cognition_signal``: 按 session_id 缓冲最近 N 条信号 (滚动保留)。
  - ``inject_cognition_into_messages``: 把缓冲拼成一条 system 消息, 插入到
    user 消息之前 (紧邻首个非 system 消息), 供 Python ReAct 循环 LLM 消费。

设计为无重型依赖的纯模块, 便于单测且不污染主链路。多副本部署下各副本
独立缓冲, 需跨副本一致时应迁 Redis (对齐生产就绪文档)。
"""
from __future__ import annotations

import time
from typing import Any

_COGNITION_BUFFERS: dict[str, list[dict[str, Any]]] = {}
_MAX_PER_SESSION = 10
_MAX_SESSIONS = 5000
_TRIM_TO = 3000

_SESSION_ACCESS: dict[str, float] = {}


def _trim_buffers() -> None:
    if len(_COGNITION_BUFFERS) <= _MAX_SESSIONS:
        return
    sorted_sessions = sorted(_SESSION_ACCESS.items(), key=lambda x: x[1])
    to_remove = sorted_sessions[: len(_COGNITION_BUFFERS) - _TRIM_TO]
    for sid, _ in to_remove:
        _COGNITION_BUFFERS.pop(sid, None)
        _SESSION_ACCESS.pop(sid, None)


def store_cognition_signal(session_id: str, signal: dict[str, Any]) -> None:
    if not session_id:
        return
    buf = _COGNITION_BUFFERS.setdefault(session_id, [])
    buf.append(signal)
    if len(buf) > _MAX_PER_SESSION:
        del buf[: len(buf) - _MAX_PER_SESSION]
    _SESSION_ACCESS[session_id] = time.time()
    _trim_buffers()


def _peek_signals(session_id: str) -> list[dict[str, Any]]:
    """取出会话缓冲的当前内容 (不消费, 供每轮回灌时重复参考)。"""
    return list(_COGNITION_BUFFERS.get(session_id, []))


def build_cognition_system_message(session_id: str) -> dict[str, Any] | None:
    """根据会话缓冲构造一条『元认知状态』system 消息; 无信号返回 None。"""
    signals = _peek_signals(session_id)
    if not signals:
        return None
    lines = ["【元认知状态回灌】以下为本次对话前认知工具的观察, 供推理参考:"]
    for s in signals:
        tool = s.get("tool", "?")
        success = s.get("success")
        preview = str(s.get("output_preview") or "")[:200]
        err = s.get("error")
        if success:
            lines.append(f"- {tool}: 成功。{preview}")
        else:
            lines.append(f"- {tool}: 失败。{err or '无错误信息'}")
    return {"role": "system", "content": "\n".join(lines)}


def inject_cognition_into_messages(
    session_id: str, messages: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """把会话级认知信号作为一条 system 消息插入到首个非 system 消息之前 (原地修改并返回)。

    若缓冲为空或无消息, 直接返回原 messages。每条系统消息位于 user 之前,
    符合 OpenAI 消息排序约定, 不影响既有 system_prompt / history。
    """
    if not messages:
        return messages
    sys_msg = build_cognition_system_message(session_id)
    if sys_msg is None:
        return messages
    insert_at = len(messages)
    for i, m in enumerate(messages):
        if m.get("role") != "system":
            insert_at = i
            break
    messages.insert(insert_at, sys_msg)
    return messages
