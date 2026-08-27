"""CommandGuard — 命令/输出安全检查 + 用户权限管理。

原 core/security.py，重命名消除与 agent.security 包的命名冲突。
Capability 已移至 agent.core.types，此模块仅保留命令检查逻辑。

提供三层安全防护：
1. 命令检查：检测危险命令模式（rm -rf、远程脚本执行等）
2. 输出检查：检测敏感信息泄露（密码、API Key、银行卡号等）
3. 权限管理：基于用户的细粒度权限控制（使用 core.types.Capability）

Usage:
    guard = CommandGuard()
    result = guard.check_command("rm -rf /")
    if not result.allowed:
        logger.info("被阻止: {result.blocked_reasons}")
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from agent.core.types import Capability, RiskLevel, DEFAULT_CAPABILITIES
import logging
logger = logging.getLogger(__name__)


_DANGEROUS_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\brm\b\s+(?:-{1,2}[\w-]+\s+)*-{1,2}[\w-]*[rR][\w-]*\s+(?:-{1,2}[\w-]+\s+)*/(?:\s|$|\*)",
     "危险删除命令"),
    (r"del\s+/[sS]", "危险删除命令"),
    (r"rmdir\s+/[sS]", "危险删除目录"),
    (r"format\s+[cC]:", "格式化磁盘"),
    (r"(?:^|[\n;&|]\s*)(?:sudo\s+)?(?:shutdown|poweroff)\b", "关机命令"),
    (r"\bshutdown\b\s+(?:-[hPrsft]|/[srhpfta]|now|\+\d+)", "关机命令"),
    (r"(?:^|[\n;&|]\s*)(?:sudo\s+)?init\s+0\b", "关机命令"),
    (r"\bsystemctl\s+(?:poweroff|halt|reboot)\b", "关机/重启命令"),
    (r"\breboot\b", "重启命令"),
    (r"\bmkfs\b", "格式化文件系统"),
    (r">\s*/dev/sd", "设备写入"),
    (r"\bcurl\b.*\|\s*(ba)?sh", "远程脚本执行"),
    (r"\bwget\b.*\|\s*(ba)?sh", "远程脚本执行"),
    (r"\bchmod\b\s+[0-7]*77[0-7]\s+/", "危险权限修改"),
    (r"\bdd\b\s+.*of=/dev/", "设备直接写入"),
    (r":\(\)\{\s*:\|:&\s*\};:", "fork炸弹"),
    (r"\bRemove-Item\b.*-Recurse", "PowerShell危险删除"),
    (r"\bStop-Computer\b", "PowerShell关机"),
    (r"\bRestart-Computer\b", "PowerShell重启"),
    (r"\bSet-ExecutionPolicy\b\s+Unrestricted", "PowerShell执行策略降级"),
    (r"\bInvoke-Expression\b", "PowerShell动态执行"),
    (r"\bStart-Process\b.*-Verb\s+RunAs", "PowerShell提权执行"),
    (r"\bnetsh\b.*firewall.*disable", "防火墙禁用"),
    (r"\breg\b.*delete\s+HKLM", "注册表危险删除"),
)

_SENSITIVE_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"(?:password|passwd|pwd)\s*[=:]\s*\S+", "密码泄露"),
    (r"(?:api[_-]?key|secret[_-]?key)\s*[=:]\s*\S+", "API密钥泄露"),
    (r"(?:token|auth)\s*[=:]\s*\S{20,}", "认证令牌泄露"),
    (r"\b\d{16,19}\b", "银行卡号"),
    (r"验证码[：:\s]*\d{4,8}", "验证码泄露"),
)


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
    risk_level: RiskLevel = RiskLevel.LOW
    warnings: list[str] = field(default_factory=list)
    blocked_reasons: list[str] = field(default_factory=list)


class CommandGuard:
    """命令守卫 — 命令/输出安全检查 + 用户权限管理。

    提供三层安全防护：
    1. 命令检查：检测危险命令模式（rm -rf、远程脚本执行等）
    2. 输出检查：检测敏感信息泄露（密码、API Key、银行卡号等）
    3. 权限管理：基于用户的细粒度权限控制

    Usage:
        guard = CommandGuard()
        result = guard.check_command("rm -rf /")
        if not result.allowed:
            logger.info("被阻止: {result.blocked_reasons}")
    """

    def __init__(self) -> None:
        self._user_permissions: dict[str, set[str]] = {}
        self._audit_log: list[dict[str, Any]] = []
        self._max_audit_log_size: int = 10000
        self._max_users: int = 5000
        self._user_access: dict[str, float] = {}

    def _trim_users(self) -> None:
        if len(self._user_permissions) <= self._max_users:
            return
        sorted_users = sorted(self._user_access.items(), key=lambda x: x[1])
        to_remove = sorted_users[: len(self._user_permissions) - (self._max_users * 3 // 4)]
        for uid, _ in to_remove:
            self._user_permissions.pop(uid, None)
            self._user_access.pop(uid, None)

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
            if re.search(pattern, command, re.IGNORECASE) and desc not in blocked:
                blocked.append(desc)

        for pattern, desc in _SENSITIVE_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE) and desc not in warnings:
                warnings.append(desc)

        if blocked:
            self._audit({"action": "command_blocked", "command": command[:100], "reasons": blocked})
            return SecurityCheckResult(
                allowed=False,
                risk_level=RiskLevel.CRITICAL,
                warnings=warnings,
                blocked_reasons=blocked,
            )

        risk = RiskLevel.HIGH if warnings else RiskLevel.LOW
        self._audit({"action": "command_checked", "risk": risk.value, "warnings": warnings})
        return SecurityCheckResult(allowed=True, risk_level=risk, warnings=warnings)

    def check_output(self, text: str, block_on_sensitive: bool = True) -> SecurityCheckResult:
        """检查输出文本安全性，检测敏感信息泄露。

        默认 fail-closed：命中敏感信息即 ``allowed=False``，由调用方决定脱敏或拒答。
        若调用方只想拿到提示而自行处理，可显式传 ``block_on_sensitive=False`` 降级为警告模式。

        Args:
            text: 待检查的输出文本。
            block_on_sensitive: 命中敏感信息时是否阻止输出，默认 True（阻止）。

        Returns:
            SecurityCheckResult: 检查结果，含敏感信息警告/阻止原因。
        """
        hits: list[str] = []

        for pattern, desc in _SENSITIVE_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE) and desc not in hits:
                hits.append(desc)

        if hits:
            if block_on_sensitive:
                self._audit({"action": "output_blocked", "reasons": hits})
                return SecurityCheckResult(
                    allowed=False,
                    risk_level=RiskLevel.HIGH,
                    warnings=hits,
                    blocked_reasons=hits,
                )
            self._audit({"action": "output_warning", "reasons": hits})
            return SecurityCheckResult(
                allowed=True,
                risk_level=RiskLevel.HIGH,
                warnings=hits,
            )

        return SecurityCheckResult(allowed=True, risk_level=RiskLevel.LOW)

    def check_permission(self, user_id: str, permission: str) -> bool:
        import time as _time
        perms = self._user_permissions.get(user_id, set())
        if not perms:
            default = {p.name for p in DEFAULT_CAPABILITIES if p.risk_level in (RiskLevel.LOW, RiskLevel.MEDIUM)}
            self._user_permissions[user_id] = default
            perms = default
        self._user_access[user_id] = _time.time()
        self._trim_users()
        return permission in perms

    def grant_permission(self, user_id: str, permission: str) -> None:
        """授予用户指定权限。

        Args:
            user_id: 用户 ID。
            permission: 权限名称。
        """
        if user_id not in self._user_permissions:
            self._user_permissions[user_id] = {p.name for p in DEFAULT_CAPABILITIES if p.risk_level in (RiskLevel.LOW, RiskLevel.MEDIUM)}
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
        if len(self._audit_log) > self._max_audit_log_size:
            self._audit_log = self._audit_log[-(self._max_audit_log_size * 3 // 4):]


SecurityGuard = CommandGuard
