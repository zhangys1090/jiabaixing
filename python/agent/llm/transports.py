from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.llm.prompt_cache import AnthropicPrefixCacheBuilder


class TransportType(str, Enum):
    OPENAI_COMPATIBLE = "openai_compatible"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    BEDROCK = "bedrock"


@dataclass
class TransportConfig:
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    temperature: float = 0.7
    max_tokens: int = 4096
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class TransportRequest:
    url: str
    method: str = "POST"
    headers: dict[str, str] = field(default_factory=dict)
    body: dict[str, Any] = field(default_factory=dict)


@dataclass
class TransportResponse:
    text: str
    role: str = "assistant"
    finish_reason: str = "stop"
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)


class BaseTransport(ABC):
    def __init__(self, config: TransportConfig) -> None:
        self._config = config

    @property
    @abstractmethod
    def transport_type(self) -> TransportType:
        ...

    @abstractmethod
    def convert_messages(self, messages: list[dict[str, Any]], system_prompt: str | None = None) -> list[dict[str, Any]]:
        ...

    @abstractmethod
    def convert_tools(self, tools: list[dict[str, Any]] | None = None) -> list[dict[str, Any]] | None:
        ...

    @abstractmethod
    def build_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        tool_choice: str = "auto",
    ) -> TransportRequest:
        ...

    @abstractmethod
    def normalize_response(self, raw: dict[str, Any]) -> TransportResponse:
        ...


class ChatCompletionsTransport(BaseTransport):
    @property
    def transport_type(self) -> TransportType:
        return TransportType.OPENAI_COMPATIBLE

    def convert_messages(self, messages: list[dict[str, Any]], system_prompt: str | None = None) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        if system_prompt:
            result.append({"role": "system", "content": system_prompt})
        result.extend(messages)
        return result

    def convert_tools(self, tools: list[dict[str, Any]] | None = None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        return tools

    def build_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        tool_choice: str = "auto",
    ) -> TransportRequest:
        base_url = self._config.base_url.rstrip("/")
        url = f"{base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self._config.api_key}",
            "Content-Type": "application/json",
        }
        body: dict[str, Any] = {
            "model": self._config.model,
            "messages": messages,
            "temperature": self._config.temperature,
            "max_tokens": self._config.max_tokens,
            "stream": stream,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = tool_choice
        return TransportRequest(url=url, method="POST", headers=headers, body=body)

    def normalize_response(self, raw: dict[str, Any]) -> TransportResponse:
        choices = raw.get("choices", [])
        if not choices:
            raise ValueError("未返回有效内容")
        choice = choices[0]
        message = choice.get("message", {})
        tool_calls = []
        if message.get("tool_calls"):
            tool_calls = message["tool_calls"]
        usage = raw.get("usage", {})
        return TransportResponse(
            text=message.get("content", ""),
            role=message.get("role", "assistant"),
            finish_reason=choice.get("finish_reason", "stop"),
            tool_calls=tool_calls,
            usage={
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            },
        )


class AnthropicTransport(BaseTransport):
    def __init__(self, config: TransportConfig) -> None:
        super().__init__(config)
        self._prefix_cache_builder = AnthropicPrefixCacheBuilder(
            enabled=config.extra.get("cacheControl", False),
        )

    @property
    def transport_type(self) -> TransportType:
        return TransportType.ANTHROPIC

    def convert_messages(self, messages: list[dict[str, Any]], system_prompt: str | None = None) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role", "")
            if role == "system":
                continue
            result.append({"role": role, "content": msg.get("content", "")})
        return result

    def convert_tools(self, tools: list[dict[str, Any]] | None = None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        converted = []
        for tool in tools:
            fn = tool.get("function", {})
            converted.append({
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
            })
        return converted

    def build_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        tool_choice: str = "auto",
    ) -> TransportRequest:
        base_url = self._config.base_url.rstrip("/")
        url = f"{base_url}/v1/messages"
        headers = {
            "x-api-key": self._config.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        body: dict[str, Any] = {
            "model": self._config.model,
            "messages": messages,
            "max_tokens": self._config.max_tokens,
            "stream": stream,
        }

        system_blocks: list[dict[str, Any]] | None = None
        for msg in messages:
            if msg.get("role") == "system":
                system_blocks = [{"type": "text", "text": msg.get("content", "")}]
                break

        non_system_msgs = [m for m in messages if m.get("role") != "system"]

        if self._prefix_cache_builder.enabled:
            non_system_msgs, system_blocks, tools = self._prefix_cache_builder.apply_cache_breakpoints(
                non_system_msgs, system_blocks, tools
            )

        if system_blocks:
            # When prefix cache breakpoints are enabled we need to keep
            # a structured list of blocks (for cache metadata). Otherwise
            # Anthropic API tests and simpler clients expect a plain
            # string for the `system` field — return the text directly.
            if self._prefix_cache_builder.enabled:
                body["system"] = system_blocks
            else:
                # pick the first text block as the system string
                body["system"] = system_blocks[0].get("text", "")
        body["messages"] = non_system_msgs

        if tools:
            body["tools"] = tools

        return TransportRequest(url=url, method="POST", headers=headers, body=body)

    def normalize_response(self, raw: dict[str, Any]) -> TransportResponse:
        content_blocks = raw.get("content", [])
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []

        for block in content_blocks:
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                tool_calls.append({
                    "id": block.get("id", ""),
                    "type": "function",
                    "function": {
                        "name": block.get("name", ""),
                        "arguments": json.dumps(block.get("input", {})),
                    },
                })

        usage = raw.get("usage", {})
        return TransportResponse(
            text="".join(text_parts),
            role="assistant",
            finish_reason="tool_calls" if tool_calls else raw.get("stop_reason", "stop"),
            tool_calls=tool_calls,
            usage={
                "prompt_tokens": usage.get("input_tokens", 0),
                "completion_tokens": usage.get("output_tokens", 0),
                "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
            },
        )


class GeminiTransport(BaseTransport):
    @property
    def transport_type(self) -> TransportType:
        return TransportType.GEMINI

    def convert_messages(self, messages: list[dict[str, Any]], system_prompt: str | None = None) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        if system_prompt:
            result.append({"role": "user", "parts": [{"text": f"[System]: {system_prompt}"}]})
            result.append({"role": "model", "parts": [{"text": "Understood."}]})
        for msg in messages:
            role = "model" if msg.get("role") == "assistant" else "user"
            result.append({"role": role, "parts": [{"text": msg.get("content", "")}]})
        return result

    def convert_tools(self, tools: list[dict[str, Any]] | None = None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        declarations = []
        for tool in tools:
            fn = tool.get("function", {})
            declarations.append({
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
            })
        return declarations

    def build_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        tool_choice: str = "auto",
    ) -> TransportRequest:
        model = self._config.model
        base_url = self._config.base_url.rstrip("/")
        url = f"{base_url}/v1/models/{model}:generateContent?key={self._config.api_key}"
        headers = {"Content-Type": "application/json"}
        body: dict[str, Any] = {
            "contents": messages,
            "generationConfig": {
                "temperature": self._config.temperature,
                "maxOutputTokens": self._config.max_tokens,
            },
        }
        if tools:
            body["tools"] = [{"functionDeclarations": tools}]
        return TransportRequest(url=url, method="POST", headers=headers, body=body)

    def normalize_response(self, raw: dict[str, Any]) -> TransportResponse:
        candidates = raw.get("candidates", [])
        if not candidates:
            raise ValueError("Gemini 未返回有效内容")
        candidate = candidates[0]
        parts = candidate.get("content", {}).get("parts", [])
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for part in parts:
            if "text" in part:
                text_parts.append(part["text"])
            elif "functionCall" in part:
                fc = part["functionCall"]
                tool_calls.append({
                    "id": f"gc_{fc.get('name', '')}",
                    "type": "function",
                    "function": {
                        "name": fc.get("name", ""),
                        "arguments": json.dumps(fc.get("args", {})),
                    },
                })
        usage = raw.get("usageMetadata", {})
        return TransportResponse(
            text="".join(text_parts),
            role="assistant",
            finish_reason="tool_calls" if tool_calls else "stop",
            tool_calls=tool_calls,
            usage={
                "prompt_tokens": usage.get("promptTokenCount", 0),
                "completion_tokens": usage.get("candidatesTokenCount", 0),
                "total_tokens": usage.get("totalTokenCount", 0),
            },
        )


class BedrockTransport(BaseTransport):
    @property
    def transport_type(self) -> TransportType:
        return TransportType.BEDROCK

    def convert_messages(self, messages: list[dict[str, Any]], system_prompt: str | None = None) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role", "")
            if role == "system":
                continue
            bedrock_role = "assistant" if role == "assistant" else "user"
            content = msg.get("content", "")
            result.append({"role": bedrock_role, "content": [{"text": content}]})
        return result

    def convert_tools(self, tools: list[dict[str, Any]] | None = None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        converted = []
        for tool in tools:
            fn = tool.get("function", {})
            converted.append({
                "toolSpec": {
                    "name": fn.get("name", ""),
                    "description": fn.get("description", ""),
                    "inputSchema": {
                        "json": fn.get("parameters", {"type": "object", "properties": {}}),
                    },
                },
            })
        return converted

    def build_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        tool_choice: str = "auto",
    ) -> TransportRequest:
        model = self._config.model
        region = self._config.extra.get("region", "us-east-1")
        base_url = self._config.base_url.rstrip("/")
        if not base_url or "bedrock" not in base_url:
            base_url = f"https://bedrock-runtime.{region}.amazonaws.com"
        url = f"{base_url}/model/{model}/invoke"
        headers = {
            "Content-Type": "application/json",
        }
        if self._config.api_key:
            headers["Authorization"] = f"Bearer {self._config.api_key}"

        system_parts: list[dict[str, str]] = []
        non_system: list[dict[str, Any]] = []
        for msg in messages:
            if msg.get("role") == "system":
                system_parts.append({"text": msg.get("content", "")})
            else:
                role = msg.get("role", "")
                bedrock_role = "assistant" if role == "assistant" else "user"
                content = msg.get("content", "")
                if isinstance(content, str):
                    content = [{"text": content}]
                non_system.append({"role": bedrock_role, "content": content})

        body: dict[str, Any] = {
            "messages": non_system,
            "inferenceConfig": {
                "temperature": self._config.temperature,
                "maxTokens": self._config.max_tokens,
            },
        }

        if system_parts:
            body["system"] = system_parts

        cache_control = self._config.extra.get("cacheControl", False)
        if cache_control and system_parts:
            system_parts[-1]["cachePoint"] = {"type": "default"}

        if tools:
            body["toolConfig"] = {"tools": tools}

        return TransportRequest(url=url, method="POST", headers=headers, body=body)

    def normalize_response(self, raw: dict[str, Any]) -> TransportResponse:
        output = raw.get("output", {})
        message = output.get("message", {})
        content_blocks = message.get("content", [])
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []

        for block in content_blocks:
            if "text" in block:
                text_parts.append(block["text"])
            elif "toolUse" in block:
                tu = block["toolUse"]
                tool_calls.append({
                    "id": tu.get("toolUseId", ""),
                    "type": "function",
                    "function": {
                        "name": tu.get("name", ""),
                        "arguments": json.dumps(tu.get("input", {})),
                    },
                })

        usage = raw.get("usage", {})
        return TransportResponse(
            text="".join(text_parts),
            role="assistant",
            finish_reason="tool_calls" if tool_calls else raw.get("stopReason", "stop"),
            tool_calls=tool_calls,
            usage={
                "prompt_tokens": usage.get("inputTokenCount", 0),
                "completion_tokens": usage.get("outputTokenCount", 0),
                "total_tokens": usage.get("inputTokenCount", 0) + usage.get("outputTokenCount", 0),
            },
        )


class TransportFactory:
    @staticmethod
    def create(transport_type: TransportType, config: TransportConfig) -> BaseTransport:
        if transport_type == TransportType.OPENAI_COMPATIBLE:
            return ChatCompletionsTransport(config)
        elif transport_type == TransportType.ANTHROPIC:
            return AnthropicTransport(config)
        elif transport_type == TransportType.GEMINI:
            return GeminiTransport(config)
        elif transport_type == TransportType.BEDROCK:
            return BedrockTransport(config)
        else:
            return ChatCompletionsTransport(config)

    @staticmethod
    def infer_type(config: TransportConfig) -> TransportType:
        explicit = config.extra.get("transport")
        if explicit:
            return TransportType(explicit)

        url = (config.base_url or "").lower()
        if "anthropic.com" in url:
            return TransportType.ANTHROPIC
        if "generativelanguage.googleapis.com" in url:
            return TransportType.GEMINI
        if "bedrock" in url:
            return TransportType.BEDROCK
        return TransportType.OPENAI_COMPATIBLE

    @staticmethod
    def from_config(config: TransportConfig) -> BaseTransport:
        transport_type = TransportFactory.infer_type(config)
        return TransportFactory.create(transport_type, config)
