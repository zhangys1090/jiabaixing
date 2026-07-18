"""A2A 协议增强 — 跨 Agent 任务管理、发现与信任.

提供三个核心类:
- A2ATaskManager: 跨 Agent 任务委派与结果收集
- A2ADiscovery: Agent 注册发现与健康检查
- A2ATrustManager: Agent 信任等级与操作权限管理

遵循 AGENTS.md 架构原则: A2A 协议主实现端为 Python。
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from agent.a2a.types import A2AAgentCard, A2ATaskStatus

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════
# 信任等级
# ═══════════════════════════════════════════════════════════════


class TrustLevel(str, Enum):
    """Agent 信任等级枚举.

    Attributes:
        UNTRUSTED: 不信任，仅允许只读操作.
        LOW: 低信任，允许基本任务提交.
        MEDIUM: 中信任，允许任务委派和结果收集.
        HIGH: 高信任，允许所有操作.
    """

    UNTRUSTED = "untrusted"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


# 每个信任等级允许的操作列表
_TRUST_LEVEL_ACTIONS: Dict[TrustLevel, List[str]] = {
    TrustLevel.UNTRUSTED: ["discover", "health_check"],
    TrustLevel.LOW: ["discover", "health_check", "delegate_task", "get_task_status"],
    TrustLevel.MEDIUM: [
        "discover", "health_check", "delegate_task", "get_task_status",
        "cancel_task", "collect_results",
    ],
    TrustLevel.HIGH: [
        "discover", "health_check", "delegate_task", "get_task_status",
        "cancel_task", "collect_results", "register_agent", "set_trust",
    ],
}


# ═══════════════════════════════════════════════════════════════
# A2ATaskManager
# ═══════════════════════════════════════════════════════════════


class A2ATaskManager:
    """跨 Agent 任务管理器.

    管理向远程 Agent 委派任务的完整生命周期：委派 → 查询 → 取消 → 收集结果。
    内部使用 A2AClient 进行远程通信。

    Attributes:
        _client_cache: 已创建的 A2AClient 缓存 (agent_url → client).
        _delegated_tasks: 已委派的任务映射 (task_id → task_info).

    Usage:
        from agent.a2a.client import A2AClient

        manager = A2ATaskManager()
        task_id = await manager.delegate_task("http://remote:8765", task)
        status = await manager.get_task_status(task_id)
        result = await manager.collect_results(task_id)
    """

    def __init__(self) -> None:
        """初始化跨 Agent 任务管理器."""
        self._client_cache: Dict[str, Any] = {}  # agent_url → A2AClient
        self._delegated_tasks: Dict[str, Dict[str, Any]] = {}  # task_id → info
        logger.info("A2ATaskManager 初始化完成")

    async def delegate_task(
        self,
        agent_url: str,
        task: Dict[str, Any],
    ) -> str:
        """委派任务给远程 Agent.

        通过 A2AClient 在远程 Agent 创建任务，返回任务 ID。
        若远程 Agent 不可达，返回空字符串。

        Args:
            agent_url: 远程 Agent 的基础 URL，如 "http://remote:8765".
            task: 任务描述字典，含 description / from_agent_id / to_agent_id 等字段.

        Returns:
            str: 远程任务 ID，失败返回空字符串.
        """
        from agent.a2a.client import A2AClient

        client = await self._get_or_create_client(agent_url)

        try:
            remote_task = await client.create_task(
                from_agent_id=task.get("from_agent_id", "local"),
                to_agent_id=task.get("to_agent_id", "remote"),
                description=task.get("description", ""),
                input_data=task.get("input", {}),
                session_id=task.get("session_id"),
            )

            if remote_task is None:
                logger.warning("委派任务失败: 无法创建远程任务 (url=%s)", agent_url)
                return ""

            # 记录委派信息
            self._delegated_tasks[remote_task.id] = {
                "agent_url": agent_url,
                "remote_task_id": remote_task.id,
                "delegated_at": int(time.time() * 1000),
                "status": A2ATaskStatus.SUBMITTED.value,
                "original_task": task,
            }

            logger.info(
                "任务已委派: task_id=%s, url=%s",
                remote_task.id, agent_url,
            )
            return remote_task.id

        except Exception as e:
            logger.warning("委派任务异常: url=%s, error=%s", agent_url, e)
            return ""

    async def get_task_status(self, task_id: str) -> Dict[str, Any]:
        """查询远程任务状态.

        Args:
            task_id: 任务唯一标识.

        Returns:
            dict: 任务状态信息，含 status / updated_at 等字段.
                若任务不存在返回 {"status": "unknown", "error": "task not found"}.
        """
        task_info = self._delegated_tasks.get(task_id)
        if task_info is None:
            return {"status": "unknown", "error": "task not found"}

        agent_url = task_info["agent_url"]
        client = await self._get_or_create_client(agent_url)

        try:
            remote_task = await client.get_task(task_id)
            if remote_task is None:
                return {
                    "status": "unknown",
                    "error": "remote task not found",
                    "task_id": task_id,
                }

            # 更新本地缓存
            task_info["status"] = remote_task.status.value
            task_info["updated_at"] = remote_task.updated_at

            return {
                "task_id": task_id,
                "status": remote_task.status.value,
                "updated_at": remote_task.updated_at,
                "error": remote_task.error,
            }

        except Exception as e:
            logger.warning("查询任务状态异常: task_id=%s, error=%s", task_id, e)
            return {"status": "error", "error": str(e), "task_id": task_id}

    async def cancel_task(self, task_id: str) -> bool:
        """取消远程任务.

        Args:
            task_id: 任务唯一标识.

        Returns:
            bool: 取消成功返回 True.
        """
        task_info = self._delegated_tasks.get(task_id)
        if task_info is None:
            logger.warning("取消任务失败: 任务不存在 %s", task_id)
            return False

        agent_url = task_info["agent_url"]
        client = await self._get_or_create_client(agent_url)

        try:
            result = await client.cancel_task(task_id, reason="由本地 Agent 取消")
            if result is not None:
                task_info["status"] = A2ATaskStatus.CANCELLED.value
                logger.info("任务已取消: %s", task_id)
                return True
            return False
        except Exception as e:
            logger.warning("取消任务异常: task_id=%s, error=%s", task_id, e)
            return False

    async def collect_results(self, task_id: str) -> Any:
        """收集远程任务结果.

        仅当任务处于终态（completed / failed / cancelled）时才返回结果。
        任务仍在执行中时返回 None。

        Args:
            task_id: 任务唯一标识.

        Returns:
            Any: 任务输出数据。任务未完成或不存在返回 None.
        """
        task_info = self._delegated_tasks.get(task_id)
        if task_info is None:
            logger.warning("收集结果失败: 任务不存在 %s", task_id)
            return None

        agent_url = task_info["agent_url"]
        client = await self._get_or_create_client(agent_url)

        try:
            remote_task = await client.get_task(task_id)
            if remote_task is None:
                return None

            terminal_states = {
                A2ATaskStatus.COMPLETED,
                A2ATaskStatus.FAILED,
                A2ATaskStatus.CANCELLED,
            }

            if remote_task.status not in terminal_states:
                logger.info("任务未完成: task_id=%s, status=%s", task_id, remote_task.status.value)
                return None

            return remote_task.output

        except Exception as e:
            logger.warning("收集结果异常: task_id=%s, error=%s", task_id, e)
            return None

    async def _get_or_create_client(self, agent_url: str) -> Any:
        """获取或创建 A2AClient（惰性缓存）.

        Args:
            agent_url: Agent URL.

        Returns:
            A2AClient: 客户端实例.
        """
        from agent.a2a.client import A2AClient

        if agent_url not in self._client_cache:
            client = A2AClient(base_url=agent_url)
            self._client_cache[agent_url] = client
        return self._client_cache[agent_url]

    async def close(self) -> None:
        """关闭所有缓存的客户端连接."""
        for client in self._client_cache.values():
            try:
                await client.close()
            except Exception:
                pass
        self._client_cache.clear()


# ═══════════════════════════════════════════════════════════════
# A2ADiscovery
# ═══════════════════════════════════════════════════════════════


class A2ADiscovery:
    """Agent 发现服务.

    管理本地 Agent 注册表，支持按能力发现和批量健康检查。
    可与 A2AProtocolManager 协同使用，也可独立运行。

    Attributes:
        _registry: Agent Card 注册表 (agent_id → card).
        _health_status: 健康状态缓存 (agent_id → last_check_time / healthy).

    Usage:
        discovery = A2ADiscovery()
        discovery.register_agent(card)
        agents = discovery.discover_agents("task-execution")
        health = discovery.health_check_all()
    """

    def __init__(self) -> None:
        """初始化 Agent 发现服务."""
        self._registry: Dict[str, A2AAgentCard] = {}
        self._health_status: Dict[str, Dict[str, Any]] = {}
        logger.info("A2ADiscovery 初始化完成")

    def register_agent(self, card: A2AAgentCard) -> None:
        """注册 Agent Card.

        若 agent_id 已存在则覆盖。

        Args:
            card: Agent Card 实例.
        """
        self._registry[card.id] = card
        self._health_status[card.id] = {
            "healthy": None,
            "last_check_time": 0,
            "url": card.url,
        }
        logger.info("Agent 注册: %s (%s)", card.name, card.id)

    def discover_agents(self, capability: str) -> List[A2AAgentCard]:
        """按能力发现 Agent.

        Args:
            capability: 能力类型字符串，如 "task-execution".

        Returns:
            list[A2AAgentCard]: 匹配的 Agent Card 列表.
        """
        results: List[A2AAgentCard] = []
        for card in self._registry.values():
            for cap in card.capabilities:
                if cap.type.value == capability or cap.name == capability:
                    results.append(card)
                    break
        return results

    async def health_check_all(self) -> Dict[str, bool]:
        """批量健康检查所有已注册 Agent.

        对每个有 URL 的 Agent 发送 HTTP GET 请求检查可达性。
        无 URL 的 Agent 标记为 False。

        Returns:
            dict[str, bool]: agent_id → 是否健康.
        """
        import httpx

        results: Dict[str, bool] = {}

        for agent_id, info in self._health_status.items():
            url = info.get("url", "")
            if not url:
                results[agent_id] = False
                continue

            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    response = await client.get(f"{url.rstrip('/')}/health")
                    healthy = response.status_code == 200
            except Exception:
                healthy = False

            results[agent_id] = healthy
            info["healthy"] = healthy
            info["last_check_time"] = int(time.time() * 1000)

        logger.info(
            "健康检查完成: %d/%d 健康",
            sum(1 for v in results.values() if v),
            len(results),
        )
        return results


# ═══════════════════════════════════════════════════════════════
# A2ATrustManager
# ═══════════════════════════════════════════════════════════════


@dataclass
class AgentTrustRecord:
    """Agent 信任记录.

    Attributes:
        agent_id: Agent 唯一标识.
        trust_level: 信任等级.
        verified: 是否已验证.
        verified_at: 验证时间戳（毫秒）.
        violation_count: 违规次数.
    """

    agent_id: str
    trust_level: TrustLevel = TrustLevel.UNTRUSTED
    verified: bool = False
    verified_at: int = 0
    violation_count: int = 0


class A2ATrustManager:
    """Agent 信任管理器.

    管理 Agent 的信任等级和操作权限，确保跨 Agent 交互的安全性。

    Attributes:
        _records: Agent 信任记录映射 (agent_id → AgentTrustRecord).
        _max_violations: 最大违规次数，超过后降级信任等级.

    Usage:
        trust_mgr = A2ATrustManager()
        trust_mgr.set_trust_level("agent:remote", TrustLevel.MEDIUM)
        if trust_mgr.verify_agent("agent:remote"):
            allowed = trust_mgr.get_allowed_actions("agent:remote")
    """

    # 违规次数阈值，超过后自动降级
    _MAX_VIOLATIONS_BEFORE_DOWNGRADE = 3

    def __init__(self, max_violations: int = 3) -> None:
        """初始化信任管理器.

        Args:
            max_violations: 触发自动降级的最大违规次数，默认 3.
        """
        self._records: Dict[str, AgentTrustRecord] = {}
        self._max_violations = max_violations
        logger.info("A2ATrustManager 初始化完成 (max_violations=%d)", max_violations)

    def verify_agent(self, agent_id: str) -> bool:
        """验证 Agent 可信度.

        Agent 可信的条件：信任等级 >= LOW 且已通过验证。

        Args:
            agent_id: Agent 唯一标识.

        Returns:
            bool: 可信返回 True.
        """
        record = self._records.get(agent_id)
        if record is None:
            logger.warning("信任验证失败: Agent 未注册 %s", agent_id)
            return False

        # 检查违规次数是否超标
        if record.violation_count >= self._max_violations:
            self._downgrade_trust(agent_id)
            return False

        return record.trust_level in (TrustLevel.LOW, TrustLevel.MEDIUM, TrustLevel.HIGH) and record.verified

    def set_trust_level(self, agent_id: str, level: TrustLevel | str) -> None:
        """设置 Agent 信任等级.

        若 Agent 记录不存在则自动创建。设置信任等级时自动标记为已验证。

        Args:
            agent_id: Agent 唯一标识.
            level: 信任等级（TrustLevel 枚举或字符串）.
        """
        if isinstance(level, str):
            try:
                level = TrustLevel(level)
            except ValueError:
                level = TrustLevel.UNTRUSTED

        record = self._records.get(agent_id)
        if record is None:
            record = AgentTrustRecord(
                agent_id=agent_id,
                trust_level=level,
                verified=True,
                verified_at=int(time.time() * 1000),
            )
            self._records[agent_id] = record
        else:
            record.trust_level = level
            # 提升信任等级时重新标记为已验证
            if level in (TrustLevel.MEDIUM, TrustLevel.HIGH):
                record.verified = True
                record.verified_at = int(time.time() * 1000)

        logger.info("信任等级设置: agent=%s, level=%s", agent_id, level.value)

    def get_allowed_actions(self, agent_id: str) -> List[str]:
        """获取 Agent 允许的操作列表.

        基于当前信任等级返回允许的操作。

        Args:
            agent_id: Agent 唯一标识.

        Returns:
            list[str]: 允许的操作名称列表. 未注册 Agent 返回空列表.
        """
        record = self._records.get(agent_id)
        if record is None:
            return []

        return list(_TRUST_LEVEL_ACTIONS.get(record.trust_level, []))

    def record_violation(self, agent_id: str, reason: str = "") -> None:
        """记录 Agent 违规行为.

        违规次数超过阈值后自动降级信任等级。

        Args:
            agent_id: Agent 唯一标识.
            reason: 违规原因.
        """
        record = self._records.get(agent_id)
        if record is None:
            record = AgentTrustRecord(agent_id=agent_id)
            self._records[agent_id] = record

        record.violation_count += 1
        logger.warning(
            "Agent 违规记录: agent=%s, count=%d, reason=%s",
            agent_id, record.violation_count, reason,
        )

        if record.violation_count >= self._max_violations:
            self._downgrade_trust(agent_id)

    def _downgrade_trust(self, agent_id: str) -> None:
        """降级 Agent 信任等级.

        按等级链降级: HIGH → MEDIUM → LOW → UNTRUSTED

        Args:
            agent_id: Agent 唯一标识.
        """
        record = self._records.get(agent_id)
        if record is None:
            return

        downgrade_map = {
            TrustLevel.HIGH: TrustLevel.MEDIUM,
            TrustLevel.MEDIUM: TrustLevel.LOW,
            TrustLevel.LOW: TrustLevel.UNTRUSTED,
            TrustLevel.UNTRUSTED: TrustLevel.UNTRUSTED,
        }

        old_level = record.trust_level
        new_level = downgrade_map.get(old_level, TrustLevel.UNTRUSTED)
        record.trust_level = new_level

        # 降级后标记为未验证
        if new_level == TrustLevel.UNTRUSTED:
            record.verified = False

        logger.info(
            "信任等级降级: agent=%s, %s → %s",
            agent_id, old_level.value, new_level.value,
        )
