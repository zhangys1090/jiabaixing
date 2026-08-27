"""API 代理服务器。

提供 LLM API 请求的代理和缓存：
  - 多后端代理（OpenAI/Anthropic/Google/本地模型）
  - 请求路由与负载均衡
  - 响应缓存（相同请求复用结果）
  - 速率限制与配额管理
  - 请求/响应日志与审计

与 LLM 客户端的关系：
  - LLM 客户端通过代理发送请求
  - 代理处理路由、缓存和限流
  - 透明代理模式：客户端无需修改

集成示例::

    from agent.api.proxy_server import ProxyServer

    server = ProxyServer()
    server.add_backend("openai", "https://api.openai.com", "sk-...")
    server.add_backend("anthropic", "https://api.anthropic.com", "sk-ant-...")
    await server.start()
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("proxy_server")




class BackendStatus(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    DOWN = "down"


@dataclass
class BackendConfig:
    name: str
    base_url: str
    api_key: str = ""
    weight: int = 1
    status: BackendStatus = BackendStatus.HEALTHY
    max_rpm: int = 60
    current_rpm: int = 0
    total_requests: int = 0
    total_errors: int = 0
    avg_latency_ms: float = 0.0
    last_check: float = 0.0


@dataclass
class CacheEntry:
    key: str
    response: str
    created_at: float
    ttl: float = 300.0
    hit_count: int = 0

    @property
    def is_expired(self) -> bool:
        return time.time() - self.created_at > self.ttl


@dataclass
class ProxyRequest:
    method: str
    path: str
    headers: dict[str, str] = field(default_factory=dict)
    body: dict[str, Any] = field(default_factory=dict)
    backend_hint: str = ""


@dataclass
class ProxyResponse:
    status_code: int
    body: str
    headers: dict[str, str] = field(default_factory=dict)
    cached: bool = False
    backend: str = ""
    latency_ms: float = 0.0


class LRUCache:
    """LRU 响应缓存。"""

    def __init__(self, max_size: int = 100, default_ttl: float = 300.0) -> None:
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._max_size = max_size
        self._default_ttl = default_ttl
        self._hits: int = 0
        self._misses: int = 0

    def _make_key(self, method: str, path: str, body: dict[str, Any]) -> str:
        raw = f"{method}:{path}:{json.dumps(body, sort_keys=True)}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(self, method: str, path: str, body: dict[str, Any]) -> CacheEntry | None:
        key = self._make_key(method, path, body)
        entry = self._cache.get(key)
        if entry is None:
            self._misses += 1
            return None
        if entry.is_expired:
            del self._cache[key]
            self._misses += 1
            return None
        self._cache.move_to_end(key)
        entry.hit_count += 1
        self._hits += 1
        return entry

    def put(self, method: str, path: str, body: dict[str, Any], response: str, ttl: float = 0) -> None:
        key = self._make_key(method, path, body)
        if len(self._cache) >= self._max_size:
            self._cache.popitem(last=False)
        self._cache[key] = CacheEntry(
            key=key,
            response=response,
            created_at=time.time(),
            ttl=ttl or self._default_ttl,
        )

    def invalidate(self, method: str, path: str, body: dict[str, Any]) -> None:
        key = self._make_key(method, path, body)
        self._cache.pop(key, None)

    def clear(self) -> None:
        self._cache.clear()

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "size": len(self._cache),
            "max_size": self._max_size,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": self._hits / (self._hits + self._misses) if (self._hits + self._misses) > 0 else 0,
        }


class ProxyServer:
    """API 代理服务器。

    管理 LLM API 请求的代理、路由和缓存。
    """

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 3113,
        cache_enabled: bool = True,
        cache_max_size: int = 100,
    ) -> None:
        self._host = host
        self._port = port
        self._backends: dict[str, BackendConfig] = {}
        self._cache = LRUCache(max_size=cache_max_size) if cache_enabled else None
        self._rate_limits: dict[str, list[float]] = defaultdict(list)
        self._running: bool = False
        self._MAX_RATE_LIMIT_KEYS = 1000

    def add_backend(
        self,
        name: str,
        base_url: str,
        api_key: str = "",
        weight: int = 1,
        max_rpm: int = 60,
    ) -> None:
        self._backends[name] = BackendConfig(
            name=name,
            base_url=base_url.rstrip("/"),
            api_key=api_key,
            weight=weight,
            max_rpm=max_rpm,
        )
        log.info("代理后端已添加", name=name, url=base_url)

    def remove_backend(self, name: str) -> bool:
        return self._backends.pop(name, None) is not None

    def _select_backend(self, hint: str = "") -> BackendConfig | None:
        if hint and hint in self._backends:
            backend = self._backends[hint]
            if backend.status != BackendStatus.DOWN:
                return backend

        candidates = [
            b for b in self._backends.values()
            if b.status != BackendStatus.DOWN
            and b.current_rpm < b.max_rpm
        ]
        if not candidates:
            return None

        total_weight = sum(b.weight for b in candidates)
        import random
        r = random.randint(1, total_weight)
        cumulative = 0
        for b in candidates:
            cumulative += b.weight
            if r <= cumulative:
                return b
        return candidates[0]

    def _check_rate_limit(self, backend_name: str) -> bool:
        backend = self._backends.get(backend_name)
        if backend is None:
            return False
        now = time.time()
        timestamps = self._rate_limits[backend_name]
        self._rate_limits[backend_name] = [t for t in timestamps if now - t < 60]
        if len(self._rate_limits) > self._MAX_RATE_LIMIT_KEYS:
            stale_keys = [k for k, v in self._rate_limits.items() if not v]
            for k in stale_keys:
                del self._rate_limits[k]
        return len(self._rate_limits[backend_name]) < backend.max_rpm

    async def proxy_request(self, request: ProxyRequest) -> ProxyResponse:
        if self._cache:
            cached = self._cache.get(request.method, request.path, request.body)
            if cached:
                return ProxyResponse(
                    status_code=200,
                    body=cached.response,
                    cached=True,
                    latency_ms=0,
                )

        backend = self._select_backend(request.backend_hint)
        if backend is None:
            return ProxyResponse(status_code=503, body='{"error": "no available backend"}')

        if not self._check_rate_limit(backend.name):
            return ProxyResponse(status_code=429, body='{"error": "rate limit exceeded"}')

        start = time.monotonic()
        try:
            import httpx

            url = f"{backend.base_url}{request.path}"
            headers = dict(request.headers)
            if backend.api_key:
                if "anthropic" in backend.base_url:
                    headers["x-api-key"] = backend.api_key
                else:
                    headers["Authorization"] = f"Bearer {backend.api_key}"

            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.request(
                    request.method,
                    url,
                    headers=headers,
                    json=request.body if request.body else None,
                )

            latency = (time.monotonic() - start) * 1000
            backend.total_requests += 1
            backend.current_rpm += 1
            backend.avg_latency_ms = (
                (backend.avg_latency_ms * (backend.total_requests - 1) + latency)
                / backend.total_requests
            )
            self._rate_limits[backend.name].append(time.time())

            response_body = resp.text

            if self._cache and resp.status_code == 200:
                self._cache.put(request.method, request.path, request.body, response_body)

            return ProxyResponse(
                status_code=resp.status_code,
                body=response_body,
                backend=backend.name,
                latency_ms=latency,
            )
        except Exception as e:
            log.debug("proxy_server 异常处理", error=str(e))
            backend.total_errors += 1
            if backend.total_errors > 5:
                backend.status = BackendStatus.DEGRADED
            latency = (time.monotonic() - start) * 1000
            log.error("代理请求失败", backend=backend.name, error=str(e))
            return ProxyResponse(
                status_code=502,
                body=json.dumps({"error": str(e)}),
                backend=backend.name,
                latency_ms=latency,
            )

    async def start(self) -> None:
        self._running = True
        try:
            from fastapi import FastAPI, Request
            from fastapi.responses import Response
            import uvicorn

            app = FastAPI(title="Jiabaixing API Proxy")

            @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
            async def handle_proxy(request: Request, path: str) -> Response:
                body = await request.json() if request.method in ("POST", "PUT") else {}
                proxy_req = ProxyRequest(
                    method=request.method,
                    path=f"/{path}",
                    headers=dict(request.headers),
                    body=body,
                )
                proxy_resp = await self.proxy_request(proxy_req)
                return Response(
                    content=proxy_resp.body,
                    status_code=proxy_resp.status_code,
                    headers=proxy_resp.headers,
                )

            config = uvicorn.Config(app, host=self._host, port=self._port, log_level="warning")
            server = uvicorn.Server(config)
            await server.serve()
        except ImportError:
            log.warning("fastapi/uvicorn 未安装，代理服务器以模拟模式运行")
        except Exception as e:
            log.error("代理服务器启动失败", error=str(e))

    async def stop(self) -> None:
        self._running = False

    def get_stats(self) -> dict[str, Any]:
        backends = {}
        for name, b in self._backends.items():
            backends[name] = {
                "status": b.status.value,
                "total_requests": b.total_requests,
                "total_errors": b.total_errors,
                "avg_latency_ms": round(b.avg_latency_ms, 1),
                "current_rpm": b.current_rpm,
            }
        return {
            "backends": backends,
            "cache": self._cache.stats if self._cache else {"enabled": False},
        }
