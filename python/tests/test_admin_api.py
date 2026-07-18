"""R1 管理面：HTTP 端点测试（需 fastapi + httpx）。

本环境若未安装 fastapi，整文件跳过；CI（⑤）在装齐依赖的环境中会真实运行，
覆盖"管理面端点 → RuntimeSecurityController → 真实执行器"的完整调用链。

通过单例控制器注入假的 ApprovalManager / PluginTrustPolicy，避免依赖完整 engine。
"""

import pytest

try:
    import fastapi
    from fastapi.testclient import TestClient

    _HAS_FASTAPI = True
except Exception:  # pragma: no cover - 仅本机缺依赖时跳过
    _HAS_FASTAPI = False

from agent.plugins.trust import PluginTrustPolicy, TrustLevel
from agent.security.runtime_control import get_controller, RuntimeSecurityController
from agent.security.runtime_posture import RuntimePosture

pytestmark = pytest.mark.skipif(not _HAS_FASTAPI, reason="fastapi 未安装")


class FakeApprovalManager:
    def __init__(self) -> None:
        self.posture = RuntimePosture.CONFIRM
        self.lockdown = False

    def set_posture(self, p: RuntimePosture) -> None:
        self.posture = p

    def set_lockdown(self, b: bool) -> None:
        self.lockdown = b


@pytest.fixture
def client():
    from agent.api.admin import router

    c = get_controller()
    c.reset()
    c.attach_approval_manager(FakeApprovalManager())
    c.attach_plugin_policy(PluginTrustPolicy())

    app = fastapi.FastAPI()
    app.include_router(router, prefix="/v1/admin")
    with TestClient(app) as test_client:
        yield test_client
    c.reset()
    c.attach_approval_manager(None)
    c.attach_plugin_policy(None)


def test_get_posture_default(client) -> None:
    r = client.get("/v1/admin/runtime/posture")
    assert r.status_code == 200
    body = r.json()
    assert body["posture"] == "confirm"
    assert body["source"] == "env"
    # 默认 CONFIRM 姿态：critical 走审批流（REVIEW），而非硬 DENY —— 与
    # runtime_posture.decide() 的 CONFIRM 决策矩阵一致（硬底线只是"永不静默 ALLOW"）。
    assert body["decisions"]["critical"] == "review"


def test_set_posture_and_lockdown(client) -> None:
    r = client.post("/v1/admin/runtime/posture", json={"posture": "safe"})
    assert r.status_code == 200
    assert r.json()["posture"] == "safe"
    assert r.json()["source"] == "override"

    r = client.post("/v1/admin/runtime/lockdown", json={"enabled": True})
    assert r.status_code == 200
    assert r.json()["lockdown"] is True
    assert r.json()["posture"] == "safe"


def test_set_posture_invalid(client) -> None:
    r = client.post("/v1/admin/runtime/posture", json={"posture": "bogus"})
    assert r.status_code == 400


def test_plugin_trust_list_and_set(client) -> None:
    r = client.post(
        "/v1/admin/plugins/trust",
        json={"plugin": "demo", "trust_level": "medium"},
    )
    assert r.status_code == 200
    assert r.json()["trust_level"] == "medium"
    assert r.json()["max_tool_risk"] == "medium"

    r = client.get("/v1/admin/plugins/trust")
    assert r.status_code == 200
    assert any(p["plugin"] == "demo" for p in r.json()["plugins"])
