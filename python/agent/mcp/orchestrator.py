from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from agent.tools.mcp_tool_bridge import MCPToolBridge
from agent.tools.registry import ToolDefinition, ToolRegistry, ToolResult

# 默认仅桥接名称以该前缀开头的工具（MCPToolBridge 注册的工具前缀）
_MCP_TOOL_PREFIX = "mcp_"


@dataclass
class ToolCall:
    """LLM 选择出的单次工具调用。"""

    tool_name: str
    params: dict[str, Any]


@dataclass
class ToolExecutionResult:
    """工具执行结果（与 ToolResult 解耦，便于序列化/上报）。"""

    tool_name: str
    success: bool
    output: str = ""
    error: str | None = None
    metadata: dict[str, Any] = None  # type: ignore[assignment]

    @classmethod
    def from_tool_result(cls, name: str, result: ToolResult) -> "ToolExecutionResult":
        return cls(
            tool_name=name,
            success=result.success,
            output=result.output,
            error=result.error,
            metadata=result.metadata or {},
        )


@runtime_checkable
class ToolSelector(Protocol):
    """工具选择器协议（可插拔）。

    真实环境中由 V4 Flash 的 function calling 实现；测试/离线环境用
    ``RuleBasedSelector`` 等确定性实现替代。协议保持与 LLM 调用解耦，
    使「动态工具发现 → LLM 选择 → 执行」链路可端到端验证。
    """

    async def select(self, query: str, definitions: list[ToolDefinition]) -> list[ToolCall]:
        ...


class RuleBasedSelector:
    """确定性工具选择器（离线/冒烟用，替代 LLM）。

    按查询词与工具名/描述/标签的匹配度打分排序，返回 Top-N。
    中文按子串匹配，英文按分词匹配，CJK 退化为字符重叠。
    """

    def __init__(self, limit: int = 5) -> None:
        self.limit = limit

    async def select(self, query: str, definitions: list[ToolDefinition]) -> list[ToolCall]:
        q = query.lower()
        scored: list[tuple[float, ToolDefinition]] = []
        for d in definitions:
            text = (d.name + " " + d.description + " " + " ".join(d.tags)).lower()
            if q and q in text:
                score = 2.0
            else:
                tokens = [t for t in q.split() if t]
                if tokens and any(tok in text for tok in tokens):
                    score = 1.0
                else:
                    overlap = len(set(q) & set(text))
                    score = 0.1 * overlap if overlap else 0.0
            if score > 0:
                scored.append((score, d))
        scored.sort(key=lambda x: -x[0])
        return [ToolCall(tool_name=d.name, params={}) for _, d in scored[: self.limit]]


def tool_definition_to_openai_schema(definition: ToolDefinition) -> dict[str, Any]:
    """将 ``ToolDefinition`` 转换为 OpenAI function-calling 工具 schema。"""
    properties: dict[str, Any] = {}
    required: list[str] = []
    for p in definition.parameters:
        param: dict[str, Any] = {"type": p.type, "description": p.description}
        if p.enum:
            param["enum"] = p.enum
        if p.items:
            param["items"] = p.items
        if p.properties:
            param["properties"] = p.properties
        if p.default is not None:
            param["default"] = p.default
        properties[p.name] = param
        if p.required:
            required.append(p.name)
    return {
        "type": "function",
        "function": {
            "name": definition.name,
            "description": definition.description or definition.short_desc,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


class LlmToolSelector:
    """基于 LLM 原生 Function Calling（V4 Flash）的真实工具选择器。

    把候选工具 schema 通过 ``LLMProvider.chat_with_tools`` 原生传给模型，
    解析结构化 ``tool_calls`` 响应得到选择结果。与 ``RuleBasedSelector``
    实现同一 ``ToolSelector`` 协议，可在编排器中无缝替换。
    """

    def __init__(self, llm: Any) -> None:
        # llm 需提供 chat_with_tools(messages, tools, tool_choice="auto")
        self._llm = llm

    async def select(self, query: str, definitions: list[ToolDefinition]) -> list[ToolCall]:
        tools = [tool_definition_to_openai_schema(d) for d in definitions]
        if not tools:
            return []
        resp = await self._llm.chat_with_tools(
            messages=[{"role": "user", "content": query}],
            tools=tools,
            tool_choice="auto",
        )
        raw_calls = resp.get("tool_calls") or []
        calls: list[ToolCall] = []
        for tc in raw_calls:
            fn = tc.get("function", {}) if isinstance(tc, dict) else {}
            name = fn.get("name", "")
            if not name:
                continue
            raw_args = fn.get("arguments", "{}")
            try:
                params = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except json.JSONDecodeError:
                params = {}
            calls.append(ToolCall(tool_name=name, params=params or {}))
        return calls


class MCPToolOrchestrator:
    """MCP 端到端链路编排：动态工具发现 → LLM 选择 → 执行。

    职责：
      1. ``discover``：注册 MCP server 并将其工具动态桥接到工具注册中心
         （经由既有 MCPToolBridge，工具以 ``mcp_<server>_<tool>`` 前缀暴露）。
      2. ``select_and_execute``：把注册中心内（含 MCP 桥接）的工具定义交给
         可插拔的 ``ToolSelector``（LLM 实现）做选择，再执行并回收结果。

    该组件只在既有能力上做编排接线，不重复实现 MCP 连接/工具执行。
    """

    def __init__(
        self,
        mcp_manager: Any,
        registry: ToolRegistry,
        bridge: MCPToolBridge | None = None,
    ) -> None:
        self.mcp_manager = mcp_manager
        self.registry = registry
        self.bridge = bridge or MCPToolBridge(mcp_manager)

    async def discover(self, server_config: Any) -> int:
        """注册并桥接一个 MCP server 的全部工具，返回桥接工具数。"""
        self.mcp_manager.register_server(server_config)
        return await self.bridge.sync_to_registry(self.registry)

    async def select_and_execute(
        self,
        query: str,
        selector: ToolSelector,
        *,
        only_mcp: bool = False,
        top_k: int | None = None,
    ) -> list[ToolExecutionResult]:
        """LLM 选择 → 执行 的闭环。

        Args:
            query: 用户/任务的原始诉求，喂给选择器。
            selector: 可插拔的工具选择器（真实 LLM 或离线 RuleBasedSelector）。
            only_mcp: 仅从 MCP 桥接工具中选择（默认全量）。
            top_k: 候选工具集截断。
        """
        tools = self.registry.get_all_definitions()
        if only_mcp:
            tools = [t for t in tools if t.name.startswith(_MCP_TOOL_PREFIX)]
        if top_k:
            tools = tools[:top_k]

        calls = await selector.select(query, tools)
        results: list[ToolExecutionResult] = []
        for call in calls:
            try:
                result = await self.registry.execute(call.tool_name, call.params)
                results.append(ToolExecutionResult.from_tool_result(call.tool_name, result))
            except Exception as exc:
                results.append(
                    ToolExecutionResult(
                        tool_name=call.tool_name,
                        success=False,
                        error=str(exc),
                        metadata={"stage": "execute"},
                    )
                )
        return results
