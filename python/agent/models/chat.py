from pydantic import BaseModel, Field
from typing import Any


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    context_files: list[str] = Field(default_factory=list)
    images: list[str] = Field(default_factory=list)
    user_id: str | None = None
    strategy_name: str | None = None


class ChatResponse(BaseModel):
    content: str
    session_id: str
    trace_id: str | None = None
    intent: str = ""
    related_files: list[str] = Field(default_factory=list)
    tool_activities: list[dict[str, Any]] = Field(default_factory=list)
    tool_calls_made: int = 0
    rounds_used: int = 0
    quality_score: float = 0.0
    duration: float | None = None
    finish_reason: str = ""


class StreamChunk(BaseModel):
    type: str = "content"
    content: str = ""
    session_id: str = ""
    trace_id: str | None = None
    done: bool = False


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.1.0"
    python_version: str = ""
    uptime_seconds: float = 0.0
    llm_available: bool = False
    llm_model: str = ""


class StatusResponse(BaseModel):
    backend: str = "python"
    llm_model: str = ""
    memory_entries: int = 0
    active_sessions: int = 0
    skills_count: int = 0
