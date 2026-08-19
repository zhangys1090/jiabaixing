"""HTTP API 服务端适配器。

APIServerAdapter 提供标准 HTTP API 端点，
支持通过 /chat 接口发送消息、/health 健康检查、/adapters 查询适配器状态。

适用于需要 RESTful API 交互的场景，如 IDE 插件、管理后台等。

工作原理:
    1. 启动时创建 FastAPI HTTP 服务器
    2. 暴露 /chat, /health, /adapters 端点
    3. /chat 请求转为统一 Message 格式并入队
    4. receive_message() 从队列消费消息

Usage:
    adapter = APIServerAdapter(host="0.0.0.0", port=9001)
    await adapter.start()
    async for msg in adapter.receive_message():
        result = await process(msg)
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

log = StructuredLogger("gateway.api_server_adapter")


class APIServerAdapter(PlatformAdapter):
    """HTTP API 服务端适配器。

    提供标准 RESTful API 端点供外部系统调用，
    适合 IDE 插件、管理后台、自定义客户端等需要主动推送消息的场景。

    Attributes:
        _host: 监听地址。
        _port: 监听端口。
        _queue: 入站消息队列。
        _app: FastAPI 应用实例。
        _server: uvicorn 服务器实例。
        _connected: 连接状态标志。
        _pending_responses: 等待响应的请求映射，request_id -> asyncio.Future。
    """

    def __init__(self, host: str = "0.0.0.0", port: int = 9001) -> None:
        """初始化 API 服务端适配器。

        Args:
            host: 监听地址，默认 "0.0.0.0"。
            port: 监听端口，默认 9001。
        """
        self._host = host
        self._port = port
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._app = FastAPI(title="API Server Gateway")
        self._server: uvicorn.Server | None = None
        self._connected = False
        self._pending_responses: dict[str, asyncio.Future[str]] = {}
        self._setup_routes()

    def _setup_routes(self) -> None:
        """注册 API HTTP 路由。"""

        @self._app.post("/chat")
        async def chat_endpoint(request: Request) -> JSONResponse:
            """处理 /chat 消息请求。

            请求体需包含 message 字段，可选 session_id、sender、metadata 字段。
            若携带 request_id，则等待处理结果后同步返回。
            """
            try:
                body = await request.json()
            except Exception:
                return JSONResponse(
                    status_code=400,
                    content={"error": "invalid JSON body"},
                )

            content = body.get("message", "") or body.get("content", "")
            if not content:
                return JSONResponse(
                    status_code=400,
                    content={"error": "missing 'message' or 'content' field"},
                )

            if len(content) > 100000:
                return JSONResponse(
                    status_code=413,
                    content={"error": "content too long (max 100KB)"},
                )

            metadata = body.get("metadata", {})
            if not isinstance(metadata, dict):
                return JSONResponse(
                    status_code=400,
                    content={"error": "'metadata' must be a JSON object"},
                )

            request_id = body.get("request_id", uuid.uuid4().hex)
            message = Message(
                id=request_id,
                platform=self.name,
                sender=body.get("sender", "api_client"),
                content=content,
                timestamp=datetime.now(),
                metadata=metadata,
            )

            # 如果请求要求同步响应，创建 Future
            sync_mode = body.get("sync", False)
            if sync_mode:
                loop = asyncio.get_event_loop()
                future: asyncio.Future[str] = loop.create_future()
                self._pending_responses[request_id] = future

            await self._queue.put(message)
            log.info(
                "API 消息入站",
                msg_id=message.id,
                sender=message.sender,
                content_len=len(message.content),
                sync=sync_mode,
            )

            if sync_mode:
                try:
                    result = await asyncio.wait_for(future, timeout=60.0)
                    return JSONResponse(
                        status_code=200,
                        content={
                            "status": "ok",
                            "message_id": message.id,
                            "response": result,
                        },
                    )
                except asyncio.TimeoutError:
                    self._pending_responses.pop(request_id, None)
                    return JSONResponse(
                        status_code=504,
                        content={"error": "response timeout", "message_id": message.id},
                    )

            return JSONResponse(
                status_code=200,
                content={"status": "accepted", "message_id": message.id},
            )

        @self._app.get("/health")
        async def health_check() -> JSONResponse:
            """健康检查端点。"""
            return JSONResponse(
                status_code=200,
                content={"status": "healthy", "adapter": self.name},
            )

        @self._app.get("/adapters")
        async def list_adapters() -> JSONResponse:
            """查询适配器状态端点。"""
            return JSONResponse(
                status_code=200,
                content={
                    "adapter": self.name,
                    "connected": self._connected,
                    "pending_responses": len(self._pending_responses),
                    "queue_size": self._queue.qsize(),
                },
            )

    @property
    def name(self) -> str:
        """返回适配器名称。

        Returns:
            str: "api_server"。
        """
        return "api_server"

    async def start(self) -> None:
        """启动 API HTTP 服务器。

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

        self._task = asyncio.create_task(self._server.serve())
        for _ in range(50):
            if self._server.started:
                break
            await asyncio.sleep(0.1)

        self._connected = True
        log.info("API Server 适配器已启动", host=self._host, port=self._port)

    async def stop(self) -> None:
        """停止 API HTTP 服务器。"""
        # 取消所有等待中的响应
        for fut in self._pending_responses.values():
            if not fut.done():
                fut.cancel()
        self._pending_responses.clear()

        if self._server is not None:
            self._server.should_exit = True
            if hasattr(self, "_task") and not self._task.done():
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError as _exc:
                    log_ignored(log, "api_server_adapter.APIServerAdapter.stop", _exc)
            self._server = None
        self._connected = False
        log.info("API Server 适配器已停止")

    async def send_message(self, chat_id: str, text: str) -> bool:
        """向等待中的请求返回响应。

        若 chat_id 对应的请求有 pending Future，则设置结果。
        否则仅记录日志（API Server 适配器不主动推送消息）。

        Args:
            chat_id: 对应请求的 request_id。
            text: 响应文本内容。

        Returns:
            bool: 成功设置响应返回 True，无对应请求返回 False。
        """
        future = self._pending_responses.pop(chat_id, None)
        if future is not None and not future.done():
            future.set_result(text)
            return True
        log.warning("无对应请求，消息丢弃", chat_id=chat_id)
        return False

    async def receive_message(self) -> AsyncIterator[Message]:
        """从内部队列消费入站消息。

        Yields:
            Message: 从 API 端点接收到的统一消息对象。
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
