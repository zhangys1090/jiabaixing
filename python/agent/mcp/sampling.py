"""MCP Sampling 原语 — Server 向 Client 请求 LLM 推理（反向调用）.

遵循 MCP 规范（2024-11-05）的 sampling/createMessage 方法：
当 MCP Server 端需要 LLM 能力但不自带 LLM 时，可通过该方法向 Client
发起采样请求，由 Client 利用自身 LLMProvider 完成推理并回传结果。

模块归属：Python 端（遵循 AGENTS.md §0.1 模块归属强制表 — LLM 调用
主实现端为 Python）。

参考：
- https://spec.modelcontextprotocol.io/specification/2024-11-05/#sampling
"""

from __future__ import annotations

from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("mcp.sampling")

# MCP 规范定义的 stop_reason 取值
STOP_REASON_END_TURN = "endTurn"
STOP_REASON_STOP_SEQUENCE = "stopSequence"
STOP_REASON_MAX_TOKENS = "maxTokens"

# 允许的 stop_reason 集合
_VALID_STOP_REASONS = frozenset({
    STOP_REASON_END_TURN,
    STOP_REASON_STOP_SEQUENCE,
    STOP_REASON_MAX_TOKENS,
})


class MCPSamplingManager:
    """MCP Sampling 原语管理器.

    实现 MCP 规范的 sampling/createMessage 方法：Server 向 Client 请求
    LLM 推理，Client 利用项目自身的 LLMProvider 完成调用并返回结果。

    设计要点：
    - LLMProvider 通过 set_provider 延迟注入，避免循环依赖；
      未注入时尝试从 agent.main.engine 解析（运行期可用）。
    - 输入 request 符合 MCP 规范的 CreateMessageParams：
      ``{messages, modelPreferences?, systemPrompt?, maxTokens?, ...}``.
    - 输出符合 MCP 规范的 SamplingResult：
      ``{role, content, model, stopReason}``.

    Attributes:
        _provider: 注入的 LLMProvider 实例（可选）.
        _provider_factory: 解析 provider 的回调函数（可选）.
    """

    def __init__(self) -> None:
        self._provider: Any = None
        self._provider_factory: Callable[[], Any] | None = None

    def set_provider(self, provider: Any) -> None:
        """注入 LLMProvider 实例.

        Args:
            provider: LLMProvider 实例，需实现 ``async chat(messages, system_prompt)``.
        """
        self._provider = provider
        log.info("MCPSamplingManager provider 已注入")

    def set_provider_factory(self, factory: Callable[[], Any]) -> None:
        """注入 provider 解析工厂.

        当 LLMProvider 在管理器构造时尚未就绪时使用，每次 create_message
        调用前会通过 factory 动态获取。

        Args:
            factory: 返回 LLMProvider 实例的回调函数.
        """
        self._provider_factory = factory

    def _resolve_provider(self) -> Any:
        """解析当前可用的 LLMProvider 实例.

        解析顺序：
        1. ``set_provider`` 显式注入的实例；
        2. ``set_provider_factory`` 注册的工厂返回值；
        3. ``agent.main.engine.llm`` 全局引擎的 LLM 实例.

        Returns:
            Any: LLMProvider 实例；不可用时返回 None.
        """
        if self._provider is not None:
            return self._provider
        if self._provider_factory is not None:
            try:
                provider = self._provider_factory()
                if provider is not None:
                    return provider
            except Exception as e:
                log.warning("provider_factory 解析失败", error=str(e))
        # 回退到全局 engine
        try:
            from agent.main import engine  # 延迟导入避免循环依赖
            if engine is not None and hasattr(engine, "llm") and engine.llm:
                return engine.llm
        except Exception as e:
            log.debug("engine.llm 不可用", error=str(e))
        return None

    async def create_message(self, request: dict[str, Any]) -> dict[str, Any]:
        """处理 sampling/createMessage 请求.

        Args:
            request: MCP 规范的 CreateMessageParams，包含：
                - messages: list[dict] — 采样消息列表，每项含 role/content.
                - modelPreferences: dict | None — 模型偏好提示.
                - systemPrompt: str | None — 系统提示词.
                - maxTokens: int | None — 最大生成 token 数.
                - temperature: float | None — 采样温度.
                - stopSequences: list[str] | None — 停止序列.

        Returns:
            dict: MCP 规范的 SamplingResult:
                - role: 固定为 "assistant".
                - content: {"type": "text", "text": str}.
                - model: 实际使用的模型名.
                - stopReason: 停止原因（endTurn/stopSequence/maxTokens）.

        Raises:
            RuntimeError: LLMProvider 不可用或 LLM 调用失败.
            ValueError: request 格式不合法（缺少 messages）.
        """
        if not isinstance(request, dict):
            raise ValueError("sampling 请求必须是 dict")

        messages = request.get("messages")
        if not messages or not isinstance(messages, list):
            raise ValueError("sampling 请求缺少 messages 字段")

        provider = self._resolve_provider()
        if provider is None:
            raise RuntimeError("LLMProvider 不可用，无法处理 sampling 请求")

        # 转换 MCP 消息格式为 LLMProvider.chat 所需格式
        chat_messages = self._convert_messages(messages)
        system_prompt = request.get("systemPrompt")
        max_tokens = request.get("maxTokens")

        log.info(
            "处理 sampling 请求",
            message_count=len(chat_messages),
            has_system_prompt=bool(system_prompt),
            max_tokens=max_tokens,
        )

        try:
            # 调用 LLM — LLMProvider.chat 返回 {content, role, finish_reason, ...}
            response = await provider.chat(
                messages=chat_messages,
                system_prompt=system_prompt,
                use_cache=False,
            )
        except Exception as e:
            log.error("sampling LLM 调用失败", error=str(e))
            raise RuntimeError(f"LLM 调用失败: {e}") from e

        content_text = ""
        if isinstance(response, dict):
            content_text = str(response.get("content", "") or "")
        else:
            content_text = str(response)

        finish_reason = ""
        if isinstance(response, dict):
            finish_reason = str(response.get("finish_reason", "") or "")

        # 推断实际使用的模型名
        model_name = ""
        if isinstance(response, dict):
            model_name = str(response.get("model", "") or "")
        if not model_name:
            model_name = getattr(provider, "model", "") or "unknown"

        stop_reason = self._map_stop_reason(finish_reason, request.get("stopSequences"))

        result = {
            "role": "assistant",
            "content": {
                "type": "text",
                "text": content_text,
            },
            "model": model_name,
            "stopReason": stop_reason,
        }
        log.info("sampling 请求完成", model=model_name, stop_reason=stop_reason)
        return result

    @staticmethod
    def _convert_messages(messages: list[dict]) -> list[dict[str, str]]:
        """将 MCP 消息格式转换为 LLMProvider.chat 所需格式.

        MCP 消息的 content 可能是字符串或 {"type": "text", "text": str} 对象。
        LLMProvider.chat 接受 OpenAI 风格的 ``{"role": ..., "content": str}``。

        Args:
            messages: MCP 消息列表.

        Returns:
            list[dict]: 转换后的 OpenAI 格式消息列表.
        """
        converted: list[dict[str, str]] = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content")
            if isinstance(content, dict):
                text = content.get("text", "")
            elif isinstance(content, str):
                text = content
            else:
                text = str(content) if content is not None else ""
            converted.append({"role": role, "content": text})
        return converted

    @staticmethod
    def _map_stop_reason(
        finish_reason: str, stop_sequences: list[str] | None
    ) -> str:
        """将 LLM finish_reason 映射为 MCP stopReason.

        Args:
            finish_reason: LLM 返回的 finish_reason（如 "stop"/"length"/"tool_calls"）.
            stop_sequences: MCP 请求中传入的停止序列列表.

        Returns:
            str: MCP stopReason（endTurn/stopSequence/maxTokens）.
        """
        finish = (finish_reason or "").lower()
        if finish in ("length", "max_tokens"):
            return STOP_REASON_MAX_TOKENS
        if finish == "stop" and stop_sequences:
            return STOP_REASON_STOP_SEQUENCE
        return STOP_REASON_END_TURN


__all__ = [
    "MCPSamplingManager",
    "STOP_REASON_END_TURN",
    "STOP_REASON_STOP_SEQUENCE",
    "STOP_REASON_MAX_TOKENS",
]
