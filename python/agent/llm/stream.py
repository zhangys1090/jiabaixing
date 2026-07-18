from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

import httpx

from agent.llm.transports import BaseTransport


CHUNK_SIZE = 6
CHUNK_DELAY_MS = 25


@dataclass
class StreamEvent:
    """流式事件数据结构.

    Attributes:
        event_type: 事件类型（stream_start/stream_chunk/stream_done）.
        trace_id: 追踪 ID.
        data: 事件数据.
        timestamp: 事件时间戳.
    """

    event_type: str
    trace_id: str
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0


StreamCallback = Callable[[StreamEvent], None]


class StreamResponseService:
    """伪流式响应服务（已有实现，保留向后兼容）.

    将完整文本拆分为小块并延时发送，模拟流式体验。
    新代码应优先使用 stream_via_transport 进行真实 SSE 流式输出。
    """

    def __init__(
        self,
        chunk_size: int = CHUNK_SIZE,
        chunk_delay_ms: int = CHUNK_DELAY_MS,
    ) -> None:
        self._chunk_size = chunk_size
        self._chunk_delay_ms = chunk_delay_ms
        self._callbacks: list[StreamCallback] = []
        self._active_streams: dict[str, bool] = {}

    def on_event(self, callback: StreamCallback) -> None:
        self._callbacks.append(callback)

    def _emit(self, event: StreamEvent) -> None:
        for cb in self._callbacks:
            try:
                cb(event)
            except Exception:
                pass

    async def stream(self, full_text: str, trace_id: str) -> None:
        self._active_streams[trace_id] = True

        self._emit(StreamEvent(
            event_type="stream_start",
            trace_id=trace_id,
            data={"totalLength": len(full_text)},
            timestamp=time.time(),
        ))

        offset = 0
        while offset < len(full_text):
            if not self._active_streams.get(trace_id, False):
                break

            chunk = full_text[offset:offset + self._chunk_size]
            offset += self._chunk_size

            self._emit(StreamEvent(
                event_type="stream_chunk",
                trace_id=trace_id,
                data={"chunk": chunk, "offset": offset},
                timestamp=time.time(),
            ))

            await asyncio.sleep(self._chunk_delay_ms / 1000.0)

        self._emit(StreamEvent(
            event_type="stream_done",
            trace_id=trace_id,
            data={"fullText": full_text},
            timestamp=time.time(),
        ))

        self._active_streams.pop(trace_id, None)

    def cancel(self, trace_id: str) -> None:
        self._active_streams[trace_id] = False

    def is_streaming(self, trace_id: str) -> bool:
        return trace_id in self._active_streams

    def collect_chunks(self, trace_id: str) -> str:
        parts: list[str] = []
        collected_trace_id: list[str] = []

        def _collector(event: StreamEvent) -> None:
            if event.trace_id == trace_id:
                collected_trace_id.append(trace_id)
                if event.event_type == "stream_chunk":
                    parts.append(event.data.get("chunk", ""))
                elif event.event_type == "stream_done":
                    parts.append(event.data.get("fullText", ""))

        self.on_event(_collector)
        return "".join(parts)


# ═══════════════════════════════════════════════════════════════
# 真实 SSE 流式输出（差距报告 #11）
# ═══════════════════════════════════════════════════════════════


async def stream_via_transport(
    transport: BaseTransport,
    messages: list[dict[str, str]],
    tools: list[dict[str, Any]] | None = None,
    api_key: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """通过 transport 执行真实 SSE 流式请求.

    使用 httpx.AsyncClient 的 stream 模式，逐行解析 SSE 数据。
    这是真正的流式输出，而非伪流式的 2 chunk。

    支持解析:
    - SSE 数据行 `data: {...}`
    - [DONE] 结束标记
    - delta.content 文本增量
    - delta.tool_calls 工具调用增量
    - finish_reason 完成原因

    Args:
        transport: 传输层实例（ChatCompletionsTransport 等）.
        messages: 消息列表.
        tools: 工具定义列表（可选，OpenAI tools 格式）.
        api_key: API Key（覆盖 transport 配置中的 key）.

    Yields:
        dict: 每个 SSE chunk 解析后的数据，可能包含:
            - content: 增量文本.
            - tool_calls: 增量工具调用.
            - finish_reason: 完成原因（仅最后一个 chunk）.
            - done: True 表示流结束.

    Raises:
        httpx.HTTPStatusError: HTTP 错误时抛出.
    """
    converted_msgs = transport.convert_messages(messages)
    converted_tools = transport.convert_tools(tools)
    request = transport.build_request(converted_msgs, converted_tools, stream=True)

    headers = dict(request.headers)
    if api_key and "Authorization" in headers:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            method=request.method,
            url=request.url,
            headers=headers,
            json=request.body,
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    yield {"done": True}
                    return
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # L-14: 多 transport 格式解析
                result: dict[str, Any] = {}

                # OpenAI 格式: choices[].delta
                choices = chunk.get("choices", [])
                if choices:
                    choice = choices[0]
                    delta = choice.get("delta", {})
                    if delta.get("content"):
                        result["content"] = delta["content"]
                    if delta.get("tool_calls"):
                        result["tool_calls"] = delta["tool_calls"]
                    if choice.get("finish_reason"):
                        result["finish_reason"] = choice["finish_reason"]

                # Anthropic 格式: type=content_block_delta
                if not result:
                    event_type = chunk.get("type", "")
                    if event_type == "content_block_delta":
                        delta_obj = chunk.get("delta", {})
                        if delta_obj.get("type") == "text_delta":
                            text = delta_obj.get("text", "")
                            if text:
                                result["content"] = text
                    elif event_type == "message_delta":
                        delta_obj = chunk.get("delta", {})
                        stop_reason = delta_obj.get("stop_reason")
                        if stop_reason:
                            result["finish_reason"] = stop_reason
                        usage = chunk.get("usage", {})
                        if usage:
                            result["usage"] = usage
                    elif event_type == "message_stop":
                        result["finish_reason"] = "stop"

                # Gemini 格式: candidates[].content.parts[].text
                if not result:
                    candidates = chunk.get("candidates", [])
                    if candidates:
                        candidate = candidates[0]
                        content_obj = candidate.get("content", {})
                        parts = content_obj.get("parts", [])
                        for part in parts:
                            text = part.get("text", "")
                            if text:
                                result["content"] = text
                                break
                        finish_reason = candidate.get("finishReason")
                        if finish_reason:
                            result["finish_reason"] = finish_reason

                if result:
                    yield result


async def stream_via_litellm(
    provider: Any,
    messages: list[dict[str, str]],
    tools: list[dict[str, Any]] | None = None,
    user_id: str | None = None,
    strategy_name: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """通过 litellm 执行流式请求（回退路径）.

    当 transport 不可用时，使用 litellm 的流式 API 作为回退。
    支持灰度发布：当传入 user_id 与 strategy_name 时，由 provider.chat 内部完成版本选择与结果记录。

    Args:
        provider: LLMProvider 实例（需提供 chat 方法）.
        messages: 消息列表.
        tools: 工具定义列表（可选）.
        user_id: 用户 ID（用于灰度分桶，可选）.
        strategy_name: 灰度策略名称（可选）.

    Yields:
        dict: 每个 chunk 的数据.
    """
    response = await provider.chat(
        messages=messages,
        tools=tools,
        stream=True,
        use_cache=False,
        user_id=user_id,
        strategy_name=strategy_name,
    )
    async for chunk in response:
        delta = chunk.choices[0].delta
        data: dict[str, Any] = {"content": ""}
        if delta.content:
            data["content"] = delta.content
        if hasattr(delta, "tool_calls") and delta.tool_calls:
            data["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name if tc.function else "",
                        "arguments": tc.function.arguments if tc.function else "",
                    },
                }
                for tc in delta.tool_calls
            ]
        # 流式末尾 chunk 可能包含 usage（当 stream_options.include_usage=True 时）
        # 若存在 usage，记录到 OTel LLM Token Counter
        chunk_usage = getattr(chunk, "usage", None)
        if chunk_usage:
            try:
                from agent.core.otel_metrics import llm_tokens_counter
                input_tokens = getattr(chunk_usage, "prompt_tokens", 0) or 0
                output_tokens = getattr(chunk_usage, "completion_tokens", 0) or 0
                if input_tokens > 0:
                    llm_tokens_counter().add(int(input_tokens), {"model": provider.model, "type": "prompt"})
                if output_tokens > 0:
                    llm_tokens_counter().add(int(output_tokens), {"model": provider.model, "type": "completion"})
                data["usage"] = {
                    "input_tokens": int(input_tokens),
                    "output_tokens": int(output_tokens),
                }
            except Exception:
                pass
        yield data
        if chunk.choices[0].finish_reason:
            data["done"] = True
            yield data
            break
