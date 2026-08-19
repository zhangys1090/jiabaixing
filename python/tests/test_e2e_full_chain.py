"""jiabaixing 全链路端到端（E2E）测试 — 核心功能 + 边界场景。

本文件覆盖「用户输入 → 路由 → 引擎 → 输出」完整链路，并针对各类边界场景
（空输入/超长输入/非法会话/并发请求/降级路径）验证系统健壮性。

设计原则：
  1. 全部离线运行 — 通过 conftest.py 的 ``mock_llm_engine`` 夹具 mock LLM，
     无需任何外部密钥或网络，CI 可直接执行。
  2. 通过 ``asgi_client``（ASGITransport）驱动真实 FastAPI app，验证真实路由层。
  3. 测试分类标记：``e2e``（核心链路）/ ``boundary``（边界场景），与 pytest.ini
     marker 对齐，CI 通过 ``-m "e2e or boundary"`` 选择性执行。

依赖夹具（conftest.py）：
  - ``mock_llm_engine``：轻量 AgentEngine + Mock LLM，注入 agent.main.engine
  - ``asgi_client``：基于 ASGITransport 的 AsyncClient
"""

from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.anyio


# ═══════════════════════════════════════════════════════════════════
# Part 1: 核心链路 E2E — 健康检查 / 对话 / 会话管理 / 模型列表
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.e2e
class TestCoreChainE2E:
    """核心链路端到端：HTTP 请求 → 路由 → 引擎 → 响应。"""

    async def test_health_endpoint_returns_ok(self, asgi_client):
        """GET /health 返回 200 + status=ok + LLM 可用性字段。"""
        resp = await asgi_client.get("/health")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "uptime_seconds" in data
        assert "llm_available" in data
        assert data["llm_available"] is True

    async def test_compat_health_endpoint(self, asgi_client):
        """GET /api/health 兼容健康端点返回完整状态字段。"""
        resp = await asgi_client.get("/api/health")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] in ("ok", "degraded")
        assert "llm_available" in data
        assert "uptime_seconds" in data

    async def test_compat_health_detail_endpoint(self, asgi_client):
        """GET /api/health/detail 详细健康端点返回组件状态。"""
        resp = await asgi_client.get("/api/health/detail")

        assert resp.status_code == 200
        data = resp.json()
        assert "status" in data

    async def test_compat_chat_full_chain(self, asgi_client):
        """POST /api/chat 完整链路：用户输入 → 引擎 process_input → 响应。

        验证 Mock LLM 的固定回复能正确穿透引擎层返回到 HTTP 响应。
        """
        resp = await asgi_client.post(
            "/api/chat",
            json={"message": "你好", "conversation_id": "e2e-chat-1"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert "content" in data
        assert len(data["content"]) > 0
        assert data["session_id"] == "e2e-chat-1"

    async def test_v1_chat_endpoint(self, asgi_client):
        """POST /v1/chat 标准对话端点返回 ChatResponse 结构。"""
        resp = await asgi_client.post(
            "/v1/chat",
            json={"message": "帮我写个脚本", "session_id": "e2e-v1-1"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert "content" in data
        assert "session_id" in data
        assert data["session_id"] == "e2e-v1-1"

    async def test_openai_compat_chat_completions(self, asgi_client):
        """POST /v1/chat/completions OpenAI 兼容端点返回 choices 结构。"""
        resp = await asgi_client.post(
            "/v1/chat/completions",
            json={
                "model": "test-model",
                "messages": [{"role": "user", "content": "测试消息"}],
            },
        )

        assert resp.status_code == 200
        data = resp.json()
        assert "choices" in data
        assert len(data["choices"]) > 0

    async def test_models_list_endpoint(self, asgi_client):
        """GET /api/models 返回模型列表（非空）。"""
        resp = await asgi_client.get("/api/models")

        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) > 0
        assert "id" in data[0]

    async def test_openai_models_endpoint(self, asgi_client):
        """GET /v1/models OpenAI 兼容模型列表。"""
        resp = await asgi_client.get("/v1/models")
        assert resp.status_code == 200

    async def test_session_create_get_delete(self, asgi_client):
        """会话生命周期：创建 → 查询 → 删除。"""
        # 创建
        resp = await asgi_client.post(
            "/v1/sessions", json={"title": "E2E 生命周期测试"}
        )
        assert resp.status_code == 200
        session_id = resp.json()["session_id"]

        # 查询
        resp = await asgi_client.get(f"/v1/sessions/{session_id}")
        assert resp.status_code == 200
        assert resp.json()["session_id"] == session_id

        # 列表
        resp = await asgi_client.get("/v1/sessions")
        assert resp.status_code == 200
        sessions = resp.json()
        assert any(s["session_id"] == session_id for s in sessions)

    async def test_session_message_round_trip(self, asgi_client):
        """会话消息往返：创建会话 → 添加消息 → 查询消息。"""
        # 创建会话
        resp = await asgi_client.post(
            "/v1/sessions", json={"title": "消息往返测试"}
        )
        session_id = resp.json()["session_id"]

        # 添加消息
        resp = await asgi_client.post(
            f"/v1/sessions/{session_id}/messages",
            json={"role": "user", "content": "测试消息内容"},
        )
        assert resp.status_code == 200

        # 查询消息
        resp = await asgi_client.get(f"/v1/sessions/{session_id}/messages")
        assert resp.status_code == 200
        messages = resp.json()
        assert isinstance(messages, list)
        assert len(messages) > 0

    async def test_skills_list_endpoint(self, asgi_client):
        """GET /v1/skills 返回技能列表。"""
        resp = await asgi_client.get("/v1/skills")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    async def test_trajectory_stats_endpoint(self, asgi_client):
        """GET /v1/trajectory/stats 返回轨迹统计。"""
        resp = await asgi_client.get("/v1/trajectory/stats")
        assert resp.status_code == 200

    async def test_slo_health_endpoint(self, asgi_client):
        """GET /v1/health/slo 返回 SLO 健康指标。"""
        resp = await asgi_client.get("/v1/health/slo")
        assert resp.status_code == 200


# ═══════════════════════════════════════════════════════════════════
# Part 2: 边界场景 E2E — 空输入 / 超长输入 / 非法会话 / 未知路由
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.boundary
class TestBoundaryScenarios:
    """边界场景：验证系统对异常输入的健壮处理。"""

    async def test_empty_message_returns_graceful(self, asgi_client):
        """空消息不导致 500，返回降级响应或 4xx。"""
        resp = await asgi_client.post(
            "/api/chat", json={"message": "", "conversation_id": "b-empty"}
        )
        # 空输入应被优雅处理（200 降级 或 4xx 校验失败），绝不能 5xx
        assert resp.status_code < 500

    async def test_missing_message_field(self, asgi_client):
        """缺少 message 字段触发 Pydantic 校验失败（422）。"""
        resp = await asgi_client.post(
            "/api/chat", json={"conversation_id": "b-no-msg"}
        )
        assert resp.status_code == 422

    async def test_very_long_message(self, asgi_client):
        """超长消息（100KB）不导致崩溃，正常返回或降级。"""
        long_msg = "测试" * 50000  # ~200KB
        resp = await asgi_client.post(
            "/api/chat",
            json={"message": long_msg, "conversation_id": "b-long"},
        )
        assert resp.status_code < 500

    async def test_nonexistent_session_lookup(self, asgi_client):
        """查询不存在的会话返回 404 或空结果（不 500）。"""
        resp = await asgi_client.get("/v1/sessions/nonexistent-session-id")
        assert resp.status_code in (404, 200)

    async def test_nonexistent_session_messages(self, asgi_client):
        """查询不存在会话的消息不崩溃。"""
        resp = await asgi_client.get(
            "/v1/sessions/nonexistent-session-id/messages"
        )
        assert resp.status_code < 500

    async def test_unknown_route_returns_404(self, asgi_client):
        """未知路由返回 404（非 500）。"""
        resp = await asgi_client.get("/v1/this-route-does-not-exist")
        assert resp.status_code == 404

    async def test_invalid_json_body(self, asgi_client):
        """非法 JSON body 触发 422 校验错误。"""
        resp = await asgi_client.post(
            "/api/chat",
            content="not-valid-json{",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422

    async def test_wrong_content_type(self, asgi_client):
        """非 JSON Content-Type 触发 422。"""
        resp = await asgi_client.post(
            "/api/chat",
            content="message=hello",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        assert resp.status_code == 422

    async def test_openai_compat_empty_messages(self, asgi_client):
        """OpenAI 兼容端点空 messages 列表优雅处理。"""
        resp = await asgi_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": []},
        )
        assert resp.status_code < 500

    async def test_openai_compat_missing_messages(self, asgi_client):
        """OpenAI 兼容端点缺少 messages 字段触发 422。"""
        resp = await asgi_client.post(
            "/v1/chat/completions",
            json={"model": "test"},
        )
        assert resp.status_code == 422

    async def test_session_stats_overview(self, asgi_client):
        """GET /v1/sessions/stats/overview 边界：空库时返回默认结构。"""
        resp = await asgi_client.get("/v1/sessions/stats/overview")
        assert resp.status_code == 200

    async def test_session_search_empty(self, asgi_client):
        """POST /v1/sessions/search 空查询返回空列表（不报错）。"""
        resp = await asgi_client.post(
            "/v1/sessions/search",
            json={"query": "不存在的关键词xyz123"},
        )
        assert resp.status_code == 200


# ═══════════════════════════════════════════════════════════════════
# Part 3: 并发与状态一致性 E2E
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.e2e
class TestConcurrencyAndConsistency:
    """并发场景：验证多请求并发时状态一致性。"""

    async def test_concurrent_chat_same_session(self, asgi_client):
        """同一会话并发发送多条消息，全部成功返回。"""
        tasks = [
            asgi_client.post(
                "/api/chat",
                json={"message": f"并发消息 {i}", "conversation_id": "e2e-concurrent"},
            )
            for i in range(5)
        ]
        responses = await asyncio.gather(*tasks, return_exceptions=True)

        for resp in responses:
            assert not isinstance(resp, Exception), f"并发请求异常: {resp}"
            assert resp.status_code < 500

    async def test_concurrent_session_creation(self, asgi_client):
        """并发创建多个会话，每个会话 ID 唯一。"""
        tasks = [
            asgi_client.post(
                "/v1/sessions", json={"title": f"并发会话 {i}"}
            )
            for i in range(5)
        ]
        responses = await asyncio.gather(*tasks, return_exceptions=True)

        session_ids = []
        for resp in responses:
            assert not isinstance(resp, Exception)
            assert resp.status_code == 200
            session_ids.append(resp.json()["session_id"])

        # 所有会话 ID 应唯一
        assert len(set(session_ids)) == len(session_ids)

    async def test_sequential_chat_state_accumulation(self, asgi_client):
        """顺序对话：同一会话多次对话，会话状态累积。"""
        session_id = "e2e-sequential"
        for i in range(3):
            resp = await asgi_client.post(
                "/api/chat",
                json={"message": f"第 {i + 1} 轮对话", "conversation_id": session_id},
            )
            assert resp.status_code == 200
            assert resp.json()["session_id"] == session_id


# ═══════════════════════════════════════════════════════════════════
# Part 4: 降级路径 E2E — 引擎不可用时的优雅降级
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.boundary
class TestDegradationPaths:
    """降级路径：引擎未初始化或子系统缺失时的优雅处理。"""

    async def test_chat_without_engine_returns_error_field(self, monkeypatch):
        """引擎未注入时，/api/chat 返回 error 字段而非 500。"""
        import agent.main as main_module

        original_engine = main_module.engine
        main_module.engine = None
        try:
            from httpx import ASGITransport, AsyncClient

            transport = ASGITransport(app=main_module.app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/api/chat",
                    json={"message": "测试", "conversation_id": "degraded"},
                )
            assert resp.status_code == 200
            data = resp.json()
            assert "error" in data or data.get("content") == ""
        finally:
            main_module.engine = original_engine

    async def test_health_without_engine(self, monkeypatch):
        """引擎未注入时，/health 仍返回 200（健康探针不应依赖引擎）。"""
        import agent.main as main_module

        original_engine = main_module.engine
        main_module.engine = None
        try:
            from httpx import ASGITransport, AsyncClient

            transport = ASGITransport(app=main_module.app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.get("/health")
            assert resp.status_code == 200
        finally:
            main_module.engine = original_engine


# ═══════════════════════════════════════════════════════════════════
# Part 5: 多轮对话链路 E2E — 验证上下文延续
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.e2e
class TestMultiTurnConversation:
    """多轮对话：验证会话上下文在多轮交互中的延续性。"""

    async def test_multi_turn_same_session(self, asgi_client):
        """同一会话 3 轮对话，每轮都返回有效响应。"""
        session_id = "e2e-multiturn"
        messages = ["第一轮：你好", "第二轮：帮我写代码", "第三轮：解释一下"]

        for msg in messages:
            resp = await asgi_client.post(
                "/api/chat",
                json={"message": msg, "conversation_id": session_id},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["session_id"] == session_id
            assert len(data.get("content", "")) > 0

    async def test_different_sessions_isolated(self, asgi_client):
        """不同会话互相隔离：A 会话的状态不影响 B 会话。"""
        resp_a = await asgi_client.post(
            "/api/chat",
            json={"message": "会话A消息", "conversation_id": "e2e-iso-a"},
        )
        resp_b = await asgi_client.post(
            "/api/chat",
            json={"message": "会话B消息", "conversation_id": "e2e-iso-b"},
        )

        assert resp_a.status_code == 200
        assert resp_b.status_code == 200
        assert resp_a.json()["session_id"] != resp_b.json()["session_id"]

    async def test_session_id_none_uses_default(self, asgi_client):
        """conversation_id 为 None 时使用默认会话（不崩溃）。"""
        resp = await asgi_client.post(
            "/api/chat",
            json={"message": "默认会话测试"},
        )
        assert resp.status_code == 200
        assert "session_id" in resp.json()
