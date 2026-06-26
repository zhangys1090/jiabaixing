from __future__ import annotations

import pytest

from agent.tools.mcp_tool_bridge import (
    MCPProvider,
    MCPToolBridge,
    MCPToolInfo,
)
from agent.tools.registry import ToolCategory, ToolDefinition, ToolRegistry


class FakeMCPProvider(MCPProvider):
    def __init__(self) -> None:
        self._servers: list[str] = []
        self._tools: dict[str, list[MCPToolInfo]] = {}
        self._call_results: dict[str, dict[str, object]] = {}

    def set_servers(self, servers: list[str]) -> None:
        self._servers = servers

    async def get_running_servers(self) -> list[str]:
        return list(self._servers)

    def set_tools(self, server_name: str, tools: list[MCPToolInfo]) -> None:
        self._tools[server_name] = tools

    async def list_tools(self, server_name: str) -> list[MCPToolInfo]:
        return self._tools.get(server_name, [])

    def set_call_result(self, server_name: str, tool_name: str, result: object) -> None:
        key = f"{server_name}::{tool_name}"
        self._call_results[key] = result

    async def call_tool(self, server_name: str, tool_name: str, params: dict) -> object:
        key = f"{server_name}::{tool_name}"
        result = self._call_results.get(key)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def provider() -> FakeMCPProvider:
    return FakeMCPProvider()


@pytest.fixture
def registry() -> ToolRegistry:
    return ToolRegistry()


@pytest.fixture
def bridge(provider: FakeMCPProvider) -> MCPToolBridge:
    return MCPToolBridge(provider)


# ─── Schema conversion ───


def test_convert_empty_schema(bridge: MCPToolBridge):
    result = bridge._convert_schema(None)
    assert result == []


def test_convert_schema_with_properties(bridge: MCPToolBridge):
    schema = {
        "properties": {
            "url": {"type": "string", "description": "网页地址"},
            "timeout": {"type": "number", "description": "超时时间"},
        },
        "required": ["url"],
    }
    result = bridge._convert_schema(schema)
    assert len(result) == 2
    url_param = next(p for p in result if p.name == "url")
    assert url_param.type == "string"
    assert url_param.required is True
    timeout_param = next(p for p in result if p.name == "timeout")
    assert timeout_param.type == "number"
    assert timeout_param.required is False


def test_convert_schema_invalid_type_defaults_to_string(bridge: MCPToolBridge):
    schema = {
        "properties": {
            "data": {"type": "custom_type", "description": "数据"},
        }
    }
    result = bridge._convert_schema(schema)
    assert len(result) == 1
    assert result[0].type == "string"


# ─── Category inference ───


def test_infer_category_browser(bridge: MCPToolBridge):
    assert bridge._infer_category("browser") == ToolCategory.NETWORK


def test_infer_category_filesystem(bridge: MCPToolBridge):
    assert bridge._infer_category("filesystem") == ToolCategory.FILE


def test_infer_category_unknown(bridge: MCPToolBridge):
    assert bridge._infer_category("unknown_server") == ToolCategory.SYSTEM


# ─── Risk level inference ───


def test_infer_risk_level_filesystem(bridge: MCPToolBridge):
    assert bridge._infer_risk_level("filesystem", "read_file") == "high"


def test_infer_risk_level_delete_tool(bridge: MCPToolBridge):
    assert bridge._infer_risk_level("unknown", "delete_record") == "high"


def test_infer_risk_level_write_tool(bridge: MCPToolBridge):
    assert bridge._infer_risk_level("unknown", "write_file") == "medium"


def test_infer_risk_level_read_tool(bridge: MCPToolBridge):
    assert bridge._infer_risk_level("unknown", "read_data") == "low"


# ─── Permission inference ───


def test_infer_permissions_browser(bridge: MCPToolBridge):
    assert bridge._infer_permissions("browser", "navigate") == ["network:access"]


def test_infer_permissions_filesystem_write(bridge: MCPToolBridge):
    assert bridge._infer_permissions("filesystem", "write_file") == ["file:write"]


def test_infer_permissions_filesystem_read(bridge: MCPToolBridge):
    assert bridge._infer_permissions("filesystem", "read_file") == ["file:read"]


def test_infer_permissions_sqlite(bridge: MCPToolBridge):
    perms = bridge._infer_permissions("sqlite", "query")
    assert "memory:read" in perms
    assert "memory:write" in perms


# ─── Sync to registry ───


@pytest.mark.asyncio
async def test_sync_no_servers(bridge: MCPToolBridge, registry: ToolRegistry):
    count = await bridge.sync_to_registry(registry)
    assert count == 0
    assert registry.size() == 0


@pytest.mark.asyncio
async def test_sync_registers_tools(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    provider.set_servers(["browser"])
    provider.set_tools("browser", [
        MCPToolInfo(name="navigate", description="导航到URL", input_schema={
            "properties": {"url": {"type": "string", "description": "网址"}},
            "required": ["url"],
        }),
    ])

    count = await bridge.sync_to_registry(registry)
    assert count == 1
    assert registry.size() == 1
    assert registry.has("mcp_browser_navigate")

    definition = registry.get_definition("mcp_browser_navigate")
    assert definition is not None
    assert "[MCP/browser]" in definition.description
    assert definition.category == ToolCategory.NETWORK


@pytest.mark.asyncio
async def test_sync_skips_duplicate(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    provider.set_servers(["browser"])
    provider.set_tools("browser", [
        MCPToolInfo(name="navigate", description="导航"),
    ])

    count1 = await bridge.sync_to_registry(registry)
    assert count1 == 1

    count2 = await bridge.sync_to_registry(registry)
    assert count2 == 0


@pytest.mark.asyncio
async def test_sync_multiple_servers(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    provider.set_servers(["browser", "filesystem"])
    provider.set_tools("browser", [MCPToolInfo(name="navigate", description="导航")])
    provider.set_tools("filesystem", [MCPToolInfo(name="read_file", description="读取")])

    count = await bridge.sync_to_registry(registry)
    assert count == 2
    assert registry.has("mcp_browser_navigate")
    assert registry.has("mcp_filesystem_read_file")


@pytest.mark.asyncio
async def test_sync_handles_server_error(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    provider.set_servers(["browser"])
    provider.set_tools("browser", [])

    original_list_tools = provider.list_tools

    async def failing_list_tools(server_name: str) -> list[MCPToolInfo]:
        if server_name == "browser":
            raise RuntimeError("连接失败")
        return await original_list_tools(server_name)

    provider.list_tools = failing_list_tools

    count = await bridge.sync_to_registry(registry)
    assert count == 0


# ─── Tool execution ───


@pytest.mark.asyncio
async def test_execute_success(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    provider.set_servers(["browser"])
    provider.set_tools("browser", [
        MCPToolInfo(name="navigate", description="导航"),
    ])
    provider.set_call_result("browser", "navigate", "Page loaded successfully")

    await bridge.sync_to_registry(registry)

    result = await registry.execute("mcp_browser_navigate", {"url": "https://example.com"})
    assert result.success is True
    assert "Page loaded" in result.output


@pytest.mark.asyncio
async def test_execute_failure(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    provider.set_servers(["browser"])
    provider.set_tools("browser", [
        MCPToolInfo(name="navigate", description="导航"),
    ])
    provider.set_call_result("browser", "navigate", RuntimeError("超时"))

    await bridge.sync_to_registry(registry)

    result = await registry.execute("mcp_browser_navigate", {"url": "https://example.com"})
    assert result.success is False
    assert "超时" in (result.error or "")


# ─── Bridged tools tracking ───


@pytest.mark.asyncio
async def test_get_bridged_tools(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    provider.set_servers(["browser"])
    provider.set_tools("browser", [
        MCPToolInfo(name="navigate", description="导航"),
    ])

    await bridge.sync_to_registry(registry)

    bridged = bridge.get_bridged_tools()
    assert "mcp_browser_navigate" in bridged
    assert bridged["mcp_browser_navigate"] == "browser/navigate"


# ─── Auto sync ───


@pytest.mark.asyncio
async def test_auto_sync_starts_and_stops(
    bridge: MCPToolBridge, registry: ToolRegistry, provider: FakeMCPProvider
):
    bridge.set_sync_interval(0.1)
    provider.set_servers(["browser"])
    provider.set_tools("browser", [
        MCPToolInfo(name="navigate", description="导航"),
    ])

    bridge.start_auto_sync(registry)
    import asyncio
    await asyncio.sleep(0.2)
    bridge.stop_auto_sync()

    assert registry.has("mcp_browser_navigate")


# ─── Sync interval ───


def test_set_sync_interval(bridge: MCPToolBridge):
    bridge.set_sync_interval(30.0)
    assert bridge._sync_interval == 30.0


def test_default_sync_interval(bridge: MCPToolBridge):
    from agent.tools.mcp_tool_bridge import DEFAULT_SYNC_INTERVAL
    assert bridge._sync_interval == DEFAULT_SYNC_INTERVAL


# ─── Provider can be replaced ───


def test_set_provider(bridge: MCPToolBridge):
    new_provider = FakeMCPProvider()
    bridge.set_provider(new_provider)
    assert bridge._provider is new_provider
