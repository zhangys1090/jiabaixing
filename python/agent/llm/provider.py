from __future__ import annotations

import asyncio
import os
import time
from typing import Any, AsyncIterator

import httpx
import litellm
from litellm import acompletion

from agent.config import EMBEDDING_MODEL, LLM_API_KEY, LLM_BASE_URL, LLM_MAX_TOKENS, LLM_MODEL, LLM_TEMPERATURE
from agent.core.canary_release import CanaryReleaseManager, safe_record_outcome
from agent.core.otel_metrics import llm_tokens_counter
from agent.core.production_metrics import get_production_metrics_collector
from agent.llm.cache import LLMCache
from agent.llm.credential_pool import CostGuard, CredentialEntry, CredentialPool, RotationStrategy, _MODEL_PRICING
from agent.llm.prompt_cache import (
    AnthropicPrefixCacheBuilder,
    PromptCacheManager,
    apply_anthropic_prefix_cache,
)
from agent.llm.queue import RequestQueue
from agent.llm.router import ProviderConfig, ProviderManager
from agent.llm.stream import stream_via_litellm, stream_via_transport
from agent.llm.transports import (
    BaseTransport,
    TransportConfig,
    TransportFactory,
    TransportResponse,
    TransportType,
)


def _record_llm_tokens(model: str, usage: dict[str, Any] | None) -> None:
    """将 LLM 响应的 usage 记录到 OTel Counter（OTel 未启用时为 NoOp）。

    同时通过 ProductionMetricsCollector.record_llm_usage 记录 token 用量与成本，
    实现 P3-#3 生产埋点的统一采集。

    Args:
        model: 实际调用的模型名。
        usage: 包含 input_tokens/output_tokens 的 usage 字典；为 None 时跳过。
    """
    if not usage:
        return
    try:
        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)
        if input_tokens > 0:
            llm_tokens_counter().add(input_tokens, {"model": model, "type": "prompt"})
        if output_tokens > 0:
            llm_tokens_counter().add(output_tokens, {"model": model, "type": "completion"})
        # P3-#3: 统一通过生产埋点采集器记录 token + 成本（复用 _MODEL_PRICING 估算成本）
        pricing = _MODEL_PRICING.get(model)
        if not pricing:
            pricing = {"input": 1.0 / 1_000_000, "output": 3.0 / 1_000_000}
        cost = input_tokens * pricing["input"] + output_tokens * pricing["output"]
        get_production_metrics_collector().record_llm_usage(
            model=model,
            prompt_tokens=input_tokens,
            completion_tokens=output_tokens,
            cost=cost,
        )
    except Exception:
        # OTel 记录失败不影响 LLM 主流程
        pass


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
        # Anthropic 前缀缓存构建器：为 Claude 模型自动标记 cache_control 断点
        # 可节省 90% 前缀 token 成本，首字延迟降低 30%
        self.anthropic_cache_builder = AnthropicPrefixCacheBuilder(
            enabled=os.environ.get("ANTHROPIC_CACHE_ENABLED", "true").lower() == "true",
            min_prefix_tokens=int(os.environ.get("ANTHROPIC_CACHE_MIN_TOKENS", "1024")),
            max_breakpoints=int(os.environ.get("ANTHROPIC_CACHE_MAX_BREAKPOINTS", "4")),
        )
        self.credential_pool: CredentialPool | None = None
        self.cost_guard = CostGuard()
        self._transport_cache: dict[str, BaseTransport] = {}
        # 灰度发布管理器：可选，由 LoopController 注入
        self.canary_manager: CanaryReleaseManager | None = None

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
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> dict[str, Any]:
        # 灰度发布：基于用户哈希分桶选择版本
        model_override: str | None = None
        canary_active = False
        if self.canary_manager and user_id and strategy_name:
            try:
                assignment = await self.canary_manager.select_version(user_id, strategy_name)
                if assignment.is_canary:
                    model_override = assignment.canary_version
                    canary_active = True
            except Exception:
                pass  # 灰度选择失败不影响主流程

        effective_model = model_override or self.model

        estimated_input_tokens = sum(len(m.get("content", "")) // 4 for m in messages)
        estimated_output_tokens = self.max_tokens
        estimated_cost = self.cost_guard.calculate_cost(
            effective_model, estimated_input_tokens, estimated_output_tokens
        )
        if not self.cost_guard.check_budget(estimated_cost):
            from agent.core.logger import StructuredLogger
            log = StructuredLogger("llm_provider")
            log.warning(
                "LLM 请求因预算超限被拦截",
                model=effective_model,
                estimated_cost=estimated_cost,
                daily_spent=self.cost_guard.get_daily_spent(),
                daily_budget=self.cost_guard._daily_budget,
            )
            return {
                "content": "",
                "role": "assistant",
                "finish_reason": "budget_exceeded",
                "error": "成本预算超限，请求被拦截",
                "usage": {"input_tokens": 0, "output_tokens": 0},
            }

        if use_cache and not stream and not tools:
            cached = self.cache.get(
                messages, effective_model, system_prompt=system_prompt, tools=tools
            )
            if cached is not None:
                if canary_active:
                    await safe_record_outcome(self.canary_manager, user_id, strategy_name, True, 0.0)
                return {"content": cached, "role": "assistant", "finish_reason": "stop", "cached": True}

        if use_cache and not stream:
            prompt_result = self.prompt_cache.try_get_exact({
                "system_prompt": system_prompt,
                "messages": messages,
                "model_name": effective_model,
            })
            if prompt_result.hit and prompt_result.value:
                if canary_active:
                    await safe_record_outcome(self.canary_manager, user_id, strategy_name, True, 0.0)
                return {
                    "content": prompt_result.value,
                    "role": "assistant",
                    "finish_reason": "stop",
                    "cached": True,
                    "cache_match_type": prompt_result.match_type,
                }

        _start = time.time()
        _success = False
        try:
            result = await self.queue.submit(
                self._do_chat, messages, tools, stream, model_override=model_override
            )
            _success = True

            if use_cache and not stream and not tools and result.get("content"):
                self.prompt_cache.store_exact(
                    {"system_prompt": system_prompt, "messages": messages, "model_name": effective_model},
                    result["content"],
                )

            return result
        finally:
            if canary_active:
                latency_ms = (time.time() - _start) * 1000
                await safe_record_outcome(self.canary_manager, user_id, strategy_name, _success, latency_ms)

    async def _do_chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        tool_choice: str = "auto",
        model_override: str | None = None,
    ) -> dict[str, Any]:
        # 灰度版本切换时跳过 transport，统一走 litellm 路径
        transport = None if model_override else self._resolve_transport()
        if transport is not None:
            return await self._do_chat_via_transport(transport, messages, tools, tool_choice)

        return await self._do_chat_via_litellm(messages, tools, stream, model_override)

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
        tool_choice: str = "auto",
    ) -> dict[str, Any]:
        """通过 transport 执行非流式聊天请求，返回包含 content/role/finish_reason/tool_calls/usage 的响应."""
        converted_msgs = transport.convert_messages(messages)
        converted_tools = transport.convert_tools(tools)
        request = transport.build_request(converted_msgs, converted_tools, stream=False, tool_choice=tool_choice)

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
            # 记录到 OTel LLM Token Counter（OTel 未启用时为 NoOp）
            _record_llm_tokens(self.model, result["usage"])

        if not tools:
            self.cache.set(
                messages, transport_resp.text, self.model, system_prompt=None, tools=tools
            )

        return result

    async def _do_chat_via_litellm(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        model_override: str | None = None,
    ) -> dict[str, Any]:
        api_key = self._resolve_api_key()
        # 灰度发布：优先使用灰度版本模型
        effective_model = model_override or self.model

        # Anthropic 前缀缓存：为 Claude 模型自动标记 cache_control 断点
        # 系统提示 + 上下文文件等固定前缀会被缓存，节省 90% 前缀 token 成本
        processed_messages, system_blocks, processed_tools = apply_anthropic_prefix_cache(
            self.anthropic_cache_builder, messages, tools, effective_model
        )

        kwargs: dict[str, Any] = {
            "model": effective_model,
            "messages": processed_messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": stream,
        }
        # Anthropic API 通过 system 参数传递系统提示
        if system_blocks:
            kwargs["system"] = system_blocks
        if processed_tools:
            kwargs["tools"] = processed_tools
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
            self.cost_guard.record_usage(effective_model, input_tokens, output_tokens)
            # 记录到 OTel LLM Token Counter（OTel 未启用时为 NoOp）
            _record_llm_tokens(effective_model, result["usage"])

        if not tools:
            self.cache.set(
                messages, result["content"], effective_model, system_prompt=None, tools=tools
            )

        return result

    async def chat_with_tools(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
    ) -> dict[str, Any]:
        """原生 Function Calling — 使用 OpenAI tools 参数（非文本解析）.

        通过 transport 或 litellm 将 tools 参数原生传递给 LLM，
        返回结构化的 tool_calls 响应，而非文本解析。

        Args:
            messages: 消息列表.
            tools: 工具定义列表（OpenAI tools 格式）.
            tool_choice: 工具选择策略，可选 "auto"/"none"/具体工具.

        Returns:
            dict: 包含 content/role/finish_reason/tool_calls/usage 的响应.

        Raises:
            httpx.HTTPStatusError: LLM API 返回错误状态码时抛出.
        """
        if not tools:
            # 无工具时退化为普通 chat
            return await self.chat(messages=messages, tools=None, use_cache=False)

        result = await self.queue.submit(
            self._do_chat, messages, tools, False, tool_choice
        )
        return result

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """真实 SSE 流式输出 — 使用 httpx + stream=True 逐 chunk yield.

        与伪流式（仅 2 chunk）不同，此方法逐行解析 SSE 数据，实时 yield chunk。
        支持: 文本增量、tool_calls 增量、finish_reason、[DONE] 标记。
        集成灰度发布：当传入 user_id 与 strategy_name 时，先进行哈希分桶，
        命中灰度则跳过 transport，统一走 litellm 路径并使用灰度版本模型。

        Args:
            messages: 消息列表.
            tools: 工具定义列表（可选）.
            user_id: 用户 ID（用于灰度分桶，可选）.
            strategy_name: 灰度策略名称（可选）.

        Yields:
            dict: chunk 数据（content/tool_calls/finish_reason/done）.

        Raises:
            httpx.HTTPStatusError: LLM API 返回错误状态码时抛出.
        """
        # 灰度发布：先做分桶判断，命中灰度则必须走 litellm 路径
        canary_active = False
        if self.canary_manager and user_id and strategy_name:
            try:
                assignment = await self.canary_manager.select_version(user_id, strategy_name)
                if assignment.is_canary:
                    canary_active = True
            except Exception:
                pass  # 灰度选择失败不影响主流程

        # 非灰度场景优先使用 transport
        if not canary_active:
            transport = self._resolve_transport()
            if transport is not None:
                api_key = self._resolve_api_key()
                async for chunk in stream_via_transport(transport, messages, tools, api_key):
                    yield chunk
                return

        # 回退到 litellm 流式（含灰度版本选择）
        async for chunk in stream_via_litellm(
            self, messages, tools, user_id=user_id, strategy_name=strategy_name
        ):
            yield chunk

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
            await asyncio.wait_for(
                acompletion(
                    model=self.model,
                    messages=[{"role": "user", "content": "ping"}],
                    max_tokens=5,
                ),
                timeout=5.0,
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
