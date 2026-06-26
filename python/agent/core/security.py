from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Permission:
    name: str
    description: str = ""
    risk_level: str = "low"


DEFAULT_PERMISSIONS = [
    Permission("memory_read", "读取记忆", "low"),
    Permission("memory_write", "写入记忆", "low"),
    Permission("file_read", "读取文件", "low"),
    Permission("file_write", "写入文件", "medium"),
    Permission("code_execute", "执行代码", "high"),
    Permission("network_access", "网络访问", "medium"),
    Permission("desktop_control", "桌面控制", "critical"),
    Permission("system_admin", "系统管理", "critical"),
]

_DANGEROUS_PATTERNS = [
    (r"rm\s+-rf\s+/", "危险删除命令"),
    (r"del\s+/[sS]", "危险删除命令"),
    (r"format\s+[cC]:", "格式化磁盘"),
    (r"shutdown", "关机命令"),
    (r"reboot", "重启命令"),
    (r"mkfs", "格式化文件系统"),
    (r">\s*/dev/sd", "设备写入"),
    (r"curl\s+.*\|\s*sh", "远程脚本执行"),
    (r"wget\s+.*\|\s*sh", "远程脚本执行"),
]

_SENSITIVE_PATTERNS = [
    (r"(?:password|passwd|pwd)\s*[=:]\s*\S+", "密码泄露"),
    (r"(?:api[_-]?key|secret[_-]?key)\s*[=:]\s*\S+", "API密钥泄露"),
    (r"(?:token|auth)\s*[=:]\s*\S{20,}", "认证令牌泄露"),
    (r"\b\d{16,19}\b", "银行卡号"),
    (r"\b\d{6}\b", "验证码"),
]


@dataclass
class SecurityCheckResult:
    allowed: bool
    risk_level: str = "low"
    warnings: list[str] = field(default_factory=list)
    blocked_reasons: list[str] = field(default_factory=list)


class SecurityGuard:
    def __init__(self) -> None:
        self._user_permissions: dict[str, set[str]] = {}
        self._audit_log: list[dict[str, Any]] = []

    def check_command(self, command: str) -> SecurityCheckResult:
        warnings: list[str] = []
        blocked: list[str] = []

        for pattern, desc in _DANGEROUS_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE):
                blocked.append(desc)

        for pattern, desc in _SENSITIVE_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE):
                warnings.append(desc)

        if blocked:
            self._audit({"action": "command_blocked", "command": command[:100], "reasons": blocked})
            return SecurityCheckResult(
                allowed=False,
                risk_level="critical",
                warnings=warnings,
                blocked_reasons=blocked,
            )

        risk = "high" if warnings else "low"
        self._audit({"action": "command_checked", "risk": risk, "warnings": warnings})
        return SecurityCheckResult(allowed=True, risk_level=risk, warnings=warnings)

    def check_output(self, text: str) -> SecurityCheckResult:
        warnings: list[str] = []
        blocked: list[str] = []

        for pattern, desc in _SENSITIVE_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                blocked.append(desc)

        if blocked:
            self._audit({"action": "output_blocked", "reasons": blocked})
            return SecurityCheckResult(
                allowed=False,
                risk_level="high",
                blocked_reasons=blocked,
            )

        return SecurityCheckResult(allowed=True, risk_level="low")

    def check_permission(self, user_id: str, permission: str) -> bool:
        perms = self._user_permissions.get(user_id, set())
        if not perms:
            default = {p.name for p in DEFAULT_PERMISSIONS if p.risk_level in ("low", "medium")}
            self._user_permissions[user_id] = default
            perms = default
        return permission in perms

    def grant_permission(self, user_id: str, permission: str) -> None:
        if user_id not in self._user_permissions:
            self._user_permissions[user_id] = {p.name for p in DEFAULT_PERMISSIONS if p.risk_level in ("low", "medium")}
        self._user_permissions[user_id].add(permission)
        self._audit({"action": "permission_granted", "user_id": user_id, "permission": permission})

    def revoke_permission(self, user_id: str, permission: str) -> None:
        if user_id in self._user_permissions:
            self._user_permissions[user_id].discard(permission)
        self._audit({"action": "permission_revoked", "user_id": user_id, "permission": permission})

    def get_audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        return self._audit_log[-limit:]

    def _audit(self, entry: dict[str, Any]) -> None:
        import time
        entry["timestamp"] = time.time()
        self._audit_log.append(entry)
