"""A2A Protocol Manager — 协议管理器.

管理 Agent Card 发布与发现、Task 生命周期、事件订阅。
对应 TS 侧 A2AProtocolManager（AgentRegistry.ts 第 964 行起），
但提供完整网络层支持（HTTP 端点见 server.py）。

遵循 AGENTS.md 架构原则: A2A 协议主实现端为 Python。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from agent.a2a.types import (
    A2AAgentCard,
    A2AArtifact,
    A2ACapability,
    A2ACapabilityType,
    A2ATask,
    A2ATaskEvent,
    A2ATaskEventType,
    A2ATaskStatus,
)

logger = logging.getLogger(__name__)


# 合法的状态流转映射（防止非法状态跳转）
_VALID_TRANSITIONS: Dict[A2ATaskStatus, List[A2ATaskStatus]] = {
    A2ATaskStatus.SUBMITTED: [
        A2ATaskStatus.WORKING,
        A2ATaskStatus.FAILED,
        A2ATaskStatus.CANCELLED,
    ],
    A2ATaskStatus.WORKING: [
        A2ATaskStatus.INPUT_REQUIRED,
        A2ATaskStatus.COMPLETED,
        A2ATaskStatus.FAILED,
        A2ATaskStatus.CANCELLED,
    ],
    A2ATaskStatus.INPUT_REQUIRED: [
        A2ATaskStatus.WORKING,
        A2ATaskStatus.CANCELLED,
    ],
    A2ATaskStatus.COMPLETED: [],  # 终态
    A2ATaskStatus.FAILED: [],  # 终态
    A2ATaskStatus.CANCELLED: [],  # 终态
}


class A2AProtocolManager:
    """A2A 协议管理器.

    管理 Agent Card 注册表、Task 存储、事件订阅器，提供完整的 A2A 协议能力。
    通过 `server.py` 暴露 HTTP 端点供远程 Agent 调用。

    Attributes:
        _agent_cards: 已注册的 Agent Card 映射 (agent_id → card).
        _tasks: Task 存储 (task_id → task).
        _event_handlers: 事件订阅器 (task_id → handlers list).
        _task_listeners: 全局 Task 监听器列表.
        _lock: 异步锁，保护并发操作.

    Usage:
        manager = get_a2a_manager()
        manager.publish_agent_card(my_card)
        task = manager.create_task(from_agent_id="a", to_agent_id="b", description="...")
        manager.update_task_status(task.id, A2ATaskStatus.WORKING)
    """

    def __init__(self) -> None:
        """初始化 A2A 协议管理器."""
        self._agent_cards: Dict[str, A2AAgentCard] = {}
        self._tasks: Dict[str, A2ATask] = {}
        self._event_handlers: Dict[str, List[Callable[[A2ATaskEvent], Any]]] = {}
        self._task_listeners: List[Callable[[A2ATaskEvent], Any]] = []
        self._lock = asyncio.Lock()
        logger.info("A2AProtocolManager 初始化完成")

    async def publish_agent_card(self, card: A2AAgentCard) -> None:
        """发布 Agent Card.

        Args:
            card: Agent Card 实例. 若 id 已存在则覆盖.
        """
        async with self._lock:
            self._agent_cards[card.id] = card
            logger.info("📇 A2A Agent Card 发布: %s (%s)", card.name, card.id)

    async def get_agent_card(self, agent_id: str) -> Optional[A2AAgentCard]:
        """获取 Agent Card.

        Args:
            agent_id: Agent 唯一标识.

        Returns:
            Optional[A2AAgentCard]: Agent Card，不存在返回 None.
        """
        return self._agent_cards.get(agent_id)

    async def list_agent_cards(self) -> List[A2AAgentCard]:
        """列出所有 Agent Card.

        Returns:
            List[A2AAgentCard]: Agent Card 列表.
        """
        return list(self._agent_cards.values())

    async def discover_agents(
        self, capability_type: Optional[A2ACapabilityType] = None
    ) -> List[A2AAgentCard]:
        """发现具备指定能力的 Agent.

        Args:
            capability_type: 能力类型. None 表示返回所有 Agent.

        Returns:
            List[A2AAgentCard]: 匹配的 Agent Card 列表.
        """
        cards = list(self._agent_cards.values())
        if capability_type is None:
            return cards
        return [
            c for c in cards if any(cap.type == capability_type for cap in c.capabilities)
        ]

    async def create_task(
        self,
        from_agent_id: str,
        to_agent_id: str,
        description: str,
        input_data: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> A2ATask:
        """创建 A2A Task.

        Args:
            from_agent_id: 发起方 Agent ID.
            to_agent_id: 执行方 Agent ID.
            description: 任务描述.
            input_data: 任务输入数据.
            session_id: 会话 ID. None 则自动生成.

        Returns:
            A2ATask: 创建的 Task 实例（状态为 SUBMITTED）.
        """
        now = int(time.time() * 1000)
        task_id = f"a2a_task_{uuid.uuid4().hex[:12]}"
        session = session_id or f"session_{uuid.uuid4().hex[:8]}"

        task = A2ATask(
            id=task_id,
            session_id=session,
            description=description,
            from_agent_id=from_agent_id,
            to_agent_id=to_agent_id,
            status=A2ATaskStatus.SUBMITTED,
            input=input_data or {},
            created_at=now,
            updated_at=now,
            status_history=[{"status": A2ATaskStatus.SUBMITTED.value, "timestamp": now}],
        )

        async with self._lock:
            self._tasks[task_id] = task

        logger.info(
            "📋 A2A Task 创建: %s (%s → %s)", task_id, from_agent_id, to_agent_id
        )

        # 触发状态变更事件
        await self._emit_event(
            A2ATaskEvent(
                task_id=task_id,
                type=A2ATaskEventType.STATUS_CHANGE,
                status=A2ATaskStatus.SUBMITTED,
                timestamp=now,
                message="Task 已提交",
            )
        )

        return task

    async def get_task(self, task_id: str) -> Optional[A2ATask]:
        """获取 Task.

        Args:
            task_id: Task 唯一标识.

        Returns:
            Optional[A2ATask]: Task 实例，不存在返回 None.
        """
        return self._tasks.get(task_id)

    async def list_tasks(
        self, agent_id: Optional[str] = None, status: Optional[A2ATaskStatus] = None
    ) -> List[A2ATask]:
        """列出 Task.

        Args:
            agent_id: 筛选特定 Agent（from 或 to）的 Task. None 表示不筛选.
            status: 筛选特定状态的 Task. None 表示不筛选.

        Returns:
            List[A2ATask]: 匹配的 Task 列表.
        """
        tasks = list(self._tasks.values())
        if agent_id is not None:
            tasks = [t for t in tasks if t.from_agent_id == agent_id or t.to_agent_id == agent_id]
        if status is not None:
            tasks = [t for t in tasks if t.status == status]
        return tasks

    async def update_task_status(
        self,
        task_id: str,
        new_status: A2ATaskStatus,
        message: str = "",
        output: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> Optional[A2ATask]:
        """更新 Task 状态.

        校验状态流转合法性，更新 Task 并触发事件。
        非法状态跳转（如 COMPLETED → WORKING）会被拒绝并返回 None。

        Args:
            task_id: Task 唯一标识.
            new_status: 新状态.
            message: 状态变更消息.
            output: 任务输出（仅完成时设置）.
            error: 错误信息（仅失败时设置）.

        Returns:
            Optional[A2ATask]: 更新后的 Task，Task 不存在或状态跳转非法时返回 None.
        """
        async with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                logger.warning("更新 Task 状态失败: Task 不存在 %s", task_id)
                return None

            # 校验状态流转合法性
            valid_next = _VALID_TRANSITIONS.get(task.status, [])
            if new_status not in valid_next:
                logger.warning(
                    "Task %s 非法状态跳转: %s → %s (合法: %s)",
                    task_id,
                    task.status.value,
                    new_status.value,
                    [s.value for s in valid_next],
                )
                return None

            now = int(time.time() * 1000)
            old_status = task.status
            task.status = new_status
            task.updated_at = now
            task.status_history.append(
                {
                    "status": new_status.value,
                    "timestamp": now,
                    "message": message,
                    "previousStatus": old_status.value,
                }
            )

            if new_status in (A2ATaskStatus.COMPLETED, A2ATaskStatus.FAILED, A2ATaskStatus.CANCELLED):
                task.completed_at = now

            if output is not None:
                task.output = output

            if error is not None:
                task.error = error

            logger.info(
                "🔄 A2A Task 状态变更: %s %s → %s",
                task_id,
                old_status.value,
                new_status.value,
            )

        # 触发状态变更事件（在锁外触发，避免死锁）
        await self._emit_event(
            A2ATaskEvent(
                task_id=task_id,
                type=A2ATaskEventType.STATUS_CHANGE,
                status=new_status,
                message=message,
                timestamp=now,
            )
        )

        return task

    async def add_artifact(
        self, task_id: str, artifact: A2AArtifact
    ) -> Optional[A2ATask]:
        """向 Task 添加产物.

        Args:
            task_id: Task 唯一标识.
            artifact: 产物实例.

        Returns:
            Optional[A2ATask]: 更新后的 Task，Task 不存在返回 None.
        """
        async with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                logger.warning("添加产物失败: Task 不存在 %s", task_id)
                return None

            now = int(time.time() * 1000)
            task.artifacts.append(artifact)
            task.updated_at = now

        await self._emit_event(
            A2ATaskEvent(
                task_id=task_id,
                type=A2ATaskEventType.ARTIFACT_UPDATE,
                artifact=artifact,
                timestamp=now,
                message=f"产物已添加: {artifact.name}",
            )
        )

        return task

    async def update_progress(
        self, task_id: str, progress: float, message: str = ""
    ) -> Optional[A2ATask]:
        """更新 Task 进度.

        Args:
            task_id: Task 唯一标识.
            progress: 进度百分比 0-100.
            message: 进度消息.

        Returns:
            Optional[A2ATask]: 更新后的 Task，Task 不存在返回 None.
        """
        async with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                logger.warning("更新进度失败: Task 不存在 %s", task_id)
                return None

            now = int(time.time() * 1000)
            task.updated_at = now

        await self._emit_event(
            A2ATaskEvent(
                task_id=task_id,
                type=A2ATaskEventType.PROGRESS,
                progress=max(0.0, min(100.0, progress)),
                message=message,
                timestamp=now,
            )
        )

        return task

    async def cancel_task(
        self, task_id: str, reason: str = ""
    ) -> Optional[A2ATask]:
        """取消 Task.

        Args:
            task_id: Task 唯一标识.
            reason: 取消原因.

        Returns:
            Optional[A2ATask]: 更新后的 Task，Task 不存在或已终态返回 None.
        """
        return await self.update_task_status(
            task_id, A2ATaskStatus.CANCELLED, message=reason
        )

    def on_task_event(
        self, task_id: str, handler: Callable[[A2ATaskEvent], Any]
    ) -> None:
        """订阅特定 Task 的事件.

        Args:
            task_id: Task 唯一标识.
            handler: 事件处理回调（同步或异步均可）.
        """
        self._event_handlers.setdefault(task_id, []).append(handler)

    def on_any_task_event(
        self, handler: Callable[[A2ATaskEvent], Any]
    ) -> None:
        """订阅所有 Task 的事件.

        Args:
            handler: 事件处理回调（同步或异步均可）.
        """
        self._task_listeners.append(handler)

    async def _emit_event(self, event: A2ATaskEvent) -> None:
        """触发事件，通知所有订阅者.

        Args:
            event: Task 事件.
        """
        # 收集所有需要调用的 handler
        handlers: List[Callable[[A2ATaskEvent], Any]] = list(self._task_listeners)
        handlers.extend(self._event_handlers.get(event.task_id, []))

        for handler in handlers:
            try:
                result = handler(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as e:
                logger.exception(
                    "A2A 事件处理器执行失败 (task=%s): %s", event.task_id, e
                )

    async def get_stats(self) -> Dict[str, Any]:
        """获取 A2A 协议统计信息.

        Returns:
            Dict[str, Any]: 统计信息，包括 agent_count, task_count, tasks_by_status.
        """
        tasks_by_status: Dict[str, int] = {}
        for task in self._tasks.values():
            status_val = task.status.value
            tasks_by_status[status_val] = tasks_by_status.get(status_val, 0) + 1

        return {
            "agent_count": len(self._agent_cards),
            "task_count": len(self._tasks),
            "tasks_by_status": tasks_by_status,
            "event_handlers": sum(len(v) for v in self._event_handlers.values()),
            "global_listeners": len(self._task_listeners),
        }

    async def clear(self) -> None:
        """清空所有数据（仅用于测试）."""
        async with self._lock:
            self._agent_cards.clear()
            self._tasks.clear()
            self._event_handlers.clear()
            self._task_listeners.clear()


# ═══════════════════════════════════════════════════════════════
# 全局单例
# ═══════════════════════════════════════════════════════════════

_a2a_manager_instance: Optional[A2AProtocolManager] = None
_a2a_manager_lock = asyncio.Lock()


async def get_a2a_manager() -> A2AProtocolManager:
    """获取全局 A2AProtocolManager 单例.

    Returns:
        A2AProtocolManager: 全局单例实例.
    """
    global _a2a_manager_instance
    if _a2a_manager_instance is None:
        async with _a2a_manager_lock:
            if _a2a_manager_instance is None:
                _a2a_manager_instance = A2AProtocolManager()
    return _a2a_manager_instance


def _reset_a2a_manager_for_testing() -> None:
    """重置全局单例（仅用于测试）."""
    global _a2a_manager_instance
    _a2a_manager_instance = None
