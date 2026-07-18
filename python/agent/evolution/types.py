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

    def __post_init__(self) -> None:
        self.quality_score = max(0.0, min(1.0, self.quality_score))


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
    PLAN_QUALITY = "plan_quality"
    TOOL_SELECTION_QUALITY = "tool_selection_quality"
    REFLECTION_EFFECTIVENESS = "reflection_effectiveness"
    CONTEXT_COMPRESSION_SUCCESS = "context_compression_success"
    MEMORY_RETRIEVAL_HIT = "memory_retrieval_hit"


@dataclass
class LearningSignal:
    signal_type: SignalType = SignalType.POSITIVE
    tool_name: str | None = None
    quality: float = 0.5
    error: str | None = None
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)
    plan_steps: int = 0
    reflection_score: float = 0.0
    memory_hit: bool = False


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
    interaction_count: int = 0  # 拍快照时的交互计数，用于回滚验证差值（审计 E-01）
    tool_weights: dict[str, float] = field(default_factory=dict)
    reflection_max_retries: int = 2
    enable_deep_reflection: bool = True
    reason: str = ""
    rolled_back: bool = False
