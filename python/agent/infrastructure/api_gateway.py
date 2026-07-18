"""API 网关中间件 — 请求追踪 + API Key 认证 + 令牌桶限流。

集成到 FastAPI 应用中，提供三层防护:
    1. 请求追踪: 为每个请求生成 trace_id，注入响应头
    2. API Key 认证: 校验 X-API-Key 头，支持多 Key + 权限分级
    3. 令牌桶限流: 按 Key/IP 限流，防止滥用

Usage:
    from agent.infrastructure.api_gateway import ApiGatewayMiddleware
    app.add_middleware(ApiGatewayMiddleware, api_keys={"key1": "admin", "key2": "read"})
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("api_gateway")


@dataclass
class TokenBucket:
    """令牌桶限流器。

    按固定速率补充令牌，每次请求消耗一个令牌。
    桶满时停止补充，桶空时拒绝请求。

    Attributes:
        capacity: 桶容量（最大令牌数）。
        tokens: 当前令牌数（初始化时自动设为 capacity）。
        refill_rate: 令牌补充速率（每秒补充的令牌数）。
        last_refill: 上次补充时间（单调时钟）。
    """

    capacity: int
    tokens: float = 0.0
    refill_rate: float = 1.0
    last_refill: float = field(default_factory=time.monotonic)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def __post_init__(self) -> None:
        """初始化后设置令牌数为桶容量。"""
        if self.tokens == 0.0:
            self.tokens = float(self.capacity)

    async def consume(self, tokens: int = 1) -> bool:
        """消耗令牌。

        先补充自上次消耗以来积累的令牌，再尝试消耗指定数量。
        补充后令牌数不超过桶容量。

        Args:
            tokens: 要消耗的令牌数，默认 1。

        Returns:
            bool: 消耗成功返回 True，令牌不足返回 False。
        """
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self.last_refill
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
            self.last_refill = now
            if self.tokens >= tokens:
                self.tokens -= tokens
                return True
            return False


class ApiGatewayMiddleware:
    """API 网关中间件 — 请求追踪 + API Key 认证 + 令牌桶限流。

    作为 ASGI 中间件集成到 FastAPI 应用，提供三层防护:
        1. 请求追踪: 为每个请求生成 trace_id，注入响应头
        2. API Key 认证: 校验 X-API-Key 头，支持多 Key + 权限分级
        3. 令牌桶限流: 按 Key/IP 限流，capacity=0 时禁用

    Args:
        app: ASGI 应用实例。
        api_keys: API Key 映射 {key: role}，空字典时不要求认证。
        rate_limit_capacity: 令牌桶容量，0 表示禁用限流。
        rate_limit_refill: 令牌桶补充速率（每秒令牌数）。
        public_paths: 免认证路径集合。
        require_api_key: 是否强制要求 API Key。
    """

    def __init__(
        self,
        app: Any,
        api_keys: dict[str, str] | None = None,
        rate_limit_capacity: int = 60,
        rate_limit_refill: float = 1.0,
        public_paths: set[str] | None = None,
        require_api_key: bool = False,
    ) -> None:
        """初始化 API 网关中间件。"""
        self.app = app
        self._api_keys: dict[str, str] = api_keys or {}
        self._require_api_key = require_api_key
        self._rate_limit_capacity = rate_limit_capacity
        self._rate_limit_refill = rate_limit_refill
        self._public_paths: set[str] = public_paths or {
            "/",
            "/v1/metrics",
            "/v1/metrics/dashboard",
            "/docs",
            "/openapi.json",
            "/health",
        }
        self._buckets: dict[str, TokenBucket] = {}
        self._request_counts: dict[str, int] = defaultdict(int)

    def _get_bucket(self, key: str) -> TokenBucket:
        """获取或创建客户端对应的令牌桶。

        Args:
            key: 客户端标识（API Key 或 IP）。

        Returns:
            TokenBucket: 该客户端的令牌桶实例。
        """
        if key not in self._buckets:
            self._buckets[key] = TokenBucket(
                capacity=self._rate_limit_capacity,
                refill_rate=self._rate_limit_refill,
            )
        return self._buckets[key]

    def _generate_trace_id(self) -> str:
        """生成请求追踪 ID（16 位十六进制）。"""
        import uuid
        return uuid.uuid4().hex[:16]

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        """ASGI 中间件入口。

        处理流程:
        1. 非 HTTP 请求直接透传
        2. 解析请求头，生成 trace_id
        3. API Key 认证（需要时）
        4. 令牌桶限流（capacity > 0 时）
        5. 注入 trace_id 到响应头后透传

        Args:
            scope: ASGI scope 字典。
            receive: ASGI receive 可调用对象。
            send: ASGI send 可调用对象。
        """
        if scope["type"] == "websocket":
            path = scope.get("path", "/")
            headers_raw = scope.get("headers", [])
            headers = {}
            for k, v in headers_raw:
                headers[k.decode() if isinstance(k, bytes) else k] = (
                    v.decode() if isinstance(v, bytes) else v
                )

            # A-04: WebSocket 也需要 API Key 认证
            if self._require_api_key and path not in self._public_paths:
                api_key = headers.get("x-api-key", "")
                if not api_key or api_key not in self._api_keys:
                    await send({"type": "websocket.close", "code": 1008, "reason": "Unauthorized"})
                    return

            # A-04: WebSocket 也需要令牌桶限流
            client_id = (
                headers.get("x-api-key", "")
                or headers.get("x-forwarded-for", "")
                or scope.get("client", ("", 0))[0]
                or "ws_anon"
            )
            if self._rate_limit_capacity > 0:
                bucket = self._get_bucket(client_id)
                if not await bucket.consume():
                    await send({"type": "websocket.close", "code": 1008, "reason": "Rate limit exceeded"})
                    return

            self._request_counts[client_id] += 1
            await self.app(scope, receive, send)
            return

        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "/")
        headers_raw = scope.get("headers", [])
        headers = {}
        for k, v in headers_raw:
            headers[k.decode() if isinstance(k, bytes) else k] = (
                v.decode() if isinstance(v, bytes) else v
            )

        trace_id = headers.get("x-trace-id", "") or self._generate_trace_id()

        # 1. API Key 认证
        if self._require_api_key and path not in self._public_paths:
            api_key = headers.get("x-api-key", "")
            if not api_key:
                await self._send_json(send, 401, {"error": "Missing API Key", "trace_id": trace_id})
                return
            if api_key not in self._api_keys:
                await self._send_json(send, 403, {"error": "Invalid API Key", "trace_id": trace_id})
                return

        # 2. 令牌桶限流（capacity=0 时禁用）
        client_id = (
            headers.get("x-api-key", "")
            or headers.get("x-forwarded-for", "")
            or scope.get("client", ("", 0))[0]
            or f"anon_{hashlib.md5(str(scope.get('client', ('', 0))).encode()).hexdigest()[:8]}"
        )
        if self._rate_limit_capacity > 0:
            bucket = self._get_bucket(client_id)
            if not await bucket.consume():
                await self._send_json(
                    send, 429, {"error": "Rate limit exceeded", "trace_id": trace_id}
                )
                return

        self._request_counts[client_id] += 1

        # 3. 注入 trace_id 到响应头
        async def send_with_trace(message: dict) -> None:
            """在响应头中注入 x-trace-id。"""
            if message["type"] == "http.response.start":
                headers_list = list(message.get("headers", []))
                trace_header = (b"x-trace-id", trace_id.encode())
                headers_list.append(trace_header)
                message["headers"] = headers_list
            await send(message)

        await self.app(scope, receive, send_with_trace)

    async def _send_json(self, send: Any, status: int, body: dict) -> None:
        """发送 JSON 格式的 HTTP 错误响应。

        Args:
            send: ASGI send 可调用对象。
            status: HTTP 状态码。
            body: 响应体字典。
        """
        import json
        body_bytes = json.dumps(body, ensure_ascii=False).encode()
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"x-trace-id", body.get("trace_id", "").encode()),
            ],
        })
        await send({
            "type": "http.response.body",
            "body": body_bytes,
        })

    def get_stats(self) -> dict[str, Any]:
        """获取网关统计信息。

        Returns:
            dict: 包含客户端数量、请求计数和活跃令牌桶数。
        """
        return {
            "total_clients": len(self._buckets),
            "request_counts": dict(self._request_counts),
            "active_buckets": len(self._buckets),
        }
