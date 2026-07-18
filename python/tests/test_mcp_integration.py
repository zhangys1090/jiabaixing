"""MCP 模块集成测试 — 验证两大集成断层修复.

覆盖：
1. MCPToolBridge 持有 MCPServerManager（而非 ToolRegistry）— 断层 2 修复
2. http+sse 配置触发 transport 而非 subprocess — 断层 1 修复
3. HTTP 端点 /v1/mcp/servers/{name}/resources 返回 200 — 断层 2 修复
4. HTTP 端点 /v1/mcp/servers/{name}/prompts 返回 200 — 断层 2 修复

测试策略：
- 单元级：直接构造 MCPServerManager/MCPToolBridge 验证类型与分发逻辑
- 端点级：通过 httpx ASGITransport + unittest.mock.patch 模拟 engine 与 bridge
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from agent.mcp.server_manager import MCPServerConfig, MCPServerManager
from agent.mcp.transport import (
    BaseMCPTransport,
    MCPTransportConfig,
    MCPTransportType,
)
from agent.tools.mcp_tool_bridge import MCPToolBridge
from agent.tools.registry import ToolRegistry


# ═══════════════════════════════════════════════════════════════
# 断层 2 修复验证：MCPToolBridge 持有 MCPServerManager
# ═══════════════════════════════════════════════════════════════


class TestMCPToolBridgeUsesServerManager:
    """验证 MCPToolBridge 接受 MCPServerManager 作为 provider."""

    def setup_method(self) -> None:
        """每个测试前重置 MCPServerManager 单例，避免状态残留."""
        MCPServerManager.reset_instance()

    def test_mcp_tool_bridge_uses_server_manager(self) -> None:
        """MCPToolBridge 应能持有 MCPServerManager 而非 ToolRegistry.

        断层 2 修复前：engine.py 中 MCPToolBridge(self.tool_registry)
        将 ToolRegistry 误传为 provider，导致 sync_to_registry 调用
        ToolRegistry.get_running_servers（不存在该方法）。

        修复后：MCPToolBridge(provider=mcp_manager) 正确传入 MCPProvider 实现。
        """
        manager = MCPServerManager.get_instance()
        bridge = MCPToolBridge(provider=manager)

        # 验证 provider 是 MCPServerManager 实例
        assert isinstance(bridge._provider, MCPServerManager)
        # 验证 provider 不是 ToolRegistry 实例
        assert not isinstance(bridge._provider, ToolRegistry)

    def test_mcp_tool_bridge_sync_with_dict_tools(self) -> None:
        """MCPToolBridge.sync_to_registry 应兼容 MCPServerManager 的 dict 工具.

        MCPServerManager.list_tools 返回 list[dict]（原始 JSON-RPC 响应），
        MCPToolBridge 需通过 dict 取值方式访问 name/description/inputSchema。
        """
        manager = MCPServerManager()
        bridge = MCPToolBridge(provider=manager)
        registry = ToolRegistry()

        # 模拟 get_running_servers 返回一个服务器
        manager.get_running_servers = lambda: ["mock-server"]  # type: ignore
        # 模拟 list_tools 返回 dict 形式工具
        manager.list_tools = AsyncMock(return_value=[
            {
                "name": "search",
                "description": "搜索工具",
                "inputSchema": {
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            }
        ])  # type: ignore

        synced = asyncio.run(bridge.sync_to_registry(registry))

        assert synced == 1
        assert registry.has("mcp_mock-server_search")
        definition = registry.get_definition("mcp_mock-server_search")
        assert definition is not None
        assert "搜索工具" in definition.description
        assert "[MCP/mock-server]" in definition.description

    def test_mcp_tool_bridge_await_or_call_handles_sync(self) -> None:
        """_await_or_call 应正确处理同步方法（MCPServerManager.get_running_servers）."""
        manager = MCPServerManager()
        manager.get_running_servers = lambda: ["srv1", "srv2"]  # type: ignore

        result = asyncio.run(MCPToolBridge._await_or_call(manager.get_running_servers))
        assert result == ["srv1", "srv2"]

    def test_mcp_tool_bridge_await_or_call_handles_async(self) -> None:
        """_await_or_call 应正确处理异步方法（如 MCPProvider 协议定义的 async 方法）."""

        async def async_get() -> list[str]:
            return ["async-srv"]

        result = asyncio.run(MCPToolBridge._await_or_call(async_get))
        assert result == ["async-srv"]


# ═══════════════════════════════════════════════════════════════
# 断层 1 修复验证：HTTP/SSE 传输分发
# ═══════════════════════════════════════════════════════════════


class TestHttpSseTransportDispatched:
    """验证 http+sse 配置触发 transport 而非 subprocess."""

    def setup_method(self) -> None:
        MCPServerManager.reset_instance()

    @pytest.mark.asyncio
    async def test_http_sse_transport_dispatched(self) -> None:
        """http+sse 配置应通过 MCPTransportFactory 创建 transport，不启动子进程.

        断层 1 修复前：start_server 无 transport 分支判断，所有服务器
        都走 stdio 子进程路径，导致 MCPTransportFactory.create() 零调用。

        修复后：http+sse 配置触发 _start_http_sse_server，创建并启动
        HttpSseMCPTransport 实例，存入 _transports 字典。
        """
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="sse-server",
            command="",
            url="http://mcp-server.example/sse",
            transport="http+sse",
            headers={"Authorization": "Bearer test-token"},
        ))

        # 用 Mock 替换工厂创建方法，避免真实 HTTP 连接
        mock_transport = MagicMock(spec=BaseMCPTransport)
        mock_transport.start = AsyncMock()
        mock_transport.stop = AsyncMock()
        mock_transport.send_request = AsyncMock(return_value={
            "jsonrpc": "2.0",
            "result": {"ok": True},
        })
        mock_transport.send_notification = MagicMock()

        with patch(
            "agent.mcp.server_manager.MCPTransportFactory.create",
            return_value=mock_transport,
        ) as mock_create:
            success = await manager.start_server("sse-server")

        # 验证启动成功
        assert success is True
        # 验证工厂被调用，且传入了 HTTP_SSE 类型
        mock_create.assert_called_once()
        call_args = mock_create.call_args
        transport_config = call_args.args[0]
        transport_type = call_args.args[1]
        assert transport_type == MCPTransportType.HTTP_SSE
        assert isinstance(transport_config, MCPTransportConfig)
        assert transport_config.url == "http://mcp-server.example/sse"
        assert transport_config.headers == {"Authorization": "Bearer test-token"}

        # 验证 transport 已启动并存入 _transports
        mock_transport.start.assert_awaited_once()
        assert "sse-server" in manager._transports
        assert manager._transports["sse-server"] is mock_transport

        # 验证未启动子进程（_processes 应为空）
        assert "sse-server" not in manager._processes
        assert len(manager._processes) == 0

        # 验证 get_running_servers 包含 transport 服务器
        assert "sse-server" in manager.get_running_servers()

    @pytest.mark.asyncio
    async def test_http_sse_send_message_delegates_to_transport(self) -> None:
        """send_message 对 http+sse 服务器应委托给 transport.send_request."""
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="sse-srv",
            command="",
            url="http://mcp.example/sse",
            transport="http+sse",
        ))

        mock_transport = MagicMock(spec=BaseMCPTransport)
        mock_transport.start = AsyncMock()
        mock_transport.stop = AsyncMock()
        mock_transport.send_request = AsyncMock(return_value={
            "jsonrpc": "2.0",
            "result": {"tools": []},
        })
        mock_transport.send_notification = MagicMock()

        with patch(
            "agent.mcp.server_manager.MCPTransportFactory.create",
            return_value=mock_transport,
        ):
            await manager.start_server("sse-srv")

        # 发送请求应委托给 transport.send_request（包含 id 字段才被识别为请求）
        response = await manager.send_message("sse-srv", {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {},
        })

        mock_transport.send_request.assert_awaited_once_with("tools/list", {})
        assert response["result"]["tools"] == []

    @pytest.mark.asyncio
    async def test_http_sse_notification_delegates_to_transport(self) -> None:
        """通知（无 id）应通过 transport.send_notification 发送."""
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="sse-notif",
            command="",
            url="http://mcp.example/sse",
            transport="http+sse",
        ))

        mock_transport = MagicMock(spec=BaseMCPTransport)
        mock_transport.start = AsyncMock()
        mock_transport.stop = AsyncMock()
        mock_transport.send_request = AsyncMock()
        mock_transport.send_notification = MagicMock()

        with patch(
            "agent.mcp.server_manager.MCPTransportFactory.create",
            return_value=mock_transport,
        ):
            await manager.start_server("sse-notif")

        # 发送通知
        response = await manager.send_message("sse-notif", {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })

        # 通知不应调用 send_request，应调用 send_notification
        mock_transport.send_request.assert_not_awaited()
        mock_transport.send_notification.assert_called_once_with(
            "notifications/initialized", None
        )
        assert response == {"jsonrpc": "2.0", "result": None}

    @pytest.mark.asyncio
    async def test_http_sse_stop_server_stops_transport(self) -> None:
        """stop_server 对 http+sse 服务器应停止并移除 transport."""
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="sse-stop",
            command="",
            url="http://mcp.example/sse",
            transport="http+sse",
        ))

        mock_transport = MagicMock(spec=BaseMCPTransport)
        mock_transport.start = AsyncMock()
        mock_transport.stop = AsyncMock()
        mock_transport.send_request = AsyncMock()
        mock_transport.send_notification = MagicMock()

        with patch(
            "agent.mcp.server_manager.MCPTransportFactory.create",
            return_value=mock_transport,
        ):
            await manager.start_server("sse-stop")
            assert "sse-stop" in manager._transports

            result = manager.stop_server("sse-stop")

        assert result is True
        assert "sse-stop" not in manager._transports


# ═══════════════════════════════════════════════════════════════
# 断层 2 修复验证：HTTP 端点暴露 resources/prompts
# ═══════════════════════════════════════════════════════════════


class TestMCPEndpoints:
    """验证 /v1/mcp/* HTTP 端点正常返回."""

    def setup_method(self) -> None:
        MCPServerManager.reset_instance()

    @pytest.fixture
    async def client(self):
        """构造 ASGI 测试客户端.

        通过 httpx.ASGITransport 直接挂载 FastAPI app，无需启动真实服务器。
        """
        from agent.main import app
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.fixture
    def mock_engine_with_bridge(self):
        """构造 mock engine，其 mcp_tool_bridge 返回预设的 resources/prompts.

        通过 patch agent.main.engine 注入 mock，使 _get_bridge() 返回 mock bridge。
        """
        mock_bridge = MagicMock(spec=MCPToolBridge)
        mock_bridge.list_resources = AsyncMock(return_value=[
            {"uri": "file:///docs/readme.md", "name": "readme", "mimeType": "text/markdown"},
        ])
        mock_bridge.read_resource = AsyncMock(return_value={
            "contents": [{"uri": "file:///docs/readme.md", "text": "# Hello"}]
        })
        mock_bridge.list_prompts = AsyncMock(return_value=[
            {"name": "code_review", "description": "代码审查"},
        ])
        mock_bridge.get_prompt = AsyncMock(return_value={
            "messages": [{"role": "user", "content": {"type": "text", "text": "审查代码"}}]
        })

        mock_engine = MagicMock()
        mock_engine.mcp_tool_bridge = mock_bridge

        with patch("agent.main.engine", mock_engine):
            yield mock_bridge

    @pytest.mark.asyncio
    async def test_mcp_servers_endpoint(
        self, client: AsyncClient
    ) -> None:
        """GET /v1/mcp/servers 应返回 200 与服务器列表."""
        resp = await client.get("/v1/mcp/servers")
        assert resp.status_code == 200
        data = resp.json()
        assert "servers" in data
        assert "total" in data
        assert isinstance(data["servers"], list)
        # 默认注册了 filesystem/sqlite/browser/cron
        names = [s["name"] for s in data["servers"]]
        assert "filesystem" in names

    @pytest.mark.asyncio
    async def test_mcp_resources_endpoint(
        self, client: AsyncClient, mock_engine_with_bridge
    ) -> None:
        """GET /v1/mcp/servers/{name}/resources 应返回 200 与资源列表.

        断层 2 修复前：无 HTTP 端点暴露 resources/prompts，list_resources
        从未被生产代码调用。

        修复后：/v1/mcp/servers/{name}/resources 端点委托 MCPToolBridge.list_resources。
        """
        resp = await client.get("/v1/mcp/servers/filesystem/resources")
        assert resp.status_code == 200
        data = resp.json()
        assert "resources" in data
        assert data["server"] == "filesystem"
        assert len(data["resources"]) == 1
        assert data["resources"][0]["uri"] == "file:///docs/readme.md"
        # 验证 bridge.list_resources 被调用
        mock_engine_with_bridge.list_resources.assert_awaited_once_with("filesystem")

    @pytest.mark.asyncio
    async def test_mcp_read_resource_endpoint(
        self, client: AsyncClient, mock_engine_with_bridge
    ) -> None:
        """POST /v1/mcp/servers/{name}/resources/read 应返回 200 与资源内容."""
        resp = await client.post(
            "/v1/mcp/servers/filesystem/resources/read",
            json={"uri": "file:///docs/readme.md"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "contents" in data
        assert data["server"] == "filesystem"
        assert data["uri"] == "file:///docs/readme.md"
        assert len(data["contents"]) == 1
        mock_engine_with_bridge.read_resource.assert_awaited_once_with(
            "filesystem", "file:///docs/readme.md"
        )

    @pytest.mark.asyncio
    async def test_mcp_prompts_endpoint(
        self, client: AsyncClient, mock_engine_with_bridge
    ) -> None:
        """GET /v1/mcp/servers/{name}/prompts 应返回 200 与提示列表.

        断层 2 修复前：无 HTTP 端点暴露 prompts，list_prompts 从未被生产代码调用。

        修复后：/v1/mcp/servers/{name}/prompts 端点委托 MCPToolBridge.list_prompts。
        使用默认注册的 filesystem 服务器，避免 404。
        """
        resp = await client.get("/v1/mcp/servers/filesystem/prompts")
        assert resp.status_code == 200
        data = resp.json()
        assert "prompts" in data
        assert data["server"] == "filesystem"
        assert len(data["prompts"]) == 1
        assert data["prompts"][0]["name"] == "code_review"
        mock_engine_with_bridge.list_prompts.assert_awaited_once_with("filesystem")

    @pytest.mark.asyncio
    async def test_mcp_get_prompt_endpoint(
        self, client: AsyncClient, mock_engine_with_bridge
    ) -> None:
        """POST /v1/mcp/servers/{name}/prompts/get 应返回 200 与提示内容.

        使用默认注册的 filesystem 服务器，避免 404。
        """
        resp = await client.post(
            "/v1/mcp/servers/filesystem/prompts/get",
            json={"name": "code_review", "arguments": {"code": "print('hi')"}},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "messages" in data
        assert data["server"] == "filesystem"
        assert data["prompt_name"] == "code_review"
        assert len(data["messages"]) == 1
        mock_engine_with_bridge.get_prompt.assert_awaited_once_with(
            "filesystem", "code_review", {"code": "print('hi')"}
        )

    @pytest.mark.asyncio
    async def test_mcp_server_not_found_returns_404(
        self, client: AsyncClient, mock_engine_with_bridge
    ) -> None:
        """不存在的服务器应返回 404."""
        resp = await client.get("/v1/mcp/servers/nonexistent/resources")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_mcp_bridge_unavailable_returns_503(
        self, client: AsyncClient
    ) -> None:
        """engine 或 bridge 不可用时应返回 503."""
        # 不使用 mock_engine_with_bridge fixture，engine 为 None
        with patch("agent.main.engine", None):
            resp = await client.get("/v1/mcp/servers/filesystem/resources")
            assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_mcp_start_server_endpoint(
        self, client: AsyncClient
    ) -> None:
        """POST /v1/mcp/servers/{name}/start 应返回 200（不实际启动 stdio 服务器）.

        使用一个禁用的服务器，验证端点正确响应。
        """
        resp = await client.post("/v1/mcp/servers/sqlite/start")
        assert resp.status_code == 200
        data = resp.json()
        assert "success" in data
        assert data["name"] == "sqlite"
