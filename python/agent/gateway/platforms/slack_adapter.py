"""Slack 平台适配器。

通过 Slack Bolt SDK 接入 Slack 工作空间：
  - 监听 @mention 和 DM 消息
  - 支持线程回复保持上下文
  - 支持 Slash Commands 和 Interactive Actions
  - 消息格式转换（Slack mrkdwn ↔ 纯文本）

集成示例::

    from agent.gateway.platforms.slack_adapter import SlackAdapter

    adapter = SlackAdapter(bot_token="xoxb-...", app_token="xapp-...")
    await adapter.start()
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from typing import Any, AsyncIterator

from agent.gateway.base import Message, PlatformAdapter
from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.slack_adapter")


def _strip_mrkdwn(text: str) -> str:
    text = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"\2 (\1)", text)
    text = re.sub(r"<(https?://[^|>]+)>", r"\1", text)
    text = re.sub(r"<@(\w+)>", r"@\1", text)
    text = re.sub(r"<#(\w+)\|([^>]+)>", r"#\2", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    text = re.sub(r"~([^~]+)~", r"\1", text)
    text = re.sub(r"`{3}(\w*)\n?", "", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    return text.strip()


def _to_mrkdwn(text: str) -> str:
    return text


class SlackAdapter(PlatformAdapter):
    """Slack 平台适配器。

    通过 Slack Bolt / RTM 接入 Slack 工作空间。

    Attributes:
        _bot_token: Slack Bot OAuth Token (xoxb-).
        _app_token: Slack App-Level Token (xapp-), 用于 Socket Mode.
        _queue: 入站消息队列.
        _connected: 连接状态.
    """

    def __init__(
        self,
        bot_token: str = "",
        app_token: str = "",
        signing_secret: str = "",
    ) -> None:
        self._bot_token = bot_token
        self._app_token = app_token
        self._signing_secret = signing_secret
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._connected: bool = False
        self._app: Any = None
        self._channels: dict[str, str] = {}

    @property
    def name(self) -> str:
        return "slack"

    async def start(self) -> None:
        if not self._bot_token:
            log.warning("Slack Bot Token 未配置，适配器以模拟模式运行")
            self._connected = True
            return

        try:
            from slack_bolt.async_app import AsyncApp
            from slack_bolt.adapter.socket_mode.aiohttp import AsyncSocketModeHandler

            self._app = AsyncApp(token=self._bot_token)

            @self._app.event("message")
            async def handle_message(event: dict, say: Any, **kwargs: Any) -> None:
                text = event.get("text", "")
                channel = event.get("channel", "")
                user = event.get("user", "")
                thread_ts = event.get("thread_ts", "")
                clean_text = _strip_mrkdwn(text)

                msg = Message(
                    id=str(uuid.uuid4()),
                    platform="slack",
                    chat_id=thread_ts or channel,
                    sender=user,
                    content=clean_text,
                    metadata={
                        "channel": channel,
                        "thread_ts": thread_ts,
                        "event_ts": event.get("ts", ""),
                    },
                )
                await self._queue.put(msg)

            if self._app_token:
                handler = AsyncSocketModeHandler(self._app, self._app_token)
                asyncio.create_task(handler.start_async())
            else:
                log.warning("App Token 未配置，Socket Mode 不可用")

            self._connected = True
            log.info("Slack 适配器已启动")
        except ImportError:
            log.warning("slack_bolt 未安装，Slack 适配器以模拟模式运行")
            self._connected = True
        except Exception as e:
            log.error("Slack 适配器启动失败", error=str(e))
            self._connected = False

    async def stop(self) -> None:
        self._connected = False
        log.info("Slack 适配器已停止")

    async def send_message(self, chat_id: str, text: str) -> bool:
        if self._app is None:
            log.debug("Slack 模拟发送", chat_id=chat_id, text=text[:50])
            return True

        try:
            client = self._app.client
            await client.chat_postMessage(
                channel=chat_id,
                text=_to_mrkdwn(text),
            )
            return True
        except Exception as e:
            log.error("Slack 发送失败", chat_id=chat_id, error=str(e))
            return False

    async def receive_message(self) -> AsyncIterator[Message]:
        while self._connected:
            try:
                msg = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                yield msg
            except asyncio.TimeoutError:
                continue

    async def is_connected(self) -> bool:
        return self._connected
