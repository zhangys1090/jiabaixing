"""MCPToolBridge — MCP 工具到 Agent 工具注册表的桥接。

将 MCP 服务端提供的工具自动注册到 Agent 的工具注册表，
使 LLM 可以像调用本地工具一样调用 MCP 远程工具。

桥接流程：
1. 发现 MCP 工具
2. 为每个工具生成 Agent 工具描述
3. 注册到 ToolRegistry
4. 调用时转发到 MCP 服务端

Usage:
    from agent.mcp_integration.mcp_tool_bridge import MCPToolBridge
    bridge = MCPToolBridge(mcp_client, tool_registry)
    count = await bridge.register_all("my-server")
"""
from __future__ import annotations

from typing import Any

from agent.mcp_integration.mcp_client import MCPClient, MCPTool
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("mcp_tool_bridge")



class MCPToolBridge:
    """MCP 工具桥接器。

    将 MCP 远程工具桥接为 Agent 本地工具，实现：
    - 自动发现并注册 MCP 工具
    - 参数格式转换（JSON Schema -> Agent 格式）
    - 调用转发（Agent -> MCP -> 结果回传）
    - 工具生命周期管理

    Usage:
        bridge = MCPToolBridge(mcp_client, tool_registry)
        count = await bridge.register_all("my-server")
    """

    TOOL_PREFIX = "mcp_"

    def __init__(self, mcp_client: MCPClient, tool_registry: Any = None) -> None:
        self._client = mcp_client
        self._registry = tool_registry
        self._registered: dict[str, str] = {}

    @property
    def registered_tools(self) -> dict[str, str]:
        return dict(self._registered)

    async def register_all(self, server_name: str) -> int:
        """注册服务端所有工具。

        Args:
            server_name: MCP 服务端名称。

        Returns:
            注册的工具数量。
        """
        if self._registry is None:
            log.warning("工具注册表不可用，跳过注册")
            return 0

        tools = await self._client.list_tools(server_name)
        count = 0

        for tool in tools:
            success = await self._register_tool(server_name, tool)
            if success:
                count += 1

        log.debug("MCP 工具注册", server=server_name, registered=count, total=len(tools))
        return count

    async def register_tool(self, server_name: str, tool_name: str) -> bool:
        """注册单个工具。

        Args:
            server_name: 服务端名称。
            tool_name: 工具名称。

        Returns:
            是否注册成功。
        """
        tools = await self._client.list_tools(server_name)
        for tool in tools:
            if tool.name == tool_name:
                return await self._register_tool(server_name, tool)
        return False

    async def unregister_all(self, server_name: str) -> int:
        """注销服务端所有工具。

        Args:
            server_name: 服务端名称。

        Returns:
            注销的工具数量。
        """
        if self._registry is None:
            return 0

        count = 0
        to_remove = [
            agent_name
            for mcp_name, agent_name in self._registered.items()
            if mcp_name.startswith(f"{server_name}:")
        ]

        for agent_name in to_remove:
            try:
                if hasattr(self._registry, "unregister"):
                    self._registry.unregister(agent_name)
                count += 1
            except Exception as _exc:
                log.debug("mcp_tool_bridge 异常处理", error=str(_exc))
                log_ignored(log, "mcp_tool_bridge.unregister_server", _exc)

        for mcp_name in list(self._registered.keys()):
            if mcp_name.startswith(f"{server_name}:"):
                del self._registered[mcp_name]

        log.info("MCP 工具注销", server=server_name, count=count)
        return count

    async def _register_tool(self, server_name: str, tool: MCPTool) -> bool:
        """注册单个 MCP 工具到 Agent 工具注册表。"""
        agent_tool_name = f"{self.TOOL_PREFIX}{server_name}__{tool.name}"
        mcp_key = f"{server_name}:{tool.name}"

        try:
            description = self._build_description(tool)
            parameters = self._build_parameters(tool)

            async def _tool_handler(params: dict[str, Any]) -> dict[str, Any]:
                return await self._client.call_tool(
                    server_name=server_name,
                    tool_name=tool.name,
                    arguments=params,
                )

            _tool_handler.__name__ = agent_tool_name
            _tool_handler.__doc__ = description

            if hasattr(self._registry, "register"):
                self._registry.register(
                    name=agent_tool_name,
                    handler=_tool_handler,
                    description=description,
                    parameters=parameters,
                )
            elif hasattr(self._registry, "add_tool"):
                self._registry.add_tool(
                    name=agent_tool_name,
                    handler=_tool_handler,
                    description=description,
                    parameters=parameters,
                )

            self._registered[mcp_key] = agent_tool_name
            return True

        except Exception as e:
            log.warning("MCP 工具注册失败", server=server_name, tool=tool.name, error=str(e))
            return False

    def _build_description(self, tool: MCPTool) -> str:
        """构建 Agent 工具描述。"""
        desc = tool.description or f"MCP tool: {tool.name}"
        return f"[MCP] {desc}"

    def _build_parameters(self, tool: MCPTool) -> dict[str, Any]:
        """构建 Agent 工具参数描述。"""
        schema = tool.input_schema
        if not schema:
            return {"type": "object", "properties": {}, "required": []}

        properties = schema.get("properties", {})
        required = schema.get("required", [])

        return {
            "type": "object",
            "properties": properties,
            "required": required,
        }
