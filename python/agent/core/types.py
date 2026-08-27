"""V6.0 unified type definitions - eliminate cross-module redundancy.

Authoritative types shared across modules:
- Permission: unified permission enum (was tools/permission_guard.Permission)
- RiskLevel: unified risk level enum
- PermissionCheckResult: unified permission check result
- ToolAccessPolicy: unified tool access policy type
- Capability: command guard capability (was core/security.py Capability)
- BaseAuditEntry / BaseAuditFinding / BaseAuditReport: unified audit protocol
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Permission(str, Enum):
    """工具操作权限枚举 — 系统唯一权威定义。

    所有模块必须从此处导入 Permission，不得自行定义。
    """

    MEMORY_READ = "memory:read"
    MEMORY_WRITE = "memory:write"
    FILE_READ = "file:read"
    FILE_WRITE = "file:write"
    CODE_EXECUTE = "code:execute"
    NETWORK_ACCESS = "network:access"
    DESKTOP_CONTROL = "desktop:control"
    SYSTEM_ADMIN = "system:admin"


class RiskLevel(str, Enum):
    """风险等级枚举 — 系统唯一权威定义。

    所有模块必须从此处导入 RiskLevel，不得自行定义。
    不同领域的 RiskLevel 语义变体（如 action_sandbox 的
    ALLOWED/CAUTION/RESTRICTED/BLOCKED）应通过映射函数转换。
    """

    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


RISK_ORDER: list[RiskLevel] = [RiskLevel.NONE, RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL]

RISK_CONFIRMATION_MAP: dict[RiskLevel, bool] = {
    RiskLevel.NONE: False,
    RiskLevel.LOW: False,
    RiskLevel.MEDIUM: False,
    RiskLevel.HIGH: True,
    RiskLevel.CRITICAL: True,
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
    """权限检查结果 — 系统唯一权威定义。

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
class Capability:
    """能力定义 — 系统唯一权威定义。

    Attributes:
        name: 能力名称。
        description: 能力描述。
        risk_level: 风险等级。
    """

    name: str
    description: str = ""
    risk_level: RiskLevel = RiskLevel.LOW


DEFAULT_CAPABILITIES = [
    Capability("memory_read", "读取记忆", RiskLevel.LOW),
    Capability("memory_write", "写入记忆", RiskLevel.LOW),
    Capability("file_read", "读取文件", RiskLevel.LOW),
    Capability("file_write", "写入文件", RiskLevel.MEDIUM),
    Capability("code_execute", "执行代码", RiskLevel.HIGH),
    Capability("network_access", "网络访问", RiskLevel.MEDIUM),
    Capability("desktop_control", "桌面控制", RiskLevel.CRITICAL),
    Capability("system_admin", "系统管理", RiskLevel.CRITICAL),
]


@dataclass
class BaseAuditEntry:
    """审计日志条目 — 系统唯一权威基类。"""

    timestamp: float = field(default_factory=time.time)
    source: str = ""
    action: str = ""
    target: str = ""
    result: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class BaseAuditFinding:
    """审计发现 — 系统唯一权威基类。"""

    severity: RiskLevel = RiskLevel.LOW
    category: str = ""
    message: str = ""
    remediation: str = ""
    timestamp: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class BaseAuditReport:
    """审计报告 — 系统唯一权威基类。"""

    timestamp: float = field(default_factory=time.time)
    findings: list[BaseAuditFinding] = field(default_factory=list)
    overall_status: str = "healthy"

    @property
    def has_critical(self) -> bool:
        return any(f.severity == RiskLevel.CRITICAL for f in self.findings)

    @property
    def has_warnings(self) -> bool:
        return any(f.severity in (RiskLevel.HIGH, RiskLevel.CRITICAL) for f in self.findings)


@dataclass
class BaseCheckpoint:
    """还原点 — 系统唯一权威基类。

    所有领域的 Checkpoint（safety/persistence/evolution/loop/desktop）
    应继承此基类，确保核心字段一致。
    """

    id: str = ""
    label: str = ""
    timestamp: float = field(default_factory=time.time)
    restored: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


import functools
import logging as _logging

_type_check_log = _logging.getLogger(__name__)


def runtime_type_check(**param_types: type):
    """运行时类型校验装饰器 — 验证函数参数类型。

    用法:
        @runtime_type_check(name=str, count=int)
        def foo(name, count): ...

    校验失败时抛出 TypeError 而非静默通过，确保接口契约。
    """

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            import inspect
            sig = inspect.signature(func)
            bound = sig.bind(*args, **kwargs)
            bound.apply_defaults()
            for param_name, expected_type in param_types.items():
                if param_name not in bound.arguments:
                    continue
                value = bound.arguments[param_name]
                if not isinstance(value, expected_type):
                    raise TypeError(
                        f"{func.__qualname__}: 参数 '{param_name}' 期望 "
                        f"{expected_type.__name__}，实际 {type(value).__name__}"
                    )
            return func(*args, **kwargs)

        return wrapper

    return decorator


def runtime_range_check(**param_ranges: tuple):
    """运行时范围校验装饰器 — 验证数值参数在合法范围内。

    用法:
        @runtime_range_check(threshold=(0.0, 1.0), count=(0, 100))
        def foo(threshold, count): ...
    """

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            import inspect
            sig = inspect.signature(func)
            bound = sig.bind(*args, **kwargs)
            bound.apply_defaults()
            for param_name, (lo, hi) in param_ranges.items():
                if param_name not in bound.arguments:
                    continue
                value = bound.arguments[param_name]
                if not (lo <= value <= hi):
                    raise ValueError(
                        f"{func.__qualname__}: 参数 '{param_name}'={value} "
                        f"超出合法范围 [{lo}, {hi}]"
                    )
            return func(*args, **kwargs)

        return wrapper

    return decorator


import warnings as _warnings


def deprecated(replacement: str = "", removal_version: str = ""):
    """废弃标记装饰器 — 标记将被移除的函数/类，调用时发出 DeprecationWarning。

    用法:
        @deprecated(replacement="new_func", removal_version="7.0")
        def old_func(): ...
    """

    def decorator(obj):
        msg_parts = [f"{obj.__name__} 已废弃"]
        if replacement:
            msg_parts.append(f"请使用 {replacement}")
        if removal_version:
            msg_parts.append(f"将在 v{removal_version} 移除")
        msg = "，".join(msg_parts) + "。"

        if isinstance(obj, type):
            original_init = obj.__init__

            def __init__(self, *args, **kwargs):
                _warnings.warn(msg, DeprecationWarning, stacklevel=2)
                original_init(self, *args, **kwargs)

            obj.__init__ = __init__
            obj.__deprecated_msg__ = msg
            return obj
        else:
            @functools.wraps(obj)
            def wrapper(*args, **kwargs):
                _warnings.warn(msg, DeprecationWarning, stacklevel=2)
                return obj(*args, **kwargs)

            wrapper.__deprecated_msg__ = msg
            return wrapper

    return decorator
