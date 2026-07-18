"""A2A 协议测试套件.

覆盖:
- Agent Card 发布/发现/序列化
- Task 生命周期（创建/状态流转/取消/添加产物/进度更新）
- 状态流转合法性校验
- 事件订阅
- HTTP 端点（FastAPI 路由）
- A2A Client（HTTP 调用，使用 httpx.MockTransport）

遵循测试规范:
- 独立临时数据库（此处为内存管理器，无 DB 依赖）
- 资源清理（每个测试后清理管理器）
- 异步测试使用 pytest.mark.asyncio
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.a2a import (
    A2AAgentCard,
    A2ACapability,
    A2ACapabilityType,
    A2AClient,
    A2ATask,
    A2ATaskEvent,
    A2ATaskEventType,
    A2ATaskStatus,
    A2ATransport,
    A2AProtocolManager,
    create_a2a_router,
    get_a2a_manager,
)
from agent.a2a.manager import _reset_a2a_manager_for_testing


# ═══════════════════════════════════════════════════════════════
# 测试夹具
# ═══════════════════════════════════════════════════════════════


@pytest.fixture
def manager() -> A2AProtocolManager:
    """提供独立的 A2AProtocolManager 实例（每个测试独立）."""
    return A2AProtocolManager()


@pytest.fixture
def sample_card() -> A2AAgentCard:
    """提供样本 Agent Card."""
    return A2AAgentCard(
        id="agent:jiabaixing:orchestrator",
        name="Jiabaixing Orchestrator",
        description="主编排 Agent",
        url="http://localhost:8765/a2a",
        transport=A2ATransport.HTTP,
        capabilities=[
            A2ACapability(
                type=A2ACapabilityType.TASK_EXECUTION,
                name="task-execute",
                description="执行通用任务",
            ),
            A2ACapability(
                type=A2ACapabilityType.ORCHESTRATION,
                name="orchestrate",
                description="编排多 Agent 协作",
            ),
        ],
        authentication={"type": "api-key"},
        version="1.0.0",
        provider={"name": "Jiabaixing", "url": "https://jiabaixing.example.com"},
    )


# ═══════════════════════════════════════════════════════════════
# 类型与序列化测试
# ═══════════════════════════════════════════════════════════════


class TestA2ATypes:
    """A2A 类型与序列化测试."""

    def test_agent_card_to_dict(self, sample_card: A2AAgentCard) -> None:
        """测试 Agent Card 序列化为字典."""
        d = sample_card.to_dict()
        assert d["id"] == "agent:jiabaixing:orchestrator"
        assert d["name"] == "Jiabaixing Orchestrator"
        assert d["transport"] == "http"
        assert len(d["capabilities"]) == 2
        assert d["capabilities"][0]["type"] == "task-execution"
        assert d["version"] == "1.0.0"

    def test_agent_card_from_dict(self, sample_card: A2AAgentCard) -> None:
        """测试 Agent Card 反序列化."""
        d = sample_card.to_dict()
        card = A2AAgentCard.from_dict(d)
        assert card.id == sample_card.id
        assert card.name == sample_card.name
        assert card.transport == sample_card.transport
        assert len(card.capabilities) == 2
        assert card.capabilities[0].type == A2ACapabilityType.TASK_EXECUTION

    def test_agent_card_from_dict_invalid_transport(self) -> None:
        """测试无效传输协议回退到 HTTP."""
        card = A2AAgentCard.from_dict(
            {"id": "x", "name": "X", "transport": "invalid-transport"}
        )
        assert card.transport == A2ATransport.HTTP

    def test_capability_to_dict(self) -> None:
        """测试能力序列化."""
        cap = A2ACapability(
            type=A2ACapabilityType.DATA_PROCESSING,
            name="data-proc",
            description="数据处理",
            modalities=["text", "image"],
        )
        d = cap.to_dict()
        assert d["type"] == "data-processing"
        assert d["name"] == "data-proc"
        assert d["modalities"] == ["text", "image"]

    def test_task_status_enum_values(self) -> None:
        """测试 Task 状态枚举值."""
        assert A2ATaskStatus.SUBMITTED.value == "submitted"
        assert A2ATaskStatus.WORKING.value == "working"
        assert A2ATaskStatus.INPUT_REQUIRED.value == "input-required"
        assert A2ATaskStatus.COMPLETED.value == "completed"
        assert A2ATaskStatus.FAILED.value == "failed"
        assert A2ATaskStatus.CANCELLED.value == "cancelled"

    def test_task_to_dict(self) -> None:
        """测试 Task 序列化."""
        task = A2ATask(
            id="t1",
            session_id="s1",
            description="测试任务",
            from_agent_id="a",
            to_agent_id="b",
            status=A2ATaskStatus.WORKING,
            input={"key": "value"},
            created_at=1000,
            updated_at=2000,
        )
        d = task.to_dict()
        assert d["id"] == "t1"
        assert d["status"] == "working"
        assert d["input"] == {"key": "value"}
        assert d["createdAt"] == 1000


# ═══════════════════════════════════════════════════════════════
# Agent Card 管理测试
# ═══════════════════════════════════════════════════════════════


class TestAgentCardManagement:
    """Agent Card 发布与发现测试."""

    @pytest.mark.asyncio
    async def test_publish_and_get_card(
        self, manager: A2AProtocolManager, sample_card: A2AAgentCard
    ) -> None:
        """测试发布并获取 Agent Card."""
        await manager.publish_agent_card(sample_card)
        card = await manager.get_agent_card(sample_card.id)
        assert card is not None
        assert card.id == sample_card.id

    @pytest.mark.asyncio
    async def test_get_missing_card(self, manager: A2AProtocolManager) -> None:
        """测试获取不存在的 Agent Card 返回 None."""
        card = await manager.get_agent_card("agent:nonexistent")
        assert card is None

    @pytest.mark.asyncio
    async def test_list_agent_cards(
        self, manager: A2AProtocolManager, sample_card: A2AAgentCard
    ) -> None:
        """测试列出所有 Agent Card."""
        await manager.publish_agent_card(sample_card)
        another = A2AAgentCard(id="agent:2", name="Agent2")
        await manager.publish_agent_card(another)
        cards = await manager.list_agent_cards()
        assert len(cards) == 2

    @pytest.mark.asyncio
    async def test_discover_agents_by_capability(
        self, manager: A2AProtocolManager, sample_card: A2AAgentCard
    ) -> None:
        """测试按能力发现 Agent."""
        await manager.publish_agent_card(sample_card)
        # 添加一个没有 task-execution 能力的 Agent
        other = A2AAgentCard(
            id="agent:monitor",
            name="Monitor",
            capabilities=[
                A2ACapability(
                    type=A2ACapabilityType.MONITORING, name="monitor-all"
                )
            ],
        )
        await manager.publish_agent_card(other)

        task_agents = await manager.discover_agents(A2ACapabilityType.TASK_EXECUTION)
        assert len(task_agents) == 1
        assert task_agents[0].id == sample_card.id

        monitor_agents = await manager.discover_agents(A2ACapabilityType.MONITORING)
        assert len(monitor_agents) == 1
        assert monitor_agents[0].id == "agent:monitor"

    @pytest.mark.asyncio
    async def test_discover_agents_no_filter(
        self, manager: A2AProtocolManager, sample_card: A2AAgentCard
    ) -> None:
        """测试无过滤条件返回所有 Agent."""
        await manager.publish_agent_card(sample_card)
        all_agents = await manager.discover_agents(None)
        assert len(all_agents) == 1


# ═══════════════════════════════════════════════════════════════
# Task 生命周期测试
# ═══════════════════════════════════════════════════════════════


class TestTaskLifecycle:
    """Task 生命周期测试."""

    @pytest.mark.asyncio
    async def test_create_task(self, manager: A2AProtocolManager) -> None:
        """测试创建 Task."""
        task = await manager.create_task(
            from_agent_id="agent:a",
            to_agent_id="agent:b",
            description="测试任务",
            input_data={"query": "hello"},
        )
        assert task.id.startswith("a2a_task_")
        assert task.status == A2ATaskStatus.SUBMITTED
        assert task.from_agent_id == "agent:a"
        assert task.to_agent_id == "agent:b"
        assert task.input == {"query": "hello"}
        assert task.created_at > 0
        assert task.updated_at == task.created_at
        assert len(task.status_history) == 1
        assert task.status_history[0]["status"] == "submitted"

    @pytest.mark.asyncio
    async def test_get_task(self, manager: A2AProtocolManager) -> None:
        """测试获取 Task."""
        task = await manager.create_task(
            from_agent_id="a", to_agent_id="b", description="x"
        )
        fetched = await manager.get_task(task.id)
        assert fetched is not None
        assert fetched.id == task.id

    @pytest.mark.asyncio
    async def test_get_missing_task(self, manager: A2AProtocolManager) -> None:
        """测试获取不存在的 Task."""
        task = await manager.get_task("nonexistent")
        assert task is None

    @pytest.mark.asyncio
    async def test_list_tasks_filter_by_agent(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试按 Agent 筛选 Task."""
        await manager.create_task("a", "b", "t1")
        await manager.create_task("a", "c", "t2")
        await manager.create_task("d", "b", "t3")

        a_tasks = await manager.list_tasks(agent_id="a")
        assert len(a_tasks) == 2

        b_tasks = await manager.list_tasks(agent_id="b")
        assert len(b_tasks) == 2  # b 是 t1 的 to 和 t3 的 to

    @pytest.mark.asyncio
    async def test_list_tasks_filter_by_status(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试按状态筛选 Task."""
        t1 = await manager.create_task("a", "b", "t1")
        t2 = await manager.create_task("a", "b", "t2")
        await manager.update_task_status(t1.id, A2ATaskStatus.WORKING)

        submitted = await manager.list_tasks(status=A2ATaskStatus.SUBMITTED)
        working = await manager.list_tasks(status=A2ATaskStatus.WORKING)

        assert len(submitted) == 1
        assert len(working) == 1
        assert working[0].id == t1.id

    @pytest.mark.asyncio
    async def test_valid_status_transition(self, manager: A2AProtocolManager) -> None:
        """测试合法状态流转."""
        task = await manager.create_task("a", "b", "x")
        # SUBMITTED → WORKING
        updated = await manager.update_task_status(
            task.id, A2ATaskStatus.WORKING, message="开始执行"
        )
        assert updated is not None
        assert updated.status == A2ATaskStatus.WORKING
        assert len(updated.status_history) == 2

        # WORKING → COMPLETED
        updated = await manager.update_task_status(
            task.id, A2ATaskStatus.COMPLETED, output={"result": "done"}
        )
        assert updated is not None
        assert updated.status == A2ATaskStatus.COMPLETED
        assert updated.completed_at is not None
        assert updated.output == {"result": "done"}

    @pytest.mark.asyncio
    async def test_invalid_status_transition(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试非法状态流转被拒绝（COMPLETED → WORKING）."""
        task = await manager.create_task("a", "b", "x")
        await manager.update_task_status(task.id, A2ATaskStatus.WORKING)
        await manager.update_task_status(task.id, A2ATaskStatus.COMPLETED)

        # COMPLETED 是终态，不能再变更为 WORKING
        result = await manager.update_task_status(
            task.id, A2ATaskStatus.WORKING, message="尝试复活"
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_update_status_missing_task(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试更新不存在的 Task 返回 None."""
        result = await manager.update_task_status(
            "nonexistent", A2ATaskStatus.WORKING
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_failed_status_with_error(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试失败状态携带错误信息."""
        task = await manager.create_task("a", "b", "x")
        await manager.update_task_status(task.id, A2ATaskStatus.WORKING)
        updated = await manager.update_task_status(
            task.id, A2ATaskStatus.FAILED, error="工具执行异常"
        )
        assert updated is not None
        assert updated.status == A2ATaskStatus.FAILED
        assert updated.error == "工具执行异常"
        assert updated.completed_at is not None

    @pytest.mark.asyncio
    async def test_cancel_task(self, manager: A2AProtocolManager) -> None:
        """测试取消 Task."""
        task = await manager.create_task("a", "b", "x")
        cancelled = await manager.cancel_task(task.id, reason="用户取消")
        assert cancelled is not None
        assert cancelled.status == A2ATaskStatus.CANCELLED

    @pytest.mark.asyncio
    async def test_cancel_terminal_task(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试取消已终态 Task 返回 None."""
        task = await manager.create_task("a", "b", "x")
        await manager.update_task_status(task.id, A2ATaskStatus.WORKING)
        await manager.update_task_status(task.id, A2ATaskStatus.COMPLETED)

        result = await manager.cancel_task(task.id)
        assert result is None

    @pytest.mark.asyncio
    async def test_add_artifact(self, manager: A2AProtocolManager) -> None:
        """测试添加产物."""
        from agent.a2a.types import A2AArtifact

        task = await manager.create_task("a", "b", "x")
        artifact = A2AArtifact(
            id="art-1",
            name="result.txt",
            mime_type="text/plain",
            content="任务结果内容",
        )
        updated = await manager.add_artifact(task.id, artifact)
        assert updated is not None
        assert len(updated.artifacts) == 1
        assert updated.artifacts[0].id == "art-1"

    @pytest.mark.asyncio
    async def test_add_artifact_missing_task(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试向不存在的 Task 添加产物返回 None."""
        from agent.a2a.types import A2AArtifact

        artifact = A2AArtifact(id="art-1")
        result = await manager.add_artifact("nonexistent", artifact)
        assert result is None

    @pytest.mark.asyncio
    async def test_update_progress(self, manager: A2AProtocolManager) -> None:
        """测试更新进度."""
        task = await manager.create_task("a", "b", "x")
        updated = await manager.update_progress(task.id, 50.0, message="进度过半")
        assert updated is not None

    @pytest.mark.asyncio
    async def test_update_progress_clamped(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试进度值被限制在 0-100."""
        task = await manager.create_task("a", "b", "x")
        # 测试通过事件验证 clamp（update_progress 不直接返回 progress）
        events: List[A2ATaskEvent] = []
        manager.on_task_event(task.id, events.append)
        await manager.update_progress(task.id, 150.0)
        await manager.update_progress(task.id, -10.0)
        # 事件中的 progress 应被 clamp
        assert events[0].progress == 100.0
        assert events[1].progress == 0.0


# ═══════════════════════════════════════════════════════════════
# 事件订阅测试
# ═══════════════════════════════════════════════════════════════


class TestEventSubscription:
    """事件订阅测试."""

    @pytest.mark.asyncio
    async def test_on_task_event_called(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试特定 Task 事件订阅被调用."""
        events: List[A2ATaskEvent] = []
        task = await manager.create_task("a", "b", "x")
        manager.on_task_event(task.id, events.append)

        await manager.update_task_status(task.id, A2ATaskStatus.WORKING)

        assert len(events) == 1
        assert events[0].type == A2ATaskEventType.STATUS_CHANGE
        assert events[0].status == A2ATaskStatus.WORKING

    @pytest.mark.asyncio
    async def test_on_any_task_event_called(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试全局 Task 事件订阅."""
        events: List[A2ATaskEvent] = []
        manager.on_any_task_event(events.append)

        t1 = await manager.create_task("a", "b", "x")
        t2 = await manager.create_task("c", "d", "y")

        # 至少收到 2 个 SUBMITTED 事件
        assert len(events) >= 2

    @pytest.mark.asyncio
    async def test_async_event_handler(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试异步事件处理器."""

        received: List[A2ATaskEvent] = []

        async def async_handler(event: A2ATaskEvent) -> None:
            received.append(event)

        task = await manager.create_task("a", "b", "x")
        manager.on_task_event(task.id, async_handler)
        await manager.update_task_status(task.id, A2ATaskStatus.WORKING)

        assert len(received) == 1

    @pytest.mark.asyncio
    async def test_event_handler_exception_not_break(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试事件处理器异常不影响主流程."""

        def bad_handler(event: A2ATaskEvent) -> None:
            raise RuntimeError("故意异常")

        task = await manager.create_task("a", "b", "x")
        manager.on_task_event(task.id, bad_handler)

        # 异常不应传播到主流程
        result = await manager.update_task_status(task.id, A2ATaskStatus.WORKING)
        assert result is not None
        assert result.status == A2ATaskStatus.WORKING


# ═══════════════════════════════════════════════════════════════
# 统计测试
# ═══════════════════════════════════════════════════════════════


class TestStats:
    """统计信息测试."""

    @pytest.mark.asyncio
    async def test_stats_empty(self, manager: A2AProtocolManager) -> None:
        """测试空管理器统计."""
        stats = await manager.get_stats()
        assert stats["agent_count"] == 0
        assert stats["task_count"] == 0
        assert stats["tasks_by_status"] == {}

    @pytest.mark.asyncio
    async def test_stats_after_operations(
        self,
        manager: A2AProtocolManager,
        sample_card: A2AAgentCard,
    ) -> None:
        """测试操作后统计."""
        await manager.publish_agent_card(sample_card)
        t1 = await manager.create_task("a", "b", "x")
        await manager.create_task("c", "d", "y")
        await manager.update_task_status(t1.id, A2ATaskStatus.WORKING)

        stats = await manager.get_stats()
        assert stats["agent_count"] == 1
        assert stats["task_count"] == 2
        assert stats["tasks_by_status"]["submitted"] == 1
        assert stats["tasks_by_status"]["working"] == 1


# ═══════════════════════════════════════════════════════════════
# HTTP 端点测试
# ═══════════════════════════════════════════════════════════════


class TestHTTPEndpoints:
    """HTTP 端点测试（使用 FastAPI TestClient）."""

    @pytest.fixture
    def app_with_router(
        self,
        manager: A2AProtocolManager,
        sample_card: A2AAgentCard,
    ) -> FastAPI:
        """提供挂载了 A2A 路由的 FastAPI app."""
        app = FastAPI()
        router = create_a2a_router(manager=manager, self_card=sample_card)
        app.include_router(router)
        return app

    def test_get_self_agent_card(
        self, app_with_router: FastAPI, sample_card: A2AAgentCard
    ) -> None:
        """测试获取自身 Agent Card."""
        client = TestClient(app_with_router)
        response = client.get("/a2a/.well-known/agent.json")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == sample_card.id
        assert data["name"] == sample_card.name

    def test_get_self_agent_card_not_configured(
        self, manager: A2AProtocolManager
    ) -> None:
        """测试未配置自身 Agent Card 时返回 404."""
        app = FastAPI()
        router = create_a2a_router(manager=manager, self_card=None)
        app.include_router(router)
        client = TestClient(app)
        response = client.get("/a2a/.well-known/agent.json")
        assert response.status_code == 404

    def test_list_agents_endpoint(
        self,
        app_with_router: FastAPI,
        manager: A2AProtocolManager,
        sample_card: A2AAgentCard,
    ) -> None:
        """测试列出 Agent 端点."""
        # 由于 manager 是异步的，需要通过事件循环初始化数据
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(manager.publish_agent_card(sample_card))
        finally:
            loop.close()

        client = TestClient(app_with_router)
        response = client.get("/a2a/agents")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["id"] == sample_card.id

    def test_discover_agents_endpoint(
        self,
        app_with_router: FastAPI,
        manager: A2AProtocolManager,
        sample_card: A2AAgentCard,
    ) -> None:
        """测试按能力发现 Agent 端点."""
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(manager.publish_agent_card(sample_card))
        finally:
            loop.close()

        client = TestClient(app_with_router)
        response = client.get(
            "/a2a/agents/discover", params={"capability": "task-execution"}
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1

    def test_discover_agents_invalid_capability(
        self, app_with_router: FastAPI
    ) -> None:
        """测试无效能力类型返回 400."""
        client = TestClient(app_with_router)
        response = client.get(
            "/a2a/agents/discover", params={"capability": "invalid-type"}
        )
        assert response.status_code == 400

    def test_create_task_endpoint(
        self, app_with_router: FastAPI
    ) -> None:
        """测试创建 Task 端点."""
        client = TestClient(app_with_router)
        response = client.post(
            "/a2a/tasks",
            json={
                "fromAgentId": "a",
                "toAgentId": "b",
                "description": "测试任务",
                "input": {"key": "value"},
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "submitted"
        assert data["fromAgentId"] == "a"
        assert data["toAgentId"] == "b"

    def test_get_task_endpoint(
        self, app_with_router: FastAPI
    ) -> None:
        """测试查询 Task 端点."""
        client = TestClient(app_with_router)
        # 先创建
        create_resp = client.post(
            "/a2a/tasks",
            json={
                "fromAgentId": "a",
                "toAgentId": "b",
                "description": "x",
            },
        )
        task_id = create_resp.json()["id"]

        # 再查询
        response = client.get(f"/a2a/tasks/{task_id}")
        assert response.status_code == 200
        assert response.json()["id"] == task_id

    def test_get_task_not_found(
        self, app_with_router: FastAPI
    ) -> None:
        """测试查询不存在的 Task 返回 404."""
        client = TestClient(app_with_router)
        response = client.get("/a2a/tasks/nonexistent")
        assert response.status_code == 404

    def test_list_tasks_endpoint(
        self, app_with_router: FastAPI
    ) -> None:
        """测试列出 Task 端点."""
        client = TestClient(app_with_router)
        client.post(
            "/a2a/tasks",
            json={"fromAgentId": "a", "toAgentId": "b", "description": "t1"},
        )
        client.post(
            "/a2a/tasks",
            json={"fromAgentId": "c", "toAgentId": "d", "description": "t2"},
        )

        response = client.get("/a2a/tasks")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2

    def test_update_task_status_endpoint(
        self, app_with_router: FastAPI
    ) -> None:
        """测试更新 Task 状态端点."""
        client = TestClient(app_with_router)
        create_resp = client.post(
            "/a2a/tasks",
            json={"fromAgentId": "a", "toAgentId": "b", "description": "x"},
        )
        task_id = create_resp.json()["id"]

        response = client.post(
            f"/a2a/tasks/{task_id}/status",
            json={"status": "working", "message": "开始执行"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "working"

    def test_update_task_status_invalid_transition(
        self, app_with_router: FastAPI
    ) -> None:
        """测试非法状态跳转返回 400."""
        client = TestClient(app_with_router)
        create_resp = client.post(
            "/a2a/tasks",
            json={"fromAgentId": "a", "toAgentId": "b", "description": "x"},
        )
        task_id = create_resp.json()["id"]

        # SUBMITTED → COMPLETED 是非法跳转（必须先 WORKING）
        response = client.post(
            f"/a2a/tasks/{task_id}/status",
            json={"status": "completed"},
        )
        assert response.status_code == 400

    def test_cancel_task_endpoint(
        self, app_with_router: FastAPI
    ) -> None:
        """测试取消 Task 端点."""
        client = TestClient(app_with_router)
        create_resp = client.post(
            "/a2a/tasks",
            json={"fromAgentId": "a", "toAgentId": "b", "description": "x"},
        )
        task_id = create_resp.json()["id"]

        response = client.post(
            f"/a2a/tasks/{task_id}/cancel", json={"reason": "用户取消"}
        )
        assert response.status_code == 200
        assert response.json()["status"] == "cancelled"

    def test_add_artifact_endpoint(
        self, app_with_router: FastAPI
    ) -> None:
        """测试添加产物端点."""
        client = TestClient(app_with_router)
        create_resp = client.post(
            "/a2a/tasks",
            json={"fromAgentId": "a", "toAgentId": "b", "description": "x"},
        )
        task_id = create_resp.json()["id"]

        response = client.post(
            f"/a2a/tasks/{task_id}/artifacts",
            json={
                "id": "art-1",
                "name": "result.txt",
                "mimeType": "text/plain",
                "content": "结果内容",
            },
        )
        assert response.status_code == 200
        assert len(response.json()["artifacts"]) == 1

    def test_push_notification_endpoint(
        self, app_with_router: FastAPI
    ) -> None:
        """测试推送通知端点."""
        client = TestClient(app_with_router)
        response = client.post(
            "/a2a/push",
            json={
                "taskId": "task-1",
                "eventType": "status-change",
                "message": "Task 完成",
            },
        )
        assert response.status_code == 200
        assert response.json()["received"] is True

    def test_stats_endpoint(
        self,
        app_with_router: FastAPI,
        manager: A2AProtocolManager,
        sample_card: A2AAgentCard,
    ) -> None:
        """测试统计端点."""
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(manager.publish_agent_card(sample_card))
            loop.run_until_complete(manager.create_task("a", "b", "x"))
        finally:
            loop.close()

        client = TestClient(app_with_router)
        response = client.get("/a2a/stats")
        assert response.status_code == 200
        data = response.json()
        assert data["agent_count"] == 1
        assert data["task_count"] == 1


# ═══════════════════════════════════════════════════════════════
# A2A Client 测试（使用 httpx.MockTransport）
# ═══════════════════════════════════════════════════════════════


class TestA2AClient:
    """A2A 客户端测试（使用 MockTransport 模拟远程 Agent）."""

    @pytest.mark.asyncio
    async def test_discover_agent_success(self) -> None:
        """测试成功发现远程 Agent Card."""
        card_data = {
            "id": "agent:remote",
            "name": "Remote Agent",
            "description": "远程测试 Agent",
            "url": "http://remote:8765/a2a",
            "transport": "http",
            "capabilities": [],
            "version": "1.0.0",
        }

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/.well-known/agent.json"
            return httpx.Response(200, json=card_data)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            card = await client.discover_agent()

        assert card is not None
        assert card.id == "agent:remote"
        assert card.name == "Remote Agent"

    @pytest.mark.asyncio
    async def test_discover_agent_failure(self) -> None:
        """测试发现失败返回 None."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="Internal Server Error")

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            card = await client.discover_agent()

        assert card is None

    @pytest.mark.asyncio
    async def test_create_task_remote(self) -> None:
        """测试远程创建 Task."""
        task_data = {
            "id": "a2a_task_remote1",
            "sessionId": "session_1",
            "description": "远程任务",
            "fromAgentId": "a",
            "toAgentId": "b",
            "status": "submitted",
            "input": {},
            "createdAt": 1000,
            "updatedAt": 1000,
            "statusHistory": [],
        }

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/a2a/tasks"
            assert request.method == "POST"
            return httpx.Response(200, json=task_data)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            task = await client.create_task(
                from_agent_id="a", to_agent_id="b", description="远程任务"
            )

        assert task is not None
        assert task.id == "a2a_task_remote1"
        assert task.status == A2ATaskStatus.SUBMITTED

    @pytest.mark.asyncio
    async def test_get_task_remote_not_found(self) -> None:
        """测试远程查询 Task 不存在返回 None."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="Not Found")

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            task = await client.get_task("nonexistent")

        assert task is None

    @pytest.mark.asyncio
    async def test_update_task_status_remote(self) -> None:
        """测试远程更新 Task 状态."""
        task_data = {
            "id": "t1",
            "sessionId": "s1",
            "description": "x",
            "fromAgentId": "a",
            "toAgentId": "b",
            "status": "working",
            "input": {},
            "createdAt": 1000,
            "updatedAt": 2000,
            "statusHistory": [],
        }

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/a2a/tasks/t1/status"
            body = json.loads(request.content)
            assert body["status"] == "working"
            return httpx.Response(200, json=task_data)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            task = await client.update_task_status(
                "t1", A2ATaskStatus.WORKING, message="开始执行"
            )

        assert task is not None
        assert task.status == A2ATaskStatus.WORKING

    @pytest.mark.asyncio
    async def test_cancel_task_remote(self) -> None:
        """测试远程取消 Task."""
        task_data = {
            "id": "t1",
            "sessionId": "s1",
            "description": "x",
            "fromAgentId": "a",
            "toAgentId": "b",
            "status": "cancelled",
            "input": {},
            "createdAt": 1000,
            "updatedAt": 2000,
            "statusHistory": [],
            "completedAt": 2000,
        }

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/a2a/tasks/t1/cancel"
            return httpx.Response(200, json=task_data)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            task = await client.cancel_task("t1", reason="用户取消")

        assert task is not None
        assert task.status == A2ATaskStatus.CANCELLED

    @pytest.mark.asyncio
    async def test_send_push_notification_success(self) -> None:
        """测试发送推送通知成功."""

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/a2a/push"
            body = json.loads(request.content)
            assert body["taskId"] == "t1"
            assert body["message"] == "完成"
            return httpx.Response(200, json={"received": True})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            success = await client.send_push_notification("t1", "完成")

        assert success is True

    @pytest.mark.asyncio
    async def test_send_push_notification_failure(self) -> None:
        """测试发送推送通知失败返回 False."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="Error")

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            success = await client.send_push_notification("t1", "x")

        assert success is False

    @pytest.mark.asyncio
    async def test_list_agents_remote(self) -> None:
        """测试远程列出 Agent."""
        agents_data = [
            {
                "id": "agent:1",
                "name": "Agent1",
                "transport": "http",
                "capabilities": [],
                "version": "1.0.0",
            }
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/a2a/agents"
            return httpx.Response(200, json=agents_data)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            agents = await client.list_agents()

        assert len(agents) == 1
        assert agents[0].id == "agent:1"

    @pytest.mark.asyncio
    async def test_list_tasks_remote(self) -> None:
        """测试远程列出 Task."""
        tasks_data = [
            {
                "id": "t1",
                "sessionId": "s1",
                "description": "x",
                "fromAgentId": "a",
                "toAgentId": "b",
                "status": "submitted",
                "input": {},
                "createdAt": 1000,
                "updatedAt": 1000,
                "statusHistory": [],
            }
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/a2a/tasks"
            return httpx.Response(200, json=tasks_data)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://remote:8765"
        ) as http_client:
            client = A2AClient("http://remote:8765")
            client._client = http_client
            tasks = await client.list_tasks()

        assert len(tasks) == 1
        assert tasks[0].id == "t1"

    @pytest.mark.asyncio
    async def test_close_client(self) -> None:
        """测试关闭客户端."""
        client = A2AClient("http://remote:8765")
        await client._get_client()
        assert client._client is not None
        await client.close()
        assert client._client is None


# ═══════════════════════════════════════════════════════════════
# 全局单例测试
# ═══════════════════════════════════════════════════════════════


class TestGlobalSingleton:
    """全局单例测试."""

    @pytest.mark.asyncio
    async def test_get_a2a_manager_singleton(self) -> None:
        """测试全局单例."""
        _reset_a2a_manager_for_testing()
        m1 = await get_a2a_manager()
        m2 = await get_a2a_manager()
        assert m1 is m2
        # 清理
        await m1.clear()
        _reset_a2a_manager_for_testing()


# ═══════════════════════════════════════════════════════════════
# 集成测试: main.py A2A 路由挂载
# ═══════════════════════════════════════════════════════════════


class TestA2ARoutesIntegrationWithMain:
    """验证 main.py 启动后 A2A 路由可访问的集成测试.

    修复断层: 此前 main.py 未调用 mount_a2a_routes(app)，导致 A2A HTTP 端点不可访问。
    本测试通过 TestClient 触发 main.py 的 lifespan，验证 A2A 路由被正确挂载。
    """

    def test_a2a_routes_accessible_after_startup(self, monkeypatch) -> None:
        """验证 main.py lifespan 启动后，GET /a2a/.well-known/agent.json 返回 200.

        测试步骤:
            1. Mock AgentEngine.initialize 仅初始化 A2A（跳过重型子系统）
            2. 使用 TestClient 触发 main.py lifespan
            3. GET /a2a/.well-known/agent.json
            4. 验证返回 200 + Agent Card 内容包含 id="agent:jiabaixing"
        """
        from agent.core.engine import AgentEngine

        # Mock engine.initialize — 仅初始化 A2A，跳过重型子系统避免副作用
        async def mock_initialize(self: AgentEngine) -> None:
            """模拟 initialize，仅设置 A2A 相关属性."""
            self.a2a_manager = await get_a2a_manager()
            self.a2a_remote_endpoints = []
            self.a2a_self_card = A2AAgentCard(
                id="agent:jiabaixing",
                name="Jiabaixing",
                description="家百星主 Agent — 集成测试",
                url="http://localhost:3112/a2a",
                transport=A2ATransport.HTTP,
                capabilities=[
                    A2ACapability(
                        type=A2ACapabilityType.TASK_EXECUTION,
                        name="task-execution",
                        description="执行通用任务",
                    ),
                ],
                version="1.0.0",
            )
            await self.a2a_manager.publish_agent_card(self.a2a_self_card)

        monkeypatch.setattr(AgentEngine, "initialize", mock_initialize)
        monkeypatch.setenv("OTEL_ENABLED", "false")

        from agent.main import app

        try:
            with TestClient(app) as client:
                response = client.get("/a2a/.well-known/agent.json")
                assert response.status_code == 200
                data = response.json()
                assert data["id"] == "agent:jiabaixing"
                assert data["name"] == "Jiabaixing"
                cap_types = [c["type"] for c in data["capabilities"]]
                assert "task-execution" in cap_types
        finally:
            # 清理全局 A2A 管理器单例，避免影响后续测试
            _reset_a2a_manager_for_testing()

    def test_a2a_agents_endpoint_after_startup(self, monkeypatch) -> None:
        """验证 main.py 启动后，GET /a2a/agents 返回 200 且包含本机 Agent Card."""
        from agent.core.engine import AgentEngine

        async def mock_initialize(self: AgentEngine) -> None:
            """模拟 initialize，仅设置 A2A 相关属性."""
            self.a2a_manager = await get_a2a_manager()
            self.a2a_remote_endpoints = []
            self.a2a_self_card = A2AAgentCard(
                id="agent:jiabaixing",
                name="Jiabaixing",
                url="http://localhost:3112/a2a",
                transport=A2ATransport.HTTP,
                capabilities=[
                    A2ACapability(
                        type=A2ACapabilityType.TASK_EXECUTION,
                        name="task-execution",
                    ),
                ],
                version="1.0.0",
            )
            await self.a2a_manager.publish_agent_card(self.a2a_self_card)

        monkeypatch.setattr(AgentEngine, "initialize", mock_initialize)
        monkeypatch.setenv("OTEL_ENABLED", "false")

        from agent.main import app

        try:
            with TestClient(app) as client:
                response = client.get("/a2a/agents")
                assert response.status_code == 200
                data = response.json()
                agent_ids = [a["id"] for a in data]
                assert "agent:jiabaixing" in agent_ids
        finally:
            _reset_a2a_manager_for_testing()


# ═══════════════════════════════════════════════════════════════
# 集成测试: OrchestratorAgent A2A 远程发现
# ═══════════════════════════════════════════════════════════════


class TestOrchestratorAgentA2AFallback:
    """验证 OrchestratorAgent 在本地无 Agent 时通过 A2A 发现远程 Agent.

    修复断层: 此前 OrchestratorAgent 不集成 A2A，多 Agent 协调仅限本地。
    本测试验证当本地 AgentRegistry 无可用 Agent 时，通过 A2A 协议委派给远程 Agent。
    """

    @pytest.mark.asyncio
    async def test_a2a_fallback_when_no_local_agent(self, monkeypatch) -> None:
        """本地 AgentRegistry 无可用 Agent 时，通过 A2A 委派给远程 Agent.

        测试步骤:
            1. 构造空的本地 AgentRegistry
            2. Mock A2AClient 的 HTTP 传输层，模拟远程 A2A 服务器响应
            3. 调用 _delegate_via_a2a
            4. 验证返回结果包含 "via": "a2a" 和远程执行输出
        """
        from agent.orchestration.agent_factory import (
            AgentRegistry,
            OrchestratorAgent,
        )

        # 1. 构造空的本地 AgentRegistry
        registry = AgentRegistry()

        # 2. 构造 Mock 远程 A2A 服务器响应数据
        remote_card_dict: Dict[str, Any] = {
            "id": "agent:remote-helper",
            "name": "Remote Helper",
            "description": "远程辅助 Agent",
            "url": "http://mock-remote:8765/a2a",
            "transport": "http",
            "capabilities": [
                {"type": "task-execution", "name": "task-execution"}
            ],
            "version": "1.0.0",
        }
        created_task_dict: Dict[str, Any] = {
            "id": "a2a_task_test1",
            "sessionId": "session_test",
            "description": "测试任务",
            "fromAgentId": "agent:jiabaixing",
            "toAgentId": "agent:remote-helper",
            "status": "submitted",
            "input": {},
            "createdAt": 1000,
            "updatedAt": 1000,
            "statusHistory": [],
        }
        completed_task_dict: Dict[str, Any] = {
            "id": "a2a_task_test1",
            "sessionId": "session_test",
            "description": "测试任务",
            "fromAgentId": "agent:jiabaixing",
            "toAgentId": "agent:remote-helper",
            "status": "completed",
            "input": {},
            "output": {"result": "remote computed"},
            "createdAt": 1000,
            "updatedAt": 2000,
            "statusHistory": [],
            "completedAt": 2000,
        }

        def handler(request: httpx.Request) -> httpx.Response:
            """Mock A2A 服务器请求处理器."""
            path = request.url.path
            if path == "/a2a/agents/discover":
                return httpx.Response(200, json=[remote_card_dict])
            if path == "/a2a/tasks" and request.method == "POST":
                return httpx.Response(200, json=created_task_dict)
            if path == "/a2a/tasks/a2a_task_test1":
                return httpx.Response(200, json=completed_task_dict)
            return httpx.Response(404, text="Not Found")

        mock_transport = httpx.MockTransport(handler)

        # 3. Patch A2AClient.__init__ 以注入 mock transport
        original_init = A2AClient.__init__

        def patched_init(self: A2AClient, base_url: str, *args: Any, **kwargs: Any) -> None:
            """注入 MockTransport 的 A2AClient 初始化."""
            original_init(self, base_url, *args, **kwargs)
            self._client = httpx.AsyncClient(
                transport=mock_transport, base_url=self._base_url
            )

        monkeypatch.setattr(A2AClient, "__init__", patched_init)

        # 4. 创建 OrchestratorAgent，配置远程 A2A 端点
        orchestrator = OrchestratorAgent(
            registry=registry,
            a2a_remote_endpoints=["http://mock-remote:8765"],
            a2a_poll_interval_seconds=0.05,
            a2a_task_timeout_seconds=2.0,
        )

        # 5. 触发 A2A 委派
        result = await orchestrator._delegate_via_a2a("测试任务")

        # 6. 验证结果
        assert result is not None
        assert result["via"] == "a2a"
        assert result["status"] == "completed"
        assert result["remote_agent"] == "agent:remote-helper"
        assert result["output"] == {"result": "remote computed"}

    @pytest.mark.asyncio
    async def test_a2a_fallback_returns_none_when_disabled(self) -> None:
        """A2A 未启用时（无远程端点），_delegate_via_a2a 返回 None."""
        from agent.orchestration.agent_factory import (
            AgentRegistry,
            OrchestratorAgent,
        )

        registry = AgentRegistry()
        orchestrator = OrchestratorAgent(
            registry=registry,
            a2a_remote_endpoints=[],  # 无远程端点 → A2A 未启用
        )

        result = await orchestrator._delegate_via_a2a("测试任务")
        assert result is None

    @pytest.mark.asyncio
    async def test_local_priority_over_a2a(self, monkeypatch) -> None:
        """本地有 Agent 时，优先使用本地，不走 A2A.

        验证 RegistryExecutor.execute 在本地 AgentRegistry 命中时直接返回本地结果，
        不调用 _delegate_via_a2a。保留本地优先策略。
        """
        from agent.orchestration.agent_factory import (
            AgentConfig,
            AgentRegistry,
            AgentScene,
            BaseAgent,
            OrchestratorAgent,
        )
        from agent.orchestration.fanout import TaskNode

        # 1. 构造有本地 Agent 的 registry
        registry = AgentRegistry()
        local_agent = BaseAgent(
            AgentConfig(scene=AgentScene.CODING, name="local-coder")
        )
        registry.register(
            name="local-coder", agent=local_agent, scene=AgentScene.CODING
        )

        # 2. 跟踪 _delegate_via_a2a 是否被调用
        a2a_called = False
        original_delegate = OrchestratorAgent._delegate_via_a2a

        async def tracking_delegate(self: OrchestratorAgent, goal: str) -> Any:
            """跟踪 A2A 委派是否被调用."""
            nonlocal a2a_called
            a2a_called = True
            return await original_delegate(self, goal)

        monkeypatch.setattr(
            OrchestratorAgent, "_delegate_via_a2a", tracking_delegate
        )

        # 3. 创建 OrchestratorAgent（配置了 A2A 远程端点）
        orchestrator = OrchestratorAgent(
            registry=registry,
            a2a_remote_endpoints=["http://mock-remote:8765"],
        )

        # 4. 获取 executor 并执行任务（本地 Agent 命中）
        executor = orchestrator._create_executor()
        task_node = TaskNode(
            id="t1", goal="写排序函数", assigned_to="local-coder"
        )
        result = await executor.execute(task_node)

        # 5. 验证本地 Agent 被调用，A2A 未被调用
        assert a2a_called is False
        # 本地 BaseAgent.execute 返回 {"task": ..., "agent": ..., "status": "completed"}
        assert isinstance(result, dict)
        assert result.get("agent") == "local-coder"
        assert result.get("status") == "completed"
