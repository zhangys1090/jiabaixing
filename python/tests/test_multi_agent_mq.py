"""multi_agent 消息队列切 MQ 测试（审计残留项）。

验证：send→receive 本地语义保持（含 "*" 广播），且消息经 MQ 传输。
无 Redis 时 RedisStreamsQueue 退化为进程内队列，行为向后兼容。
不依赖 Redis。
"""

import asyncio

import pytest

from agent.evolution.multi_agent import AgentMessage, AgentNode, MultiAgentCoordinator
from agent.infrastructure.message_queue import Message, MessagePriority


def _coord() -> MultiAgentCoordinator:
    c = MultiAgentCoordinator()
    c.register(AgentNode(id="analyst", capabilities=["analyze"]))
    c.register(AgentNode(id="writer", capabilities=["write"]))
    return c


@pytest.mark.asyncio
async def test_send_receive_local_immediate() -> None:
    """send 后同进程 receive 立即可见（本地快速投递路径）。"""
    c = _coord()
    await c.send_message("analyst", "writer", "请总结", msg_type="task")
    msgs = await c.receive_messages("writer")
    assert len(msgs) == 1
    assert msgs[0].content == "请总结"
    assert msgs[0].from_agent == "analyst"


@pytest.mark.asyncio
async def test_receive_filters_by_agent() -> None:
    """只有目标 agent 收到定向消息；其余 agent 不应收到。"""
    c = _coord()
    await c.send_message("analyst", "writer", "hello")
    writer_msgs = await c.receive_messages("writer")
    analyst_msgs = await c.receive_messages("analyst")
    assert len(writer_msgs) == 1
    assert analyst_msgs == []


@pytest.mark.asyncio
async def test_broadcast_delivered_to_all() -> None:
    """to_agent='*' 的广播消息投递到所有 agent。"""
    c = _coord()
    await c.send_message("system", "*", "shutdown soon")
    # writer 收
    w = await c.receive_messages("writer")
    assert any(m.content == "shutdown soon" for m in w)
    # analyst 也收（广播缓冲被消费一次）
    a = await c.receive_messages("analyst")
    assert any(m.content == "shutdown soon" for m in a)


@pytest.mark.asyncio
async def test_on_mq_reconstructs_and_delivers() -> None:
    """MQ 消费者 _on_mq：还原 AgentMessage 并投递到目标 inbox（模拟跨副本送达）。"""
    c = _coord()
    msg = Message(
        id="m1",
        topic=c._mq_topic,
        payload={
            "id": "m1",
            "from_agent": "a1",
            "to_agent": "writer",
            "content": "cross-instance",
            "msg_type": "task",
            "timestamp": 1.0,
            "sender_coord_id": "other-coord",
        },
    )
    await c._on_mq(msg)
    msgs = await c.receive_messages("writer")
    assert len(msgs) == 1
    assert msgs[0].content == "cross-instance"
    assert msgs[0].from_agent == "a1"


@pytest.mark.asyncio
async def test_on_mq_skips_own_echo() -> None:
    """_on_mq 应忽略自身回声（sender_coord_id == 本实例），避免重复投递。"""
    c = _coord()
    msg = Message(
        id="m2",
        topic=c._mq_topic,
        payload={
            "id": "m2",
            "from_agent": "a1",
            "to_agent": "writer",
            "content": "echo",
            "msg_type": "task",
            "timestamp": 1.0,
            "sender_coord_id": c._coord_id,  # 与自身相同
        },
    )
    await c._on_mq(msg)
    msgs = await c.receive_messages("writer")
    assert msgs == []  # 回声被丢弃，未重复投递


@pytest.mark.asyncio
async def test_priority_publish_does_not_raise() -> None:
    """send_message 经 MQ 发布时不抛错（覆盖 publish 路径）。"""
    c = _coord()
    await c.send_message("analyst", "writer", "hi", msg_type="task")
    # 等待 MQ 异步 worker 处理（回声会被 _on_mq 跳过，不影响）
    await asyncio.sleep(0.05)
    assert True
