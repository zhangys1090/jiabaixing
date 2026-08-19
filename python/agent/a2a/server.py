"""A2A HTTP 服务器 — FastAPI 路由集成.

将 A2A 协议能力通过 HTTP 端点暴露，供远程 Agent 调用。
对应 A2A 协议规范:
- GET  /.well-known/agent.json        — Agent Card 发现
- POST /api/a2a/tasks                 — 创建 Task
- GET  /api/a2a/tasks/{task_id}       — 查询 Task
- GET  /api/a2a/tasks                 — 列出 Task
- POST /api/a2a/tasks/{task_id}/cancel — 取消 Task
- POST /api/a2a/push                  — 推送通知
- GET  /api/a2a/agents                — 列出所有 Agent
- GET  /api/a2a/agents/discover       — 按能力发现 Agent
- GET  /api/a2a/stats                 — 协议统计

入站鉴权: 若提供 auth_interceptor + self_card.authentication.type != none，
则受保护端点（tasks 生命周期 / push）会先调用 auth_interceptor.verify_inbound
校验请求头凭据，校验失败返回 401。发现类端点（agent.json / agents / discover）
保持公开，遵循 A2A 协议发现规范。

遵循 AGENTS.md 架构原则: TS 侧仅做 HTTP 入口路由转发，业务逻辑在 Python 端。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from agent.a2a.auth import A2AAuthInterceptor
from agent.a2a.manager import A2AProtocolManager, get_a2a_manager
from agent.a2a.types import (
    A2AAgentCard,
    A2AArtifact,
    A2AAuthType,
    A2ACapability,
    A2ACapabilityType,
    A2ATask,
    A2ATaskStatus,
)
from agent.core.logger import log_ignored

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════
# Pydantic 请求/响应模型
# ═══════════════════════════════════════════════════════════════


class CreateTaskRequest(BaseModel):
    """创建 Task 请求模型.

    Attributes:
        from_agent_id: 发起方 Agent ID.
        to_agent_id: 执行方 Agent ID.
        description: 任务描述.
        input_data: 任务输入数据.
        session_id: 会话 ID（可选）.
    """

    from_agent_id: str = Field(..., alias="fromAgentId")
    to_agent_id: str = Field(..., alias="toAgentId")
    description: str
    input_data: Dict[str, Any] = Field(default_factory=dict, alias="input")
    session_id: Optional[str] = Field(None, alias="sessionId")

    model_config = {"populate_by_name": True}


class UpdateStatusRequest(BaseModel):
    """更新 Task 状态请求模型.

    Attributes:
        status: 新状态.
        message: 状态变更消息.
        output: 任务输出.
        error: 错误信息.
    """

    status: str
    message: str = ""
    output: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class AddArtifactRequest(BaseModel):
    """添加产物请求模型.

    Attributes:
        id: 产物唯一标识.
        name: 产物名称.
        mime_type: MIME 类型.
        content: 内容.
        metadata: 额外元数据.
    """

    id: str
    name: str = ""
    mime_type: str = "text/plain"
    content: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class CancelTaskRequest(BaseModel):
    """取消 Task 请求模型.

    Attributes:
        reason: 取消原因.
    """

    reason: str = ""


class PushNotificationRequest(BaseModel):
    """推送通知请求模型.

    Attributes:
        task_id: 关联的 Task ID.
        event_type: 事件类型 (status-change/artifact-update/progress).
        message: 通知消息.
        data: 附加数据.
    """

    task_id: str = Field(..., alias="taskId")
    event_type: str = Field("status-change", alias="eventType")
    message: str = ""
    data: Dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class PublishAgentCardRequest(BaseModel):
    """发布 Agent Card 请求模型.

    Attributes:
        id: Agent 唯一标识.
        name: 显示名称.
        description: 详细描述.
        url: Agent 服务端点 URL.
        transport: 传输协议.
        capabilities: 能力列表.
        version: 版本号.
    """

    id: str
    name: str
    description: str = ""
    url: str = ""
    transport: str = "http"
    capabilities: List[Dict[str, Any]] = Field(default_factory=list)
    authentication: Optional[Dict[str, str]] = None
    version: str = "1.0.0"
    provider: Optional[Dict[str, str]] = None


# ═══════════════════════════════════════════════════════════════
# 路由工厂
# ═══════════════════════════════════════════════════════════════


def _www_authenticate(auth_type: str) -> str:
    """构造 401 响应的 WWW-Authenticate 头值.

    Args:
        auth_type: 鉴权类型字符串（none/api-key/bearer/jwt）.

    Returns:
        str: WWW-Authenticate 头值.
    """
    if auth_type in ("bearer", "jwt", "oauth2"):
        return 'Bearer realm="a2a"'
    if auth_type == "api-key":
        return 'ApiKey realm="a2a"'
    return 'None realm="a2a"'


def create_a2a_router(
    manager: Optional[A2AProtocolManager] = None,
    self_card: Optional[A2AAgentCard] = None,
    auth_interceptor: Optional[A2AAuthInterceptor] = None,
) -> APIRouter:
    """创建 A2A FastAPI 路由器.

    Args:
        manager: A2A 协议管理器. None 则使用全局单例.
        self_card: 自身 Agent Card，用于 /.well-known/agent.json 端点，
            以及作为入站鉴权的 expected_auth 来源.
        auth_interceptor: 入站鉴权拦截器. None 表示不启用入站鉴权.
            启用后，受保护端点（tasks 生命周期 / push）会校验请求头凭据.

    Returns:
        APIRouter: FastAPI 路由器实例，可挂载到任意 FastAPI app.

    Usage:
        # 不带鉴权
        router = create_a2a_router(self_card=my_card)

        # 带入站鉴权
        interceptor = A2AAuthInterceptor.from_env()
        router = create_a2a_router(self_card=my_card, auth_interceptor=interceptor)
        app.include_router(router)
    """
    router = APIRouter(prefix="/a2a", tags=["A2A Protocol"])

    async def _get_manager() -> A2AProtocolManager:
        """获取协议管理器（延迟初始化）."""
        return manager if manager is not None else await get_a2a_manager()

    def _require_auth(request: Request) -> None:
        """入站鉴权依赖：校验请求头凭据，失败抛出 401.

        使用 auth_interceptor.self_auth（含凭据）作为期望配置，
        而非 self_card.get_auth_config()（仅含 type，是公开发布的）.

        Args:
            request: FastAPI Request 对象.

        Raises:
            HTTPException: 401 鉴权失败.
        """
        if auth_interceptor is None or self_card is None:
            # 未启用鉴权 — 直接放行
            return
        # 使用拦截器内部的 self_auth（含凭据，从环境变量加载）
        expected_auth = auth_interceptor.self_auth
        # 若鉴权类型为 NONE，直接放行
        if expected_auth.type == A2AAuthType.NONE:
            return
        # 将 request.headers 转为普通 dict
        headers_dict: Dict[str, str] = {k: v for k, v in request.headers.items()}
        if not auth_interceptor.verify_inbound(headers_dict, expected_auth):
            logger.warning(
                "A2A 入站鉴权失败: path=%s type=%s",
                request.url.path,
                expected_auth.type.value,
            )
            raise HTTPException(
                status_code=401,
                detail=f"A2A 鉴权失败: {expected_auth.type.value}",
                headers={"WWW-Authenticate": _www_authenticate(expected_auth.type.value)},
            )

    # ───────────────────────────────────────────────────────────
    # Agent Card 端点
    # ───────────────────────────────────────────────────────────

    @router.get("/.well-known/agent.json", include_in_schema=False)
    async def get_self_agent_card() -> Dict[str, Any]:
        """返回自身 Agent Card（A2A 协议标准发现端点）.

        Returns:
            Dict[str, Any]: Agent Card 字典.

        Raises:
            HTTPException: 404 未配置自身 Agent Card.
        """
        if self_card is None:
            raise HTTPException(
                status_code=404,
                detail="未配置自身 Agent Card，无法响应 /.well-known/agent.json",
            )
        result = self_card.to_dict()
        result.pop("authentication", None)
        return result

    @router.get("/agents", response_model=List[Dict[str, Any]])
    async def list_agents() -> List[Dict[str, Any]]:
        """列出所有已注册 Agent Card.

        Returns:
            List[Dict[str, Any]]: Agent Card 列表.
        """
        m = await _get_manager()
        cards = await m.list_agent_cards()
        results = []
        for c in cards:
            d = c.to_dict()
            d.pop("authentication", None)
            results.append(d)
        return results

    @router.get("/agents/discover", response_model=List[Dict[str, Any]])
    async def discover_agents(
        capability: Optional[str] = Query(
            None, description="能力类型筛选，如 task-execution"
        ),
    ) -> List[Dict[str, Any]]:
        """按能力发现 Agent.

        Args:
            capability: 能力类型字符串（如 task-execution）.

        Returns:
            List[Dict[str, Any]]: 匹配的 Agent Card 列表.
        """
        m = await _get_manager()
        cap_type = None
        if capability:
            try:
                cap_type = A2ACapabilityType(capability)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail=f"无效的能力类型: {capability}",
                )
        cards = await m.discover_agents(cap_type)
        results = []
        for c in cards:
            d = c.to_dict()
            d.pop("authentication", None)
            results.append(d)
        return results

    @router.post("/agents/publish", response_model=Dict[str, Any], dependencies=[Depends(_require_auth)])
    async def publish_agent_card(req: PublishAgentCardRequest) -> Dict[str, Any]:
        """发布 Agent Card.

        Args:
            req: Agent Card 发布请求.

        Returns:
            Dict[str, Any]: 发布的 Agent Card.
        """
        m = await _get_manager()
        # A-05: 存储时脱敏 authentication 字典，只保留 type 字段，移除敏感凭据值。
        safe_auth = None
        if req.authentication:
            safe_auth = {"type": req.authentication.get("type", "none")}
        card = A2AAgentCard(
            id=req.id,
            name=req.name,
            description=req.description,
            url=req.url,
            transport=__import__("agent.a2a.types", fromlist=["A2ATransport"]).A2ATransport(
                req.transport
            ),
            capabilities=[A2ACapability.from_dict(c) for c in req.capabilities],
            authentication=safe_auth,
            version=req.version,
            provider=req.provider,
        )
        await m.publish_agent_card(card)
        result = card.to_dict()
        result.pop("authentication", None)
        return result

    # ───────────────────────────────────────────────────────────
    # Task 生命周期端点
    # ───────────────────────────────────────────────────────────

    @router.post("/tasks", response_model=Dict[str, Any], dependencies=[Depends(_require_auth)])
    async def create_task(req: CreateTaskRequest) -> Dict[str, Any]:
        """创建 A2A Task.

        Args:
            req: 创建 Task 请求.

        Returns:
            Dict[str, Any]: 创建的 Task.
        """
        m = await _get_manager()
        task = await m.create_task(
            from_agent_id=req.from_agent_id,
            to_agent_id=req.to_agent_id,
            description=req.description,
            input_data=req.input_data,
            session_id=req.session_id,
        )
        return task.to_dict()

    @router.get("/tasks/{task_id}", response_model=Dict[str, Any], dependencies=[Depends(_require_auth)])
    async def get_task(task_id: str) -> Dict[str, Any]:
        """查询 Task 详情.

        Args:
            task_id: Task 唯一标识.

        Returns:
            Dict[str, Any]: Task 详情.

        Raises:
            HTTPException: 404 Task 不存在.
        """
        m = await _get_manager()
        task = await m.get_task(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"Task 不存在: {task_id}")
        return task.to_dict()

    @router.get("/tasks", response_model=List[Dict[str, Any]], dependencies=[Depends(_require_auth)])
    async def list_tasks(
        agent_id: Optional[str] = Query(None, alias="agentId"),
        status: Optional[str] = Query(None),
    ) -> List[Dict[str, Any]]:
        """列出 Task（可按 agent_id / status 筛选）.

        Args:
            agent_id: 筛选特定 Agent 的 Task.
            status: 筛选特定状态的 Task.

        Returns:
            List[Dict[str, Any]]: Task 列表.
        """
        m = await _get_manager()
        status_enum = None
        if status:
            try:
                status_enum = A2ATaskStatus(status)
            except ValueError:
                raise HTTPException(
                    status_code=400, detail=f"无效的状态: {status}"
                )
        tasks = await m.list_tasks(agent_id=agent_id, status=status_enum)
        return [t.to_dict() for t in tasks]

    @router.post("/tasks/{task_id}/status", response_model=Dict[str, Any], dependencies=[Depends(_require_auth)])
    async def update_task_status(
        task_id: str, req: UpdateStatusRequest
    ) -> Dict[str, Any]:
        """更新 Task 状态.

        Args:
            task_id: Task 唯一标识.
            req: 状态更新请求.

        Returns:
            Dict[str, Any]: 更新后的 Task.

        Raises:
            HTTPException: 404 Task 不存在; 400 非法状态跳转.
        """
        m = await _get_manager()
        try:
            new_status = A2ATaskStatus(req.status)
        except ValueError:
            raise HTTPException(
                status_code=400, detail=f"无效的状态: {req.status}"
            )

        task = await m.update_task_status(
            task_id, new_status, message=req.message, output=req.output, error=req.error
        )
        if task is None:
            existing = await m.get_task(task_id)
            if existing is None:
                raise HTTPException(status_code=404, detail=f"Task 不存在: {task_id}")
            raise HTTPException(
                status_code=400,
                detail=f"非法状态跳转: {existing.status.value} → {req.status}",
            )
        return task.to_dict()

    @router.post("/tasks/{task_id}/artifacts", response_model=Dict[str, Any], dependencies=[Depends(_require_auth)])
    async def add_artifact(
        task_id: str, req: AddArtifactRequest
    ) -> Dict[str, Any]:
        """向 Task 添加产物.

        Args:
            task_id: Task 唯一标识.
            req: 产物添加请求.

        Returns:
            Dict[str, Any]: 更新后的 Task.

        Raises:
            HTTPException: 404 Task 不存在.
        """
        m = await _get_manager()
        artifact = A2AArtifact(
            id=req.id,
            name=req.name,
            mime_type=req.mime_type,
            content=req.content,
            metadata=req.metadata,
        )
        task = await m.add_artifact(task_id, artifact)
        if task is None:
            raise HTTPException(status_code=404, detail=f"Task 不存在: {task_id}")
        return task.to_dict()

    @router.post("/tasks/{task_id}/cancel", response_model=Dict[str, Any], dependencies=[Depends(_require_auth)])
    async def cancel_task(task_id: str, req: CancelTaskRequest) -> Dict[str, Any]:
        """取消 Task.

        Args:
            task_id: Task 唯一标识.
            req: 取消请求.

        Returns:
            Dict[str, Any]: 更新后的 Task.

        Raises:
            HTTPException: 404 Task 不存在; 400 已终态无法取消.
        """
        m = await _get_manager()
        task = await m.cancel_task(task_id, reason=req.reason)
        if task is None:
            existing = await m.get_task(task_id)
            if existing is None:
                raise HTTPException(status_code=404, detail=f"Task 不存在: {task_id}")
            raise HTTPException(
                status_code=400,
                detail=f"Task 已终态，无法取消（当前状态: {existing.status.value}）",
            )
        return task.to_dict()

    # ───────────────────────────────────────────────────────────
    # 推送通知端点
    # ───────────────────────────────────────────────────────────

    @router.post("/push", response_model=Dict[str, Any], dependencies=[Depends(_require_auth)])
    async def push_notification(req: PushNotificationRequest) -> Dict[str, Any]:
        """接收远程 Agent 的推送通知.

        Args:
            req: 推送通知请求.

        Returns:
            Dict[str, Any]: 接收确认.
        """
        logger.info(
            "📩 A2A 推送通知: task=%s type=%s msg=%s",
            req.task_id,
            req.event_type,
            req.message,
        )

        m = await _get_manager()
        task = await m.get_task(req.task_id)
        if task is not None:
            if req.event_type == "status-change":
                new_status = req.data.get("status")
                if new_status:
                    try:
                        from agent.a2a.types import TaskStatus
                        task.status = TaskStatus(new_status)
                        if hasattr(m, "update_task"):
                            await m.update_task(task)
                    except (ValueError, KeyError) as _exc:
                        log_ignored(logger, "server.create_a2a_router.push_notification", _exc)
            elif req.event_type == "progress":
                progress = req.data.get("progress")
                if progress is not None:
                    if not hasattr(task, "metadata") or task.metadata is None:
                        task.metadata = {}
                    task.metadata["push_progress"] = progress
                    if hasattr(m, "update_task"):
                        await m.update_task(task)
            elif req.event_type == "artifact":
                artifact = req.data.get("artifact")
                if artifact is not None:
                    if not hasattr(task, "metadata") or task.metadata is None:
                        task.metadata = {}
                    task.metadata.setdefault("artifacts", []).append(artifact)
                    if hasattr(m, "update_task"):
                        await m.update_task(task)

        return {
            "received": True,
            "taskId": req.task_id,
            "eventType": req.event_type,
            "message": req.message,
        }

    # ───────────────────────────────────────────────────────────
    # P1-6: A2A 结果推送回调（WebHook / SSE）
    # ───────────────────────────────────────────────────────────

    _push_subscribers: Dict[str, List[Any]] = {}

    @router.post("/push/subscribe", response_model=Dict[str, Any])
    async def subscribe_push_notifications(
        task_id: str = Query(..., alias="taskId"),
        callback_url: Optional[str] = Query(None, alias="callbackUrl"),
    ) -> Dict[str, Any]:
        """P1-6: 订阅 Task 结果推送通知.

        支持两种模式:
        - WebHook: 提供 callbackUrl，任务状态变更时 POST 到该 URL
        - SSE: 不提供 callbackUrl，通过 /push/stream SSE 端点接收

        Args:
            task_id: 要订阅的 Task ID.
            callback_url: WebHook 回调 URL（可选）.

        Returns:
            Dict[str, Any]: 订阅确认.
        """
        sub_id = f"push_sub_{task_id}_{id(callback_url)}"
        if task_id not in _push_subscribers:
            _push_subscribers[task_id] = []
        _push_subscribers[task_id].append({
            "sub_id": sub_id,
            "callback_url": callback_url,
            "created_at": __import__("time").time(),
        })
        logger.info("P1-6: 推送订阅注册: task=%s sub=%s url=%s", task_id, sub_id, callback_url)
        return {"subId": sub_id, "taskId": task_id, "mode": "webhook" if callback_url else "sse"}

    @router.get("/push/stream")
    async def push_notification_stream(
        task_id: str = Query(..., alias="taskId"),
    ):
        """P1-6: SSE 推送通知流.

        客户端通过此端点建立 SSE 连接，实时接收 Task 状态变更通知.

        Args:
            task_id: 要监听的 Task ID.
        """
        from fastapi.responses import StreamingResponse
        import asyncio
        import json

        queue: asyncio.Queue = asyncio.Queue()

        if task_id not in _push_subscribers:
            _push_subscribers[task_id] = []
        _push_subscribers[task_id].append({"sub_id": f"sse_{id(queue)}", "queue": queue})

        async def event_generator():
            try:
                while True:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
            except asyncio.CancelledError:
                pass

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    async def _dispatch_push_to_subscribers(
        task_id: str, event_type: str, data: Dict[str, Any],
    ) -> None:
        """P1-6: 将推送事件分发到所有订阅者（WebHook + SSE）.

        Args:
            task_id: Task ID.
            event_type: 事件类型.
            data: 事件数据.
        """
        import json as _json

        subscribers = _push_subscribers.get(task_id, [])
        for sub in subscribers:
            if "queue" in sub:
                await sub["queue"].put({"eventType": event_type, **data})
            elif sub.get("callback_url"):
                try:
                    import httpx
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        await client.post(
                            sub["callback_url"],
                            json={"taskId": task_id, "eventType": event_type, **data},
                        )
                except Exception as _exc:
                    log_ignored(logger, "server._dispatch_push_to_subscribers.webhook", _exc)

    # ───────────────────────────────────────────────────────────
    # 统计端点
    # ───────────────────────────────────────────────────────────

    @router.get("/stats", response_model=Dict[str, Any])
    async def get_stats() -> Dict[str, Any]:
        """获取 A2A 协议统计信息.

        Returns:
            Dict[str, Any]: 统计信息.
        """
        m = await _get_manager()
        return await m.get_stats()

    return router


def mount_a2a_routes(
    app,
    manager: Optional[A2AProtocolManager] = None,
    self_card: Optional[A2AAgentCard] = None,
    auth_interceptor: Optional[A2AAuthInterceptor] = None,
) -> APIRouter:
    """将 A2A 路由挂载到 FastAPI app.

    Args:
        app: FastAPI 应用实例.
        manager: A2A 协议管理器. None 则使用全局单例.
        self_card: 自身 Agent Card.
        auth_interceptor: 入站鉴权拦截器. None 表示不启用入站鉴权.

    Returns:
        APIRouter: 已挂载的路由器实例.

    Usage:
        from fastapi import FastAPI
        from agent.a2a import mount_a2a_routes, A2AAgentCard, A2AAuthInterceptor

        app = FastAPI()
        self_card = A2AAgentCard(id="agent:jiabaixing", name="Jiabaixing", url="http://...")
        interceptor = A2AAuthInterceptor.from_env()
        mount_a2a_routes(app, self_card=self_card, auth_interceptor=interceptor)
    """
    router = create_a2a_router(
        manager=manager, self_card=self_card, auth_interceptor=auth_interceptor
    )
    app.include_router(router)
    logger.info(
        "A2A 路由已挂载到 FastAPI app (auth=%s)",
        "on" if auth_interceptor else "off",
    )
    return router
