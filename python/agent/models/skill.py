from pydantic import BaseModel, Field
from typing import Any


class SkillMeta(BaseModel):
    name: str
    description: str = ""
    category: str = ""
    difficulty: str = "basic"
    enabled: bool = True
    parameters: dict[str, Any] = Field(default_factory=dict)


class SkillExecuteRequest(BaseModel):
    name: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    session_id: str = "default"


class SkillExecuteResponse(BaseModel):
    success: bool
    result: Any = None
    error: str | None = None
    duration_ms: float = 0.0
