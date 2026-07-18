"""Vertex (Google) 与 Bedrock (AWS) 的 OAuth / ADC 凭据获取。

对标 Hermes 的 Provider OAuth onboarding：
  - Vertex  → Google ADC（服务账号 / 应用默认凭证）+ OAuth2 授权码流转 + 令牌持久化。
  - Bedrock → AWS IAM / SigV4（OAuth 等效物）+ AWS IAM Identity Center OIDC
             授权码流转 + 令牌持久化。

设计（对齐 AGENTS.md §0.1，Python 主实现）：
  - 纯函数 + 优雅降级：SDK 缺失或凭据未配置时返回 {degraded: True, reason: ...}，
    绝不抛异常阻断引擎启动。
  - 不记录任何密钥明文到日志；只上报存在性 / 来源（source）。
  - 授权码流转与令牌持久化与网络实现解耦（HTTP POST 可注入），便于离线测试。
  - 令牌落地文件权限 0600，且可按 AGENT_OAUTH_TOKEN_DIR 重定向。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

# ── 通用 OAuth2 配置 ──

#: 标准授权码流转的默认 HTTP POST 实现（stdlib，无第三方依赖）。
HttpPost = Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]


@dataclass
class OAuth2Config:
    """一个 OAuth2 授权码提供方的端点与范围配置。"""

    auth_url: str
    token_url: str
    scopes: list[str] = field(default_factory=list)
    supports_pkce: bool = True
    # 额外授权请求参数（如 Google 的 access_type=offline 以换取 refresh_token）。
    extra_auth_params: dict[str, str] = field(default_factory=dict)


#: Vertex AI（Google Cloud）OAuth2 配置。
VERTEX_OAUTH = OAuth2Config(
    auth_url="https://accounts.google.com/o/oauth2/v2/auth",
    token_url="https://oauth2.googleapis.com/token",
    scopes=["https://www.googleapis.com/auth/cloud-platform"],
    supports_pkce=True,
    extra_auth_params={"access_type": "offline", "prompt": "consent"},
)

#: AWS IAM Identity Center（SSO）OIDC 授权码配置。
AWS_SSO_OAUTH = OAuth2Config(
    auth_url="https://oidc.us-east-1.amazonaws.com/authorize",
    token_url="https://oidc.us-east-1.amazonaws.com/token",
    scopes=["sso-oauth.amazonaws.com/cli"],
    supports_pkce=True,
)


# ── PKCE ──


def generate_pkce() -> tuple[str, str]:
    """生成 PKCE code_verifier / code_challenge（S256）。

    Returns:
        (verifier, challenge)。
    """
    verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


# ── 授权 URL 与令牌交换 ──


def build_authorization_url(
    config: OAuth2Config,
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str | None = None,
    extra: dict[str, str] | None = None,
) -> str:
    """构造授权码跳转 URL。"""
    params: dict[str, str] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(config.scopes),
        "state": state,
    }
    params.update(config.extra_auth_params)
    if code_challenge:
        params["code_challenge"] = code_challenge
        params["code_challenge_method"] = "S256"
    if extra:
        params.update(extra)
    return f"{config.auth_url}?{urllib.parse.urlencode(params)}"


def _default_http_post(url: str, data: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OAuth 令牌交换失败 HTTP {e.code}: {body}") from e


def exchange_code_for_token(
    config: OAuth2Config,
    client_id: str,
    code: str,
    redirect_uri: str,
    client_secret: str | None = None,
    code_verifier: str | None = None,
    http_post: HttpPost | None = None,
) -> dict[str, Any]:
    """用授权码交换访问令牌（授权码流转核心）。"""
    post = http_post or _default_http_post
    data: dict[str, Any] = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": client_id,
        "redirect_uri": redirect_uri,
    }
    if client_secret:
        data["client_secret"] = client_secret
    if code_verifier:
        data["code_verifier"] = code_verifier
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = post(config.token_url, data, headers)
    return _normalize_token(token)


def refresh_access_token(
    config: OAuth2Config,
    client_id: str,
    refresh_token: str,
    client_secret: str | None = None,
    http_post: HttpPost | None = None,
) -> dict[str, Any]:
    """用 refresh_token 刷新访问令牌。"""
    post = http_post or _default_http_post
    data: dict[str, Any] = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }
    if client_secret:
        data["client_secret"] = client_secret
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = post(config.token_url, data, headers)
    # 刷新响应可能不含 refresh_token（Google 复用旧值），回填以便持久化。
    if "refresh_token" not in token and refresh_token:
        token["refresh_token"] = refresh_token
    return _normalize_token(token)


def _normalize_token(token: dict[str, Any]) -> dict[str, Any]:
    """把 expires_in（秒）折算为绝对过期时间 expires_at（epoch）。"""
    if "expires_in" in token and "expires_at" not in token:
        try:
            token["expires_at"] = time.time() + float(token["expires_in"])
        except (TypeError, ValueError):
            pass
    return token


# ── 令牌持久化 ──


class OAuthTokenStore:
    """OAuth 令牌落地存储（按 provider 分文件，权限 0600）。"""

    def __init__(self, directory: str | None = None) -> None:
        self.directory = (
            directory
            or os.environ.get("AGENT_OAUTH_TOKEN_DIR")
            or os.path.join(os.path.expanduser("~"), ".jiabaixing", "oauth")
        )
        try:
            os.makedirs(self.directory, exist_ok=True)
        except OSError:
            pass

    def _path(self, provider: str) -> str:
        return os.path.join(self.directory, f"{provider}.json")

    def save(self, provider: str, token: dict[str, Any]) -> None:
        path = self._path(provider)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(token, f)
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def load(self, provider: str) -> dict[str, Any] | None:
        path = self._path(provider)
        if not os.path.exists(path):
            return None
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def clear(self, provider: str) -> None:
        path = self._path(provider)
        if os.path.exists(path):
            os.remove(path)

    @staticmethod
    def is_expired(token: dict[str, Any], leeway: int = 60) -> bool:
        exp = token.get("expires_at")
        if not exp:
            return True
        try:
            return time.time() > (float(exp) - leeway)
        except (TypeError, ValueError):
            return True


# ── Provider 封装：Vertex ──


def create_vertex_authorization_url(
    client_id: str,
    redirect_uri: str,
    state: str,
    use_pkce: bool = True,
) -> tuple[str, str | None]:
    """构造 Vertex（Google）授权跳转 URL。

    Returns:
        (url, code_verifier|None)。
    """
    verifier = None
    challenge = None
    if use_pkce:
        verifier, challenge = generate_pkce()
    url = build_authorization_url(
        VERTEX_OAUTH, client_id, redirect_uri, state, code_challenge=challenge
    )
    return url, verifier


def complete_vertex_oauth(
    code: str,
    client_id: str,
    client_secret: str | None,
    redirect_uri: str,
    code_verifier: str | None = None,
    token_store: OAuthTokenStore | None = None,
    http_post: HttpPost | None = None,
) -> dict[str, Any]:
    """完成 Vertex 授权码流转：交换令牌并持久化。"""
    token = exchange_code_for_token(
        VERTEX_OAUTH,
        client_id,
        code,
        redirect_uri,
        client_secret=client_secret,
        code_verifier=code_verifier,
        http_post=http_post,
    )
    if token_store and token.get("access_token"):
        token_store.save("vertex", token)
    return token


# ── Provider 封装：Bedrock（AWS IAM Identity Center OIDC） ──


def create_bedrock_sso_authorization_url(
    client_id: str,
    redirect_uri: str,
    state: str,
    use_pkce: bool = True,
) -> tuple[str, str | None]:
    """构造 Bedrock（AWS SSO OIDC）授权跳转 URL。"""
    verifier = None
    challenge = None
    if use_pkce:
        verifier, challenge = generate_pkce()
    url = build_authorization_url(
        AWS_SSO_OAUTH, client_id, redirect_uri, state, code_challenge=challenge
    )
    return url, verifier


def complete_bedrock_sso_oauth(
    code: str,
    client_id: str,
    client_secret: str | None,
    redirect_uri: str,
    code_verifier: str | None = None,
    token_store: OAuthTokenStore | None = None,
    http_post: HttpPost | None = None,
) -> dict[str, Any]:
    """完成 Bedrock（AWS SSO OIDC）授权码流转：交换令牌并持久化。"""
    token = exchange_code_for_token(
        AWS_SSO_OAUTH,
        client_id,
        code,
        redirect_uri,
        client_secret=client_secret,
        code_verifier=code_verifier,
        http_post=http_post,
    )
    if token_store and token.get("access_token"):
        token_store.save("bedrock", token)
    return token


# ── 凭据解析（ADC / IAM + OAuth 令牌优先） ──


def resolve_vertex_credentials(
    project: str | None = None,
    location: str | None = None,
    token_store: OAuthTokenStore | None = None,
) -> dict[str, Any]:
    """解析 Vertex AI 凭据（Google ADC / 服务账号 / OAuth 令牌）。

    优先使用持久化的 OAuth 访问令牌（未过期）；过期但有 refresh_token 时尝试刷新；
    均无则回退 ADC / 服务账号文件。任何异常都优雅降级。
    """
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCP_PROJECT")
    location = (
        location
        or os.environ.get("GOOGLE_CLOUD_LOCATION")
        or os.environ.get("VERTEX_LOCATION")
        or "us-central1"
    )
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    result: dict[str, Any] = {
        "provider": "vertex",
        "project": project,
        "location": location,
        "source": None,
        "adc_available": False,
        "oauth_available": False,
        "access_token_expires_at": None,
        "degraded": False,
        "reason": None,
    }

    # 1) OAuth 令牌优先
    store = token_store or OAuthTokenStore()
    tok = store.load("vertex")
    if tok:
        if not OAuthTokenStore.is_expired(tok):
            result["source"] = "oauth_token"
            result["oauth_available"] = True
            result["access_token_expires_at"] = tok.get("expires_at")
            return result
        # 过期但有 refresh_token → 尝试刷新
        refresh_tok = tok.get("refresh_token")
        client_id = os.environ.get("VERTEX_OAUTH_CLIENT_ID")
        client_secret = os.environ.get("VERTEX_OAUTH_CLIENT_SECRET")
        if refresh_tok and client_id:
            try:
                refreshed = refresh_access_token(
                    VERTEX_OAUTH, client_id, refresh_tok, client_secret=client_secret
                )
                store.save("vertex", refreshed)
                result["source"] = "oauth_token"
                result["oauth_available"] = True
                result["access_token_expires_at"] = refreshed.get("expires_at")
                return result
            except Exception as e:
                result["reason"] = f"Vertex OAuth 刷新失败，回退 ADC: {e}"
                # 继续走 ADC 分支

    # 2) ADC / 服务账号文件
    try:
        import google.auth  # type: ignore

        creds, proj = google.auth.default()
        del creds
        result["source"] = "adc"
        result["adc_available"] = True
        if project is None and proj:
            result["project"] = proj
    except Exception:
        if sa_path and os.path.exists(sa_path):
            result["source"] = "service_account_file"
            result["adc_available"] = True
            result["service_account_path"] = sa_path
        else:
            result["degraded"] = True
            if not result["reason"]:
                result["reason"] = "google-auth 未安装且无可用的 GOOGLE_APPLICATION_CREDENTIALS"
    return result


def resolve_bedrock_credentials(
    region: str | None = None,
    token_store: OAuthTokenStore | None = None,
) -> dict[str, Any]:
    """解析 AWS Bedrock 凭据（IAM / SigV4 / AWS SSO OAuth 令牌）。

    优先使用持久化的 AWS SSO OIDC 访问令牌（未过期）；过期但有 refresh_token 时尝试刷新；
    均无则回退 botocore IAM 会话 / 环境变量。
    """
    region = (
        region
        or os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    ak = os.environ.get("AWS_ACCESS_KEY_ID")
    result: dict[str, Any] = {
        "provider": "bedrock",
        "region": region,
        "source": None,
        "has_access_key": False,
        "has_session_token": False,
        "oauth_available": False,
        "access_token_expires_at": None,
        "degraded": False,
        "reason": None,
    }

    # 1) AWS SSO OIDC 令牌优先
    store = token_store or OAuthTokenStore()
    tok = store.load("bedrock")
    if tok:
        if not OAuthTokenStore.is_expired(tok):
            result["source"] = "oauth_token"
            result["oauth_available"] = True
            result["access_token_expires_at"] = tok.get("expires_at")
            return result
        refresh_tok = tok.get("refresh_token")
        client_id = os.environ.get("AWS_SSO_OAUTH_CLIENT_ID")
        client_secret = os.environ.get("AWS_SSO_OAUTH_CLIENT_SECRET")
        if refresh_tok and client_id:
            try:
                refreshed = refresh_access_token(
                    AWS_SSO_OAUTH, client_id, refresh_tok, client_secret=client_secret
                )
                store.save("bedrock", refreshed)
                result["source"] = "oauth_token"
                result["oauth_available"] = True
                result["access_token_expires_at"] = refreshed.get("expires_at")
                return result
            except Exception as e:
                result["reason"] = f"Bedrock SSO OAuth 刷新失败，回退 IAM: {e}"

    # 2) IAM 会话 / 环境变量
    try:
        import botocore.session  # type: ignore

        sess = botocore.session.get_session()
        creds = sess.get_credentials()
        if creds and creds.access_key:
            result["source"] = "iam_session"
            result["has_access_key"] = True
            result["has_session_token"] = bool(creds.token)
        else:
            result["degraded"] = True
            result["reason"] = "botocore 已安装但未发现可用 IAM 凭证"
    except Exception:
        if ak:
            result["source"] = "env_static"
            result["has_access_key"] = True
        else:
            result["degraded"] = True
            if not result["reason"]:
                result["reason"] = "boto3/botocore 未安装且未设置 AWS_ACCESS_KEY_ID"
    return result


def resolve_provider_credentials(provider_id: str) -> dict[str, Any] | None:
    """按 provider_id 分发到对应的 OAuth / ADC 凭据解析器。

    Args:
        provider_id: 目录中的 provider id（如 "vertex" / "bedrock"）。

    Returns:
        凭据信息字典；非 OAuth-capable provider 返回 None。
    """
    if provider_id == "vertex":
        return resolve_vertex_credentials()
    if provider_id == "bedrock":
        return resolve_bedrock_credentials()
    return None
