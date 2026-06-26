from pydantic import BaseModel, Field
from typing import Any


class EvolutionFeedbackRequest(BaseModel):
    session_id: str = "default"
    tool_name: str = ""
    success: bool = True
    duration_ms: float = 0.0
    user_rating: float | None = None
    context: dict[str, Any] = Field(default_factory=dict)


class EvolutionStatusResponse(BaseModel):
    total_feedback: int = 0
    total_interactions: int = 0
    avg_success_rate: float = 0.0
    average_quality: float = 0.0
    quality_trend: str = "stable"
    tool_weights: dict[str, float] = Field(default_factory=dict)
    top_performing_tools: list[dict[str, Any]] = Field(default_factory=list)
    bottom_performing_tools: list[dict[str, Any]] = Field(default_factory=list)
    evolution_cycles: int = 0
    last_evolution: str | None = None


class EvolutionTriggerRequest(BaseModel):
    force: bool = False
    focus_area: str | None = None


class EvolutionTriggerResponse(BaseModel):
    triggered: bool
    changes_made: int = 0
    details: str = ""
