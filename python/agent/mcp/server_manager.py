from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("mcp.manager")

MCP_CONFIG_PATH = os.path.join(os.getcwd(), "data", "mcp-servers.json")

REQUEST_TIMEOUT: float = 30.0
MAX_OUTPUT_BUFFER: int = 512 * 1024


@dataclass
class MCPServerConfig:
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
        self._message_handlers: dict[str, Callable[[dict], None]] = {}
        self._event_handlers: dict[str, list[Callable]] = {}
        self._initialize_default_servers()

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
            cls._instance._message_handlers.clear()
            cls._instance._event_handlers.clear()
        cls._instance = None

    def on(self, event: str, handler: Callable) -> None:
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def _emit(self, event: str, data: Any = None) -> None:
        for handler in self._event_handlers.get(event, []):
            try:
                handler(data)
            except Exception:
                pass

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
        log.info(f"MCP服务器已注册: {config.name}")

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

        if name in self._processes:
            log.warning(f"MCP服务器已在运行: {name}")
            return True

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

    async def _initialize_server(self, name: str) -> bool:
        try:
            response = await self.send_message(name, {
                "jsonrpc": "2.0",
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

            log.info(f"MCP服务器初始化完成: {name}")
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
            except Exception:
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
            except Exception:
                break

    async def _monitor_exit(self, name: str, server_proc: MCPServerProcess) -> None:
        try:
            code = await server_proc.process.wait()
            log.warning(f"MCP服务器进程退出: {name} (code={code})")
            self._cleanup_server(name, server_proc)
        except Exception:
            pass

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
                    handler = self._message_handlers.get(name)
                    if handler:
                        handler(message)
                    self._emit("message", {"serverName": name, "message": message})
            except json.JSONDecodeError:
                pass

    def _cleanup_server(self, name: str, server_proc: MCPServerProcess) -> None:
        for future in server_proc.pending_requests.values():
            if not future.done():
                future.set_exception(RuntimeError(f"MCP服务器 {name} 已退出"))
        server_proc.pending_requests.clear()
        self._processes.pop(name, None)
        self._emit("serverStopped", {"name": name})

    def stop_server(self, name: str) -> bool:
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
        for name in list(self._processes.keys()):
            self.stop_server(name)
        log.info("所有MCP服务器已停止")

    async def send_message(self, server_name: str, message: dict) -> dict:
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

    def get_server_status(self, name: str) -> dict:
        server_proc = self._processes.get(name)
        config = self._servers.get(name)
        return {
            "running": server_proc is not None,
            "initialized": server_proc.initialized if server_proc else False,
            "config": config,
            "server_info": server_proc.server_info if server_proc else None,
            "capabilities": server_proc.capabilities if server_proc else None,
        }

    def get_all_server_status(self) -> dict[str, dict]:
        return {name: self.get_server_status(name) for name in self._servers}

    def get_running_servers(self) -> list[str]:
        return list(self._processes.keys())

    def get_server_count(self) -> int:
        return len(self._servers)

    def get_running_server_count(self) -> int:
        return len(self._processes)

    def get_server_health(self, name: str) -> dict:
        status = self.get_server_status(name)
        server_proc = self._processes.get(name)
        return {
            "name": name,
            "running": status["running"],
            "initialized": status["initialized"],
            "healthy": status["running"] and status["initialized"],
            "restart_count": server_proc.restart_count if server_proc else 0,
            "last_health_check": server_proc.last_health_check if server_proc else None,
            "uptime": (
                asyncio.get_event_loop().time() - server_proc.start_time
                if server_proc
                else 0
            ),
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
                    )
            log.info(f"从文件加载了 {len(configs)} 个 MCP 服务器配置")
        except FileNotFoundError:
            pass
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
