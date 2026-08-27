"""DistributedLock — 工作流分布式锁。

防止多实例部署时并发启动同一工作流定义。
底层复用 infrastructure.distributed_lock 的成熟实现：
- Redis SETNX + 自动续期（后台任务按 TTL/2 续租）
- 进程内 asyncio.Lock 降级（单机/测试）

适配层将 infrastructure 的 DistributedLock 接口
映射为 WorkflowEngine 所需的 LockProvider / LockHandle。

Usage:
    from agent.workflow.distributed_lock import create_lock_provider
    provider = create_lock_provider()
    handle = await provider.acquire("workflow:abc123", ttl=300.0)
    ...
    await provider.release(handle)
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("workflow_distributed_lock")


class LockProvider(ABC):
    """分布式锁提供者基类。"""

    @abstractmethod
    async def acquire(self, resource: str, ttl: float = 60.0) -> LockHandle | None:
        """获取锁。

        Args:
            resource: 资源标识。
            ttl: 锁存活时间（秒）。

        Returns:
            LockHandle 或 None（获取失败）。
        """

    @abstractmethod
    async def release(self, handle: LockHandle) -> bool:
        """释放锁。"""

    @abstractmethod
    async def extend(self, handle: LockHandle, ttl: float = 60.0) -> bool:
        """延长锁的存活时间。"""

    @abstractmethod
    async def is_locked(self, resource: str) -> bool:
        """检查资源是否被锁定。"""


class LockHandle:
    """锁句柄。

    Attributes:
        resource: 资源标识。
        owner: 锁持有者标识。
        acquired_at: 获取时间戳。
        expires_at: 过期时间戳。
    """

    def __init__(self, resource: str, owner: str, acquired_at: float, expires_at: float) -> None:
        self.resource = resource
        self.owner = owner
        self.acquired_at = acquired_at
        self.expires_at = expires_at

    @property
    def is_expired(self) -> bool:
        return time.time() > self.expires_at

    async def __aenter__(self) -> LockHandle:
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        return False


class InfrastructureLockProvider(LockProvider):
    """适配器 — 包装 infrastructure.distributed_lock.DistributedLock。

    复用已有的成熟分布式锁实现，优势：
    - Redis 后端自动续期（_extend_loop），防止长任务锁过期
    - 进程内降级锁（LocalLock），单机安全
    - 异步安全，不阻塞事件循环
    - 环境变量自动配置（REDIS_ENABLED / REDIS_URL）
    """

    def __init__(self) -> None:
        from agent.infrastructure.distributed_lock import create_lock
        self._create_lock = create_lock
        self._active: dict[str, Any] = {}

    async def acquire(self, resource: str, ttl: float = 60.0) -> LockHandle | None:
        ttl_ms = int(ttl * 1000)
        lock = self._create_lock(
            resource,
            ttl_ms=ttl_ms,
            auto_extend=True,
            max_retries=3,
            retry_interval_ms=200,
        )
        acquired = await lock.acquire(ttl_ms=ttl_ms)
        if not acquired:
            return None
        now = time.time()
        handle = LockHandle(
            resource=resource,
            owner=lock._token if hasattr(lock, "_token") else "",
            acquired_at=now,
            expires_at=now + ttl,
        )
        self._active[resource] = (lock, handle)
        log.info("工作流锁获取成功", resource=resource)
        return handle

    async def release(self, handle: LockHandle) -> bool:
        entry = self._active.pop(handle.resource, None)
        if entry is None:
            return False
        lock, _ = entry
        await lock.release()
        log.info("工作流锁释放", resource=handle.resource)
        return True

    async def extend(self, handle: LockHandle, ttl: float = 60.0) -> bool:
        entry = self._active.get(handle.resource)
        if entry is None:
            return False
        lock, _ = entry
        if hasattr(lock, "_extend_ttl"):
            try:
                extended = lock._extend_ttl()
                if extended:
                    handle.expires_at = time.time() + ttl
                    return True
            except Exception as _exc:
                log.debug("distributed_lock 异常处理", error=str(_exc))
                log_ignored(log, "distributed_lock.InMemoryDistributedLockProvider.extend", _exc)
        if hasattr(lock, "acquire") and hasattr(lock, "_acquired") and lock._acquired:
            handle.expires_at = time.time() + ttl
            return True
        return False

    async def is_locked(self, resource: str) -> bool:
        entry = self._active.get(resource)
        if entry is None:
            return False
        lock, _ = entry
        return lock.held()


class CoreDistributedLockProvider(LockProvider):
    """适配器 — 包装 core.distributed.DistributedLock。

    使用 SQLite + 心跳续期的分布式锁，
    适用于无 Redis 但需要跨进程互斥的场景。
    """

    def __init__(self) -> None:
        from agent.core.distributed import DistributedLock as CoreLock
        from agent.core.distributed import LockConfig
        self._core_lock_cls = CoreLock
        self._lock_config = LockConfig
        self._active: dict[str, Any] = {}

    async def acquire(self, resource: str, ttl: float = 60.0) -> LockHandle | None:
        config = self._lock_config(ttl_seconds=ttl, max_retries=3)
        lock = self._core_lock_cls(name=resource, config=config)
        acquired = await lock.acquire(timeout=ttl)
        if not acquired:
            return None
        now = time.time()
        handle = LockHandle(
            resource=resource,
            owner=lock._owner_id,
            acquired_at=now,
            expires_at=now + ttl,
        )
        self._active[resource] = (lock, handle)
        log.info("CoreDistributed 锁获取成功", resource=resource)
        return handle

    async def release(self, handle: LockHandle) -> bool:
        entry = self._active.pop(handle.resource, None)
        if entry is None:
            return False
        lock, _ = entry
        lock.release()
        log.info("CoreDistributed 锁释放", resource=handle.resource)
        return True

    async def extend(self, handle: LockHandle, ttl: float = 60.0) -> bool:
        entry = self._active.get(handle.resource)
        if entry is None:
            return False
        lock, _ = entry
        if hasattr(lock, "_extend_ttl"):
            try:
                extended = lock._extend_ttl()
                if extended:
                    handle.expires_at = time.time() + ttl
                    return True
            except Exception as _exc:
                log.debug("distributed_lock 异常处理", error=str(_exc))
                log_ignored(log, "distributed_lock.CoreDistributedLockProvider.extend", _exc)
        return False

    async def is_locked(self, resource: str) -> bool:
        entry = self._active.get(resource)
        if entry is None:
            return False
        lock, _ = entry
        return lock.is_owned()


def create_lock_provider(
    backend: str = "auto",
    **kwargs: Any,
) -> LockProvider:
    """工厂方法 — 创建锁提供者。

    Args:
        backend: 后端类型 (auto/infrastructure/core)。
            - auto: 优先使用 infrastructure（Redis + 自动续期），
                    不可用时降级为 core（SQLite + 心跳）
            - infrastructure: 使用 infrastructure.distributed_lock
            - core: 使用 core.distributed.DistributedLock

    Returns:
        LockProvider 实例。
    """
    if backend == "core":
        provider = CoreDistributedLockProvider()
        log.debug("锁提供者选择", backend="CoreDistributed (SQLite)")
        return provider

    if backend == "infrastructure":
        provider = InfrastructureLockProvider()
        log.debug("锁提供者选择", backend="Infrastructure (Redis/Local)")
        return provider

    try:
        provider = InfrastructureLockProvider()
        log.debug("锁提供者选择", backend="Infrastructure (auto)")
        return provider
    except Exception as _exc:
        log.debug("distributed_lock 异常处理", error=str(_exc))
        log_ignored(log, "distributed_lock.create_lock_provider", _exc)

    provider = CoreDistributedLockProvider()
    log.debug("锁提供者选择", backend="CoreDistributed (fallback)")
    return provider
