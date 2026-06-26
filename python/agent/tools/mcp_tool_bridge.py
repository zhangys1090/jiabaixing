from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

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
    """

    async def get_running_servers(self) -> list[str]:
        return []

    async def list_tools(self, server_name: str) -> list[MCPToolInfo]:
        return []

    async def call_tool(self, server_name: str, tool_name: str, params: dict[str, Any]) -> Any:
        return None


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

    async def sync_to_registry(self, registry: ToolRegistry) -> int:
        running_servers = await self._provider.get_running_servers()
        synced_count = 0

        for server_name in running_servers:
            try:
                tools = await self._provider.list_tools(server_name)

                for tool in tools:
                    bridged_name = f"mcp_{server_name}_{tool.name}"

                    if bridged_name in self._bridged_tools:
                        continue

                    definition = ToolDefinition(
                        name=bridged_name,
                        description=f"[MCP/{server_name}] {tool.description or tool.name}",
                        category=self._infer_category(server_name),
                        parameters=self._convert_schema(tool.input_schema),
                        risk_level=self._infer_risk_level(server_name, tool.name),
                        permissions=self._infer_permissions(server_name, tool.name),
                    )

                    server_name_capture = server_name
                    tool_name_capture = tool.name

                    async def executor(params: dict[str, Any] | None = None) -> ToolResult:
                        return await self._execute_mcp_tool(
                            server_name_capture, tool_name_capture, params or {}
                        )

                    registry.register(definition, executor)
                    self._bridged_tools[bridged_name] = f"{server_name}/{tool.name}"
                    synced_count += 1

                    log.info(
                        f"MCP工具桥接: {bridged_name} ← {server_name}/{tool.name}"
                    )
            except Exception as err:
                log.warning(
                    f"MCP服务器 {server_name} 工具同步失败: {err}"
                )

        log.info(f"MCP工具桥接完成: {synced_count} 个新工具")
        return synced_count

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
