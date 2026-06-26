from __future__ import annotations

import pytest

from agent.tools.permission_guard import (
    DEFAULT_PERMISSIONS,
    AuditEntry,
    Permission,
    PermissionCheckResult,
    PermissionGuard,
    SessionLimits,
    ToolContext,
)


def _ctx(session_id: str = "s1", trace_id: str = "t1", permissions: set[Permission] | None = None) -> ToolContext:
    return ToolContext(
        user_id="u1",
        trace_id=trace_id,
        session_id=session_id,
        permissions=permissions or set(DEFAULT_PERMISSIONS),
    )


# ─── Permission enum ───


def test_permission_values():
    assert Permission.MEMORY_READ == "memory:read"
    assert Permission.FILE_READ == "file:read"
    assert Permission.CODE_EXECUTE == "code:execute"
    assert Permission.SYSTEM_ADMIN == "system:admin"


# ─── Basic permission check ───


def test_check_allowed():
    guard = PermissionGuard()
    result = guard.check("web_search", [Permission.NETWORK_ACCESS], "low", _ctx())
    assert result.allowed is True
    assert result.needs_confirmation is False


def test_check_missing_permission():
    guard = PermissionGuard()
    ctx = _ctx(permissions={Permission.FILE_READ})
    result = guard.check("shell_exec", [Permission.CODE_EXECUTE], "low", ctx)
    assert result.allowed is False
    assert len(result.missing) > 0


def test_check_high_risk_needs_confirmation():
    guard = PermissionGuard()
    result = guard.check("shell_exec", [Permission.CODE_EXECUTE], "critical", _ctx())
    assert result.needs_confirmation is True


def test_check_denied_policy():
    guard = PermissionGuard()
    guard.set_tool_policy("dangerous_tool", "deny", reason="此工具危险")
    result = guard.check("dangerous_tool", [], "low", _ctx())
    assert result.allowed is False
    assert "危险" in result.reason


def test_check_ask_policy():
    guard = PermissionGuard()
    guard.set_tool_policy("ask_tool", "ask")
    result = guard.check("ask_tool", [], "low", _ctx())
    assert result.needs_confirmation is True


# ─── Session limits ───


def test_session_max_calls():
    guard = PermissionGuard()
    guard.set_session_limits("s1", max_tool_calls=2)
    guard.check("t1", [], "low", _ctx("s1"))
    guard.record_execution("s1", "t1", type("R", (), {"success": True})())
    guard.check("t2", [], "low", _ctx("s1"))
    guard.record_execution("s1", "t2", type("R", (), {"success": True})())
    result = guard.check("t3", [], "low", _ctx("s1"))
    assert result.allowed is False
    assert "上限" in result.reason


def test_session_consecutive_same():
    guard = PermissionGuard()
    guard.set_session_limits("s1", max_consecutive_same=2)
    for _ in range(3):
        guard.record_execution("s1", "same_tool", type("R", (), {"success": True})())
    result = guard.check("same_tool", [], "low", _ctx("s1"))
    assert result.allowed is False
    assert "连续调用" in result.reason


# ─── Record execution ───


def test_record_execution_updates_stats():
    guard = PermissionGuard()
    guard.record_execution("s1", "tool_a", type("R", (), {"success": True})())
    guard.record_execution("s1", "tool_b", type("R", (), {"success": True})())

    status = guard.get_session_status("s1")
    assert status["tool_call_count"] == 2


def test_record_execution_error_count():
    guard = PermissionGuard()
    guard.set_session_limits("s1", auto_stop_threshold=3)
    for _ in range(3):
        guard.record_execution("s1", "bad_tool", type("R", (), {"success": False})())

    status = guard.get_session_status("s1")
    assert status["error_count"] == 3


# ─── User permissions ───


def test_grant_permission():
    guard = PermissionGuard()
    guard.grant_permission("u1", Permission.DESKTOP_CONTROL)
    perms = guard.get_user_permissions("u1")
    assert Permission.DESKTOP_CONTROL in perms


def test_revoke_permission():
    guard = PermissionGuard()
    guard.revoke_permission("u1", Permission.FILE_WRITE)
    perms = guard.get_user_permissions("u1")
    assert Permission.FILE_WRITE not in perms


def test_set_admin():
    guard = PermissionGuard()
    guard.set_admin("admin_user")
    perms = guard.get_user_permissions("admin_user")
    assert Permission.SYSTEM_ADMIN in perms


def test_default_permissions():
    guard = PermissionGuard()
    perms = guard.get_user_permissions("new_user")
    assert len(perms) >= 3


# ─── Audit trail ───


def test_audit_trail():
    guard = PermissionGuard()
    guard.check("t1", [], "low", _ctx(trace_id="trace1"))
    guard.check("t2", [], "high", _ctx(trace_id="trace2"))

    trail = guard.get_audit_trail()
    assert len(trail) >= 2


def test_audit_trail_limit():
    guard = PermissionGuard()
    for i in range(10):
        guard.check(f"t{i}", [], "low", _ctx(trace_id=f"trace{i}"))

    trail = guard.get_audit_trail(limit=3)
    assert len(trail) == 3


# ─── Session reset ───


def test_reset_session():
    guard = PermissionGuard()
    guard.record_execution("s1", "tool_a", type("R", (), {"success": True})())
    guard.reset_session("s1")
    status = guard.get_session_status("s1")
    assert status["tool_call_count"] == 0


# ─── Tool policy ───


def test_set_tool_policy():
    guard = PermissionGuard()
    guard.set_tool_policy("my_tool", "deny", reason="测试禁用")
    result = guard.check("my_tool", [], "low", _ctx())
    assert result.allowed is False
    assert "测试禁用" in result.reason


def test_set_tool_policy_expiry():
    guard = PermissionGuard()
    guard.set_tool_policy("expire_tool", "deny", reason="临时", expires_in_ms=1)
    import time
    time.sleep(0.01)
    result = guard.check("expire_tool", [], "low", _ctx())
    assert result.allowed is True


def test_wildcard_policy():
    guard = PermissionGuard()
    guard.set_tool_policy("desktop_*", "deny", reason="桌面操作禁用")
    result = guard.check("desktop_screenshot", [], "low", _ctx())
    assert result.allowed is False


# ─── Risk threshold ───


def test_risk_threshold_blocks():
    guard = PermissionGuard()
    guard.set_session_limits("s1", risk_threshold="medium")
    guard.set_tool_policy("tool", "ask")
    result = guard.check("tool", [], "high", _ctx("s1"))
    assert result.allowed is False
    assert result.needs_confirmation is True
