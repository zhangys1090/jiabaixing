"""
Phase B 端到端测试 — 从 3 个入口验证 Python 后端完整性

入口 1: CLI → Python FastAPI (/v1/chat)
入口 2: Gateway → Python FastAPI (/v1/chat + /v1/memory + /v1/skills)
入口 3: 前端 UI → TS Server → PythonAgentBridge → Python FastAPI

测试策略:
  - 使用 ASGITransport 直接测试 FastAPI（无需启动真实服务）
  - 模拟 3 个入口的完整请求路径
  - 验证 Python 后端各模块的集成正确性
"""
from __future__ import annotations

import pytest
import uuid
from httpx import ASGITransport, AsyncClient

from agent.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    # 每个测试使用独立的 x-forwarded-for，避免跨测试/跨文件共享全局令牌桶被耗尽
    # （ApiGatewayMiddleware 按 client_id 限流，默认 client_id 在整轮测试中被快速耗尽触发 429，
    #  导致本文件测试在完整 suite 中因顺序依赖而偶发失败）
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-forwarded-for": f"test-{uuid.uuid4().hex}"},
    ) as c:
        yield c


# ═══════════════════════════════════════════════════════════════
# 入口 1: CLI — REPL 直接调用 Python 后端
# 路径: CLI → HTTP POST /v1/chat → AgentEngine.process_input()
# ═══════════════════════════════════════════════════════════════

class TestEntryCLI:
    """CLI 入口端到端测试"""

    @pytest.mark.anyio
    async def test_cli_health_check(self, client: AsyncClient):
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "python_version" in data

    @pytest.mark.anyio
    async def test_cli_status(self, client: AsyncClient):
        resp = await client.get("/v1/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["backend"] == "python"

    @pytest.mark.anyio
    async def test_cli_chat_simple(self, client: AsyncClient):
        resp = await client.post(
            "/v1/chat",
            json={"message": "你好", "session_id": "cli_test"},
        )
        assert resp.status_code in (200, 502, 503)
        if resp.status_code == 200:
            data = resp.json()
            assert "content" in data
            assert "session_id" in data
            assert "trace_id" in data

    @pytest.mark.anyio
    async def test_cli_chat_with_loop(self, client: AsyncClient):
        resp = await client.post(
            "/v1/chat",
            json={
                "message": "分析这段代码",
                "session_id": "cli_loop_test",
                "context_files": ["use_loop"],
            },
        )
        assert resp.status_code in (200, 502, 503)

    @pytest.mark.anyio
    async def test_cli_memory_search(self, client: AsyncClient):
        resp = await client.get(
            "/v1/memory/search",
            params={"query": "测试查询", "limit": 5},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "results" in data
        assert "total" in data

    @pytest.mark.anyio
    async def test_cli_memory_store_and_retrieve(self, client: AsyncClient):
        store_resp = await client.post(
            "/v1/memory/store",
            json={
                "content": "Phase B 端到端测试记忆",
                "memory_type": "short_term",
                "scene": "test",
            },
        )
        assert store_resp.status_code == 200
        data = store_resp.json()
        assert "success" in data

        search_resp = await client.get(
            "/v1/memory/search",
            params={"query": "Phase B", "limit": 5},
        )
        assert search_resp.status_code == 200

    @pytest.mark.anyio
    async def test_cli_memory_stats(self, client: AsyncClient):
        resp = await client.get("/v1/memory/stats")
        assert resp.status_code == 200

    @pytest.mark.anyio
    async def test_cli_skills_list(self, client: AsyncClient):
        resp = await client.get("/v1/skills")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) > 0

    @pytest.mark.anyio
    async def test_cli_evolution_feedback(self, client: AsyncClient):
        resp = await client.post(
            "/v1/evolution/feedback",
            json={
                "interaction_id": "cli_e2e_test",
                "quality_score": 0.9,
                "cause": "chat",
            },
        )
        assert resp.status_code == 200

    @pytest.mark.anyio
    async def test_cli_session_lifecycle(self, client: AsyncClient):
        create_resp = await client.post(
            "/v1/sessions",
            json={"title": "CLI 端到端测试会话"},
        )
        assert create_resp.status_code == 200
        session_id = create_resp.json()["session_id"]

        add_resp = await client.post(
            f"/v1/sessions/{session_id}/messages",
            json={"role": "user", "content": "测试消息"},
        )
        assert add_resp.status_code == 200
        assert add_resp.json()["success"] is True

        get_resp = await client.get(f"/v1/sessions/{session_id}/messages")
        assert get_resp.status_code == 200
        msgs = get_resp.json()
        assert len(msgs) >= 1

        delete_resp = await client.delete(f"/v1/sessions/{session_id}")
        assert delete_resp.status_code == 200


# ═══════════════════════════════════════════════════════════════
# 入口 2: Gateway — TS IntegrationManager 转发到 Python
# 路径: 微信/飞书/钉钉 → TS Gateway → PythonAgentBridge → /v1/chat
# ═══════════════════════════════════════════════════════════════

class TestEntryGateway:
    """Gateway 入口端到端测试 — 模拟 TS 侧 PythonAgentBridge 的请求"""

    @pytest.mark.anyio
    async def test_gateway_chat_forward(self, client: AsyncClient):
        resp = await client.post(
            "/v1/chat",
            json={
                "message": "来自微信用户的消息",
                "session_id": "wechat_user_123",
            },
        )
        assert resp.status_code in (200, 502, 503)
        if resp.status_code == 200:
            data = resp.json()
            assert "content" in data
            assert data["session_id"] == "wechat_user_123"

    @pytest.mark.anyio
    async def test_gateway_multi_session(self, client: AsyncClient):
        sessions = ["wechat_1", "feishu_2", "dingtalk_3"]
        for sid in sessions:
            resp = await client.post(
                "/v1/chat",
                json={"message": f"来自 {sid} 的消息", "session_id": sid},
            )
            assert resp.status_code in (200, 502, 503)

    @pytest.mark.anyio
    async def test_gateway_memory_cross_session(self, client: AsyncClient):
        store_resp = await client.post(
            "/v1/memory/store",
            json={
                "content": "用户偏好：喜欢简洁回答",
                "memory_type": "long_term",
                "scene": "preference",
            },
        )
        assert store_resp.status_code == 200

        search_resp = await client.get(
            "/v1/memory/search",
            params={"query": "用户偏好", "limit": 5},
        )
        assert search_resp.status_code == 200

    @pytest.mark.anyio
    async def test_gateway_skill_execution(self, client: AsyncClient):
        list_resp = await client.get("/v1/skills")
        assert list_resp.status_code == 200
        skills = list_resp.json()
        if skills:
            exec_resp = await client.post(
                "/v1/skills/execute",
                json={"name": skills[0]["name"], "parameters": {}},
            )
            assert exec_resp.status_code == 200

    @pytest.mark.anyio
    async def test_gateway_health_for_bridge(self, client: AsyncClient):
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"

    @pytest.mark.anyio
    async def test_gateway_llm_provider_management(self, client: AsyncClient):
        resp = await client.get("/v1/llm/providers")
        assert resp.status_code == 200
        providers = resp.json()
        assert isinstance(providers, list)

    @pytest.mark.anyio
    async def test_gateway_cost_monitoring(self, client: AsyncClient):
        resp = await client.get("/v1/llm/providers/cost/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert "total_cost_usd" in data
        assert "daily_budget_usd" in data

    @pytest.mark.anyio
    async def test_gateway_cron_scheduling(self, client: AsyncClient):
        resp = await client.get("/v1/cron/jobs")
        assert resp.status_code == 200

        create_resp = await client.post(
            "/v1/cron/jobs",
            json={
                "name": "网关定时任务",
                "schedule": "every:10m",
                "command": "echo gateway_test",
            },
        )
        assert create_resp.status_code == 200
        assert create_resp.json()["success"] is True


# ═══════════════════════════════════════════════════════════════
# 入口 3: 前端 UI — React → TS Server → PythonAgentBridge → Python
# 路径: 浏览器 → TS /api/ide/chat → PythonAgentBridge → /v1/chat
# ═══════════════════════════════════════════════════════════════

class TestEntryFrontendUI:
    """前端 UI 入口端到端测试 — 模拟 TS 侧 ACP 路由的请求"""

    @pytest.mark.anyio
    async def test_ui_chat_via_bridge(self, client: AsyncClient):
        resp = await client.post(
            "/v1/chat",
            json={
                "message": "IDE 中用户的问题",
                "session_id": "ide_session_001",
            },
        )
        assert resp.status_code in (200, 502, 503)
        if resp.status_code == 200:
            data = resp.json()
            assert "content" in data
            assert "trace_id" in data

    @pytest.mark.anyio
    async def test_ui_session_management(self, client: AsyncClient):
        create_resp = await client.post(
            "/v1/sessions",
            json={"title": "IDE 工作会话", "user_id": "ide_user"},
        )
        assert create_resp.status_code == 200
        session_id = create_resp.json()["session_id"]

        list_resp = await client.get("/v1/sessions")
        assert list_resp.status_code == 200
        sessions = list_resp.json()
        assert isinstance(sessions, list)

        detail_resp = await client.get(f"/v1/sessions/{session_id}")
        assert detail_resp.status_code == 200

    @pytest.mark.anyio
    async def test_ui_memory_panel(self, client: AsyncClient):
        stats_resp = await client.get("/v1/memory/stats")
        assert stats_resp.status_code == 200

        search_resp = await client.get(
            "/v1/memory/search",
            params={"query": "IDE 上下文", "limit": 10},
        )
        assert search_resp.status_code == 200

    @pytest.mark.anyio
    async def test_ui_skill_panel(self, client: AsyncClient):
        resp = await client.get("/v1/skills")
        assert resp.status_code == 200
        skills = resp.json()
        assert isinstance(skills, list)
        for skill in skills:
            assert "name" in skill
            assert "description" in skill
            assert "category" in skill

    @pytest.mark.anyio
    async def test_ui_evolution_panel(self, client: AsyncClient):
        status_resp = await client.get("/v1/evolution/status")
        assert status_resp.status_code == 200

        feedback_resp = await client.post(
            "/v1/evolution/feedback",
            json={
                "interaction_id": "ui_e2e_test",
                "quality_score": 0.75,
                "cause": "ide_chat",
            },
        )
        assert feedback_resp.status_code == 200

    @pytest.mark.anyio
    async def test_ui_llm_provider_panel(self, client: AsyncClient):
        providers_resp = await client.get("/v1/llm/providers")
        assert providers_resp.status_code == 200

        cache_resp = await client.get("/v1/llm/providers/cache/stats")
        assert cache_resp.status_code == 200

        cost_resp = await client.get("/v1/llm/providers/cost/stats")
        assert cost_resp.status_code == 200

    @pytest.mark.anyio
    async def test_ui_credential_pool(self, client: AsyncClient):
        resp = await client.get("/v1/llm/providers/credentials/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert "total" in data
        assert "available" in data


# ═══════════════════════════════════════════════════════════════
# 跨入口集成验证 — 确保多入口并发使用不冲突
# ═══════════════════════════════════════════════════════════════

class TestCrossEntryIntegration:
    """跨入口集成测试 — 验证多入口并发使用时的数据一致性"""

    @pytest.mark.anyio
    async def test_shared_memory_across_entries(self, client: AsyncClient):
        await client.post(
            "/v1/memory/store",
            json={
                "content": "跨入口共享记忆",
                "memory_type": "long_term",
                "scene": "cross_entry",
            },
        )

        search_resp = await client.get(
            "/v1/memory/search",
            params={"query": "跨入口", "limit": 10},
        )
        assert search_resp.status_code == 200
        assert search_resp.json()["total"] >= 0

    @pytest.mark.anyio
    async def test_session_isolation(self, client: AsyncClient):
        cli_session = await client.post(
            "/v1/sessions",
            json={"title": "CLI 专属会话"},
        )
        gw_session = await client.post(
            "/v1/sessions",
            json={"title": "Gateway 专属会话"},
        )
        ui_session = await client.post(
            "/v1/sessions",
            json={"title": "UI 专属会话"},
        )

        cli_id = cli_session.json()["session_id"]
        gw_id = gw_session.json()["session_id"]
        ui_id = ui_session.json()["session_id"]

        assert cli_id != gw_id
        assert gw_id != ui_id
        assert cli_id != ui_id

        await client.post(
            f"/v1/sessions/{cli_id}/messages",
            json={"role": "user", "content": "CLI 消息"},
        )
        await client.post(
            f"/v1/sessions/{gw_id}/messages",
            json={"role": "user", "content": "Gateway 消息"},
        )
        await client.post(
            f"/v1/sessions/{ui_id}/messages",
            json={"role": "user", "content": "UI 消息"},
        )

        cli_msgs = (await client.get(f"/v1/sessions/{cli_id}/messages")).json()
        gw_msgs = (await client.get(f"/v1/sessions/{gw_id}/messages")).json()
        ui_msgs = (await client.get(f"/v1/sessions/{ui_id}/messages")).json()

        cli_contents = [m["content"] for m in cli_msgs]
        gw_contents = [m["content"] for m in gw_msgs]
        ui_contents = [m["content"] for m in ui_msgs]

        assert "CLI 消息" in cli_contents
        assert "Gateway 消息" not in cli_contents
        assert "Gateway 消息" in gw_contents
        assert "UI 消息" in ui_contents

    @pytest.mark.anyio
    async def test_evolution_collects_from_all_entries(self, client: AsyncClient):
        for entry in ["cli", "gateway", "ui"]:
            resp = await client.post(
                "/v1/evolution/feedback",
                json={
                    "interaction_id": f"cross_{entry}_001",
                    "quality_score": 0.8,
                    "cause": f"{entry}_chat",
                },
            )
            assert resp.status_code == 200

        status_resp = await client.get("/v1/evolution/status")
        assert status_resp.status_code == 200

    @pytest.mark.anyio
    async def test_full_pipeline_all_entries(self, client: AsyncClient):
        health = await client.get("/health")
        assert health.status_code == 200

        for idx, (entry_name, session_id) in enumerate([
            ("cli", "pipeline_cli"),
            ("gateway", "pipeline_gw"),
            ("ui", "pipeline_ui"),
        ]):
            # 每个入口使用独立的 x-forwarded-for，避免与文件内其他测试共享
            # 全局令牌桶（同一 client_id 会被耗尽触发 429，属测试隔离问题）
            headers = {"x-forwarded-for": f"10.0.0.{idx + 1}"}

            chat_resp = await client.post(
                "/v1/chat",
                json={
                    "message": f"Pipeline test from {entry_name}",
                    "session_id": session_id,
                },
                headers=headers,
            )
            # chat 可能 502/503（取决于 LLM 后端可用性），但端点应可用（非 500）
            assert chat_resp.status_code in (200, 502, 503)

            mem_resp = await client.get("/v1/memory/stats", headers=headers)
            assert mem_resp.status_code == 200

            skill_resp = await client.get("/v1/skills", headers=headers)
            assert skill_resp.status_code == 200

            evo_resp = await client.post(
                "/v1/evolution/feedback",
                json={
                    "interaction_id": f"pipeline_{entry_name}",
                    "quality_score": 0.85,
                    "cause": "pipeline_test",
                },
                headers=headers,
            )
            assert evo_resp.status_code == 200
