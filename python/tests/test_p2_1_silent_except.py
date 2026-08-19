"""P2-1 静默吞异常治理的回归测试。

覆盖三件事：
1. ``log_ignored`` 记账器本身的行为（含永不抛异常的硬约束）；
2. ``/health`` 能看到这些被忽略的异常（可观测性交付物）；
3. **红线**：``agent`` 包内静默吞异常必须为 0，且 codemod 幂等。
"""

from __future__ import annotations

import ast
import logging
import pathlib
import subprocess
import sys

import pytest

from agent.api.health import (
    IGNORED_EXC_SITE_WARN_THRESHOLD,
    ignored_exceptions_health,
)
from agent.core.logger import (
    StructuredLogger,
    get_ignored_exception_stats,
    log_ignored,
    reset_ignored_exception_stats,
)

PY_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = PY_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
from check_silent_except import scan  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_stats():
    reset_ignored_exception_stats()
    yield
    reset_ignored_exception_stats()


# --------------------------------------------------------------------------
# 1. log_ignored 记账器
# --------------------------------------------------------------------------


def test_log_ignored_counts_by_site():
    log = StructuredLogger("t")
    log_ignored(log, "mod.A.f", ValueError("x"))
    log_ignored(log, "mod.A.f", ValueError("y"))
    log_ignored(log, "mod.B.g", KeyError("z"))

    stats = get_ignored_exception_stats()
    assert stats["total"] == 3
    assert stats["distinct_sites"] == 2
    by_site = {s["where"]: s["count"] for s in stats["top_sites"]}
    assert by_site == {"mod.A.f": 2, "mod.B.g": 1}


def test_log_ignored_accepts_none_logger():
    """无模块级 logger 的文件传 None —— 必须走兜底 logger 而非崩溃。"""
    log_ignored(None, "mod.no_logger", RuntimeError("boom"))
    assert get_ignored_exception_stats()["total"] == 1


def test_log_ignored_accepts_stdlib_logger(caplog):
    std = logging.getLogger("agent.test_stdlib")
    with caplog.at_level(logging.WARNING, logger="agent.test_stdlib"):
        log_ignored(std, "mod.std", OSError("disk"), level="warning")
    assert "忽略异常 @ mod.std" in caplog.text
    assert "OSError" in caplog.text


def test_log_ignored_level_is_configurable(monkeypatch, caplog):
    """默认 debug（不刷屏），可用环境变量一键提级到 warning 排障。"""
    log = StructuredLogger("t_level")
    monkeypatch.setenv("IGNORED_EXC_LOG_LEVEL", "warning")
    with caplog.at_level(logging.WARNING, logger="agent.t_level"):
        log_ignored(log, "mod.lv", ValueError("v"))
    assert "忽略异常 @ mod.lv" in caplog.text


def test_log_ignored_never_raises():
    """它运行在 except 块内，抛异常会掩盖原始控制流 —— 硬约束。"""

    class Exploding:
        def debug(self, *a, **k):
            raise RuntimeError("logger 炸了")

        warning = error = info = debug

    log_ignored(Exploding(), "mod.boom", ValueError("v"))  # 不得抛出
    # 计数在日志之前完成，因此仍应记账成功
    assert get_ignored_exception_stats()["total"] == 1


def test_log_ignored_context_kwargs_are_rendered(caplog):
    log = StructuredLogger("t_ctx")
    with caplog.at_level(logging.WARNING, logger="agent.t_ctx"):
        log_ignored(log, "mod.ctx", ValueError("v"), level="warning", session_id="s1")
    assert "session_id=s1" in caplog.text


# --------------------------------------------------------------------------
# 2. /health 可观测
# --------------------------------------------------------------------------


def test_health_reports_ignored_exceptions():
    log_ignored(None, "mod.h", ValueError("v"))
    result = ignored_exceptions_health()
    assert result["status"] == "healthy"
    assert result["extra"]["total"] == 1


def test_health_degrades_on_hot_site():
    """某一处在反复吞异常 = 真实故障被掩盖，必须浮出来。"""
    for _ in range(IGNORED_EXC_SITE_WARN_THRESHOLD):
        log_ignored(None, "mod.hot", ValueError("v"))
    result = ignored_exceptions_health()
    assert result["status"] == "degraded"
    assert "mod.hot" in str(result["extra"]["top_sites"])


def test_health_check_is_registered():
    from agent.api.health import get_health_checker, register_default_checks

    register_default_checks(engine=object())
    assert "ignored_exceptions" in get_health_checker()._checks


# --------------------------------------------------------------------------
# 3. 红线：零静默吞异常 + codemod 幂等
# --------------------------------------------------------------------------


def test_zero_silent_except_in_agent_package():
    counts, locations, parse_errors = scan()
    offenders = {f: c for f, c in counts.items() if c > 0}
    assert not parse_errors, f"存在语法解析失败文件: {parse_errors}"
    assert not offenders, (
        "检出静默吞异常（`except X: pass`），请改用 "
        "`log_ignored(log, '<qualname>', _exc)`：\n"
        + "\n".join(f"  {f}: 行 {locations[f]}" for f in offenders)
    )


def test_codemod_is_idempotent():
    """已改写的文件再跑 codemod 必须是 no-op —— 防止重复注入。"""
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "codemod_silent_except.py"),
         "agent/core/engine.py", "agent/loop/controller.py"],
        cwd=str(PY_ROOT), capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert "合计 0 处" in proc.stdout, proc.stdout


def test_rewritten_handlers_bind_exception_and_call_helper():
    """抽查 engine.py：不得残留未绑定异常名的 except 空壳。"""
    src = (PY_ROOT / "agent" / "core" / "engine.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    helper_calls = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id == "log_ignored":
                helper_calls += 1
    assert helper_calls >= 60, f"engine.py 的 log_ignored 调用点仅 {helper_calls} 个"
    assert "from agent.core.logger import log_ignored" in src
