import pytest
from httpx import AsyncClient, ASGITransport

from agent.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_health_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"


@pytest.mark.anyio
async def test_llm_providers():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/llm/providers")
        assert resp.status_code == 200


@pytest.mark.anyio
async def test_memory_stats():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/memory/stats")
        assert resp.status_code == 200


@pytest.mark.anyio
async def test_skills_list():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/skills")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)


@pytest.mark.anyio
async def test_sessions_list():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/sessions")
        assert resp.status_code == 200


@pytest.mark.anyio
async def test_session_create_and_messages():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/v1/sessions", json={"title": "集成测试会话"})
        assert resp.status_code == 200
        sid = resp.json()["session_id"]

        resp = await client.post(f"/v1/sessions/{sid}/messages", json={"role": "user", "content": "你好"})
        assert resp.status_code == 200
        assert resp.json()["success"] is True

        resp = await client.get(f"/v1/sessions/{sid}/messages")
        assert resp.status_code == 200
        msgs = resp.json()
        assert len(msgs) >= 1


@pytest.mark.anyio
async def test_cron_jobs():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/cron/jobs")
        assert resp.status_code == 200

        resp = await client.post("/v1/cron/jobs", json={
            "name": "测试任务",
            "schedule": "every:5m",
            "command": "echo test",
        })
        assert resp.status_code == 200
        assert resp.json()["success"] is True


@pytest.mark.anyio
async def test_evolution_status():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/evolution/status")
        assert resp.status_code == 200


@pytest.mark.anyio
async def test_evolution_feedback():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/v1/evolution/feedback", json={
            "interaction_id": "e2e_test",
            "quality_score": 0.85,
            "cause": "chat",
        })
        assert resp.status_code == 200


@pytest.mark.anyio
async def test_full_pipeline():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
        assert resp.status_code == 200

        resp = await client.get("/v1/skills")
        assert resp.status_code == 200

        resp = await client.get("/v1/memory/stats")
        assert resp.status_code == 200

        resp = await client.get("/v1/evolution/status")
        assert resp.status_code == 200

        resp = await client.get("/v1/cron/jobs")
        assert resp.status_code == 200
