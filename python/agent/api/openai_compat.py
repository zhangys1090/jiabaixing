"""OpenAI 兼容 API 路由（差距报告 #11）.

提供与 OpenAI API 完全兼容的端点，支持:
- POST /v1/chat/completions（含 stream=true 流式模式）
- POST /v1/embeddings
- GET /v1/models

遵循 AGENTS.md 架构原则: LLM 调用主实现端为 Python。
TS 侧的伪流式（2 chunk）和文本解析 FC 由本模块的原生实现替代。

特性:
- 真实 SSE 流式输出（httpx + stream=True）
- 原生 Function Calling（OpenAI tools 参数）
- OpenAI 标准错误格式（error.code/error.message/error.type）
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from agent.core.logger import StructuredLogger

router = APIRouter()
log = StructuredLogger("openai_compat")


# ═══════════════════════════════════════════════════════════════
# 请求/响应模型
# ═══════════════════════════════════════════════════════════════


class ChatMessage(BaseModel):
    """OpenAI 聊天消息格式.

    Attributes:
        role: 消息角色（system/user/assistant/tool）.
        content: 消息内容.
        tool_calls: 工具调用列表（assistant 消息）.
        tool_call_id: 工具调用 ID（tool 消息）.
    """

    role: str
    content: str | None = ""
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


class ChatCompletionRequest(BaseModel):
    """OpenAI Chat Completions 请求格式.

    Attributes:
        model: 模型名称.
        messages: 消息列表.
        tools: 工具定义列表（原生 Function Calling）.
        tool_choice: 工具选择策略.
        stream: 是否启用流式输出.
        temperature: 采样温度.
        max_tokens: 最大输出 token 数.
    """

    model: str = "gpt-4o-mini"
    messages: list[ChatMessage]
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | None = None
    stream: bool = False
    temperature: float | None = None
    max_tokens: int | None = None


class EmbeddingRequest(BaseModel):
    """OpenAI Embeddings 请求格式.

    Attributes:
        model: 嵌入模型名称.
        input: 输入文本（字符串或字符串列表）.
    """

    model: str = "text-embedding-3-small"
    input: str | list[str]


# ═══════════════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════════════


def _get_engine():
    """获取全局 AgentEngine 实例.

    Returns:
        AgentEngine 实例，未初始化时返回 None.
    """
    from agent.main import engine
    return engine


def create_openai_error(
    code: str,
    message: str,
    error_type: str = "api_error",
    status_code: int = 500,
) -> JSONResponse:
    """构造 OpenAI 标准错误响应.

    Args:
        code: 错误代码（如 "engine_unavailable"/"invalid_request"）.
        message: 错误描述信息.
        error_type: 错误类型（如 "api_error"/"invalid_request_error"）.
        status_code: HTTP 状态码.

    Returns:
        JSONResponse: OpenAI 标准格式的错误响应.
    """
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": code,
                "message": message,
                "type": error_type,
            }
        },
    )


def _make_chat_completion_response(
    result: dict[str, Any],
    model: str,
) -> dict[str, Any]:
    """构造 OpenAI 非流式 chat completion 响应.

    Args:
        result: LLMProvider.chat_with_tools 返回的结果.
        model: 模型名称.

    Returns:
        OpenAI 格式的响应字典.
    """
    message: dict[str, Any] = {
        "role": result.get("role", "assistant"),
        "content": result.get("content", ""),
    }
    if result.get("tool_calls"):
        message["tool_calls"] = result["tool_calls"]

    response: dict[str, Any] = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": result.get("finish_reason", "stop"),
            }
        ],
    }

    if result.get("usage"):
        usage = result["usage"]
        response["usage"] = {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        }

    return response


def _make_chat_completion_chunk(
    content: str = "",
    finish_reason: str | None = None,
    tool_calls: list[dict] | None = None,
    model: str = "gpt-4o-mini",
) -> dict[str, Any]:
    """构造 OpenAI 流式 chat completion chunk.

    Args:
        content: 增量文本内容.
        finish_reason: 完成原因（仅最后一个 chunk）.
        tool_calls: 增量工具调用.
        model: 模型名称.

    Returns:
        OpenAI 格式的 chunk 字典.
    """
    delta: dict[str, Any] = {}
    if content:
        delta["content"] = content
    if tool_calls:
        delta["tool_calls"] = tool_calls

    choice: dict[str, Any] = {
        "index": 0,
        "delta": delta,
    }
    if finish_reason:
        choice["finish_reason"] = finish_reason

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [choice],
    }


async def _stream_chat_completions(
    provider: Any,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    model: str,
) -> AsyncIterator[str]:
    """生成 SSE 流式响应数据.

    将 LLMProvider.chat_stream 的输出转换为 OpenAI SSE 格式。

    Args:
        provider: LLMProvider 实例.
        messages: 消息列表.
        tools: 工具定义列表（可选）.
        model: 模型名称.

    Yields:
        str: SSE 格式的数据行（data: {...}\\n\\n）.
    """
    try:
        async for chunk in provider.chat_stream(messages=messages, tools=tools):
            content = chunk.get("content", "")
            tool_calls = chunk.get("tool_calls")
            finish_reason = chunk.get("finish_reason")
            done = chunk.get("done")

            if not any([content, tool_calls, finish_reason, done]):
                continue

            if done and not any([content, tool_calls, finish_reason]):
                # 纯 done 标记，发送 [DONE]
                break

            openai_chunk = _make_chat_completion_chunk(
                content=content,
                finish_reason=finish_reason,
                tool_calls=tool_calls,
                model=model,
            )
            yield f"data: {json.dumps(openai_chunk, ensure_ascii=False)}\n\n"

        # 发送 [DONE] 标记
        yield "data: [DONE]\n\n"
    except Exception as e:
        log.error("流式输出错误", error=str(e))
        error_chunk = {
            "error": {
                "code": "stream_error",
                "message": str(e),
                "type": "api_error",
            }
        }
        yield f"data: {json.dumps(error_chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"


# ═══════════════════════════════════════════════════════════════
# API 端点
# ═══════════════════════════════════════════════════════════════


@router.post("/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    """OpenAI 兼容的 Chat Completions 端点.

    支持原生 Function Calling（tools 参数）和真实 SSE 流式输出（stream=true）。

    Args:
        req: ChatCompletionRequest 请求体.

    Returns:
        - stream=false: JSONResponse（OpenAI chat.completion 格式）
        - stream=true: StreamingResponse（SSE text/event-stream）

    Raises:
        JSONResponse: engine 不可用时返回 503 OpenAI 标准错误.
    """
    eng = _get_engine()
    if not eng or not eng.llm:
        return create_openai_error(
            code="engine_unavailable",
            message="Agent engine not initialized",
            error_type="api_error",
            status_code=503,
        )

    if hasattr(eng.llm, "model") and eng.llm.model:
        supported = getattr(eng.llm, "supported_models", None)
        if supported and req.model not in supported:
            return create_openai_error(
                code="model_not_found",
                message=f"Model '{req.model}' not found. Supported: {supported}",
                error_type="invalid_request_error",
                status_code=404,
            )

    # 转换消息格式
    messages = [msg.model_dump(exclude_none=True) for msg in req.messages]

    provider = eng.llm

    if req.stream:
        # 流式模式 — 返回 SSE
        return StreamingResponse(
            _stream_chat_completions(
                provider=provider,
                messages=messages,
                tools=req.tools,
                model=req.model,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # 非流式模式 — 调用 chat_with_tools
    try:
        if req.tools:
            tool_choice = req.tool_choice or "auto"
            result = await provider.chat_with_tools(
                messages=messages,
                tools=req.tools,
                tool_choice=tool_choice,
            )
        else:
            result = await provider.chat_with_tools(
                messages=messages,
                tools=[],
            )
    except Exception as e:
        log.error("chat completions 失败", error=str(e))
        return create_openai_error(
            code="internal_error",
            message=str(e),
            error_type="api_error",
            status_code=500,
        )

    response = _make_chat_completion_response(result, req.model)
    return JSONResponse(content=response)


@router.post("/embeddings")
async def embeddings(req: EmbeddingRequest):
    """OpenAI 兼容的 Embeddings 端点.

    Args:
        req: EmbeddingRequest 请求体.

    Returns:
        JSONResponse: OpenAI embeddings 格式响应.

    Raises:
        JSONResponse: engine 不可用时返回 503 OpenAI 标准错误.
    """
    eng = _get_engine()
    if not eng or not eng.llm:
        return create_openai_error(
            code="engine_unavailable",
            message="Agent engine not initialized",
            error_type="api_error",
            status_code=503,
        )

    # 支持单个字符串或字符串列表
    inputs = [req.input] if isinstance(req.input, str) else req.input
    data = []
    for i, text in enumerate(inputs):
        embedding = await eng.llm.embed(text, model=req.model)
        data.append({
            "object": "embedding",
            "index": i,
            "embedding": embedding or [],
        })

    return JSONResponse(content={
        "object": "list",
        "data": data,
        "model": req.model,
    })


@router.get("/models")
async def list_models():
    """OpenAI 兼容的 Models 列表端点.

    Returns:
        JSONResponse: OpenAI models 格式响应.

    Raises:
        JSONResponse: engine 不可用时返回 503 OpenAI 标准错误.
    """
    eng = _get_engine()
    if not eng or not eng.llm:
        return create_openai_error(
            code="engine_unavailable",
            message="Agent engine not initialized",
            error_type="api_error",
            status_code=503,
        )

    models: list[dict[str, Any]] = []
    mgr = getattr(eng.llm, "provider_manager", None)
    if mgr:
        for p in mgr.list_providers():
            models.append({
                "id": p.model,
                "object": "model",
                "created": int(time.time()),
                "owned_by": p.display_name or p.name,
            })
    else:
        models.append({
            "id": eng.llm.model,
            "object": "model",
            "created": int(time.time()),
            "owned_by": "jiabaixing",
        })

    return JSONResponse(content={
        "object": "list",
        "data": models,
    })
