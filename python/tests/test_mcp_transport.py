"""MCP 传输层测试套件.

覆盖:
- StdioMCPTransport: 启动/停止、请求/通知（子进程 JSON-RPC echo）
- HttpSseMCPTransport: SSE 状态机、endpoint 提取、多行 data 拼接、
  CRLF 处理、超时配置、send_request POST 目标
- MCPTransportFactory: 工厂创建与拒绝未知类型
- MCPServerManager 集成: transport 字段分发与 MCPProvider 接口对齐

遵循测试规范:
- 无 DB 依赖，无需数据库隔离
- 异步测试使用 pytest.mark.asyncio
- SSE 测试使用 httpx.MockTransport 模拟响应流
- stdio 测试使用真实子进程（Python echo 脚本）
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

import httpx
import pytest

from agent.mcp.server_manager import MCPServerConfig, MCPServerManager
from agent.mcp.transport import (
    BaseMCPTransport,
    HttpSseMCPTransport,
    MCPTransportConfig,
    MCPTransportFactory,
    MCPTransportType,
    StdioMCPTransport,
)


# ═══════════════════════════════════════════════════════════════
# 辅助常量与函数
# ═══════════════════════════════════════════════════════════════


# JSON-RPC echo 子进程脚本：读取一行 JSON，若含 id 则回写响应
_ECHO_SCRIPT = (
    "import sys, json\n"
    "while True:\n"
    "    line = sys.stdin.readline()\n"
    "    if not line:\n"
    "        break\n"
    "    try:\n"
    "        msg = json.loads(line)\n"
    "    except Exception:\n"
    "        continue\n"
    "    if 'id' in msg:\n"
    "        resp = {'jsonrpc': '2.0', 'id': msg['id'], 'result': {'ok': True, 'echo': msg.get('method')}}\n"
    "        sys.stdout.write(json.dumps(resp) + chr(10))\n"
    "        sys.stdout.flush()\n"
)


def _make_echo_config() -> MCPTransportConfig:
    """构造一个使用 Python echo 子进程的 stdio 传输配置.

    Returns:
        MCPTransportConfig: 指向内嵌 echo 脚本的配置.
    """
    return MCPTransportConfig(command=sys.executable, args=["-c", _ECHO_SCRIPT])


# ═══════════════════════════════════════════════════════════════
# StdioMCPTransport 测试
# ═══════════════════════════════════════════════════════════════


class TestStdioMCPTransport:
    """Stdio 传输层测试（使用真实子进程）."""

    @pytest.mark.asyncio
    async def test_stdio_transport_start_stop(self) -> None:
        """测试 Stdio 传输层启动和停止.

        启动后进程应存在，停止后进程应被终止且 is_running 为 False。
        """
        config = MCPTransportConfig(
            command=sys.executable, args=["-c", "import time; time.sleep(60)"]
        )
        transport = StdioMCPTransport(config)

        await transport.start()
        assert transport.is_running is True

        await transport.stop()
        assert transport.is_running is False

    @pytest.mark.asyncio
    async def test_stdio_send_request(self) -> None:
        """测试 Stdio 发送请求并接收 JSON-RPC 响应.

        echo 子进程应回写 {"result": {"ok": true, "echo": "test/method"}}。
        """
        transport = StdioMCPTransport(_make_echo_config())
        await transport.start()
        try:
            result = await transport.send_request("test/method", {"foo": "bar"})
            assert result["jsonrpc"] == "2.0"
            assert result["result"]["ok"] is True
            assert result["result"]["echo"] == "test/method"
        finally:
            await transport.stop()

    @pytest.mark.asyncio
    async def test_stdio_send_notification(self) -> None:
        """测试 Stdio 发送通知（无 id，不等待响应）.

        通知写入后不应抛出异常，且不阻塞。
        """
        transport = StdioMCPTransport(_make_echo_config())
        await transport.start()
        try:
            # 通知不应抛出异常
            transport.send_notification("test/notification", {"hello": "world"})

            # 确保通知写入后仍能正常发送请求（管道未损坏）
            result = await transport.send_request("ping", {})
            assert result["result"]["ok"] is True
        finally:
            await transport.stop()


# ═══════════════════════════════════════════════════════════════
# HttpSseMCPTransport 测试
# ═══════════════════════════════════════════════════════════════


class TestHttpSseMCPTransport:
    """HTTP/SSE 传输层测试（使用 httpx.MockTransport 与状态机单元测试）."""

    def test_http_sse_parses_endpoint_event(self) -> None:
        """测试从 endpoint 事件提取 SSE POST 端点.

        修正 TS 侧 bug: sseEndpoint 提取后未使用。
        Python 侧应将 endpoint 事件的数据存入 _sse_endpoint。
        """
        transport = HttpSseMCPTransport(
            MCPTransportConfig(url="http://server/sse")
        )

        transport._parse_sse_line("event: endpoint")
        transport._parse_sse_line("data: /messages?session=abc123")
        transport._parse_sse_line("")  # 空行触发事件分发

        assert transport._sse_endpoint == "http://server/messages?session=abc123"

    def test_http_sse_concatenates_multiline_data(self) -> None:
        """测试多行 data 字段用 \\n 拼接后再解析.

        修正 TS 侧 bug: 每行独立 JSON.parse 导致多行 data 截断。
        SSE 规范要求多行 data 用 \\n 拼接成完整字符串后再解析。
        测试数据设计为 JSON 在 token 边界换行（非字符串内部），确保
        拼接后仍是合法 JSON。
        """
        transport = HttpSseMCPTransport(
            MCPTransportConfig(url="http://server/sse")
        )

        # 预注册一个 pending future，id=1
        loop = asyncio.new_event_loop()
        try:
            future: asyncio.Future[dict] = loop.create_future()
            transport._pending[1] = future

            # JSON 在对象字段边界换行（\n 在 token 之间是合法 JSON 空白）
            transport._parse_sse_line("event: message")
            transport._parse_sse_line('data: {"jsonrpc":"2.0","id":1,"result":{')
            transport._parse_sse_line('data: "part":"hello"}}')
            transport._parse_sse_line("")  # 空行触发分发

            assert future.done()
            msg = future.result()
            assert msg["id"] == 1
            assert msg["result"]["part"] == "hello"
        finally:
            loop.close()

    def test_http_sse_state_machine_transitions(self) -> None:
        """测试 SSE 状态机在 event:/data:/空行 之间正确转移.

        - event: 行设置当前事件类型
        - data: 行追加到数据缓冲
        - 空行分发事件并重置状态
        """
        transport = HttpSseMCPTransport(
            MCPTransportConfig(url="http://server/sse")
        )

        # 初始状态
        assert transport._event_type == ""
        assert transport._data_lines == []

        # event: 行
        transport._parse_sse_line("event: message")
        assert transport._event_type == "message"

        # data: 行
        transport._parse_sse_line("data: hello")
        assert transport._data_lines == ["hello"]

        # 第二个 data: 行（追加）
        transport._parse_sse_line("data: world")
        assert transport._data_lines == ["hello", "world"]

        # 空行：分发并重置
        transport._parse_sse_line("")
        assert transport._event_type == ""
        assert transport._data_lines == []

    @pytest.mark.asyncio
    async def test_http_sse_send_request_to_endpoint(self) -> None:
        """测试 send_request POST 到 sse_endpoint 而非 config.url.

        修正 TS 侧 bug: sseEndpoint 提取后从未使用，POST 错误 URL。
        Python 侧应 POST 到从 endpoint 事件提取的 sse_endpoint。
        """
        posted_urls: list[str] = []
        transport = HttpSseMCPTransport(
            MCPTransportConfig(url="http://server/sse")
        )

        def handler(request: httpx.Request) -> httpx.Response:
            posted_urls.append(str(request.url))
            # 解析 POST body 获取 id，模拟 SSE 推送响应
            body = json.loads(request.content)
            msg_id = body.get("id")

            async def deliver_sse_response() -> None:
                await asyncio.sleep(0.02)
                sse_data = json.dumps({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {"ok": True},
                })
                transport._feed_raw(f"event: message\ndata: {sse_data}\n\n")

            asyncio.create_task(deliver_sse_response())
            return httpx.Response(202)

        mock_http = httpx.MockTransport(handler)
        transport._client = httpx.AsyncClient(transport=mock_http)
        transport._sse_endpoint = "http://server/mcp/messages?session=xyz"

        try:
            result = await transport.send_request("tools/list", {})

            assert result["result"]["ok"] is True
            assert len(posted_urls) == 1
            # POST 必须发往 sse_endpoint，而非 config.url(/sse)
            assert "/mcp/messages" in posted_urls[0]
            assert posted_urls[0].endswith("session=xyz")
            # 不应 POST 到 /sse
            assert posted_urls[0].count("/sse") == 0
        finally:
            await transport._client.aclose()

    def test_http_sse_handles_crlf_line_endings(self) -> None:
        """测试 \\r\\n 行尾正确处理.

        修正 TS 侧 bug: split('\\n') 后 \\r 残留。
        Python 侧应在解析每行前去除尾部 \\r。
        """
        transport = HttpSseMCPTransport(
            MCPTransportConfig(url="http://server/sse")
        )

        received: list[dict] = []
        transport.on_notification("test/event", lambda params: received.append(params))

        # 原始带 \r\n 的 SSE 数据
        raw = (
            "event: message\r\n"
            'data: {"jsonrpc":"2.0","method":"test/event","params":{"ok":true}}\r\n'
            "\r\n"
        )
        transport._feed_raw(raw)

        assert len(received) == 1
        assert received[0]["ok"] is True

    @pytest.mark.asyncio
    async def test_http_sse_timeout_config(self) -> None:
        """测试 httpx 超时配置: read=None 避免误杀 SSE 长连接.

        修正 TS 侧 bug: HTTP POST 超时双重设置冲突。
        Python 侧应使用 httpx.Timeout(read=None, write=30.0)。
        """
        transport = HttpSseMCPTransport(
            MCPTransportConfig(url="http://server/sse", timeout=30.0)
        )
        await transport._ensure_client()
        try:
            timeout = transport._client.timeout
            # read=None 避免 SSE 长连接被误杀
            assert timeout.read is None
            # write 超时使用配置值
            assert timeout.write == 30.0
        finally:
            await transport._client.aclose()


# ═══════════════════════════════════════════════════════════════
# MCPTransportFactory 测试
# ═══════════════════════════════════════════════════════════════


class TestMCPTransportFactory:
    """传输层工厂测试."""

    def test_factory_creates_stdio(self) -> None:
        """测试工厂创建 StdioMCPTransport."""
        config = MCPTransportConfig(command="echo", args=["hello"])
        transport = MCPTransportFactory.create(config, MCPTransportType.STDIO)
        assert isinstance(transport, StdioMCPTransport)
        assert isinstance(transport, BaseMCPTransport)

    def test_factory_creates_http_sse(self) -> None:
        """测试工厂创建 HttpSseMCPTransport."""
        config = MCPTransportConfig(url="http://server/sse")
        transport = MCPTransportFactory.create(config, MCPTransportType.HTTP_SSE)
        assert isinstance(transport, HttpSseMCPTransport)
        assert isinstance(transport, BaseMCPTransport)

    def test_factory_rejects_unknown_type(self) -> None:
        """测试工厂拒绝未知传输类型并抛出 ValueError."""
        config = MCPTransportConfig()
        with pytest.raises(ValueError, match="未知"):
            MCPTransportFactory.create(config, "unknown-transport")


# ═══════════════════════════════════════════════════════════════
# MCPServerManager 集成测试
# ═══════════════════════════════════════════════════════════════


class TestMCPServerManagerTransportIntegration:
    """MCPServerManager 传输层集成测试."""

    def setup_method(self) -> None:
        """每个测试前重置单例."""
        MCPServerManager.reset_instance()

    def test_server_manager_dispatches_by_transport(self) -> None:
        """测试 MCPServerManager 按 transport 字段分发到正确的传输类型.

        - transport="stdio" → MCPTransportType.STDIO
        - transport="http+sse" → MCPTransportType.HTTP_SSE
        - 默认（未指定）→ STDIO
        """
        manager = MCPServerManager()

        manager.register_server(MCPServerConfig(
            name="stdio-srv",
            command="echo",
            args=[],
            transport="stdio",
        ))
        manager.register_server(MCPServerConfig(
            name="sse-srv",
            command="",
            url="http://server/sse",
            headers={"Authorization": "Bearer token123"},
            transport="http+sse",
        ))
        manager.register_server(MCPServerConfig(
            name="default-srv",
            command="echo",
            args=[],
        ))

        # 验证配置字段存储
        stdio_cfg = manager.get_server_config("stdio-srv")
        assert stdio_cfg.transport == "stdio"

        sse_cfg = manager.get_server_config("sse-srv")
        assert sse_cfg.transport == "http+sse"
        assert sse_cfg.url == "http://server/sse"
        assert sse_cfg.headers == {"Authorization": "Bearer token123"}

        # 验证传输类型解析
        assert manager._resolve_transport_type(stdio_cfg) == MCPTransportType.STDIO
        assert manager._resolve_transport_type(sse_cfg) == MCPTransportType.HTTP_SSE

        # 默认（未指定 transport）应为 STDIO
        default_cfg = manager.get_server_config("default-srv")
        assert manager._resolve_transport_type(default_cfg) == MCPTransportType.STDIO

    @pytest.mark.asyncio
    async def test_server_manager_send_request_interface(self) -> None:
        """测试 MCPServerManager 实现 MCPProvider.send_request 接口.

        修正接口断层: _send_jsonrpc 委托 provider.send_request，
        而 MCPServerManager 此前缺少 send_request 方法。
        """
        manager = MCPServerManager()

        # 未运行的服务器应抛出 RuntimeError
        with pytest.raises(RuntimeError, match="未运行"):
            await manager.send_request("nonexistent", "resources/list", {})

    def test_config_loads_transport_fields_from_file(self) -> None:
        """测试 _load_config_from_file 读取 transport/url/headers 字段.

        修正: 当前 _load_config_from_file 未读取这些新字段。
        测试需在创建 manager 之后写入测试文件，避免 _initialize_default_servers
        中的 register_server 覆盖测试配置。
        """
        import os
        import tempfile

        from agent.mcp import server_manager as sm_module

        original_path = sm_module.MCP_CONFIG_PATH
        try:
            tmpdir = tempfile.mkdtemp(prefix="jbx_mcp_test_")
            cfg_path = os.path.join(tmpdir, "mcp-servers.json")

            # 先创建 manager（会写入原始 MCP_CONFIG_PATH）
            manager = MCPServerManager()

            # 切换到测试路径并写入测试配置
            sm_module.MCP_CONFIG_PATH = cfg_path
            config_data = [
                {
                    "name": "remote-sse",
                    "command": "",
                    "url": "http://remote:8080/sse",
                    "transport": "http+sse",
                    "headers": {"X-Api-Key": "secret"},
                    "enabled": True,
                    "autoStart": False,
                }
            ]
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(config_data, f)

            manager._load_config_from_file()

            cfg = manager.get_server_config("remote-sse")
            assert cfg is not None
            assert cfg.transport == "http+sse"
            assert cfg.url == "http://remote:8080/sse"
            assert cfg.headers == {"X-Api-Key": "secret"}
        finally:
            sm_module.MCP_CONFIG_PATH = original_path
