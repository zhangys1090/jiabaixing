from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("permission_guard")


class Permission(str, Enum):
    """工具操作权限枚举。

    定义系统支持的所有权限类型，每个工具调用需要具备对应的权限。
    """

    MEMORY_READ = "memory:read"
    MEMORY_WRITE = "memory:write"
    FILE_READ = "file:read"
    FILE_WRITE = "file:write"
    CODE_EXECUTE = "code:execute"
    NETWORK_ACCESS = "network:access"
    DESKTOP_CONTROL = "desktop:control"
    SYSTEM_ADMIN = "system:admin"


RiskLevel = str

RISK_ORDER: list[RiskLevel] = ["low", "medium", "high", "critical"]
RISK_CONFIRMATION_MAP: dict[RiskLevel, bool] = {
    "low": False, "medium": False, "high": True, "critical": True,
}

DEFAULT_PERMISSIONS: list[Permission] = [
    Permission.MEMORY_READ, Permission.MEMORY_WRITE,
    Permission.FILE_READ, Permission.FILE_WRITE,
    Permission.CODE_EXECUTE, Permission.NETWORK_ACCESS,
]

ADMIN_PERMISSIONS: list[Permission] = [
    *DEFAULT_PERMISSIONS,
    Permission.DESKTOP_CONTROL, Permission.NETWORK_ACCESS,
    Permission.SYSTEM_ADMIN,
]

ToolAccessPolicy = str


@dataclass
class PermissionCheckResult:
    """权限检查结果。

    Attributes:
        allowed: 是否允许执行。
        missing: 缺失的权限列表。
        reason: 拒绝原因（allowed=False时）。
        needs_confirmation: 是否需要用户确认。
        policy: 当前生效的策略（allow/deny/ask）。
    """

    allowed: bool
    missing: list[Permission] = field(default_factory=list)
    reason: str = ""
    needs_confirmation: bool = False
    policy: ToolAccessPolicy = "allow"


@dataclass
class ToolPolicyEntry:
    """单个工具的策略配置。

    Attributes:
        tool_name: 工具名称，支持 * 通配符。
        policy: 策略类型（allow/deny/ask）。
        reason: 策略设置原因。
        expires_at: 过期时间戳（0表示永不过期）。
    """

    tool_name: str
    policy: ToolAccessPolicy = "allow"
    reason: str = ""
    expires_at: float = 0.0


@dataclass
class AuditEntry:
    """审计日志条目。

    Attributes:
        timestamp: 事件时间戳。
        trace_id: 追踪ID。
        tool_name: 工具名称。
        allowed: 是否被允许。
        reason: 拒绝/允许原因。
        risk_level: 风险等级。
    """

    timestamp: float
    trace_id: str
    tool_name: str
    allowed: bool
    reason: str
    risk_level: RiskLevel


@dataclass
class SessionStats:
    """会话统计信息。

    Attributes:
        tool_call_count: 工具调用总次数。
        error_count: 错误次数。
        consecutive_tool: 当前连续调用的工具名称。
        consecutive_count: 连续调用次数。
    """

    tool_call_count: int = 0
    error_count: int = 0
    consecutive_tool: str | None = None
    consecutive_count: int = 0


@dataclass
class SessionLimits:
    """会话限制配置。

    Attributes:
        max_tool_calls: 单个会话最大工具调用次数。
        max_consecutive_same: 同一工具最大连续调用次数。
        auto_stop_threshold: 错误次数达到阈值时自动停止。
        risk_threshold: 风险等级阈值，超过需确认。
    """

    max_tool_calls: int = 100
    max_consecutive_same: int = 5
    auto_stop_threshold: int = 5
    risk_threshold: RiskLevel = "high"


@dataclass
class ToolContext:
    """工具调用上下文。

    Attributes:
        user_id: 用户标识。
        trace_id: 追踪ID。
        session_id: 会话ID。
        permissions: 当前会话已授予的权限集合。
        metadata: 附加元数据。
    """

    user_id: str = ""
    trace_id: str = ""
    session_id: str = ""
    permissions: set[Permission] = field(default_factory=set)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolResult:
    """工具执行结果。

    Attributes:
        success: 是否执行成功。
        output: 输出文本。
        error: 错误信息（失败时）。
        duration: 执行耗时（毫秒）。
        metadata: 附加元数据。
    """

    success: bool
    output: str = ""
    error: str | None = None
    duration: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


class PermissionGuard:
    """工具权限守卫。

    负责工具调用的权限检查、风险管控、会话限制和审计追踪。
    支持通配符策略匹配、会话统计、自动停止和审计日志。

    Usage:
        guard = PermissionGuard()
        ctx = ToolContext(user_id="user1", session_id="s1")
        result = guard.check("shell_exec", [Permission.CODE_EXECUTE], "high", ctx)
        if result.needs_confirmation:
            ...  # 等待用户确认
    """

    def __init__(self) -> None:
        self._user_permissions: dict[str, set[Permission]] = {}
        self._pending_confirmations: dict[str, dict[str, Any]] = {}
        self._tool_policies: dict[str, ToolPolicyEntry] = {}
        self._session_stats: dict[str, SessionStats] = {}
        self._session_limits: dict[str, SessionLimits] = {}
        self._audit_trail: list[AuditEntry] = []
        self._load_default_policies()

    def _load_default_policies(self) -> None:
        for tool in ["shell_exec", "desktop_automate", "multi_file_edit"]:
            self._tool_policies[tool] = ToolPolicyEntry(tool_name=tool, policy="ask")

    def check(
        self,
        tool_name: str,
        required_permissions: list[Permission],
        risk_level: RiskLevel,
        context: ToolContext,
    ) -> PermissionCheckResult:
        """检查工具调用是否被允许。

        依次检查：会话调用上限 → 连续调用上限 → 工具策略 → 权限 → 风险阈值。

        Args:
            tool_name: 工具名称。
            required_permissions: 执行该工具所需的权限列表。
            risk_level: 操作风险等级（low/medium/high/critical）。
            context: 工具调用上下文。

        Returns:
            PermissionCheckResult: 包含是否允许、是否需要确认等信息的检查结果。
        """
        session_id = context.session_id or "default"
        trace_id = context.trace_id or "unknown"

        stats = self._get_or_create_stats(session_id)
        limits = self._get_or_create_limits(session_id)

        if stats.tool_call_count >= limits.max_tool_calls:
            self._record_audit(trace_id, tool_name, False, f"会话工具调用已达上限 ({limits.max_tool_calls})", risk_level)
            return PermissionCheckResult(allowed=False, reason=f"会话工具调用已达上限 ({limits.max_tool_calls})")

        if stats.consecutive_tool == tool_name and stats.consecutive_count >= limits.max_consecutive_same:
            self._record_audit(trace_id, tool_name, False, f"连续调用 {tool_name} 已达上限", risk_level)
            return PermissionCheckResult(allowed=False, reason=f"连续调用 {tool_name} 已达上限 ({limits.max_consecutive_same})")

        policy = self._get_effective_policy(tool_name)
        if policy.policy == "deny":
            reason = policy.reason or "工具已被禁用"
            self._record_audit(trace_id, tool_name, False, reason, risk_level)
            return PermissionCheckResult(allowed=False, reason=reason, policy="deny")

        missing: list[Permission] = []
        for perm in required_permissions:
            if perm not in context.permissions:
                missing.append(perm)
        if missing:
            reason = f"缺少权限: {', '.join(p.value for p in missing)}"
            log.warning("权限不足", tool=tool_name, missing=reason)
            self._record_audit(trace_id, tool_name, False, reason, risk_level)
            return PermissionCheckResult(allowed=False, missing=missing, reason=reason)

        risk_index = RISK_ORDER.index(risk_level) if risk_level in RISK_ORDER else 0
        threshold_index = RISK_ORDER.index(limits.risk_threshold) if limits.risk_threshold in RISK_ORDER else 0
        if risk_index >= threshold_index and policy.policy != "allow":
            self._record_audit(trace_id, tool_name, False, f"风险超过阈值: {risk_level}", risk_level)
            return PermissionCheckResult(allowed=False, reason=f"需要确认: {risk_level} 风险操作", needs_confirmation=True, policy="ask")

        needs_confirmation = policy.policy == "ask" or RISK_CONFIRMATION_MAP.get(risk_level, False)
        if needs_confirmation:
            log.info("需确认", tool=tool_name, risk=risk_level)

        self._record_audit(trace_id, tool_name, True, "等待确认" if needs_confirmation else "权限检查通过", risk_level)
        return PermissionCheckResult(allowed=True, needs_confirmation=needs_confirmation, policy=policy.policy)

    def record_execution(self, session_id: str, tool_name: str, result: ToolResult) -> None:
        """记录一次工具执行结果，更新会话统计。

        Args:
            session_id: 会话ID。
            tool_name: 工具名称。
            result: 工具执行结果。
        """
        stats = self._get_or_create_stats(session_id)
        stats.tool_call_count += 1

        if stats.consecutive_tool == tool_name:
            stats.consecutive_count += 1
        else:
            stats.consecutive_tool = tool_name
            stats.consecutive_count = 1

        if not result.success:
            stats.error_count += 1
            limits = self._get_or_create_limits(session_id)
            if stats.error_count >= limits.auto_stop_threshold:
                log.warning("错误次数已达阈值", threshold=limits.auto_stop_threshold)

    def set_tool_policy(self, tool_name: str, policy: ToolAccessPolicy, reason: str = "", expires_in_ms: int = 0) -> None:
        """设置工具访问策略。

        Args:
            tool_name: 工具名称，支持 * 通配符。
            policy: 策略（allow/deny/ask）。
            reason: 设置原因。
            expires_in_ms: 过期时间（毫秒），0表示永不过期。
        """
        self._tool_policies[tool_name] = ToolPolicyEntry(
            tool_name=tool_name,
            policy=policy,
            reason=reason,
            expires_at=(time.time() + expires_in_ms / 1000) if expires_in_ms else 0.0,
        )
        log.info("工具策略", tool=tool_name, policy=policy)

    def set_session_limits(self, session_id: str, **limits: Any) -> None:
        """设置会话级别的限制参数。

        Args:
            session_id: 会话ID。
            **limits: 限制参数，如 max_tool_calls=50。
        """
        current = self._get_or_create_limits(session_id)
        for key, value in limits.items():
            if hasattr(current, key):
                setattr(current, key, value)
        self._session_limits[session_id] = current

    def get_user_permissions(self, user_id: str) -> set[Permission]:
        """获取用户的权限集合，首次访问自动分配默认权限。

        Args:
            user_id: 用户标识。

        Returns:
            set[Permission]: 用户的权限集合。
        """
        if user_id not in self._user_permissions:
            self._user_permissions[user_id] = set(DEFAULT_PERMISSIONS)
        return self._user_permissions[user_id]

    def grant_permission(self, user_id: str, permission: Permission) -> None:
        """授予用户指定权限。

        Args:
            user_id: 用户标识。
            permission: 要授予的权限。
        """
        self.get_user_permissions(user_id).add(permission)
        log.info("授予权限", permission=permission.value, user=user_id)

    def revoke_permission(self, user_id: str, permission: Permission) -> None:
        """撤销用户指定权限。

        Args:
            user_id: 用户标识。
            permission: 要撤销的权限。
        """
        self.get_user_permissions(user_id).discard(permission)
        log.info("撤销权限", permission=permission.value, user=user_id)

    def set_admin(self, user_id: str) -> None:
        """将用户提升为管理员，分配全部权限。

        Args:
            user_id: 用户标识。
        """
        self._user_permissions[user_id] = set(ADMIN_PERMISSIONS)
        log.info("管理员", user=user_id)

    def get_session_status(self, session_id: str) -> dict[str, Any]:
        """获取会话的运行时状态。

        Args:
            session_id: 会话ID。

        Returns:
            dict: 包含 tool_call_count / error_count / consecutive_tool 等字段。
        """
        stats = self._get_or_create_stats(session_id)
        limits = self._get_or_create_limits(session_id)
        return {
            "tool_call_count": stats.tool_call_count,
            "error_count": stats.error_count,
            "consecutive_tool": stats.consecutive_tool,
            "consecutive_count": stats.consecutive_count,
            "max_tool_calls": limits.max_tool_calls,
        }

    def get_audit_trail(self, limit: int = 0) -> list[AuditEntry]:
        """获取审计日志。

        Args:
            limit: 返回条数限制，0表示全部。

        Returns:
            list[AuditEntry]: 审计日志列表。
        """
        if limit:
            return self._audit_trail[-limit:]
        return list(self._audit_trail)

    def reset_session(self, session_id: str) -> None:
        """重置会话的统计和限制数据。

        Args:
            session_id: 会话ID。
        """
        self._session_stats.pop(session_id, None)
        self._session_limits.pop(session_id, None)

    def _get_effective_policy(self, tool_name: str) -> ToolPolicyEntry:
        """获取工具的有效策略，支持通配符匹配和过期检查。

        Args:
            tool_name: 工具名称。

        Returns:
            ToolPolicyEntry: 匹配的策略条目，默认返回allow。
        """
        policy = self._tool_policies.get(tool_name)
        if not policy:
            for key, entry in self._tool_policies.items():
                if key.endswith("*") and tool_name.startswith(key[:-1]):
                    policy = entry
                    break
        if policy and policy.expires_at and time.time() > policy.expires_at:
            del self._tool_policies[tool_name]
            policy = None
        return policy or ToolPolicyEntry(tool_name=tool_name, policy="allow")

    def _get_or_create_stats(self, session_id: str) -> SessionStats:
        if session_id not in self._session_stats:
            self._session_stats[session_id] = SessionStats()
        return self._session_stats[session_id]

    def _get_or_create_limits(self, session_id: str) -> SessionLimits:
        if session_id not in self._session_limits:
            self._session_limits[session_id] = SessionLimits()
        return self._session_limits[session_id]

    def _record_audit(self, trace_id: str, tool_name: str, allowed: bool, reason: str, risk_level: RiskLevel) -> None:
        self._audit_trail.append(AuditEntry(
            timestamp=time.time(),
            trace_id=trace_id,
            tool_name=tool_name,
            allowed=allowed,
            reason=reason,
            risk_level=risk_level,
        ))
