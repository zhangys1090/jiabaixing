"""jiabaixing 能力链路端到端（E2E）测试 — 核心外部契约验证。

覆盖「用户输入 → 路由 → 引擎 → 输出」完整链路的关键能力契约：
- 健康检查 / 服务状态（可观测性入口）
- 会话生命周期（创建 → 查询 → 写消息 → 读消息 → 持久化）
- 核心对话（HTTP 到 engine.process_input 再到 Mock LLM 返回）
- 工具注册表可见性（引擎挂载的子系统可被 API 访问）
- MCP / A2A 协议路由（多 Agent 协作入口）
- SLO 健康检查（真实商用闭环可核查证据）
- 引擎能力接线（loop/memory/evolution/orchestrator 等核心子系统齐备）

所有用例离线可跑（依赖 conftest.mock_llm_engine 的 Mock LLM），
不依赖任何外部 LLM API 密钥。标记：pytest.mark.e2e
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.e2e


# ─────────────────────────────────────────────────────────────
# 1. 健康检查链
# ─────────────────────────────────────────────────────────────


async def test_health_check_chain(asgi_client):
    """GET /health → 200 + status=ok + 服务状态字段。"""
    resp = await asgi_client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "uptime_seconds" in data
    assert "llm_available" in data
    assert "llm_model" in data
    # mock 后 LLM 应可用
    assert data["llm_available"] is True


async def test_status_chain(asgi_client):
    """GET /v1/status → 200 + 暴露 llm_model / 会话 / 工具计数。"""
    resp = await asgi_client.get("/v1/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "llm_model" in data
    assert "memory_entries" in data
    assert "active_sessions" in data
    assert "skills_count" in data
    # 工具注册表已挂载，能力计数 > 0
    assert data["skills_count"] > 0


# ─────────────────────────────────────────────────────────────
# 2. 会话管理链（持久化）
# ─────────────────────────────────────────────────────────────


async def test_session_lifecycle_chain(asgi_client):
    """POST /v1/sessions → GET → POST messages → GET messages 完整持久化链路。"""
    resp = await asgi_client.post("/v1/sessions", json={"title": "E2E 能力会话"})
    assert resp.status_code == 200
    session_id = resp.json()["session_id"]
    assert resp.json()["title"] == "E2E 能力会话"

    resp = await asgi_client.get(f"/v1/sessions/{session_id}")
    assert resp.status_code == 200
    assert resp.json()["session_id"] == session_id

    resp = await asgi_client.post(
        f"/v1/sessions/{session_id}/messages",
        json={"role": "user", "content": "家百星，你好"},
    )
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    resp = await asgi_client.get(f"/v1/sessions/{session_id}/messages")
    assert resp.status_code == 200
    messages = resp.json()
    assert len(messages) >= 1
    assert messages[0]["content"] == "家百星，你好"
    assert messages[0]["role"] == "user"


# ─────────────────────────────────────────────────────────────
# 3. 核心对话链（用户输入 → 输出）
# ─────────────────────────────────────────────────────────────


async def test_core_chat_chain(asgi_client):
    """POST /v1/chat → engine.process_input → Mock LLM → ChatResponse。"""
    resp = await asgi_client.post(
        "/v1/chat",
        json={"message": "你好", "session_id": "e2e-capability-chat"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "content" in data
    assert isinstance(data["content"], str) and len(data["content"]) > 0
    assert data["session_id"] == "e2e-capability-chat"
    assert "trace_id" in data
    # Mock LLM 固定响应包含「家百星」
    assert "家百星" in data["content"]


# ─────────────────────────────────────────────────────────────
# 4. 工具注册表可见性（子系统接线）
# ─────────────────────────────────────────────────────────────


async def test_tool_registry_visible_chain(asgi_client):
    """GET /v1/metrics → tool_metrics.total_tools > 0，证明工具注册表已挂载。"""
    resp = await asgi_client.get("/v1/metrics")
    assert resp.status_code == 200
    data = resp.json()
    assert "tool_metrics" in data
    assert data["tool_metrics"]["total_tools"] > 0


async def test_tool_direct_invocation_chain(mock_llm_engine):
    """engine.tool_registry.execute("file_list") → ToolResult（Action 能力）。"""
    eng = mock_llm_engine
    assert eng.tool_registry is not None and eng.tool_registry.size() > 0
    result = await eng.tool_registry.execute("file_list", {"dir_path": "."})
    assert result is not None
    assert result.success is True
    assert result.output is not None


# ─────────────────────────────────────────────────────────────
# 5. MCP / A2A 协议路由链（多 Agent 协作）
# ─────────────────────────────────────────────────────────────


async def test_mcp_servers_chain(asgi_client):
    """GET /v1/mcp/servers → 200 + {servers, total} 结构。"""
    resp = await asgi_client.get("/v1/mcp/servers")
    assert resp.status_code == 200
    data = resp.json()
    assert "servers" in data and "total" in data
    assert isinstance(data["servers"], list)
    assert data["total"] == len(data["servers"])


async def test_a2a_agent_card_chain(asgi_client):
    """GET /a2a/.well-known/agent.json → 200 + AgentCard（含 task-execution 能力）。"""
    resp = await asgi_client.get("/a2a/.well-known/agent.json")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == "agent:jiabaixing"
    assert data["name"] == "Jiabaixing"
    cap_types = [c["type"] for c in data["capabilities"]]
    assert "task-execution" in cap_types


async def test_a2a_agents_list_chain(asgi_client):
    """GET /a2a/agents → 200 + Agent Card 列表。"""
    resp = await asgi_client.get("/a2a/agents")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ─────────────────────────────────────────────────────────────
# 6. SLO 健康检查链（真实商用闭环证据）
# ─────────────────────────────────────────────────────────────


async def test_slo_health_chain(asgi_client):
    """GET /v1/health/slo → 200 + 含 status 字段（成功/违约快照）。"""
    resp = await asgi_client.get("/v1/health/slo")
    assert resp.status_code == 200
    data = resp.json()
    # 快照至少包含整体状态与成功率指标
    assert "status" in data
    assert data["status"] in ("ok", "breach", "unknown")


# ─────────────────────────────────────────────────────────────
# 7. 多模态记忆链（memory 子系统存在时）
# ─────────────────────────────────────────────────────────────


async def test_multimodal_store_chain(mock_llm_engine, asgi_client):
    """POST /v1/memory/multimodal/store → 当 memory 子系统存在时返回 mem_id。"""

    class _MockMemory:
        async def store_multimodal(self, **kwargs) -> str:
            return "mem_e2e_capability_001"

        async def get_stats(self) -> dict:
            return {"multimodal_model": "fallback"}

    mock_llm_engine.memory = _MockMemory()
    resp = await asgi_client.post(
        "/v1/memory/multimodal/store",
        json={"content": "E2E 多模态记忆内容", "memory_type": "long_term"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["id"] == "mem_e2e_capability_001"


# ─────────────────────────────────────────────────────────────
# 8. 引擎能力接线（各项核心能力齐备）
# ─────────────────────────────────────────────────────────────


def test_engine_capability_wiring(mock_llm_engine):
    """引擎必须暴露全部核心能力子系统（loop/memory/evolution/orchestrator 等）。

    这是「各项能力」的接线断言：任何核心子系统缺失都意味着对应能力未接入主引擎，
    应在此 E2E 红线上暴露，而非等到生产才发现。
    """
    eng = mock_llm_engine
    required_subsystems = [
        "llm",
        "tool_registry",
        "session_store",
        "loop",
        "memory",
        "evolution",
        "conversation",
        "persistence",
        "trajectory_db",
        "orchestrator",
        "security",
        "approval_manager",
    ]
    for attr in required_subsystems:
        assert hasattr(eng, attr), f"引擎缺失核心能力子系统: {attr}"

    # 真实挂载的子系统必须可用
    assert eng.tool_registry is not None
    assert eng.tool_registry.size() > 0
    assert eng.session_store is not None
