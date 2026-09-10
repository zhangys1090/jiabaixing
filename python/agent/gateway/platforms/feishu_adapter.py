"""飞书 (Feishu/Lark) 平台适配器。

通过飞书开放平台事件订阅接入飞书工作空间：
  - 监听 @mention 和 DM 消息
  - 支持群聊/私聊消息收发
  - 支持飞书卡片消息和交互式消息
  - 消息格式转换（飞书富文本 ↔ 纯文本）
  - 事件回调签名验证 (Verification Token + Encrypt Key)

独立化设计：
  - 不依赖主项目其他业务逻辑，仅依赖 agent.gateway.base
  - 飞书 SDK (lark-oapi) 为可选依赖，缺失时自动降级为模拟模式
  - 配置通过环境变量或构造参数注入，无硬编码

集成示例::

    from agent.gateway.platforms.feishu_adapter import FeishuAdapter

    adapter = FeishuAdapter(
        app_id=os.environ["FEISHU_APP_ID"],
        app_secret=os.environ["FEISHU_APP_SECRET"],
        verification_token=os.environ.get("FEISHU_VERIFICATION_TOKEN", ""),
        encrypt_key=os.environ.get("FEISHU_ENCRYPT_KEY", ""),
    )
    await adapter.start()
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import time
import uuid
from typing import Any, AsyncIterator

from agent.gateway.base import Message, PlatformAdapter
from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.feishu_adapter")


def _strip_feishu_rich_text(text: str) -> str:
    text = re.sub(r"<at user_id=\"([^\"]+)\">([^<]*)</at>", r"@\2", text)
    text = re.sub(r"<a href=\"([^\"]+)\">([^<]*)</a>", r"\2 (\1)", text)
    text = re.sub(r"<strong>([^<]*)</strong>", r"\1", text)
    text = re.sub(r"<em>([^<]*)</em>", r"\1", text)
    text = re.sub(r"<code>([^<]*)</code>", r"\1", text)
    text = re.sub(r"<pre[^>]*>([^<]*)</pre>", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


def _to_feishu_rich_text(text: str) -> str:
    return text


class FeishuAdapter(PlatformAdapter):
    """飞书 (Feishu/Lark) 平台适配器。

    通过飞书开放平台 SDK (lark-oapi) 接入飞书工作空间。

    Attributes:
        _app_id: 飞书应用 App ID (cli_xxx).
        _app_secret: 飞书应用 App Secret.
        _verification_token: 事件订阅验证 Token.
        _encrypt_key: 事件订阅加密 Key (可选).
        _queue: 入站消息队列.
        _connected: 连接状态.
        _client: 飞书 API 客户端.
        _event_handler: 飞书事件处理器.
    """

    def __init__(
        self,
        app_id: str = "",
        app_secret: str = "",
        verification_token: str = "",
        encrypt_key: str = "",
    ) -> None:
        self._app_id = app_id
        self._app_secret = app_secret
        self._verification_token = verification_token
        self._encrypt_key = encrypt_key
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._connected: bool = False
        self._client: Any = None
        self._event_handler: Any = None
        self._ws_client: Any = None

    @property
    def name(self) -> str:
        return "feishu"

    async def start(self) -> None:
        if not self._app_id or not self._app_secret:
            log.warning("飞书 App ID/Secret 未配置，适配器以模拟模式运行")
            self._enter_simulated()
            return

        try:
            import lark_oapi as lark
            from lark_oapi.api.im.v1 import (
                create_message,
                p2_im_message_receive_v1,
            )

            self._client = lark.Client.builder() \
                .app_id(self._app_id) \
                .app_secret(self._app_secret) \
                .build()

            event_handler = lark.EventDispatcherHandler.builder(
                verification_token=self._verification_token,
                encrypt_key=self._encrypt_key,
            ).register_p2_im_message_receive_v1(
                self._on_message_receive
            ).build()

            self._event_handler = event_handler

            try:
                ws_cli = lark.ws.Client(
                    self._app_id,
                    self._app_secret,
                    event_handler=event_handler,
                    log_level=lark.LogLevel.DEBUG,
                )
                asyncio.create_task(ws_cli.start())
                self._ws_client = ws_cli
                log.info("飞书适配器已启动 (WebSocket 长连接模式)")
            except Exception as ws_err:
                log.warning(
                    "WebSocket 模式启动失败，降级为 HTTP 回调模式",
                    error=str(ws_err),
                )

            self._connected = True
        except ImportError:
            log.warning("lark_oapi 未安装，飞书适配器以模拟模式运行 (pip install lark-oapi)")
            self._enter_simulated()
        except Exception as e:
            log.error("飞书适配器启动失败", error=str(e))
            self._connected = False

    async def _on_message_receive(self, ctx: Any, event: Any) -> None:
        try:
            msg_body = event.event.message
            if not msg_body:
                return

            msg_type = getattr(msg_body, "message_type", "text")
            if msg_type != "text":
                log.debug("跳过非文本消息", msg_type=msg_type)
                return

            content_str = getattr(msg_body, "content", "{}")
            try:
                content_json = json.loads(content_str) if isinstance(content_str, str) else content_str
                text = content_json.get("text", "")
            except (json.JSONDecodeError, TypeError):
                text = content_str

            clean_text = _strip_feishu_rich_text(text)
            if not clean_text:
                return

            sender_id = ""
            sender_info = getattr(event.event.sender, "sender_id", None)
            if sender_info:
                sender_id = getattr(sender_info, "union_id", "") or getattr(sender_info, "user_id", "") or ""

            chat_id = getattr(msg_body, "chat_id", "")
            msg_id = getattr(msg_body, "message_id", str(uuid.uuid4()))

            msg = Message(
                id=msg_id,
                platform="feishu",
                sender=sender_id,
                content=clean_text,
                metadata={
                    "chat_id": chat_id,
                    "msg_type": msg_type,
                    "app_id": self._app_id,
                },
            )
            await self._queue.put(msg)
        except Exception as e:
            log.warning("飞书消息处理异常", error=str(e))

    async def stop(self) -> None:
        self._connected = False
        self._client = None
        self._ws_client = None
        log.info("飞书适配器已停止")

    async def send_message(self, chat_id: str, text: str) -> bool:
        if self._client is None:
            log.warning("飞书适配器未连接，消息未真实发送", chat_id=chat_id)
            return False

        try:
            from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

            req = CreateMessageRequest.builder() \
                .receive_id_type("chat_id") \
                .receive_id(chat_id) \
                .request_body(
                    CreateMessageRequestBody.builder()
                    .msg_type("text")
                    .content(json.dumps({"text": _to_feishu_rich_text(text)}))
                    .build()
                ) \
                .build()

            resp = await self._client.im.v1.message.async_create(req)
            if not resp.success():
                log.error("飞书发送失败", code=resp.code, msg=resp.msg)
                return False
            return True
        except ImportError:
            log.warning("lark_oapi 未安装，无法发送消息")
            return False
        except Exception as e:
            log.error("飞书发送异常", chat_id=chat_id, error=str(e))
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

    async def reply_message(self, message_id: str, text: str) -> bool:
        if self._client is None:
            log.warning("飞书适配器未连接，回复未真实发送", message_id=message_id)
            return False

        try:
            from lark_oapi.api.im.v1 import ReplyMessageRequest, ReplyMessageRequestBody

            req = ReplyMessageRequest.builder() \
                .message_id(message_id) \
                .request_body(
                    ReplyMessageRequestBody.builder()
                    .msg_type("text")
                    .content(json.dumps({"text": _to_feishu_rich_text(text)}))
                    .build()
                ) \
                .build()

            resp = await self._client.im.v1.message.async_reply(req)
            if not resp.success():
                log.error("飞书回复失败", code=resp.code, msg=resp.msg)
                return False
            return True
        except Exception as e:
            log.error("飞书回复异常", message_id=message_id, error=str(e))
            return False

    async def get_chat_info(self, chat_id: str) -> dict[str, Any] | None:
        if self._client is None:
            return None

        try:
            from lark_oapi.api.im.v1 import GetChatRequest

            req = GetChatRequest.builder().chat_id(chat_id).build()
            resp = await self._client.im.v1.chat.async_get(req)
            if resp.success() and resp.data:
                return {
                    "chat_id": getattr(resp.data, "chat_id", ""),
                    "name": getattr(resp.data, "name", ""),
                    "owner_id": getattr(resp.data, "owner_id", ""),
                    "member_count": getattr(resp.data, "member_count", 0),
                }
            return None
        except Exception as e:
            log.warning("获取群信息失败", chat_id=chat_id, error=str(e))
            return None
