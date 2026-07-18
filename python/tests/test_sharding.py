"""水平扩展原语测试（审计残留项 · 水平扩展分片）。

覆盖：一致性哈希分片、分片归属、领导者选举（进程内降级下仅一副本为 leader）。
不依赖 Redis —— LeaderElection 在 REDIS_ENABLED=false 时走 LocalLock 降级。
"""

import asyncio
import os

import pytest

from agent.infrastructure.sharding import (
    LeaderElection,
    consistent_shard,
    get_replica_index,
    get_shard_count,
    this_replica_owns,
)


def test_consistent_shard_deterministic_and_in_range() -> None:
    """相同 key 结果稳定，且始终落在 [0, n) 内。"""
    for n in (1, 2, 4, 8, 16):
        s = consistent_shard("job-123", n)
        assert 0 <= s < n
        assert consistent_shard("job-123", n) == s  # 稳定性


def test_consistent_shard_spreads_across_shards() -> None:
    """n>1 时，多个 key 应分散到不同分片（非全部落在 0）。"""
    shards = {consistent_shard(f"k{i}", 8) for i in range(200)}
    assert len(shards) > 1


def test_get_shard_count_default_and_env(monkeypatch) -> None:
    monkeypatch.delenv("SHARD_COUNT", raising=False)
    assert get_shard_count() == 1
    monkeypatch.setenv("SHARD_COUNT", "4")
    assert get_shard_count() == 4
    monkeypatch.setenv("SHARD_COUNT", "not-a-number")
    assert get_shard_count() == 1  # 容错


def test_get_replica_index_env(monkeypatch) -> None:
    monkeypatch.delenv("REPLICA_INDEX", raising=False)
    assert get_replica_index() == 0
    monkeypatch.setenv("REPLICA_INDEX", "2")
    assert get_replica_index() == 2


def test_this_replica_owns_single_shard_always(monkeypatch) -> None:
    """单副本（n<=1）下任意 key 恒由本副本负责。"""
    monkeypatch.setenv("SHARD_COUNT", "1")
    assert this_replica_owns("anything") is True


def test_this_replica_owns_exactly_one_replica(monkeypatch) -> None:
    """n>1 时，每个 key 恰好被一个副本（其分片序号）负责。"""
    monkeypatch.setenv("SHARD_COUNT", "4")
    monkeypatch.setenv("REPLICA_INDEX", "0")
    key = "user-42"
    target = consistent_shard(key, 4)
    assert this_replica_owns(key) == (target == 0)

    # 枚举所有副本，恰好一个负责该 key
    owned = sum(this_replica_owns(key, replica_index=i) for i in range(4))
    assert owned == 1


@pytest.mark.asyncio
async def test_leader_election_single_instance_becomes_leader() -> None:
    """单实例（无 Redis）下启动竞选后应为 leader。"""
    os.environ.setdefault("REDIS_ENABLED", "false")
    le = LeaderElection("test-single")
    await le.start()
    try:
        assert le.is_leader is True
    finally:
        await le.stop()
    assert le.is_leader is False


@pytest.mark.asyncio
async def test_leader_election_only_one_leader() -> None:
    """两个同服务实例竞争，恰有一个成为 leader（防双调度）。"""
    os.environ.setdefault("REDIS_ENABLED", "false")
    a = LeaderElection("cron")
    b = LeaderElection("cron")
    await a.start()
    await b.start()
    # 给竞选循环一个调度窗口
    await asyncio.sleep(0.2)
    leaders = [x.is_leader for x in (a, b)]
    try:
        assert sum(leaders) == 1
    finally:
        await a.stop()
        await b.stop()
    # 停止后均不应持有 leader
    assert a.is_leader is False and b.is_leader is False
