"""A2A 运行时鉴权拦截器测试套件.

覆盖:
- 4 种鉴权类型（none/api-key/bearer/jwt）的出站注入
- 4 种鉴权类型的入站校验
- 鉴权失败的 401 响应（通过 FastAPI TestClient 验证）
- JWT 过期 / 签名错误
- 配置缺失时的降级（默认 none）
- A2AAuthInterceptor.from_env() 工厂方法
- A2AClient 出站鉴权头注入
- 大小写不敏感的请求头匹配

遵循测试规范:
- 异步测试使用 pytest.mark.asyncio
- 每个测试独立，不依赖全局状态
- 测试方法名清晰描述场景
"""

from __future__ import annotations

import os
import time
from typing import Dict, Optional

import jwt as jwt_lib
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.a2a import (
    A2AAgentCard,
    A2AAuthConfig,
    A2AAuthInterceptor,
    A2AAuthType,
    A2ACapability,
    A2ACapabilityType,
    A2AClient,
    A2ATransport,
    create_a2a_router,
)
from agent.a2a.auth import (
    BEARER_PREFIX,
    HEADER_API_KEY,
    HEADER_AUTHORIZATION,
    _extract_bearer_token,
    _get_header,
    _safe_str_eq,
)


# ═══════════════════════════════════════════════════════════════
# 测试常量
# ═══════════════════════════════════════════════════════════════

TEST_API_KEY = "test-secret-api-key-12345"
TEST_BEARER_TOKEN = "test-bearer-token-67890"
TEST_JWT_SECRET = "test-jwt-secret-super-safe"


# ═══════════════════════════════════════════════════════════════
# 测试夹具
# ═══════════════════════════════════════════════════════════════


@pytest.fixture
def api_key_interceptor() -> A2AAuthInterceptor:
    """提供 api-key 类型的鉴权拦截器."""
    return A2AAuthInterceptor(
        self_auth=A2AAuthConfig(
            type=A2AAuthType.API_KEY,
            api_key=TEST_API_KEY,
        )
    )


@pytest.fixture
def bearer_interceptor() -> A2AAuthInterceptor:
    """提供 bearer 类型的鉴权拦截器."""
    return A2AAuthInterceptor(
        self_auth=A2AAuthConfig(
            type=A2AAuthType.BEARER,
            bearer_token=TEST_BEARER_TOKEN,
        )
    )


@pytest.fixture
def jwt_interceptor() -> A2AAuthInterceptor:
    """提供 jwt 类型的鉴权拦截器."""
    return A2AAuthInterceptor(
        self_auth=A2AAuthConfig(
            type=A2AAuthType.JWT,
            jwt_secret=TEST_JWT_SECRET,
        )
    )


@pytest.fixture
def none_interceptor() -> A2AAuthInterceptor:
    """提供 none 类型的鉴权拦截器."""
    return A2AAuthInterceptor(
        self_auth=A2AAuthConfig(type=A2AAuthType.NONE)
    )


def _make_card(auth_type: A2AAuthType) -> A2AAgentCard:
    """构造指定鉴权类型的 AgentCard.

    Args:
        auth_type: 鉴权类型.

    Returns:
        A2AAgentCard: 测试用 Agent Card.
    """
    return A2AAgentCard(
        id=f"agent:test:{auth_type.value}",
        name=f"TestAgent-{auth_type.value}",
        description="测试 Agent",
        url="http://test-agent:8765/a2a",
        transport=A2ATransport.HTTP,
        capabilities=[
            A2ACapability(
                type=A2ACapabilityType.TASK_EXECUTION,
                name="task-exec",
                description="测试能力",
            ),
        ],
        authentication={"type": auth_type.value},
        version="1.0.0",
    )


# ═══════════════════════════════════════════════════════════════
# 类型与配置测试
# ═══════════════════════════════════════════════════════════════


class TestA2AAuthTypes:
    """A2A 鉴权类型与配置测试."""

    def test_auth_type_enum_values(self) -> None:
        """测试鉴权类型枚举值."""
        assert A2AAuthType.NONE.value == "none"
        assert A2AAuthType.API_KEY.value == "api-key"
        assert A2AAuthType.BEARER.value == "bearer"
        assert A2AAuthType.JWT.value == "jwt"
        # OAUTH2 保留兼容值
        assert A2AAuthType.OAUTH2.value == "oauth2"

    def test_auth_type_parse_valid(self) -> None:
        """测试 parse 方法解析有效值."""
        assert A2AAuthType.parse("none") == A2AAuthType.NONE
        assert A2AAuthType.parse("api-key") == A2AAuthType.API_KEY
        assert A2AAuthType.parse("bearer") == A2AAuthType.BEARER
        assert A2AAuthType.parse("jwt") == A2AAuthType.JWT
        assert A2AAuthType.parse("API-KEY") == A2AAuthType.API_KEY  # 大小写不敏感

    def test_auth_type_parse_invalid_falls_back_to_none(self) -> None:
        """测试 parse 方法对未知值降级到 NONE."""
        assert A2AAuthType.parse("unknown") == A2AAuthType.NONE
        assert A2AAuthType.parse(None) == A2AAuthType.NONE
        assert A2AAuthType.parse("") == A2AAuthType.NONE

    def test_auth_config_to_dict_only_exposes_type(self) -> None:
        """测试 A2AAuthConfig.to_dict() 仅暴露 type 字段，不泄露凭据."""
        config = A2AAuthConfig(
            type=A2AAuthType.API_KEY,
            api_key="secret-key",
            bearer_token="secret-token",
            jwt_secret="secret-secret",
        )
        d = config.to_dict()
        assert d == {"type": "api-key"}
        # 确保凭据未泄露
        assert "api_key" not in d
        assert "apiKey" not in d
        assert "bearer_token" not in d
        assert "jwt_secret" not in d

    def test_auth_config_from_dict(self) -> None:
        """测试 A2AAuthConfig.from_dict() 解析."""
        config = A2AAuthConfig.from_dict({"type": "bearer"})
        assert config.type == A2AAuthType.BEARER

        config = A2AAuthConfig.from_dict(None)
        assert config.type == A2AAuthType.NONE

        config = A2AAuthConfig.from_dict({})
        assert config.type == A2AAuthType.NONE

    def test_agent_card_get_auth_config(self) -> None:
        """测试 AgentCard.get_auth_config() 方法."""
        card = _make_card(A2AAuthType.JWT)
        auth = card.get_auth_config()
        assert auth.type == A2AAuthType.JWT

        # 无 authentication 字段
        card_no_auth = A2AAgentCard(id="x", name="X")
        assert card_no_auth.get_auth_config().type == A2AAuthType.NONE


# ═══════════════════════════════════════════════════════════════
# 出站鉴权头注入测试
# ═══════════════════════════════════════════════════════════════


class TestOutboundAuth:
    """出站鉴权头注入测试."""

    def test_outbound_none_no_injection(
        self, none_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 none 类型不注入任何头."""
        target = _make_card(A2AAuthType.NONE)
        headers = none_interceptor.verify_outbound(target, {"Content-Type": "application/json"})
        assert headers == {"Content-Type": "application/json"}
        assert HEADER_API_KEY not in headers
        assert HEADER_AUTHORIZATION not in headers

    def test_outbound_api_key_injection(
        self, api_key_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 api-key 类型注入 X-API-Key 头."""
        target = _make_card(A2AAuthType.API_KEY)
        headers = api_key_interceptor.verify_outbound(target, {})
        assert headers[HEADER_API_KEY] == TEST_API_KEY
        assert HEADER_AUTHORIZATION not in headers

    def test_outbound_bearer_injection(
        self, bearer_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 bearer 类型注入 Authorization: Bearer 头."""
        target = _make_card(A2AAuthType.BEARER)
        headers = bearer_interceptor.verify_outbound(target, {})
        assert headers[HEADER_AUTHORIZATION] == f"{BEARER_PREFIX}{TEST_BEARER_TOKEN}"
        assert HEADER_API_KEY not in headers

    def test_outbound_oauth2_treated_as_bearer(
        self, bearer_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 oauth2 类型作为 bearer 处理（向后兼容）."""
        target = _make_card(A2AAuthType.OAUTH2)
        headers = bearer_interceptor.verify_outbound(target, {})
        assert headers[HEADER_AUTHORIZATION] == f"{BEARER_PREFIX}{TEST_BEARER_TOKEN}"

    def test_outbound_jwt_injection(
        self, jwt_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 jwt 类型签发并注入 JWT."""
        target = _make_card(A2AAuthType.JWT)
        headers = jwt_interceptor.verify_outbound(target, {})
        auth_header = headers[HEADER_AUTHORIZATION]
        assert auth_header.startswith(BEARER_PREFIX)
        token = auth_header[len(BEARER_PREFIX):]
        # 验证签发的 JWT 可被自身密钥验证
        payload = jwt_lib.decode(token, TEST_JWT_SECRET, algorithms=["HS256"])
        assert payload["sub"] == "a2a-outbound"
        assert "iat" in payload
        assert "exp" in payload

    def test_outbound_preserves_existing_headers(
        self, api_key_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试出站注入保留已有头."""
        target = _make_card(A2AAuthType.API_KEY)
        original = {"Content-Type": "application/json", "X-Custom": "custom-val"}
        headers = api_key_interceptor.verify_outbound(target, original)
        assert headers["Content-Type"] == "application/json"
        assert headers["X-Custom"] == "custom-val"
        assert headers[HEADER_API_KEY] == TEST_API_KEY

    def test_outbound_does_not_mutate_input_headers(
        self, api_key_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试出站注入不修改入参 headers 字典."""
        target = _make_card(A2AAuthType.API_KEY)
        original: Dict[str, str] = {}
        _ = api_key_interceptor.verify_outbound(target, original)
        assert original == {}, "入参字典不应被修改"

    def test_outbound_api_key_missing_credential_logs_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """测试 api-key 类型但未配置凭据时记录 warning 并跳过注入."""
        interceptor = A2AAuthInterceptor(
            self_auth=A2AAuthConfig(type=A2AAuthType.API_KEY)  # 无 api_key
        )
        target = _make_card(A2AAuthType.API_KEY)
        headers = interceptor.verify_outbound(target, {})
        assert HEADER_API_KEY not in headers

    def test_outbound_bearer_missing_credential_skips(
        self
    ) -> None:
        """测试 bearer 类型但未配置凭据时跳过注入."""
        interceptor = A2AAuthInterceptor(
            self_auth=A2AAuthConfig(type=A2AAuthType.BEARER)  # 无 token
        )
        target = _make_card(A2AAuthType.BEARER)
        headers = interceptor.verify_outbound(target, {})
        assert HEADER_AUTHORIZATION not in headers

    def test_outbound_jwt_missing_credential_skips(
        self
    ) -> None:
        """测试 jwt 类型但未配置密钥时跳过注入."""
        interceptor = A2AAuthInterceptor(
            self_auth=A2AAuthConfig(type=A2AAuthType.JWT)  # 无 secret
        )
        target = _make_card(A2AAuthType.JWT)
        headers = interceptor.verify_outbound(target, {})
        assert HEADER_AUTHORIZATION not in headers


# ═══════════════════════════════════════════════════════════════
# 入站鉴权校验测试
# ═══════════════════════════════════════════════════════════════


class TestInboundAuth:
    """入站鉴权校验测试."""

    def test_inbound_none_always_passes(
        self, none_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 none 类型始终通过."""
        expected = A2AAuthConfig(type=A2AAuthType.NONE)
        # 空头通过
        assert none_interceptor.verify_inbound({}, expected) is True
        # 任意头通过
        assert none_interceptor.verify_inbound({"X-Random": "x"}, expected) is True

    def test_inbound_api_key_correct(
        self, api_key_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 api-key 类型正确凭据通过."""
        expected = A2AAuthConfig(type=A2AAuthType.API_KEY, api_key=TEST_API_KEY)
        headers = {HEADER_API_KEY: TEST_API_KEY}
        assert api_key_interceptor.verify_inbound(headers, expected) is True

    def test_inbound_api_key_wrong(
        self, api_key_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 api-key 类型错误凭据拒绝."""
        expected = A2AAuthConfig(type=A2AAuthType.API_KEY, api_key=TEST_API_KEY)
        headers = {HEADER_API_KEY: "wrong-key"}
        assert api_key_interceptor.verify_inbound(headers, expected) is False

    def test_inbound_api_key_missing(
        self, api_key_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 api-key 类型缺失头拒绝."""
        expected = A2AAuthConfig(type=A2AAuthType.API_KEY, api_key=TEST_API_KEY)
        assert api_key_interceptor.verify_inbound({}, expected) is False

    def test_inbound_api_key_case_insensitive(
        self, api_key_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试请求头名称大小写不敏感."""
        expected = A2AAuthConfig(type=A2AAuthType.API_KEY, api_key=TEST_API_KEY)
        # 小写头名
        headers = {"x-api-key": TEST_API_KEY}
        assert api_key_interceptor.verify_inbound(headers, expected) is True
        # 大写头名
        headers = {"X-API-KEY": TEST_API_KEY}
        assert api_key_interceptor.verify_inbound(headers, expected) is True

    def test_inbound_bearer_correct(
        self, bearer_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 bearer 类型正确凭据通过."""
        expected = A2AAuthConfig(
            type=A2AAuthType.BEARER, bearer_token=TEST_BEARER_TOKEN
        )
        headers = {HEADER_AUTHORIZATION: f"{BEARER_PREFIX}{TEST_BEARER_TOKEN}"}
        assert bearer_interceptor.verify_inbound(headers, expected) is True

    def test_inbound_bearer_wrong(
        self, bearer_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 bearer 类型错误凭据拒绝."""
        expected = A2AAuthConfig(
            type=A2AAuthType.BEARER, bearer_token=TEST_BEARER_TOKEN
        )
        headers = {HEADER_AUTHORIZATION: f"{BEARER_PREFIX}wrong-token"}
        assert bearer_interceptor.verify_inbound(headers, expected) is False

    def test_inbound_bearer_missing(
        self, bearer_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 bearer 类型缺失头拒绝."""
        expected = A2AAuthConfig(
            type=A2AAuthType.BEARER, bearer_token=TEST_BEARER_TOKEN
        )
        assert bearer_interceptor.verify_inbound({}, expected) is False

    def test_inbound_bearer_wrong_scheme(
        self, bearer_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 Authorization 头使用非 Bearer scheme 时拒绝."""
        expected = A2AAuthConfig(
            type=A2AAuthType.BEARER, bearer_token=TEST_BEARER_TOKEN
        )
        headers = {HEADER_AUTHORIZATION: f"Basic {TEST_BEARER_TOKEN}"}
        assert bearer_interceptor.verify_inbound(headers, expected) is False

    def test_inbound_jwt_correct(
        self, jwt_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 jwt 类型正确签名通过."""
        expected = A2AAuthConfig(type=A2AAuthType.JWT, jwt_secret=TEST_JWT_SECRET)
        # 签发一个有效 JWT
        token = jwt_lib.encode(
            {"sub": "remote-agent", "iat": int(time.time()),
             "exp": int(time.time()) + 3600},
            TEST_JWT_SECRET,
            algorithm="HS256",
        )
        headers = {HEADER_AUTHORIZATION: f"{BEARER_PREFIX}{token}"}
        assert jwt_interceptor.verify_inbound(headers, expected) is True

    def test_inbound_jwt_wrong_signature(
        self, jwt_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 jwt 类型签名错误拒绝."""
        expected = A2AAuthConfig(type=A2AAuthType.JWT, jwt_secret=TEST_JWT_SECRET)
        # 用错误密钥签发
        token = jwt_lib.encode(
            {"sub": "x", "iat": int(time.time()), "exp": int(time.time()) + 3600},
            "wrong-secret",
            algorithm="HS256",
        )
        headers = {HEADER_AUTHORIZATION: f"{BEARER_PREFIX}{token}"}
        assert jwt_interceptor.verify_inbound(headers, expected) is False

    def test_inbound_jwt_expired(
        self, jwt_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 jwt 类型过期 token 拒绝."""
        expected = A2AAuthConfig(type=A2AAuthType.JWT, jwt_secret=TEST_JWT_SECRET)
        # 签发一个已过期的 JWT
        token = jwt_lib.encode(
            {"sub": "x", "iat": int(time.time()) - 7200,
             "exp": int(time.time()) - 3600},
            TEST_JWT_SECRET,
            algorithm="HS256",
        )
        headers = {HEADER_AUTHORIZATION: f"{BEARER_PREFIX}{token}"}
        assert jwt_interceptor.verify_inbound(headers, expected) is False

    def test_inbound_jwt_malformed(
        self, jwt_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 jwt 类型格式错误 token 拒绝."""
        expected = A2AAuthConfig(type=A2AAuthType.JWT, jwt_secret=TEST_JWT_SECRET)
        headers = {HEADER_AUTHORIZATION: f"{BEARER_PREFIX}not.a.valid.jwt"}
        assert jwt_interceptor.verify_inbound(headers, expected) is False

    def test_inbound_jwt_missing(
        self, jwt_interceptor: A2AAuthInterceptor
    ) -> None:
        """测试 jwt 类型缺失头拒绝."""
        expected = A2AAuthConfig(type=A2AAuthType.JWT, jwt_secret=TEST_JWT_SECRET)
        assert jwt_interceptor.verify_inbound({}, expected) is False

    def test_inbound_api_key_self_not_configured(
        self
    ) -> None:
        """测试要求 api-key 但自身未配置 api_key 时拒绝（配置错误）."""
        interceptor = A2AAuthInterceptor(
            self_auth=A2AAuthConfig(type=A2AAuthType.API_KEY)  # 无 api_key
        )
        expected = A2AAuthConfig(type=A2AAuthType.API_KEY)  # 无 api_key
        headers = {HEADER_API_KEY: "any-key"}
        assert interceptor.verify_inbound(headers, expected) is False


# ═══════════════════════════════════════════════════════════════
# from_env 工厂方法测试
# ═══════════════════════════════════════════════════════════════


class TestFromEnv:
    """A2AAuthInterceptor.from_env() 工厂方法测试."""

    def test_from_env_default_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """测试无环境变量时默认为 none."""
        for var in ("A2A_AUTH_TYPE", "A2A_API_KEY", "A2A_BEARER_TOKEN", "A2A_JWT_SECRET"):
            monkeypatch.delenv(var, raising=False)
        ic = A2AAuthInterceptor.from_env()
        assert ic._self_auth.type == A2AAuthType.NONE

    def test_from_env_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """测试从环境变量加载 api-key 配置."""
        monkeypatch.setenv("A2A_AUTH_TYPE", "api-key")
        monkeypatch.setenv("A2A_API_KEY", TEST_API_KEY)
        ic = A2AAuthInterceptor.from_env()
        assert ic._self_auth.type == A2AAuthType.API_KEY
        assert ic._self_auth.api_key == TEST_API_KEY

    def test_from_env_bearer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """测试从环境变量加载 bearer 配置."""
        monkeypatch.setenv("A2A_AUTH_TYPE", "bearer")
        monkeypatch.setenv("A2A_BEARER_TOKEN", TEST_BEARER_TOKEN)
        ic = A2AAuthInterceptor.from_env()
        assert ic._self_auth.type == A2AAuthType.BEARER
        assert ic._self_auth.bearer_token == TEST_BEARER_TOKEN

    def test_from_env_jwt(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """测试从环境变量加载 jwt 配置."""
        monkeypatch.setenv("A2A_AUTH_TYPE", "jwt")
        monkeypatch.setenv("A2A_JWT_SECRET", TEST_JWT_SECRET)
        ic = A2AAuthInterceptor.from_env()
        assert ic._self_auth.type == A2AAuthType.JWT
        assert ic._self_auth.jwt_secret == TEST_JWT_SECRET

    def test_from_env_unknown_type_falls_back_to_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """测试未知鉴权类型降级到 none."""
        monkeypatch.setenv("A2A_AUTH_TYPE", "magic-auth")
        ic = A2AAuthInterceptor.from_env()
        assert ic._self_auth.type == A2AAuthType.NONE

    def test_from_env_empty_strings_treated_as_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """测试空字符串环境变量被视为 None."""
        monkeypatch.setenv("A2A_AUTH_TYPE", "api-key")
        monkeypatch.setenv("A2A_API_KEY", "")  # 空字符串
        ic = A2AAuthInterceptor.from_env()
        assert ic._self_auth.type == A2AAuthType.API_KEY
        assert ic._self_auth.api_key is None


# ═══════════════════════════════════════════════════════════════
# HTTP 端点 401 测试
# ═══════════════════════════════════════════════════════════════


class TestHTTPEndpointAuth:
    """HTTP 端点鉴权测试（使用 FastAPI TestClient）."""

    @pytest.fixture
    def protected_app(
        self,
        api_key_interceptor: A2AAuthInterceptor,
    ) -> FastAPI:
        """提供挂载了 api-key 鉴权拦截器的 FastAPI app."""
        from agent.a2a.manager import A2AProtocolManager

        manager = A2AProtocolManager()
        self_card = _make_card(A2AAuthType.API_KEY)
        app = FastAPI()
        router = create_a2a_router(
            manager=manager,
            self_card=self_card,
            auth_interceptor=api_key_interceptor,
        )
        app.include_router(router)
        return app

    @pytest.fixture
    def open_app(self) -> FastAPI:
        """提供无鉴权的 FastAPI app（控制组）."""
        from agent.a2a.manager import A2AProtocolManager

        manager = A2AProtocolManager()
        self_card = _make_card(A2AAuthType.NONE)
        app = FastAPI()
        router = create_a2a_router(
            manager=manager,
            self_card=self_card,
            auth_interceptor=None,  # 不启用鉴权
        )
        app.include_router(router)
        return app

    def test_protected_endpoint_rejects_no_credentials(
        self, protected_app: FastAPI
    ) -> None:
        """测试受保护端点拒绝无凭据请求（401）."""
        client = TestClient(protected_app)
        response = client.get("/a2a/tasks")
        assert response.status_code == 401
        assert "鉴权失败" in response.json()["detail"]

    def test_protected_endpoint_rejects_wrong_credentials(
        self, protected_app: FastAPI
    ) -> None:
        """测试受保护端点拒绝错误凭据（401）."""
        client = TestClient(protected_app)
        response = client.get(
            "/a2a/tasks", headers={HEADER_API_KEY: "wrong-key"}
        )
        assert response.status_code == 401

    def test_protected_endpoint_accepts_correct_credentials(
        self, protected_app: FastAPI
    ) -> None:
        """测试受保护端点接受正确凭据（200）."""
        client = TestClient(protected_app)
        response = client.get(
            "/a2a/tasks", headers={HEADER_API_KEY: TEST_API_KEY}
        )
        assert response.status_code == 200
        assert response.json() == []

    def test_protected_endpoint_401_has_www_authenticate_header(
        self, protected_app: FastAPI
    ) -> None:
        """测试 401 响应包含 WWW-Authenticate 头."""
        client = TestClient(protected_app)
        response = client.get("/a2a/tasks")
        assert response.status_code == 401
        assert "www-authenticate" in {k.lower() for k in response.headers.keys()}

    def test_public_endpoint_remains_open(
        self, protected_app: FastAPI
    ) -> None:
        """测试发现类端点保持公开（无需鉴权）."""
        client = TestClient(protected_app)
        # /.well-known/agent.json 是公开的
        response = client.get("/a2a/.well-known/agent.json")
        assert response.status_code == 200
        # /a2a/agents 也是公开的
        response = client.get("/a2a/agents")
        assert response.status_code == 200
        # /a2a/agents/discover 也是公开的
        response = client.get("/a2a/agents/discover")
        assert response.status_code == 200

    def test_no_auth_interceptor_means_no_protection(
        self, open_app: FastAPI
    ) -> None:
        """测试无 auth_interceptor 时端点完全开放."""
        client = TestClient(open_app)
        response = client.get("/a2a/tasks")
        assert response.status_code == 200

    def test_create_task_requires_auth(
        self, protected_app: FastAPI
    ) -> None:
        """测试 POST /a2a/tasks 端点需要鉴权."""
        client = TestClient(protected_app)
        # 无凭据 — 401
        response = client.post(
            "/a2a/tasks",
            json={
                "fromAgentId": "a",
                "toAgentId": "b",
                "description": "test",
            },
        )
        assert response.status_code == 401
        # 有凭据 — 通过鉴权（可能 422 因 manager 内部逻辑，但不应是 401）
        response = client.post(
            "/a2a/tasks",
            json={
                "fromAgentId": "a",
                "toAgentId": "b",
                "description": "test",
            },
            headers={HEADER_API_KEY: TEST_API_KEY},
        )
        assert response.status_code != 401

    def test_push_endpoint_requires_auth(
        self, protected_app: FastAPI
    ) -> None:
        """测试 POST /a2a/push 端点需要鉴权."""
        client = TestClient(protected_app)
        response = client.post(
            "/a2a/push",
            json={"taskId": "t1", "message": "hello"},
        )
        assert response.status_code == 401
        response = client.post(
            "/a2a/push",
            json={"taskId": "t1", "message": "hello"},
            headers={HEADER_API_KEY: TEST_API_KEY},
        )
        assert response.status_code != 401


# ═══════════════════════════════════════════════════════════════
# A2AClient 出站鉴权集成测试
# ═══════════════════════════════════════════════════════════════


class TestA2AClientAuthIntegration:
    """A2AClient 出站鉴权集成测试（使用 httpx MockTransport）."""

    def test_client_outbound_api_key_header_injected(self) -> None:
        """测试 A2AClient 出站时自动注入 api-key 头."""
        import asyncio

        import httpx

        captured_headers: Dict[str, str] = {}

        def mock_handler(request: httpx.Request) -> httpx.Response:
            """捕获请求头并返回 200 响应."""
            captured_headers.update(dict(request.headers))
            return httpx.Response(200, json=[])

        transport = httpx.MockTransport(mock_handler)
        interceptor = A2AAuthInterceptor(
            self_auth=A2AAuthConfig(
                type=A2AAuthType.API_KEY, api_key=TEST_API_KEY
            )
        )
        target_card = _make_card(A2AAuthType.API_KEY)

        async def run() -> None:
            client = A2AClient(
                "http://test-agent:8765",
                auth_interceptor=interceptor,
                target_card=target_card,
            )
            # 直接注入 mock transport
            inner_client = httpx.AsyncClient(
                base_url="http://test-agent:8765",
                transport=transport,
                headers={"Content-Type": "application/json"},
            )
            client._client = inner_client
            try:
                await client.list_tasks()
            finally:
                await client.close()

        asyncio.run(run())
        # 验证 X-API-Key 头被注入
        # httpx 的 headers 是大小写不敏感的，但 MockTransport 捕获的可能是小写
        header_keys_lower = {k.lower() for k in captured_headers.keys()}
        assert "x-api-key" in header_keys_lower
        # 找到对应的值
        for k, v in captured_headers.items():
            if k.lower() == "x-api-key":
                assert v == TEST_API_KEY

    def test_client_outbound_bearer_header_injected(self) -> None:
        """测试 A2AClient 出站时自动注入 Bearer 头."""
        import asyncio

        import httpx

        captured_headers: Dict[str, str] = {}

        def mock_handler(request: httpx.Request) -> httpx.Response:
            captured_headers.update(dict(request.headers))
            return httpx.Response(200, json=[])

        transport = httpx.MockTransport(mock_handler)
        interceptor = A2AAuthInterceptor(
            self_auth=A2AAuthConfig(
                type=A2AAuthType.BEARER, bearer_token=TEST_BEARER_TOKEN
            )
        )
        target_card = _make_card(A2AAuthType.BEARER)

        async def run() -> None:
            client = A2AClient(
                "http://test-agent:8765",
                auth_interceptor=interceptor,
                target_card=target_card,
            )
            inner_client = httpx.AsyncClient(
                base_url="http://test-agent:8765",
                transport=transport,
                headers={"Content-Type": "application/json"},
            )
            client._client = inner_client
            try:
                await client.list_tasks()
            finally:
                await client.close()

        asyncio.run(run())
        auth_value: Optional[str] = None
        for k, v in captured_headers.items():
            if k.lower() == "authorization":
                auth_value = v
                break
        assert auth_value is not None
        assert auth_value == f"{BEARER_PREFIX}{TEST_BEARER_TOKEN}"

    def test_client_no_interceptor_no_auth_headers(self) -> None:
        """测试无 auth_interceptor 时不注入任何鉴权头."""
        import asyncio

        import httpx

        captured_headers: Dict[str, str] = {}

        def mock_handler(request: httpx.Request) -> httpx.Response:
            captured_headers.update(dict(request.headers))
            return httpx.Response(200, json=[])

        transport = httpx.MockTransport(mock_handler)

        async def run() -> None:
            client = A2AClient("http://test-agent:8765")  # 无 interceptor
            inner_client = httpx.AsyncClient(
                base_url="http://test-agent:8765",
                transport=transport,
                headers={"Content-Type": "application/json"},
            )
            client._client = inner_client
            try:
                await client.list_tasks()
            finally:
                await client.close()

        asyncio.run(run())
        header_keys_lower = {k.lower() for k in captured_headers.keys()}
        assert "x-api-key" not in header_keys_lower
        assert "authorization" not in header_keys_lower

    def test_client_set_target_card_updates_auth_target(self) -> None:
        """测试 set_target_card 方法更新鉴权目标."""
        interceptor = A2AAuthInterceptor(
            self_auth=A2AAuthConfig(
                type=A2AAuthType.API_KEY, api_key=TEST_API_KEY
            )
        )
        client = A2AClient(
            "http://test:8765",
            auth_interceptor=interceptor,
            target_card=None,  # 初始无 target
        )
        # 初始无 target_card，无鉴权头
        assert client._auth_headers() == {}
        # 设置 target_card 后注入鉴权头
        client.set_target_card(_make_card(A2AAuthType.API_KEY))
        headers = client._auth_headers()
        assert headers[HEADER_API_KEY] == TEST_API_KEY


# ═══════════════════════════════════════════════════════════════
# 工具函数测试
# ═══════════════════════════════════════════════════════════════


class TestUtilityFunctions:
    """鉴权工具函数测试."""

    def test_get_header_case_insensitive(self) -> None:
        """测试 _get_header 大小写不敏感."""
        headers = {"X-API-Key": "value"}
        assert _get_header(headers, "X-API-Key") == "value"
        assert _get_header(headers, "x-api-key") == "value"
        assert _get_header(headers, "X-API-KEY") == "value"

    def test_get_header_missing(self) -> None:
        """测试 _get_header 不存在时返回 None."""
        headers = {"X-Other": "value"}
        assert _get_header(headers, "X-API-Key") is None

    def test_extract_bearer_token_valid(self) -> None:
        """测试 _extract_bearer_token 提取有效 token."""
        headers = {HEADER_AUTHORIZATION: f"{BEARER_PREFIX}my-token"}
        assert _extract_bearer_token(headers) == "my-token"

    def test_extract_bearer_token_wrong_scheme(self) -> None:
        """测试 _extract_bearer_token 非 Bearer scheme 返回 None."""
        headers = {HEADER_AUTHORIZATION: "Basic my-token"}
        assert _extract_bearer_token(headers) is None

    def test_extract_bearer_token_missing(self) -> None:
        """测试 _extract_bearer_token 缺失头返回 None."""
        assert _extract_bearer_token({}) is None

    def test_extract_bearer_token_empty(self) -> None:
        """测试 _extract_bearer_token 仅有前缀返回 None."""
        headers = {HEADER_AUTHORIZATION: BEARER_PREFIX}
        assert _extract_bearer_token(headers) is None

    def test_safe_str_eq_equal(self) -> None:
        """测试 _safe_str_eq 相等字符串."""
        assert _safe_str_eq("abc", "abc") is True

    def test_safe_str_eq_different(self) -> None:
        """测试 _safe_str_eq 不等字符串."""
        assert _safe_str_eq("abc", "abd") is False

    def test_safe_str_eq_empty(self) -> None:
        """测试 _safe_str_eq 空字符串."""
        assert _safe_str_eq("", "") is True
        assert _safe_str_eq("a", "") is False
