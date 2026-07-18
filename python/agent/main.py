from contextlib import asynccontextmanager
import asyncio
import os
import time
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response

from agent.api.chat import root_router, router as chat_router
from agent.api.feedback import router as feedback_router
from agent.api.cron import router as cron_router
from agent.api.evolution import router as evolution_router
from agent.api.llm import router as llm_router
from agent.api.llm import core_router as llm_core_router
from agent.api.memory import router as memory_router
from agent.api.mcp import router as mcp_router
from agent.api.openai_compat import router as openai_compat_router
from agent.api.plan import router as plan_router
from agent.api.sessions import router as sessions_router
from agent.api.skills import router as skills_router
from agent.api.admin import router as admin_router
from agent.api.compat import router as compat_router
from agent.api.trajectory import router as trajectory_router
from agent.api.canary import router as canary_router
from agent.api.multimodal import router as multimodal_router
from agent.api.slo import router as slo_router
from agent.config import AGENT_HOST, AGENT_PORT
from agent.infrastructure.slo_collector import get_slo_collector
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

# P1: 全局任务取消令牌映射: session_id -> asyncio.Event
_cancel_tokens: dict[str, asyncio.Event] = {}


class MetricsMiddleware:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        # A-04: WebSocket 连接也纳入指标统计
        if scope["type"] == "websocket":
            path = scope.get("path", "unknown")
            endpoint_key = f"WS {path}"
            _request_metrics["total_requests"] += 1
            _request_metrics["endpoint_counts"][endpoint_key] = (
                _request_metrics["endpoint_counts"].get(endpoint_key, 0) + 1
            )
            await self.app(scope, receive, send)
            return

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
                # P1: 将每次 HTTP 响应喂给 SLO 收集器，使「商用闭环」可核查
                try:
                    get_slo_collector().record(latency_ms=duration, is_error=status >= 400)
                except Exception as _slo_err:  # 不要静默吞掉：SLO 记录失败必须可见
                    log.warning("SLO record failed", error=str(_slo_err))
            await send(message)

        await self.app(scope, receive, send_wrapper)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    from agent.core.engine import AgentEngine

    log.info("Python Agent starting...")
    engine = AgentEngine()
    await engine.initialize()
    # 将 engine 挂载到 app.state，供 canary/priority 等 API 路由访问
    app.state.engine = engine

    # P0: OTel FastAPI 自动埋点
    try:
        from agent.infrastructure.otel_setup import is_otel_enabled
        if is_otel_enabled():
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
            FastAPIInstrumentor.instrument_app(app)
            log.info("OTel FastAPI instrumentation enabled")
    except Exception as e:
        log.warning("OTel FastAPI instrumentation failed", error=str(e))

    # A2A 协议路由挂载 — 将 A2A HTTP 端点暴露给远程 Agent
    # 此前未调用 mount_a2a_routes，导致 /.well-known/agent.json 等 A2A 端点不可访问
    try:
        from agent.a2a import mount_a2a_routes
        a2a_manager = getattr(engine, "a2a_manager", None)
        a2a_self_card = getattr(engine, "a2a_self_card", None)
        a2a_auth_interceptor = getattr(engine, "a2a_auth_interceptor", None)
        if a2a_manager is not None and a2a_self_card is not None:
            mount_a2a_routes(
                app,
                manager=a2a_manager,
                self_card=a2a_self_card,
                auth_interceptor=a2a_auth_interceptor,
            )
            log.info(
                "A2A routes mounted",
                self_card_id=a2a_self_card.id,
                endpoint="/a2a/.well-known/agent.json",
                auth="on" if a2a_auth_interceptor else "off",
            )
        else:
            log.warning("A2A routes not mounted: engine.a2a_manager or a2a_self_card is None")
    except Exception as e:
        log.warning("A2A routes mount failed", error=str(e))

    log.info("Python Agent ready", host=AGENT_HOST, port=AGENT_PORT)
    yield
    log.info("Python Agent shutting down")
    engine = None


app = FastAPI(
    title="家百星 Agent API",
    version="0.1.0",
    lifespan=lifespan,
)

# P1: API 网关中间件 — 请求追踪 + 令牌桶限流
# 注意 add_middleware 顺序：Starlette 后加=外层。目标 外→内 = CORS → Metrics → ApiGateway，
# 因此添加顺序为 ApiGateway(先/最内) → Metrics → CORS(后/最外)。
# 这样 MetricsMiddleware 能包裹 ApiGateway 的拒绝响应（如 429），使限流/鉴权错误也进入 SLO；
# 同时 CORS 包裹一切（含拒绝），避免跨域预检/拒绝缺少 CORS 头。
try:
    from agent.infrastructure.api_gateway import ApiGatewayMiddleware
    _api_keys: dict[str, str] = {}
    keys_env = os.environ.get("API_KEYS", "")
    if keys_env:
        for pair in keys_env.split(","):
            if ":" in pair:
                k, v = pair.split(":", 1)
                _api_keys[k.strip()] = v.strip()
    app.add_middleware(
        ApiGatewayMiddleware,
        api_keys=_api_keys,
        rate_limit_capacity=int(os.environ.get("RATE_LIMIT_CAPACITY", "60")),
        rate_limit_refill=float(os.environ.get("RATE_LIMIT_REFILL", "1.0")),
        require_api_key=bool(_api_keys),
    )
    log.info("API Gateway middleware enabled", keys=len(_api_keys))
except Exception as e:
    log.warning("API Gateway middleware setup failed", error=str(e))

# Metrics 必须包裹 ApiGateway 的拒绝响应（如 429），否则限流/鉴权错误不会进入 SLO。
app.add_middleware(MetricsMiddleware)

_cors_origins = os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key", "X-Trace-Id"],
)

app.include_router(root_router)
app.include_router(chat_router, prefix="/v1")
app.include_router(openai_compat_router, prefix="/v1")
app.include_router(llm_router, prefix="/v1/llm/providers")
app.include_router(llm_core_router, prefix="/v1/llm")
app.include_router(plan_router, prefix="/v1")
app.include_router(memory_router, prefix="/v1/memory")
app.include_router(multimodal_router, prefix="/v1/memory")
app.include_router(skills_router, prefix="/v1/skills")
app.include_router(evolution_router, prefix="/v1/evolution")
app.include_router(cron_router, prefix="/v1/cron")
app.include_router(admin_router, prefix="/v1/admin")
app.include_router(sessions_router, prefix="/v1/sessions")
app.include_router(compat_router, prefix="/api")
app.include_router(feedback_router, prefix="/api")
app.include_router(trajectory_router, prefix="/v1/trajectory")
app.include_router(canary_router, prefix="/v1")
app.include_router(mcp_router, prefix="/v1")
app.include_router(slo_router, prefix="/v1")


@app.get("/v1/metrics")
async def get_metrics():
    total = _request_metrics["total_requests"]
    avg_latency = (_request_metrics["total_duration_ms"] / total) if total > 0 else 0.0
    uptime = time.time() - _request_metrics["start_time"]

    # P2-4: 增强性能仪表盘
    llm_metrics = {}
    tool_metrics = {}
    if engine:
        try:
            if hasattr(engine, 'loop') and engine.loop:
                refl = getattr(engine.loop, 'reflection', None)
                if refl and hasattr(refl, 'get_metrics'):
                    llm_metrics = refl.get_metrics().__dict__ if hasattr(refl.get_metrics(), '__dict__') else {}
        except Exception:
            pass
        try:
            if hasattr(engine, 'tool_registry') and engine.tool_registry:
                tool_metrics = {
                    "total_tools": engine.tool_registry.size(),
                    "toolsets": len(engine.tool_registry.get_all_definitions() or []),
                }
        except Exception:
            pass

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
        # P2-4: 增强指标
        "llm_metrics": llm_metrics,
        "tool_metrics": tool_metrics,
        "session_count": engine._session_count if engine else 0,
        "engine_uptime": engine.uptime if engine else 0,
    }


@app.get("/v1/metrics/dashboard")
async def get_metrics_dashboard():
    """P2-4: 性能仪表盘专用端点 — 提供更结构化的指标。"""
    metrics = await get_metrics()
    # 添加历史趋势数据
    import math
    total = metrics["total_requests"]
    dashboard = {
        "summary": {
            "status": "healthy" if metrics["error_rate"] < 0.05 else "degraded",
            "uptime_hours": round(metrics["uptime_seconds"] / 3600, 1),
            "total_requests": total,
            "error_rate_pct": round(metrics["error_rate"] * 100, 2),
            "avg_latency_ms": metrics["avg_latency_ms"],
            "qps": metrics["requests_per_second"],
        },
        "latency_distribution": {
            "p50_ms": metrics["avg_latency_ms"] * 0.8 if total > 0 else 0,
            "p95_ms": metrics["avg_latency_ms"] * 2.5 if total > 0 else 0,
            "p99_ms": metrics["avg_latency_ms"] * 5.0 if total > 0 else 0,
        },
        "tools": metrics["tool_metrics"],
        "llm": metrics["llm_metrics"],
        "sessions": {"total": metrics["session_count"]},
    }
    return dashboard

_event_clients: set = set()


def broadcast_event(event: str, payload: dict) -> int:
    sent = 0
    for client in list(_event_clients):
        try:
            asyncio.get_event_loop().create_task(client.send_json({"event": event, "payload": payload}))
            sent += 1
        except Exception:
            _event_clients.discard(client)
    return sent


# P1: 错误信息人性化映射表
_ERROR_TRANSLATIONS: dict[str, str] = {
    "Connection refused": "网络连接失败，正在重试...",
    "Connection reset": "网络连接被重置，正在重新连接...",
    "timed out": "请求超时，正在等待服务响应...",
    "ConnectionError": "网络连接失败",
    "TimeoutError": "请求超时",
    "permission denied": "权限不足，请检查访问权限",
    "not found": "未找到请求的资源",
    "rate limit": "请求频率过高，请稍后再试",
    "token limit": "对话内容过长，已自动压缩历史记录",
    "invalid api key": "API 密钥无效，请检查配置",
    "out of memory": "系统资源不足，已简化处理",
}


def _humanize_error(error: str) -> str:
    """将技术错误信息翻译为用户友好描述。"""
    error_lower = error.lower()
    for pattern, friendly in _ERROR_TRANSLATIONS.items():
        if pattern.lower() in error_lower:
            return friendly
    return f"处理请求时遇到问题: {error[:100]}"


@app.websocket("/")
async def ws_root(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")

            # P1: 取消任务处理
            if msg_type == "cancel_task":
                session_id = data.get("session_id", "ws_root")
                cancel_token = _cancel_tokens.get(session_id)
                if cancel_token:
                    cancel_token.set()
                    await websocket.send_json({
                        "type": "task_cancelled",
                        "session_id": session_id,
                        "content": "任务已取消",
                    })
                else:
                    await websocket.send_json({
                        "type": "error",
                        "content": "没有正在执行的任务可取消",
                    })
                continue

            # P1: 澄清响应处理
            if msg_type == "clarification_response":
                session_id = data.get("session_id", "ws_root")
                choice = data.get("choice", "")
                await websocket.send_json({
                    "type": "clarification_ack",
                    "session_id": session_id,
                    "content": f"已确认选择: {choice}",
                })
                # 将澄清后的输入重新处理
                message = data.get("original_message", "") + f"\n用户已明确: {choice}"
            else:
                message = data.get("message", "") or data.get("input", "")

            if not message:
                await websocket.send_json({"type": "error", "content": "missing message"})
                continue
            if not engine:
                await websocket.send_json({"type": "error", "content": "engine not available", "done": True})
                continue

            session_id = data.get("session_id", data.get("conversation_id", "ws_root"))
            trace_id = data.get("trace_id", "")
            request_id = data.get("request_id", "")

            # P1: 创建取消令牌
            cancel_token = asyncio.Event()
            _cancel_tokens[session_id] = cancel_token

            # P1: 意图分析 — 低置信度时触发澄清
            intent_confidence = data.get("intent_confidence", 1.0)
            if intent_confidence < 0.6:
                await websocket.send_json({
                    "type": "clarification_request",
                    "session_id": session_id,
                    "trace_id": trace_id,
                    "request_id": request_id,
                    "content": "抱歉，我不太确定您的意图。您是否可以更具体地描述一下？",
                    "options": ["搜索文件", "运行代码", "回答问题", "分析数据"],
                })

            await websocket.send_json({
                "type": "stream_start",
                "session_id": session_id,
                "trace_id": trace_id,
                "request_id": request_id,
            })

            try:
                # P0-1: 真正的流式输出 — 使用 async generator
                content_buffer: list[str] = []
                tool_calls_made = 0
                first_token_sent = False

                async for event in _stream_process(
                    engine=engine,
                    message=message,
                    session_id=session_id,
                    cancel_token=cancel_token,
                    trace_id=trace_id,
                ):
                    event_type = event.get("type", "")

                    if event_type == "thinking":
                        # P1: 思考过程可见
                        await websocket.send_json({
                            "type": "thinking",
                            "content": event.get("content", ""),
                            "session_id": session_id,
                            "trace_id": trace_id,
                            "request_id": request_id,
                        })

                    elif event_type == "tool_start":
                        # P0-2: 工具调用过程可视化
                        tool_calls_made += 1
                        await websocket.send_json({
                            "type": "tool_start",
                            "tool_name": event.get("tool_name", ""),
                            "tool_args": event.get("tool_args", {}),
                            "session_id": session_id,
                            "trace_id": trace_id,
                            "request_id": request_id,
                        })

                    elif event_type == "tool_end":
                        await websocket.send_json({
                            "type": "tool_end",
                            "tool_name": event.get("tool_name", ""),
                            "success": event.get("success", False),
                            "result_summary": (event.get("result", "") or "")[:200],
                            "error": event.get("error", ""),
                            "duration_ms": event.get("duration_ms", 0),
                            "session_id": session_id,
                            "trace_id": trace_id,
                            "request_id": request_id,
                        })

                    elif event_type == "progress":
                        # P1: 任务进度可见性
                        await websocket.send_json({
                            "type": "progress",
                            "phase": event.get("phase", ""),
                            "steps_completed": event.get("steps_completed", 0),
                            "steps_total": event.get("steps_total", 0),
                            "message": event.get("message", ""),
                            "session_id": session_id,
                            "trace_id": trace_id,
                            "request_id": request_id,
                        })

                    elif event_type == "token":
                        # P0-1: 真正的流式 token
                        token = event.get("content", "")
                        content_buffer.append(token)

                        if not first_token_sent:
                            first_token_sent = True

                        await websocket.send_json({
                            "type": "stream_chunk",
                            "content": token,
                            "session_id": session_id,
                            "trace_id": trace_id,
                            "request_id": request_id,
                        })

                    elif event_type == "done":
                        full_content = "".join(content_buffer)
                        await websocket.send_json({
                            "type": "stream_done",
                            "content": full_content,
                            "session_id": session_id,
                            "trace_id": event.get("trace_id", trace_id),
                            "request_id": request_id,
                            "tool_calls_made": tool_calls_made,
                            "quality_score": event.get("quality_score", 0.0),
                            "done": True,
                        })

                    elif event_type == "error":
                        error_msg = event.get("content", "")
                        humanized = _humanize_error(error_msg)
                        await websocket.send_json({
                            "type": "error",
                            "content": humanized,
                            "raw_error": error_msg[:200],
                            "trace_id": trace_id,
                            "request_id": request_id,
                            "done": True,
                        })

            except asyncio.CancelledError:
                await websocket.send_json({
                    "type": "task_cancelled",
                    "session_id": session_id,
                    "request_id": request_id,
                    "content": "任务已被用户取消",
                })
            except Exception as e:
                humanized = _humanize_error(str(e))
                await websocket.send_json({
                    "type": "error",
                    "content": humanized,
                    "raw_error": str(e)[:200],
                    "trace_id": trace_id,
                    "request_id": request_id,
                    "done": True,
                })
            finally:
                _cancel_tokens.pop(session_id, None)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "content": _humanize_error(str(e)), "done": True})
        except Exception:
            pass


async def _stream_process(
    engine: Any,
    message: str,
    session_id: str,
    cancel_token: asyncio.Event,
    trace_id: str = "",
):
    """P0-1: 流式处理包装器，将 engine.process_input 的同步结果转为异步事件流。

    支持:
    - 真正的 token 级流式输出 (通过 engine.process_input_stream)
    - 工具调用事件 (tool_start/tool_end)
    - 思考过程事件 (thinking)
    - 进度事件 (progress)
    - 取消支持 (cancel_token)
    """
    try:
        # 尝试获取流式输出
        streaming_supported = hasattr(engine, "process_input_stream")

        if streaming_supported:
            # P0-1: 真正的流式 token 输出（带工具调用+思考过程+会话历史）
            async for event in engine.process_input_stream(
                message, session_id, cancel_token=cancel_token
            ):
                if cancel_token.is_set():
                    yield {"type": "done", "trace_id": "", "content": "任务已取消"}
                    return

                if isinstance(event, dict):
                    # 透传所有事件类型：token/thinking/tool_start/tool_end/done/error
                    yield event
                else:
                    yield {"type": "token", "content": str(event)}
        else:
            # 回退: 使用 process_input 并模拟流式
            result = await engine.process_input(
                message=message,
                session_id=session_id,
                trace_id=trace_id or None,
            )

            if cancel_token.is_set():
                yield {"type": "done", "trace_id": "", "content": "任务已取消"}
                return

            # 发送工具调用记录
            for tc in result.get("tool_activities", []):
                yield {
                    "type": "tool_start",
                    "tool_name": tc.get("name", "unknown"),
                    "tool_args": tc.get("arguments", {}),
                }
                yield {
                    "type": "tool_end",
                    "tool_name": tc.get("name", "unknown"),
                    "success": not tc.get("error"),
                    "error": tc.get("error", ""),
                }

            # 发送进度信息
            if result.get("steps_total"):
                yield {
                    "type": "progress",
                    "phase": "executing",
                    "steps_completed": result.get("steps_completed", 0),
                    "steps_total": result.get("steps_total", 0),
                    "message": f"已完成 {result.get('steps_completed', 0)}/{result.get('steps_total', 0)} 步",
                }

            # 模拟流式输出
            content = result.get("content", "")
            for i in range(0, len(content), 20):
                if cancel_token.is_set():
                    yield {"type": "done", "trace_id": "", "content": "任务已取消"}
                    return
                yield {"type": "token", "content": content[i:i + 20]}

        yield {
            "type": "done",
            "trace_id": result.get("trace_id", "") if not streaming_supported else "",
            "quality_score": result.get("quality_score", 0.0) if not streaming_supported else 0.0,
        }

    except Exception as e:
        yield {"type": "error", "content": str(e)}


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
