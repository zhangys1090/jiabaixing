from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class LoopState(str, Enum):
    IDLE = "idle"
    PLANNING = "planning"
    EXECUTING = "executing"
    EVALUATING = "evaluating"
    REPORTING = "reporting"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class PlanStep:
    step_id: str
    description: str
    tool_name: str | None = None
    tool_params: dict[str, Any] = field(default_factory=dict)
    retry_count: int = 0
    max_retries: int = 2
    status: str = "pending"
    # 工具链编排：指定从哪个步骤的输出获取输入
    # 格式："step:<step_id>" 或 "result:<step_id>"（取 StepResult.content）
    # 执行时自动将前序步骤的输出注入当前步骤的参数
    input_from_step: str | None = None
    # 指定将上游输出注入到当前参数的哪个字段名（默认 "input"）
    input_param_name: str = "input"


@dataclass
class ExecutionPlan:
    steps: list[PlanStep] = field(default_factory=list)
    reasoning: str = ""
    simple: bool = False
    tool_call_mode: str = "auto"
    recommended_tools: list[str] = field(default_factory=list)


@dataclass
class BudgetState:
    max_rounds: int = 5
    max_tool_calls: int = 20
    max_tokens: int = 8000
    max_duration_ms: int = 120000
    rounds_used: int = 0
    tokens_used: int = 0
    tool_calls_used: int = 0
    start_time: float = 0.0


@dataclass
class StepResult:
    step_id: str
    success: bool
    content: str = ""
    tool_name: str | None = None
    error: str | None = None
    duration_ms: float = 0.0


@dataclass
class LoopContext:
    user_input: str = ""
    session_id: str = "default"
    messages: list[dict[str, str]] = field(default_factory=list)
    plan: ExecutionPlan | None = None
    current_step_index: int = 0
    budget: BudgetState = field(default_factory=BudgetState)
    step_results: dict[str, StepResult] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    trace_id: str = ""
    # 任务取消事件：设置后主循环和 executor 会在下一个检查点中止
    cancel_event: "asyncio.Event | None" = None
    # 灰度发布：用户标识和策略名称，传递到 llm.chat() 用于哈希分桶选择版本
    user_id: str | None = None
    strategy_name: str | None = None

    def is_cancelled(self) -> bool:
        """检查任务是否已被取消"""
        return self.cancel_event is not None and self.cancel_event.is_set()


@dataclass
class EvaluatorOutput:
    goal_progress: float = 0.0
    suggested_action: str = "continue"
    reason: str = ""
    quality_score: float = 0.0
    step_success_rate: float = 0.0
    failure_analysis: str | None = None
    suggested_correction: str | None = None


@dataclass
class ExecutorOutput:
    messages: list[dict[str, str]] = field(default_factory=list)
    tool_calls_count: int = 0
    tool_duration: float = 0.0
    completed_naturally: bool = True
    step_results: list[StepResult] = field(default_factory=list)


@dataclass
class ReporterOutput:
    response: str = ""
    quality_score: float = 0.0
    steps_completed: int = 0
    steps_total: int = 0
    total_duration_ms: float = 0.0
    quality_breakdown: dict[str, float] = field(default_factory=dict)


@dataclass
class AgentResult:
    response: str = ""
    quality_score: float = 0.0
    trace_id: str = ""
    session_id: str = ""
    steps_completed: int = 0
    steps_total: int = 0
    success: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ReActThought:
    text: str
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    is_final: bool = False
    final_answer: str | None = None


@dataclass
class ReActActionResult:
    success: bool
    content: str | None = None
    error: str | None = None
    is_complete: bool = False


@dataclass
class StructuredReActStep:
    """P1: 结构化 ReAct 步骤 — 显式 JSON 结构替代 prompt 注入。

    每个步骤包含三个显式字段:
    - thought: 推理过程
    - action: 工具调用或最终回答
    - observation: 执行结果观察
    """

    thought: str = ""
    action: dict[str, Any] = field(default_factory=dict)
    observation: str = ""
    step_index: int = 0
    is_final: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "thought": self.thought,
            "action": self.action,
            "observation": self.observation,
            "step_index": self.step_index,
            "is_final": self.is_final,
        }

    def to_context_message(self) -> str:
        import json
        return json.dumps(self.to_dict(), ensure_ascii=False)


class LifecycleHook(str, Enum):
    BEFORE_LOOP = "before_loop"
    AFTER_PLAN = "after_plan"
    BEFORE_STEP = "before_step"
    AFTER_STEP = "after_step"
    AFTER_EVALUATE = "after_evaluate"
    AFTER_RESPONSE = "after_response"


@dataclass
class HookContext:
    hook: LifecycleHook
    loop_context: LoopContext
    data: dict[str, Any] = field(default_factory=dict)
