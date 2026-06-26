import pytest
from httpx import ASGITransport, AsyncClient

from agent.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_health(client: AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["python_version"] == "3.13.0"


@pytest.mark.anyio
async def test_status(client: AsyncClient):
    resp = await client.get("/v1/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["backend"] == "python"


@pytest.mark.anyio
async def test_chat_endpoint_exists(client: AsyncClient):
    resp = await client.post(
        "/v1/chat",
        json={"message": "hello", "session_id": "test"},
    )
    assert resp.status_code in (200, 502, 503)


@pytest.mark.anyio
async def test_memory_search(client: AsyncClient):
    resp = await client.get("/v1/memory/search", params={"query": "test"})
    assert resp.status_code == 200
    data = resp.json()
    assert "results" in data


@pytest.mark.anyio
async def test_skills_list(client: AsyncClient):
    resp = await client.get("/v1/skills")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0


@pytest.mark.anyio
async def test_evolution_status(client: AsyncClient):
    resp = await client.get("/v1/evolution/status")
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_cron_jobs(client: AsyncClient):
    resp = await client.get("/v1/cron/jobs")
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_sessions_list(client: AsyncClient):
    resp = await client.get("/v1/sessions")
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_plan_endpoint_exists(client: AsyncClient):
    resp = await client.post(
        "/v1/plan",
        json={"task": "test task", "session_id": "test"},
    )
    assert resp.status_code in (200, 502, 503)
