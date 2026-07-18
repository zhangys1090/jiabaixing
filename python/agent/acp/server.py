"""ACP 服务器。

提供 ACP 协议的 HTTP 服务器实现：
  - FastAPI 路由挂载
  - JSON-RPC over HTTP 传输
  - 会话管理与并发控制
  - SSE 事件流支持

集成示例::

    from agent.acp.server import ACPServer

    server = ACPServer(agent_engine=engine)
    app = server.create_app()
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from agent.acp.entry import ACPEntry, ACPRequest, ACPResponse
from agent.core.logger import StructuredLogger

log = StructuredLogger("acp.server")


@dataclass
class ACPSession:
    id: str = ""
    created_at: float = 0.0
    last_active: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SSEEvent:
    event: str = "message"
    data: str = ""
    id: str = ""
    retry: int | None = None


class ACPServer:
    """ACP HTTP 服务器。"""

    def __init__(self, agent_engine: Any = None, max_sessions: int = 100, auth_manager: Any = None):
        self._entry = ACPEntry(agent_engine=agent_engine)
        self._sessions: dict[str, ACPSession] = {}
        self._max_sessions = max_sessions
        self._event_queues: dict[str, asyncio.Queue] = {}
        self._semaphore = asyncio.Semaphore(self._entry.get_capabilities().max_concurrent_requests)
        self._auth_manager = auth_manager

    @property
    def entry(self) -> ACPEntry:
        return self._entry

    def create_session(self, metadata: dict[str, Any] | None = None) -> ACPSession:
        if len(self._sessions) >= self._max_sessions:
            oldest = min(self._sessions.values(), key=lambda s: s.last_active)
            self._sessions.pop(oldest.id, None)
            self._event_queues.pop(oldest.id, None)
        session_id = uuid.uuid4().hex[:16]
        now = time.time()
        session = ACPSession(
            id=session_id,
            created_at=now,
            last_active=now,
            metadata=metadata or {},
        )
        self._sessions[session_id] = session
        self._event_queues[session_id] = asyncio.Queue(maxsize=100)
        log.info("ACP session created", session_id=session_id)
        return session

    def get_session(self, session_id: str) -> ACPSession | None:
        session = self._sessions.get(session_id)
        if session:
            session.last_active = time.time()
        return session

    def close_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
        self._event_queues.pop(session_id, None)

    async def handle_rpc(self, request_body: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
        async with self._semaphore:
            response = await self._entry.handle_request(request_body)
            if session_id and session_id in self._sessions:
                self._sessions[session_id].last_active = time.time()
            result: dict[str, Any] = {
                "jsonrpc": response.jsonrpc,
                "id": response.id,
            }
            if response.error is not None:
                result["error"] = response.error
            else:
                result["result"] = response.result
            return result

    async def push_event(self, session_id: str, event_type: str, data: Any) -> bool:
        queue = self._event_queues.get(session_id)
        if not queue:
            return False
        try:
            sse = SSEEvent(
                event=event_type,
                data=json.dumps(data, ensure_ascii=False) if not isinstance(data, str) else data,
                id=uuid.uuid4().hex[:8],
            )
            queue.put_nowait(sse)
            return True
        except asyncio.QueueFull:
            return False

    async def event_stream(self, session_id: str) -> AsyncIterator[str]:
        queue = self._event_queues.get(session_id)
        if not queue:
            return
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
                lines = [f"event: {event.event}"]
                if event.id:
                    lines.append(f"id: {event.id}")
                if event.retry is not None:
                    lines.append(f"retry: {event.retry}")
                lines.append(f"data: {event.data}")
                lines.append("")
                lines.append("")
                yield "\n".join(lines)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"

    def create_app(self) -> Any:
        try:
            from fastapi import FastAPI, Request
            from fastapi.responses import StreamingResponse, JSONResponse
        except ImportError:
            log.warning("FastAPI not available, ACP HTTP server disabled")
            return None

        app = FastAPI(title="Jiabaixing ACP Server", version="5.0.0")
        server = self

        @app.post("/rpc")
        async def rpc_endpoint(request: Request):
            body = await request.json()
            session_id = request.headers.get("X-Session-Id")
            result = await server.handle_rpc(body, session_id=session_id)
            return JSONResponse(content=result)

        @app.post("/sessions")
        async def create_session_endpoint(request: Request):
            body = await request.json() if await request.body() else {}
            session = server.create_session(metadata=body if isinstance(body, dict) else {})
            return JSONResponse(content={"sessionId": session.id})

        @app.get("/sessions/{session_id}/events")
        async def events_endpoint(session_id: str):
            if session_id not in server._sessions:
                return JSONResponse(content={"error": "Session not found"}, status_code=404)
            return StreamingResponse(
                server.event_stream(session_id),
                media_type="text/event-stream",
            )

        @app.delete("/sessions/{session_id}")
        async def close_session_endpoint(session_id: str):
            server.close_session(session_id)
            return JSONResponse(content={"status": "closed"})

        return app

    def get_stats(self) -> dict[str, Any]:
        return {
            "initialized": self._entry.is_initialized,
            "active_sessions": len(self._sessions),
            "max_sessions": self._max_sessions,
            "capabilities": self._entry.get_capabilities().methods,
        }
