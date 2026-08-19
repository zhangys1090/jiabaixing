"""WhatsApp 平台适配器。

通过 WhatsApp Business API 接入 WhatsApp：
  - Webhook 接收入站消息
  - 支持文本、图片、文档消息类型
  - 模板消息发送
  - 消息状态回调（delivered/read）

集成示例::

    from agent.gateway.platforms.whatsapp_adapter import WhatsAppAdapter

    adapter = WhatsAppAdapter(
        phone_number_id="123456",
        access_token="EAAJ...",
        verify_token="my_verify",
    )
    await adapter.start()
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, AsyncIterator

from agent.gateway.base import Message, PlatformAdapter
from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.whatsapp_adapter")


class WhatsAppAdapter(PlatformAdapter):
    """WhatsApp Business API 适配器。

    通过 Cloud API (Meta Graph API) 接入 WhatsApp Business。

    Attributes:
        _phone_number_id: WhatsApp Business 电话号码 ID.
        _access_token: Meta Graph API Access Token.
        _verify_token: Webhook 验证 Token.
        _queue: 入站消息队列.
        _connected: 连接状态.
    """

    def __init__(
        self,
        phone_number_id: str = "",
        access_token: str = "",
        verify_token: str = "",
        host: str = "0.0.0.0",
        port: int = 9001,
    ) -> None:
        self._phone_number_id = phone_number_id
        self._access_token = access_token
        self._verify_token = verify_token
        self._host = host
        self._port = port
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._connected: bool = False
        self._app: Any = None

    @property
    def name(self) -> str:
        return "whatsapp"

    async def start(self) -> None:
        if not self._access_token:
            log.warning("WhatsApp Access Token 未配置，适配器以模拟模式运行（不会真实连接）")
            self._enter_simulated()
            return

        try:
            from fastapi import FastAPI, Request
            from fastapi.responses import PlainTextResponse
            import uvicorn

            self._app = FastAPI()

            @self._app.get("/webhook/whatsapp")
            async def verify(request: Request) -> PlainTextResponse:
                mode = request.query_params.get("hub.mode")
                token = request.query_params.get("hub.verify_token")
                challenge = request.query_params.get("hub.challenge")
                if mode == "subscribe" and token == self._verify_token:
                    return PlainTextResponse(content=challenge)
                return PlainTextResponse(content="Forbidden", status_code=403)

            @self._app.post("/webhook/whatsapp")
            async def webhook(request: Request) -> dict:
                body = await request.json()
                await self._process_webhook(body)
                return {"status": "ok"}

            config = uvicorn.Config(self._app, host=self._host, port=self._port, log_level="warning")
            server = uvicorn.Server(config)
            asyncio.create_task(server.serve())
            self._connected = True
            log.info("WhatsApp 适配器已启动", port=self._port)
        except ImportError:
            log.warning("fastapi/uvicorn 未安装，WhatsApp 适配器以模拟模式运行（不会真实连接）")
            self._enter_simulated()
        except Exception as e:
            log.error("WhatsApp 适配器启动失败", error=str(e))
            self._connected = False

    async def _process_webhook(self, body: dict) -> None:
        try:
            for entry in body.get("entry", []):
                for change in entry.get("changes", []):
                    value = change.get("value", {})
                    for msg_data in value.get("messages", []):
                        msg_type = msg_data.get("type", "text")
                        if msg_type == "text":
                            content = msg_data.get("text", {}).get("body", "")
                        elif msg_type == "image":
                            content = "[图片]"
                        elif msg_type == "document":
                            content = "[文档]"
                        else:
                            content = f"[{msg_type}]"

                        from_number = msg_data.get("from", "")
                        msg_id = msg_data.get("id", "")

                        msg = Message(
                            id=msg_id or str(uuid.uuid4()),
                            platform="whatsapp",
                            chat_id=from_number,
                            sender=from_number,
                            content=content,
                            metadata={
                                "wa_id": msg_id,
                                "type": msg_type,
                                "timestamp": msg_data.get("timestamp", ""),
                            },
                        )
                        await self._queue.put(msg)
        except Exception as e:
            log.error("WhatsApp webhook 处理失败", error=str(e))

    async def stop(self) -> None:
        self._connected = False
        log.info("WhatsApp 适配器已停止")

    async def send_message(self, chat_id: str, text: str) -> bool:
        if not self._access_token:
            # 诚实化：模拟态（未配置 Token / 未安装 fastapi）未真实发送
            log.warning("WhatsApp 适配器未连接，消息未真实发送", chat_id=chat_id)
            return False

        try:
            import httpx

            url = f"https://graph.facebook.com/v18.0/{self._phone_number_id}/messages"
            headers = {
                "Authorization": f"Bearer {self._access_token}",
                "Content-Type": "application/json",
            }
            payload = {
                "messaging_product": "whatsapp",
                "to": chat_id,
                "type": "text",
                "text": {"body": text},
            }

            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=payload, headers=headers, timeout=30)
                return resp.status_code == 200
        except Exception as e:
            log.error("WhatsApp 发送失败", chat_id=chat_id, error=str(e))
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
