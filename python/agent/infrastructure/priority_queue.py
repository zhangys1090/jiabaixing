"""异步优先级队列（进程内，基于 heapq + RWLock）。

为高 / 低优先级任务提供 **真正生效** 的优先级调度，解决旧实现
（`asyncio.Queue` 纯 FIFO、`priority` 仅作元数据）在默认部署下优先级失效的问题：

- 使用 `heapq` 最小堆，存储 `(-priority, seq, item)`：优先级数值越大越先出队；
  同优先级按入队序号 `seq` FIFO，保证先到先服务、无饥饿。
- 用 `AsyncRWLock` 保护堆结构，使并发 push/pop 与只读快照协程安全。
- 用 `asyncio.Event` 在「有消息可用」时唤醒消费者，避免忙等。

本结构被 `InMemoryMessageQueue` 与 `RedisStreamsQueue` 的进程内降级路径复用，
是 P1-4 「优先级调度真实生效」的核心数据结构。

设计上与本模块的 `Message` 类型解耦：调用方在 `put(item, priority)` 时显式传入
整数优先级，避免与 `message_queue` 形成循环依赖。
"""

from __future__ import annotations

import asyncio
import heapq
from dataclasses import dataclass
from typing import Any

from agent.core.logger import StructuredLogger
from agent.infrastructure.rw_lock import AsyncRWLock
log = StructuredLogger("priority_queue")


DEFAULT_MAX_SIZE: int = 10_000


@dataclass
class _Entry:
    neg_priority: int
    seq: int
    item: Any

    # 最小堆规则：neg_priority 越小越先出队 → 原始 priority 越大越先出队；
    # 同优先级按 seq 升序（FIFO）。seq 全局唯一，故比较永不依赖不可比较的 item。
    def __lt__(self, other: "_Entry") -> bool:
        if self.neg_priority != other.neg_priority:
            return self.neg_priority < other.neg_priority
        return self.seq < other.seq


class AsyncPriorityQueue:
    """异步优先级队列。

    - `put(item, priority=0)`：入队（priority 越大越先出队）。
    - `get()`：阻塞直到有元素，返回优先级最高的元素。
    - `qsize()`：当前堆中元素数量（只读快照）。
    """

    def __init__(self, maxsize: int = DEFAULT_MAX_SIZE) -> None:
        self._heap: list[_Entry] = []
        self._rw = AsyncRWLock()
        self._not_empty = asyncio.Event()
        self._seq = 0
        self._maxsize = maxsize

    async def put(self, item: Any, priority: int = 0) -> None:
        """入队一个元素，priority 越大越先被消费。"""
        async with self._rw.write_lock():
            self._seq += 1
            entry = _Entry(-int(priority), self._seq, item)
            heapq.heappush(self._heap, entry)
        # 锁外唤醒，缩短临界区
        self._not_empty.set()

    async def get(self) -> Any:
        """取出优先级最高的元素；队列空时阻塞等待。"""
        while True:
            await self._not_empty.wait()
            async with self._rw.write_lock():
                if not self._heap:
                    # 被其它消费者抢空，复位信号量后重试
                    self._not_empty.clear()
                    continue
                entry = heapq.heappop(self._heap)
                if not self._heap:
                    self._not_empty.clear()
                return entry.item

    async def qsize(self) -> int:
        """当前堆中元素数量（只读快照，使用读锁）。"""
        async with self._rw.read_lock():
            return len(self._heap)
