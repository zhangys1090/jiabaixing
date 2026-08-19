"""MCPLifecycle — MCP 服务端生命周期管理。

管理 MCP 服务端的启动、监控、重启和关闭，
支持从配置文件加载服务端定义。

Usage:
    from agent.mcp_integration.mcp_lifecycle import MCPLifecycle
    lifecycle = MCPLifecycle(mcp_client)
    await lifecycle.load_config(config_path)
    await lifecycle.start_all()
    status = lifecycle.get_status()
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.mcp_integration.mcp_client import MCPClient, MCPServerConfig, MCPServerState

log = StructuredLogger("mcp_lifecycle")


@dataclass
class ServerStatus:
    """服务端状态摘要。

    Attributes:
        name: 服务端名称。
        connected: 是否已连接。
        tool_count: 工具数量。
        error_count: 错误计数。
        uptime_seconds: 运行时间（秒）。
    """

    name: str = ""
    connected: bool = False
    tool_count: int = 0
    error_count: int = 0
    uptime_seconds: float = 0.0


class MCPLifecycle:
    """MCP 服务端生命周期管理器。

    职责：
    1. 从配置文件加载服务端定义
    2. 批量启动/停止服务端
    3. 健康检查与自动重启
    4. 状态监控与报告

    Usage:
        lifecycle = MCPLifecycle(mcp_client)
        await lifecycle.load_config("mcp_servers.json")
        await lifecycle.start_all()
    """

    def __init__(
        self,
        mcp_client: MCPClient,
        health_check_interval: float = 60.0,
        config_path: str = "",
    ) -> None:
        self._client = mcp_client
        self._health_check_interval = health_check_interval
        self._start_times: dict[str, float] = {}
        self._config_path: str = config_path or self._default_config_path()

    @staticmethod
    def _default_config_path() -> str:
        """计算 MCP 配置文件默认路径。

        搜索顺序：
        1. 环境变量 MCP_CONFIG_PATH
        2. 项目根目录 data/mcp_servers.json
        3. 用户目录 ~/.jiabaixing/mcp_servers.json

        Returns:
            配置文件路径（文件可能不存在）。
        """
        env_path = os.environ.get("MCP_CONFIG_PATH", "")
        if env_path:
            return env_path

        data_dir = os.environ.get("DATA_DIR", "data")
        project_path = os.path.join(data_dir, "mcp_servers.json")
        if os.path.exists(project_path):
            return project_path

        user_dir = os.path.expanduser("~/.jiabaixing")
        return os.path.join(user_dir, "mcp_servers.json")

    async def load_config(self, config_path: str) -> int:
        """从配置文件加载服务端定义。

        配置文件格式（JSON）：
        {
            "servers": [
                {
                    "name": "filesystem",
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                    "auto_start": true
                }
            ]
        }

        Args:
            config_path: 配置文件路径。

        Returns:
            加载的服务端数量。
        """
        if not os.path.exists(config_path):
            log.warning("配置文件不存在", path=config_path)
            return 0

        try:
            with open(config_path, encoding="utf-8") as f:
                config = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log.warning("配置文件解析失败", path=config_path, error=str(e))
            return 0

        servers = config.get("servers", [])
        count = 0

        for srv in servers:
            name = srv.get("name", "")
            if not name:
                continue

            server_config = MCPServerConfig(
                name=name,
                transport=srv.get("transport", "stdio"),
                command=srv.get("command", ""),
                args=srv.get("args", []),
                env=srv.get("env", {}),
                url=srv.get("url", ""),
                auto_start=srv.get("auto_start", True),
                restart_on_failure=srv.get("restart_on_failure", True),
            )

            self._client._servers[name] = server_config
            self._client._states[name] = MCPServerState(name=name)
            count += 1

        self._config_path = config_path
        log.info("MCP 配置加载", path=config_path, servers=count)
        return count

    async def auto_load(self) -> int:
        """自动发现并加载默认配置文件。

        按优先级搜索配置文件：
        1. 环境变量 MCP_CONFIG_PATH
        2. data/mcp_servers.json
        3. ~/.jiabaixing/mcp_servers.json

        找到则加载，未找到则静默返回 0。

        Returns:
            加载的服务端数量。
        """
        path = self._config_path
        if not path:
            return 0

        if not os.path.exists(path):
            log.debug("MCP 默认配置文件不存在", path=path)
            return 0

        count = await self.load_config(path)
        if count > 0:
            log.info("MCP 自动加载配置", path=path, servers=count)
        return count

    async def start_all(self) -> dict[str, bool]:
        """启动所有配置了 auto_start 的服务端。

        Returns:
            服务端名称 -> 是否启动成功。
        """
        results: dict[str, bool] = {}

        for name, config in self._client._servers.items():
            if not config.auto_start:
                continue

            success = await self._client.connect(
                name=name,
                command=config.command,
                args=config.args,
                env=config.env,
                url=config.url,
                transport=config.transport,
            )

            if success:
                self._start_times[name] = time.time()

            results[name] = success

        log.info("MCP 批量启动", results=results)
        return results

    async def start_server(self, name: str) -> bool:
        """启动单个服务端。

        Args:
            name: 服务端名称。

        Returns:
            是否启动成功。
        """
        config = self._client._servers.get(name)
        if not config:
            log.warning("服务端配置不存在", server=name)
            return False

        success = await self._client.connect(
            name=name,
            command=config.command,
            args=config.args,
            env=config.env,
            url=config.url,
            transport=config.transport,
        )

        if success:
            self._start_times[name] = time.time()

        return success

    async def stop_all(self) -> None:
        """停止所有服务端。"""
        await self._client.disconnect_all()
        self._start_times.clear()
        log.info("MCP 批量停止")

    async def restart_server(self, name: str) -> bool:
        """重启单个服务端。

        Args:
            name: 服务端名称。

        Returns:
            是否重启成功。
        """
        await self._client.disconnect(name)
        return await self.start_server(name)

    async def health_check(self) -> dict[str, bool]:
        """对所有已连接服务端执行健康检查。

        Returns:
            服务端名称 -> 是否健康。
        """
        results: dict[str, bool] = {}

        for name, state in self._client._states.items():
            if not state.connected:
                results[name] = False
                continue

            try:
                tools = await self._client.list_tools(name)
                state.last_ping = time.time()
                results[name] = True
            except Exception:
                state.connected = False
                results[name] = False

                config = self._client._servers.get(name)
                if config and config.restart_on_failure:
                    log.info("MCP 服务端不健康，尝试重启", server=name)
                    await self.restart_server(name)

        return results

    def get_status(self) -> list[ServerStatus]:
        """获取所有服务端状态。

        Returns:
            服务端状态列表。
        """
        now = time.time()
        statuses: list[ServerStatus] = []

        for name, state in self._client._states.items():
            start_time = self._start_times.get(name, 0)
            uptime = now - start_time if start_time > 0 else 0

            statuses.append(ServerStatus(
                name=name,
                connected=state.connected,
                tool_count=state.tool_count,
                error_count=state.error_count,
                uptime_seconds=uptime,
            ))

        return statuses

    def save_config(self, config_path: str = "") -> bool:
        """保存当前服务端配置到文件。

        Args:
            config_path: 保存路径（默认使用加载路径）。

        Returns:
            是否保存成功。
        """
        path = config_path or self._config_path
        if not path:
            return False

        servers: list[dict[str, Any]] = []
        for name, config in self._client._servers.items():
            servers.append({
                "name": config.name,
                "transport": config.transport,
                "command": config.command,
                "args": config.args,
                "env": config.env,
                "url": config.url,
                "auto_start": config.auto_start,
                "restart_on_failure": config.restart_on_failure,
            })

        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"servers": servers}, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            log.warning("配置保存失败", path=path, error=str(e))
            return False
