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
    # 递归删除根目录：必须同时覆盖合并短选项(-rf/-fr)、分离短选项(-r -f)、
    # 长选项(--recursive --force)与 sudo/前置其它选项的组合。
    # 注意：曾有一版"改进"写成 (-[rR].*-[fF]|-[fF].*-[rR])，要求两个独立选项，
    # 反而漏掉了最常见的 `rm -rf /` / `rm -rf /*` / `sudo rm -rf /`（fail-open 回归）。
    (r"\brm\b\s+(?:-{1,2}[\w-]+\s+)*-{1,2}[\w-]*[rR][\w-]*\s+(?:-{1,2}[\w-]+\s+)*/(?:\s|$|\*)",
     "危险删除命令"),
    (r"del\s+/[sS]", "危险删除命令"),
    (r"rmdir\s+/[sS]", "危险删除目录"),
    (r"format\s+[cC]:", "格式化磁盘"),
    # 关机：命令位出现即拦截（覆盖 `shutdown now` / 裸 `shutdown` / `sudo shutdown`），
    # 同时保留带选项的内嵌形式（如 ssh host 'shutdown -h now'）。
    # 散文中的 "graceful shutdown of the service" 不在命令位，不会误报。
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
]

_SENSITIVE_PATTERNS = [
    (r"(?:password|passwd|pwd)\s*[=:]\s*\S+", "密码泄露"),
    (r"(?:api[_-]?key|secret[_-]?key)\s*[=:]\s*\S+", "API密钥泄露"),
    (r"(?:token|auth)\s*[=:]\s*\S{20,}", "认证令牌泄露"),
    (r"\b\d{16,19}\b", "银行卡号"),
    (r"验证码[：:\s]*\d{4,8}", "验证码泄露"),
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
        self._max_audit_log_size: int = 10000

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
                risk_level="critical",
                warnings=warnings,
                blocked_reasons=blocked,
            )

        risk = "high" if warnings else "low"
        self._audit({"action": "command_checked", "risk": risk, "warnings": warnings})
        return SecurityCheckResult(allowed=True, risk_level=risk, warnings=warnings)

    def check_output(self, text: str, block_on_sensitive: bool = True) -> SecurityCheckResult:
        """检查输出文本安全性，检测敏感信息泄露。

        默认 fail-closed：命中敏感信息即 ``allowed=False``，由调用方决定脱敏或拒答。
        若调用方只想拿到提示而自行处理，可显式传 ``block_on_sensitive=False`` 降级为警告模式。

        Note:
            本方法当前在 agent 包内**无调用点**（孤儿能力）。实际接线的输出安全检查是
            ``agent/verification/service.py::check_output_safety``。二者职责重叠，
            后续应择一收口，详见审计报告 §1.8 W4。

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
                    risk_level="high",
                    warnings=hits,
                    blocked_reasons=hits,
                )
            self._audit({"action": "output_warning", "reasons": hits})
            return SecurityCheckResult(
                allowed=True,
                risk_level="high",
                warnings=hits,
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
        if len(self._audit_log) > self._max_audit_log_size:
            self._audit_log = self._audit_log[-(self._max_audit_log_size // 2):]
