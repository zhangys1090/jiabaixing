"""水平扩展原语 —— 多副本部署下的分片与领导者选举。

背景（审计残留项 · 水平扩展分片）：K8s 已 2 副本 + HPA 至 10，但此前缺少
"副本间如何分工"的明确机制——所有副本都跑调度循环、都持有本地 coordinator
状态，水平扩容只是"堆叠相同实例"，并未真正分担工作。

设计：
- 一致性哈希分片 `consistent_shard(key, shard_count)`：把任意 key 稳定映射到
  [0, shard_count) 的某个分片，使"同一任务总落到同一副本"，便于按 key 路由。
- `get_shard_count()` / `get_replica_index()`：从环境变量读取（默认 1 / 0），
  单副本部署下分片退化为 0（无操作），无需改动业务代码。
- `LeaderElection`：基于分布式锁的领导者选举，保证"单例型工作"（如 cron 调度
  循环、jobs.json 写入）在某一时刻仅由一个副本承担，其余副本作为热备/执行者。
  多副本解耦执行仍由 MQ 承担，因此非 leader 副本也能消费并执行派发任务。

所有原语均优雅降级：REDIS 不可用时锁退化为进程内 asyncio.Lock，单副本安全。
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.infrastructure.distributed_lock import create_lock
log = StructuredLogger("sharding")



def get_shard_count() -> int:
    """总分片数（副本数）。默认 1 = 不分片。"""
    try:
        return max(1, int(os.getenv("SHARD_COUNT", "1") or "1"))
    except ValueError:
        return 1


def get_replica_index() -> int:
    """当前副本在分片环中的序号。默认 0 = 单副本。"""
    try:
        return int(os.getenv("REPLICA_INDEX", "0") or "0")
    except ValueError:
        return 0


def consistent_shard(key: str, shard_count: int | None = None) -> int:
    """把 key 稳定映射到 [0, shard_count) 的分片序号。

    Args:
        key: 用于分片的标识（如 job.id、agent.id、user.id）。
        shard_count: 分片数；省略则取 `get_shard_count()`。

    Returns:
        分片序号（始终在合法范围内）。
    """
    n = shard_count if shard_count is not None else get_shard_count()
    if n <= 1:
        return 0
    digest = hashlib.md5(key.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % n


def this_replica_owns(key: str, shard_count: int | None = None, replica_index: int | None = None) -> bool:
    """当前副本是否应负责该 key（按分片归属判断）。

    单副本（shard_count<=1）下恒为 True，业务无需特殊分支。
    """
    n = shard_count if shard_count is not None else get_shard_count()
    if n <= 1:
        return True
    idx = replica_index if replica_index is not None else get_replica_index()
    return consistent_shard(key, n) == idx


class LeaderElection:
    """基于分布式锁的领导者选举。

    用法::

        le = LeaderElection("cron")
        await le.start()          # 后台竞选循环，非阻塞
        if le.is_leader:
            ... 仅 leader 执行单例工作 ...
        # 关闭时
        await le.stop()

    竞选语义：
    - 后台循环周期性尝试获取 `leader:<service>` 锁；获取成功即成为 leader。
    - Redis 后端下锁自动续期（见 distributed_lock.RedisLock）；周期性探测持锁
      状态，一旦丢失（如 Redis 抖动）立即降级为非 leader 并重新竞选。
    - 单进程 / REDIS 不可用时退化为进程内锁，单实例恒为 leader。
    """

    def __init__(self, service: str, ttl_ms: int = 30_000, refresh_ms: int = 10_000) -> None:
        self._service = service
        self._ttl_ms = ttl_ms
        self._refresh_ms = refresh_ms
        self._lock = create_lock(
            f"leader:{service}",
            ttl_ms=ttl_ms,
            max_retries=0,
            retry_interval_ms=500,
        )
        self._is_leader = False
        self._task: asyncio.Task | None = None
        self._stop = False

    @property
    def is_leader(self) -> bool:
        return self._is_leader

    @property
    def service(self) -> str:
        return self._service

    async def start(self) -> None:
        """启动后台竞选循环（非阻塞）。"""
        if self._task is not None and not self._task.done():
            return
        self._stop = False
        self._task = asyncio.create_task(self._campaign())
        # 立即尝试一次，缩短首次成为 leader 的延迟
        if await self._try_acquire():
            self._is_leader = True

    async def _campaign(self) -> None:
        try:
            while not self._stop:
                if not self._is_leader:
                    if await self._try_acquire():
                        self._is_leader = True
                        log.info("成为 leader", service=self._service)
                else:
                    if not self._held():
                        self._is_leader = False
                        log.warning("丢失 leader 身份，重新竞选", service=self._service)
                await asyncio.sleep(self._refresh_ms / 1000.0)
        except asyncio.CancelledError as _exc:
            log_ignored(log, "sharding.LeaderElection._campaign", _exc)

    async def _try_acquire(self) -> bool:
        try:
            return await self._lock.acquire()
        except Exception as exc:
            log.warning("leader 竞选异常", service=self._service, error=str(exc))
            return False

    def _held(self) -> bool:
        return getattr(self._lock, "held", lambda: False)()

    async def stop(self) -> None:
        """停止竞选并释放锁。"""
        self._stop = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception) as _exc:
                log_ignored(log, "sharding.LeaderElection.stop", _exc)
            self._task = None
        try:
            await self._lock.release()
        except Exception as _exc:
            log.debug("sharding 异常处理", error=str(_exc))
            log_ignored(log, "sharding.LeaderElection.stop", _exc)
        self._is_leader = False
