"""OperationScope — 操作作用域。

限制 Agent 操作的范围，防止越界。三个维度：
1. PathScope: 限制文件操作在指定目录树内
2. PermissionScope: 限制可用权限子集
3. ResourceScope: 限制资源配额（文件数/大小/超时）

与 PermissionGuard 的关系：
- PermissionGuard 检查"能不能做"（权限）
- OperationScope 检查"在哪里做、做多少"（范围和配额）

Usage:
    from agent.safety.operation_scope import OperationScope, ScopeDefinition

    scope = OperationScope(ScopeDefinition(
        allowed_paths=["/home/user/project"],
        max_total_changes=50,
    ))
    if scope.check_path("/home/user/project/src/main.py"):
        # 允许操作
    scope.record_change("/home/user/project/src/main.py")
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("operation_scope")




@dataclass
class ScopeDefinition:
    """作用域定义。

    Attributes:
        allowed_paths: 允许操作的路径白名单（前缀匹配）。
        denied_paths: 禁止操作的路径黑名单（优先于白名单）。
        allowed_permissions: 允许的权限列表。
        max_file_size_mb: 单文件最大大小（MB）。
        max_total_changes: 最大变更文件数。
        network_allowed: 是否允许网络访问。
        timeout_seconds: 操作超时（秒）。
    """

    allowed_paths: list[str] = field(default_factory=list)
    denied_paths: list[str] = field(default_factory=list)
    allowed_permissions: list[str] = field(default_factory=lambda: [
        "memory:read", "memory:write", "file:read", "file:write",
        "code:execute", "network:access",
    ])
    max_file_size_mb: float = 100.0
    max_total_changes: int = 100
    network_allowed: bool = True
    timeout_seconds: float = 300.0


@dataclass
class ScopeViolation:
    """作用域违反记录。

    Attributes:
        kind: 违反类型（path/permission/resource/timeout）。
        detail: 违反详情。
        path: 涉及的路径（如有）。
        timestamp: 时间戳。
    """

    kind: str
    detail: str = ""
    path: str = ""
    timestamp: float = 0.0


class OperationScope:
    """操作作用域 — 限制 Agent 操作的范围和配额。

    三层防护：
    1. 路径检查：操作是否在允许的目录内
    2. 权限检查：操作是否在允许的权限内
    3. 资源检查：是否超过配额限制
    """

    _SYSTEM_CRITICAL_PATHS = [
        "/etc/passwd", "/etc/shadow", "/etc/sudoers",
        "C:\\Windows\\System32", "C:\\Windows\\SysWOW64",
    ]

    def __init__(self, definition: ScopeDefinition | None = None) -> None:
        self._def = definition or ScopeDefinition()
        self._changes: list[str] = []
        self._violations: list[ScopeViolation] = []
        self._start_time: float = time.time()

    def check_path(self, path: str) -> tuple[bool, str]:
        """检查路径是否在允许的作用域内。

        Returns:
            (allowed, reason): 是否允许及原因。
        """
        resolved = str(Path(path).resolve())

        for critical in self._SYSTEM_CRITICAL_PATHS:
            if resolved.startswith(critical) or resolved.lower().startswith(critical.lower()):
                violation = ScopeViolation(kind="path", detail="系统关键路径", path=path, timestamp=time.time())
                self._violations.append(violation)
                return False, f"系统关键路径禁止操作: {path}"

        for denied in self._def.denied_paths:
            denied_resolved = str(Path(denied).resolve())
            if resolved.startswith(denied_resolved):
                violation = ScopeViolation(kind="path", detail="黑名单路径", path=path, timestamp=time.time())
                self._violations.append(violation)
                return False, f"路径在黑名单中: {path}"

        if self._def.allowed_paths:
            in_allowed = False
            for allowed in self._def.allowed_paths:
                allowed_resolved = str(Path(allowed).resolve())
                if resolved.startswith(allowed_resolved):
                    in_allowed = True
                    break
            if not in_allowed:
                violation = ScopeViolation(kind="path", detail="白名单外路径", path=path, timestamp=time.time())
                self._violations.append(violation)
                return False, f"路径不在白名单中: {path}"

        return True, ""

    def check_permission(self, permission: str) -> tuple[bool, str]:
        """检查权限是否在允许的作用域内。"""
        if permission not in self._def.allowed_permissions:
            violation = ScopeViolation(kind="permission", detail=f"权限 {permission} 不在允许列表中", timestamp=time.time())
            self._violations.append(violation)
            return False, f"权限不允许: {permission}"
        return True, ""

    def check_file_size(self, path: str) -> tuple[bool, str]:
        """检查文件大小是否在配额内。"""
        try:
            size_mb = Path(path).stat().st_size / (1024 * 1024)
            if size_mb > self._def.max_file_size_mb:
                violation = ScopeViolation(kind="resource", detail=f"文件大小 {size_mb:.1f}MB 超过限制 {self._def.max_file_size_mb}MB", path=path, timestamp=time.time())
                self._violations.append(violation)
                return False, f"文件过大: {size_mb:.1f}MB > {self._def.max_file_size_mb}MB"
        except FileNotFoundError as _exc:
            log_ignored(log, "operation_scope.check_file_size", _exc)
        return True, ""

    def check_change_quota(self) -> tuple[bool, str]:
        """检查变更文件数是否在配额内。"""
        if len(self._changes) >= self._def.max_total_changes:
            violation = ScopeViolation(kind="resource", detail=f"变更文件数 {len(self._changes)} 超过限制 {self._def.max_total_changes}", timestamp=time.time())
            self._violations.append(violation)
            return False, f"变更文件数已达上限: {self._def.max_total_changes}"
        return True, ""

    def check_timeout(self) -> tuple[bool, str]:
        """检查是否超时。"""
        elapsed = time.time() - self._start_time
        if elapsed > self._def.timeout_seconds:
            violation = ScopeViolation(kind="timeout", detail=f"操作超时 {elapsed:.1f}s > {self._def.timeout_seconds}s", timestamp=time.time())
            self._violations.append(violation)
            return False, f"操作超时: {elapsed:.1f}s"
        return True, ""

    def record_change(self, path: str) -> tuple[bool, str]:
        """记录一次文件变更，同时检查配额。"""
        allowed, reason = self.check_path(path)
        if not allowed:
            return False, reason
        allowed, reason = self.check_change_quota()
        if not allowed:
            return False, reason
        self._changes.append(path)
        return True, ""

    @property
    def changes_count(self) -> int:
        return len(self._changes)

    @property
    def violations(self) -> list[ScopeViolation]:
        return list(self._violations)

    @property
    def definition(self) -> ScopeDefinition:
        return self._def

    def reset(self) -> None:
        self._changes.clear()
        self._violations.clear()
        self._start_time = time.time()

    def summary(self) -> dict[str, Any]:
        return {
            "changes_count": self.changes_count,
            "max_changes": self._def.max_total_changes,
            "violations_count": len(self._violations),
            "elapsed_seconds": time.time() - self._start_time,
            "timeout_seconds": self._def.timeout_seconds,
        }

    # ─── A2: 权限动态收缩 ───

    _HIGH_RISK_PERMISSIONS = {"file:write", "code:execute", "network:access", "system:modify"}
    _MEDIUM_RISK_PERMISSIONS = {"file:read", "memory:write"}

    def shrink_permissions(self, task_phase: str = "executing") -> list[str]:
        """A2: 根据任务阶段动态收缩权限，实现最小权限原则.

        任务完成后逐步收回已授予的工具权限，防止权限滥用。

        Args:
            task_phase: "planning"(规划), "executing"(执行), "verifying"(验证), "completed"(完成)

        Returns:
            被收回的权限列表
        """
        _PHASE_PERMISSIONS = {
            "planning": {"memory:read", "memory:write", "file:read"},
            "executing": None,
            "verifying": {"memory:read", "file:read", "code:execute"},
            "completed": {"memory:read", "file:read"},
        }
        target = _PHASE_PERMISSIONS.get(task_phase)
        if target is None:
            return []

        removed: list[str] = []
        for perm in list(self._def.allowed_permissions):
            if perm not in target:
                self._def.allowed_permissions.remove(perm)
                removed.append(perm)

        if removed:
            log.info("A2: permissions shrunk", phase=task_phase, removed=removed, remaining=self._def.allowed_permissions)
        return removed

    def expand_permissions(self, required: list[str]) -> list[str]:
        """A2: 按需临时扩展权限（任务需要时）.

        Returns:
            新增的权限列表
        """
        added: list[str] = []
        for perm in required:
            if perm not in self._def.allowed_permissions:
                self._def.allowed_permissions.append(perm)
                added.append(perm)
        if added:
            log.info("A2: permissions expanded", added=added)
        return added
