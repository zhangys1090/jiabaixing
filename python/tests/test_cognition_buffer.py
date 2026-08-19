"""D2 认知信号回灌 — cognition_buffer 纯逻辑 + API 端点测试 (P2 第4轮)。

纯逻辑部分不依赖任何重型第三方库, 可在最小 Python 环境运行;
API 端点测试在 fastapi 可用时运行, 否则自动跳过。
"""
from __future__ import annotations

import importlib
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from agent.core.cognition_buffer import (  # noqa: E402
    _COGNITION_BUFFERS,
    build_cognition_system_message,
    inject_cognition_into_messages,
    store_cognition_signal,
)


def _reset() -> None:
    _COGNITION_BUFFERS.clear()


def test_store_and_inject_inserts_system_message_before_user():
    _reset()
    store_cognition_signal("s1", {"tool": "emotion_detect", "success": True, "output_preview": "正面"})
    store_cognition_signal("s1", {"tool": "self_reflect", "success": False, "error": "boom"})

    messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}]
    out = inject_cognition_into_messages("s1", messages)
    # 注入一条 system 消息, 位于首个非 system(user) 之前
    assert len(out) == 3
    assert out[0]["role"] == "system"          # 原 system_prompt
    assert out[1]["role"] == "system"          # 注入的元认知消息
    assert out[1]["content"].startswith("【元认知状态回灌】")
    assert out[2]["role"] == "user"
    assert "emotion_detect" in out[1]["content"]
    assert "self_reflect" in out[1]["content"]
    assert "boom" in out[1]["content"]


def test_empty_or_missing_session_no_inject():
    _reset()
    messages = [{"role": "user", "content": "hi"}]
    assert inject_cognition_into_messages("missing", messages) == messages


def test_empty_session_id_not_stored():
    _reset()
    store_cognition_signal("", {"tool": "x"})
    assert "" not in _COGNITION_BUFFERS  # 空 session 被忽略, 不写入


def test_rolling_cap_keeps_recent_ten():
    _reset()
    for i in range(15):
        store_cognition_signal("s2", {"tool": f"t{i}"})
    assert len(_COGNITION_BUFFERS["s2"]) == 10


def test_build_message_none_when_empty():
    _reset()
    assert build_cognition_system_message("empty") is None


def _make_client():
    try:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from agent.api.cognition import router
    except Exception as exc:  # 依赖(fastapi/logger)不可用 → 跳过, 不视为失败
        import pytest

        pytest.skip(f"API 依赖不可用: {exc}")
    app = FastAPI()
    app.include_router(router, prefix="/v1")
    return TestClient(app)


def test_api_endpoint_stores_and_injects():
    _reset()
    client = _make_client()
    resp = client.post(
        "/v1/cognition/signal",
        json={
            "session_id": "s3",
            "tool": "emotion_detect",
            "success": True,
            "output_preview": "负面",
            "timestamp": "t",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    assert len(_COGNITION_BUFFERS["s3"]) == 1
    msgs = [{"role": "user", "content": "hi"}]
    inject_cognition_into_messages("s3", msgs)
    assert msgs[0]["role"] == "system"
    assert "负面" in msgs[0]["content"]


def test_api_endpoint_requires_session_id():
    _reset()
    client = _make_client()
    resp = client.post("/v1/cognition/signal", json={"tool": "x"})
    assert resp.json()["success"] is False
    assert "session_id" in resp.json()["error"]
