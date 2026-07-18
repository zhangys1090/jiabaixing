"""分布式锁单元测试（审计 P0-1）。

策略：Redis 路径需要真实 Redis（env REDIS_ENABLED=true 时跑），
进程内降级（LocalLock）路径始终可单测，且通过模块级注册表模拟
「多副本竞争」——两个同名的 LocalLock 共享底层 asyncio.Lock，可真实互斥。
所有断言均为行为断言，不含恒真，符合 CI 恒真护栏。
"""

import asyncio
import os
import uuid

import pytest

from agent.infrastructure.distributed_lock import (
    LocalLock,
    RedisLock,
    create_lock,
    get_lock_manager,
)


REDIS_ENABLED = os.environ.get("REDIS_ENABLED", "false").lower() == "true"
require_redis = pytest.mark.skipif(
    not REDIS_ENABLED,
    reason="REDIS_ENABLED != true，跳过需要真实 Redis 的锁测试",
)


def _uniq_name(prefix: str = "lk") -> str:
    return f"jbx:test:{prefix}:{uuid.uuid4().hex}"


async def test_local_mutual_exclusion():
    """同名锁在多协程并发下严格互斥：任意时刻仅 1 个持有。"""
    name = _uniq_name("mutex")
    inside = 0
    max_inside = 0

    async def worker():
        nonlocal inside, max_inside
        lk = create_lock(name, ttl_ms=5000, max_retries=50, retry_interval_ms=2)
        if await lk.acquire():
            try:
                inside += 1
                max_inside = max(max_inside, inside)
                await asyncio.sleep(0.01)
                inside -= 1
            finally:
                await lk.release()

    await asyncio.gather(*[worker() for _ in range(6)])
    assert max_inside == 1


async def test_local_serial_eventually_all_enter():
    """竞争下所有协程最终都能进入（串行而非饿死）。"""
    name = _uniq_name("serial")
    entered = []

    async def worker(idx):
        lk = create_lock(name, ttl_ms=5000, max_retries=50, retry_interval_ms=2)
        if await lk.acquire():
            try:
                entered.append(idx)
                await asyncio.sleep(0.01)
            finally:
                await lk.release()

    await asyncio.gather(*[worker(i) for i in range(4)])
    assert sorted(entered) == [0, 1, 2, 3]


async def test_local_release_allows_other():
    """释放后另一协程可立即获取。"""
    name = _uniq_name("rel")

    async def holder():
        lk = create_lock(name, ttl_ms=5000, max_retries=20, retry_interval_ms=2)
        assert await lk.acquire() is True
        await asyncio.sleep(0.05)
        await lk.release()

    async def waiter():
        await asyncio.sleep(0.02)
        lk = create_lock(name, ttl_ms=5000, max_retries=20, retry_interval_ms=2)
        assert await lk.acquire() is True
        await lk.release()

    await asyncio.gather(holder(), waiter())


async def test_local_acquire_false_when_held():
    """已持有且未释放时，另一获取应返回 False（非死等）。"""
    name = _uniq_name("held")
    lk1 = create_lock(name, ttl_ms=60_000, max_retries=0, retry_interval_ms=5)
    assert await lk1.acquire() is True
    try:
        lk2 = create_lock(name, ttl_ms=60_000, max_retries=0, retry_interval_ms=5)
        assert await lk2.acquire() is False  # 立刻失败，不阻塞
    finally:
        await lk1.release()


async def test_lock_manager_caches_instance():
    """LockManager 按名缓存，重复 get 返回同一实例。"""
    mgr = get_lock_manager()
    name = _uniq_name("mgr")
    a = mgr.get(name)
    b = mgr.get(name)
    assert a is b


@require_redis
async def test_redis_acquire_and_release():
    """Redis 锁：获取后键存在；释放后键消失；另一实例无法获取。"""
    name = _uniq_name("redis")
    lk1 = RedisLock(name, ttl_ms=30_000, max_retries=5, retry_interval_ms=20)
    assert await lk1.acquire() is True
    try:
        r = await lk1._ensure()
        assert await r.exists(f"lock:{name}") == 1
        lk2 = RedisLock(name, ttl_ms=30_000, max_retries=0, retry_interval_ms=10)
        assert await lk2.acquire() is False
        # 验证键存在后释放，再验证键消失
        assert await r.exists(f"lock:{name}") == 1
    finally:
        await lk1.release()
    # release 后重新连接验证键已消失
    r2 = await lk1._ensure()
    assert await r2.exists(f"lock:{name}") == 0
    if lk1._redis is not None:
        await lk1._redis.aclose()


@require_redis
async def test_redis_auto_extend_keeps_alive():
    """自动续期：TTL 远小于持有时长，键在持锁期间仍存活。"""
    name = _uniq_name("extend")
    lk = RedisLock(name, ttl_ms=400, auto_extend=True, max_retries=5, retry_interval_ms=10)
    assert await lk.acquire() is True
    try:
        await asyncio.sleep(1.2)  # 远超单次 TTL（400ms）
        r = await lk._ensure()
        assert await r.exists(f"lock:{name}") == 1  # 续期生效
    finally:
        await lk.release()
        if lk._redis is not None:
            await lk._redis.aclose()
