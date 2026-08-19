"""WorkflowEngine 数据结构定义。

定义工作流引擎的所有核心数据类型：
- WorkflowStep: 工作流步骤
- WorkflowDefinition: 工作流定义（DAG）
- StepState: 步骤运行时状态
- WorkflowInstance: 工作流实例（状态机）
- TriggerConfig: 触发配置
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class StepType(str, Enum):
    LLM = "llm"
    TOOL = "tool"
    SUBFLOW = "subflow"
    HUMAN = "human"


class StepStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


class WorkflowStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TriggerType(str, Enum):
    CRON = "cron"
    FILE = "file"
    WEBHOOK = "webhook"
    MESSAGE = "message"
    MANUAL = "manual"


class FailurePolicy(str, Enum):
    FAIL = "fail"
    SKIP = "skip"
    RETRY = "retry"


@dataclass
class WorkflowStep:
    """工作流步骤。

    Attributes:
        id: 步骤唯一标识。
        name: 步骤名称。
        type: 步骤类型（llm/tool/subflow/human）。
        prompt: LLM prompt 或工具调用描述。
        tool_name: 工具步骤的工具名。
        subflow_id: 子工作流步骤的工作流定义 ID。
        depends_on: 依赖的步骤 ID 列表。
        condition: 执行条件表达式。
        timeout_seconds: 步骤超时。
        retry_count: 重试次数。
        on_failure: 失败策略。
        variables_input: 输入变量映射 {步骤内变量名: 工作流变量名}。
        variables_output: 输出变量映射 {工作流变量名: 步骤结果字段名}。
    """

    id: str
    name: str
    type: str = StepType.LLM
    prompt: str = ""
    tool_name: str = ""
    subflow_id: str = ""
    depends_on: list[str] = field(default_factory=list)
    condition: str | None = None
    timeout_seconds: float = 300.0
    retry_count: int = 0
    on_failure: str = FailurePolicy.FAIL
    variables_input: dict[str, str] = field(default_factory=dict)
    variables_output: dict[str, str] = field(default_factory=dict)


@dataclass
class TriggerConfig:
    """触发配置。

    Attributes:
        type: 触发类型。
        cron_expression: cron 触发表达式。
        watch_paths: 文件监听路径列表。
        watch_patterns: 文件监听 glob 模式列表。
        webhook_path: webhook 路径。
        webhook_method: webhook HTTP 方法。
        message_pattern: 消息匹配模式。
        enabled: 是否启用。
    """

    type: str = TriggerType.MANUAL
    cron_expression: str | None = None
    watch_paths: list[str] | None = None
    watch_patterns: list[str] | None = None
    webhook_path: str | None = None
    webhook_method: str = "POST"
    message_pattern: str | None = None
    enabled: bool = True


@dataclass
class WorkflowDefinition:
    """工作流定义（DAG）。

    Attributes:
        id: 工作流定义 ID。
        name: 工作流名称。
        description: 描述。
        steps: 步骤列表。
        variables: 工作流变量定义。
        trigger: 触发配置。
        created_at: 创建时间戳。
        updated_at: 更新时间戳。
        version: 版本号。
        tags: 标签。
    """

    id: str
    name: str
    description: str = ""
    steps: list[WorkflowStep] = field(default_factory=list)
    variables: dict[str, Any] = field(default_factory=dict)
    trigger: TriggerConfig | None = None
    created_at: float = 0.0
    updated_at: float = 0.0
    version: int = 1
    tags: list[str] = field(default_factory=list)


@dataclass
class StepState:
    """步骤运行时状态。

    Attributes:
        step_id: 步骤 ID。
        status: 步骤状态。
        started_at: 开始时间戳。
        completed_at: 完成时间戳。
        result: 步骤执行结果。
        error: 错误信息。
        attempts: 尝试次数。
        duration_ms: 执行耗时（毫秒）。
    """

    step_id: str
    status: str = StepStatus.PENDING
    started_at: float = 0.0
    completed_at: float = 0.0
    result: dict[str, Any] | None = None
    error: str = ""
    attempts: int = 0
    duration_ms: float = 0.0


@dataclass
class WorkflowInstance:
    """工作流实例 — 运行时状态机。

    Attributes:
        id: 实例 ID。
        definition_id: 关联的定义 ID。
        definition: 关联的定义（运行时填充）。
        status: 工作流状态。
        step_states: 步骤状态映射。
        variables: 运行时变量。
        created_at: 创建时间戳。
        updated_at: 更新时间戳。
        started_at: 开始执行时间戳。
        completed_at: 完成时间戳。
        checkpoint_id: SafetyNet 还原点 ID。
        parent_instance_id: 父工作流实例 ID（子工作流场景）。
        error: 错误信息。
    """

    id: str
    definition_id: str
    definition: WorkflowDefinition | None = None
    status: str = WorkflowStatus.PENDING
    step_states: dict[str, StepState] = field(default_factory=dict)
    variables: dict[str, Any] = field(default_factory=dict)
    created_at: float = 0.0
    updated_at: float = 0.0
    started_at: float = 0.0
    completed_at: float = 0.0
    checkpoint_id: str = ""
    parent_instance_id: str = ""
    error: str = ""


def new_step(
    name: str,
    step_type: str = StepType.LLM,
    prompt: str = "",
    tool_name: str = "",
    depends_on: list[str] | None = None,
    **kwargs: Any,
) -> WorkflowStep:
    """快捷创建步骤。"""
    return WorkflowStep(
        id=kwargs.pop("id", uuid.uuid4().hex[:8]),
        name=name,
        type=step_type,
        prompt=prompt,
        tool_name=tool_name,
        depends_on=depends_on or [],
        **kwargs,
    )


def new_definition(
    name: str,
    steps: list[WorkflowStep] | None = None,
    trigger: TriggerConfig | None = None,
    **kwargs: Any,
) -> WorkflowDefinition:
    """快捷创建工作流定义。"""
    now = time.time()
    return WorkflowDefinition(
        id=kwargs.pop("id", uuid.uuid4().hex[:8]),
        name=name,
        steps=steps or [],
        trigger=trigger,
        created_at=now,
        updated_at=now,
        **kwargs,
    )


def new_instance(definition_id: str, **kwargs: Any) -> WorkflowInstance:
    """快捷创建工作流实例。"""
    now = time.time()
    return WorkflowInstance(
        id=kwargs.pop("id", uuid.uuid4().hex[:8]),
        definition_id=definition_id,
        created_at=now,
        updated_at=now,
        **kwargs,
    )
