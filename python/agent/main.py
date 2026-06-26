from contextlib import asynccontextmanager
import time
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response

from agent.api.chat import root_router, router as chat_router
from agent.api.cron import router as cron_router
from agent.api.evolution import router as evolution_router
from agent.api.llm import router as llm_router
from agent.api.memory import router as memory_router
from agent.api.plan import router as plan_router
from agent.api.sessions import router as sessions_router
from agent.api.skills import router as skills_router
from agent.api.compat import router as compat_router
from agent.api.trajectory import router as trajectory_router
from agent.config import AGENT_HOST, AGENT_PORT
from agent.core.logger import StructuredLogger

log = StructuredLogger("main")

engine = None

_request_metrics: dict[str, Any] = {
    "total_requests": 0,
    "total_errors": 0,
    "total_duration_ms": 0.0,
    "endpoint_counts": {},
    "start_time": time.time(),
}


class MetricsMiddleware:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.monotonic()
        path = scope.get("path", "unknown")
        method = scope.get("method", "GET")
        endpoint_key = f"{method} {path}"

        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                status = message.get("status", 200)
                _request_metrics["total_requests"] += 1
                _request_metrics["endpoint_counts"][endpoint_key] = (
                    _request_metrics["endpoint_counts"].get(endpoint_key, 0) + 1
                )
                if status >= 400:
                    _request_metrics["total_errors"] += 1
                duration = (time.monotonic() - start) * 1000
                _request_metrics["total_duration_ms"] += duration
                if duration > 1000:
                    log.warning("Slow request", endpoint=endpoint_key, duration_ms=f"{duration:.0f}", status=status)
            await send(message)

        await self.app(scope, receive, send_wrapper)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    from agent.core.engine import AgentEngine

    log.info("Python Agent starting...")
    engine = AgentEngine()
    await engine.initialize()
    log.info("Python Agent ready", host=AGENT_HOST, port=AGENT_PORT)
    yield
    log.info("Python Agent shutting down")
    engine = None


app = FastAPI(
    title="家百星 Agent API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(MetricsMiddleware)

app.include_router(root_router)
app.include_router(chat_router, prefix="/v1")
app.include_router(llm_router, prefix="/v1/llm/providers")
app.include_router(plan_router, prefix="/v1")
app.include_router(memory_router, prefix="/v1/memory")
app.include_router(skills_router, prefix="/v1/skills")
app.include_router(evolution_router, prefix="/v1/evolution")
app.include_router(cron_router, prefix="/v1/cron")
app.include_router(sessions_router, prefix="/v1/sessions")
app.include_router(compat_router, prefix="/api")
app.include_router(trajectory_router, prefix="/v1/trajectory")


@app.get("/v1/metrics")
async def get_metrics():
    total = _request_metrics["total_requests"]
    avg_latency = (_request_metrics["total_duration_ms"] / total) if total > 0 else 0.0
    uptime = time.time() - _request_metrics["start_time"]
    return {
        "total_requests": total,
        "total_errors": _request_metrics["total_errors"],
        "error_rate": round(_request_metrics["total_errors"] / total, 4) if total > 0 else 0.0,
        "avg_latency_ms": round(avg_latency, 2),
        "uptime_seconds": round(uptime, 1),
        "requests_per_second": round(total / uptime, 4) if uptime > 0 else 0.0,
        "top_endpoints": dict(
            sorted(_request_metrics["endpoint_counts"].items(), key=lambda x: x[1], reverse=True)[:10]
        ),
    }

_event_clients: set = set()


def broadcast_event(event: str, payload: dict) -> int:
    sent = 0
    for client in list(_event_clients):
        try:
            import asyncio
            asyncio.get_event_loop().create_task(client.send_json({"event": event, "payload": payload}))
            sent += 1
        except Exception:
            _event_clients.discard(client)
    return sent


@app.websocket("/")
async def ws_root(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            message = data.get("message", "") or data.get("input", "")
            if not message:
                await websocket.send_json({"type": "error", "content": "missing message"})
                continue
            if not engine:
                await websocket.send_json({"type": "error", "content": "engine not available", "done": True})
                continue

            session_id = data.get("session_id", data.get("conversation_id", "ws_root"))
            trace_id = data.get("trace_id", "")

            await websocket.send_json({
                "type": "stream_start",
                "session_id": session_id,
                "trace_id": trace_id,
            })

            try:
                result = await engine.process_input(
                    message=message,
                    session_id=session_id,
                )

                content = result.get("content", "")
                chunk_size = 20
                for i in range(0, len(content), chunk_size):
                    chunk = content[i:i + chunk_size]
                    await websocket.send_json({
                        "type": "stream_chunk",
                        "content": chunk,
                        "session_id": result.get("session_id", session_id),
                        "trace_id": result.get("trace_id", trace_id),
                    })

                await websocket.send_json({
                    "type": "stream_done",
                    "content": content,
                    "session_id": result.get("session_id", session_id),
                    "trace_id": result.get("trace_id", trace_id),
                    "done": True,
                })
            except Exception as e:
                await websocket.send_json({
                    "type": "error",
                    "content": str(e),
                    "trace_id": trace_id,
                    "done": True,
                })
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "content": str(e), "done": True})
        except Exception:
            pass


@app.websocket("/ws")
async def ws_explicit(websocket: WebSocket):
    await ws_root(websocket)


@app.websocket("/v1/events")
async def ws_events(websocket: WebSocket):
    await websocket.accept()
    _event_clients.add(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event", "")
            payload = data.get("payload", {})
            if event:
                for client in list(_event_clients):
                    if client != websocket:
                        try:
                            await client.send_json({"event": event, "payload": payload})
                        except Exception:
                            _event_clients.discard(client)
    except WebSocketDisconnect:
        _event_clients.discard(websocket)
    except Exception:
        _event_clients.discard(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "agent.main:app",
        host=AGENT_HOST,
        port=AGENT_PORT,
        reload=False,
    )
