from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.mcp.logging import MCPLoggingManager
from agent.mcp.progress import MCPProgressManager
from agent.mcp.sampling import MCPSamplingManager
from agent.mcp.transport import (
    BaseMCPTransport,
    MCPTransportConfig,
    MCPTransportFactory,
    MCPTransportType,
)

log = StructuredLogger("mcp.manager")

MCP_CONFIG_PATH = str(DATA_ROOT / "mcp-servers.json")

REQUEST_TIMEOUT: float = 30.0
MAX_OUTPUT_BUFFER: int = 512 * 1024

# MCP Server→Client 三类内建方法名
METHOD_SAMPLING_CREATE = "sampling/createMessage"
METHOD_NOTIFICATION_LOG = "notifications/message"
METHOD_NOTIFICATION_PROGRESS = "notifications/progress"


@dataclass
class MCPServerConfig:
    """MCP 服务器配置.

    Attributes:
        name: 服务器唯一名称.
        command: STDIO 模式可执行命令.
        args: STDIO 模式命令参数.
        env: STDIO 模式环境变量.
        description: 服务器描述.
        enabled: 是否启用.
        auto_start: 是否自动启动.
        tool_filtering: 是否启用工具过滤.
        allowed_tools: 允许工具列表.
        denied_tools: 禁用工具列表.
        transport: 传输类型 ("stdio" 或 "http+sse").
        url: HTTP/SSE 模式 SSE 端点 URL.
        headers: HTTP/SSE 模式额外请求头.
    """
    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] | None = None
    description: str = ""
    enabled: bool = True
    auto_start: bool = False
    tool_filtering: bool = False
    allowed_tools: list[str] | None = None
    denied_tools: list[str] | None = None
    transport: str = "stdio"
    url: str = ""
    headers: dict[str, str] | None = None
    restart_on_failure: bool = True


@dataclass
class MCPServerProcess:
    process: asyncio.subprocess.Process
    start_time: float
    request_id: int = 0
    pending_requests: dict[int | str, asyncio.Future[dict]] = field(default_factory=dict)
    output_buffer: str = ""
    initialized: bool = False
    server_info: dict | None = None
    capabilities: dict | None = None
    restart_count: int = 0
    last_health_check: float | None = None


class MCPServerManager:
    _instance: MCPServerManager | None = None

    def __init__(self) -> None:
        self._servers: dict[str, MCPServerConfig] = {}
        self._processes: dict[str, MCPServerProcess] = {}
        # HTTP/SSE 传输层实例映射，键为服务器名，值为 BaseMCPTransport 实例
        self._transports: dict[str, BaseMCPTransport] = {}
        self._message_handlers: dict[str, Callable[[dict], None]] = {}
        self._event_handlers: dict[str, list[Callable]] = {}
        # P3-#2: MCP 三类原语管理器（Sampling/Logging/Progress）
        self._sampling_manager = MCPSamplingManager()
        self._logging_manager = MCPLoggingManager()
        self._progress_manager = MCPProgressManager()
        self._initialize_default_servers()
        self._MAX_EVENT_HANDLERS_PER_EVENT = 50
        self._MAX_EVENT_TYPES = 100

    @classmethod
    def get_instance(cls) -> MCPServerManager:
        if cls._instance is None:
            cls._instance = cls()
            cls._instance._load_config_from_file()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        if cls._instance:
            cls._instance.stop_all_servers()
            cls._instance._servers.clear()
            cls._instance._processes.clear()
            cls._instance._transports.clear()
            cls._instance._message_handlers.clear()
            cls._instance._event_handlers.clear()
            # 清空三个原语管理器的订阅者，避免单例重建后订阅者泄漏
            cls._instance._logging_manager.clear_subscribers()
            cls._instance._progress_manager.clear_subscribers()
        cls._instance = None

    def on(self, event: str, handler: Callable) -> None:
        if event not in self._event_handlers:
            self._event_handlers[event] = []
            if len(self._event_handlers) > self._MAX_EVENT_TYPES:
                oldest_events = list(self._event_handlers.keys())[: len(self._event_handlers) - (self._MAX_EVENT_TYPES * 3 // 4)]
                for k in oldest_events:
                    del self._event_handlers[k]
        self._event_handlers[event].append(handler)
        if len(self._event_handlers[event]) > self._MAX_EVENT_HANDLERS_PER_EVENT:
            self._event_handlers[event] = self._event_handlers[event][-self._MAX_EVENT_HANDLERS_PER_EVENT * 3 // 4:]

    def _emit(self, event: str, data: Any = None) -> None:
        for handler in self._event_handlers.get(event, []):
            try:
                handler(data)
            except Exception as _exc:
                log.debug("server_manager 异常处理", error=str(_exc))
                log_ignored(log, "server_manager.MCPServerManager._emit", _exc)

    def _initialize_default_servers(self) -> None:
        self.register_server(MCPServerConfig(
            name="filesystem",
            command="npx",
            args=["@modelcontextprotocol/server-filesystem", os.getcwd()],
            description="文件系统操作服务器",
            enabled=True,
            auto_start=False,
        ))
        self.register_server(MCPServerConfig(
            name="sqlite",
            command="npx",
            args=["@modelcontextprotocol/server-sqlite", "--db-path", "./data"],
            description="SQLite数据库操作服务器",
            enabled=True,
            auto_start=False,
        ))
        self.register_server(MCPServerConfig(
            name="browser",
            command="npx",
            args=["@anthropic-ai/mcp-server-browser"],
            description="浏览器自动化服务器",
            enabled=True,
            auto_start=False,
        ))
        self.register_server(MCPServerConfig(
            name="cron",
            command="npx",
            args=["@anthropic-ai/mcp-server-cron"],
            description="定时任务服务器",
            enabled=True,
            auto_start=False,
        ))

    def register_server(self, config: MCPServerConfig) -> None:
        self._servers[config.name] = config
        self._save_config_to_file()
        log.debug(f"MCP服务器已注册: {config.name}")

    def unregister_server(self, name: str) -> bool:
        self.stop_server(name)
        self._servers.pop(name, None)
        self._save_config_to_file()
        return True

    def get_server_config(self, name: str) -> MCPServerConfig | None:
        return self._servers.get(name)

    def get_all_servers(self) -> list[MCPServerConfig]:
        return list(self._servers.values())

    async def start_server(self, name: str) -> bool:
        config = self._servers.get(name)
        if not config:
            log.error(f"MCP服务器不存在: {name}")
            return False

        if not config.enabled:
            log.warning(f"MCP服务器已禁用: {name}")
            return False

        if name in self._processes or name in self._transports:
            log.warning(f"MCP服务器已在运行: {name}")
            return True

        # 传输类型分发：HTTP/SSE 走传输层，STDIO 走子进程
        transport_type = self._resolve_transport_type(config)
        if transport_type == MCPTransportType.HTTP_SSE:
            return await self._start_http_sse_server(name, config)

        try:
            log.info(f"启动MCP服务器: {name}")

            process_env = dict(os.environ)
            if config.env:
                process_env.update(config.env)

            child = await asyncio.create_subprocess_exec(
                config.command,
                *config.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=process_env,
            )

            server_proc = MCPServerProcess(
                process=child,
                start_time=asyncio.get_event_loop().time(),
            )

            asyncio.create_task(self._read_stdout(name, server_proc))
            asyncio.create_task(self._read_stderr(name, server_proc))
            asyncio.create_task(self._monitor_exit(name, server_proc))

            self._processes[name] = server_proc
            self._emit("serverStarted", {"name": name, "config": config})

            log.info(f"MCP服务器启动成功: {name} (PID: {child.pid})")

            init_ok = await self._initialize_server(name)
            if not init_ok:
                log.warning(f"MCP服务器初始化握手失败: {name}")

            return True
        except Exception as e:
            log.error(f"MCP服务器启动失败 [{name}]: {e}")
            return False

    async def _start_http_sse_server(self, name: str, config: MCPServerConfig) -> bool:
        """启动 HTTP/SSE 传输层的 MCP 服务器.

        通过 MCPTransportFactory 创建 HttpSseMCPTransport 实例并启动，
        跳过 stdio 子进程启动路径。传输实例存入 _transports 字典，
        供 send_message/stop_server 委托使用。

        Args:
            name: 服务器名称.
            config: MCP 服务器配置，必须包含 url 字段.

        Returns:
            bool: 启动成功返回 True，失败返回 False.
        """
        try:
            log.info(f"启动MCP服务器(HTTP/SSE): {name} url={config.url}")
            transport_config = MCPTransportConfig(
                url=config.url,
                headers=config.headers or {},
                timeout=REQUEST_TIMEOUT,
            )
            transport = MCPTransportFactory.create(transport_config, MCPTransportType.HTTP_SSE)
            await transport.start()
            # P3-#2: 注册 Server→Client 三类内建方法的处理器
            self._register_transport_handlers(name, transport)
            self._transports[name] = transport
            self._emit("serverStarted", {"name": name, "config": config})
            log.info(f"MCP服务器(HTTP/SSE)启动成功: {name}")
            return True
        except Exception as e:
            log.error(f"MCP服务器(HTTP/SSE)启动失败 [{name}]: {e}")
            return False

    def _register_transport_handlers(
        self, name: str, transport: BaseMCPTransport
    ) -> None:
        """向传输层注册 Server→Client 内建方法处理器（P3-#2）.

        为 HTTP/SSE 传输层注册 sampling/logging/progress 三类方法的
        处理器，使 Server 主动发起的请求与通知能被路由到对应的管理器。

        Args:
            name: 服务器名称.
            transport: 传输层实例.
        """
        # sampling/createMessage 为带 id 的请求
        transport.on_request(
            METHOD_SAMPLING_CREATE,
            lambda message, _name=name: self._schedule_dispatch(_name, message),
        )
        # notifications/message 与 notifications/progress 为通知（无 id）
        transport.on_notification(
            METHOD_NOTIFICATION_LOG,
            lambda params, _name=name: self._schedule_dispatch(
                _name, {"jsonrpc": "2.0", "method": METHOD_NOTIFICATION_LOG, "params": params}
            ),
        )
        transport.on_notification(
            METHOD_NOTIFICATION_PROGRESS,
            lambda params, _name=name: self._schedule_dispatch(
                _name, {"jsonrpc": "2.0", "method": METHOD_NOTIFICATION_PROGRESS, "params": params}
            ),
        )

    async def _initialize_server(self, name: str) -> bool:
        try:
            response = await self.send_message(name, {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "jiabaixing",
                        "version": "5.0",
                    },
                },
            })

            server_proc = self._processes.get(name)
            if server_proc and response.get("result"):
                result = response["result"]
                server_proc.initialized = True
                server_proc.server_info = result.get("serverInfo")
                server_proc.capabilities = result.get("capabilities")

            await self.send_message(name, {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            })

            log.debug(f"MCP服务器初始化完成: {name}")
            return True
        except Exception as e:
            log.error(f"MCP服务器初始化失败 [{name}]: {e}")
            return False

    async def _read_stdout(self, name: str, server_proc: MCPServerProcess) -> None:
        assert server_proc.process.stdout
        while True:
            try:
                line = await server_proc.process.stdout.readline()
                if not line:
                    break
                chunk = line.decode("utf-8", errors="replace")
                self._handle_server_output(name, server_proc, chunk)
            except Exception as _exc:
                log.debug("server_manager 异常处理", error=str(_exc))
                break

    async def _read_stderr(self, name: str, server_proc: MCPServerProcess) -> None:
        assert server_proc.process.stderr
        while True:
            try:
                line = await server_proc.process.stderr.readline()
                if not line:
                    break
                msg = line.decode("utf-8", errors="replace").strip()
                if msg:
                    log.debug(f"MCP[{name}] stderr: {msg[:200]}")
            except Exception as _exc:
                log.debug("server_manager 异常处理", error=str(_exc))
                break

    async def _monitor_exit(self, name: str, server_proc: MCPServerProcess) -> None:
        try:
            code = await server_proc.process.wait()
            log.warning(f"MCP服务器进程退出: {name} (code={code})")
            self._cleanup_server(name, server_proc)
        except Exception as _exc:
            log.debug("server_manager 异常处理", error=str(_exc))
            log_ignored(log, "server_manager.MCPServerManager._monitor_exit", _exc)

    def _handle_server_output(
        self, name: str, server_proc: MCPServerProcess, chunk: str
    ) -> None:
        server_proc.output_buffer += chunk
        if len(server_proc.output_buffer) > MAX_OUTPUT_BUFFER:
            server_proc.output_buffer = server_proc.output_buffer[-MAX_OUTPUT_BUFFER // 2:]

        lines = server_proc.output_buffer.split("\n")
        server_proc.output_buffer = lines.pop() or ""

        for line in lines:
            trimmed = line.strip()
            if not trimmed:
                continue
            try:
                message: dict = json.loads(trimmed)
                if "id" in message:
                    future = server_proc.pending_requests.pop(message["id"], None)
                    if future and not future.done():
                        future.set_result(message)

                if "method" in message:
                    # P3-#2: 优先分发内建 MCP 原语方法
                    method = message["method"]
                    if method in (
                        METHOD_SAMPLING_CREATE,
                        METHOD_NOTIFICATION_LOG,
                        METHOD_NOTIFICATION_PROGRESS,
                    ):
                        self._schedule_dispatch(name, message)
                    # 通用 message handler 仍调用（保持向后兼容）
                    handler = self._message_handlers.get(name)
                    if handler:
                        handler(message)
                    self._emit("message", {"serverName": name, "message": message})
            except json.JSONDecodeError as _exc:
                log_ignored(log, "server_manager.MCPServerManager._handle_server_output", _exc)

    def _schedule_dispatch(self, name: str, message: dict) -> None:
        """将内建 MCP 原语方法分发调度到事件循环.

        在同步上下文（_handle_server_output）中调用，通过
        ``asyncio.create_task`` 调度异步分发协程。无运行中事件循环
        时静默跳过。

        Args:
            name: 服务器名称.
            message: 完整 JSON-RPC 消息.
        """
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            return
        if loop.is_running():
            loop.create_task(self._dispatch_incoming_method(name, message))

    async def _dispatch_incoming_method(
        self, name: str, message: dict
    ) -> None:
        """分发 MCP Server→Client 内建方法（sampling/logging/progress）.

        Args:
            name: 服务器名称.
            message: 完整 JSON-RPC 消息，包含 method/params/可选 id.
        """
        method = message.get("method", "")
        params = message.get("params") or {}
        msg_id = message.get("id")

        try:
            if method == METHOD_SAMPLING_CREATE:
                # Server→Client 请求，需通过 SamplingManager 完成 LLM 调用并回响应
                result = await self._sampling_manager.create_message(params)
                if msg_id is not None:
                    await self._send_response(name, msg_id, result=result)
            elif method == METHOD_NOTIFICATION_LOG:
                # Server→Client 通知，分发到订阅者
                level = params.get("level", "info")
                logger_name = params.get("logger", name)
                data = params.get("data")
                await self._logging_manager.send_log(level, logger_name, data)
            elif method == METHOD_NOTIFICATION_PROGRESS:
                # Server→Client 通知，分发到订阅者
                progress_token = params.get("progressToken", "")
                progress = params.get("progress", 0.0)
                total = params.get("total")
                prog_message = params.get("message")
                await self._progress_manager.send_progress(
                    progress_token, progress, total, prog_message
                )
        except Exception as e:
            log.error(f"MCP 方法分发失败 [{method}]: {e}")
            # sampling 请求失败时回 JSON-RPC 错误响应
            if method == METHOD_SAMPLING_CREATE and msg_id is not None:
                try:
                    await self._send_response(
                        name,
                        msg_id,
                        error={"code": -32603, "message": str(e)},
                    )
                except Exception as send_err:
                    log.warning(f"sampling 错误响应发送失败: {send_err}")

    async def _send_response(
        self,
        server_name: str,
        msg_id: int | str,
        result: Any = None,
        error: dict | None = None,
    ) -> None:
        """向 MCP 服务器发送 JSON-RPC 响应（用于 Server→Client 请求的回包）.

        Args:
            server_name: 服务器名称.
            msg_id: 服务器请求的 id.
            result: 成功结果（与 error 互斥）.
            error: 错误对象（与 result 互斥）.
        """
        response: dict[str, Any] = {"jsonrpc": "2.0", "id": msg_id}
        if error is not None:
            response["error"] = error
        else:
            response["result"] = result

        # HTTP/SSE 路径：通过 transport.send_response 发送
        transport = self._transports.get(server_name)
        if transport is not None:
            transport.send_response(msg_id, result=result, error=error)
            return

        # stdio 路径：直接写入子进程 stdin
        server_proc = self._processes.get(server_name)
        if not server_proc:
            log.warning(f"无法发送响应，服务器未运行: {server_name}")
            return
        json_str = json.dumps(response, ensure_ascii=False) + "\n"
        try:
            server_proc.process.stdin.write(json_str.encode("utf-8"))
        except Exception as e:
            log.error(f"发送响应失败 [{server_name}]: {e}")

    def get_sampling_manager(self) -> MCPSamplingManager:
        """返回 Sampling 原语管理器实例."""
        return self._sampling_manager

    def get_logging_manager(self) -> MCPLoggingManager:
        """返回 Logging 原语管理器实例."""
        return self._logging_manager

    def get_progress_manager(self) -> MCPProgressManager:
        """返回 Progress 原语管理器实例."""
        return self._progress_manager

    def _cleanup_server(self, name: str, server_proc: MCPServerProcess) -> None:
        for future in server_proc.pending_requests.values():
            if not future.done():
                future.set_exception(RuntimeError(f"MCP服务器 {name} 已退出"))
        server_proc.pending_requests.clear()
        self._processes.pop(name, None)
        self._emit("serverStopped", {"name": name})

    def stop_server(self, name: str) -> bool:
        # HTTP/SSE 传输层停止路径
        transport = self._transports.pop(name, None)
        if transport is not None:
            try:
                log.info(f"停止MCP服务器(HTTP/SSE): {name}")
                # transport.stop 是协程，需要事件循环驱动；这里通过 asyncio.run_coroutine_threadsafe
                # 或直接 create_task 处理。为保持 stop_server 同步签名，使用事件循环调度。
                try:
                    loop = asyncio.get_event_loop()
                except RuntimeError:
                    loop = None
                if loop and loop.is_running():
                    loop.create_task(transport.stop())
                else:
                    # 无运行中事件循环时，使用 asyncio.run 同步停止
                    asyncio.run(transport.stop())
                self._emit("serverStopped", {"name": name})
                log.info(f"MCP服务器(HTTP/SSE)已停止: {name}")
                return True
            except Exception as e:
                log.error(f"MCP服务器(HTTP/SSE)停止失败 [{name}]: {e}")
                return False

        server_proc = self._processes.get(name)
        if not server_proc:
            return False

        try:
            log.info(f"停止MCP服务器: {name}")
            server_proc.process.kill()
            self._cleanup_server(name, server_proc)
            log.info(f"MCP服务器已停止: {name}")
            return True
        except Exception as e:
            log.error(f"MCP服务器停止失败 [{name}]: {e}")
            return False

    async def start_all_servers(self) -> None:
        log.info("启动所有MCP服务器...")
        tasks = [
            self.start_server(name)
            for name, config in self._servers.items()
            if config.enabled
        ]
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info(f"MCP服务器启动完成: {len(self._processes)}/{len(self._servers)} 个运行中")

    async def start_auto_start_servers(self) -> None:
        log.info("启动自动启动的MCP服务器...")
        tasks = [
            self.start_server(name)
            for name, config in self._servers.items()
            if config.enabled and config.auto_start
        ]
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info(f"自动启动完成: {len(self._processes)} 个运行中")

    def stop_all_servers(self) -> None:
        log.info("停止所有MCP服务器...")
        # 先停 stdio 子进程，再停 HTTP/SSE 传输层
        for name in list(self._processes.keys()):
            self.stop_server(name)
        for name in list(self._transports.keys()):
            self.stop_server(name)
        log.info("所有MCP服务器已停止")

    async def send_message(self, server_name: str, message: dict) -> dict:
        # HTTP/SSE 传输层优先委托
        transport = self._transports.get(server_name)
        if transport is not None:
            method = message.get("method", "")
            params = message.get("params")
            is_notification = "method" in message and "id" not in message
            if is_notification:
                transport.send_notification(method, params)
                return {"jsonrpc": "2.0", "result": None}
            return await transport.send_request(method, params)

        server_proc = self._processes.get(server_name)
        if not server_proc:
            raise RuntimeError(f"MCP服务器未运行: {server_name}")

        is_notification = "method" in message and "id" not in message
        if is_notification:
            json_str = json.dumps(message, ensure_ascii=False) + "\n"
            server_proc.process.stdin.write(json_str.encode("utf-8"))
            return {"jsonrpc": "2.0", "result": None}

        server_proc.request_id += 1
        msg_id = server_proc.request_id
        msg_with_id = {**message, "id": msg_id}

        future: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        server_proc.pending_requests[msg_id] = future

        json_str = json.dumps(msg_with_id, ensure_ascii=False) + "\n"
        try:
            server_proc.process.stdin.write(json_str.encode("utf-8"))
        except Exception as e:
            log.debug("server_manager 异常处理", error=str(e))
            server_proc.pending_requests.pop(msg_id, None)
            raise RuntimeError(f"MCP写入失败: {e}")

        try:
            return await asyncio.wait_for(future, timeout=REQUEST_TIMEOUT)
        except asyncio.TimeoutError:
            server_proc.pending_requests.pop(msg_id, None)
            raise TimeoutError(
                f"MCP请求超时 ({REQUEST_TIMEOUT}s): {server_name}/{message.get('method')}"
            )

    def filter_tools(
        self, server_name: str, tools: list[dict]
    ) -> list[dict]:
        config = self._servers.get(server_name)
        if not config or not config.tool_filtering:
            return tools

        result: list[dict] = []
        for tool in tools:
            tool_name = tool.get("name", "")
            if config.denied_tools and tool_name in config.denied_tools:
                continue
            if config.allowed_tools and tool_name not in config.allowed_tools:
                continue
            result.append(tool)
        return result

    def _resolve_transport_type(self, config: MCPServerConfig) -> MCPTransportType:
        """根据 MCPServerConfig.transport 字段解析为 MCPTransportType 枚举.

        Args:
            config: MCP 服务器配置.
        Returns:
            MCPTransportType: 传输类型枚举（默认 STDIO）.
        """
        try:
            return MCPTransportType(config.transport or "stdio")
        except ValueError:
            log.warning(f"MCP服务器 {config.name} 传输类型未知: {config.transport}, 回退为 STDIO")
            return MCPTransportType.STDIO

    async def send_request(
        self,
        server_name: str,
        method: str,
        params: dict | None = None,
    ) -> dict:
        """发送通用 JSON-RPC 请求到 MCP 服务器（实现 MCPProvider 接口）.

        委托 send_message 处理实际通信，使 MCPServerManager 与
        MCPProvider.send_request 接口对齐，支持 resources/*、prompts/* 等
        MCP 标准协议方法。

        Args:
            server_name: MCP 服务器名称.
            method: JSON-RPC 方法名（如 "resources/list"）.
            params: 请求参数字典，可选.
        Returns:
            dict: 完整 JSON-RPC 响应.
        Raises:
            RuntimeError: 服务器未运行或通信失败.
            TimeoutError: 请求超时.
        """
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        return await self.send_message(server_name, message)

    async def call_tool(
        self, server_name: str, tool_name: str, args: dict | None = None
    ) -> Any:
        config = self._servers.get(server_name)
        if config and config.tool_filtering:
            if config.denied_tools and tool_name in config.denied_tools:
                raise RuntimeError(f"工具 {tool_name} 已被禁用")
            if config.allowed_tools and tool_name not in config.allowed_tools:
                raise RuntimeError(f"工具 {tool_name} 不在允许列表中")

        response = await self.send_message(server_name, {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": args or {},
            },
        })

        if response.get("error"):
            err = response["error"]
            raise RuntimeError(f"MCP工具调用失败: {err.get('message')} ({err.get('code')})")

        return response.get("result")

    async def list_tools(self, server_name: str) -> list[dict]:
        response = await self.send_message(server_name, {
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {},
        })

        if response.get("error"):
            raise RuntimeError(f"MCP工具列表获取失败: {response['error'].get('message')}")

        result = response.get("result", {}) or {}
        return result.get("tools", [])

    def register_message_handler(
        self, server_name: str, handler: Callable[[dict], None]
    ) -> None:
        self._message_handlers[server_name] = handler
        log.info(f"注册消息处理器: {server_name}")

    def unregister_message_handler(self, server_name: str) -> None:
        self._message_handlers.pop(server_name, None)

    async def list_resources(self, server_name: str) -> list[dict]:
        """列出 MCP 服务器提供的资源.

        MCP Protocol: resources/list

        Args:
            server_name: MCP 服务器名称.

        Returns:
            list[dict]: 资源列表；服务器未初始化或不支持 resources 时返回空列表.
        """
        server_proc = self._processes.get(server_name)
        transport = self._transports.get(server_name)
        if not server_proc and not transport:
            log.warning(f"MCP服务器 {server_name} 未运行，无法列出资源")
            return []

        caps = None
        if server_proc and server_proc.initialized:
            caps = server_proc.capabilities or {}
        elif transport:
            caps = getattr(transport, "_capabilities", None) or {}

        if not caps.get("resources"):
            log.debug(f"MCP服务器 {server_name} 不支持 resources")
            return []

        try:
            response = await self.send_request(server_name, "resources/list", {})
            if response.get("error"):
                log.warning(f"MCP资源列表获取失败: {response['error'].get('message')}")
                return []
            result = response.get("result") or {}
            return result.get("resources", [])
        except Exception as exc:
            log.warning(f"MCP资源列表获取异常: {exc}")
            return []

    async def read_resource(self, server_name: str, uri: str) -> dict:
        """读取 MCP 服务器提供的资源内容.

        MCP Protocol: resources/read

        Args:
            server_name: MCP 服务器名称.
            uri: 资源 URI.

        Returns:
            dict: 资源内容.

        Raises:
            RuntimeError: 服务器未运行或资源读取失败.
        """
        server_proc = self._processes.get(server_name)
        transport = self._transports.get(server_name)
        if not server_proc and not transport:
            raise RuntimeError(f"MCP服务器 {server_name} 未运行")

        response = await self.send_request(server_name, "resources/read", {"uri": uri})
        if response.get("error"):
            err = response["error"]
            raise RuntimeError(f"MCP资源读取失败: {err.get('message')} ({err.get('code')})")
        return response.get("result", {})

    async def list_prompts(self, server_name: str) -> list[dict]:
        """列出 MCP 服务器提供的提示模板.

        MCP Protocol: prompts/list

        Args:
            server_name: MCP 服务器名称.

        Returns:
            list[dict]: 提示模板列表；服务器未初始化或不支持 prompts 时返回空列表.
        """
        server_proc = self._processes.get(server_name)
        transport = self._transports.get(server_name)
        if not server_proc and not transport:
            log.warning(f"MCP服务器 {server_name} 未运行，无法列出提示模板")
            return []

        caps = None
        if server_proc and server_proc.initialized:
            caps = server_proc.capabilities or {}
        elif transport:
            caps = getattr(transport, "_capabilities", None) or {}

        if not caps.get("prompts"):
            log.debug(f"MCP服务器 {server_name} 不支持 prompts")
            return []

        try:
            response = await self.send_request(server_name, "prompts/list", {})
            if response.get("error"):
                log.warning(f"MCP提示模板列表获取失败: {response['error'].get('message')}")
                return []
            result = response.get("result") or {}
            return result.get("prompts", [])
        except Exception as exc:
            log.warning(f"MCP提示模板列表获取异常: {exc}")
            return []

    async def get_prompt(
        self, server_name: str, name: str, args: dict[str, str] | None = None
    ) -> dict:
        """获取 MCP 服务器提供的提示模板内容.

        MCP Protocol: prompts/get

        Args:
            server_name: MCP 服务器名称.
            name: 提示模板名称.
            args: 提示模板参数，可选.

        Returns:
            dict: 提示模板内容.

        Raises:
            RuntimeError: 服务器未运行或提示模板获取失败.
        """
        server_proc = self._processes.get(server_name)
        transport = self._transports.get(server_name)
        if not server_proc and not transport:
            raise RuntimeError(f"MCP服务器 {server_name} 未运行")

        response = await self.send_request(
            server_name, "prompts/get", {"name": name, "arguments": args or {}}
        )
        if response.get("error"):
            err = response["error"]
            raise RuntimeError(f"MCP提示模板获取失败: {err.get('message')} ({err.get('code')})")
        return response.get("result", {})

    async def list_all_resources(self) -> dict[str, list[dict]]:
        """列出所有运行中服务器上的全部资源.

        Returns:
            dict[str, list[dict]]: 服务器名 → 资源列表.
        """
        all_resources: dict[str, list[dict]] = {}
        for name in self.get_running_servers():
            try:
                resources = await self.list_resources(name)
                if resources:
                    all_resources[name] = resources
            except Exception as exc:
                log.warning(f"列出 {name} 资源失败: {exc}")
        return all_resources

    async def list_all_prompts(self) -> dict[str, list[dict]]:
        """列出所有运行中服务器上的全部提示模板.

        Returns:
            dict[str, list[dict]]: 服务器名 → 提示模板列表.
        """
        all_prompts: dict[str, list[dict]] = {}
        for name in self.get_running_servers():
            try:
                prompts = await self.list_prompts(name)
                if prompts:
                    all_prompts[name] = prompts
            except Exception as exc:
                log.warning(f"列出 {name} 提示模板失败: {exc}")
        return all_prompts

    def get_server_status(self, name: str) -> dict:
        server_proc = self._processes.get(name)
        transport = self._transports.get(name)
        config = self._servers.get(name)
        return {
            "running": server_proc is not None or transport is not None,
            "initialized": server_proc.initialized if server_proc else (transport is not None),
            "config": config,
            "server_info": server_proc.server_info if server_proc else None,
            "capabilities": server_proc.capabilities if server_proc else None,
            "transport_type": self._resolve_transport_type(config).value if config else "stdio",
        }

    def get_all_server_status(self) -> dict[str, dict]:
        return {name: self.get_server_status(name) for name in self._servers}

    def get_running_servers(self) -> list[str]:
        # 合并 stdio 子进程与 HTTP/SSE 传输层
        return list(self._processes.keys()) + list(self._transports.keys())

    def get_server_count(self) -> int:
        return len(self._servers)

    def get_running_server_count(self) -> int:
        return len(self._processes) + len(self._transports)

    def get_server_health(self, name: str) -> dict:
        status = self.get_server_status(name)
        server_proc = self._processes.get(name)
        transport = self._transports.get(name)
        # HTTP/SSE 传输层健康度由 is_running 判定
        uptime = 0.0
        if server_proc:
            uptime = asyncio.get_event_loop().time() - server_proc.start_time
        elif transport is not None:
            uptime = 0.0
        return {
            "name": name,
            "running": status["running"],
            "initialized": status["initialized"],
            "healthy": status["running"] and status["initialized"],
            "restart_count": server_proc.restart_count if server_proc else 0,
            "last_health_check": server_proc.last_health_check if server_proc else None,
            "uptime": uptime,
            "transport_type": status.get("transport_type", "stdio"),
        }

    def get_all_server_health(self) -> dict[str, dict]:
        return {name: self.get_server_health(name) for name in self._servers}

    def _load_config_from_file(self) -> None:
        try:
            with open(MCP_CONFIG_PATH, "r", encoding="utf-8") as f:
                configs: list[dict] = json.load(f)
            for cfg in configs:
                name = cfg.get("name", "")
                if name and name not in self._servers:
                    self._servers[name] = MCPServerConfig(
                        name=name,
                        command=cfg.get("command", ""),
                        args=cfg.get("args", []),
                        env=cfg.get("env"),
                        description=cfg.get("description", ""),
                        enabled=cfg.get("enabled", True),
                        auto_start=cfg.get("autoStart", False),
                        tool_filtering=cfg.get("toolFiltering", False),
                        allowed_tools=cfg.get("allowedTools"),
                        denied_tools=cfg.get("deniedTools"),
                        transport=cfg.get("transport", "stdio"),
                        url=cfg.get("url", ""),
                        headers=cfg.get("headers"),
                    )
            log.debug(f"从文件加载了 {len(configs)} 个 MCP 服务器配置")
        except FileNotFoundError as _exc:
            log_ignored(log, "server_manager.MCPServerManager._load_config_from_file", _exc)
        except Exception as e:
            log.warning(f"加载 MCP 配置文件失败: {e}")

    def _save_config_to_file(self) -> None:
        try:
            os.makedirs(os.path.dirname(MCP_CONFIG_PATH), exist_ok=True)
            configs = [
                {
                    "name": s.name,
                    "command": s.command,
                    "args": s.args,
                    "env": s.env,
                    "description": s.description,
                    "enabled": s.enabled,
                    "autoStart": s.auto_start,
                    "toolFiltering": s.tool_filtering,
                    "allowedTools": s.allowed_tools,
                    "deniedTools": s.denied_tools,
                    "transport": s.transport,
                    "url": s.url,
                    "headers": s.headers,
                }
                for s in self._servers.values()
            ]
            with open(MCP_CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(configs, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log.warning(f"保存 MCP 配置文件失败: {e}")

    def reload_config(self) -> None:
        self._servers.clear()
        self._initialize_default_servers()
        self._load_config_from_file()
        self._emit("configReloaded")
        log.info("MCP 服务器配置已重新加载")
