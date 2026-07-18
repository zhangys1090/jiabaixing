"""分布式锁 —— 多副本部署下的互斥与防重。

背景（审计 P0-1）：K8s 已 2 副本 + HPA 至 10，但此前全仓无分布式锁实现，
仅 configmap 有 LOCK_* 占位配置。共享 SQLite/Redis 在并发写时存在竞态隐患。

设计：
- Redis 后端：`SET key token NX PX ttl` 争用；Lua 脚本仅在持有者匹配时释放；
  可选自动续期（后台任务，按 TTL 半数续租）防止长任务持锁过期。
- 进程内降级：Redis 不可用时回退为 `asyncio.Lock`，并以模块级注册表
  按锁名共享底层锁——这样同一进程内的两个"伪实例"也能真实竞争，便于单测。
- `create_lock(name)` 工厂按 `REDIS_ENABLED` 选择后端；`get_lock_manager()` 提供单例。
- 全部操作优雅降级：Redis 异常不抛，仅告警。

环境变量：REDIS_ENABLED / REDIS_URL / LOCK_TIMEOUT_MS / LOCK_RETRY_INTERVAL_MS /
LOCK_MAX_RETRIES / LOCK_AUTO_EXTEND（与 deploy/kubernetes/configmap.yaml 对齐）。
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("distributed_lock")

LOCK_TIMEOUT_MS_DEFAULT: int = 30_000
LOCK_RETRY_INTERVAL_MS_DEFAULT: int = 200
LOCK_MAX_RETRIES_DEFAULT: int = 10
LOCK_AUTO_EXTEND_DEFAULT: bool = True


def _get_redis_url() -> str:
    url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    # Windows: localhost 优先解析 IPv6(::1)，redis-server 默认仅监听 IPv4
    if "://localhost" in url:
        url = url.replace("://localhost", "://127.0.0.1")
    return url


def _is_redis_enabled() -> bool:
    return os.environ.get("REDIS_ENABLED", "false").lower() in ("true", "1", "yes")


def _lock_timeout_ms() -> int:
    return int(os.environ.get("LOCK_TIMEOUT_MS", str(LOCK_TIMEOUT_MS_DEFAULT)))


def _lock_retry_interval_ms() -> int:
    return int(os.environ.get("LOCK_RETRY_INTERVAL_MS", str(LOCK_RETRY_INTERVAL_MS_DEFAULT)))


def _lock_max_retries() -> int:
    return int(os.environ.get("LOCK_MAX_RETRIES", str(LOCK_MAX_RETRIES_DEFAULT)))


def _lock_auto_extend() -> bool:
    return os.environ.get("LOCK_AUTO_EXTEND", "true").lower() in ("true", "1", "yes")


class DistributedLock:
    """分布式锁抽象。

    子类实现 acquire/release；支持 async with 上下文管理器。
    若 `acquire()` 在重试耗尽后仍失败，`async with` 会抛出 RuntimeError，
    调用方需自行决定跳过或重试。
    """

    def __init__(self, name: str) -> None:
        self._name = name
        self._acquired = False

    async def acquire(self, ttl_ms: int | None = None) -> bool:
        raise NotImplementedError

    async def release(self) -> None:
        raise NotImplementedError

    def held(self) -> bool:
        """当前是否持有锁（用于领导者选举的持锁探测）。"""
        return self._acquired

    async def __aenter__(self) -> "DistributedLock":
        ok = await self.acquire()
        if not ok:
            raise RuntimeError(f"Failed to acquire lock: {self._name}")
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.release()


class RedisLock(DistributedLock):
    """基于 Redis `SET NX PX` 的分布式锁。

    释放使用 Lua 脚本，仅当 value 与持有者 token 匹配时才 DEL，避免误删他人锁。
    可选自动续期：后台任务按 TTL/2 周期用 `SET XX PX` 续租，防止长任务过期被抢。
    """

    _RELEASE_LUA = """
    if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
    else
        return 0
    end
    """

    def __init__(
        self,
        name: str,
        redis_url: str | None = None,
        ttl_ms: int | None = None,
        auto_extend: bool | None = None,
        retry_interval_ms: int | None = None,
        max_retries: int | None = None,
    ) -> None:
        super().__init__(name)
        self._redis_url = redis_url or _get_redis_url()
        self._ttl_ms = ttl_ms or _lock_timeout_ms()
        self._auto_extend = auto_extend if auto_extend is not None else _lock_auto_extend()
        self._retry_interval_ms = retry_interval_ms or _lock_retry_interval_ms()
        self._max_retries = max_retries if max_retries is not None else _lock_max_retries()
        self._token = uuid.uuid4().hex
        self._redis: Any = None
        self._extend_task: asyncio.Task | None = None
        self._key = f"lock:{self._name}"

    async def _ensure(self) -> Any:
        if self._redis is None:
            import redis.asyncio as aioredis

            self._redis = aioredis.from_url(
                self._redis_url, decode_responses=True, max_connections=10,
                protocol=2,  # RESP2 兼容 Redis 5.x（Windows 移植版不支持 RESP3 HELLO）
            )
        return self._redis

    async def acquire(self, ttl_ms: int | None = None) -> bool:
        if self._acquired:
            return True
        r = await self._ensure()
        ttl = ttl_ms or self._ttl_ms
        retries = 0
        while retries <= self._max_retries:
            ok = await r.set(self._key, self._token, nx=True, px=ttl)
            if ok:
                self._acquired = True
                if self._auto_extend:
                    self._extend_task = asyncio.create_task(self._extend_loop(ttl))
                return True
            retries += 1
            await asyncio.sleep(self._retry_interval_ms / 1000.0)
        return False

    async def _extend_loop(self, ttl_ms: int) -> None:
        try:
            while self._acquired and self._redis is not None:
                await asyncio.sleep(ttl_ms / 2000.0)  # 在 TTL 半数时续租
                if not self._acquired:
                    break
                try:
                    await self._redis.set(self._key, self._token, xx=True, px=ttl_ms)
                except Exception:
                    break
        except asyncio.CancelledError:
            pass

    async def release(self) -> None:
        if not self._acquired:
            return
        self._acquired = False
        if self._extend_task is not None:
            self._extend_task.cancel()
            self._extend_task = None
        try:
            r = await self._ensure()
            await r.eval(RedisLock._RELEASE_LUA, 1, self._key, self._token)
        except Exception as exc:
            log.warning("lock release error", name=self._name, error=str(exc))
        finally:
            try:
                if self._redis is not None:
                    await self._redis.aclose()
            except Exception:
                pass
            self._redis = None


class LocalLock(DistributedLock):
    """进程内降级锁。

    按「锁名 + 事件循环」在模块级注册表共享底层 `asyncio.Lock`——因此同一进程
    （同一事件循环）内的两个 `LocalLock("x")` 实例会真实互斥（用于测试模拟多
    副本竞争，以及单实例安全）。按事件循环分桶可避免 asyncio.Lock 跨循环复用
    报错（pytest 每测试新建循环的场景）。
    """

    _registry: dict[str, dict[int, asyncio.Lock]] = {}
    _owner: dict[str, str] = {}

    @staticmethod
    def _loop_key() -> int:
        try:
            return id(asyncio.get_event_loop())
        except RuntimeError:
            return id(asyncio.new_event_loop())

    def __init__(
        self,
        name: str,
        ttl_ms: int | None = None,
        max_retries: int | None = None,
        retry_interval_ms: int | None = None,
    ) -> None:
        super().__init__(name)
        loop_locks = LocalLock._registry.setdefault(name, {})
        key = self._loop_key()
        if key not in loop_locks:
            loop_locks[key] = asyncio.Lock()
        self._lock = loop_locks[key]
        self._token = uuid.uuid4().hex
        self._ttl_ms = ttl_ms or _lock_timeout_ms()
        self._max_retries = max_retries if max_retries is not None else _lock_max_retries()
        self._retry_interval_ms = retry_interval_ms or _lock_retry_interval_ms()

    async def acquire(self, ttl_ms: int | None = None) -> bool:
        if self._acquired:
            return True
        ttl = ttl_ms or self._ttl_ms
        # max_retries==0：非阻塞抢锁（用于领导者选举的即时竞选，避免阻塞整个启动）
        if self._max_retries == 0:
            try:
                await asyncio.wait_for(self._lock.acquire(), timeout=0.01)
            except (asyncio.TimeoutError, ValueError):
                return False
            self._acquired = True
            LocalLock._owner[self._name] = self._token
            return True
        retries = 0
        while retries <= self._max_retries:
            try:
                await asyncio.wait_for(self._lock.acquire(), timeout=ttl / 1000.0 + 0.5)
                self._acquired = True
                LocalLock._owner[self._name] = self._token
                return True
            except asyncio.TimeoutError:
                retries += 1
                await asyncio.sleep(self._retry_interval_ms / 1000.0)
        return False

    async def release(self) -> None:
        if not self._acquired:
            return
        self._acquired = False
        tok = LocalLock._owner.pop(self._name, None)
        if tok == self._token:
            try:
                self._lock.release()
            except Exception:
                pass


def create_lock(name: str, **kwargs: Any) -> DistributedLock:
    """工厂：按 REDIS_ENABLED 选择后端。"""
    if _is_redis_enabled():
        return RedisLock(name, **kwargs)
    return LocalLock(name, **kwargs)


class LockManager:
    """分布式锁单例工厂（按锁名缓存实例）。"""

    def __init__(self) -> None:
        self._cache: dict[str, DistributedLock] = {}

    def get(self, name: str, **kwargs: Any) -> DistributedLock:
        if name not in self._cache:
            self._cache[name] = create_lock(name, **kwargs)
        return self._cache[name]

    async def acquire(self, name: str, **kwargs: Any) -> bool:
        return await self.get(name, **kwargs).acquire()

    async def release(self, name: str) -> None:
        lk = self._cache.get(name)
        if lk is not None:
            await lk.release()


_lock_manager: LockManager | None = None


def get_lock_manager() -> LockManager:
    global _lock_manager
    if _lock_manager is None:
        _lock_manager = LockManager()
    return _lock_manager
