from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # 仅供类型注解使用（PEP 563 下不会在运行时求值）
    import asyncio


class LoopState(str, Enum):
    IDLE = "idle"
    PERCEIVING = "perceiving"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    EVALUATING = "evaluating"
    REPORTING = "reporting"
    COMPLETED = "completed"
    FAILED = "failed"


class StepState(str, Enum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    RETRYING = "retrying"
    BLOCKED = "blocked"


STEP_TRANSITIONS: dict[StepState, list[StepState]] = {
    StepState.PENDING: [StepState.READY, StepState.BLOCKED, StepState.SKIPPED],
    StepState.READY: [StepState.RUNNING, StepState.WAITING_APPROVAL, StepState.SKIPPED],
    StepState.RUNNING: [StepState.COMPLETED, StepState.FAILED, StepState.RETRYING, StepState.WAITING_APPROVAL],
    StepState.WAITING_APPROVAL: [StepState.RUNNING, StepState.SKIPPED],
    StepState.FAILED: [StepState.RETRYING, StepState.SKIPPED],
    StepState.RETRYING: [StepState.COMPLETED, StepState.FAILED],
    StepState.BLOCKED: [StepState.READY, StepState.SKIPPED],
    StepState.COMPLETED: [],
    StepState.SKIPPED: [],
}


class StepStateMachine:
    def __init__(self, initial: StepState = StepState.PENDING) -> None:
        self._state = initial
        self._history: list[tuple[StepState, StepState, float]] = []
        self._violations: list[tuple[StepState, StepState, float]] = []

    @property
    def state(self) -> StepState:
        return self._state

    def can_transition(self, target: StepState) -> bool:
        return target in STEP_TRANSITIONS.get(self._state, [])

    def transition(self, target: StepState) -> bool:
        import time
        if not self.can_transition(target):
            self._violations.append((self._state, target, time.time()))
            return False
        prev = self._state
        self._state = target
        self._history.append((prev, target, time.time()))
        return True

    @property
    def history(self) -> list[tuple[StepState, StepState, float]]:
        return list(self._history)

    @property
    def violations(self) -> list[tuple[StepState, StepState, float]]:
        return list(self._violations)

    def is_terminal(self) -> bool:
        return self._state in (StepState.COMPLETED, StepState.SKIPPED)


@dataclass
class PlanStep:
    step_id: str
    description: str
    tool_name: str | None = None
    tool_params: dict[str, Any] = field(default_factory=dict)
    retry_count: int = 0
    max_retries: int = 2
    status: str = "pending"
    _state_machine: StepStateMachine = field(default_factory=StepStateMachine, init=False, repr=False)
    # 工具链编排：指定从哪个步骤的输出获取输入
    # 格式："step:<step_id>" 或 "result:<step_id>"（取 StepResult.content）
    # 执行时自动将前序步骤的输出注入当前步骤的参数
    input_from_step: str | None = None
    # 指定将上游输出注入到当前参数的哪个字段名（默认 "input"）
    input_param_name: str = "input"
    # 安全沙箱联动：本步所使用工具的风险等级（low/medium/high/critical），
    # 由 RiskPrecheck.annotate_plan 在执行前标注，供用户确认与审批。
    risk_level: str = "low"
    # 安全沙箱联动：该步是否需要人工审批（risk_level 为 high/critical 时为 True）。
    # Planner 在生成阶段即标注，使前端确认 UI 可在执行前呈现待审批步骤。
    requires_approval: bool = False

    def transition_state(self, target: StepState) -> bool:
        result = self._state_machine.transition(target)
        if result:
            self.status = target.value
        return result

    def can_transition_to(self, target: StepState) -> bool:
        return self._state_machine.can_transition(target)

    @property
    def step_state(self) -> StepState:
        return self._state_machine.state


@dataclass
class ExecutionPlan:
    steps: list[PlanStep] = field(default_factory=list)
    reasoning: str = ""
    simple: bool = False
    tool_call_mode: str = "auto"
    recommended_tools: list[str] = field(default_factory=list)

    def pending_approval_steps(self) -> list["PlanStep"]:
        """返回所有需要人工审批的步骤（供前端确认 UI / 审批流使用）。"""
        return [s for s in self.steps if getattr(s, "requires_approval", False)]


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
    agent_native: bool = False
    verification_level: str = "full"


@dataclass
class StepResult:
    step_id: str
    success: bool
    content: str = ""
    tool_name: str | None = None
    tool_params: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    duration_ms: float = 0.0
    metadata: dict[str, Any] | None = None


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
    # 能力驱动路由（W1/U2 最后一公里）：任务类型标识（coding/reasoning/agentic/
    # vision/cheap/long_context），由 LoopController._derive_task_type 推导，
    # 透传到 llm.chat(task_type=...) 触发 CapabilityAwareRouter 任务级选型，
    # 实现「单 Agent 内多模型协同」独有能力。
    task_type: str | None = None
    # 五感感知状态：由 PerceptionBus 在每轮循环开始时填充，
    # 包含情绪/场景/环境/视觉/听觉五通道的感知结果，
    # 供 Plan 阶段参考以实现感知驱动的规划。
    perception_state: Any | None = None

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
    factual_accuracy: float = 0.0
    citation_accuracy: float = 0.0
    relevance_score: float = 0.0
    safety_flag: bool = False
    evaluation_dimensions: dict[str, float] = field(default_factory=dict)


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
