from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger
from agent.tools.registry import ToolCategory, ToolDefinition, ToolParameterDef, ToolResult, ToolRegistry

log = StructuredLogger("mcp_tool_bridge")

DEFAULT_SYNC_INTERVAL = 60.0


@dataclass
class MCPToolInfo:
    """MCP服务器工具信息。

    Attributes:
        name: 工具名称。
        description: 工具描述。
        input_schema: 输入参数的JSON Schema定义。
    """

    name: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)


class MCPProvider:
    """MCP服务器提供者接口，用于解耦MCP服务器管理。

    作为协议接口，定义了获取运行中服务器列表、获取服务器工具列表、
    调用服务器工具三个核心操作。实际实现由MCP服务器管理器提供。

    扩展支持通用JSON-RPC请求（send_request），用于Resources/Prompts
    等MCP标准协议方法。子类可覆写send_request以接入真实的JSON-RPC通道。
    """

    async def get_running_servers(self) -> list[str]:
        return []

    async def list_tools(self, server_name: str) -> list[MCPToolInfo]:
        return []

    async def call_tool(self, server_name: str, tool_name: str, params: dict[str, Any]) -> Any:
        return None

    async def send_request(
        self,
        server_name: str,
        method: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """发送通用JSON-RPC请求到MCP服务器。

        默认返回空字典（表示不支持）。子类应覆写此方法以接入真实的
        JSON-RPC通信通道（如stdio/SSE），从而支持resources/*、prompts/*
        等MCP标准协议方法。

        Args:
            server_name: MCP服务器名称。
            method: JSON-RPC方法名（如 "resources/list"）。
            params: 请求参数字典，可选。

        Returns:
            dict: MCP服务器返回的完整JSON-RPC响应。

        Raises:
            Exception: 当服务器未运行、超时或通信失败时由子类抛出。
        """
        return {}


class MCPToolBridge:
    """MCP工具桥接器——将MCP服务器工具动态注册到Python ToolRegistry。

    连接MCP服务器与本地工具系统，实现外部工具的无缝集成。
    支持自动同步、定期刷新和自定义工具命名。

    Usage:
        bridge = MCPToolBridge(provider=mcp_server_manager)
        count = await bridge.sync_to_registry(tool_registry)
        # 所有MCP工具自动注册为 mcp_{server}_{tool} 格式
    """
    def __init__(self, provider: MCPProvider | None = None) -> None:
        self._bridged_tools: dict[str, str] = {}
        self._sync_interval = DEFAULT_SYNC_INTERVAL
        self._sync_task: asyncio.Task | None = None
        self._provider = provider or MCPProvider()

    def set_provider(self, provider: MCPProvider) -> None:
        self._provider = provider

    async def sync_to_registry(
        self,
        registry: ToolRegistry,
        enabled_check: "Callable[[str], bool] | None" = None,
    ) -> int:
        """将运行中的 MCP 服务器工具注册到核心工具注册表。

        Args:
            registry: 核心工具注册表。
            enabled_check: 可选门控回调 ref("mcp:<server>") -> bool；返回 False 的
                服务器整体跳过（T4：ExtensionCatalog 窄腰门控，向后兼容默认全启用）。
        """
        running_servers = await self._await_or_call(self._provider.get_running_servers)
        synced_count = 0

        for server_name in running_servers:
            ref = f"mcp:{server_name}"
            if enabled_check is not None and not enabled_check(ref):
                log.info(f"MCP 服务器被扩展目录禁用, 跳过同步: {server_name}")
                continue
            try:
                tools = await self._await_or_call(
                    self._provider.list_tools, server_name
                )

                for tool in tools:
                    # 兼容 MCPToolInfo 对象和 dict 两种形式
                    if isinstance(tool, dict):
                        tool_name = tool.get("name", "")
                        tool_desc = tool.get("description", "")
                        tool_schema = tool.get("inputSchema") or tool.get("input_schema") or {}
                    else:
                        tool_name = tool.name
                        tool_desc = tool.description
                        tool_schema = tool.input_schema

                    bridged_name = f"mcp_{server_name}_{tool_name}"

                    if bridged_name in self._bridged_tools:
                        continue

                    definition = ToolDefinition(
                        name=bridged_name,
                        description=f"[MCP/{server_name}] {tool_desc or tool_name}",
                        category=self._infer_category(server_name),
                        parameters=self._convert_schema(tool_schema),
                        risk_level=self._infer_risk_level(server_name, tool_name),
                        permissions=self._infer_permissions(server_name, tool_name),
                    )

                    # 必须用默认参数绑定：普通赋值仍属循环作用域，闭包晚绑定会让
                    # 所有已注册工具都指向循环最后一次迭代的 server/tool（严重路由错乱）。
                    async def executor(
                        params: dict[str, Any] | None = None,
                        _server: str = server_name,
                        _tool: str = tool_name,
                    ) -> ToolResult:
                        return await self._execute_mcp_tool(_server, _tool, params or {})

                    registry.register(definition, executor)
                    self._bridged_tools[bridged_name] = f"{server_name}/{tool_name}"
                    synced_count += 1

                    log.info(
                        f"MCP工具桥接: {bridged_name} ← {server_name}/{tool_name}"
                    )
            except Exception as err:
                log.warning(
                    f"MCP服务器 {server_name} 工具同步失败: {err}"
                )

        log.info(f"MCP工具桥接完成: {synced_count} 个新工具")
        return synced_count

    @staticmethod
    async def _await_or_call(func: Any, *args: Any, **kwargs: Any) -> Any:
        """调用函数并兼容同步/异步两种实现.

        MCPServerManager.get_running_servers 是同步方法，而 MCPProvider
        协议定义为异步。此工具方法自动检测返回值是否为 awaitable，
        若是则 await，否则直接返回，使 MCPToolBridge 同时兼容两种 provider。

        Args:
            func: 待调用的方法（同步或异步）.
            *args: 位置参数.
            **kwargs: 关键字参数.

        Returns:
            Any: 方法返回值（已解包协程）.
        """
        result = func(*args, **kwargs)
        if inspect.isawaitable(result):
            return await result
        return result

    async def _execute_mcp_tool(
        self, server_name: str, tool_name: str, params: dict[str, Any]
    ) -> ToolResult:
        start_time = time.monotonic()
        try:
            result = await self._provider.call_tool(server_name, tool_name, params)

            output_str = result if isinstance(result, str) else str(result)

            return ToolResult(
                success=True,
                output=output_str[:4000],
                duration=time.monotonic() - start_time,
            )
        except Exception as err:
            return ToolResult(
                success=False,
                error=f"MCP工具调用失败 [{server_name}/{tool_name}]: {err}",
                duration=time.monotonic() - start_time,
            )

    def _convert_schema(self, input_schema: dict[str, Any] | None) -> list[ToolParameterDef]:
        if not input_schema:
            return []

        properties = input_schema.get("properties", {})
        if not isinstance(properties, dict):
            return []

        required_fields: list[str] = input_schema.get("required", [])
        if not isinstance(required_fields, list):
            required_fields = []

        valid_types = {"string", "number", "boolean", "object", "array"}
        result: list[ToolParameterDef] = []

        for name, schema in properties.items():
            if not isinstance(schema, dict):
                continue
            raw_type = schema.get("type", "string")
            param_type = raw_type if raw_type in valid_types else "string"
            result.append(ToolParameterDef(
                name=name,
                type=param_type,
                required=name in required_fields,
                description=schema.get("description", name),
            ))

        return result

    def _infer_category(self, server_name: str) -> ToolCategory:
        mapping: dict[str, ToolCategory] = {
            "browser": ToolCategory.NETWORK,
            "cron": ToolCategory.SYSTEM,
            "filesystem": ToolCategory.FILE,
            "sqlite": ToolCategory.MEMORY,
        }
        return mapping.get(server_name, ToolCategory.SYSTEM)

    def _infer_risk_level(self, server_name: str, tool_name: str) -> str:
        if server_name == "browser":
            return "medium"
        if server_name == "filesystem":
            return "high"
        if server_name == "cron":
            return "medium"
        if "delete" in tool_name or "remove" in tool_name:
            return "high"
        if "write" in tool_name or "create" in tool_name:
            return "medium"
        return "low"

    def _infer_permissions(self, server_name: str, tool_name: str) -> list[str]:
        if server_name == "browser":
            return ["network:access"]
        if server_name == "filesystem":
            if any(kw in tool_name for kw in ("write", "create", "delete")):
                return ["file:write"]
            return ["file:read"]
        if server_name == "cron":
            return ["system:admin"]
        if server_name == "sqlite":
            return ["memory:read", "memory:write"]
        if "delete" in tool_name or "admin" in tool_name:
            return ["system:admin"]
        return ["code:execute"]

    def start_auto_sync(self, registry: ToolRegistry) -> None:
        if self._sync_task and not self._sync_task.done():
            return
        self._sync_task = asyncio.create_task(self._auto_sync_loop(registry))
        log.info(f"MCP工具自动同步已启动 (间隔={self._sync_interval}s)")

    def stop_auto_sync(self) -> None:
        if self._sync_task and not self._sync_task.done():
            self._sync_task.cancel()
            self._sync_task = None

    async def _auto_sync_loop(self, registry: ToolRegistry) -> None:
        while True:
            try:
                await self.sync_to_registry(registry)
            except Exception as err:
                log.warning(f"自动同步出错: {err}")
            await asyncio.sleep(self._sync_interval)

    def get_bridged_tools(self) -> dict[str, str]:
        return dict(self._bridged_tools)

    def set_sync_interval(self, seconds: float) -> None:
        self._sync_interval = seconds

    async def _send_jsonrpc(
        self,
        server_name: str,
        method: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """发送JSON-RPC请求到MCP服务器（内部复用方法）。

        委托给provider.send_request实现真实的JSON-RPC通信。异常会向上
        抛出，由公共方法（list_resources/read_resource等）捕获并转换为
        空结构返回。

        Args:
            server_name: MCP服务器名称。
            method: JSON-RPC方法名（如 "resources/list"、"prompts/get"）。
            params: 请求参数字典，可选。

        Returns:
            dict: MCP服务器返回的完整JSON-RPC响应。

        Raises:
            Exception: 当服务器未运行、超时或通信失败时抛出。
        """
        return await self._provider.send_request(server_name, method, params)

    async def list_resources(self, server_name: str) -> list[dict[str, Any]]:
        """列出MCP服务器的可用资源。

        发送 resources/list JSON-RPC请求获取服务器资源列表。每个资源
        通常包含 uri、name、description、mimeType 字段（遵循MCP协议规范）。

        Args:
            server_name: MCP服务器名称。

        Returns:
            list[dict]: 资源列表。服务器不存在、超时或通信失败时返回空列表。
        """
        try:
            response = await self._send_jsonrpc(server_name, "resources/list", {})
            result = response.get("result", {}) if isinstance(response, dict) else {}
            if not isinstance(result, dict):
                return []
            resources = result.get("resources", [])
            return resources if isinstance(resources, list) else []
        except Exception as err:
            log.warning(f"MCP服务器 {server_name} 资源列表获取失败: {err}")
            return []

    async def read_resource(self, server_name: str, uri: str) -> dict[str, Any]:
        """读取MCP服务器资源内容。

        发送 resources/read JSON-RPC请求，根据URI读取资源内容。返回的
        contents中每个元素包含 uri、mimeType 以及 text 或 blob（base64）字段。

        Args:
            server_name: MCP服务器名称。
            uri: 资源URI（如 "file:///path/to/file"）。

        Returns:
            dict: 形如 {"contents": [...]}。资源不存在或通信失败时返回
            {"contents": []}。
        """
        try:
            response = await self._send_jsonrpc(
                server_name, "resources/read", {"uri": uri}
            )
            result = response.get("result", {}) if isinstance(response, dict) else {}
            if not isinstance(result, dict):
                return {"contents": []}
            contents = result.get("contents", [])
            if not isinstance(contents, list):
                return {"contents": []}
            return {"contents": contents}
        except Exception as err:
            log.warning(f"MCP服务器 {server_name} 资源读取失败 [{uri}]: {err}")
            return {"contents": []}

    async def list_prompts(self, server_name: str) -> list[dict[str, Any]]:
        """列出MCP服务器的可用提示模板。

        发送 prompts/list JSON-RPC请求获取服务器提示列表。每个提示
        通常包含 name、description、arguments 字段（遵循MCP协议规范）。

        Args:
            server_name: MCP服务器名称。

        Returns:
            list[dict]: 提示列表。服务器不存在、超时或通信失败时返回空列表。
        """
        try:
            response = await self._send_jsonrpc(server_name, "prompts/list", {})
            result = response.get("result", {}) if isinstance(response, dict) else {}
            if not isinstance(result, dict):
                return []
            prompts = result.get("prompts", [])
            return prompts if isinstance(prompts, list) else []
        except Exception as err:
            log.warning(f"MCP服务器 {server_name} 提示列表获取失败: {err}")
            return []

    async def get_prompt(
        self,
        server_name: str,
        name: str,
        arguments: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """获取MCP服务器提示内容。

        发送 prompts/get JSON-RPC请求，根据name和可选参数获取提示内容。
        返回的messages中每个元素包含 role 和 content（含 type、text）字段。

        Args:
            server_name: MCP服务器名称。
            name: 提示模板名称。
            arguments: 提示参数字典（可选），用于填充提示模板中的占位符。

        Returns:
            dict: 形如 {"messages": [...]}。提示不存在或通信失败时返回
            {"messages": []}。
        """
        try:
            params: dict[str, Any] = {"name": name}
            if arguments:
                params["arguments"] = arguments
            response = await self._send_jsonrpc(server_name, "prompts/get", params)
            result = response.get("result", {}) if isinstance(response, dict) else {}
            if not isinstance(result, dict):
                return {"messages": []}
            messages = result.get("messages", [])
            if not isinstance(messages, list):
                return {"messages": []}
            return {"messages": messages}
        except Exception as err:
            log.warning(f"MCP服务器 {server_name} 提示获取失败 [{name}]: {err}")
            return {"messages": []}
