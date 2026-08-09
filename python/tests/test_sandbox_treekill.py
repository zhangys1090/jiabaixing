"""E2: Windows 沙箱硬隔离相关测试。

覆盖：
1. 跨平台进程树终止逻辑（Windows taskkill / POSIX killpg）—— 用 mock 验证正确命令。
2. 软沙箱在改动后行为不变（回归守护）。
3. 可选 WindowsHardSandbox 在关闭 / pywin32 缺失时安全降级（不抛错）。
4. SANDBOX_HARD_WINDOWS 开关解析。
"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys

import pytest

from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel
from agent.sandbox import windows_hard


class _FakeProc:
    def __init__(self, pid: int = 1234) -> None:
        self.pid = pid
        self._killed = False

    def kill(self) -> None:
        self._killed = True


def test_kill_process_tree_windows_uses_taskkill(monkeypatch):
    """Windows 上必须用 taskkill /T /F 递归杀整棵树。"""
    monkeypatch.setattr(sys, "platform", "win32")
    calls: list[tuple[tuple, dict]] = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return object()

    monkeypatch.setattr("agent.sandbox.executor.subprocess.run", fake_run)
    monkeypatch.setattr("agent.sandbox.executor.os", os)  # 保持 os 可用

    async def run():
        ex = SandboxExecutor(SandboxConfig())
        await ex._kill_process_tree(_FakeProc(999))

    asyncio.run(run())

    assert calls, "应当调用 subprocess.run"
    cmd = calls[0][0][0]
    assert cmd[:3] == ["taskkill", "/T", "/F"], f"命令应为 taskkill /T /F，得到 {cmd}"
    assert "/PID" in cmd and "999" in cmd, f"命令应包含 /PID 999，得到 {cmd}"


def test_kill_process_tree_posix_uses_killpg(monkeypatch):
    """POSIX 上应对进程组发送 SIGKILL（子进程经 setsid 成为组首）。"""
    monkeypatch.setattr(sys, "platform", "linux")
    killed: dict[str, object] = {}

    def fake_getpgid(pid):
        return pid  # 组 id 等于 pid

    def fake_killpg(pgid, sig):
        killed["pgid"] = pgid
        killed["sig"] = sig

    monkeypatch.setattr("agent.sandbox.executor.os.getpgid", fake_getpgid, raising=False)
    monkeypatch.setattr("agent.sandbox.executor.os.killpg", fake_killpg, raising=False)
    # Windows 上 signal.SIGKILL 不存在；为 POSIX 分支提供该常量以便测试执行。
    monkeypatch.setattr("signal.SIGKILL", 9, raising=False)

    async def run():
        ex = SandboxExecutor(SandboxConfig())
        await ex._kill_process_tree(_FakeProc(4242))

    asyncio.run(run())

    assert killed.get("pgid") == 4242, "killpg 应作用于 pid 对应的进程组"
    import signal

    assert killed.get("sig") == signal.SIGKILL, "应使用 SIGKILL"


def test_soft_sandbox_python_still_works():
    """回归守护：改动后 LOW 级 Python 执行仍正常（未破坏软沙箱）。"""

    async def run():
        ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW, timeout_ms=10000))
        return await ex.execute_code("print('hello-sandbox')", "python")

    result = asyncio.run(run())
    assert result.success, f"执行应成功: {result.error}"
    assert "hello-sandbox" in result.output


def test_harden_windows_noop_when_disabled(monkeypatch):
    """默认关闭时 _harden_windows 直接返回，不抛错、不触达 pywin32。"""
    monkeypatch.delenv("SANDBOX_HARD_WINDOWS", raising=False)
    ex = SandboxExecutor(SandboxConfig())
    # 不应抛异常（即使 proc 是占位对象）。
    ex._harden_windows(_FakeProc())


def test_harden_windows_graceful_when_pywin32_missing(monkeypatch):
    """启用但 pywin32 缺失时，_harden_windows 安全降级（不抛错）。"""
    monkeypatch.setenv("SANDBOX_HARD_WINDOWS", "true")
    monkeypatch.setattr(sys, "platform", "win32")
    # 强制 is_available() 为 False（pywin32 在本环境确实不可用）。
    monkeypatch.setattr(
        "agent.sandbox.executor.WindowsHardSandbox.is_available",
        staticmethod(lambda: False),
    )
    ex = SandboxExecutor(SandboxConfig())
    # 不应抛异常。
    ex._harden_windows(_FakeProc())


@pytest.mark.parametrize(
    "env_val,expected",
    [
        ("false", False),
        ("off", False),
        ("true", True),
        ("on", True),
        ("auto", False),  # 本环境 pywin32 缺失 → auto 解析为 False
    ],
)
def test_hard_windows_enabled_parsing(monkeypatch, env_val, expected):
    monkeypatch.setenv("SANDBOX_HARD_WINDOWS", env_val)
    # auto 依赖 is_available；本环境 pywin32 缺失，故为 False。
    assert windows_hard.hard_windows_enabled() is expected


def test_windows_hard_sandbox_is_available_false_without_pywin32():
    """本环境未安装 pywin32，is_available() 必须为 False（硬隔离安全降级）。"""
    assert windows_hard.WindowsHardSandbox.is_available() is False
