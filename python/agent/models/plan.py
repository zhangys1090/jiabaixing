from pydantic import BaseModel, Field
from typing import Any


class PlanRequest(BaseModel):
    task: str
    session_id: str = "default"
    context: dict[str, Any] = Field(default_factory=dict)
    max_steps: int = 5


class PlanStep(BaseModel):
    step_id: int
    description: str
    tool: str | None = None
    tool_input: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[int] = Field(default_factory=list)


class PlanResponse(BaseModel):
    session_id: str
    trace_id: str | None = None
    steps: list[PlanStep] = Field(default_factory=list)
    reasoning: str = ""


class ExecuteRequest(BaseModel):
    session_id: str = "default"
    steps: list[PlanStep] = Field(default_factory=list)
    auto_proceed: bool = True


class ExecuteStepResult(BaseModel):
    step_id: int
    success: bool
    output: str = ""
    error: str | None = None
    duration_ms: float = 0.0


class ExecuteResponse(BaseModel):
    session_id: str
    trace_id: str | None = None
    results: list[ExecuteStepResult] = Field(default_factory=list)
    overall_success: bool = True


class EvaluateRequest(BaseModel):
    session_id: str = "default"
    task: str = ""
    results: list[ExecuteStepResult] = Field(default_factory=list)
    criteria: list[str] = Field(default_factory=lambda: ["correctness", "completeness"])


class EvaluateResponse(BaseModel):
    session_id: str
    trace_id: str | None = None
    score: float = 0.0
    passed: bool = False
    feedback: str = ""
    suggestions: list[str] = Field(default_factory=list)


class ReflectRequest(BaseModel):
    session_id: str = "default"
    task: str = ""
    plan: PlanResponse | None = None
    execution: ExecuteResponse | None = None
    evaluation: EvaluateResponse | None = None


class ReflectResponse(BaseModel):
    session_id: str
    trace_id: str | None = None
    reflection: str = ""
    improvements: list[str] = Field(default_factory=list)
    should_retry: bool = False
