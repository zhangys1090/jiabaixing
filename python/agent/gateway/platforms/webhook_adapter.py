"""HTTP Webhook 适配器。

WebhookAdapter 是最简单的消息平台适配器，
通过 HTTP POST 请求接收入站消息，适用于第三方系统回调场景。

工作原理:
    1. 启动时创建 FastAPI/Starlette HTTP 服务器
    2. 暴露 POST /webhook/{adapter_name} 端点接收消息
    3. 入站消息转换为统一 Message 格式
    4. 通过内部 asyncio.Queue 供 receive_message() 消费

Usage:
    adapter = WebhookAdapter(host="0.0.0.0", port=9000)
    await adapter.start()
    async for msg in adapter.receive_message():
        print(msg.content)
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Any, AsyncIterator

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from agent.gateway.base import Message, PlatformAdapter
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("gateway.webhook_adapter")


class WebhookAdapter(PlatformAdapter):
    """HTTP Webhook 入站适配器。

    通过 HTTP POST 请求接收外部系统的消息推送，
    适合 GitHub、GitLab、自定义系统等 Webhook 回调场景。

    Attributes:
        _host: 监听地址。
        _port: 监听端口。
        _queue: 入站消息队列。
        _app: FastAPI 应用实例。
        _server: uvicorn 服务器实例。
        _connected: 连接状态标志。
    """

    def __init__(self, host: str = "0.0.0.0", port: int = 9000) -> None:
        """初始化 Webhook 适配器。

        Args:
            host: 监听地址，默认 "0.0.0.0"。
            port: 监听端口，默认 9000。
        """
        self._host = host
        self._port = port
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._app = FastAPI(title="Webhook Gateway")
        self._server: uvicorn.Server | None = None
        self._connected = False
        self._setup_routes()

    def _setup_routes(self) -> None:
        """注册 Webhook HTTP 路由。"""

        @self._app.post(f"/webhook/{self.name}")
        async def webhook_endpoint(request: Request) -> JSONResponse:
            """处理入站 Webhook POST 请求。

            请求体需包含 content 字段，可选 sender 和 metadata 字段。
            """
            try:
                body = await request.json()
            except Exception:
                return JSONResponse(
                    status_code=400,
                    content={"error": "invalid JSON body"},
                )

            content = body.get("content", "")
            if not content:
                return JSONResponse(
                    status_code=400,
                    content={"error": "missing 'content' field"},
                )

            message = Message(
                id=body.get("id", uuid.uuid4().hex),
                platform=self.name,
                sender=body.get("sender", "webhook"),
                content=content,
                timestamp=body.get("timestamp"),
                metadata=body.get("metadata", {}),
            )
            if not isinstance(message.timestamp, datetime):
                message.timestamp = datetime.now()

            await self._queue.put(message)
            log.info(
                "Webhook 消息入站",
                msg_id=message.id,
                sender=message.sender,
                content_len=len(message.content),
            )
            return JSONResponse(
                status_code=200,
                content={"status": "ok", "message_id": message.id},
            )

        @self._app.get("/health")
        async def health_check() -> JSONResponse:
            """健康检查端点。"""
            return JSONResponse(
                status_code=200,
                content={"status": "healthy", "adapter": self.name},
            )

    @property
    def name(self) -> str:
        """返回适配器名称。

        Returns:
            str: "webhook"。
        """
        return "webhook"

    async def start(self) -> None:
        """启动 Webhook HTTP 服务器。

        使用 uvicorn 在后台运行 FastAPI 应用。

        Raises:
            Exception: 服务器启动失败时抛出。
        """
        if self._connected:
            log.warning("适配器已在运行中")
            return

        config = uvicorn.Config(
            app=self._app,
            host=self._host,
            port=self._port,
            log_level="warning",
        )
        self._server = uvicorn.Server(config)

        # 在后台启动服务器
        self._task = asyncio.create_task(self._server.serve())
        # 等待服务器就绪
        for _ in range(50):
            if self._server.started:
                break
            await asyncio.sleep(0.1)

        self._connected = True
        log.info("Webhook 适配器已启动", host=self._host, port=self._port)

    async def stop(self) -> None:
        """停止 Webhook HTTP 服务器。"""
        if self._server is not None:
            self._server.should_exit = True
            if hasattr(self, "_task") and not self._task.done():
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError as _exc:
                    log_ignored(log, "webhook_adapter.WebhookAdapter.stop", _exc)
            self._server = None
        self._connected = False
        log.info("Webhook 适配器已停止")

    async def send_message(self, chat_id: str, text: str) -> bool:
        """Webhook 适配器不支持主动发送消息。

        Args:
            chat_id: 未使用。
            text: 未使用。

        Returns:
            bool: 始终返回 False，Webhook 是单向入站适配器。
        """
        log.warning("Webhook 适配器不支持主动发送消息")
        return False

    async def receive_message(self) -> AsyncIterator[Message]:
        """从内部队列消费入站消息。

        Yields:
            Message: 从 Webhook 接收到的统一消息对象。
        """
        while self._connected:
            try:
                message = await asyncio.wait_for(
                    self._queue.get(), timeout=1.0
                )
                yield message
            except asyncio.TimeoutError:
                continue

    async def is_connected(self) -> bool:
        """检查适配器连接状态。

        Returns:
            bool: 服务器运行中返回 True。
        """
        return self._connected
