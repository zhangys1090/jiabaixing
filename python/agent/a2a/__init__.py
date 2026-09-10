"""A2A (Agent-to-Agent) 协议 Python 实现.

提供跨 Agent 通信能力，包括:
- Agent Card 发布与发现
- Task 生命周期管理（submitted/working/input-required/completed/failed/cancelled）
- 推送通知
- HTTP 端点暴露（FastAPI 路由）
- A2A 客户端（调用远程 Agent）
- 运行时鉴权拦截器（none/api-key/bearer/jwt）
- 跨 Agent 任务管理（A2ATaskManager）
- Agent 发现服务（A2ADiscovery）
- 信任管理（A2ATrustManager）

遵循 AGENTS.md 架构原则: A2A 协议主实现端为 Python，TS 侧仅做 HTTP 入口路由。
"""

from agent.a2a.types import (
    A2AAgentCard,
    A2AAuthConfig,
    A2AAuthType,
    A2ACapability,
    A2ACapabilityType,
    A2ATask,
    A2ATaskEvent,
    A2ATaskEventType,
    A2ATaskStatus,
    A2ATransport,
    A2AArtifact,
)
from agent.a2a.protocol import (
    A2ATaskManager,
    A2ADiscovery,
    A2ATrustManager,
    AgentTrustRecord,
    TrustLevel,
)

# HTTP/网络层依赖 fastapi 等可选依赖。缺失时优雅降级，
# 保证 types/protocol 等纯逻辑（含 TrustLevel）仍可被独立导入。
try:
    from agent.a2a.manager import A2AProtocolManager, get_a2a_manager
    from agent.a2a.server import create_a2a_router, mount_a2a_routes
    from agent.a2a.client import A2AClient
    from agent.a2a.auth import A2AAuthInterceptor
except ImportError:  # pragma: no cover - 仅在缺 fastapi 等可选依赖时触发
    A2AProtocolManager = None
    get_a2a_manager = None
    create_a2a_router = None
    mount_a2a_routes = None
    A2AClient = None
    A2AAuthInterceptor = None

__all__ = [
    "A2AAgentCard",
    "A2AAuthConfig",
    "A2AAuthType",
    "A2ACapability",
    "A2ACapabilityType",
    "A2ATask",
    "A2ATaskEvent",
    "A2ATaskEventType",
    "A2ATaskStatus",
    "A2ATransport",
    "A2AArtifact",
    "A2AProtocolManager",
    "get_a2a_manager",
    "create_a2a_router",
    "mount_a2a_routes",
    "A2AClient",
    "A2AAuthInterceptor",
    "A2ATaskManager",
    "A2ADiscovery",
    "A2ATrustManager",
    "AgentTrustRecord",
    "TrustLevel",
]
