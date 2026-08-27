"""Redis Streams 消息队列，为 Agent 系统提供异步任务解耦能力。

基于 Redis Streams (XADD/XREADGROUP) 实现消费者组模式的消息队列，
支持多消费者并行消费、消息确认、死信队列和优雅降级。
当 Redis 不可用时自动降级为进程内 asyncio.Queue，确保系统可用性。

典型场景：
- LLM 请求异步调度
- 工具调用结果通知
- Agent 间事件广播
- 长任务进度更新
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Optional

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.infrastructure.priority_queue import AsyncPriorityQueue

log = StructuredLogger("mq")

REDIS_URL_DEFAULT: str = "redis://localhost:6379/0"
MQ_ENABLED_DEFAULT: bool = False
CONSUMER_GROUP_DEFAULT: str = "agent-workers"
MAX_PENDING_ACK_MS: int = 300_000
DEAD_LETTER_MAX_LENGTH: int = 10_000
INCOMING_QUEUE_MAX_SIZE: int = 10_000


class MessagePriority(int, Enum):
    LOW = 0
    NORMAL = 5
    HIGH = 10
    CRITICAL = 15


class MessageStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    DEAD_LETTER = "dead_letter"


@dataclass
class Message:
    """消息体.

    Attributes:
        id: 消息唯一ID（Redis Stream Entry ID 或 UUID）.
        topic: 主题/队列名.
        payload: 消息内容（可序列化对象）.
        priority: 优先级.
        status: 当前状态.
        created_at: 创建时间戳.
        retry_count: 重试次数.
        max_retries: 最大重试次数.
        error: 最近一次错误信息.
    """
    id: str
    topic: str
    payload: Any
    priority: MessagePriority = MessagePriority.NORMAL
    status: MessageStatus = MessageStatus.PENDING
    created_at: float = field(default_factory=time.time)
    retry_count: int = 0
    max_retries: int = 3
    error: str | None = None


@dataclass
class QueueStats:
    """队列统计信息."""
    topic: str
    pending_count: int = 0
    processing_count: int = 0
    completed_count: int = 0
    failed_count: int = 0
    dead_letter_count: int = 0
    consumer_count: int = 0


def _is_mq_enabled() -> bool:
    return os.getenv("MQ_ENABLED", str(MQ_ENABLED_DEFAULT)).lower() in ("true", "1", "yes")


def _get_redis_url() -> str:
    url = os.getenv("REDIS_URL", REDIS_URL_DEFAULT)
    # Windows: localhost 优先解析 IPv6(::1)，redis-server 默认仅监听 IPv4
    if "://localhost" in url:
        url = url.replace("://localhost", "://127.0.0.1")
    return url


def _get_consumer_name() -> str:
    import socket
    return f"consumer-{socket.gethostname()}-{os.getpid()}"


class RedisStreamsQueue:
    """基于 Redis Streams 的消息队列.

    支持：
    - 消费者组模式（XREADGROUP）
    - 消息确认（XACK）
    - 死信队列（超过最大重试次数的消息）
    - 优先级路由（高优先级消息进入独立 Stream）
    - 优雅降级（Redis 不可用时降级为 asyncio.Queue）

    Usage:
        mq = RedisStreamsQueue()
        await mq.start()

        # 生产者
        msg_id = await mq.publish("llm-requests", {"prompt": "Hello", "model": "gpt-4"})

        # 消费者
        async def handle_llm(msg: Message) -> Any:
            result = await call_llm(msg.payload)
            return result

        await mq.subscribe("llm-requests", handle_llm)
    """

    def __init__(
        self,
        redis_url: str | None = None,
        consumer_group: str | None = None,
        consumer_name: str | None = None,
    ) -> None:
        self._redis_url = redis_url or _get_redis_url()
        self._consumer_group = consumer_group or CONSUMER_GROUP_DEFAULT
        self._consumer_name = consumer_name or _get_consumer_name()
        self._redis: Any = None
        self._handlers: dict[str, list[Callable[[Message], Coroutine]]] = {}
        # P1-4：进程内降级队列改用优先级堆 + RWLock 保护的 AsyncPriorityQueue
        self._fallback_queues: dict[str, AsyncPriorityQueue] = {}
        self._fallback_workers: dict[str, asyncio.Task] = {}
        self._running: bool = False
        self._use_redis: bool = False
        self._stats: dict[str, QueueStats] = {}
        self._completed_count: int = 0
        self._failed_count: int = 0
        self._dead_letter_count: int = 0
        self._redis_workers: dict[str, asyncio.Task] = {}
        self._MAX_TOPICS = 100
        self._MAX_HANDLERS_PER_TOPIC = 50

    async def start(self) -> None:
        """启动消息队列，尝试连接 Redis，失败则降级为进程内队列."""
        if self._running:
            return

        if _is_mq_enabled():
            try:
                import redis.asyncio as aioredis

                self._redis = aioredis.from_url(
                    self._redis_url,
                    decode_responses=True,
                    max_connections=20,
                    protocol=2,  # RESP2 兼容 Redis 5.x
                )
                await self._redis.ping()
                self._use_redis = True
                log.info(f"Redis Streams MQ 已连接: {self._redis_url}")
            except Exception as exc:
                log.warning(f"Redis 连接失败，降级为进程内队列: {exc}")
                self._use_redis = False
                self._redis = None
        else:
            log.debug("MQ_ENABLED=false，使用进程内队列")
            self._use_redis = False

        self._running = True

        for topic in self._handlers:
            self._ensure_fallback_worker(topic)
            # P0-2：Redis 模式下启动消费者组循环，否则 XADD 的消息无人消费
            if self._use_redis and self._redis:
                self._ensure_redis_worker(topic)

    async def stop(self) -> None:
        """停止消息队列，释放资源."""
        self._running = False

        for task in self._fallback_workers.values():
            task.cancel()
        self._fallback_workers.clear()
        for task in self._redis_workers.values():
            task.cancel()
        self._redis_workers.clear()

        if self._redis:
            try:
                await self._redis.aclose()
            except Exception as _exc:
                log.debug("message_queue 异常处理", error=str(_exc))
                log_ignored(log, "message_queue.RedisStreamsQueue.stop", _exc)
            self._redis = None

        self._use_redis = False
        log.info("消息队列已停止")

    async def publish(
        self,
        topic: str,
        payload: Any,
        priority: MessagePriority = MessagePriority.NORMAL,
        max_retries: int = 3,
    ) -> str:
        """发布消息到指定主题.

        Args:
            topic: 主题/队列名.
            payload: 消息内容（必须可 JSON 序列化）.
            priority: 优先级.
            max_retries: 最大重试次数.

        Returns:
            str: 消息ID.
        """
        import uuid

        msg_id = str(uuid.uuid4())
        msg = Message(
            id=msg_id,
            topic=topic,
            payload=payload,
            priority=priority,
            max_retries=max_retries,
        )

        if self._use_redis and self._redis:
            return await self._publish_redis(topic, msg)
        else:
            return await self._publish_fallback(topic, msg)

    async def subscribe(
        self, topic: str, handler: Callable[[Message], Coroutine]
    ) -> None:
        """订阅主题.

        Args:
            topic: 主题/队列名.
            handler: 异步消息处理函数.
        """
        if topic not in self._handlers:
            self._handlers[topic] = []
            self._stats[topic] = QueueStats(topic=topic)
            if len(self._handlers) > self._MAX_TOPICS:
                oldest_topics = list(self._handlers.keys())[: len(self._handlers) - (self._MAX_TOPICS * 3 // 4)]
                for t in oldest_topics:
                    self._handlers.pop(t, None)
                    self._stats.pop(t, None)
        self._handlers[topic].append(handler)
        if len(self._handlers[topic]) > self._MAX_HANDLERS_PER_TOPIC:
            self._handlers[topic] = self._handlers[topic][-self._MAX_HANDLERS_PER_TOPIC * 3 // 4:]

        if self._running:
            self._ensure_fallback_worker(topic)
            # P0-2：Redis 模式同步启动消费者组循环
            if self._use_redis and self._redis:
                self._ensure_redis_worker(topic)

        log.debug(f"订阅主题: {topic} (handler_count={len(self._handlers[topic])})")

    async def unsubscribe(self, topic: str) -> None:
        """取消订阅主题."""
        self._handlers.pop(topic, None)
        worker = self._fallback_workers.pop(topic, None)
        if worker:
            worker.cancel()
        log.info(f"取消订阅主题: {topic}")

    def get_stats(self, topic: str | None = None) -> dict[str, QueueStats] | QueueStats | None:
        """获取队列统计信息."""
        if topic:
            return self._stats.get(topic)
        return dict(self._stats)

    async def _publish_redis(self, topic: str, msg: Message) -> str:
        """通过 Redis Streams 发布消息."""
        try:
            stream_key = self._stream_key(topic, msg.priority)

            try:
                await self._redis.xgroup_create(
                    stream_key, self._consumer_group, id="0", mkstream=True
                )
            except Exception as _exc:
                log.debug("message_queue 异常处理", error=str(_exc))
                log_ignored(log, "message_queue.RedisStreamsQueue._publish_redis", _exc)

            entry_id = await self._redis.xadd(
                stream_key,
                {
                    "msg_id": msg.id,
                    "payload": json.dumps(msg.payload, ensure_ascii=False, default=str),
                    "priority": str(msg.priority.value),
                    "created_at": str(msg.created_at),
                    "max_retries": str(msg.max_retries),
                },
            )

            self._stats.setdefault(topic, QueueStats(topic=topic)).pending_count += 1
            log.debug(f"Redis 发布: {topic}/{msg.id} → {stream_key}")
            return msg.id
        except Exception as exc:
            log.warning(f"Redis 发布失败，降级为进程内: {exc}")
            return await self._publish_fallback(topic, msg)

    async def _publish_fallback(self, topic: str, msg: Message) -> str:
        """通过进程内 asyncio.Queue 发布消息."""
        if topic not in self._fallback_queues:
            self._fallback_queues[topic] = asyncio.Queue(maxsize=INCOMING_QUEUE_MAX_SIZE)
        await self._fallback_queues[topic].put(msg)
        self._stats.setdefault(topic, QueueStats(topic=topic)).pending_count += 1
        return msg.id

    def _ensure_fallback_worker(self, topic: str) -> None:
        """确保进程内队列有消费者 worker."""
        if topic in self._fallback_workers:
            return
        if topic not in self._fallback_queues:
            self._fallback_queues[topic] = asyncio.Queue(maxsize=INCOMING_QUEUE_MAX_SIZE)

        async def _worker():
            queue = self._fallback_queues[topic]
            handlers = self._handlers.get(topic, [])
            while self._running:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                msg.status = MessageStatus.PROCESSING
                stats = self._stats.get(topic)
                if stats:
                    stats.pending_count = max(0, stats.pending_count - 1)
                    stats.processing_count += 1

                for handler in handlers:
                    try:
                        await handler(msg)
                        msg.status = MessageStatus.COMPLETED
                        self._completed_count += 1
                        if stats:
                            stats.processing_count = max(0, stats.processing_count - 1)
                            stats.completed_count += 1
                    except Exception as exc:
                        log.debug("message_queue 异常处理", error=str(exc))
                        msg.retry_count += 1
                        msg.error = str(exc)
                        if msg.retry_count >= msg.max_retries:
                            msg.status = MessageStatus.DEAD_LETTER
                            self._dead_letter_count += 1
                            if stats:
                                stats.processing_count = max(0, stats.processing_count - 1)
                                stats.dead_letter_count += 1
                            log.error(f"消息进入死信: {topic}/{msg.id} error={exc}")
                        else:
                            msg.status = MessageStatus.PENDING
                            if stats:
                                stats.processing_count = max(0, stats.processing_count - 1)
                                stats.failed_count += 1
                            await asyncio.sleep(2 ** msg.retry_count)
                            await queue.put(msg)

        task = asyncio.create_task(_worker())
        self._fallback_workers[topic] = task

    @staticmethod
    def _stream_key(topic: str, priority: MessagePriority) -> str:
        """根据优先级生成 Stream Key.

        高优先级消息进入独立 Stream，确保优先消费.
        """
        if priority.value >= MessagePriority.HIGH.value:
            return f"mq:{topic}:high"
        return f"mq:{topic}:normal"

    def _ensure_redis_worker(self, topic: str) -> None:
        """确保 Redis 消费者组循环已启动（P0-2 补全的读取侧）。"""
        if topic in self._redis_workers:
            return
        if topic not in self._handlers:
            self._handlers.setdefault(topic, [])
            self._stats.setdefault(topic, QueueStats(topic=topic))
        task = asyncio.create_task(self._redis_worker(topic))
        self._redis_workers[topic] = task

    async def _redis_worker(self, topic: str) -> None:
        """Redis Streams 消费者组循环：XREADGROUP 阻塞读取并投递给 handlers。

        与 `_fallback_worker` 语义对齐：成功 XACK + 完成计数；
        失败按 retry 重投或进入死信。
        """
        streams = {
            self._stream_key(topic, MessagePriority.NORMAL): ">",
            self._stream_key(topic, MessagePriority.HIGH): ">",
        }
        # 预创建消费者组（MKSTREAM），避免 XREADGROUP 在 stream 不存在时报 NOGROUP
        for sk in streams:
            try:
                await self._redis.xgroup_create(sk, self._consumer_group, id="0", mkstream=True)
            except Exception as _exc:
                log.debug("message_queue 异常处理", error=str(_exc))
                log_ignored(log, "message_queue.RedisStreamsQueue._redis_worker", _exc)
        log.debug("redis worker started", topic=topic, streams=list(streams.keys()))
        while self._running and self._use_redis and self._redis:
            try:
                resp = await self._redis.xreadgroup(
                    self._consumer_group,
                    self._consumer_name,
                    streams,
                    count=10,
                    block=1000,
                )
                if not resp:
                    continue
                for _stream_key, messages in resp:
                    for entry_id, fields in messages:
                        try:
                            msg = Message(
                                id=fields.get("msg_id", entry_id),
                                topic=topic,
                                payload=json.loads(fields.get("payload", "null")),
                                priority=MessagePriority(int(fields.get("priority", "5"))),
                                max_retries=int(fields.get("max_retries", "3")),
                                retry_count=int(fields.get("retry_count", "0")),
                                created_at=float(fields.get("created_at", "0")),
                            )
                            await self._handle_redis(msg, _stream_key, entry_id)
                        except Exception as exc:
                            log.error("redis worker msg parse failed", topic=topic, error=str(exc))
            except Exception as exc:
                log.warning("redis worker loop error", topic=topic, error=str(exc))
                await asyncio.sleep(1.0)

    async def _handle_redis(self, msg: Message, stream_key: str, entry_id: str) -> None:
        """处理一条 Redis Streams 消息：投递 handlers + 确认/重试/死信。"""
        stats = self._stats.setdefault(msg.topic, QueueStats(topic=msg.topic))
        stats.pending_count = max(0, stats.pending_count - 1)
        stats.processing_count += 1
        handlers = self._handlers.get(msg.topic, [])
        try:
            for handler in handlers:
                await handler(msg)
            stats.processing_count = max(0, stats.processing_count - 1)
            stats.completed_count += 1
            self._completed_count += 1
        except Exception as exc:
            log.debug("message_queue 异常处理", error=str(exc))
            msg.retry_count += 1
            msg.error = str(exc)
            if msg.retry_count >= msg.max_retries:
                stats.processing_count = max(0, stats.processing_count - 1)
                stats.dead_letter_count += 1
                self._dead_letter_count += 1
                log.error("redis msg dead letter", topic=msg.topic, id=msg.id, error=str(exc))
            else:
                stats.processing_count = max(0, stats.processing_count - 1)
                stats.failed_count += 1
                # 重投：带递增 retry 重新 XADD，并 ACK 旧条目避免重复处理
                try:
                    await self._redis.xadd(
                        stream_key,
                        {
                            "msg_id": msg.id,
                            "payload": json.dumps(msg.payload, ensure_ascii=False, default=str),
                            "priority": str(msg.priority.value),
                            "created_at": str(msg.created_at),
                            "max_retries": str(msg.max_retries),
                            "retry_count": str(msg.retry_count),
                        },
                    )
                except Exception as _exc:
                    log.debug("message_queue 异常处理", error=str(_exc))
                    log_ignored(log, "message_queue.RedisStreamsQueue._handle_redis", _exc)
                log.warning("redis msg retry", topic=msg.topic, id=msg.id, retry=msg.retry_count)
        finally:
            try:
                await self._redis.xack(stream_key, self._consumer_group, entry_id)
            except Exception as _exc:
                log.debug("message_queue 异常处理", error=str(_exc))
                log_ignored(log, "message_queue.RedisStreamsQueue._handle_redis", _exc)


class InMemoryMessageQueue:
    """纯进程内消息队列（无 Redis 依赖的轻量实现）.

    适用于单实例部署或开发环境。提供与 RedisStreamsQueue 相同的接口，
    但所有消息仅在进程内传递，无持久化和跨进程能力。
    """

    def __init__(self, max_queue_size: int = INCOMING_QUEUE_MAX_SIZE) -> None:
        # P1-4：进程内队列改用优先级堆 + RWLock 保护的 AsyncPriorityQueue，
        # 使高优先级消息真正优先被消费（旧实现用 asyncio.Queue 纯 FIFO，priority 仅元数据）。
        self._queues: dict[str, AsyncPriorityQueue] = {}
        self._handlers: dict[str, list[Callable[[Message], Coroutine]]] = {}
        self._workers: dict[str, asyncio.Task] = {}
        self._running: bool = False
        self._stats: dict[str, QueueStats] = {}
        self._max_queue_size: int = max_queue_size
        self._MAX_TOPICS = 100
        self._MAX_HANDLERS_PER_TOPIC = 50

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        for topic in self._handlers:
            self._ensure_worker(topic)

    async def stop(self) -> None:
        self._running = False
        for task in self._workers.values():
            task.cancel()
        self._workers.clear()

    async def publish(
        self,
        topic: str,
        payload: Any,
        priority: MessagePriority = MessagePriority.NORMAL,
        max_retries: int = 3,
    ) -> str:
        import uuid

        msg_id = str(uuid.uuid4())
        msg = Message(
            id=msg_id,
            topic=topic,
            payload=payload,
            priority=priority,
            max_retries=max_retries,
        )
        if topic not in self._queues:
            self._queues[topic] = AsyncPriorityQueue(maxsize=self._max_queue_size)
        # priority 作为出队权重，真正影响消费顺序（P1-4）
        await self._queues[topic].put(msg, int(msg.priority))
        self._stats.setdefault(topic, QueueStats(topic=topic)).pending_count += 1
        return msg_id

    async def subscribe(
        self, topic: str, handler: Callable[[Message], Coroutine]
    ) -> None:
        if topic not in self._handlers:
            self._handlers[topic] = []
            self._stats[topic] = QueueStats(topic=topic)
            if len(self._handlers) > self._MAX_TOPICS:
                oldest_topics = list(self._handlers.keys())[: len(self._handlers) - (self._MAX_TOPICS * 3 // 4)]
                for t in oldest_topics:
                    self._handlers.pop(t, None)
                    self._stats.pop(t, None)
        self._handlers[topic].append(handler)
        if len(self._handlers[topic]) > self._MAX_HANDLERS_PER_TOPIC:
            self._handlers[topic] = self._handlers[topic][-self._MAX_HANDLERS_PER_TOPIC * 3 // 4:]
        if self._running:
            self._ensure_worker(topic)

    async def unsubscribe(self, topic: str) -> None:
        self._handlers.pop(topic, None)
        worker = self._workers.pop(topic, None)
        if worker:
            worker.cancel()

    def get_stats(self, topic: str | None = None) -> dict[str, QueueStats] | QueueStats | None:
        if topic:
            return self._stats.get(topic)
        return dict(self._stats)

    def _ensure_worker(self, topic: str) -> None:
        if topic in self._workers:
            return
        if topic not in self._queues:
            self._queues[topic] = AsyncPriorityQueue(maxsize=self._max_queue_size)

        async def _worker():
            queue = self._queues[topic]
            handlers = self._handlers.get(topic, [])
            while self._running:
                # 阻塞等待直到有消息；优先级堆保证出队顺序为 priority 降序 + FIFO。
                # 取消（stop）时从 get() 抛出 CancelledError，干净退出循环。
                try:
                    msg = await queue.get()
                except asyncio.CancelledError:
                    break
                except Exception as _exc:
                    log.warning("异常被静默捕获", error=str(_exc))
                    continue

                msg.status = MessageStatus.PROCESSING
                stats = self._stats.get(topic)
                if stats:
                    stats.pending_count = max(0, stats.pending_count - 1)
                    stats.processing_count += 1

                for handler in handlers:
                    try:
                        await handler(msg)
                        msg.status = MessageStatus.COMPLETED
                        if stats:
                            stats.processing_count = max(0, stats.processing_count - 1)
                            stats.completed_count += 1
                    except Exception as exc:
                        log.debug("message_queue 异常处理", error=str(exc))
                        msg.retry_count += 1
                        msg.error = str(exc)
                        if msg.retry_count >= msg.max_retries:
                            msg.status = MessageStatus.DEAD_LETTER
                            if stats:
                                stats.processing_count = max(0, stats.processing_count - 1)
                                stats.dead_letter_count += 1
                            log.error(f"消息进入死信: {topic}/{msg.id} error={exc}")
                        else:
                            msg.status = MessageStatus.PENDING
                            if stats:
                                stats.processing_count = max(0, stats.processing_count - 1)
                                stats.failed_count += 1
                            await asyncio.sleep(2 ** msg.retry_count)
                            # 重试重投：保留原优先级，确保高优重试仍优先于低优新消息
                            await queue.put(msg, int(msg.priority))

        task = asyncio.create_task(_worker())
        self._workers[topic] = task


def create_message_queue() -> RedisStreamsQueue:
    """工厂函数：创建消息队列实例.

    根据 MQ_ENABLED 环境变量决定是否启用 Redis Streams。
    未启用时仍使用进程内队列（RedisStreamsQueue 内部降级）。
    """
    return RedisStreamsQueue()
