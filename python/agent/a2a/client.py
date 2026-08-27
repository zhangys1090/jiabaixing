"""A2A Client — 调用远程 Agent 的客户端.

提供 HTTP 客户端能力，让本地 Agent 可以调用远程 Agent 的 A2A 端点:
- 发现远程 Agent Card
- 创建委派 Task
- 查询 Task 状态
- 取消 Task
- 发送推送通知

出站鉴权: 若提供 auth_interceptor + target_card，所有出站请求会自动注入
对应的鉴权头（X-API-Key / Authorization: Bearer xxx / JWT）.

遵循 AGENTS.md 架构原则: A2A 协议主实现端为 Python。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

from agent.a2a.auth import A2AAuthInterceptor
from agent.a2a.types import (
    A2AAgentCard,
    A2ACapabilityType,
    A2ATask,
    A2ATaskStatus,
)

logger = logging.getLogger(__name__)



# 默认超时（秒）
DEFAULT_TIMEOUT = 30.0


class A2AClient:
    """A2A 客户端 — 调用远程 Agent.

    通过 HTTP 调用远程 Agent 的 A2A 端点，支持:
    - Agent Card 发现 (GET /.well-known/agent.json)
    - 创建 Task (POST /a2a/tasks)
    - 查询 Task (GET /a2a/tasks/{task_id})
    - 列出 Task (GET /a2a/tasks)
    - 更新 Task 状态 (POST /a2a/tasks/{task_id}/status)
    - 取消 Task (POST /a2a/tasks/{task_id}/cancel)
    - 添加产物 (POST /a2a/tasks/{task_id}/artifacts)
    - 列出 Agent (GET /a2a/agents)
    - 按能力发现 Agent (GET /a2a/agents/discover)
    - 发送推送通知 (POST /a2a/push)

    出站鉴权: 若同时提供 auth_interceptor 与 target_card，所有出站请求会通过
    auth_interceptor.verify_outbound(target_card, headers) 注入鉴权头。

    Attributes:
        _base_url: 目标 Agent 的基础 URL，如 "http://jiabaixing-python:8765".
        _timeout: HTTP 请求超时（秒）.
        _headers: 默认请求头.
        _client: httpx.AsyncClient 实例（惰性创建）.
        _auth_interceptor: 出站鉴权拦截器（可选）.
        _target_card: 目标 Agent Card（可选，用于出站鉴权）.

    Usage:
        # 不带鉴权
        client = A2AClient("http://remote-agent:8765")

        # 带 A2AAuthInterceptor 出站鉴权
        interceptor = A2AAuthInterceptor.from_env()
        target_card = A2AAgentCard(id="agent:remote", name="Remote",
                                    authentication={"type": "api-key"})
        client = A2AClient("http://remote-agent:8765",
                           auth_interceptor=interceptor, target_card=target_card)
        card = await client.discover_agent()
        task = await client.create_task(...)
        await client.close()
    """

    def __init__(
        self,
        base_url: str,
        timeout: float = DEFAULT_TIMEOUT,
        headers: Optional[Dict[str, str]] = None,
        api_key: Optional[str] = None,
        auth_interceptor: Optional[A2AAuthInterceptor] = None,
        target_card: Optional[A2AAgentCard] = None,
    ) -> None:
        """初始化 A2A 客户端.

        Args:
            base_url: 目标 Agent 的基础 URL（不含 /a2a 前缀）.
            timeout: HTTP 请求超时（秒）.
            headers: 额外请求头.
            api_key: API Key（若远程 Agent 需要认证）. 注意：当 auth_interceptor
                被提供时，auth_interceptor 优先；此参数仅为兼容旧 API 保留.
            auth_interceptor: 出站鉴权拦截器（可选）.
            target_card: 目标 Agent Card（可选，用于出站鉴权头注入）.
        """
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._headers: Dict[str, str] = {"Content-Type": "application/json"}
        if headers:
            self._headers.update(headers)
        if api_key:
            self._headers["Authorization"] = f"Bearer {api_key}"
        self._client: Optional[httpx.AsyncClient] = None
        # 出站鉴权组件
        self._auth_interceptor: Optional[A2AAuthInterceptor] = auth_interceptor
        self._target_card: Optional[A2AAgentCard] = target_card
        logger.debug(
            "A2AClient 初始化: base_url=%s auth=%s",
            self._base_url,
            "on" if auth_interceptor else "off",
        )

    def set_target_card(self, card: A2AAgentCard) -> None:
        """设置/更新目标 Agent Card（用于出站鉴权头注入）.

        Args:
            card: 目标 Agent Card.
        """
        self._target_card = card

    def _auth_headers(self) -> Dict[str, str]:
        """计算当前出站请求应注入的鉴权头.

        若 auth_interceptor 与 target_card 均已配置，调用
        auth_interceptor.verify_outbound 注入鉴权头；否则返回空字典.

        Returns:
            Dict[str, str]: 鉴权头字典（可能为空）.
        """
        if self._auth_interceptor is None or self._target_card is None:
            return {}
        return self._auth_interceptor.verify_outbound(self._target_card, {})

    async def _get_client(self) -> httpx.AsyncClient:
        """获取 httpx 客户端实例（惰性创建）.

        Returns:
            httpx.AsyncClient: 客户端实例.
        """
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                headers=self._headers,
            )
        return self._client

    async def close(self) -> None:
        """关闭客户端，释放连接池资源."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> "A2AClient":
        """异步上下文管理器入口."""
        await self._get_client()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """异步上下文管理器出口."""
        await self.close()

    # ───────────────────────────────────────────────────────────
    # Agent Card 发现
    # ───────────────────────────────────────────────────────────

    async def discover_agent(self) -> Optional[A2AAgentCard]:
        """发现远程 Agent Card (GET /.well-known/agent.json).

        发现成功后，若未显式设置 target_card，则自动缓存返回的 AgentCard
        以便后续出站请求注入鉴权头。

        Returns:
            Optional[A2AAgentCard]: Agent Card 实例，失败返回 None.
        """
        try:
            client = await self._get_client()
            response = await client.get(
                "/.well-known/agent.json", headers=self._auth_headers()
            )
            response.raise_for_status()
            data = response.json()
            card = A2AAgentCard.from_dict(data)
            # 自动缓存目标 AgentCard，用于后续出站鉴权
            if self._target_card is None:
                self._target_card = card
            return card
        except Exception as e:
            logger.warning("发现远程 Agent Card 失败: %s", e)
            return None

    async def list_agents(self) -> List[A2AAgentCard]:
        """列出远程 Agent 已注册的所有 Agent Card (GET /a2a/agents).

        Returns:
            List[A2AAgentCard]: Agent Card 列表，失败返回空列表.
        """
        try:
            client = await self._get_client()
            response = await client.get("/a2a/agents", headers=self._auth_headers())
            response.raise_for_status()
            data = response.json()
            return [A2AAgentCard.from_dict(c) for c in data]
        except Exception as e:
            logger.warning("列出远程 Agent 失败: %s", e)
            return []

    async def discover_agents(
        self, capability: Optional[A2ACapabilityType] = None
    ) -> List[A2AAgentCard]:
        """按能力发现远程 Agent (GET /a2a/agents/discover).

        Args:
            capability: 能力类型. None 表示返回所有.

        Returns:
            List[A2AAgentCard]: 匹配的 Agent Card 列表.
        """
        try:
            client = await self._get_client()
            params = {}
            if capability is not None:
                params["capability"] = capability.value
            response = await client.get(
                "/a2a/agents/discover", params=params, headers=self._auth_headers()
            )
            response.raise_for_status()
            data = response.json()
            return [A2AAgentCard.from_dict(c) for c in data]
        except Exception as e:
            logger.warning("按能力发现远程 Agent 失败: %s", e)
            return []

    # ───────────────────────────────────────────────────────────
    # P2-3: A2A 服务发现（mDNS / DNS-SD）
    # ───────────────────────────────────────────────────────────

    @staticmethod
    async def discover_via_mdns(
        service_type: str = "_a2a._tcp.local.",
        timeout: float = 5.0,
    ) -> List[Dict[str, Any]]:
        """P2-3: 通过 mDNS/DNS-SD 发现局域网内的 A2A Agent.

        使用 zeroconf 库在局域网内广播和发现 A2A 服务，
        无需预先知道目标 Agent 的 URL。

        Args:
            service_type: mDNS 服务类型，默认 _a2a._tcp.local.
            timeout: 发现超时（秒）.

        Returns:
            List[Dict]: 发现的服务列表 [{name, host, port, properties}].
        """
        try:
            from zeroconf import Zeroconf, ServiceBrowser, ServiceStateChange
            import socket

            discovered: List[Dict[str, Any]] = []
            zc = Zeroconf()

            def on_service_state_change(
                zeroconf: Zeroconf,
                service_type: str,
                name: str,
                state_change: ServiceStateChange,
            ) -> None:
                if state_change == ServiceStateChange.Added:
                    info = zeroconf.get_service_info(service_type, name)
                    if info:
                        addresses = [
                            socket.inet_ntoa(addr) for addr in info.addresses
                        ]
                        discovered.append({
                            "name": name,
                            "host": addresses[0] if addresses else "",
                            "port": info.port,
                            "properties": {
                                k.decode(): v.decode() if isinstance(v, bytes) else v
                                for k, v in (info.properties or {}).items()
                            },
                        })

            browser = ServiceBrowser(zc, service_type, handlers=[on_service_state_change])

            import asyncio
            await asyncio.sleep(timeout)

            browser.cancel()
            zc.close()

            logger.info(
                "P2-3: mDNS 发现 %d 个 A2A 服务 (timeout=%.1fs)",
                len(discovered), timeout,
            )
            return discovered

        except ImportError:
            logger.warning(
                "P2-3: zeroconf 未安装，mDNS 发现不可用。"
                "安装: pip install zeroconf"
            )
            return []
        except Exception as e:
            logger.warning("P2-3: mDNS 发现失败: %s", e)
            return []

    # ───────────────────────────────────────────────────────────
    # Task 生命周期
    # ───────────────────────────────────────────────────────────

    async def create_task(
        self,
        from_agent_id: str,
        to_agent_id: str,
        description: str,
        input_data: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> Optional[A2ATask]:
        """创建委派 Task (POST /a2a/tasks).

        Args:
            from_agent_id: 发起方 Agent ID（通常是自己）.
            to_agent_id: 执行方 Agent ID.
            description: 任务描述.
            input_data: 任务输入.
            session_id: 会话 ID.

        Returns:
            Optional[A2ATask]: 创建的 Task，失败返回 None.
        """
        try:
            client = await self._get_client()
            payload = {
                "fromAgentId": from_agent_id,
                "toAgentId": to_agent_id,
                "description": description,
                "input": input_data or {},
            }
            if session_id:
                payload["sessionId"] = session_id
            response = await client.post(
                "/a2a/tasks", json=payload, headers=self._auth_headers()
            )
            response.raise_for_status()
            data = response.json()
            return _task_from_dict(data)
        except Exception as e:
            logger.warning("创建远程 Task 失败: %s", e)
            return None

    async def get_task(self, task_id: str) -> Optional[A2ATask]:
        """查询 Task 详情 (GET /a2a/tasks/{task_id}).

        Args:
            task_id: Task 唯一标识.

        Returns:
            Optional[A2ATask]: Task 实例，不存在/失败返回 None.
        """
        try:
            client = await self._get_client()
            response = await client.get(
                f"/a2a/tasks/{task_id}", headers=self._auth_headers()
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return _task_from_dict(response.json())
        except Exception as e:
            logger.warning("查询远程 Task 失败: %s", e)
            return None

    async def list_tasks(
        self,
        agent_id: Optional[str] = None,
        status: Optional[A2ATaskStatus] = None,
    ) -> List[A2ATask]:
        """列出远程 Task (GET /a2a/tasks).

        Args:
            agent_id: 筛选特定 Agent.
            status: 筛选特定状态.

        Returns:
            List[A2ATask]: Task 列表，失败返回空列表.
        """
        try:
            client = await self._get_client()
            params = {}
            if agent_id:
                params["agentId"] = agent_id
            if status:
                params["status"] = status.value
            response = await client.get(
                "/a2a/tasks", params=params, headers=self._auth_headers()
            )
            response.raise_for_status()
            data = response.json()
            return [_task_from_dict(t) for t in data]
        except Exception as e:
            logger.warning("列出远程 Task 失败: %s", e)
            return []

    async def update_task_status(
        self,
        task_id: str,
        new_status: A2ATaskStatus,
        message: str = "",
        output: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> Optional[A2ATask]:
        """更新远程 Task 状态 (POST /a2a/tasks/{task_id}/status).

        Args:
            task_id: Task 唯一标识.
            new_status: 新状态.
            message: 状态变更消息.
            output: 任务输出.
            error: 错误信息.

        Returns:
            Optional[A2ATask]: 更新后的 Task，失败返回 None.
        """
        try:
            client = await self._get_client()
            payload: Dict[str, Any] = {"status": new_status.value, "message": message}
            if output is not None:
                payload["output"] = output
            if error is not None:
                payload["error"] = error
            response = await client.post(
                f"/a2a/tasks/{task_id}/status",
                json=payload,
                headers=self._auth_headers(),
            )
            if response.status_code in (404, 400):
                logger.warning(
                    "更新远程 Task 状态失败: task=%s status=%s response=%s",
                    task_id,
                    new_status.value,
                    response.text,
                )
                return None
            response.raise_for_status()
            return _task_from_dict(response.json())
        except Exception as e:
            logger.warning("更新远程 Task 状态失败: %s", e)
            return None

    async def cancel_task(self, task_id: str, reason: str = "") -> Optional[A2ATask]:
        """取消远程 Task (POST /a2a/tasks/{task_id}/cancel).

        Args:
            task_id: Task 唯一标识.
            reason: 取消原因.

        Returns:
            Optional[A2ATask]: 更新后的 Task，失败返回 None.
        """
        try:
            client = await self._get_client()
            response = await client.post(
                f"/a2a/tasks/{task_id}/cancel",
                json={"reason": reason},
                headers=self._auth_headers(),
            )
            if response.status_code in (404, 400):
                return None
            response.raise_for_status()
            return _task_from_dict(response.json())
        except Exception as e:
            logger.warning("取消远程 Task 失败: %s", e)
            return None

    # ───────────────────────────────────────────────────────────
    # 推送通知
    # ───────────────────────────────────────────────────────────

    async def send_push_notification(
        self,
        task_id: str,
        message: str,
        event_type: str = "status-change",
        data: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """向远程 Agent 发送推送通知 (POST /a2a/push).

        Args:
            task_id: 关联的 Task ID.
            message: 通知消息.
            event_type: 事件类型.
            data: 附加数据.

        Returns:
            bool: 是否发送成功.
        """
        try:
            client = await self._get_client()
            payload = {
                "taskId": task_id,
                "eventType": event_type,
                "message": message,
                "data": data or {},
            }
            response = await client.post(
                "/a2a/push", json=payload, headers=self._auth_headers()
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning("发送推送通知失败: %s", e)
            return False


# ═══════════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════════


def _task_from_dict(data: Dict[str, Any]) -> A2ATask:
    """从字典构造 A2ATask 实例.

    Args:
        data: 字典数据.

    Returns:
        A2ATask: Task 实例.
    """
    try:
        status_val = data.get("status", "submitted")
        status = A2ATaskStatus(status_val)
    except ValueError:
        status = A2ATaskStatus.SUBMITTED

    return A2ATask(
        id=data.get("id", ""),
        session_id=data.get("sessionId", ""),
        description=data.get("description", ""),
        from_agent_id=data.get("fromAgentId", ""),
        to_agent_id=data.get("toAgentId", ""),
        status=status,
        input=data.get("input", {}),
        output=data.get("output"),
        created_at=data.get("createdAt", 0),
        updated_at=data.get("updatedAt", 0),
        completed_at=data.get("completedAt"),
        error=data.get("error"),
        status_history=data.get("statusHistory", []),
    )
