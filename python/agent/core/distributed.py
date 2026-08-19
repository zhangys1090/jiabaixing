"""分布式协调 (Distributed Coordination) — 多实例互斥与 Leader 选举。

支持多实例部署场景下的协调需求：
1. 分布式锁 (DistributedLock) — 基于 SQLite 轻量实现，无需 Redis
2. Leader 选举 (LeaderElector) — 自动选举 Leader 实例
3. 任务分配 (TaskBalancer) — 按实例负载均衡分配任务

架构：
    Coordinator
    ├── DistributedLock (SQLite 文件锁)
    ├── LeaderElector (心跳 + 选举)
    └── TaskBalancer (一致性哈希分配)

Usage:
    lock = DistributedLock("my_task", db_path="/data/locks.db")
    async with lock:
        await do_exclusive_work()

    elector = LeaderElector(instance_id="node-1")
    if elector.is_leader():
        await run_scheduled_tasks()
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from agent.core.logger import log_ignored

# 注意：本模块的日志调用使用 %-style 位置参数（如 log.warning("x %d", n)），
# 必须使用标准库 Logger —— StructuredLogger 只接受 **kwargs，传位置参数会 TypeError。
log = logging.getLogger(__name__)


@dataclass
class LockConfig:
    ttl_seconds: float = 30.0
    retry_interval: float = 0.1
    max_retries: int = 50
    heartbeat_interval: float = 5.0


class DistributedLock:
    """分布式锁 — 基于 SQLite 的轻量实现。

    无需外部依赖（Redis/etcd），适合单机多进程或
    中小规模分布式协调场景。

    使用 SQLite 的 WAL 模式 + 唯一约束实现互斥，
    支持 TTL 自动过期和心跳续期。
    """

    def __init__(
        self,
        name: str,
        db_path: str | Path = "",
        config: LockConfig | None = None,
    ) -> None:
        self._name = name
        self._config = config or LockConfig()
        if not db_path:
            db_path = Path(__file__).parent.parent.parent / "data" / "distributed_locks.db"
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._owner_id = str(uuid.uuid4())[:8]
        self._local = threading.local()
        self._heartbeat_task: asyncio.Task | None = None
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(str(self._db_path))
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA busy_timeout=5000")
        return self._local.conn

    def _init_db(self) -> None:
        conn = self._get_conn()
        conn.execute(
            "CREATE TABLE IF NOT EXISTS distributed_locks ("
            "  lock_name TEXT PRIMARY KEY,"
            "  owner_id TEXT NOT NULL,"
            "  acquired_at REAL NOT NULL,"
            "  expires_at REAL NOT NULL"
            ")"
        )
        conn.commit()

    async def acquire(self, timeout: float | None = None) -> bool:
        """尝试获取锁。

        Args:
            timeout: 等待超时（秒），None 使用默认值。

        Returns:
            True 如果获取成功。
        """
        effective_timeout = timeout if timeout is not None else (
            self._config.retry_interval * self._config.max_retries
        )

        start = time.monotonic()
        while time.monotonic() - start < effective_timeout:
            if self._try_acquire():
                self._start_heartbeat()
                return True
            await asyncio.sleep(self._config.retry_interval)

        return False

    def _try_acquire(self) -> bool:
        conn = self._get_conn()
        now = time.time()

        try:
            conn.execute(
                "DELETE FROM distributed_locks "
                "WHERE lock_name = ? AND expires_at < ?",
                (self._name, now),
            )

            conn.execute(
                "INSERT INTO distributed_locks (lock_name, owner_id, acquired_at, expires_at) "
                "VALUES (?, ?, ?, ?)",
                (self._name, self._owner_id, now, now + self._config.ttl_seconds),
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            conn.commit()
            return False

    def _start_heartbeat(self) -> None:
        if self._heartbeat_task is not None:
            return
        try:
            loop = asyncio.get_running_loop()
            self._heartbeat_task = loop.create_task(self._heartbeat_loop())
        except RuntimeError:
            self._heartbeat_task = None

    async def _heartbeat_loop(self) -> None:
        """心跳循环 — 定期续约分布式锁，连续失败或锁丢失时退出。"""
        consecutive_failures = 0
        _MAX_HEARTBEAT_FAILURES = 5
        while True:
            await asyncio.sleep(self._config.heartbeat_interval)
            try:
                extended = await asyncio.get_running_loop().run_in_executor(
                    None, self._extend_ttl,
                )
                if not extended:
                    log.warning("DistributedLock heartbeat: lock lost (TTL extend returned 0), breaking")
                    break
                consecutive_failures = 0
            except Exception as e:
                consecutive_failures += 1
                log.warning("DistributedLock heartbeat failed (%d/%d): %s", consecutive_failures, _MAX_HEARTBEAT_FAILURES, e)
                if consecutive_failures >= _MAX_HEARTBEAT_FAILURES:
                    log.error("DistributedLock heartbeat: %d consecutive failures, giving up", consecutive_failures)
                    break

    def _extend_ttl(self) -> bool:
        conn = self._get_conn()
        now = time.time()
        cursor = conn.execute(
            "UPDATE distributed_locks SET expires_at = ? "
            "WHERE lock_name = ? AND owner_id = ?",
            (now + self._config.ttl_seconds, self._name, self._owner_id),
        )
        conn.commit()
        return cursor.rowcount > 0

    def release(self) -> bool:
        """释放锁。"""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None

        conn = self._get_conn()
        conn.execute(
            "DELETE FROM distributed_locks WHERE lock_name = ? AND owner_id = ?",
            (self._name, self._owner_id),
        )
        conn.commit()
        return True

    def is_owned(self) -> bool:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT owner_id, expires_at FROM distributed_locks "
            "WHERE lock_name = ?",
            (self._name,),
        ).fetchone()
        if row is None:
            return False
        owner, expires = row
        return owner == self._owner_id and expires > time.time()

    async def __aenter__(self) -> "DistributedLock":
        acquired = await self.acquire()
        if not acquired:
            raise TimeoutError(f"Failed to acquire lock '{self._name}'")
        return self

    async def __aexit__(self, *args: Any) -> None:
        self.release()


class LeaderElector:
    """Leader 选举器 — 多实例 Leader 选举。

    通过心跳 + 先到先得的方式选举 Leader，
    支持自动故障转移（Leader 心跳超时后被接管）。
    """

    def __init__(
        self,
        instance_id: str = "",
        group: str = "default",
        db_path: str | Path = "",
        heartbeat_interval: float = 5.0,
        leader_ttl: float = 15.0,
    ) -> None:
        self._instance_id = instance_id or f"{os.uname().nodename}-{uuid.uuid4().hex[:6]}"
        self._group = group
        self._heartbeat_interval = heartbeat_interval
        self._leader_ttl = leader_ttl
        if not db_path:
            db_path = Path(__file__).parent.parent.parent / "data" / "leader_election.db"
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._is_leader = False
        self._heartbeat_task: asyncio.Task | None = None
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(str(self._db_path))
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA busy_timeout=3000")
        return self._local.conn

    def _init_db(self) -> None:
        conn = self._get_conn()
        conn.execute(
            "CREATE TABLE IF NOT EXISTS leader_election ("
            "  group_name TEXT PRIMARY KEY,"
            "  leader_id TEXT NOT NULL,"
            "  elected_at REAL NOT NULL,"
            "  last_heartbeat REAL NOT NULL"
            ")"
        )
        conn.commit()

    def is_leader(self) -> bool:
        return self._is_leader

    async def start(self) -> None:
        """启动 Leader 选举心跳。"""
        self._heartbeat_task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError as _exc:
                log_ignored(None, "distributed.LeaderElector.stop", _exc)
            self._heartbeat_task = None

    async def _run_loop(self) -> None:
        """领导者选举循环 — 定期尝试成为/维持 Leader，连续失败后退出。"""
        consecutive_failures = 0
        _MAX_ELECTION_FAILURES = 10
        while True:
            try:
                self._try_become_leader()
                consecutive_failures = 0
            except Exception as e:
                consecutive_failures += 1
                log.warning("LeaderElection try_become_leader failed (%d/%d): %s", consecutive_failures, _MAX_ELECTION_FAILURES, e)
                if consecutive_failures >= _MAX_ELECTION_FAILURES:
                    log.error("LeaderElection: %d consecutive failures, stopping election loop", consecutive_failures)
                    break
            await asyncio.sleep(self._heartbeat_interval)

    def _try_become_leader(self) -> None:
        conn = self._get_conn()
        now = time.time()

        conn.execute(
            "DELETE FROM leader_election "
            "WHERE group_name = ? AND last_heartbeat < ?",
            (self._group, now - self._leader_ttl),
        )

        try:
            conn.execute(
                "INSERT INTO leader_election (group_name, leader_id, elected_at, last_heartbeat) "
                "VALUES (?, ?, ?, ?)",
                (self._group, self._instance_id, now, now),
            )
            conn.commit()
            self._is_leader = True
        except sqlite3.IntegrityError:
            conn.execute(
                "UPDATE leader_election SET last_heartbeat = ? "
                "WHERE group_name = ? AND leader_id = ?",
                (now, self._group, self._instance_id),
            )
            conn.commit()
            row = conn.execute(
                "SELECT leader_id FROM leader_election WHERE group_name = ?",
                (self._group,),
            ).fetchone()
            self._is_leader = row is not None and row[0] == self._instance_id

    def get_leader_id(self) -> str | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT leader_id FROM leader_election "
            "WHERE group_name = ? AND last_heartbeat > ?",
            (self._group, time.time() - self._leader_ttl),
        ).fetchone()
        return row[0] if row else None


class TaskBalancer:
    """任务分配器 — 基于一致性哈希的负载均衡。

    将任务按 key 哈希分配到不同实例，
    支持实例增减时的最小重分配。
    """

    def __init__(self, instance_id: str = "", virtual_nodes: int = 150) -> None:
        self._instance_id = instance_id or str(uuid.uuid4())[:8]
        self._virtual_nodes = virtual_nodes
        self._ring: dict[int, str] = {}
        self._sorted_keys: list[int] = []
        self._instances: set[str] = {self._instance_id}

    def add_instance(self, instance_id: str) -> None:
        self._instances.add(instance_id)
        self._rebuild_ring()

    def remove_instance(self, instance_id: str) -> None:
        self._instances.discard(instance_id)
        self._rebuild_ring()

    def _rebuild_ring(self) -> None:
        self._ring.clear()
        for inst in sorted(self._instances):
            for i in range(self._virtual_nodes):
                key = f"{inst}:vnode:{i}"
                hash_val = int(hashlib.md5(key.encode()).hexdigest(), 16)
                self._ring[hash_val] = inst
        self._sorted_keys = sorted(self._ring.keys())

    def get_instance(self, task_key: str) -> str:
        if not self._ring:
            self._rebuild_ring()

        hash_val = int(hashlib.md5(task_key.encode()).hexdigest(), 16)
        for key in self._sorted_keys:
            if hash_val <= key:
                return self._ring[key]
        return self._ring[self._sorted_keys[0]] if self._sorted_keys else self._instance_id

    def is_responsible(self, task_key: str) -> bool:
        return self.get_instance(task_key) == self._instance_id

    @property
    def instance_count(self) -> int:
        return len(self._instances)
