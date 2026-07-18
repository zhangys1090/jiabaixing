"""A2A 协议类型定义.

对应 TS 侧 AgentRegistry.ts 第 851-959 行的类型定义，
确保 TS ↔ Python 双端协议一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class A2ATaskStatus(str, Enum):
    """A2A Task 状态枚举.

    Attributes:
        SUBMITTED: 已提交，等待执行方接收
        WORKING: 执行中
        INPUT_REQUIRED: 需要发起方补充输入
        COMPLETED: 已完成
        FAILED: 执行失败
        CANCELLED: 已取消
    """

    SUBMITTED = "submitted"
    WORKING = "working"
    INPUT_REQUIRED = "input-required"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class A2ATransport(str, Enum):
    """A2A 传输协议枚举.

    Attributes:
        JSON_RPC: JSON-RPC 2.0 over HTTP
        GRPC: gRPC
        HTTP: 普通 HTTP REST
    """

    JSON_RPC = "json-rpc"
    GRPC = "grpc"
    HTTP = "http"


class A2ACapabilityType(str, Enum):
    """A2A 能力类型枚举.

    Attributes:
        TASK_EXECUTION: 任务执行
        INFORMATION_RETRIEVAL: 信息检索
        DATA_PROCESSING: 数据处理
        ORCHESTRATION: 编排
        MONITORING: 监控
    """

    TASK_EXECUTION = "task-execution"
    INFORMATION_RETRIEVAL = "information-retrieval"
    DATA_PROCESSING = "data-processing"
    ORCHESTRATION = "orchestration"
    MONITORING = "monitoring"


class A2AAuthType(str, Enum):
    """A2A 认证方案枚举.

    Attributes:
        NONE: 无认证（默认）
        API_KEY: API Key 校验（X-API-Key 头）
        OAUTH2: OAuth 2.0（保留兼容值，等价于 BEARER 的 Bearer Token 校验）
        BEARER: Bearer Token 校验（Authorization: Bearer xxx）
        JWT: JWT 签名校验（HS256，密钥从环境变量 A2A_JWT_SECRET 读取）
    """

    NONE = "none"
    API_KEY = "api-key"
    OAUTH2 = "oauth2"
    BEARER = "bearer"
    JWT = "jwt"

    @classmethod
    def parse(cls, value: Any) -> "A2AAuthType":
        """从字符串解析认证类型，未知值降级为 NONE.

        Args:
            value: 原始值（字符串/None/枚举）.

        Returns:
            A2AAuthType: 解析后的枚举值.
        """
        if value is None:
            return cls.NONE
        if isinstance(value, cls):
            return value
        try:
            return cls(str(value).lower())
        except ValueError:
            # 未知值降级为 NONE，遵循"配置缺失时降级"原则
            return cls.NONE


@dataclass
class A2AAuthConfig:
    """A2A 鉴权配置.

    描述某个 Agent 的鉴权要求与凭据。对于出站调用，凭据来自本地配置（环境变量）；
    对于入站校验，凭据用于验证请求方提供的凭据是否匹配。

    Attributes:
        type: 鉴权类型.
        api_key: API Key（api-key 类型使用）.
        bearer_token: Bearer Token（bearer / oauth2 类型使用）.
        jwt_secret: JWT 签名密钥（jwt 类型使用）.
    """

    type: A2AAuthType = A2AAuthType.NONE
    api_key: Optional[str] = None
    bearer_token: Optional[str] = None
    jwt_secret: Optional[str] = None

    def to_dict(self) -> Dict[str, str]:
        """序列化为 AgentCard.authentication 字段格式（仅暴露 type，不泄露凭据）.

        Returns:
            Dict[str, str]: 公开可发布的鉴权配置（仅含 type 字段）.
        """
        return {"type": self.type.value}

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "A2AAuthConfig":
        """从字典构造鉴权配置.

        仅解析 type 字段；凭据字段需通过环境变量另行注入，避免从公开 AgentCard 泄露。

        Args:
            data: 字典数据（通常来自 AgentCard.authentication）.

        Returns:
            A2AAuthConfig: 鉴权配置实例（仅 type 字段被填充）.
        """
        if data is None:
            return cls(type=A2AAuthType.NONE)
        return cls(type=A2AAuthType.parse(data.get("type")))


class A2ATaskEventType(str, Enum):
    """A2A Task 事件类型枚举.

    Attributes:
        STATUS_CHANGE: 状态变更
        ARTIFACT_UPDATE: 产物更新
        PROGRESS: 进度更新
    """

    STATUS_CHANGE = "status-change"
    ARTIFACT_UPDATE = "artifact-update"
    PROGRESS = "progress"


@dataclass
class A2ACapability:
    """A2A 能力声明.

    描述 Agent 提供的某项能力，供其他 Agent 发现与调用。

    Attributes:
        type: 能力类型.
        name: 能力名称.
        description: 详细描述.
        input_schema: 输入 schema (JSON Schema).
        output_schema: 输出 schema (JSON Schema).
        modalities: 支持的模态列表，如 ["text", "image"].
    """

    type: A2ACapabilityType
    name: str
    description: str = ""
    input_schema: Optional[Dict[str, Any]] = None
    output_schema: Optional[Dict[str, Any]] = None
    modalities: List[str] = field(default_factory=lambda: ["text"])

    def to_dict(self) -> Dict[str, Any]:
        """序列化为字典.

        Returns:
            Dict[str, Any]: 可 JSON 序列化的字典表示.
        """
        return {
            "type": self.type.value,
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "outputSchema": self.output_schema,
            "modalities": self.modalities,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "A2ACapability":
        """从字典反序列化.

        Args:
            data: 字典数据.

        Returns:
            A2ACapability: 能力实例.
        """
        return cls(
            type=A2ACapabilityType(data.get("type", "task-execution")),
            name=data.get("name", ""),
            description=data.get("description", ""),
            input_schema=data.get("inputSchema"),
            output_schema=data.get("outputSchema"),
            modalities=data.get("modalities", ["text"]),
        )


@dataclass
class A2AAgentCard:
    """A2A Agent Card.

    Agent 的自我描述，发布后供其他 Agent 发现与调用。

    Attributes:
        id: Agent 唯一标识 URI，如 "agent:jiabaixing:orchestrator".
        name: 显示名称.
        description: 详细描述.
        url: Agent 服务端点 URL，如 "http://jiabaixing-python:8765/a2a".
        transport: 支持的传输协议.
        capabilities: 能力声明列表.
        authentication: 认证方案.
        version: 版本号.
        provider: 提供者信息 (name, url).
    """

    id: str
    name: str
    description: str = ""
    url: str = ""
    transport: A2ATransport = A2ATransport.HTTP
    capabilities: List[A2ACapability] = field(default_factory=list)
    authentication: Optional[Dict[str, str]] = None
    version: str = "1.0.0"
    provider: Optional[Dict[str, str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """序列化为字典.

        Returns:
            Dict[str, Any]: 可 JSON 序列化的字典表示，符合 A2A 协议规范.
        """
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "url": self.url,
            "transport": self.transport.value,
            "capabilities": [cap.to_dict() for cap in self.capabilities],
            "authentication": self.authentication,
            "version": self.version,
            "provider": self.provider,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "A2AAgentCard":
        """从字典反序列化.

        Args:
            data: 字典数据.

        Returns:
            A2AAgentCard: Agent Card 实例.
        """
        transport_val = data.get("transport", "http")
        try:
            transport = A2ATransport(transport_val)
        except ValueError:
            transport = A2ATransport.HTTP

        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            description=data.get("description", ""),
            url=data.get("url", ""),
            transport=transport,
            capabilities=[
                A2ACapability.from_dict(c) for c in data.get("capabilities", [])
            ],
            authentication=data.get("authentication"),
            version=data.get("version", "1.0.0"),
            provider=data.get("provider"),
        )

    def get_auth_config(self) -> A2AAuthConfig:
        """从 authentication 字段构造 A2AAuthConfig（仅 type 字段被填充）.

        Returns:
            A2AAuthConfig: 鉴权配置实例.
        """
        return A2AAuthConfig.from_dict(self.authentication)


@dataclass
class A2AArtifact:
    """A2A Task 产物.

    Task 执行过程中产生的产物（文件、数据等）。

    Attributes:
        id: 产物唯一标识.
        name: 产物名称.
        mime_type: MIME 类型.
        content: 内容（文本或 base64 编码的二进制）.
        metadata: 额外元数据.
    """

    id: str
    name: str = ""
    mime_type: str = "text/plain"
    content: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """序列化为字典.

        Returns:
            Dict[str, Any]: 可 JSON 序列化的字典表示.
        """
        return {
            "id": self.id,
            "name": self.name,
            "mimeType": self.mime_type,
            "content": self.content,
            "metadata": self.metadata,
        }


@dataclass
class A2ATaskEvent:
    """A2A Task 事件.

    Task 状态变更、产物更新、进度更新等事件。

    Attributes:
        task_id: 关联的 Task ID.
        type: 事件类型.
        status: 新状态（仅 type=status-change 时）.
        message: 事件消息.
        artifact: 产物（仅 type=artifact-update 时）.
        progress: 进度百分比 0-100（仅 type=progress 时）.
        timestamp: 事件时间戳（毫秒）.
    """

    task_id: str
    type: A2ATaskEventType
    status: Optional[A2ATaskStatus] = None
    message: str = ""
    artifact: Optional[A2AArtifact] = None
    progress: Optional[float] = None
    timestamp: int = 0

    def to_dict(self) -> Dict[str, Any]:
        """序列化为字典.

        Returns:
            Dict[str, Any]: 可 JSON 序列化的字典表示.
        """
        return {
            "taskId": self.task_id,
            "type": self.type.value,
            "status": self.status.value if self.status else None,
            "message": self.message,
            "artifact": self.artifact.to_dict() if self.artifact else None,
            "progress": self.progress,
            "timestamp": self.timestamp,
        }


@dataclass
class A2ATask:
    """A2A Task — 跨 Agent 任务生命周期.

    描述一个 Agent 委派给另一个 Agent 的任务，包含完整生命周期信息。

    Attributes:
        id: 任务唯一标识.
        session_id: 会话 ID.
        description: 任务描述.
        from_agent_id: 发起方 Agent ID.
        to_agent_id: 执行方 Agent ID.
        status: 当前状态.
        input: 任务输入.
        output: 任务输出.
        artifacts: 产物列表.
        created_at: 创建时间戳（毫秒）.
        updated_at: 更新时间戳（毫秒）.
        completed_at: 完成时间戳（毫秒）.
        error: 错误信息.
        status_history: 状态历史.
    """

    id: str
    session_id: str
    description: str
    from_agent_id: str
    to_agent_id: str
    status: A2ATaskStatus = A2ATaskStatus.SUBMITTED
    input: Dict[str, Any] = field(default_factory=dict)
    output: Optional[Dict[str, Any]] = None
    artifacts: List[A2AArtifact] = field(default_factory=list)
    created_at: int = 0
    updated_at: int = 0
    completed_at: Optional[int] = None
    error: Optional[str] = None
    status_history: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """序列化为字典.

        Returns:
            Dict[str, Any]: 可 JSON 序列化的字典表示，符合 A2A 协议规范.
        """
        return {
            "id": self.id,
            "sessionId": self.session_id,
            "description": self.description,
            "fromAgentId": self.from_agent_id,
            "toAgentId": self.to_agent_id,
            "status": self.status.value,
            "input": self.input,
            "output": self.output,
            "artifacts": [a.to_dict() for a in self.artifacts],
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
            "error": self.error,
            "statusHistory": self.status_history,
        }
