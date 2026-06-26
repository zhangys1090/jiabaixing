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
    llm_available = await eng.llm.check_available() if eng else False
    return HealthResponse(
        status="ok",
        python_version=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        uptime_seconds=eng.uptime if eng else 0.0,
        llm_available=llm_available,
        llm_model=eng.llm.model if eng else "",
    )


@root_router.get("/v1/status", response_model=StatusResponse)
async def status():
    eng = get_engine()
    return StatusResponse(
        llm_model=eng.llm.model if eng else "",
        memory_entries=0,
        active_sessions=0,
        skills_count=0,
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

            trace_id = data.get("trace_id", "")

            await websocket.send_json(StreamChunk(
                type="stream_start",
                content="",
                session_id=session_id,
                done=False,
            ).model_dump())

            try:
                if hasattr(eng, "process_input_stream"):
                    async for chunk in eng.process_input_stream(message, session_id):
                        await websocket.send_json(StreamChunk(
                            type="stream_chunk",
                            content=chunk.get("content", ""),
                            session_id=session_id,
                            done=False,
                        ).model_dump())
                else:
                    result = await eng.process_input(
                        message=message,
                        session_id=session_id,
                    )
                    content = result.get("content", "")
                    chunk_size = 20
                    for i in range(0, len(content), chunk_size):
                        await websocket.send_json(StreamChunk(
                            type="stream_chunk",
                            content=content[i:i + chunk_size],
                            session_id=session_id,
                            done=False,
                        ).model_dump())

                await websocket.send_json(StreamChunk(
                    type="stream_done",
                    content="",
                    session_id=session_id,
                    done=True,
                ).model_dump())
            except Exception as e:
                await websocket.send_json(StreamChunk(
                    type="error",
                    content=str(e),
                    session_id=session_id,
                    done=True,
                ).model_dump())

    except WebSocketDisconnect:
        pass
