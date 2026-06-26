from __future__ import annotations

import json
import os
import time
from typing import Any, AsyncIterator

import httpx
import litellm
from litellm import acompletion

from agent.config import EMBEDDING_MODEL, LLM_API_KEY, LLM_BASE_URL, LLM_MAX_TOKENS, LLM_MODEL, LLM_TEMPERATURE
from agent.llm.cache import LLMCache
from agent.llm.credential_pool import CostGuard, CredentialEntry, CredentialPool, RotationStrategy
from agent.llm.prompt_cache import PromptCacheManager
from agent.llm.queue import RequestQueue
from agent.llm.router import ProviderConfig, ProviderManager
from agent.llm.transports import (
    BaseTransport,
    TransportConfig,
    TransportFactory,
    TransportResponse,
    TransportType,
)


class LLMProvider:
    def __init__(self) -> None:
        self.model = self._normalize_model(LLM_MODEL)
        self.temperature = LLM_TEMPERATURE
        self.max_tokens = LLM_MAX_TOKENS
        self._available: bool | None = None
        self.cache = LLMCache()
        self.queue = RequestQueue(max_concurrent=3)
        self.provider_manager = ProviderManager()
        self.prompt_cache = PromptCacheManager()
        self.credential_pool: CredentialPool | None = None
        self.cost_guard = CostGuard()
        self._transport_cache: dict[str, BaseTransport] = {}

        if LLM_API_KEY:
            os.environ["OPENAI_API_KEY"] = LLM_API_KEY
        if LLM_BASE_URL:
            litellm.api_base = LLM_BASE_URL

        primary = self.provider_manager.get_primary()
        if primary:
            self.model = self._normalize_model(primary.model)
            if primary.api_key:
                os.environ["OPENAI_API_KEY"] = primary.api_key
            if primary.base_url:
                litellm.api_base = primary.base_url

    @staticmethod
    def _normalize_model(model: str) -> str:
        if "/" in model:
            return model
        prefixes = {
            "deepseek": "openai",
            "gpt": "openai",
            "claude": "anthropic",
            "gemini": "gemini",
            "glm": "openai",
            "qwen": "openai",
            "mimo": "openai",
        }
        for prefix, provider in prefixes.items():
            if model.startswith(prefix):
                return f"{provider}/{model}"
        if LLM_BASE_URL:
            return f"openai/{model}"
        return model

    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        use_cache: bool = True,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        if use_cache and not stream and not tools:
            cached = self.cache.get(messages, self.model)
            if cached is not None:
                return {"content": cached, "role": "assistant", "finish_reason": "stop", "cached": True}

        if use_cache and not stream:
            prompt_result = self.prompt_cache.try_get_exact({
                "system_prompt": system_prompt,
                "messages": messages,
                "model_name": self.model,
            })
            if prompt_result.hit and prompt_result.value:
                return {
                    "content": prompt_result.value,
                    "role": "assistant",
                    "finish_reason": "stop",
                    "cached": True,
                    "cache_match_type": prompt_result.match_type,
                }

        result = await self.queue.submit(self._do_chat, messages, tools, stream)

        if use_cache and not stream and not tools and result.get("content"):
            self.prompt_cache.store_exact(
                {"system_prompt": system_prompt, "messages": messages, "model_name": self.model},
                result["content"],
            )

        return result

    async def _do_chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
    ) -> dict[str, Any]:
        transport = self._resolve_transport()
        if transport is not None:
            return await self._do_chat_via_transport(transport, messages, tools)

        return await self._do_chat_via_litellm(messages, tools, stream)

    def _resolve_transport(self) -> BaseTransport | None:
        primary = self.provider_manager.get_primary()
        if primary and primary.extra.get("transport"):
            transport_type = primary.extra["transport"]
            cache_key = f"{primary.name}:{transport_type}"
            if cache_key in self._transport_cache:
                return self._transport_cache[cache_key]

            config = TransportConfig(
                base_url=primary.base_url,
                api_key=primary.api_key,
                model=primary.model,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                extra=primary.extra,
            )
            transport = TransportFactory.create(TransportType(transport_type), config)
            self._transport_cache[cache_key] = transport
            return transport

        if primary and primary.base_url:
            cache_key = f"{primary.name}:auto"
            if cache_key in self._transport_cache:
                return self._transport_cache[cache_key]

            config = TransportConfig(
                base_url=primary.base_url,
                api_key=primary.api_key,
                model=primary.model,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                extra=primary.extra,
            )
            inferred = TransportFactory.infer_type(config)
            if inferred != TransportType.OPENAI_COMPATIBLE:
                transport = TransportFactory.create(inferred, config)
                self._transport_cache[cache_key] = transport
                return transport

        return None

    async def _do_chat_via_transport(
        self,
        transport: BaseTransport,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        converted_msgs = transport.convert_messages(messages)
        converted_tools = transport.convert_tools(tools)
        request = transport.build_request(converted_msgs, converted_tools, stream=False)

        api_key = self._resolve_api_key()
        if api_key and "Authorization" in request.headers:
            request.headers["Authorization"] = f"Bearer {api_key}"

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.request(
                method=request.method,
                url=request.url,
                headers=request.headers,
                json=request.body,
            )
            resp.raise_for_status()
            raw = resp.json()

        transport_resp: TransportResponse = transport.normalize_response(raw)

        result: dict[str, Any] = {
            "content": transport_resp.text,
            "role": transport_resp.role,
            "finish_reason": transport_resp.finish_reason,
        }
        if transport_resp.tool_calls:
            result["tool_calls"] = transport_resp.tool_calls
        if transport_resp.usage:
            input_tokens = transport_resp.usage.get("prompt_tokens", 0)
            output_tokens = transport_resp.usage.get("completion_tokens", 0)
            result["usage"] = {"input_tokens": input_tokens, "output_tokens": output_tokens}
            self.cost_guard.record_usage(self.model, input_tokens, output_tokens)

        if not tools:
            self.cache.set(messages, transport_resp.text, self.model)

        return result

    async def _do_chat_via_litellm(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
    ) -> dict[str, Any]:
        api_key = self._resolve_api_key()

        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": stream,
        }
        if tools:
            kwargs["tools"] = tools
        if api_key:
            kwargs["api_key"] = api_key

        try:
            response = await acompletion(**kwargs)
        except Exception as e:
            if self.credential_pool:
                self.credential_pool.report_failure(api_key or "")
            fallback = self.provider_manager.get_fallback(exclude=None)
            if fallback and fallback.api_key:
                kwargs["model"] = fallback.model
                kwargs["api_key"] = fallback.api_key
                if fallback.base_url:
                    litellm.api_base = fallback.base_url
                response = await acompletion(**kwargs)
            else:
                raise

        if self.credential_pool and api_key:
            self.credential_pool.report_success(api_key)

        if stream:
            return response

        choice = response.choices[0]
        message = choice.message
        result: dict[str, Any] = {
            "content": message.content or "",
            "role": message.role,
            "finish_reason": choice.finish_reason,
        }
        if hasattr(message, "tool_calls") and message.tool_calls:
            result["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in message.tool_calls
            ]

        usage = getattr(response, "usage", None)
        if usage:
            input_tokens = getattr(usage, "prompt_tokens", 0) or 0
            output_tokens = getattr(usage, "completion_tokens", 0) or 0
            result["usage"] = {"input_tokens": input_tokens, "output_tokens": output_tokens}
            self.cost_guard.record_usage(self.model, input_tokens, output_tokens)

        if not tools:
            self.cache.set(messages, result["content"], self.model)

        return result

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        response = await self.chat(messages=messages, tools=tools, stream=True, use_cache=False)
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
            yield data
            if chunk.choices[0].finish_reason:
                data["done"] = True
                yield data
                break

    async def embed(self, text: str, model: str | None = None) -> list[float] | None:
        """Generate embeddings for text using the configured provider."""
        if not text:
            return None

        model_name = self._normalize_model(model) if model else self._normalize_model(EMBEDDING_MODEL)
        api_key = self._resolve_api_key()

        kwargs: dict[str, Any] = {
            "model": model_name,
            "input": [text],
        }
        if api_key:
            kwargs["api_key"] = api_key

        try:
            response = await litellm.embedding(**kwargs)
            embedding = None
            if hasattr(response, "data") and response.data:
                first = response.data[0]
                embedding = getattr(first, "embedding", None)
                if embedding is None and isinstance(first, dict):
                    embedding = first.get("embedding")
            if isinstance(embedding, list):
                return embedding
        except Exception:
            pass
        return None

    async def check_available(self) -> bool:
        if self._available is not None:
            return self._available
        try:
            await acompletion(
                model=self.model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=5,
            )
            self._available = True
        except Exception:
            self._available = False
        return self._available

    def setup_credential_pool(
        self,
        api_keys: list[str],
        strategy: RotationStrategy = RotationStrategy.FILL_FIRST,
    ) -> None:
        entries = [CredentialEntry(key=k, weight=1.0) for k in api_keys]
        self.credential_pool = CredentialPool(
            provider_name=self.model,
            entries=entries,
            strategy=strategy,
        )

    def _resolve_api_key(self) -> str | None:
        if self.credential_pool:
            entry = self.credential_pool.get_next()
            return entry.key
        primary = self.provider_manager.get_primary()
        return primary.api_key if primary else None

    def get_cost_stats(self) -> dict[str, Any]:
        return self.cost_guard.get_daily_stats()

    def get_cache_stats(self) -> dict[str, Any]:
        return self.prompt_cache.get_stats()

    def get_credential_stats(self) -> dict[str, Any]:
        if self.credential_pool:
            return self.credential_pool.get_stats()
        return {"provider": self.model, "total": 0, "available": 0}
