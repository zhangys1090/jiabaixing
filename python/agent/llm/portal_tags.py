"""Nous Portal OAuth 标签管理。

为 Nous Portal 提供 OAuth 认证标签（tags）管理：
  - OAuth 2.0 令牌获取与刷新
  - 标签（Tags）绑定与权限控制
  - 多 Portal 端点管理
  - 标签继承与组合
  - 访问控制列表（ACL）
  - 审计日志

与 DashboardAuth 的关系：
  - DashboardAuth 管理 Dashboard 访问认证
  - PortalTags 管理 Nous Portal 的 OAuth 标签
  - 两者可共享密钥但职责分离

集成示例::

    from agent.llm.portal_tags import PortalTagManager

    mgr = PortalTagManager(client_id="my-app", client_secret="...")
    mgr.register_portal("nous-prod", "https://nous.example.com", tags=["gpt-4o", "claude-3"])

    token = await mgr.get_token("nous-prod")
    tags = mgr.get_tags("nous-prod")
    allowed = mgr.check_access("nous-prod", "user-123", tag="gpt-4o")
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

log = StructuredLogger("portal_tags")




class TokenStatus(str, Enum):
    """令牌状态。"""

    VALID = "valid"
    EXPIRED = "expired"
    REVOKED = "revoked"
    UNKNOWN = "unknown"


@dataclass
class OAuthToken:
    """OAuth 2.0 令牌。

    Attributes:
        access_token: 访问令牌。
        token_type: 令牌类型。
        expires_at: 过期时间戳。
        scope: 授权范围。
        portal_id: 所属 Portal ID。
        refresh_token: 刷新令牌。
    """

    access_token: str
    token_type: str = "Bearer"
    expires_at: float = 0.0
    scope: str = ""
    portal_id: str = ""
    refresh_token: str = ""

    @property
    def is_expired(self) -> bool:
        """是否已过期。"""
        return time.time() >= self.expires_at

    @property
    def status(self) -> TokenStatus:
        """令牌状态。"""
        if self.is_expired:
            return TokenStatus.EXPIRED
        return TokenStatus.VALID


@dataclass
class PortalEndpoint:
    """Portal 端点配置。

    Attributes:
        portal_id: Portal 唯一标识。
        base_url: 基础 URL。
        token_url: 令牌获取 URL。
        tags: 可用标签列表。
        acl: 访问控制列表。
        metadata: 附加元数据。
    """

    portal_id: str
    base_url: str
    token_url: str = ""
    tags: list[str] = field(default_factory=list)
    acl: dict[str, list[str]] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.token_url:
            self.token_url = f"{self.base_url.rstrip('/')}/oauth/token"


@dataclass
class TagBinding:
    """标签绑定。

    Attributes:
        tag: 标签名称。
        entity_type: 实体类型（user / group / role）。
        entity_id: 实体 ID。
        granted_by: 授权者。
        granted_at: 授权时间。
        expires_at: 过期时间（0 表示永不过期）。
    """

    tag: str
    entity_type: str
    entity_id: str
    granted_by: str = ""
    granted_at: float = 0.0
    expires_at: float = 0.0

    def __post_init__(self) -> None:
        if self.granted_at == 0.0:
            self.granted_at = time.time()

    @property
    def is_expired(self) -> bool:
        """是否已过期。"""
        if self.expires_at == 0.0:
            return False
        return time.time() >= self.expires_at


@dataclass
class AccessCheckResult:
    """访问检查结果。

    Attributes:
        allowed: 是否允许。
        portal_id: Portal ID。
        tag: 请求的标签。
        entity_id: 实体 ID。
        reason: 原因说明。
    """

    allowed: bool
    portal_id: str
    tag: str
    entity_id: str
    reason: str = ""


class PortalTagManager:
    """Nous Portal OAuth 标签管理器。

    管理 OAuth 令牌获取/刷新、标签绑定与访问控制。
    """

    def __init__(
        self,
        client_id: str = "",
        client_secret: str = "",
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._portals: dict[str, PortalEndpoint] = {}
        self._tokens: dict[str, OAuthToken] = {}
        self._bindings: list[TagBinding] = []
        self._audit: list[dict[str, Any]] = []
        self._max_audit = 500

    def register_portal(
        self,
        portal_id: str,
        base_url: str,
        tags: list[str] | None = None,
        acl: dict[str, list[str]] | None = None,
        token_url: str = "",
    ) -> PortalEndpoint:
        """注册 Portal 端点。

        Args:
            portal_id: Portal 唯一标识。
            base_url: 基础 URL。
            tags: 可用标签列表。
            acl: 访问控制列表（entity_id → tags）。
            token_url: 令牌获取 URL。

        Returns:
            PortalEndpoint 注册的端点配置。
        """
        portal = PortalEndpoint(
            portal_id=portal_id,
            base_url=base_url,
            token_url=token_url,
            tags=tags or [],
            acl=acl or {},
        )
        self._portals[portal_id] = portal
        log.debug("Portal registered", portal_id=portal_id, tags=portal.tags)
        return portal

    def unregister_portal(self, portal_id: str) -> None:
        """注销 Portal 端点。"""
        self._portals.pop(portal_id, None)
        self._tokens.pop(portal_id, None)

    async def get_token(self, portal_id: str) -> OAuthToken | None:
        """获取 OAuth 令牌。

        若已有有效令牌则直接返回，否则尝试获取新令牌。

        Args:
            portal_id: Portal ID。

        Returns:
            OAuthToken 或 None。
        """
        existing = self._tokens.get(portal_id)
        if existing and not existing.is_expired:
            return existing

        portal = self._portals.get(portal_id)
        if portal is None:
            log.warning("Portal not found", portal_id=portal_id)
            return None

        try:
            token = await self._fetch_token(portal)
            if token:
                self._tokens[portal_id] = token
                log.info("Token obtained", portal_id=portal_id)
            return token
        except Exception as e:
            log.warning("Token fetch failed", portal_id=portal_id, error=str(e))
            return None

    async def refresh_token(self, portal_id: str) -> OAuthToken | None:
        """刷新 OAuth 令牌。

        Args:
            portal_id: Portal ID。

        Returns:
            新的 OAuthToken 或 None。
        """
        existing = self._tokens.get(portal_id)
        if not existing or not existing.refresh_token:
            return await self.get_token(portal_id)

        portal = self._portals.get(portal_id)
        if portal is None:
            return None

        try:
            token = await self._fetch_token(
                portal, refresh_token=existing.refresh_token
            )
            if token:
                self._tokens[portal_id] = token
                log.info("Token refreshed", portal_id=portal_id)
            return token
        except Exception as e:
            log.warning("Token refresh failed", portal_id=portal_id, error=str(e))
            return None

    def get_tags(self, portal_id: str) -> list[str]:
        """获取 Portal 可用标签。

        Args:
            portal_id: Portal ID。

        Returns:
            标签列表。
        """
        portal = self._portals.get(portal_id)
        return portal.tags if portal else []

    def bind_tag(
        self,
        portal_id: str,
        tag: str,
        entity_type: str,
        entity_id: str,
        granted_by: str = "",
        expires_at: float = 0.0,
    ) -> TagBinding:
        """绑定标签到实体。

        Args:
            portal_id: Portal ID。
            tag: 标签名称。
            entity_type: 实体类型。
            entity_id: 实体 ID。
            granted_by: 授权者。
            expires_at: 过期时间。

        Returns:
            TagBinding 绑定记录。
        """
        portal = self._portals.get(portal_id)
        if portal and tag not in portal.tags:
            portal.tags.append(tag)

        binding = TagBinding(
            tag=tag,
            entity_type=entity_type,
            entity_id=entity_id,
            granted_by=granted_by,
            expires_at=expires_at,
        )
        self._bindings.append(binding)
        self._record_audit("bind", portal_id, tag, entity_id)
        return binding

    def unbind_tag(
        self, portal_id: str, tag: str, entity_type: str, entity_id: str
    ) -> None:
        """解绑标签。"""
        self._bindings = [
            b
            for b in self._bindings
            if not (b.tag == tag and b.entity_type == entity_type and b.entity_id == entity_id)
        ]
        self._record_audit("unbind", portal_id, tag, entity_id)

    def check_access(
        self, portal_id: str, entity_id: str, tag: str = ""
    ) -> AccessCheckResult:
        """检查实体对标签的访问权限。

        Args:
            portal_id: Portal ID。
            entity_id: 实体 ID。
            tag: 请求的标签（空表示检查 Portal 级访问）。

        Returns:
            AccessCheckResult 检查结果。
        """
        portal = self._portals.get(portal_id)
        if portal is None:
            return AccessCheckResult(
                allowed=False,
                portal_id=portal_id,
                tag=tag,
                entity_id=entity_id,
                reason="Portal not found",
            )

        if not tag:
            return AccessCheckResult(
                allowed=True,
                portal_id=portal_id,
                tag=tag,
                entity_id=entity_id,
            )

        acl_tags = portal.acl.get(entity_id, [])
        if tag in acl_tags:
            return AccessCheckResult(
                allowed=True,
                portal_id=portal_id,
                tag=tag,
                entity_id=entity_id,
            )

        binding = next(
            (
                b
                for b in self._bindings
                if b.tag == tag
                and b.entity_id == entity_id
                and not b.is_expired
            ),
            None,
        )
        if binding:
            return AccessCheckResult(
                allowed=True,
                portal_id=portal_id,
                tag=tag,
                entity_id=entity_id,
            )

        self._record_audit("deny", portal_id, tag, entity_id)
        return AccessCheckResult(
            allowed=False,
            portal_id=portal_id,
            tag=tag,
            entity_id=entity_id,
            reason=f"No access to tag '{tag}'",
        )

    def get_entity_tags(self, entity_id: str) -> list[str]:
        """获取实体绑定的所有有效标签。

        Args:
            entity_id: 实体 ID。

        Returns:
            有效标签列表。
        """
        return list({
            b.tag for b in self._bindings if b.entity_id == entity_id and not b.is_expired
        })

    def get_audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        """获取审计日志。"""
        return self._audit[-limit:]

    async def _fetch_token(
        self, portal: PortalEndpoint, refresh_token: str = ""
    ) -> OAuthToken | None:
        """从 Portal 获取 OAuth 令牌。

        实际实现需要 HTTP 请求，这里提供框架。
        """
        try:
            import httpx

            data: dict[str, Any] = {
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            }
            if refresh_token:
                data["grant_type"] = "refresh_token"
                data["refresh_token"] = refresh_token
            else:
                data["grant_type"] = "client_credentials"

            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(portal.token_url, data=data)
                resp.raise_for_status()
                result = resp.json()

                return OAuthToken(
                    access_token=result["access_token"],
                    token_type=result.get("token_type", "Bearer"),
                    expires_at=time.time() + result.get("expires_in", 3600),
                    scope=result.get("scope", ""),
                    portal_id=portal.portal_id,
                    refresh_token=result.get("refresh_token", ""),
                )
        except ImportError:
            log.warning("httpx not available, token fetch skipped")
            return None
        except Exception as e:
            log.warning("Token fetch error", error=str(e))
            return None

    def _record_audit(
        self, action: str, portal_id: str, tag: str, entity_id: str
    ) -> None:
        """记录审计日志。"""
        entry = {
            "action": action,
            "portal_id": portal_id,
            "tag": tag,
            "entity_id": entity_id,
            "ts": time.time(),
        }
        self._audit.append(entry)
        if len(self._audit) > self._max_audit:
            self._audit = self._audit[-self._max_audit:]
