"""认知信号回灌 HTTP API (D2, P2 第4轮)。

端点:
    POST /v1/cognition/signal — TS 侧认知工具完成后经 PythonAgentBridge 转发,
        把 cognition_result 存入会话级认知缓冲, 供 Python ReAct 循环 LLM 消费
        (元认知回灌: 如高负向情绪降速、反思建议进 evolution)。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Request

from agent.core.cognition_buffer import store_cognition_signal
from agent.core.logger import StructuredLogger

log = StructuredLogger("api.cognition")

router = APIRouter(tags=["cognition"])


@router.post("/cognition/signal")
async def submit_cognition_signal(request: Request):
    """接收一条认知信号并存入会话缓冲。

    请求体::

        {
            "session_id": "sess-xxx",
            "tool": "emotion_detect",
            "category": "cognition",
            "success": true,
            "duration_ms": 12,
            "output_preview": "正面情绪",
            "error": null,
            "timestamp": "2026-08-12T..."
        }

    Returns:
        dict: {"success": bool} 或 {"success": false, "error": str}
    """
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        # 仅 JSON 解析失败才返回 invalid JSON body；其余异常（如请求体过大）
        # 如实向上抛出，由全局错误日志中间件记录，避免掩盖真实错误（审计 E-02）。
        return {"success": False, "error": "invalid JSON body"}

    session_id = body.get("session_id") or ""
    tool = body.get("tool") or "?"
    category = body.get("category") or "cognition"
    success = bool(body.get("success", False))
    duration_ms = body.get("duration_ms", 0)
    output_preview = body.get("output_preview")
    error = body.get("error")
    timestamp = body.get("timestamp") or ""

    if not session_id:
        return {"success": False, "error": "session_id required"}

    try:
        store_cognition_signal(
            session_id,
            {
                "tool": tool,
                "category": category,
                "success": success,
                "duration_ms": duration_ms,
                "output_preview": output_preview,
                "error": error,
                "timestamp": timestamp,
            },
        )
    except Exception as exc:
        log.error("认知信号存储失败", error=str(exc))
        return {"success": False, "error": str(exc)}

    return {"success": True}
