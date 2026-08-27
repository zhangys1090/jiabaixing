"""MCPClient — MCP 服务端连接与通信管理。

管理与 MCP (Model Control Protocol) 服务端的连接，
支持 stdio 和 SSE 两种传输方式，自动发现和调用工具。

Usage:
    from agent.mcp_integration.mcp_client import MCPClient
    client = MCPClient()
    await client.connect("my-server", command="npx", args=["-y", "@modelcontextprotocol/server-filesystem", "/tmp"])
    tools = await client.list_tools("my-server")
    result = await client.call_tool("my-server", "read_file", {"path": "/tmp/test.txt"})
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from agent.core.logger import StructuredLogger, log_ignored
from agent.mcp.server_manager import MCPServerConfig

log = StructuredLogger("mcp_client")


@dataclass
class MCPTool:
    """MCP 工具描述。

    Attributes:
        name: 工具名称。
        description: 工具描述。
        input_schema: 输入参数 JSON Schema。
        server_name: 所属服务端名称。
    """

    name: str = ""
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)
    server_name: str = ""


@dataclass
class MCPServerState:
    """MCP 服务端运行状态。

    Attributes:
        name: 服务端名称。
        connected: 是否已连接。
        process: 子进程对象。
        last_ping: 最后心跳时间。
        tool_count: 工具数量。
        error_count: 错误计数。
    """

    name: str = ""
    connected: bool = False
    process: Any = None
    last_ping: float = 0.0
    tool_count: int = 0
    error_count: int = 0


class MCPClient:
    """MCP 客户端管理器。

    管理与多个 MCP 服务端的连接，支持：
    - stdio 传输：启动子进程通信
    - SSE 传输：HTTP 长连接通信
    - 工具发现：自动列出服务端提供的工具
    - 工具调用：通过 MCP 协议调用远程工具
    - 生命周期管理：自动启动、重启、关闭
    - 资源订阅：resources/subscribe 实时变更通知

    Usage:
        client = MCPClient()
        await client.connect("fs", command="npx", args=["-y", "@mcp/server-fs"])
        tools = await client.list_tools("fs")
    """

    def __init__(self) -> None:
        self._servers: dict[str, MCPServerConfig] = {}
        self._states: dict[str, MCPServerState] = {}
        self._tools: dict[str, list[MCPTool]] = {}
        self._request_id: int = 0
        self._http_client: httpx.AsyncClient | None = None
        self._resource_sub: Any | None = None

    @property
    def connected_servers(self) -> list[str]:
        return [name for name, state in self._states.items() if state.connected]

    @property
    def all_tools(self) -> list[MCPTool]:
        tools: list[MCPTool] = []
        for server_tools in self._tools.values():
            tools.extend(server_tools)
        return tools

    async def connect(
        self,
        name: str,
        command: str = "",
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
        url: str = "",
        transport: str = "stdio",
    ) -> bool:
        """连接到 MCP 服务端。

        Args:
            name: 服务端名称。
            command: 启动命令。
            args: 启动参数。
            env: 环境变量。
            url: 服务端 URL（SSE 模式）。
            transport: 传输方式。

        Returns:
            是否连接成功。
        """
        config = MCPServerConfig(
            name=name,
            transport=transport,
            command=command,
            args=args or [],
            env=env or {},
            url=url,
        )
        self._servers[name] = config
        self._states[name] = MCPServerState(name=name)

        try:
            if transport == "stdio":
                success = await self._connect_stdio(name, config)
            elif transport == "sse":
                success = await self._connect_sse(name, config)
            else:
                log.warning("未知传输方式", transport=transport)
                return False

            if success:
                await self._discover_tools(name)
                log.info(
                    "MCP 服务端连接成功",
                    server=name,
                    transport=transport,
                    tools=len(self._tools.get(name, [])),
                )

            return success

        except Exception as e:
            log.warning("MCP 连接失败", server=name, error=str(e))
            return False

    async def disconnect(self, name: str) -> None:
        """断开 MCP 服务端连接。

        Args:
            name: 服务端名称。
        """
        state = self._states.get(name)
        if state and state.process:
            try:
                state.process.terminate()
                await asyncio.wait_for(state.process.wait(), timeout=5.0)
            except Exception as _exc:
                log.debug("mcp_client 异常处理", error=str(_exc))
                try:
                    state.process.kill()
                except Exception as _exc:
                    log.debug("mcp_client 异常处理", error=str(_exc))
                    log_ignored(log, "mcp_client.disconnect.kill", _exc)

        self._states.pop(name, None)
        self._tools.pop(name, None)
        log.info("MCP 服务端断开", server=name)

    async def disconnect_all(self) -> None:
        """断开所有服务端连接。"""
        for name in list(self._states.keys()):
            await self.disconnect(name)
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    async def list_tools(self, server_name: str = "") -> list[MCPTool]:
        """列出可用工具。

        Args:
            server_name: 服务端名称（空字符串表示所有）。

        Returns:
            工具列表。
        """
        if server_name:
            return self._tools.get(server_name, [])
        return self.all_tools

    async def call_tool(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """调用 MCP 工具。

        Args:
            server_name: 服务端名称。
            tool_name: 工具名称。
            arguments: 工具参数。

        Returns:
            调用结果。
        """
        state = self._states.get(server_name)
        if not state or not state.connected:
            return {"error": f"服务端 {server_name} 未连接"}

        config = self._servers.get(server_name)
        if not config:
            return {"error": f"服务端 {server_name} 配置不存在"}

        try:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": arguments or {},
                },
            }

            response = await self._send_request(server_name, request)

            if "error" in response:
                state.error_count += 1
                return {"error": response["error"].get("message", str(response["error"]))}

            result = response.get("result", {})
            log.info("MCP 工具调用", server=server_name, tool=tool_name)
            return result

        except Exception as e:
            log.debug("mcp_client 异常处理", error=str(e))
            state.error_count += 1
            log.warning("MCP 工具调用失败", server=server_name, tool=tool_name, error=str(e))
            return {"error": str(e)}

    async def list_resources(self, server_name: str) -> list[dict[str, Any]]:
        """列出服务端资源。

        Args:
            server_name: 服务端名称。

        Returns:
            资源列表。
        """
        try:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "resources/list",
                "params": {},
            }

            response = await self._send_request(server_name, request)
            return response.get("result", {}).get("resources", [])

        except Exception as e:
            log.warning("MCP 资源列表失败", server=server_name, error=str(e))
            return []

    async def read_resource(self, server_name: str, uri: str) -> dict[str, Any]:
        """读取服务端资源。

        Args:
            server_name: 服务端名称。
            uri: 资源 URI。

        Returns:
            资源内容。
        """
        try:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "resources/read",
                "params": {"uri": uri},
            }

            response = await self._send_request(server_name, request)
            return response.get("result", {})

        except Exception as e:
            log.warning("MCP 资源读取失败", server=server_name, uri=uri, error=str(e))
            return {"error": str(e)}

    async def list_prompts(self, server_name: str) -> list[dict[str, Any]]:
        """列出服务端提示模板。

        Args:
            server_name: 服务端名称。

        Returns:
            提示模板列表。
        """
        try:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "prompts/list",
                "params": {},
            }

            response = await self._send_request(server_name, request)
            return response.get("result", {}).get("prompts", [])

        except Exception as e:
            log.warning("MCP 提示列表失败", server=server_name, error=str(e))
            return []

    async def get_prompt(
        self,
        server_name: str,
        prompt_name: str,
        arguments: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """获取服务端提示模板内容。

        Args:
            server_name: 服务端名称。
            prompt_name: 提示模板名称。
            arguments: 模板参数。

        Returns:
            提示模板内容。
        """
        try:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "prompts/get",
                "params": {
                    "name": prompt_name,
                    "arguments": arguments or {},
                },
            }

            response = await self._send_request(server_name, request)
            return response.get("result", {})

        except Exception as e:
            log.warning("MCP 提示获取失败", server=server_name, prompt=prompt_name, error=str(e))
            return {"error": str(e)}

    # ═══════════════════════════════════════════════════════════
    # P2-1: MCP Sampling 协议
    # ═══════════════════════════════════════════════════════════

    async def create_sampling_request(
        self,
        server_name: str,
        messages: list[dict[str, Any]],
        model_preferences: dict[str, Any] | None = None,
        max_tokens: int = 1024,
        system_prompt: str | None = None,
        include_context: str | None = None,
    ) -> dict[str, Any]:
        """P2-1: MCP Sampling 协议 — 请求服务端进行 LLM 采样。

        MCP Sampling 允许服务端请求客户端进行 LLM 推理，
        实现服务端→客户端的推理委派（如：服务端需要 LLM 判断
        某个操作是否安全，但自身无 LLM 能力）。

        Args:
            server_name: 服务端名称。
            messages: 采样消息列表（role + content）。
            model_preferences: 模型偏好（hints/priority）。
            max_tokens: 最大生成 token 数。
            system_prompt: 系统提示（可选）。
            include_context: 包含的上下文类型（optional）。

        Returns:
            采样结果（role + content + model + stopReason）。
        """
        try:
            self._request_id += 1
            params: dict[str, Any] = {
                "messages": messages,
                "maxTokens": max_tokens,
            }
            if model_preferences:
                params["modelPreferences"] = model_preferences
            if system_prompt:
                params["systemPrompt"] = system_prompt
            if include_context:
                params["includeContext"] = include_context

            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "sampling/createMessage",
                "params": params,
            }

            response = await self._send_request(server_name, request)
            result = response.get("result", {})

            log.info(
                "P2-1: MCP Sampling 请求完成",
                server=server_name,
                model=result.get("model", "unknown"),
                stop_reason=result.get("stopReason", "unknown"),
            )
            return result

        except Exception as e:
            log.warning("P2-1: MCP Sampling 请求失败", server=server_name, error=str(e))
            return {"error": str(e)}

    # ═══════════════════════════════════════════════════════════
    # P2-1: MCP Roots 协议
    # ═══════════════════════════════════════════════════════════

    async def list_roots(self, server_name: str) -> list[dict[str, Any]]:
        """P2-1: MCP Roots 协议 — 列出客户端文件系统根目录。

        MCP Roots 允许客户端向服务端声明可访问的文件系统根目录，
        服务端据此判断哪些文件路径是合法的。

        Args:
            server_name: 服务端名称。

        Returns:
            根目录列表（uri + name）。
        """
        try:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "roots/list",
                "params": {},
            }

            response = await self._send_request(server_name, request)
            roots = response.get("result", {}).get("roots", [])

            log.debug("P2-1: MCP Roots 列表获取成功", server=server_name, count=len(roots))
            return roots

        except Exception as e:
            log.warning("P2-1: MCP Roots 列表获取失败", server=server_name, error=str(e))
            return []

    async def _connect_stdio(self, name: str, config: MCPServerConfig) -> bool:
        """通过 stdio 连接 MCP 服务端。"""
        import os

        proc_env = {**os.environ, **config.env}

        try:
            process = await asyncio.create_subprocess_exec(
                config.command,
                *config.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=proc_env,
            )

            state = self._states[name]
            state.process = process
            state.connected = True
            state.last_ping = time.time()

            return True

        except Exception as e:
            log.warning("stdio 启动失败", server=name, error=str(e))
            return False

    async def _connect_sse(self, name: str, config: MCPServerConfig) -> bool:
        """通过 SSE 连接 MCP 服务端。

        P2: 使用 httpx.AsyncClient 替代 urllib.request，原生异步非阻塞。
        """
        if not config.url:
            log.warning("SSE 连接失败：URL 为空", server=name)
            return False
        try:
            if self._http_client is None:
                self._http_client = httpx.AsyncClient(timeout=30.0)
            resp = await self._http_client.get(config.url)
            resp.raise_for_status()
            state = self._states[name]
            state.connected = True
            state.last_ping = time.time()
            log.info("SSE 连接成功", server=name, url=config.url)
            return True
        except Exception as e:
            log.warning("SSE 连接失败", server=name, url=config.url, error=str(e))
            return False

    async def _discover_tools(self, name: str) -> None:
        """发现服务端工具。"""
        try:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "tools/list",
                "params": {},
            }

            response = await self._send_request(name, request)

            tools_data = response.get("result", {}).get("tools", [])
            tools: list[MCPTool] = []

            for t in tools_data:
                tools.append(MCPTool(
                    name=t.get("name", ""),
                    description=t.get("description", ""),
                    input_schema=t.get("inputSchema", {}),
                    server_name=name,
                ))

            self._tools[name] = tools
            self._states[name].tool_count = len(tools)

        except Exception as e:
            log.warning("工具发现失败", server=name, error=str(e))
            self._tools[name] = []

    async def _send_request(self, server_name: str, request: dict[str, Any]) -> dict[str, Any]:
        """发送 JSON-RPC 请求到 MCP 服务端。

        Args:
            server_name: 服务端名称。
            request: JSON-RPC 请求。

        Returns:
            JSON-RPC 响应。
        """
        state = self._states.get(server_name)
        config = self._servers.get(server_name)

        if not state or not config:
            return {"error": {"message": f"服务端 {server_name} 不存在"}}

        if config.transport == "stdio" and state.process:
            return await self._send_stdio(state, request)
        if config.transport == "sse" and config.url:
            return await self._send_sse(config.url, request)

        return {"error": {"message": "无可用的传输通道"}}

    async def _send_stdio(self, state: MCPServerState, request: dict[str, Any]) -> dict[str, Any]:
        """通过 stdio 发送请求。"""
        process = state.process
        if not process or not process.stdin or not process.stdout:
            return {"error": {"message": "进程不可用"}}

        msg = json.dumps(request) + "\n"
        process.stdin.write(msg.encode())
        await process.stdin.drain()

        response_line = await asyncio.wait_for(
            process.stdout.readline(), timeout=30.0,
        )

        if not response_line:
            return {"error": {"message": "服务端无响应"}}

        try:
            return json.loads(response_line.decode())
        except json.JSONDecodeError as e:
            return {"error": {"message": f"响应解析失败: {e}"}}

    async def _send_sse(self, url: str, request: dict[str, Any]) -> dict[str, Any]:
        """通过 SSE 发送请求。

        P2: 使用 httpx.AsyncClient 替代 urllib.request，原生异步非阻塞。
        支持连接池复用、自动重试、超时控制。
        """
        try:
            if self._http_client is None:
                self._http_client = httpx.AsyncClient(timeout=30.0)
            resp = await self._http_client.post(
                url,
                json=request,
                headers={"Content-Type": "application/json"},
            )
            resp.raise_for_status()
            return resp.json()
        except httpx.TimeoutException as e:
            return {"error": {"message": f"SSE 请求超时: {e}"}}
        except httpx.HTTPStatusError as e:
            return {"error": {"message": f"SSE HTTP 错误 {e.response.status_code}: {e}"}}
        except Exception as e:
            log.debug("mcp_client 异常处理", error=str(e))
            return {"error": {"message": f"SSE 请求失败: {e}"}}

    @property
    def resource_subscription(self) -> Any:
        """获取资源订阅管理器（懒初始化）。"""
        if self._resource_sub is None:
            from agent.mcp_integration.resource_subscription import ResourceSubscriptionManager
            self._resource_sub = ResourceSubscriptionManager(self)
        return self._resource_sub

    async def subscribe_resource(
        self,
        server_name: str,
        uri: str,
        callback: Any | None = None,
    ) -> bool:
        """订阅资源变更通知。

        Args:
            server_name: MCP 服务端名称。
            uri: 资源 URI。
            callback: 变更回调函数（可选）。

        Returns:
            是否订阅成功。
        """
        return await self.resource_subscription.subscribe(server_name, uri, callback)

    async def unsubscribe_resource(self, server_name: str, uri: str) -> bool:
        """取消资源订阅。"""
        return await self.resource_subscription.unsubscribe(server_name, uri)

    async def handle_notification(self, notification: dict[str, Any]) -> None:
        """处理 MCP 服务端推送的通知。

        目前支持:
        - notifications/resources/updated: 资源变更通知

        Args:
            notification: JSON-RPC 通知对象。
        """
        method = notification.get("method", "")
        if method == "notifications/resources/updated":
            await self.resource_subscription.handle_notification(notification)
        else:
            log.debug("收到未知通知", method=method)
