"""异步读写锁（AsyncRWLock）。

为进程内共享结构（如消息队列的优先级堆）提供并发安全的读写保护：

- 多个写者（push/pop）互斥；
- 多个读者（统计、快照）之间可并发，但读者与写者互斥；
- 采用 **写优先（write-preferring）** 策略，避免持续到来的读者把写者饿死。

纯本地原语，不依赖 Redis，适用于单进程 / 单副本以及进程内降级场景。
与 `distributed_lock.py` 的跨进程互斥形成互补：前者管「单机内协程」，
后者管「多副本间节点」。
"""

from __future__ import annotations

import asyncio
from typing import Any


class AsyncRWLock:
    """异步写优先读写锁。

    用法::

        rw = AsyncRWLock()
        async with rw.write_lock():
            ... 修改共享结构 ...
        async with rw.read_lock():
            ... 只读共享结构 ...
    """

    def __init__(self) -> None:
        # 写者独占锁；首位读者也持有它以挡住写者进入。
        self._write_lock = asyncio.Lock()
        # 保护 _readers 计数（读者并发进入时串行化计数）。
        self._readers_lock = asyncio.Lock()
        self._readers = 0

    def read_lock(self) -> "_ReadGuard":
        return _ReadGuard(self)

    def write_lock(self) -> "_WriteGuard":
        return _WriteGuard(self)

    async def _acquire_read(self) -> None:
        await self._readers_lock.acquire()
        self._readers += 1
        if self._readers == 1:
            # 首位读者占用写锁，阻止写者进入，直到所有读者退出。
            await self._write_lock.acquire()
        self._readers_lock.release()

    async def _release_read(self) -> None:
        await self._readers_lock.acquire()
        self._readers -= 1
        if self._readers == 0:
            self._write_lock.release()
        self._readers_lock.release()

    async def _acquire_write(self) -> None:
        # 写者不持 _readers_lock，避免与读者的 _readers_lock 形成死锁。
        await self._write_lock.acquire()

    def _release_write(self) -> None:
        self._write_lock.release()


class _ReadGuard:
    def __init__(self, rw: AsyncRWLock) -> None:
        self._rw = rw

    async def __aenter__(self) -> "_ReadGuard":
        await self._rw._acquire_read()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self._rw._release_read()


class _WriteGuard:
    def __init__(self, rw: AsyncRWLock) -> None:
        self._rw = rw

    async def __aenter__(self) -> "_WriteGuard":
        await self._rw._acquire_write()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self._rw._release_write()
