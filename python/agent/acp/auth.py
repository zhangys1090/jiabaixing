"""ACP 认证管理。

ACP 协议的身份认证与权限守卫：
  - API Key / Bearer Token 认证
  - 请求签名验证（HMAC-SHA256）
  - 权限级别（read / write / admin）
  - 会话级权限衰减

集成示例::

    from agent.acp.auth import ACPAuthManager

    auth = ACPAuthManager(secret_key="my-secret")
    token = auth.generate_token(user_id="user1", permissions=["read", "write"])
    result = auth.verify_token(token)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("acp.auth")


class PermissionLevel(Enum):
    """ACP 协议权限级别 — ACP 领域特化类型。

    与 core.types.Permission（工具操作枚举）语义不同：
    - core.types.Permission: 系统级工具权限（memory:read, file:write 等）
    - PermissionLevel: ACP 协议级权限（read/write/admin）

    两者不应混用。ACP 认证场景使用此类型。
    """

    READ = "read"
    WRITE = "write"
    ADMIN = "admin"


@dataclass
class ACPToken:
    token_id: str = ""
    user_id: str = ""
    permissions: list[str] = field(default_factory=list)
    created_at: float = 0.0
    expires_at: float = 0.0
    signature: str = ""


@dataclass
class AuthResult:
    valid: bool = False
    user_id: str = ""
    permissions: list[str] = field(default_factory=list)
    reason: str = ""


class ACPAuthManager:
    """ACP 认证管理器。"""

    def __init__(
        self,
        secret_key: str = "",
        token_ttl: float = 3600.0,
        api_keys: dict[str, list[str]] | None = None,
    ):
        self._secret_key = secret_key or uuid.uuid4().hex
        self._token_ttl = token_ttl
        self._api_keys: dict[str, list[str]] = api_keys or {}
        self._tokens: dict[str, ACPToken] = {}
        self._revoked: set[str] = set()

    def register_api_key(self, key: str, permissions: list[str] | None = None) -> None:
        self._api_keys[key] = permissions or [PermissionLevel.READ.value]

    def generate_token(self, user_id: str, permissions: list[str] | None = None, ttl: float | None = None) -> str:
        now = time.time()
        expires = now + (ttl or self._token_ttl)
        token_id = uuid.uuid4().hex
        payload = f"{token_id}:{user_id}:{','.join(permissions or [])}:{expires}"
        signature = self._sign(payload)
        token = ACPToken(
            token_id=token_id,
            user_id=user_id,
            permissions=permissions or [PermissionLevel.READ.value],
            created_at=now,
            expires_at=expires,
            signature=signature,
        )
        self._tokens[token_id] = token
        encoded = f"{token_id}.{self._encode_payload(payload)}.{signature}"
        log.info("Token generated", user_id=user_id, token_id=token_id)
        return encoded

    def verify_token(self, encoded: str) -> AuthResult:
        parts = encoded.split(".")
        if len(parts) != 3:
            return AuthResult(valid=False, reason="Invalid token format")
        token_id, encoded_payload, signature = parts
        if token_id in self._revoked:
            return AuthResult(valid=False, reason="Token revoked")
        token = self._tokens.get(token_id)
        if not token:
            return AuthResult(valid=False, reason="Token not found")
        if time.time() > token.expires_at:
            return AuthResult(valid=False, reason="Token expired")
        payload = self._decode_payload(encoded_payload)
        expected_sig = self._sign(payload)
        if not hmac.compare_digest(signature, expected_sig):
            return AuthResult(valid=False, reason="Invalid signature")
        return AuthResult(
            valid=True,
            user_id=token.user_id,
            permissions=token.permissions,
        )

    def verify_api_key(self, key: str) -> AuthResult:
        permissions = self._api_keys.get(key)
        if permissions is None:
            return AuthResult(valid=False, reason="Unknown API key")
        return AuthResult(valid=True, user_id="api_key", permissions=permissions)

    def check_permission(self, auth_result: AuthResult, required: str) -> bool:
        if not auth_result.valid:
            return False
        if PermissionLevel.ADMIN.value in auth_result.permissions:
            return True
        return required in auth_result.permissions

    def revoke_token(self, token_id: str) -> None:
        self._revoked.add(token_id)
        self._tokens.pop(token_id, None)
        log.info("Token revoked", token_id=token_id)

    def cleanup_expired(self) -> int:
        now = time.time()
        expired = [tid for tid, t in self._tokens.items() if now > t.expires_at]
        for tid in expired:
            self._tokens.pop(tid, None)
            self._revoked.discard(tid)
        if expired:
            log.info("Expired tokens cleaned", count=len(expired))
        return len(expired)

    def _sign(self, payload: str) -> str:
        return hmac.new(
            self._secret_key.encode("utf-8"),
            payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    @staticmethod
    def _encode_payload(payload: str) -> str:
        import base64
        return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("utf-8").rstrip("=")

    @staticmethod
    def _decode_payload(encoded: str) -> str:
        import base64
        padding = 4 - len(encoded) % 4
        if padding != 4:
            encoded += "=" * padding
        return base64.urlsafe_b64decode(encoded.encode("utf-8")).decode("utf-8")

    def get_stats(self) -> dict[str, Any]:
        return {
            "active_tokens": len(self._tokens),
            "revoked_tokens": len(self._revoked),
            "api_keys": len(self._api_keys),
        }
