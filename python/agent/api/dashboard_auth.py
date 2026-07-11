"""Dashboard 认证系统。

提供 Web Dashboard 的认证和授权：
  - 多认证方式（API Key / OAuth2 / JWT / Basic Auth）
  - 会话管理（Token 生成、刷新、撤销）
  - 角色权限控制（RBAC）
  - 速率限制（每用户每分钟请求数）
  - 审计日志

与 API Server 的关系：
  - API Server 的认证中间件
  - 保护 Dashboard 和 API 端点
  - 与 AccountUsageTracker 集成

集成示例::

    from agent.api.dashboard_auth import DashboardAuth

    auth = DashboardAuth(secret_key="my-secret")
    token = auth.create_token(user_id="admin", role="admin")
    verified = auth.verify_token(token)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("dashboard_auth")


class AuthMethod(str, Enum):
    API_KEY = "api_key"
    OAUTH2 = "oauth2"
    JWT = "jwt"
    BASIC = "basic"


class Role(str, Enum):
    ADMIN = "admin"
    USER = "user"
    VIEWER = "viewer"
    API = "api"


@dataclass
class Permission:
    resource: str
    actions: list[str] = field(default_factory=lambda: ["read"])

    def allows(self, action: str) -> bool:
        return action in self.actions or "*" in self.actions


@dataclass
class UserInfo:
    id: str
    username: str
    role: Role = Role.USER
    permissions: list[Permission] = field(default_factory=list)
    api_keys: list[str] = field(default_factory=list)
    created_at: float = 0.0
    last_login: float = 0.0
    enabled: bool = True

    def __post_init__(self) -> None:
        if self.created_at == 0.0:
            self.created_at = time.time()

    def has_permission(self, resource: str, action: str) -> bool:
        for perm in self.permissions:
            if perm.resource == resource or perm.resource == "*":
                if perm.allows(action):
                    return True
        if self.role == Role.ADMIN:
            return True
        return False


@dataclass
class Session:
    id: str
    user_id: str
    token: str
    created_at: float
    expires_at: float
    refresh_token: str = ""
    last_activity: float = 0.0
    ip_address: str = ""

    @property
    def is_expired(self) -> bool:
        return time.time() > self.expires_at


@dataclass
class AuditEntry:
    timestamp: float
    user_id: str
    action: str
    resource: str
    success: bool
    ip_address: str = ""
    details: str = ""


_ROLE_PERMISSIONS: dict[Role, list[Permission]] = {
    Role.ADMIN: [Permission(resource="*", actions=["*"])],
    Role.USER: [
        Permission(resource="sessions", actions=["read", "write"]),
        Permission(resource="skills", actions=["read", "write"]),
        Permission(resource="memory", actions=["read", "write"]),
        Permission(resource="tools", actions=["read", "execute"]),
        Permission(resource="settings", actions=["read", "write"]),
    ],
    Role.VIEWER: [
        Permission(resource="sessions", actions=["read"]),
        Permission(resource="skills", actions=["read"]),
        Permission(resource="memory", actions=["read"]),
        Permission(resource="settings", actions=["read"]),
    ],
    Role.API: [
        Permission(resource="sessions", actions=["read", "write"]),
        Permission(resource="tools", actions=["read", "execute"]),
    ],
}


class DashboardAuth:
    """Dashboard 认证管理器。

    提供用户认证、会话管理和权限控制。
    """

    def __init__(
        self,
        secret_key: str = "change-me-in-production",
        token_ttl: float = 3600,
        refresh_ttl: float = 86400 * 7,
        max_sessions_per_user: int = 5,
    ) -> None:
        self._secret = secret_key.encode()
        self._token_ttl = token_ttl
        self._refresh_ttl = refresh_ttl
        self._max_sessions = max_sessions_per_user
        self._users: dict[str, UserInfo] = {}
        self._sessions: dict[str, Session] = {}
        self._api_keys: dict[str, str] = {}
        self._rate_limits: dict[str, list[float]] = defaultdict(list)
        self._audit_log: list[AuditEntry] = []
        self._max_rpm: int = 60

    def _generate_token(self, user_id: str, extra: str = "") -> str:
        payload = f"{user_id}:{extra}:{time.time()}:{uuid.uuid4()}"
        signature = hmac.new(self._secret, payload.encode(), hashlib.sha256).hexdigest()
        return f"{hashlib.sha256(payload.encode()).hexdigest()[:32]}.{signature[:32]}"

    def create_user(
        self,
        user_id: str,
        username: str,
        role: Role = Role.USER,
        custom_permissions: list[Permission] | None = None,
    ) -> UserInfo:
        perms = custom_permissions or _ROLE_PERMISSIONS.get(role, [])
        user = UserInfo(id=user_id, username=username, role=role, permissions=perms)
        self._users[user_id] = user
        log.info("用户已创建", user_id=user_id, role=role.value)
        return user

    def create_api_key(self, user_id: str, prefix: str = "jbk") -> str:
        key = f"{prefix}_{uuid.uuid4().hex[:32]}"
        self._api_keys[key] = user_id
        if user_id in self._users:
            self._users[user_id].api_keys.append(key)
        log.info("API Key 已创建", user_id=user_id, prefix=prefix)
        return key

    def revoke_api_key(self, key: str) -> bool:
        user_id = self._api_keys.pop(key, None)
        if user_id and user_id in self._users:
            self._users[user_id].api_keys = [k for k in self._users[user_id].api_keys if k != key]
        return user_id is not None

    def create_token(self, user_id: str, role: Role | None = None, ip_address: str = "") -> Session:
        user = self._users.get(user_id)
        if user is None:
            user = self.create_user(user_id, user_id, role or Role.USER)

        token = self._generate_token(user_id)
        refresh = self._generate_token(user_id, "refresh")
        now = time.time()

        session = Session(
            id=str(uuid.uuid4()),
            user_id=user_id,
            token=token,
            created_at=now,
            expires_at=now + self._token_ttl,
            refresh_token=refresh,
            last_activity=now,
            ip_address=ip_address,
        )

        user_sessions = [s for s in self._sessions.values() if s.user_id == user_id]
        if len(user_sessions) >= self._max_sessions:
            oldest = min(user_sessions, key=lambda s: s.created_at)
            self._sessions.pop(oldest.id, None)

        self._sessions[session.id] = session
        user.last_login = now
        self._audit(f"login", user_id, "session", True, ip_address)
        return session

    def verify_token(self, token: str) -> UserInfo | None:
        for session in self._sessions.values():
            if session.token == token:
                if session.is_expired:
                    self._sessions.pop(session.id, None)
                    return None
                session.last_activity = time.time()
                return self._users.get(session.user_id)
        return None

    def verify_api_key(self, key: str) -> UserInfo | None:
        user_id = self._api_keys.get(key)
        if user_id:
            return self._users.get(user_id)
        return None

    def refresh_token(self, refresh_token: str) -> Session | None:
        for session in list(self._sessions.values()):
            if session.refresh_token == refresh_token:
                if time.time() - session.created_at > self._refresh_ttl:
                    self._sessions.pop(session.id, None)
                    return None
                self._sessions.pop(session.id, None)
                return self.create_token(session.user_id, ip_address=session.ip_address)
        return None

    def revoke_token(self, token: str) -> bool:
        for sid, session in list(self._sessions.items()):
            if session.token == token:
                self._sessions.pop(sid)
                self._audit("logout", session.user_id, "session", True)
                return True
        return False

    def check_permission(self, user_id: str, resource: str, action: str) -> bool:
        user = self._users.get(user_id)
        if user is None or not user.enabled:
            return False
        return user.has_permission(resource, action)

    def check_rate_limit(self, user_id: str) -> bool:
        now = time.time()
        timestamps = self._rate_limits[user_id]
        self._rate_limits[user_id] = [t for t in timestamps if now - t < 60]
        if len(self._rate_limits[user_id]) >= self._max_rpm:
            return False
        self._rate_limits[user_id].append(now)
        return True

    def _audit(self, action: str, user_id: str, resource: str, success: bool, ip: str = "") -> None:
        entry = AuditEntry(
            timestamp=time.time(),
            user_id=user_id,
            action=action,
            resource=resource,
            success=success,
            ip_address=ip,
        )
        self._audit_log.append(entry)
        if len(self._audit_log) > 10000:
            self._audit_log = self._audit_log[-5000:]

    def get_user(self, user_id: str) -> UserInfo | None:
        return self._users.get(user_id)

    def list_users(self) -> list[dict[str, Any]]:
        return [
            {
                "id": u.id,
                "username": u.username,
                "role": u.role.value,
                "enabled": u.enabled,
                "last_login": u.last_login,
                "api_keys": len(u.api_keys),
            }
            for u in self._users.values()
        ]

    def get_audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        entries = self._audit_log[-limit:]
        return [
            {
                "timestamp": e.timestamp,
                "user_id": e.user_id,
                "action": e.action,
                "resource": e.resource,
                "success": e.success,
                "ip": e.ip_address,
            }
            for e in entries
        ]

    def get_stats(self) -> dict[str, Any]:
        active_sessions = len([s for s in self._sessions.values() if not s.is_expired])
        return {
            "users": len(self._users),
            "active_sessions": active_sessions,
            "api_keys": len(self._api_keys),
            "audit_entries": len(self._audit_log),
        }
