"""LSP 服务器管理器。

管理多个语言服务器进程的生命周期：
  - 按语言 ID 自动匹配并启动对应语言服务器
  - JSON-RPC over stdio 通信
  - 能力协商（initialize / initialized 握手）
  - 连接池管理与健康检查

内置服务器配置:
    - python  → pylsp
    - typescript → typescript-language-server
    - go     → gopls
    - rust   → rust-analyzer

集成示例::

    from agent.lsp.servers import LspServerManager

    mgr = LspServerManager()
    server_id = await mgr.connect("python")
    result = await mgr.request(server_id, "textDocument/completion", {...})
    await mgr.disconnect(server_id)
"""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass, field
from typing import Any

from agent.lsp.protocol import LspProtocol, LspServerCapabilities
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("lsp.servers")


@dataclass
class LspServerConfig:
    id: str = ""
    command: str = ""
    args: list[str] = field(default_factory=list)
    languages: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)


@dataclass
class ManagedServer:
    config: LspServerConfig
    process: Any = None
    capabilities: LspServerCapabilities | None = None
    status: str = "disconnected"
    document_versions: dict[str, int] = field(default_factory=dict)


BUILTIN_SERVERS: list[LspServerConfig] = [
    LspServerConfig(
        id="pylsp",
        command="pylsp",
        languages=["python"],
    ),
    LspServerConfig(
        id="tsls",
        command="typescript-language-server",
        args=["--stdio"],
        languages=["typescript", "typescriptreact", "javascript", "javascriptreact"],
    ),
    LspServerConfig(
        id="gopls",
        command="gopls",
        languages=["go"],
    ),
    LspServerConfig(
        id="rust-analyzer",
        command="rust-analyzer",
        languages=["rust"],
    ),
]


class LspServerManager:
    """LSP 服务器管理器。"""

    def __init__(self, custom_servers: list[LspServerConfig] | None = None):
        self._protocol = LspProtocol()
        self._servers: dict[str, ManagedServer] = {}
        self._builtin = list(BUILTIN_SERVERS)
        self._custom = custom_servers or []
        self._workspace_root: str = ""

    def configure_workspace(self, root_uri: str) -> None:
        self._workspace_root = root_uri

    def get_server_config(self, language_id: str) -> LspServerConfig | None:
        for s in self._custom:
            if language_id in s.languages:
                return s
        for s in self._builtin:
            if language_id in s.languages:
                return s
        return None

    async def connect(self, language_id: str) -> str | None:
        config = self.get_server_config(language_id)
        if not config:
            log.warning("No server config for language", language=language_id)
            return None
        if config.id in self._servers:
            existing = self._servers[config.id]
            if existing.status == "connected":
                return config.id
            await self.disconnect(config.id)
        return await self._connect_server(config)

    async def _connect_server(self, config: LspServerConfig) -> str | None:
        managed = ManagedServer(config=config, status="connecting")
        self._servers[config.id] = managed
        try:
            env = {**os.environ, **config.env}
            process = await asyncio.create_subprocess_exec(
                config.command,
                *config.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            managed.process = process
            init_params = self._protocol.initialize_params(self._workspace_root)
            init_request = self._protocol.build_request("initialize", init_params)
            response = await self._send_and_receive(config.id, init_request)
            if response and "result" in response:
                caps = response["result"].get("capabilities", {})
                managed.capabilities = self._parse_capabilities(caps)
                initialized = self._protocol.build_notification("initialized", {})
                await self._send(config.id, initialized)
                managed.status = "connected"
                log.info("LSP server connected", server=config.id)
                return config.id
            managed.status = "failed"
            log.warning("LSP initialize failed", server=config.id)
            return None
        except Exception as e:
            managed.status = "failed"
            log.warning("LSP server connect error", server=config.id, error=str(e))
            return None

    async def disconnect(self, server_id: str) -> None:
        managed = self._servers.pop(server_id, None)
        if not managed or not managed.process:
            return
        try:
            shutdown = self._protocol.build_request("shutdown", None)
            await self._send_and_receive(server_id, shutdown)
            exit_notif = self._protocol.build_notification("exit", None)
            await self._send(server_id, exit_notif)
        except Exception as _exc:
            log_ignored(log, "servers.LspServerManager.disconnect", _exc)
        try:
            managed.process.terminate()
            await asyncio.wait_for(managed.process.wait(), timeout=5.0)
        except Exception:
            try:
                managed.process.kill()
            except Exception as _exc:
                log_ignored(log, "servers.LspServerManager.disconnect", _exc)
        log.info("LSP server disconnected", server=server_id)

    async def request(self, server_id: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        msg = self._protocol.build_request(method, params)
        return await self._send_and_receive(server_id, msg)

    async def notify(self, server_id: str, method: str, params: dict[str, Any] | None = None) -> None:
        msg = self._protocol.build_notification(method, params)
        await self._send(server_id, msg)

    async def _send(self, server_id: str, msg: dict[str, Any]) -> None:
        managed = self._servers.get(server_id)
        if not managed or not managed.process or not managed.process.stdin:
            return
        data = LspProtocol.encode_message(msg)
        managed.process.stdin.write(data)
        await managed.process.stdin.drain()

    async def _send_and_receive(self, server_id: str, msg: dict[str, Any]) -> dict[str, Any] | None:
        await self._send(server_id, msg)
        request_id = msg.get("id")
        managed = self._servers.get(server_id)
        if not managed or not managed.process or not managed.process.stdout:
            return None
        try:
            header = b""
            while True:
                byte = await managed.process.stdout.read(1)
                if not byte:
                    return None
                header += byte
                if header.endswith(b"\r\n\r\n"):
                    break
            content_length = 0
            for line in header.decode("utf-8").split("\r\n"):
                if line.lower().startswith("content-length:"):
                    content_length = int(line.split(":")[1].strip())
                    break
            if content_length == 0:
                return None
            body = await managed.process.stdout.readexactly(content_length)
            return LspProtocol.parse_message(body)
        except Exception as e:
            log.warning("LSP receive error", server=server_id, error=str(e))
            return None

    @staticmethod
    def _parse_capabilities(caps: dict[str, Any]) -> LspServerCapabilities:
        return LspServerCapabilities(
            completion_provider=caps.get("completionProvider"),
            hover_provider=caps.get("hoverProvider", False),
            definition_provider=caps.get("definitionProvider", False),
            references_provider=caps.get("referencesProvider", False),
            document_symbol_provider=caps.get("documentSymbolProvider", False),
            diagnostic_provider=caps.get("diagnosticProvider"),
            text_document_sync=caps.get("textDocumentSync", {}).get("change", 1) if isinstance(caps.get("textDocumentSync"), dict) else caps.get("textDocumentSync", 1),
        )

    async def shutdown_all(self) -> None:
        for sid in list(self._servers.keys()):
            await self.disconnect(sid)

    def get_status(self) -> dict[str, str]:
        return {sid: m.status for sid, m in self._servers.items()}
