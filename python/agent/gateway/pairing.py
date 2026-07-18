"""配对授权（DM 配对授权）。

管理用户与 Agent 的 DM（私聊）配对授权：
  - 配对请求与审批流程
  - 配对状态管理（pending/approved/revoked）
  - 自动配对规则（基于用户角色/群组）
  - 配对过期与续期
  - 配对审计日志

与网关的关系：
  - 入站 DM 消息先检查配对授权
  - 未授权的 DM 返回配对请求提示
  - 已授权的 DM 正常处理

集成示例::

    from agent.gateway.pairing import PairingAuth

    auth = PairingAuth()
    auth.add_auto_approve_rule(AutoApproveRule(role="admin"))
    request = auth.request_pairing(user_id="u123", platform="slack")
    auth.approve(request.id)
    assert auth.is_authorized("u123", "slack")
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.pairing")


class PairingStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    REVOKED = "revoked"
    EXPIRED = "expired"


@dataclass
class PairingRequest:
    id: str
    user_id: str
    platform: str
    chat_id: str = ""
    display_name: str = ""
    reason: str = ""
    status: PairingStatus = PairingStatus.PENDING
    requested_at: float = 0.0
    resolved_at: float = 0.0
    resolved_by: str = ""
    expires_at: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())
        if self.requested_at == 0.0:
            self.requested_at = time.time()

    @property
    def is_expired(self) -> bool:
        return self.expires_at > 0 and time.time() > self.expires_at


@dataclass
class PairingRecord:
    user_id: str
    platform: str
    chat_id: str = ""
    approved_at: float = 0.0
    approved_by: str = ""
    expires_at: float = 0.0
    last_activity: float = 0.0
    message_count: int = 0
    auto_approved: bool = False

    @property
    def is_expired(self) -> bool:
        return self.expires_at > 0 and time.time() > self.expires_at


@dataclass
class AutoApproveRule:
    role: str = ""
    platform: str = ""
    group_id: str = ""
    max_pairs: int = 100
    ttl_seconds: float = 0


@dataclass
class PairingAuditEntry:
    timestamp: float
    action: str
    user_id: str
    platform: str
    details: str = ""


class PairingAuth:
    """DM 配对授权管理器。

    管理用户与 Agent 的 DM 配对授权流程。
    """

    def __init__(self, default_ttl: float = 86400 * 30) -> None:
        self._requests: dict[str, PairingRequest] = {}
        self._pairings: dict[str, PairingRecord] = {}
        self._auto_rules: list[AutoApproveRule] = []
        self._audit: list[PairingAuditEntry] = []
        self._default_ttl = default_ttl

    def _pairing_key(self, user_id: str, platform: str) -> str:
        return f"{platform}:{user_id}"

    def add_auto_approve_rule(self, rule: AutoApproveRule) -> None:
        self._auto_rules.append(rule)
        log.info("自动配对规则已添加", role=rule.role, platform=rule.platform)

    def request_pairing(
        self,
        user_id: str,
        platform: str,
        chat_id: str = "",
        display_name: str = "",
        reason: str = "",
        user_role: str = "",
        user_groups: list[str] | None = None,
    ) -> PairingRequest:
        key = self._pairing_key(user_id, platform)
        existing = self._pairings.get(key)
        if existing and not existing.is_expired:
            return PairingRequest(
                id="already_authorized",
                user_id=user_id,
                platform=platform,
                chat_id=chat_id,
                status=PairingStatus.APPROVED,
            )

        req = PairingRequest(
            user_id=user_id,
            platform=platform,
            chat_id=chat_id,
            display_name=display_name,
            reason=reason,
        )

        auto_approved = False
        for rule in self._auto_rules:
            if rule.role and rule.role != user_role:
                continue
            if rule.platform and rule.platform != platform:
                continue
            if rule.group_id and user_groups and rule.group_id not in user_groups:
                continue
            auto_approved = True
            break

        if auto_approved:
            req.status = PairingStatus.APPROVED
            req.resolved_at = time.time()
            req.resolved_by = "auto"
            ttl = next((r.ttl_seconds for r in self._auto_rules if r.role == user_role), self._default_ttl)
            self._pairings[key] = PairingRecord(
                user_id=user_id,
                platform=platform,
                chat_id=chat_id,
                approved_at=time.time(),
                approved_by="auto",
                expires_at=time.time() + ttl if ttl > 0 else 0,
                auto_approved=True,
            )
            self._audit_append("auto_approve", user_id, platform, f"role={user_role}")
            log.info("配对自动授权", user=user_id, platform=platform)
        else:
            self._requests[req.id] = req
            self._audit_append("request", user_id, platform, reason)
            log.info("配对请求已创建", id=req.id, user=user_id, platform=platform)

        return req

    def approve(self, request_id: str, approved_by: str = "", ttl: float = 0) -> bool:
        req = self._requests.get(request_id)
        if req is None or req.status != PairingStatus.PENDING:
            return False

        req.status = PairingStatus.APPROVED
        req.resolved_at = time.time()
        req.resolved_by = approved_by

        key = self._pairing_key(req.user_id, req.platform)
        effective_ttl = ttl or self._default_ttl
        self._pairings[key] = PairingRecord(
            user_id=req.user_id,
            platform=req.platform,
            chat_id=req.chat_id,
            approved_at=time.time(),
            approved_by=approved_by,
            expires_at=time.time() + effective_ttl if effective_ttl > 0 else 0,
        )
        self._requests.pop(request_id, None)
        self._audit_append("approve", req.user_id, req.platform, f"by={approved_by}")
        log.info("配对已授权", user=req.user_id, platform=req.platform, by=approved_by)
        return True

    def reject(self, request_id: str, rejected_by: str = "") -> bool:
        req = self._requests.get(request_id)
        if req is None or req.status != PairingStatus.PENDING:
            return False
        req.status = PairingStatus.REJECTED
        req.resolved_at = time.time()
        req.resolved_by = rejected_by
        self._requests.pop(request_id, None)
        self._audit_append("reject", req.user_id, req.platform, f"by={rejected_by}")
        return True

    def revoke(self, user_id: str, platform: str, revoked_by: str = "") -> bool:
        key = self._pairing_key(user_id, platform)
        record = self._pairings.pop(key, None)
        if record is None:
            return False
        self._audit_append("revoke", user_id, platform, f"by={revoked_by}")
        log.info("配对已撤销", user=user_id, platform=platform)
        return True

    def is_authorized(self, user_id: str, platform: str) -> bool:
        key = self._pairing_key(user_id, platform)
        record = self._pairings.get(key)
        if record is None:
            return False
        if record.is_expired:
            self._pairings.pop(key)
            return False
        record.last_activity = time.time()
        record.message_count += 1
        return True

    def get_pending_requests(self) -> list[dict[str, Any]]:
        return [
            {
                "id": r.id,
                "user_id": r.user_id,
                "platform": r.platform,
                "display_name": r.display_name,
                "reason": r.reason,
                "requested_at": r.requested_at,
            }
            for r in self._requests.values()
            if r.status == PairingStatus.PENDING
        ]

    def get_active_pairings(self) -> list[dict[str, Any]]:
        return [
            {
                "user_id": p.user_id,
                "platform": p.platform,
                "chat_id": p.chat_id,
                "approved_at": p.approved_at,
                "auto": p.auto_approved,
                "message_count": p.message_count,
            }
            for p in self._pairings.values()
            if not p.is_expired
        ]

    def _audit_append(self, action: str, user_id: str, platform: str, details: str = "") -> None:
        self._audit.append(PairingAuditEntry(
            timestamp=time.time(),
            action=action,
            user_id=user_id,
            platform=platform,
            details=details,
        ))
        if len(self._audit) > 10000:
            self._audit = self._audit[-5000:]

    def get_stats(self) -> dict[str, Any]:
        return {
            "pending_requests": len([r for r in self._requests.values() if r.status == PairingStatus.PENDING]),
            "active_pairings": len([p for p in self._pairings.values() if not p.is_expired]),
            "total_audit": len(self._audit),
        }
