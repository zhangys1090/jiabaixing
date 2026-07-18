"""T3 OAuth / ADC 凭据获取测试：Vertex (Google ADC) 与 Bedrock (AWS IAM)。

验证优雅降级与凭据来源上报（不记录密钥明文）。无论 google-auth / botocore
是否安装，关键不变量都成立：未配置 → degraded；配置到位 → 非 degraded 且 source 合理。
"""
from __future__ import annotations

import os

from agent.llm.oauth_credentials import (
    resolve_bedrock_credentials,
    resolve_provider_credentials,
    resolve_vertex_credentials,
)


def _env(keys: list[str], values: dict[str, str | None]) -> dict[str, str | None]:
    saved = {k: os.environ.get(k) for k in keys}
    for k in keys:
        if k in values:
            if values[k] is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = values[k]
    return saved


def _restore(saved: dict[str, str | None]) -> None:
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def test_vertex_degraded_when_nothing_configured():
    saved = _env(
        ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"],
        {"GOOGLE_CLOUD_PROJECT": None, "GCP_PROJECT": None, "GOOGLE_APPLICATION_CREDENTIALS": None},
    )
    try:
        r = resolve_vertex_credentials()
        assert r["provider"] == "vertex"
        assert r["degraded"] is True
        assert r["source"] is None
    finally:
        _restore(saved)


def test_vertex_service_account_file_detected(tmp_path):
    sa = tmp_path / "sa.json"
    sa.write_text("{}")
    saved = _env(
        ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"],
        {"GOOGLE_CLOUD_PROJECT": "my-project", "GOOGLE_APPLICATION_CREDENTIALS": str(sa)},
    )
    try:
        r = resolve_vertex_credentials()
        assert r["degraded"] is False
        assert r["adc_available"] is True
        assert r["source"] in ("adc", "service_account_file")
        assert r["project"] == "my-project"
    finally:
        _restore(saved)


def test_bedrock_degraded_without_creds():
    saved = _env(
        ["AWS_ACCESS_KEY_ID", "AWS_REGION", "AWS_DEFAULT_REGION"],
        {"AWS_ACCESS_KEY_ID": None, "AWS_REGION": None, "AWS_DEFAULT_REGION": None},
    )
    try:
        r = resolve_bedrock_credentials()
        assert r["provider"] == "bedrock"
        assert r["degraded"] is True
        assert r["source"] is None
    finally:
        _restore(saved)


def test_bedrock_env_static_creds(tmp_path):
    saved = _env(
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
        {
            "AWS_ACCESS_KEY_ID": "AKIAEXAMPLE",
            "AWS_SECRET_ACCESS_KEY": "secret",
            "AWS_REGION": "eu-west-1",
        },
    )
    try:
        r = resolve_bedrock_credentials()
        assert r["degraded"] is False
        assert r["has_access_key"] is True
        assert r["region"] == "eu-west-1"
        assert r["source"] in ("iam_session", "env_static")
    finally:
        _restore(saved)


def test_resolve_provider_credentials_dispatch():
    assert resolve_provider_credentials("vertex") is not None
    assert resolve_provider_credentials("bedrock") is not None
    # 非 OAuth-capable provider 返回 None
    assert resolve_provider_credentials("deepseek") is None
    assert resolve_provider_credentials("unknown") is None
