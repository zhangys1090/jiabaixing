"""
P2 多传输层 Transport Layer 测试

覆盖:
  - TransportFactory 创建与推断
  - ChatCompletionsTransport (OpenAI Compatible)
  - AnthropicTransport
  - GeminiTransport
  - LLMProvider Transport 集成路径
  - API 端点 /transport/info + /transport/switch
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from types import SimpleNamespace

from agent.llm.transports import (
    BaseTransport,
    ChatCompletionsTransport,
    AnthropicTransport,
    GeminiTransport,
    TransportConfig,
    TransportFactory,
    TransportResponse,
    TransportType,
)


# ═══════════════════════════════════════════════════════════════
# TransportFactory 测试
# ═══════════════════════════════════════════════════════════════

class TestTransportFactory:
    def test_create_openai(self):
        config = TransportConfig(base_url="https://api.openai.com", api_key="test", model="gpt-4")
        transport = TransportFactory.create(TransportType.OPENAI_COMPATIBLE, config)
        assert isinstance(transport, ChatCompletionsTransport)
        assert transport.transport_type == TransportType.OPENAI_COMPATIBLE

    def test_create_anthropic(self):
        config = TransportConfig(base_url="https://api.anthropic.com", api_key="test", model="claude-3")
        transport = TransportFactory.create(TransportType.ANTHROPIC, config)
        assert isinstance(transport, AnthropicTransport)
        assert transport.transport_type == TransportType.ANTHROPIC

    def test_create_gemini(self):
        config = TransportConfig(base_url="https://generativelanguage.googleapis.com", api_key="test", model="gemini-pro")
        transport = TransportFactory.create(TransportType.GEMINI, config)
        assert isinstance(transport, GeminiTransport)
        assert transport.transport_type == TransportType.GEMINI

    def test_infer_type_anthropic_url(self):
        config = TransportConfig(base_url="https://api.anthropic.com/v1")
        assert TransportFactory.infer_type(config) == TransportType.ANTHROPIC

    def test_infer_type_gemini_url(self):
        config = TransportConfig(base_url="https://generativelanguage.googleapis.com/v1")
        assert TransportFactory.infer_type(config) == TransportType.GEMINI

    def test_infer_type_default_openai(self):
        config = TransportConfig(base_url="https://api.example.com/v1")
        assert TransportFactory.infer_type(config) == TransportType.OPENAI_COMPATIBLE

    def test_infer_type_explicit_transport(self):
        config = TransportConfig(base_url="https://api.example.com", extra={"transport": "anthropic"})
        assert TransportFactory.infer_type(config) == TransportType.ANTHROPIC

    def test_from_config_auto_infer(self):
        config = TransportConfig(base_url="https://api.anthropic.com", api_key="test", model="claude-3")
        transport = TransportFactory.from_config(config)
        assert isinstance(transport, AnthropicTransport)


# ═══════════════════════════════════════════════════════════════
# ChatCompletionsTransport 测试
# ═══════════════════════════════════════════════════════════════

class TestChatCompletionsTransport:
    def setup_method(self):
        self.config = TransportConfig(
            base_url="https://api.openai.com/v1",
            api_key="sk-test",
            model="gpt-4o",
            temperature=0.7,
            max_tokens=4096,
        )
        self.transport = ChatCompletionsTransport(self.config)

    def test_convert_messages_passthrough(self):
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
        ]
        result = self.transport.convert_messages(messages)
        assert len(result) == 2
        assert result[0]["role"] == "system"

    def test_convert_messages_with_system_prompt(self):
        messages = [{"role": "user", "content": "Hello"}]
        result = self.transport.convert_messages(messages, system_prompt="Be concise")
        assert len(result) == 2
        assert result[0]["role"] == "system"
        assert result[0]["content"] == "Be concise"

    def test_convert_tools_passthrough(self):
        tools = [{"type": "function", "function": {"name": "test"}}]
        result = self.transport.convert_tools(tools)
        assert result == tools

    def test_convert_tools_none(self):
        assert self.transport.convert_tools(None) is None

    def test_build_request(self):
        messages = [{"role": "user", "content": "Hi"}]
        req = self.transport.build_request(messages)
        assert req.url == "https://api.openai.com/v1/chat/completions"
        assert req.method == "POST"
        assert req.headers["Authorization"] == "Bearer sk-test"
        assert req.body["model"] == "gpt-4o"
        assert req.body["messages"] == messages
        assert req.body["stream"] is False

    def test_build_request_with_tools(self):
        messages = [{"role": "user", "content": "Hi"}]
        tools = [{"type": "function", "function": {"name": "calc"}}]
        req = self.transport.build_request(messages, tools=tools)
        assert "tools" in req.body
        assert req.body["tool_choice"] == "auto"

    def test_normalize_response(self):
        raw = {
            "choices": [{
                "message": {"role": "assistant", "content": "Hello!"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        resp = self.transport.normalize_response(raw)
        assert resp.text == "Hello!"
        assert resp.role == "assistant"
        assert resp.finish_reason == "stop"
        assert resp.usage["prompt_tokens"] == 10

    def test_normalize_response_with_tool_calls(self):
        raw = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_123",
                        "type": "function",
                        "function": {"name": "calc", "arguments": '{"a": 1}'},
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
        }
        resp = self.transport.normalize_response(raw)
        assert len(resp.tool_calls) == 1
        assert resp.tool_calls[0]["function"]["name"] == "calc"
        assert resp.finish_reason == "tool_calls"


# ═══════════════════════════════════════════════════════════════
# AnthropicTransport 测试
# ═══════════════════════════════════════════════════════════════

class TestAnthropicTransport:
    def setup_method(self):
        self.config = TransportConfig(
            base_url="https://api.anthropic.com",
            api_key="sk-ant-test",
            model="claude-3-sonnet",
            max_tokens=4096,
        )
        self.transport = AnthropicTransport(self.config)

    def test_convert_messages_strips_system(self):
        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
        ]
        result = self.transport.convert_messages(messages)
        assert len(result) == 1
        assert result[0]["role"] == "user"

    def test_convert_tools(self):
        tools = [{
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search the web",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
            },
        }]
        result = self.transport.convert_tools(tools)
        assert len(result) == 1
        assert result[0]["name"] == "search"
        assert "input_schema" in result[0]

    def test_build_request_extracts_system(self):
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hi"},
        ]
        req = self.transport.build_request(messages)
        assert req.url == "https://api.anthropic.com/v1/messages"
        assert req.headers["x-api-key"] == "sk-ant-test"
        assert req.headers["anthropic-version"] == "2023-06-01"
        system = req.body["system"]
        if isinstance(system, list):
            assert system[0].get("text") == "You are helpful."
        else:
            assert system == "You are helpful."
        assert all(m.get("role") != "system" for m in req.body["messages"])

    def test_build_request_cache_control(self):
        config = TransportConfig(
            base_url="https://api.anthropic.com",
            api_key="sk-ant-test",
            model="claude-3-sonnet",
            max_tokens=4096,
            extra={"cacheControl": True},
        )
        transport = AnthropicTransport(config)
        messages = [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "Hi"},
        ]
        req = transport.build_request(messages)
        system = req.body["system"]
        assert isinstance(system, list)
        assert system[0].get("cache_control") == {"type": "ephemeral"}

    def test_normalize_response_text(self):
        raw = {
            "content": [{"type": "text", "text": "Hello!"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }
        resp = self.transport.normalize_response(raw)
        assert resp.text == "Hello!"
        assert resp.finish_reason == "end_turn"
        assert resp.usage["prompt_tokens"] == 10

    def test_normalize_response_tool_use(self):
        raw = {
            "content": [
                {"type": "text", "text": "Let me search"},
                {"type": "tool_use", "id": "tu_1", "name": "search", "input": {"q": "test"}},
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 15, "output_tokens": 8},
        }
        resp = self.transport.normalize_response(raw)
        assert "Let me search" in resp.text
        assert len(resp.tool_calls) == 1
        assert resp.tool_calls[0]["function"]["name"] == "search"
        assert resp.finish_reason == "tool_calls"


# ═══════════════════════════════════════════════════════════════
# GeminiTransport 测试
# ═══════════════════════════════════════════════════════════════

class TestGeminiTransport:
    def setup_method(self):
        self.config = TransportConfig(
            base_url="https://generativelanguage.googleapis.com",
            api_key="gemini-test",
            model="gemini-pro",
            temperature=0.7,
            max_tokens=2048,
        )
        self.transport = GeminiTransport(self.config)

    def test_convert_messages_role_mapping(self):
        messages = [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
        ]
        result = self.transport.convert_messages(messages)
        assert result[0]["role"] == "user"
        assert result[1]["role"] == "model"

    def test_convert_messages_with_system_prompt(self):
        messages = [{"role": "user", "content": "Hi"}]
        result = self.transport.convert_messages(messages, system_prompt="Be concise")
        assert len(result) == 3
        assert result[0]["role"] == "user"
        assert "System" in result[0]["parts"][0]["text"]

    def test_convert_tools(self):
        tools = [{
            "type": "function",
            "function": {
                "name": "calc",
                "description": "Calculate",
                "parameters": {"type": "object", "properties": {}},
            },
        }]
        result = self.transport.convert_tools(tools)
        assert len(result) == 1
        assert result[0]["name"] == "calc"

    def test_build_request(self):
        messages = [{"role": "user", "parts": [{"text": "Hi"}]}]
        req = self.transport.build_request(messages)
        assert "gemini-pro:generateContent" in req.url
        assert "key=gemini-test" in req.url
        assert "contents" in req.body

    def test_normalize_response(self):
        raw = {
            "candidates": [{
                "content": {"parts": [{"text": "Hello!"}]},
            }],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15},
        }
        resp = self.transport.normalize_response(raw)
        assert resp.text == "Hello!"
        assert resp.usage["total_tokens"] == 15

    def test_normalize_response_function_call(self):
        raw = {
            "candidates": [{
                "content": {
                    "parts": [{
                        "functionCall": {"name": "search", "args": {"q": "test"}},
                    }],
                },
            }],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15},
        }
        resp = self.transport.normalize_response(raw)
        assert len(resp.tool_calls) == 1
        assert resp.tool_calls[0]["function"]["name"] == "search"


# ═══════════════════════════════════════════════════════════════
# LLMProvider Transport 集成测试
# ═══════════════════════════════════════════════════════════════

class TestLLMProviderTransportIntegration:
    def _make_provider(self):
        from agent.llm.provider import LLMProvider
        from agent.llm.router import ProviderManager
        import tempfile
        provider = LLMProvider()
        with tempfile.TemporaryDirectory() as tmpdir:
            pass
        provider.provider_manager = ProviderManager(data_dir=tempfile.mkdtemp())
        provider._transport_cache.clear()
        return provider

    def test_resolve_transport_no_provider(self):
        provider = self._make_provider()
        transport = provider._resolve_transport()
        assert transport is None

    def test_resolve_transport_explicit_anthropic(self):
        from agent.llm.router import ProviderConfig
        provider = self._make_provider()
        cfg = ProviderConfig(
            name="claude",
            base_url="https://api.anthropic.com",
            api_key="sk-ant-test",
            model="claude-3-sonnet",
            extra={"transport": "anthropic"},
        )
        provider.provider_manager.register(cfg)
        provider.provider_manager.set_primary("claude")

        transport = provider._resolve_transport()
        assert transport is not None
        assert transport.transport_type == TransportType.ANTHROPIC

    def test_resolve_transport_auto_infer_gemini(self):
        from agent.llm.router import ProviderConfig
        provider = self._make_provider()
        cfg = ProviderConfig(
            name="gemini",
            base_url="https://generativelanguage.googleapis.com/v1",
            api_key="gemini-test",
            model="gemini-pro",
        )
        provider.provider_manager.register(cfg)
        provider.provider_manager.set_primary("gemini")

        transport = provider._resolve_transport()
        assert transport is not None
        assert transport.transport_type == TransportType.GEMINI

    @pytest.mark.anyio
    async def test_embed_calls_litellm_embedding(self, monkeypatch):
        from agent.llm import provider as provider_module
        from agent.config import EMBEDDING_MODEL

        provider = provider_module.LLMProvider()

        async def fake_embedding(**kwargs):
            assert kwargs["model"] == provider._normalize_model(EMBEDDING_MODEL)
            assert kwargs["input"] == ["测试文本"]
            return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2, 0.3])])

        monkeypatch.setattr(provider_module.litellm, "embedding", fake_embedding)
        embedding = await provider.embed("测试文本")

        assert embedding == [0.1, 0.2, 0.3]

    def test_resolve_transport_openai_falls_to_none(self):
        from agent.llm.router import ProviderConfig
        provider = self._make_provider()
        cfg = ProviderConfig(
            name="openai",
            base_url="https://api.openai.com/v1",
            api_key="sk-test",
            model="gpt-4o",
        )
        provider.provider_manager.register(cfg)
        provider.provider_manager.set_primary("openai")

        transport = provider._resolve_transport()
        assert transport is None

    def test_transport_cache_reuse(self):
        from agent.llm.router import ProviderConfig
        provider = self._make_provider()
        cfg = ProviderConfig(
            name="claude",
            base_url="https://api.anthropic.com",
            api_key="sk-ant-test",
            model="claude-3-sonnet",
            extra={"transport": "anthropic"},
        )
        provider.provider_manager.register(cfg)
        provider.provider_manager.set_primary("claude")

        t1 = provider._resolve_transport()
        t2 = provider._resolve_transport()
        assert t1 is t2


# ═══════════════════════════════════════════════════════════════
# Transport API 端点测试
# ═══════════════════════════════════════════════════════════════

@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    from agent.main import app
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestTransportAPI:
    @pytest.mark.anyio
    async def test_transport_info(self, client: AsyncClient):
        resp = await client.get("/v1/llm/providers/transport/info")
        assert resp.status_code == 200
        data = resp.json()
        assert "active_transport" in data
        assert "available_types" in data
        assert isinstance(data["available_types"], list)

    @pytest.mark.anyio
    async def test_transport_switch_invalid_type(self, client: AsyncClient):
        resp = await client.post(
            "/v1/llm/providers/transport/switch",
            params={"provider_name": "test", "transport_type": "invalid"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False

    @pytest.mark.anyio
    async def test_transport_switch_nonexistent_provider(self, client: AsyncClient):
        resp = await client.post(
            "/v1/llm/providers/transport/switch",
            params={"provider_name": "nonexistent", "transport_type": "anthropic"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
