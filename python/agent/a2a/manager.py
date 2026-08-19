"""A2A Protocol Manager — 协议管理器.

管理 Agent Card 发布与发现、Task 生命周期、事件订阅。
对应 TS 侧 A2AProtocolManager（AgentRegistry.ts 第 964 行起），
但提供完整网络层支持（HTTP 端点见 server.py）。

遵循 AGENTS.md 架构原则: A2A 协议主实现端为 Python。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
import uuid
from pathlib import Path
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

        # P2-2: 多跳委派深度守卫
        self._delegation_chain: Dict[str, List[str]] = {}
        self._max_delegation_depth = int(
            __import__("os").environ.get("A2A_MAX_DELEGATION_DEPTH", "3")
        )

        # P2-6: 协商协议持久化 — SQLite 存储 Task 协商记录
        self._persist_enabled = os.environ.get("A2A_PERSIST_ENABLED", "true").lower() == "true"
        self._persist_path: Path | None = None
        self._persist_conn: sqlite3.Connection | None = None
        if self._persist_enabled:
            try:
                from agent.config import DATA_DIR
                self._persist_path = DATA_DIR / "a2a_negotiations.db"
                self._persist_path.parent.mkdir(parents=True, exist_ok=True)
                self._persist_conn = sqlite3.connect(str(self._persist_path))
                self._persist_conn.row_factory = sqlite3.Row
                self._init_persist_tables()
                logger.info("P2-6: 协商协议持久化已启用 (path=%s)", self._persist_path)
            except Exception as exc:
                logger.warning("P2-6: 协商持久化初始化失败，降级为内存模式: %s", exc)
                self._persist_conn = None

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

        # P2-2: 多跳委派深度守卫
        # 追踪委派链 from_agent_id → to_agent_id → ...，
        # 当链深度超过 A2A_MAX_DELEGATION_DEPTH 时拒绝创建，
        # 防止 A→B→C→D→... 无限委派导致资源耗尽。
        chain_key = from_agent_id
        chain = self._delegation_chain.get(chain_key, [])
        if to_agent_id in chain:
            chain_depth = chain.index(to_agent_id) + 1
        else:
            chain_depth = len(chain) + 1

        if chain_depth > self._max_delegation_depth:
            raise ValueError(
                f"P2-2: 委派深度 {chain_depth} 超过最大限制 "
                f"{self._max_delegation_depth}，"
                f"委派链: {' → '.join(chain + [to_agent_id])}，"
                f"拒绝创建任务以防循环委派"
            )

        self._delegation_chain.setdefault(to_agent_id, []).append(from_agent_id)

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

        # P2-6: 持久化 Task 记录
        self._persist_task(task)

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

            # P2-6: 持久化状态变更
            self._persist_task(task)

            # P2-2: 终态时清理委派链 — 防止长期运行内存泄漏
            if new_status in (A2ATaskStatus.COMPLETED, A2ATaskStatus.FAILED, A2ATaskStatus.CANCELLED):
                self._delegation_chain.pop(task.from_agent_id, None)
                self._delegation_chain.pop(task.to_agent_id, None)

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
            "persist_enabled": self._persist_conn is not None,
        }

    # ═══════════════════════════════════════════════════════════
    # P2-6: 协商协议持久化
    # ═══════════════════════════════════════════════════════════

    def _init_persist_tables(self) -> None:
        """P2-6: 初始化持久化表结构。"""
        if not self._persist_conn:
            return
        self._persist_conn.executescript("""
            CREATE TABLE IF NOT EXISTS a2a_tasks (
                task_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                from_agent_id TEXT NOT NULL,
                to_agent_id TEXT NOT NULL,
                description TEXT NOT NULL,
                status TEXT NOT NULL,
                input_json TEXT,
                output_json TEXT,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS a2a_negotiations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                round INTEGER NOT NULL,
                proposer TEXT NOT NULL,
                proposal_json TEXT NOT NULL,
                responder TEXT NOT NULL,
                response_type TEXT NOT NULL,
                response_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (task_id) REFERENCES a2a_tasks(task_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_a2a_tasks_status ON a2a_tasks(status);
            CREATE INDEX IF NOT EXISTS idx_a2a_tasks_from ON a2a_tasks(from_agent_id);
            CREATE INDEX IF NOT EXISTS idx_a2a_tasks_to ON a2a_tasks(to_agent_id);
            CREATE INDEX IF NOT EXISTS idx_a2a_neg_task ON a2a_negotiations(task_id);
        """)
        self._persist_conn.commit()

    def _persist_task(self, task: A2ATask) -> None:
        """P2-6: 持久化 Task 记录。"""
        if not self._persist_conn:
            return
        try:
            self._persist_conn.execute(
                """INSERT OR REPLACE INTO a2a_tasks
                   (task_id, session_id, from_agent_id, to_agent_id, description,
                    status, input_json, output_json, error, created_at, updated_at, completed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    task.id,
                    task.session_id,
                    task.from_agent_id,
                    task.to_agent_id,
                    task.description,
                    task.status.value,
                    json.dumps(task.input, ensure_ascii=False) if task.input else None,
                    json.dumps(task.output, ensure_ascii=False) if task.output else None,
                    task.error,
                    task.created_at,
                    task.updated_at,
                    task.completed_at,
                ),
            )
            self._persist_conn.commit()
        except Exception as exc:
            logger.warning("P2-6: Task 持久化失败: %s", exc)

    def _persist_negotiation(
        self,
        task_id: str,
        round_num: int,
        proposer: str,
        proposal: Dict[str, Any],
        responder: str,
        response_type: str,
        response: Dict[str, Any] | None = None,
    ) -> None:
        """P2-6: 持久化协商轮次记录。"""
        if not self._persist_conn:
            return
        try:
            now = int(time.time() * 1000)
            self._persist_conn.execute(
                """INSERT INTO a2a_negotiations
                   (task_id, round, proposer, proposal_json, responder,
                    response_type, response_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    task_id,
                    round_num,
                    proposer,
                    json.dumps(proposal, ensure_ascii=False),
                    responder,
                    response_type,
                    json.dumps(response, ensure_ascii=False) if response else None,
                    now,
                ),
            )
            self._persist_conn.commit()
        except Exception as exc:
            logger.warning("P2-6: 协商记录持久化失败: %s", exc)

    async def negotiate(
        self,
        task_id: str,
        proposer: str,
        proposal: Dict[str, Any],
        responder: str,
        max_rounds: int = 3,
    ) -> Dict[str, Any]:
        """P2-6: 执行协商协议 — 提议-响应多轮协商。

        协商流程：
        1. proposer 发起提议
        2. responder 响应（accept/reject/counter）
        3. 若 counter 则进入下一轮
        4. 达成一致或超过最大轮数时结束

        Args:
            task_id: 关联的 A2A Task ID.
            proposer: 提议方 Agent ID.
            proposal: 提议内容.
            responder: 响应方 Agent ID.
            max_rounds: 最大协商轮数.

        Returns:
            协商结果 {accepted, rounds, final_proposal, final_response}.
        """
        current_proposal = proposal
        final_response: Dict[str, Any] = {}

        for round_num in range(1, max_rounds + 1):
            logger.info(
                "P2-6: 协商轮次 %d/%d (task=%s, %s → %s)",
                round_num, max_rounds, task_id, proposer, responder,
            )

            # 持久化提议
            self._persist_negotiation(
                task_id=task_id,
                round_num=round_num,
                proposer=proposer,
                proposal=current_proposal,
                responder=responder,
                response_type="pending",
            )

            # 触发协商事件供外部处理
            event = A2ATaskEvent(
                task_id=task_id,
                type=A2ATaskEventType.STATUS_CHANGE,
                message=f"协商轮次 {round_num}: {proposer} 提议",
                timestamp=int(time.time() * 1000),
            )
            await self._emit_event(event)

            # 简化实现：检查 responder 是否有协商处理器
            handlers = self._event_handlers.get(f"negotiate:{responder}", [])
            if handlers:
                try:
                    handler_result = handlers[0](current_proposal)
                    if asyncio.iscoroutine(handler_result):
                        handler_result = await handler_result
                    final_response = handler_result if isinstance(handler_result, dict) else {}
                except Exception as exc:
                    logger.warning("P2-6: 协商处理器异常: %s", exc)
                    final_response = {"type": "reject", "reason": str(exc)}

            response_type = final_response.get("type", "accept")

            # 持久化响应
            self._persist_negotiation(
                task_id=task_id,
                round_num=round_num,
                proposer=proposer,
                proposal=current_proposal,
                responder=responder,
                response_type=response_type,
                response=final_response,
            )

            if response_type == "accept":
                logger.info("P2-6: 协商达成一致 (task=%s, rounds=%d)", task_id, round_num)
                return {
                    "accepted": True,
                    "rounds": round_num,
                    "final_proposal": current_proposal,
                    "final_response": final_response,
                }
            elif response_type == "counter":
                current_proposal = final_response.get("counter_proposal", current_proposal)
                proposer, responder = responder, proposer
            else:
                logger.info("P2-6: 协商被拒绝 (task=%s, rounds=%d)", task_id, round_num)
                return {
                    "accepted": False,
                    "rounds": round_num,
                    "final_proposal": current_proposal,
                    "final_response": final_response,
                }

        logger.info("P2-6: 协商超过最大轮数 (task=%s, max_rounds=%d)", task_id, max_rounds)
        return {
            "accepted": False,
            "rounds": max_rounds,
            "final_proposal": current_proposal,
            "final_response": final_response,
            "reason": "exceeded_max_rounds",
        }

    async def load_persisted_tasks(self) -> List[A2ATask]:
        """P2-6: 从持久化存储加载 Task 记录（用于重启恢复）。"""
        if not self._persist_conn:
            return []

        try:
            rows = self._persist_conn.execute(
                "SELECT * FROM a2a_tasks ORDER BY updated_at DESC LIMIT 100"
            ).fetchall()

            tasks: List[A2ATask] = []
            for row in rows:
                status = A2ATaskStatus(row["status"])
                task = A2ATask(
                    id=row["task_id"],
                    session_id=row["session_id"],
                    description=row["description"],
                    from_agent_id=row["from_agent_id"],
                    to_agent_id=row["to_agent_id"],
                    status=status,
                    input=json.loads(row["input_json"]) if row["input_json"] else {},
                    output=json.loads(row["output_json"]) if row["output_json"] else None,
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    completed_at=row["completed_at"],
                    error=row["error"],
                )
                tasks.append(task)
                if status not in (A2ATaskStatus.COMPLETED, A2ATaskStatus.FAILED, A2ATaskStatus.CANCELLED):
                    self._tasks[task.id] = task

            logger.info("P2-6: 从持久化存储加载了 %d 个 Task (%d 个活跃)", len(tasks), len(self._tasks))
            return tasks
        except Exception as exc:
            logger.warning("P2-6: 加载持久化 Task 失败: %s", exc)
            return []

    async def clear_all(self) -> None:
        """清空所有数据（仅用于测试）."""
        async with self._lock:
            self._agent_cards.clear()
            self._tasks.clear()
            self._event_handlers.clear()
            self._task_listeners.clear()
            # P2-6: 同时清空委派链
            self._delegation_chain.clear()

    def close(self) -> None:
        """P2-6: 关闭持久化连接，释放资源。"""
        if self._persist_conn is not None:
            try:
                self._persist_conn.close()
                logger.info("P2-6: 协商持久化 SQLite 连接已关闭")
            except Exception as exc:
                logger.warning("P2-6: 关闭持久化连接失败: %s", exc)
            finally:
                self._persist_conn = None

    def __del__(self) -> None:
        """P2-6: 析构时确保 SQLite 连接关闭。"""
        self.close()


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
