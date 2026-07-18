"""ACP 入口点。

Agent Communication Protocol 的 Python 侧入口：
  - 启动 ACP JSON-RPC 服务（stdio / HTTP）
  - 请求路由与分发
  - 生命周期管理（initialize / shutdown）

集成示例::

    from agent.acp.entry import ACPEntry

    entry = ACPEntry(agent_engine=engine)
    await entry.start_stdio()
"""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger

log = StructuredLogger("acp.entry")


@dataclass
class ACPCapabilities:
    methods: list[str] = field(default_factory=lambda: [
        "initialize", "shutdown",
        "chat/send", "chat/stream",
        "file/read", "file/edit", "file/diffs",
        "terminal/execute", "terminal/stream",
        "tools/list", "tools/activity",
    ])
    file_operations: dict[str, bool] = field(default_factory=lambda: {
        "read": True, "write": True, "diff": True,
    })
    terminal_operations: dict[str, bool] = field(default_factory=lambda: {
        "execute": True, "stream": True,
    })
    max_concurrent_requests: int = 10


@dataclass
class ACPRequest:
    jsonrpc: str = "2.0"
    id: int | str | None = None
    method: str = ""
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class ACPResponse:
    jsonrpc: str = "2.0"
    id: int | str | None = None
    result: Any = None
    error: dict[str, Any] | None = None


class ACPEntry:
    """ACP 协议入口。"""

    def __init__(self, agent_engine: Any = None):
        self._engine = agent_engine
        self._capabilities = ACPCapabilities()
        self._initialized = False
        self._handlers: dict[str, Callable[..., Awaitable[Any]]] = {}
        self._request_counter = 0
        self._register_default_handlers()

    def _register_default_handlers(self) -> None:
        self._handlers["initialize"] = self._handle_initialize
        self._handlers["shutdown"] = self._handle_shutdown
        self._handlers["chat/send"] = self._handle_chat_send
        self._handlers["file/read"] = self._handle_file_read
        self._handlers["file/diffs"] = self._handle_file_diffs
        self._handlers["tools/list"] = self._handle_tools_list

    def register_handler(self, method: str, handler: Callable[..., Awaitable[Any]]) -> None:
        self._handlers[method] = handler

    async def handle_request(self, raw: str | bytes | dict[str, Any]) -> ACPResponse:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        if isinstance(raw, str):
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as e:
                return ACPResponse(id=None, error={"code": -32700, "message": f"Parse error: {e}"})
        else:
            data = raw

        request = ACPRequest(
            jsonrpc=data.get("jsonrpc", "2.0"),
            id=data.get("id"),
            method=data.get("method", ""),
            params=data.get("params", {}),
        )

        if not self._initialized and request.method != "initialize":
            return ACPResponse(
                id=request.id,
                error={"code": -32002, "message": "Server not initialized"},
            )

        handler = self._handlers.get(request.method)
        if not handler:
            return ACPResponse(
                id=request.id,
                error={"code": -32601, "message": f"Method not found: {request.method}"},
            )

        try:
            result = await handler(request.params)
            return ACPResponse(id=request.id, result=result)
        except Exception as e:
            log.warning("ACP handler error", method=request.method, error=str(e))
            return ACPResponse(id=request.id, error={"code": -32603, "message": str(e)})

    async def _handle_initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        self._initialized = True
        return {
            "capabilities": {
                "methods": self._capabilities.methods,
                "fileOperations": self._capabilities.file_operations,
                "terminalOperations": self._capabilities.terminal_operations,
                "maxConcurrentRequests": self._capabilities.max_concurrent_requests,
            },
            "serverInfo": {
                "name": "jiabaixing-agent",
                "version": "5.0.0",
            },
        }

    async def _handle_shutdown(self, params: dict[str, Any] = None) -> dict[str, Any]:
        self._initialized = False
        return {}

    async def _handle_chat_send(self, params: dict[str, Any]) -> dict[str, Any]:
        message = params.get("message", "")
        session_id = params.get("sessionId", "default")
        if self._engine and hasattr(self._engine, "chat"):
            try:
                response = await self._engine.chat(message, session_id=session_id)
                return {"content": str(response), "sessionId": session_id}
            except Exception as e:
                return {"content": "", "error": str(e)}
        return {"content": message, "sessionId": session_id}

    async def _handle_file_read(self, params: dict[str, Any]) -> dict[str, Any]:
        path = params.get("path", "")
        try:
            from agent.security.path_security import PathSecurity
            path_sec = PathSecurity()
            check = path_sec.check_path(path)
            if not check.is_safe:
                return {"content": "", "error": f"路径安全检查失败: {check.reason}"}

            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            return {"content": content, "path": path}
        except Exception as e:
            return {"content": "", "error": str(e)}

    async def _handle_file_diffs(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = params.get("sessionId", "default")
        return {"diffs": [], "sessionId": session_id}

    async def _handle_tools_list(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._engine and hasattr(self._engine, "tool_registry"):
            try:
                tools = self._engine.tool_registry.list_tools()
                return {"tools": [t if isinstance(t, dict) else {"name": str(t)} for t in tools]}
            except Exception:
                pass
        return {"tools": []}

    async def start_stdio(self) -> None:
        log.info("ACP starting in stdio mode")
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        writer_transport, writer_protocol = await loop.connect_write_pipe(
            asyncio.streams.FlowControlMixin, sys.stdout
        )
        writer = asyncio.StreamWriter(writer_transport, writer_protocol, reader, loop)

        while True:
            try:
                header = b""
                while True:
                    byte = await reader.read(1)
                    if not byte:
                        return
                    header += byte
                    if header.endswith(b"\r\n\r\n"):
                        break
                content_length = 0
                for line in header.decode("utf-8").split("\r\n"):
                    if line.lower().startswith("content-length:"):
                        content_length = int(line.split(":")[1].strip())
                        break
                if content_length == 0:
                    continue
                body = await reader.readexactly(content_length)
                response = await self.handle_request(body)
                response_json = json.dumps({
                    "jsonrpc": response.jsonrpc,
                    "id": response.id,
                    **({"result": response.result} if response.error is None else {"error": response.error}),
                }, ensure_ascii=False).encode("utf-8")
                header_str = f"Content-Length: {len(response_json)}\r\n\r\n"
                writer.write(header_str.encode("utf-8") + response_json)
                await writer.drain()
            except asyncio.IncompleteReadError:
                return
            except Exception as e:
                log.warning("ACP stdio error", error=str(e))

    def get_capabilities(self) -> ACPCapabilities:
        return self._capabilities

    @property
    def is_initialized(self) -> bool:
        return self._initialized
