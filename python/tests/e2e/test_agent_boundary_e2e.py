"""jiabaixing 边界（boundary）端到端测试 — 异常/极端路径的链路健壮性验证。

验证「用户输入 → 输出」链路在以下边界场景下不崩溃（不返回 500），
并按预期优雅降级或返回规范错误码：

- 引擎未初始化（503 / 健康检查仍可对外）
- 空消息 / 超大消息（不 500）
- 非法 JSON 请求体（422）
- 未知路径（404）
- 多模态空内容（400）
- 子系统缺失（trajectory 无 DB 时优雅降级，不 500）

所有用例离线可跑，依赖 conftest.mock_llm_engine 或显式将 engine 置空。
标记：pytest.mark.e2e + pytest.mark.boundary
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

pytestmark = [pytest.mark.e2e, pytest.mark.boundary]


def _client_with_engine_state(engine_value):
    """构建 ASGITransport 客户端，并将 agent.main.engine 设为指定值。"""
    import agent.main as main_module

    main_module.engine = engine_value
    from agent.main import app

    transport = ASGITransport(app=app)
    return transport


async def test_engine_not_initialized_chat_returns_503(monkeypatch):
    """引擎未初始化时，/v1/chat 必须返回 503 而非 500 或 200。"""
    import agent.main as main_module

    monkeypatch.setattr(main_module, "engine", None)
    transport = _client_with_engine_state(None)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/v1/chat", json={"message": "你好", "session_id": "x"}
        )
    assert resp.status_code == 503
    assert "not initialized" in resp.json()["detail"].lower()


async def test_health_without_engine_still_200(monkeypatch):
    """引擎未初始化时，/health 仍应 200 且 llm_available=False（优雅对外）。"""
    import agent.main as main_module

    monkeypatch.setattr(main_module, "engine", None)
    transport = _client_with_engine_state(None)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["llm_available"] is False


async def test_chat_empty_message_not_500(asgi_client):
    """空消息不应导致 500（接受 200 正常响应或 400 校验拒绝，但绝不崩溃）。"""
    resp = await asgi_client.post(
        "/v1/chat", json={"message": "", "session_id": "empty"}
    )
    assert resp.status_code != 500
    assert resp.status_code in (200, 400)


async def test_chat_oversized_message_not_500(asgi_client):
    """超大消息（100k 字符）不应导致 500。"""
    big = "请帮我处理这条非常长的指令。" * 4000  # ~120k 字符
    resp = await asgi_client.post(
        "/v1/chat", json={"message": big, "session_id": "oversized"}
    )
    assert resp.status_code != 500


async def test_invalid_json_body_returns_422(asgi_client):
    """非法 JSON 请求体必须返回 422（FastAPI 请求校验）。"""
    resp = await asgi_client.post(
        "/v1/chat",
        content="{not valid json",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 422


async def test_unknown_path_returns_404(asgi_client):
    """未知路径必须返回 404。"""
    resp = await asgi_client.get("/this/route/does/not/exist")
    assert resp.status_code == 404


async def test_multimodal_empty_content_returns_400(mock_llm_engine, asgi_client):
    """多模态空内容应被校验拒绝（400），且错误信息指明 content 字段。"""
    import agent.main as main_module
    from agent.main import app

    class _MockMemory:
        async def store_multimodal(self, **kwargs):
            return "should_not_reach"

        async def get_stats(self):
            return {}

    main_module.engine.memory = _MockMemory()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/v1/memory/multimodal/store", json={"content": ""}
        )
    assert resp.status_code == 400
    assert "content" in resp.json()["detail"].lower()


async def test_trajectory_missing_subsystem_not_500(asgi_client):
    """trajectory_db 缺失时 /v1/trajectory/stats 必须优雅降级（非 500）。"""
    resp = await asgi_client.get("/v1/trajectory/stats")
    assert resp.status_code != 500
