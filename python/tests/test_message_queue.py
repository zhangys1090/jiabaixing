"""消息队列单元测试.

覆盖 RedisStreamsQueue 和 InMemoryMessageQueue 的核心功能：
- 发布/订阅基础流程
- 多消费者并行消费
- 消息重试与死信队列
- 优先级路由
- 统计信息
- 优雅降级
"""

from __future__ import annotations

import asyncio

import pytest

from agent.infrastructure.message_queue import (
    InMemoryMessageQueue,
    Message,
    MessagePriority,
    MessageStatus,
    QueueStats,
    RedisStreamsQueue,
)


# ═══════════════════════════════════════════════════════════════
# InMemoryMessageQueue tests
# ═══════════════════════════════════════════════════════════════


class TestInMemoryMessageQueue:
    @pytest.mark.asyncio
    async def test_publish_and_subscribe(self):
        mq = InMemoryMessageQueue()
        await mq.start()

        received: list[Message] = []

        async def handler(msg: Message):
            received.append(msg)

        await mq.subscribe("test-topic", handler)
        msg_id = await mq.publish("test-topic", {"key": "value"})

        await asyncio.sleep(0.3)
        await mq.stop()

        assert len(received) == 1
        assert received[0].id == msg_id
        assert received[0].payload == {"key": "value"}
        assert received[0].status == MessageStatus.COMPLETED

    @pytest.mark.asyncio
    async def test_multiple_messages(self):
        mq = InMemoryMessageQueue()
        await mq.start()

        received: list[Message] = []

        async def handler(msg: Message):
            received.append(msg)

        await mq.subscribe("multi-topic", handler)

        ids = []
        for i in range(5):
            msg_id = await mq.publish("multi-topic", {"index": i})
            ids.append(msg_id)

        await asyncio.sleep(0.5)
        await mq.stop()

        assert len(received) == 5
        payloads = [m.payload["index"] for m in received]
        assert sorted(payloads) == [0, 1, 2, 3, 4]

    @pytest.mark.asyncio
    async def test_multiple_handlers(self):
        mq = InMemoryMessageQueue()
        await mq.start()

        received_a: list[Message] = []
        received_b: list[Message] = []

        async def handler_a(msg: Message):
            received_a.append(msg)

        async def handler_b(msg: Message):
            received_b.append(msg)

        await mq.subscribe("fanout", handler_a)
        await mq.subscribe("fanout", handler_b)

        await mq.publish("fanout", {"data": 1})
        await asyncio.sleep(0.3)
        await mq.stop()

        assert len(received_a) == 1
        assert len(received_b) == 1

    @pytest.mark.asyncio
    async def test_retry_on_failure(self):
        mq = InMemoryMessageQueue()
        await mq.start()

        attempt_count = 0

        async def flaky_handler(msg: Message):
            nonlocal attempt_count
            attempt_count += 1
            if attempt_count < 3:
                raise ValueError("transient error")

        await mq.subscribe("retry-topic", flaky_handler)
        await mq.publish("retry-topic", {"key": "val"}, max_retries=3)

        await asyncio.sleep(3.0)
        await mq.stop()

        assert attempt_count >= 2

    @pytest.mark.asyncio
    async def test_dead_letter_after_max_retries(self):
        mq = InMemoryMessageQueue()
        await mq.start()

        async def always_fail(msg: Message):
            raise RuntimeError("permanent error")

        await mq.subscribe("dlq-topic", always_fail)
        await mq.publish("dlq-topic", {"key": "val"}, max_retries=2)

        await asyncio.sleep(5.0)
        await mq.stop()

        stats = mq.get_stats("dlq-topic")
        assert stats is not None
        assert stats.dead_letter_count >= 1

    @pytest.mark.asyncio
    async def test_unsubscribe(self):
        mq = InMemoryMessageQueue()
        await mq.start()

        received: list[Message] = []

        async def handler(msg: Message):
            received.append(msg)

        await mq.subscribe("unsub-topic", handler)
        await mq.publish("unsub-topic", {"a": 1})
        await asyncio.sleep(0.3)

        await mq.unsubscribe("unsub-topic")
        await mq.publish("unsub-topic", {"a": 2})
        await asyncio.sleep(0.3)

        await mq.stop()
        assert len(received) == 1

    @pytest.mark.asyncio
    async def test_stats(self):
        mq = InMemoryMessageQueue()
        await mq.start()

        async def handler(msg: Message):
            pass

        await mq.subscribe("stats-topic", handler)
        await mq.publish("stats-topic", {"x": 1})
        await asyncio.sleep(0.3)
        await mq.stop()

        stats = mq.get_stats("stats-topic")
        assert stats is not None
        assert stats.topic == "stats-topic"
        assert stats.completed_count >= 1

    @pytest.mark.asyncio
    async def test_start_idempotent(self):
        mq = InMemoryMessageQueue()
        await mq.start()
        await mq.start()
        await mq.stop()

    @pytest.mark.asyncio
    async def test_stop_idempotent(self):
        mq = InMemoryMessageQueue()
        await mq.start()
        await mq.stop()
        await mq.stop()


# ═══════════════════════════════════════════════════════════════
# RedisStreamsQueue tests (进程内降级模式)
# ═══════════════════════════════════════════════════════════════


class TestRedisStreamsQueueFallback:
    @pytest.mark.asyncio
    async def test_fallback_mode(self):
        import os

        os.environ["MQ_ENABLED"] = "false"
        try:
            mq = RedisStreamsQueue()
            await mq.start()

            received: list[Message] = []

            async def handler(msg: Message):
                received.append(msg)

            await mq.subscribe("fb-topic", handler)
            await mq.publish("fb-topic", {"data": "hello"})
            await asyncio.sleep(0.3)
            await mq.stop()

            assert len(received) == 1
            assert received[0].payload == {"data": "hello"}
        finally:
            os.environ.pop("MQ_ENABLED", None)

    @pytest.mark.asyncio
    async def test_stream_key_priority(self):
        key_normal = RedisStreamsQueue._stream_key(
            "tasks", MessagePriority.NORMAL
        )
        key_high = RedisStreamsQueue._stream_key(
            "tasks", MessagePriority.HIGH
        )
        key_critical = RedisStreamsQueue._stream_key(
            "tasks", MessagePriority.CRITICAL
        )

        assert key_normal == "mq:tasks:normal"
        assert key_high == "mq:tasks:high"
        assert key_critical == "mq:tasks:high"


# ═══════════════════════════════════════════════════════════════
# Message / MessagePriority / MessageStatus tests
# ═══════════════════════════════════════════════════════════════


class TestMessageTypes:
    def test_message_defaults(self):
        msg = Message(id="test-id", topic="test", payload={"k": "v"})
        assert msg.priority == MessagePriority.NORMAL
        assert msg.status == MessageStatus.PENDING
        assert msg.retry_count == 0
        assert msg.max_retries == 3
        assert msg.error is None

    def test_priority_values(self):
        assert MessagePriority.LOW == 0
        assert MessagePriority.NORMAL == 5
        assert MessagePriority.HIGH == 10
        assert MessagePriority.CRITICAL == 15

    def test_status_values(self):
        assert MessageStatus.PENDING == "pending"
        assert MessageStatus.PROCESSING == "processing"
        assert MessageStatus.COMPLETED == "completed"
        assert MessageStatus.FAILED == "failed"
        assert MessageStatus.DEAD_LETTER == "dead_letter"

    def test_queue_stats_defaults(self):
        stats = QueueStats(topic="test")
        assert stats.pending_count == 0
        assert stats.consumer_count == 0
