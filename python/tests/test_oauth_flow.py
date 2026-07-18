"""④ OAuth 授权码流转 + 令牌持久化测试（离线，HTTP POST 可注入）。

覆盖：
  - PKCE 生成（verifier/challenge 格式合规）。
  - 授权 URL 构造（含 code_challenge / scope / state）。
  - 授权码交换 / 刷新令牌（注入假 HTTP POST，验证 expires_at 折算与持久化）。
  - OAuthTokenStore 保存/加载/清除/过期判断。
  - complete_*_oauth 把令牌写入 store。
  - resolve_*_credentials 优先使用持久化令牌；过期且有 refresh_token 时尝试刷新。
"""

import json
import os
import time

import pytest

import agent.llm.oauth_credentials as oc


def _fake_post(url, data, headers):
    """模拟令牌端点：根据 grant_type 返回访问/刷新令牌。"""
    if data.get("grant_type") == "authorization_code":
        return {
            "access_token": "at-123",
            "refresh_token": "rt-123",
            "token_type": "Bearer",
            "expires_in": 3600,
        }
    if data.get("grant_type") == "refresh_token":
        return {"access_token": "at-refreshed", "expires_in": 3600}
    return {}


def test_generate_pkce_format():
    verifier, challenge = oc.generate_pkce()
    assert 43 <= len(verifier) <= 128
    # challenge 为 base64url(sha256(verifier)) 无填充
    import base64
    import hashlib

    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert challenge == expected


def test_build_authorization_url_includes_pkce_and_scope():
    url, verifier = oc.create_vertex_authorization_url(
        client_id="cid", redirect_uri="http://localhost/cb", state="st"
    )
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "code_challenge=" in url
    assert "scope=" in url
    assert "state=st" in url
    assert "access_type=offline" in url
    assert verifier is not None


def test_exchange_code_for_token_normalizes_expiry():
    token = oc.exchange_code_for_token(
        oc.VERTEX_OAUTH,
        client_id="cid",
        code="authcode",
        redirect_uri="http://localhost/cb",
        client_secret="secret",
        code_verifier="ver",
        http_post=_fake_post,
    )
    assert token["access_token"] == "at-123"
    assert token["refresh_token"] == "rt-123"
    # expires_in → expires_at 折算
    assert "expires_at" in token
    assert token["expires_at"] > time.time()


def test_refresh_access_token_keeps_refresh_token():
    token = oc.refresh_access_token(
        oc.VERTEX_OAUTH,
        client_id="cid",
        refresh_token="rt-123",
        client_secret="secret",
        http_post=_fake_post,
    )
    assert token["access_token"] == "at-refreshed"
    # 刷新响应不含 refresh_token，应回填原值
    assert token["refresh_token"] == "rt-123"


def test_token_store_save_load_clear(tmp_path):
    store = oc.OAuthTokenStore(directory=str(tmp_path))
    tok = {"access_token": "a", "expires_at": time.time() + 1000}
    store.save("vertex", tok)
    assert store.load("vertex") == tok
    assert store.is_expired(tok) is False
    # 过期判断
    expired = {"access_token": "x", "expires_at": time.time() - 10}
    assert store.is_expired(expired) is True
    store.clear("vertex")
    assert store.load("vertex") is None


def test_complete_vertex_oauth_persists(tmp_path):
    store = oc.OAuthTokenStore(directory=str(tmp_path))
    token = oc.complete_vertex_oauth(
        code="authcode",
        client_id="cid",
        client_secret="secret",
        redirect_uri="http://localhost/cb",
        token_store=store,
        http_post=_fake_post,
    )
    assert token["access_token"] == "at-123"
    assert store.load("vertex") is not None


def test_bedrock_sso_auth_url_host():
    url, _ = oc.create_bedrock_sso_authorization_url(
        client_id="cid", redirect_uri="http://localhost/cb", state="st"
    )
    assert "oidc.us-east-1.amazonaws.com/authorize" in url


def test_resolve_vertex_prefers_valid_oauth_token(tmp_path):
    store = oc.OAuthTokenStore(directory=str(tmp_path))
    store.save("vertex", {"access_token": "a", "expires_at": time.time() + 1000})
    res = oc.resolve_vertex_credentials(token_store=store)
    assert res["oauth_available"] is True
    assert res["source"] == "oauth_token"
    # 有效 OAuth 令牌即视为可用，不降级（且不会回落到 ADC 分支）。
    assert res["degraded"] is False


def test_resolve_vertex_refreshes_expired_token(tmp_path, monkeypatch):
    store = oc.OAuthTokenStore(directory=str(tmp_path))
    store.save("vertex", {"access_token": "old", "refresh_token": "rt-123", "expires_at": time.time() - 10})
    monkeypatch.setenv("VERTEX_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VERTEX_OAUTH_CLIENT_SECRET", "secret")
    # 注入假刷新网络调用
    monkeypatch.setattr(oc, "_default_http_post", _fake_post)
    res = oc.resolve_vertex_credentials(token_store=store)
    assert res["oauth_available"] is True
    assert res["source"] == "oauth_token"
    # 刷新后写回 store
    saved = store.load("vertex")
    assert saved["access_token"] == "at-refreshed"
