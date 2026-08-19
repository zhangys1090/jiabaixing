from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from typing import Any

from agent.models.chat import (
    ChatRequest,
    ChatResponse,
    HealthResponse,
    StatusResponse,
    StreamChunk,
)
from agent.core.logger import log_ignored

router = APIRouter()
root_router = APIRouter()


def get_engine():
    from agent.main import engine
    return engine


def _engine_unavailable():
    return JSONResponse(
        status_code=503,
        content={"detail": "Agent engine not initialized"},
    )


@root_router.get("/health", response_model=HealthResponse)
async def health():
    import sys
    eng = get_engine()
    llm_available = await eng.llm.check_available() if (eng and eng.llm) else False
    return HealthResponse(
        status="ok",
        python_version=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        uptime_seconds=eng.uptime if eng else 0.0,
        llm_available=llm_available,
        llm_model=eng.llm.model if (eng and eng.llm) else "",
    )


@root_router.get("/v1/status", response_model=StatusResponse)
async def status():
    eng = get_engine()
    memory_entries = 0
    active_sessions = 0
    skills_count = 0

    if eng:
        try:
            if hasattr(eng, "memory") and eng.memory:
                stats = eng.memory.get_stats()
                memory_entries = stats.get("total_entries", 0)
        except Exception as _exc:
            log_ignored(None, "chat.status", _exc)
        try:
            if hasattr(eng, "session_store") and eng.session_store:
                active_sessions = len(eng.session_store.list_sessions())
        except Exception as _exc:
            log_ignored(None, "chat.status", _exc)
        try:
            if hasattr(eng, "tool_registry") and eng.tool_registry:
                skills_count = eng.tool_registry.size()
        except Exception as _exc:
            log_ignored(None, "chat.status", _exc)

    return StatusResponse(
        llm_model=eng.llm.model if (eng and eng.llm) else "",
        memory_entries=memory_entries,
        active_sessions=active_sessions,
        skills_count=skills_count,
    )


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    eng = get_engine()
    if not eng:
        return _engine_unavailable()
    use_loop = req.context_files and "use_loop" in req.context_files
    result = await eng.process_input(
        message=req.message,
        session_id=req.session_id,
        context_files=req.context_files,
        use_loop=use_loop,
        user_id=req.user_id,
        strategy_name=req.strategy_name,
    )
    return ChatResponse(**result)


@router.websocket("/stream/{session_id}")
async def stream_chat(websocket: WebSocket, session_id: str):
    await websocket.accept()
    eng = get_engine()
    try:
        while True:
            data = await websocket.receive_json()
            message = data.get("message", "")
            if not message:
                await websocket.send_json(StreamChunk(
                    type="error",
                    content="missing message",
                    session_id=session_id,
                    done=True,
                ).model_dump())
                continue

            ws_user_id = data.get("user_id")
            ws_strategy_name = data.get("strategy_name")
            ws_images = data.get("images")

            # P0: 优先使用 ConversationLoop.run_stream 获得富类型流式事件
            loop = getattr(eng, "conversation", None)
            if loop and hasattr(loop, "run_stream"):
                try:
                    async for event in loop.run_stream(
                        user_input=message,
                        session_id=session_id,
                        images=ws_images,
                    ):
                        _event_meta = dict(event.get("metadata", {}))
                        if "quality_score" in event:
                            _event_meta["quality_score"] = event["quality_score"]
                        for _top_key in ("rounds_used", "duration", "finish_reason", "tool_calls_made"):
                            if _top_key in event and _top_key not in _event_meta:
                                _event_meta[_top_key] = event[_top_key]
                        await websocket.send_json(StreamChunk(
                            type=event.get("type", "stream_chunk"),
                            content=event.get("content", ""),
                            session_id=session_id,
                            trace_id=event.get("trace_id"),
                            done=event.get("type") in ("stream_done", "error", "done"),
                            metadata=_event_meta,
                        ).model_dump())
                except Exception as e:
                    await websocket.send_json(StreamChunk(
                        type="error",
                        content=str(e),
                        session_id=session_id,
                        done=True,
                    ).model_dump())
                continue

            # 回退路径
            await websocket.send_json(StreamChunk(
                type="stream_start",
                content="",
                session_id=session_id,
                done=False,
            ).model_dump())

            try:
                ws_result = None
                last_stream_chunk = None
                if hasattr(eng, "process_input_stream"):
                    async for chunk in eng.process_input_stream(message, session_id):
                        last_stream_chunk = chunk
                        await websocket.send_json(StreamChunk(
                            type="stream_chunk",
                            content=chunk.get("content", ""),
                            session_id=session_id,
                            done=False,
                        ).model_dump())
                else:
                    ws_result = await eng.process_input(
                        message=message,
                        session_id=session_id,
                        user_id=ws_user_id,
                        strategy_name=ws_strategy_name,
                    )
                    content = ws_result.get("content", "")
                    chunk_size = 20
                    for i in range(0, len(content), chunk_size):
                        await websocket.send_json(StreamChunk(
                            type="stream_chunk",
                            content=content[i:i + chunk_size],
                            session_id=session_id,
                            done=False,
                        ).model_dump())

                stream_done_metadata = {}
                if isinstance(ws_result, dict):
                    for k in ("quality_score", "tool_calls_made", "rounds_used", "duration", "finish_reason"):
                        if k in ws_result:
                            stream_done_metadata[k] = ws_result[k]
                elif isinstance(last_stream_chunk, dict):
                    for k in ("quality_score", "tool_calls_made", "rounds_used", "duration", "finish_reason"):
                        if k in last_stream_chunk:
                            stream_done_metadata[k] = last_stream_chunk[k]
                    _meta = last_stream_chunk.get("metadata", {})
                    for k in ("quality_score", "tool_calls_made", "rounds_used", "duration", "finish_reason"):
                        if k not in stream_done_metadata and k in _meta:
                            stream_done_metadata[k] = _meta[k]
                await websocket.send_json(StreamChunk(
                    type="stream_done",
                    content="",
                    session_id=session_id,
                    done=True,
                    metadata=stream_done_metadata,
                ).model_dump())
            except Exception as e:
                await websocket.send_json(StreamChunk(
                    type="error",
                    content=str(e),
                    session_id=session_id,
                    done=True,
                ).model_dump())

    except WebSocketDisconnect as _exc:
        log_ignored(None, "chat.stream_chat", _exc)
