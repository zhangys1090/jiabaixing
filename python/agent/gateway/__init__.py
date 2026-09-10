"""消息平台网关框架。

提供可扩展的多平台适配器架构，支持飞书、微信、Slack 等消息平台
通过统一的 Gateway 框架接入 Agent 系统。

核心组件:
    - Message: 统一消息数据模型
    - PlatformAdapter: 平台适配器抽象基类
    - GatewayConfig: 网关配置数据类
    - MessageDispatcher: 消息分发中心

Usage:
    from agent.gateway import MessageDispatcher, GatewayConfig
    from agent.gateway.platforms.webhook_adapter import WebhookAdapter

    dispatcher = MessageDispatcher()
    adapter = WebhookAdapter(host="0.0.0.0", port=9000)
    dispatcher.register_adapter("webhook", adapter)
    await adapter.start()
"""

from agent.gateway.base import GatewayConfig, Message, PlatformAdapter
from agent.gateway.dispatcher import MessageDispatcher
from agent.gateway.mirror import MessageMirror
from agent.gateway.pairing import PairingAuth
from agent.gateway.restart import HotReloader
from agent.gateway.forensics import ShutdownForensics
from agent.gateway.platforms.feishu_adapter import FeishuAdapter

__all__ = [
    "FeishuAdapter",
    "GatewayConfig",
    "Message",
    "MessageDispatcher",
    "MessageMirror",
    "PairingAuth",
    "HotReloader",
    "ShutdownForensics",
    "PlatformAdapter",
]
