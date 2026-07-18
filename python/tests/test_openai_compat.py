"""OpenAI 兼容 API 测试套件.

覆盖差距报告 #11:
- 原生 Function Calling（chat_with_tools）— 使用 OpenAI tools 参数，非文本解析
- 真实 SSE 流式输出（chat_stream）— 使用 httpx + stream=True，非伪流式 2 chunk
- OpenAI 兼容端点（/v1/chat/completions、/v1/embeddings、/v1/models）

测试策略:
- 使用 httpx.MockTransport 模拟 OpenAI API 响应（不依赖真实 API）
- 流式测试: MockTransport 返回多行 `data: {...}\n\n` 格式
- FastAPI TestClient / ASGITransport 测试端点

遵循测试规范:
- 异步测试使用 pytest.mark.asyncio
- 资源清理
- 不依赖真实 OpenAI API
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from agent.llm.provider import LLMProvider
from agent.llm.transports import (
    ChatCompletionsTransport,
    TransportConfig,
    TransportType,
)


# ═══════════════════════════════════════════════════════════════
# 辅助函数 — 构造 OpenAI 格式响应
# ═══════════════════════════════════════════════════════════════


def make_chat_completion_response(
    content: str = "你好！",
    tool_calls: list[dict] | None = None,
    finish_reason: str = "stop",
) -> dict:
    """构造 OpenAI 非流式 chat completion 响应.

    Args:
        content: 响应文本内容.
        tool_calls: 工具调用列表.
        finish_reason: 完成原因.

    Returns:
        OpenAI 格式的响应字典.
    """
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": "chatcmpl-test-001",
        "object": "chat.completion",
        "created": 1700000000,
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


def make_chat_chunk(
    content: str = "",
    finish_reason: str | None = None,
    tool_calls: list[dict] | None = None,
) -> dict:
    """构造 OpenAI 流式 chat completion chunk.

    Args:
        content: 增量文本内容.
        finish_reason: 完成原因（仅最后一个 chunk）.
        tool_calls: 增量工具调用.

    Returns:
        OpenAI 格式的 chunk 字典.
    """
    delta: dict[str, Any] = {}
    if content:
        delta["content"] = content
    if tool_calls:
        delta["tool_calls"] = tool_calls
    choice: dict[str, Any] = {"index": 0, "delta": delta}
    if finish_reason:
        choice["finish_reason"] = finish_reason
    return {
        "id": "chatcmpl-test-stream",
        "object": "chat.completion.chunk",
        "created": 1700000000,
        "model": "gpt-4o-mini",
        "choices": [choice],
    }


def make_sse_bytes(chunks: list[dict], done: bool = True) -> bytes:
    """构造 SSE 流式响应字节串.

    Args:
        chunks: chunk 字典列表.
        done: 是否追加 [DONE] 标记.

    Returns:
        SSE 格式的字节串（多行 `data: {...}\\n\\n`）.
    """
    lines: list[str] = []
    for chunk in chunks:
        lines.append(f"data: {json.dumps(chunk)}\n\n")
    if done:
        lines.append("data: [DONE]\n\n")
    return "".join(lines).encode("utf-8")


def make_tool_call_delta(
    index: int = 0,
    name: str | None = None,
    arguments: str | None = None,
    call_id: str | None = None,
) -> dict:
    """构造 tool_calls 增量 delta.

    Args:
        index: 工具调用索引.
        name: 函数名（仅首个 chunk）.
        arguments: 函数参数增量字符串.
        call_id: 调用 ID（仅首个 chunk）.

    Returns:
        tool_calls delta 字典.
    """
    delta: dict[str, Any] = {"index": index}
    fn: dict[str, Any] = {}
    if name is not None:
        fn["name"] = name
    if arguments is not None:
        fn["arguments"] = arguments
    if fn:
        delta["function"] = fn
    if call_id is not None:
        delta["id"] = call_id
        delta["type"] = "function"
    return delta


def setup_openai_provider(monkeypatch) -> LLMProvider:
    """创建使用 OpenAI 兼容 transport 的 LLMProvider.

    注册一个 OpenAI 兼容的 provider 配置，使 _resolve_transport 返回 ChatCompletionsTransport.

    Args:
        monkeypatch: pytest monkeypatch 夹具.

    Returns:
        配置好的 LLMProvider 实例.
    """
    from agent.llm.router import ProviderConfig

    provider = LLMProvider()
    cfg = ProviderConfig(
        name="openai-test",
        base_url="https://api.openai.com/v1",
        api_key="sk-test-key",
        model="gpt-4o-mini",
        extra={"transport": "openai_compatible"},
    )
    provider.provider_manager.register(cfg)
    provider.provider_manager.set_primary("openai-test")
    return provider


def patch_provider_httpx(monkeypatch, handler) -> None:
    """替换 provider 模块中的 httpx.AsyncClient，使用 MockTransport.

    Args:
        monkeypatch: pytest monkeypatch 夹具.
        handler: MockTransport 处理函数.
    """
    mock_transport = httpx.MockTransport(handler)

    class MockAsyncClient(httpx.AsyncClient):
        """使用 MockTransport 的 httpx.AsyncClient 替身."""

        def __init__(self, *args, **kwargs):
            kwargs["transport"] = mock_transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr("agent.llm.provider.httpx.AsyncClient", MockAsyncClient)


# ═══════════════════════════════════════════════════════════════
# TestChatWithTools — 原生 Function Calling 测试
# ═══════════════════════════════════════════════════════════════


class TestChatWithTools:
    """原生 Function Calling 测试 — 使用 OpenAI tools 参数（非文本解析）."""

    @pytest.mark.asyncio
    async def test_chat_with_tools_returns_tool_calls(self, monkeypatch) -> None:
        """验证原生 Function Calling 响应 — 返回 tool_calls 结构化数据."""
        tool_calls = [
            {
                "id": "call_abc123",
                "type": "function",
                "function": {"name": "get_weather", "arguments": '{"city": "北京"}'},
            }
        ]
        response_body = make_chat_completion_response(
            content="", tool_calls=tool_calls, finish_reason="tool_calls"
        )

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            # 验证请求体中包含原生 tools 参数（非文本解析）
            assert "tools" in body
            assert body["tools"][0]["function"]["name"] == "get_weather"
            return httpx.Response(200, json=response_body)

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "获取天气信息",
                    "parameters": {
                        "type": "object",
                        "properties": {"city": {"type": "string"}},
                    },
                },
            }
        ]
        result = await provider.chat_with_tools(
            messages=[{"role": "user", "content": "北京天气如何？"}],
            tools=tools,
        )

        assert result["finish_reason"] == "tool_calls"
        assert "tool_calls" in result
        assert result["tool_calls"][0]["function"]["name"] == "get_weather"
        assert "北京" in result["tool_calls"][0]["function"]["arguments"]

    @pytest.mark.asyncio
    async def test_chat_with_tools_handles_tool_choice_auto(self, monkeypatch) -> None:
        """验证 tool_choice=auto 时请求体正确传递."""
        response_body = make_chat_completion_response(content="调用工具", finish_reason="stop")

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert body.get("tool_choice") == "auto"
            return httpx.Response(200, json=response_body)

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        result = await provider.chat_with_tools(
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "noop"}}],
            tool_choice="auto",
        )
        assert result["content"] == "调用工具"

    @pytest.mark.asyncio
    async def test_chat_with_tools_handles_tool_choice_none(self, monkeypatch) -> None:
        """验证 tool_choice=none 时不触发工具调用."""
        response_body = make_chat_completion_response(content="不调用工具", finish_reason="stop")

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert body.get("tool_choice") == "none"
            return httpx.Response(200, json=response_body)

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        result = await provider.chat_with_tools(
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "noop"}}],
            tool_choice="none",
        )
        assert result["content"] == "不调用工具"
        assert "tool_calls" not in result

    @pytest.mark.asyncio
    async def test_chat_without_tools_returns_normal_response(self, monkeypatch) -> None:
        """验证无 tools 时返回普通响应."""
        response_body = make_chat_completion_response(content="你好！", finish_reason="stop")

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert "tools" not in body
            return httpx.Response(200, json=response_body)

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        result = await provider.chat_with_tools(
            messages=[{"role": "user", "content": "你好"}],
            tools=[],
        )
        assert result["content"] == "你好！"
        assert result["finish_reason"] == "stop"


# ═══════════════════════════════════════════════════════════════
# TestChatStream — 真实 SSE 流式输出测试
# ═══════════════════════════════════════════════════════════════


class TestChatStream:
    """真实 SSE 流式输出测试 — 使用 httpx + stream=True（非伪流式 2 chunk）."""

    @pytest.mark.asyncio
    async def test_chat_stream_yields_sse_chunks(self, monkeypatch) -> None:
        """验证流式输出多个 chunk（非伪流式的 2 chunk）."""
        # 构造 5 个文本 chunk + finish chunk
        chunks = [
            make_chat_chunk(content="你"),
            make_chat_chunk(content="好"),
            make_chat_chunk(content="，"),
            make_chat_chunk(content="世"),
            make_chat_chunk(content="界"),
            make_chat_chunk(finish_reason="stop"),
        ]
        sse_bytes = make_sse_bytes(chunks)

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert body.get("stream") is True
            return httpx.Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        collected: list[str] = []
        async for chunk in provider.chat_stream(
            messages=[{"role": "user", "content": "打招呼"}]
        ):
            if chunk.get("content"):
                collected.append(chunk["content"])

        # 验证收到多个 chunk（不是伪流式的 2 chunk）
        assert len(collected) >= 5, f"期望至少 5 个 chunk，实际 {len(collected)}"
        assert "".join(collected) == "你好，世界"

    @pytest.mark.asyncio
    async def test_chat_stream_yields_done_marker(self, monkeypatch) -> None:
        """验证流式输出包含 [DONE] 标记后的结束信号."""
        chunks = [
            make_chat_chunk(content="完成"),
            make_chat_chunk(finish_reason="stop"),
        ]
        sse_bytes = make_sse_bytes(chunks, done=True)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        done_received = False
        finish_reason_received = False
        async for chunk in provider.chat_stream(
            messages=[{"role": "user", "content": "测试"}]
        ):
            if chunk.get("done"):
                done_received = True
            if chunk.get("finish_reason") == "stop":
                finish_reason_received = True

        assert done_received, "应收到 done 标记"
        assert finish_reason_received, "应收到 finish_reason=stop"

    @pytest.mark.asyncio
    async def test_chat_stream_with_tools_yields_tool_calls_delta(self, monkeypatch) -> None:
        """验证流式模式下正确处理 tool_calls 增量."""
        chunks = [
            make_chat_chunk(tool_calls=[make_tool_call_delta(
                index=0, name="get_weather", call_id="call_1", arguments=""
            )]),
            make_chat_chunk(tool_calls=[make_tool_call_delta(
                index=0, arguments='{"city"'
            )]),
            make_chat_chunk(tool_calls=[make_tool_call_delta(
                index=0, arguments=': "北京"}'
            )]),
            make_chat_chunk(finish_reason="tool_calls"),
        ]
        sse_bytes = make_sse_bytes(chunks)

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert "tools" in body
            return httpx.Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "获取天气",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }
        ]
        tool_call_chunks: list[dict] = []
        async for chunk in provider.chat_stream(
            messages=[{"role": "user", "content": "北京天气"}],
            tools=tools,
        ):
            if chunk.get("tool_calls"):
                tool_call_chunks.append(chunk)

        assert len(tool_call_chunks) >= 1, "应收到 tool_calls delta"
        # 验证首个 chunk 包含函数名
        first_tc = tool_call_chunks[0]["tool_calls"][0]
        assert first_tc.get("function", {}).get("name") == "get_weather"

    @pytest.mark.asyncio
    async def test_chat_stream_handles_error(self, monkeypatch) -> None:
        """验证流式请求错误时正确抛出异常."""
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="Internal Server Error")

        patch_provider_httpx(monkeypatch, handler)
        provider = setup_openai_provider(monkeypatch)

        with pytest.raises(Exception):
            async for _ in provider.chat_stream(
                messages=[{"role": "user", "content": "触发错误"}]
            ):
                pass


# ═══════════════════════════════════════════════════════════════
# TestOpenAICompatEndpoints — OpenAI 兼容端点测试
# ═══════════════════════════════════════════════════════════════


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_test_app():
    """构造独立的 FastAPI 测试应用（避免依赖全局 engine）.

    Returns:
        FastAPI 应用实例.
    """
    from fastapi import FastAPI
    from agent.api.openai_compat import router as openai_router

    app = FastAPI(title="Test OpenAI Compat")
    app.include_router(openai_router, prefix="/v1")
    return app


def _make_mock_provider():
    """构造 mock LLMProvider 用于端点测试.

    Returns:
        MagicMock 包装的 LLMProvider.
    """
    provider = MagicMock(spec=LLMProvider)
    provider.model = "gpt-4o-mini"
    provider.chat_with_tools = AsyncMock()
    provider.chat_stream = MagicMock()
    provider.embed = AsyncMock()
    return provider


@pytest.fixture
def mock_engine(monkeypatch):
    """注入 mock engine 到 openai_compat 模块.

    Args:
        monkeypatch: pytest monkeypatch 夹具.

    Yields:
        mock engine 实例.
    """
    provider = _make_mock_provider()
    engine = MagicMock()
    engine.llm = provider
    engine.provider_manager = MagicMock()
    engine.provider_manager.list_providers = MagicMock(return_value=[])

    # patch _get_engine 函数
    import agent.api.openai_compat as compat_module
    monkeypatch.setattr(compat_module, "_get_engine", lambda: engine)
    return engine


@pytest.fixture
async def compat_client(mock_engine):
    """提供 OpenAI 兼容端点的 TestClient.

    Args:
        mock_engine: mock engine 夹具.

    Yields:
        httpx.AsyncClient 实例.
    """
    app = _make_test_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestOpenAICompatEndpoints:
    """OpenAI 兼容端点测试 — /v1/chat/completions、/v1/embeddings、/v1/models."""

    @pytest.mark.asyncio
    async def test_post_chat_completions_non_stream(self, compat_client, mock_engine) -> None:
        """测试非流式 chat completions 端点."""
        mock_engine.llm.chat_with_tools.return_value = {
            "content": "你好！",
            "role": "assistant",
            "finish_reason": "stop",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }

        resp = await compat_client.post("/v1/chat/completions", json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "你好"}],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "chat.completion"
        assert data["choices"][0]["message"]["content"] == "你好！"
        assert data["choices"][0]["finish_reason"] == "stop"

    @pytest.mark.asyncio
    async def test_post_chat_completions_stream(self, compat_client, mock_engine) -> None:
        """测试流式 chat completions 端点 — 返回 SSE text/event-stream."""

        async def fake_stream(messages, tools=None):
            yield {"content": "你", "finish_reason": None}
            yield {"content": "好", "finish_reason": None}
            yield {"content": "！", "finish_reason": "stop", "done": True}

        mock_engine.llm.chat_stream.return_value = fake_stream(
            messages=[], tools=None
        )

        resp = await compat_client.post("/v1/chat/completions", json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "你好"}],
            "stream": True,
        })
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        # 验证返回 SSE 格式数据
        text = resp.text
        assert "data: " in text
        assert "[DONE]" in text

    @pytest.mark.asyncio
    async def test_post_chat_completions_with_tools(self, compat_client, mock_engine) -> None:
        """测试带 tools 的 chat completions 端点 — 原生 Function Calling."""
        mock_engine.llm.chat_with_tools.return_value = {
            "content": "",
            "role": "assistant",
            "finish_reason": "tool_calls",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "get_weather", "arguments": '{"city": "北京"}'},
                }
            ],
        }

        resp = await compat_client.post("/v1/chat/completions", json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "北京天气"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "获取天气",
                        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                    },
                }
            ],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["choices"][0]["finish_reason"] == "tool_calls"
        assert data["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "get_weather"

    @pytest.mark.asyncio
    async def test_post_embeddings(self, compat_client, mock_engine) -> None:
        """测试 embeddings 端点."""
        mock_engine.llm.embed.return_value = [0.1, 0.2, 0.3]

        resp = await compat_client.post("/v1/embeddings", json={
            "model": "text-embedding-3-small",
            "input": "测试文本",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert len(data["data"]) == 1
        assert data["data"][0]["embedding"] == [0.1, 0.2, 0.3]

    @pytest.mark.asyncio
    async def test_get_models(self, compat_client, mock_engine) -> None:
        """测试 models 列表端点."""
        from agent.llm.router import ProviderConfig
        mock_engine.provider_manager.list_providers.return_value = [
            ProviderConfig(
                name="openai",
                display_name="OpenAI",
                model="gpt-4o-mini",
                enabled=True,
            ),
        ]
        mock_engine.llm.model = "gpt-4o-mini"

        resp = await compat_client.get("/v1/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert len(data["data"]) >= 1
        assert any(m["id"] == "gpt-4o-mini" for m in data["data"])

    @pytest.mark.asyncio
    async def test_error_response_format(self, compat_client, monkeypatch) -> None:
        """测试 OpenAI 标准错误格式 — error.code/error.message/error.type."""
        # 让 _get_engine 返回 None，触发 503 错误
        import agent.api.openai_compat as compat_module
        monkeypatch.setattr(compat_module, "_get_engine", lambda: None)

        resp = await compat_client.post("/v1/chat/completions", json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "触发错误"}],
        })
        assert resp.status_code == 503
        data = resp.json()
        # 验证 OpenAI 标准错误格式
        assert "error" in data
        assert "code" in data["error"]
        assert "message" in data["error"]
        assert "type" in data["error"]
