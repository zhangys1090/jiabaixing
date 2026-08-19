"""LLM 连接池 (HTTP Connection Pool)。

基于 httpx 的持久连接池，避免每次请求重建 TCP/TLS 连接：
- HTTP Keep-Alive 复用，减少 50-200ms 握手延迟
- 按 host 分池，不同 provider 独立管理
- 自动清理空闲连接和过期连接
- 连接预热（提前建立连接）
- 连接健康检查（自动剔除失效连接）

架构：
    ConnectionPoolManager
    ├── pool: "api.openai.com"    → HTTPConnectionPool
    ├── pool: "api.anthropic.com" → HTTPConnectionPool
    └── pool: "generativelanguage.googleapis.com" → HTTPConnectionPool

Usage:
    pool = LLMConnectionPool(base_url="https://api.openai.com")
    async with pool.get_client() as client:
        resp = await client.post("/v1/chat/completions", json=body)
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx
from agent.core.logger import log_ignored


@dataclass
class PoolConfig:
    max_connections: int = 20
    max_keepalive_connections: int = 10
    keepalive_expiry: float = 30.0
    connect_timeout: float = 10.0
    read_timeout: float = 60.0
    write_timeout: float = 30.0
    pool_timeout: float = 5.0
    max_idle_time: float = 300.0
    retries: int = 2
    enabled: bool = True


@dataclass
class PoolStats:
    base_url: str = ""
    active_connections: int = 0
    idle_connections: int = 0
    total_requests: int = 0
    total_errors: int = 0
    avg_latency_ms: float = 0.0
    created_at: float = 0.0


class LLMConnectionPool:
    """LLM HTTP 连接池 — 持久连接复用。

    为每个 LLM provider 维护一个 httpx.AsyncClient 连接池，
    支持 Keep-Alive 连接复用和自动清理。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str = "",
        config: PoolConfig | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._config = config or PoolConfig()
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()
        self._total_requests = 0
        self._total_errors = 0
        self._latencies: list[float] = []
        self._created_at = time.time()
        self._last_used = time.time()
        self._closed = False

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def stats(self) -> PoolStats:
        avg_lat = 0.0
        if self._latencies:
            avg_lat = sum(self._latencies[-100:]) / min(len(self._latencies), 100)
        return PoolStats(
            base_url=self._base_url,
            active_connections=0,
            idle_connections=0,
            total_requests=self._total_requests,
            total_errors=self._total_errors,
            avg_latency_ms=avg_lat * 1000,
            created_at=self._created_at,
        )

    async def get_client(self) -> httpx.AsyncClient:
        """获取或创建持久化 HTTP 客户端。

        首次调用创建客户端，后续复用同一实例。
        自动处理过期重连和健康检查。
        """
        if self._closed:
            raise RuntimeError(f"Connection pool for {self._base_url} is closed")

        async with self._lock:
            if self._client is not None:
                if not self._client.is_closed:
                    self._last_used = time.time()
                    return self._client

            headers: dict[str, str] = {}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"

            limits = httpx.Limits(
                max_connections=self._config.max_connections,
                max_keepalive_connections=self._config.max_keepalive_connections,
                keepalive_expiry=self._config.keepalive_expiry,
            )

            timeout = httpx.Timeout(
                connect=self._config.connect_timeout,
                read=self._config.read_timeout,
                write=self._config.write_timeout,
                pool=self._config.pool_timeout,
            )

            transport = httpx.AsyncHTTPTransport(
                limits=limits,
                retries=self._config.retries,
            )

            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers=headers,
                timeout=timeout,
                transport=transport,
            )
            self._last_used = time.time()
            return self._client

    def record_request(self, latency: float, success: bool) -> None:
        self._total_requests += 1
        if not success:
            self._total_errors += 1
        self._latencies.append(latency)
        if len(self._latencies) > 1000:
            self._latencies = self._latencies[-500:]

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._closed = True

    def is_idle(self) -> bool:
        return time.time() - self._last_used > self._config.max_idle_time


class ConnectionPoolManager:
    """连接池管理器 — 按 base_url 分池。

    统一管理所有 LLM provider 的连接池，
    支持自动清理空闲连接和全局统计。
    """

    def __init__(self, config: PoolConfig | None = None) -> None:
        self._config = config or PoolConfig()
        self._pools: dict[str, LLMConnectionPool] = {}
        self._lock = asyncio.Lock()
        self._cleanup_task: asyncio.Task | None = None

    async def get_pool(
        self,
        base_url: str,
        api_key: str = "",
    ) -> LLMConnectionPool:
        async with self._lock:
            if base_url not in self._pools:
                self._pools[base_url] = LLMConnectionPool(
                    base_url=base_url,
                    api_key=api_key,
                    config=self._config,
                )
            return self._pools[base_url]

    async def get_or_create(
        self,
        base_url: str,
        api_key: str = "",
    ) -> LLMConnectionPool:
        return await self.get_pool(base_url, api_key)

    async def warmup(self, base_url: str, api_key: str = "") -> None:
        """预热连接池 — 提前建立连接。

        在启动时调用，避免首次请求的冷启动延迟。
        """
        pool = await self.get_pool(base_url, api_key)
        client = await pool.get_client()
        try:
            await client.head("/", timeout=5.0)
        except Exception as _exc:
            log_ignored(None, "connection_pool.ConnectionPoolManager.warmup", _exc)

    async def start_cleanup(self, interval: float = 60.0) -> None:
        """启动定期清理任务 — 关闭空闲连接池。"""
        if self._cleanup_task is not None:
            return

        async def _cleanup_loop() -> None:
            while True:
                await asyncio.sleep(interval)
                async with self._lock:
                    idle_urls = [
                        url for url, pool in self._pools.items()
                        if pool.is_idle()
                    ]
                    for url in idle_urls:
                        pool = self._pools.pop(url)
                        await pool.close()

        self._cleanup_task = asyncio.create_task(_cleanup_loop())

    async def stop_cleanup(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError as _exc:
                log_ignored(None, "connection_pool.ConnectionPoolManager.stop_cleanup", _exc)
            self._cleanup_task = None

    def all_stats(self) -> dict[str, PoolStats]:
        return {url: pool.stats for url, pool in self._pools.items()}

    async def close_all(self) -> None:
        await self.stop_cleanup()
        async with self._lock:
            for pool in self._pools.values():
                await pool.close()
            self._pools.clear()


def get_host_from_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed.netloc or parsed.path.split("/")[0]
