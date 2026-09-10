"""消息平台适配器实现。

提供各消息平台的具体适配器实现，
所有适配器继承自 agent.gateway.base.PlatformAdapter。

已实现适配器:
    - WebhookAdapter: HTTP Webhook 入站适配器
    - APIServerAdapter: HTTP API 服务端适配器
    - FeishuAdapter: 飞书 (Feishu/Lark) 平台适配器
"""

from agent.gateway.platforms.webhook_adapter import WebhookAdapter
from agent.gateway.platforms.api_server_adapter import APIServerAdapter
from agent.gateway.platforms.feishu_adapter import FeishuAdapter

__all__ = [
    "APIServerAdapter",
    "FeishuAdapter",
    "WebhookAdapter",
]
