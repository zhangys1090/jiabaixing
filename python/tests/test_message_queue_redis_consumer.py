"""消息队列消费循环测试（审计 P0-2）。

根因：此前 RedisStreamsQueue 的 Redis 路径只 XADD（发布），缺失 XREADGROUP
消费者循环，导致 Redis 模式「只写不读」。本测试覆盖补全后的两类后端：

- 进程内降级（InMemory，默认 MQ_ENABLED=false）：始终可单测，验证
  publish → fallback worker 消费 → handler 被调用（恰好一次）。
- Redis 后端（需 REDIS_ENABLED=true 且 MQ_ENABLED=true）：验证「跨实例解耦」——
  实例 A 发布，实例 B 的消费者组 worker 收到并执行，证明多副本真正解耦。
所有断言均为行为断言，不含恒真，符合 CI 恒真护栏。
"""

import asyncio
import os

import pytest

from agent.infrastructure.message_queue import (
    Message,
    MessagePriority,
    RedisStreamsQueue,
)

REDIS_ENABLED = os.environ.get("REDIS_ENABLED", "false").lower() == "true"
MQ_ENABLED = os.environ.get("MQ_ENABLED", "false").lower() == "true"
require_redis_mq = pytest.mark.skipif(
    not (REDIS_ENABLED and MQ_ENABLED),
    reason="需要 REDIS_ENABLED=true 且 MQ_ENABLED=true 的 Redis 模式",
)


async def _drain(got: list, target: int = 1, tries: int = 80) -> None:
    for _ in range(tries):
        if len(got) >= target:
            break
        await asyncio.sleep(0.02)


async def test_fallback_publish_consume():
    """默认（进程内降级）路径：发布后被 worker 消费，handler 恰好执行一次。"""
    mq = RedisStreamsQueue()
    await mq.start()
    got: list = []

    async def handler(msg: Message) -> None:
        got.append(msg.payload)

    await mq.subscribe("fb-topic", handler)
    mid = await mq.publish("fb-topic", {"k": "v"}, priority=MessagePriority.NORMAL)
    assert mid  # 发布返回消息 ID
    await _drain(got)
    await mq.stop()
    assert got == [{"k": "v"}]


async def test_fallback_priority_routing():
    """高优先级消息进入独立 stream，但仍能被同一 handler 消费。"""
    mq = RedisStreamsQueue()
    await mq.start()
    got: list = []

    async def handler(msg: Message) -> None:
        got.append(msg.priority)

    await mq.subscribe("prio", handler)
    await mq.publish("prio", {"x": 1}, priority=MessagePriority.HIGH)
    await _drain(got)
    await mq.stop()
    assert got == [MessagePriority.HIGH]


async def test_fallback_dead_letter_on_persistent_failure():
    """消息处理持续抛错且超最大重试 → 进入死信，不再无限重试。

    与项目现有契约一致（`>=` 语义）：max_retries=2 表示最多 2 次投递，
    第 2 次失败后进入死信，handler 恰好被调用 2 次（有界，不无限重试）。
    """
    mq = RedisStreamsQueue()
    await mq.start()
    attempts: list = []

    async def bad_handler(msg: Message) -> None:
        attempts.append(msg.id)
        raise RuntimeError("boom")

    await mq.subscribe("dlq", bad_handler)
    await mq.publish("dlq", {"x": 1}, max_retries=2)
    # 与项目现有契约一致（`>=` 语义）：max_retries=2 → 最多 2 次投递后死信
    await _drain(attempts, target=2, tries=400)
    await mq.stop()
    assert len(attempts) == 2  # 有界，不无限重试
    stats = mq.get_stats("dlq")
    assert stats is not None
    assert stats.dead_letter_count == 1


@require_redis_mq
async def test_redis_cross_instance_consume():
    """Redis 后端跨实例：实例 A 发布，实例 B 消费者收到并执行。"""
    a = RedisStreamsQueue()
    b = RedisStreamsQueue()
    await a.start()
    await b.start()
    got: list = []

    async def handler(msg: Message) -> None:
        got.append(msg.payload)

    await b.subscribe("xinst", handler)  # B 消费，A 不参与
    await a.publish("xinst", {"job": 1})
    await _drain(got)
    await a.stop()
    await b.stop()
    assert got == [{"job": 1}]


@require_redis_mq
async def test_redis_consumer_group_exactly_once():
    """消费者组内：一条消息仅投递给一个消费者（无重复消费）。"""
    a = RedisStreamsQueue()
    await a.start()
    got_a: list = []
    got_b: list = []

    async def ha(msg: Message) -> None:
        got_a.append(msg.payload)

    async def hb(msg: Message) -> None:
        got_b.append(msg.payload)

    # 同组两个消费者共享一个后端
    await a.subscribe("cg", ha)
    b = RedisStreamsQueue()
    await b.start()
    await b.subscribe("cg", hb)

    await a.publish("cg", {"n": 1})
    await _drain(got_a + got_b, target=1)
    await a.stop()
    await b.stop()
    total = len(got_a) + len(got_b)
    assert total == 1  # 恰好一次，不重复
