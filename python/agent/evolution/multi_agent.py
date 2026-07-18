"""多 Agent 协调系统。

管理多个 Agent 实例的协作与通信：
  - Agent 注册与发现
  - 任务分配与负载均衡
  - Agent 间消息传递
  - 协作模式（顺序/并行/投票/层级）
  - 故障转移与恢复

与 Orchestrator 的关系：
  - Orchestrator 管理单 Agent 的进化优化
  - MultiAgentCoordinator 管理多 Agent 的协作
  - 两者可组合使用

集成示例::

    from agent.evolution.multi_agent import MultiAgentCoordinator, AgentNode

    coord = MultiAgentCoordinator()
    coord.register(AgentNode(id="researcher", capabilities=["search", "analyze"]))
    coord.register(AgentNode(id="writer", capabilities=["write", "summarize"]))

    result = await coord.delegate("分析并总结这份报告", mode="sequential")
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger
from agent.infrastructure.message_queue import (
    Message,
    MessagePriority,
    create_message_queue,
)

log = StructuredLogger("multi_agent")


class AgentStatus(str, Enum):
    IDLE = "idle"
    BUSY = "busy"
    OFFLINE = "offline"
    ERROR = "error"


class CollaborationMode(str, Enum):
    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    VOTING = "voting"
    HIERARCHICAL = "hierarchical"
    PIPELINE = "pipeline"


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class AgentNode:
    id: str
    capabilities: list[str] = field(default_factory=list)
    status: AgentStatus = AgentStatus.IDLE
    priority: int = 0
    max_concurrent: int = 1
    current_tasks: int = 0
    total_completed: int = 0
    total_failed: int = 0
    avg_duration_ms: float = 0.0
    last_heartbeat: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.last_heartbeat == 0.0:
            self.last_heartbeat = time.time()

    @property
    def is_available(self) -> bool:
        return self.status == AgentStatus.IDLE and self.current_tasks < self.max_concurrent


@dataclass
class AgentTask:
    id: str
    description: str
    assigned_to: str = ""
    status: TaskStatus = TaskStatus.PENDING
    result: str = ""
    error: str = ""
    created_at: float = 0.0
    started_at: float = 0.0
    completed_at: float = 0.0
    parent_task: str = ""
    subtasks: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())
        if self.created_at == 0.0:
            self.created_at = time.time()

    @property
    def duration_ms(self) -> float:
        if self.started_at and self.completed_at:
            return (self.completed_at - self.started_at) * 1000
        return 0.0


@dataclass
class CollaborationResult:
    task_id: str
    mode: CollaborationMode
    success: bool
    results: list[dict[str, Any]] = field(default_factory=list)
    final_result: str = ""
    total_duration_ms: float = 0.0
    agents_used: list[str] = field(default_factory=list)


@dataclass
class AgentMessage:
    id: str
    from_agent: str
    to_agent: str
    content: str
    msg_type: str = "info"
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())
        if self.timestamp == 0.0:
            self.timestamp = time.time()

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "from_agent": self.from_agent,
            "to_agent": self.to_agent,
            "content": self.content,
            "msg_type": self.msg_type,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_payload(cls, data: dict[str, Any]) -> "AgentMessage":
        return cls(
            id=data.get("id", ""),
            from_agent=data.get("from_agent", ""),
            to_agent=data.get("to_agent", ""),
            content=data.get("content", ""),
            msg_type=data.get("msg_type", "info"),
            timestamp=data.get("timestamp", 0.0),
        )


class MultiAgentCoordinator:
    """多 Agent 协调器。

    管理多个 Agent 的注册、发现、任务分配和协作。
    """

    def __init__(self) -> None:
        self._agents: dict[str, AgentNode] = {}
        self._tasks: dict[str, AgentTask] = {}
        # P-残留：Agent 间消息改为经 MQ 传输（多副本可跨实例投递）。
        # 本地 inbox 仍作为 receive_messages 的拉取缓冲，保持向后兼容语义。
        self._coord_id: str = uuid.uuid4().hex[:8]
        self._inbox: dict[str, list[AgentMessage]] = defaultdict(list)
        self._mq: Any = None
        self._mq_started: bool = False
        self._mq_topic: str = f"multi_agent.msg.{self._coord_id}"
        self._handlers: dict[str, Callable[..., Awaitable[str]]] = {}
        self._leader: str = ""

    def register(self, agent: AgentNode) -> None:
        self._agents[agent.id] = agent
        if not self._leader:
            self._leader = agent.id
        log.info("Agent 已注册", id=agent.id, capabilities=agent.capabilities)

    def unregister(self, agent_id: str) -> None:
        self._agents.pop(agent_id, None)
        self._handlers.pop(agent_id, None)
        if self._leader == agent_id:
            remaining = list(self._agents.keys())
            self._leader = remaining[0] if remaining else ""

    def set_handler(self, agent_id: str, handler: Callable[..., Awaitable[str]]) -> None:
        self._handlers[agent_id] = handler

    def get_agent(self, agent_id: str) -> AgentNode | None:
        return self._agents.get(agent_id)

    def list_agents(self, capability: str | None = None) -> list[AgentNode]:
        agents = list(self._agents.values())
        if capability:
            agents = [a for a in agents if capability in a.capabilities]
        return sorted(agents, key=lambda a: a.priority)

    def find_best_agent(self, capability: str) -> AgentNode | None:
        candidates = [
            a for a in self._agents.values()
            if capability in a.capabilities and a.is_available
        ]
        if not candidates:
            return None
        return min(candidates, key=lambda a: (a.current_tasks, -a.priority, a.avg_duration_ms))

    async def delegate(
        self,
        description: str,
        mode: CollaborationMode = CollaborationMode.SEQUENTIAL,
        capabilities: list[str] | None = None,
        timeout: float = 120.0,
    ) -> CollaborationResult:
        start = time.monotonic()
        task_id = str(uuid.uuid4())

        if mode == CollaborationMode.SEQUENTIAL:
            result = await self._delegate_sequential(task_id, description, capabilities, timeout)
        elif mode == CollaborationMode.PARALLEL:
            result = await self._delegate_parallel(task_id, description, capabilities, timeout)
        elif mode == CollaborationMode.VOTING:
            result = await self._delegate_voting(task_id, description, capabilities, timeout)
        elif mode == CollaborationMode.HIERARCHICAL:
            result = await self._delegate_hierarchical(task_id, description, capabilities, timeout)
        else:
            result = await self._delegate_sequential(task_id, description, capabilities, timeout)

        result.total_duration_ms = (time.monotonic() - start) * 1000
        return result

    async def _execute_agent(self, agent_id: str, description: str, timeout: float) -> dict[str, Any]:
        agent = self._agents.get(agent_id)
        handler = self._handlers.get(agent_id)

        if agent is None or handler is None:
            return {"agent": agent_id, "success": False, "error": "Agent 或 handler 不存在"}

        agent.status = AgentStatus.BUSY
        agent.current_tasks += 1
        start = time.monotonic()

        try:
            result = await asyncio.wait_for(handler(description), timeout=timeout)
            duration = (time.monotonic() - start) * 1000
            agent.total_completed += 1
            agent.avg_duration_ms = (
                (agent.avg_duration_ms * (agent.total_completed - 1) + duration)
                / agent.total_completed
            )
            return {"agent": agent_id, "success": True, "result": result, "duration_ms": duration}
        except asyncio.TimeoutError:
            agent.total_failed += 1
            return {"agent": agent_id, "success": False, "error": "超时"}
        except Exception as e:
            agent.total_failed += 1
            return {"agent": agent_id, "success": False, "error": str(e)}
        finally:
            agent.current_tasks -= 1
            agent.status = AgentStatus.IDLE if agent.current_tasks == 0 else AgentStatus.BUSY
            agent.last_heartbeat = time.time()

    async def _delegate_sequential(
        self,
        task_id: str,
        description: str,
        capabilities: list[str] | None,
        timeout: float,
    ) -> CollaborationResult:
        results = []
        agents_used = []
        current_desc = description

        caps = capabilities or ["general"]
        for cap in caps:
            agent = self.find_best_agent(cap)
            if agent is None:
                results.append({"capability": cap, "success": False, "error": "无可用 Agent"})
                continue

            agents_used.append(agent.id)
            r = await self._execute_agent(agent.id, current_desc, timeout)
            results.append(r)
            if r["success"]:
                current_desc = r["result"]

        final = results[-1].get("result", "") if results and results[-1].get("success") else ""
        return CollaborationResult(
            task_id=task_id,
            mode=CollaborationMode.SEQUENTIAL,
            success=any(r.get("success") for r in results),
            results=results,
            final_result=final,
            agents_used=agents_used,
        )

    async def _delegate_parallel(
        self,
        task_id: str,
        description: str,
        capabilities: list[str] | None,
        timeout: float,
    ) -> CollaborationResult:
        caps = capabilities or ["general"]
        tasks = []
        for cap in caps:
            agent = self.find_best_agent(cap)
            if agent:
                tasks.append(self._execute_agent(agent.id, description, timeout))

        if not tasks:
            return CollaborationResult(task_id=task_id, mode=CollaborationMode.PARALLEL, success=False)

        results = await asyncio.gather(*tasks, return_exceptions=True)
        processed = []
        agents_used = []
        for r in results:
            if isinstance(r, Exception):
                processed.append({"success": False, "error": str(r)})
            else:
                processed.append(r)
                if r.get("agent"):
                    agents_used.append(r["agent"])

        final = "\n---\n".join(r.get("result", "") for r in processed if r.get("success"))
        return CollaborationResult(
            task_id=task_id,
            mode=CollaborationMode.PARALLEL,
            success=any(r.get("success") for r in processed),
            results=processed,
            final_result=final,
            agents_used=agents_used,
        )

    async def _delegate_voting(
        self,
        task_id: str,
        description: str,
        capabilities: list[str] | None,
        timeout: float,
    ) -> CollaborationResult:
        available = [a for a in self._agents.values() if a.is_available]
        if not available:
            return CollaborationResult(task_id=task_id, mode=CollaborationMode.VOTING, success=False)

        tasks = [self._execute_agent(a.id, description, timeout) for a in available[:5]]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        processed = []
        agents_used = []
        vote_counts: dict[str, int] = defaultdict(int)
        for r in results:
            if isinstance(r, Exception):
                processed.append({"success": False, "error": str(r)})
            else:
                processed.append(r)
                if r.get("agent"):
                    agents_used.append(r["agent"])
                if r.get("success") and r.get("result"):
                    vote_counts[r["result"]] += 1

        final = max(vote_counts, key=vote_counts.get) if vote_counts else ""
        return CollaborationResult(
            task_id=task_id,
            mode=CollaborationMode.VOTING,
            success=bool(vote_counts),
            results=processed,
            final_result=final,
            agents_used=agents_used,
        )

    async def _delegate_hierarchical(
        self,
        task_id: str,
        description: str,
        capabilities: list[str] | None,
        timeout: float,
    ) -> CollaborationResult:
        if not self._leader or self._leader not in self._handlers:
            return CollaborationResult(task_id=task_id, mode=CollaborationMode.HIERARCHICAL, success=False)

        r = await self._execute_agent(self._leader, description, timeout)
        return CollaborationResult(
            task_id=task_id,
            mode=CollaborationMode.HIERARCHICAL,
            success=r.get("success", False),
            results=[r],
            final_result=r.get("result", ""),
            agents_used=[self._leader],
        )

    async def send_message(self, from_agent: str, to_agent: str, content: str, msg_type: str = "info") -> None:
        msg = AgentMessage(
            id=str(uuid.uuid4()),
            from_agent=from_agent,
            to_agent=to_agent,
            content=content,
            msg_type=msg_type,
        )
        # 本地快速投递：同进程 send→receive 立即可见，保持向后兼容语义
        self._deliver_local(msg)
        # MQ 传输：跨副本投递（无 Redis 时退化为进程内队列，回声由 _on_mq 跳过）
        await self._ensure_mq()
        payload = msg.to_payload()
        payload["sender_coord_id"] = self._coord_id
        await self._mq.publish(self._mq_topic, payload, priority=MessagePriority.NORMAL)

    async def receive_messages(self, agent_id: str) -> list[AgentMessage]:
        messages = list(self._inbox.pop(agent_id, []))
        return messages

    async def _ensure_mq(self) -> None:
        """惰性初始化 Agent 消息 MQ（多副本跨实例投递）。"""
        if self._mq_started:
            return
        self._mq = create_message_queue()
        await self._mq.start()
        await self._mq.subscribe(self._mq_topic, self._on_mq)
        self._mq_started = True

    async def _on_mq(self, msg: Message) -> None:
        """MQ 消费者：还原 AgentMessage 并投递到本地 inbox / 广播缓冲。

        跳过自身回声（send_message 已本地投递），仅处理来自其他副本的消息。
        """
        try:
            payload = msg.payload
            if isinstance(payload, str):
                import json

                payload = json.loads(payload)
            if payload.get("sender_coord_id") == self._coord_id:
                return  # 本地已投递，忽略自身回声
            agent_msg = AgentMessage.from_payload(payload)
        except Exception as exc:
            log.warning("解析 Agent 消息失败", error=str(exc))
            return
        self._deliver_local(agent_msg)

    def _deliver_local(self, msg: AgentMessage) -> None:
        if msg.to_agent == "*":
            # 广播：投递到所有已注册 agent 的本地 inbox（每个 agent 各自消费一次）
            for agent_id in self._agents:
                self._inbox[agent_id].append(msg)
        else:
            self._inbox[msg.to_agent].append(msg)

    def get_stats(self) -> dict[str, Any]:
        return {
            "agents": len(self._agents),
            "idle": len([a for a in self._agents.values() if a.status == AgentStatus.IDLE]),
            "busy": len([a for a in self._agents.values() if a.status == AgentStatus.BUSY]),
            "offline": len([a for a in self._agents.values() if a.status == AgentStatus.OFFLINE]),
            "leader": self._leader,
            "total_completed": sum(a.total_completed for a in self._agents.values()),
            "total_failed": sum(a.total_failed for a in self._agents.values()),
        }
