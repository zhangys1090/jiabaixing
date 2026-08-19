"""操作验证端点 /v1/perception/verify-action 测试（审计 P1-2）。

验证桌面动作接回 action_verifier 的 HTTP 闭环：
- _serialize 将 VerificationResult 归一为 JSON 安全字典。
- 成功路径：200 + 归一化字段。
- 验证器内部异常：优雅降级为 200 + success=false（不拖垮调用方）。
所有断言均为行为断言，不含恒真，符合 CI 恒真护栏。
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.api.action_verify import router, _serialize
from agent.perception.action_verifier import VerificationResult


def make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/v1/perception")
    return app


def test_serialize_normalizes_fields():
    vr = VerificationResult(
        success=True,
        confidence=0.9,
        evidence="changed",
        retry_suggested=False,
        method="pixel",
        diff_ratio=0.05,
    )
    out = _serialize(vr)
    assert out == {
        "success": True,
        "confidence": 0.9,
        "evidence": "changed",
        "retry_suggested": False,
        "method": "pixel",
        "diff_ratio": 0.05,
    }


def test_verify_action_success():
    fake = AsyncMock()
    fake.verify.return_value = VerificationResult(
        success=True,
        confidence=0.8,
        evidence="屏幕已变化",
        method="pixel",
        diff_ratio=0.1,
    )
    with patch("agent.api.action_verify.ActionVerifier", return_value=fake):
        with TestClient(make_app()) as client:
            resp = client.post(
                "/v1/perception/verify-action",
                json={
                    "action_description": "点击确定",
                    "pre_path": "a.png",
                    "post_path": "b.png",
                },
            )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["method"] == "pixel"
    assert body["diff_ratio"] == pytest.approx(0.1)


def test_verify_action_graceful_on_exception():
    fake = AsyncMock()
    fake.verify.side_effect = RuntimeError("boom")
    with patch("agent.api.action_verify.ActionVerifier", return_value=fake):
        with TestClient(make_app()) as client:
            resp = client.post(
                "/v1/perception/verify-action",
                json={"action_description": "x"},
            )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert body["method"] == "error"
    assert "boom" in body["evidence"]
