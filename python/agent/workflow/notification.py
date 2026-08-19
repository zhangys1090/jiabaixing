"""NotificationChannel — 工作流通知渠道。

支持三种通知方式：
1. WebSocketNotifier: WebSocket 实时推送
2. LogNotifier: 日志记录（兜底）
3. WebhookNotifier: HTTP 回调通知（异步执行，不阻塞工作流）

Usage:
    from agent.workflow.notification import NotificationManager

    mgr = NotificationManager()
    await mgr.notify("workflow-done", {"workflow_id": "abc", "status": "done"})
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("workflow_notification")


@dataclass
class Notification:
    """通知消息。

    Attributes:
        type: 通知类型（workflow-started/workflow-done/workflow-failed/step-done/step-failed）。
        payload: 通知载荷。
        timestamp: 时间戳。
        target: 通知目标（session_id / webhook_url / 空=广播）。
    """

    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0
    target: str = ""


class WebSocketNotifier:
    """WebSocket 通知器 — 通过 WebSocket 推送通知。"""

    def __init__(self) -> None:
        self._connections: dict[str, Any] = {}

    def register(self, session_id: str, ws: Any) -> None:
        self._connections[session_id] = ws

    def unregister(self, session_id: str) -> None:
        self._connections.pop(session_id, None)

    async def send(self, notification: Notification) -> bool:
        if not self._connections:
            return False
        message = json.dumps({
            "type": f"workflow:{notification.type}",
            "payload": notification.payload,
            "timestamp": notification.timestamp,
        }, ensure_ascii=False)
        sent = 0
        for session_id, ws in list(self._connections.items()):
            try:
                if hasattr(ws, "send"):
                    await ws.send(message)
                    sent += 1
            except Exception as e:
                log.warning("WebSocket 通知发送失败", session=session_id, error=str(e))
                self._connections.pop(session_id, None)
        return sent > 0


class LogNotifier:
    """日志通知器 — 记录到结构化日志（兜底方案）。"""

    async def send(self, notification: Notification) -> bool:
        log.info(
            f"工作流通知: {notification.type}",
            **notification.payload,
        )
        return True


class WebhookNotifier:
    """Webhook 通知器 — HTTP POST 回调（异步非阻塞）。"""

    def __init__(self) -> None:
        self._urls: list[str] = []

    def add_url(self, url: str) -> None:
        self._urls.append(url)

    def remove_url(self, url: str) -> None:
        self._urls = [u for u in self._urls if u != url]

    async def send(self, notification: Notification) -> bool:
        if not self._urls:
            return False
        payload = json.dumps({
            "type": notification.type,
            "payload": notification.payload,
            "timestamp": notification.timestamp,
        }, ensure_ascii=False)
        sent = 0
        for url in self._urls:
            try:
                sent += await self._async_post(url, payload)
            except Exception as e:
                log.warning("Webhook 通知发送失败", url=url, error=str(e))
        return sent > 0

    async def _async_post(self, url: str, payload: str) -> int:
        """异步 HTTP POST — 使用 asyncio + 线程池避免阻塞事件循环。"""
        def _sync_post() -> int:
            import urllib.request
            req = urllib.request.Request(
                url,
                data=payload.encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                return 1 if resp.status < 300 else 0

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _sync_post)


class NotificationManager:
    """通知管理器 — 统一管理多个通知渠道。"""

    def __init__(self) -> None:
        self._ws = WebSocketNotifier()
        self._log = LogNotifier()
        self._webhook = WebhookNotifier()
        self._history: list[Notification] = []

    @property
    def websocket(self) -> WebSocketNotifier:
        return self._ws

    @property
    def webhook(self) -> WebhookNotifier:
        return self._webhook

    async def notify(
        self,
        notification_type: str,
        payload: dict[str, Any] | None = None,
        target: str = "",
    ) -> None:
        notification = Notification(
            type=notification_type,
            payload=payload or {},
            timestamp=time.time(),
            target=target,
        )
        self._history.append(notification)
        await self._log.send(notification)
        await self._ws.send(notification)
        if self._webhook._urls:
            await self._webhook.send(notification)

    def get_history(self, limit: int = 50) -> list[Notification]:
        return list(self._history[-limit:])
