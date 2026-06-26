from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class EvolutionType(str, Enum):
    PROMPT_OPTIMIZATION = "prompt_optimization"
    TOOL_WEIGHT_ADJUSTMENT = "tool_weight_adjustment"
    SELF_MODIFICATION = "self_modification"
    CONFIG_TUNING = "config_tuning"
    PROACTIVE_IMPROVEMENT = "proactive_improvement"


class EvolutionPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class EvolutionCause(str, Enum):
    LOW_QUALITY = "low_quality"
    TOOL_FAILURE = "tool_failure"
    REPEATED_QUESTION = "repeated_question"
    USER_CORRECTION = "user_correction"
    PROACTIVE = "proactive"


@dataclass
class FeedbackSignal:
    interaction_id: str = ""
    quality_score: float = 0.0
    cause: str = ""
    tool_name: str | None = None
    error: str | None = None
    user_correction: bool = False
    timestamp: float = 0.0
    tools_used: list[str] = field(default_factory=list)
    tool_successes: dict[str, bool] = field(default_factory=dict)
    tool_durations_ms: dict[str, float] = field(default_factory=dict)
    session_id: str = ""
    scene: str = ""
    response_length: int = 0
    rounds_used: int = 0


@dataclass
class EvolutionAction:
    action_type: str = ""
    target: str = ""
    description: str = ""
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvolutionPlan:
    plan_id: str = ""
    evolution_type: str = ""
    priority: str = "medium"
    cause: str = ""
    actions: list[EvolutionAction] = field(default_factory=list)
    reasoning: str = ""


@dataclass
class EvolutionResult:
    plan_id: str = ""
    success: bool = False
    executed_actions: int = 0
    total_actions: int = 0
    duration_ms: float = 0.0
    error: str | None = None


@dataclass
class EvolutionMetrics:
    total_interactions: int = 0
    total_evolutions: int = 0
    successful_evolutions: int = 0
    average_quality: float = 0.0
    quality_trend: str = "stable"
    recent_quality_scores: list[float] = field(default_factory=list)
    tool_weights: dict[str, float] = field(default_factory=dict)
    prompt_examples: list[dict[str, str]] = field(default_factory=list)


class SignalType(str, Enum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    TASK_SUCCESS = "task_success"
    TASK_FAILURE = "task_failure"


@dataclass
class LearningSignal:
    signal_type: SignalType = SignalType.POSITIVE
    tool_name: str | None = None
    quality: float = 0.5
    error: str | None = None
    timestamp: float = 0.0


@dataclass
class ReflectionConfig:
    enable_deep_reflection: bool = True
    max_retries: int = 2


@dataclass
class RollbackSnapshot:
    """验证回滚快照: 优化前的状态基线。"""
    cycle_id: str
    timestamp: float
    avg_quality: float
    avg_response_time_ms: float
    tool_weights: dict[str, float] = field(default_factory=dict)
    reflection_max_retries: int = 2
    enable_deep_reflection: bool = True
    reason: str = ""
    rolled_back: bool = False
