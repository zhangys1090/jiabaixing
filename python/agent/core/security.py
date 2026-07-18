from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Permission:
    """权限定义。

    Attributes:
        name: 权限名称。
        description: 权限描述。
        risk_level: 风险等级（low / medium / high / critical）。
    """

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
    """安全检查结果。

    Attributes:
        allowed: 是否允许操作。
        risk_level: 风险等级。
        warnings: 警告信息列表。
        blocked_reasons: 阻止原因列表。
    """

    allowed: bool
    risk_level: str = "low"
    warnings: list[str] = field(default_factory=list)
    blocked_reasons: list[str] = field(default_factory=list)


class SecurityGuard:
    """安全守卫 — 命令/输出安全检查 + 用户权限管理。

    提供三层安全防护：
    1. 命令检查：检测危险命令模式（rm -rf、远程脚本执行等）
    2. 输出检查：检测敏感信息泄露（密码、API Key、银行卡号等）
    3. 权限管理：基于用户的细粒度权限控制

    Usage:
        guard = SecurityGuard()
        result = guard.check_command("rm -rf /")
        if not result.allowed:
            print(f"被阻止: {result.blocked_reasons}")
    """

    def __init__(self) -> None:
        """初始化安全守卫。"""
        self._user_permissions: dict[str, set[str]] = {}
        self._audit_log: list[dict[str, Any]] = []

    def check_command(self, command: str) -> SecurityCheckResult:
        """检查命令安全性，检测危险命令和敏感信息。

        Args:
            command: 待检查的命令字符串。

        Returns:
            SecurityCheckResult: 检查结果，含阻止原因和警告。
        """
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
        """检查输出文本安全性，检测敏感信息泄露。

        Args:
            text: 待检查的输出文本。

        Returns:
            SecurityCheckResult: 检查结果，含敏感信息阻止原因。
        """
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
        """检查用户是否拥有指定权限。

        新用户默认拥有 low 和 medium 级别的权限。

        Args:
            user_id: 用户 ID。
            permission: 权限名称。

        Returns:
            bool: 是否拥有该权限。
        """
        perms = self._user_permissions.get(user_id, set())
        if not perms:
            default = {p.name for p in DEFAULT_PERMISSIONS if p.risk_level in ("low", "medium")}
            self._user_permissions[user_id] = default
            perms = default
        return permission in perms

    def grant_permission(self, user_id: str, permission: str) -> None:
        """授予用户指定权限。

        Args:
            user_id: 用户 ID。
            permission: 权限名称。
        """
        if user_id not in self._user_permissions:
            self._user_permissions[user_id] = {p.name for p in DEFAULT_PERMISSIONS if p.risk_level in ("low", "medium")}
        self._user_permissions[user_id].add(permission)
        self._audit({"action": "permission_granted", "user_id": user_id, "permission": permission})

    def revoke_permission(self, user_id: str, permission: str) -> None:
        """撤销用户指定权限。

        Args:
            user_id: 用户 ID。
            permission: 权限名称。
        """
        if user_id in self._user_permissions:
            self._user_permissions[user_id].discard(permission)
        self._audit({"action": "permission_revoked", "user_id": user_id, "permission": permission})

    def get_audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        """获取安全审计日志。

        Args:
            limit: 返回的最大条目数，默认 100。

        Returns:
            list[dict]: 审计日志条目列表（按时间倒序）。
        """
        return self._audit_log[-limit:]

    def _audit(self, entry: dict[str, Any]) -> None:
        import time
        entry["timestamp"] = time.time()
        self._audit_log.append(entry)
