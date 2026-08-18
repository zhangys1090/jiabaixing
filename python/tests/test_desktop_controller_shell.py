"""回归测试：DesktopController.shell_exec 安全加固。

锁定审计发现：旧实现当 shlex.split 失败时回退到 `shell=True` 执行原始命令
字符串，而危险命令仅用可绕过的黑名单校验，导致 Shell 元字符注入
(`;`、`|`、`&`、`$(...)`) 可被解释执行。修复后：始终 shell=False，
解析失败即拒绝执行（fail-closed）。
"""
from __future__ import annotations

import sys

import pytest

from agent.desktop.desktop_controller import DesktopController


@pytest.fixture
def controller(tmp_path):
    return DesktopController(data_dir=str(tmp_path))


def test_shell_exec_rejects_unparseable_command(controller) -> None:
    """shlex 无法解析的命令必须被拒绝（fail-closed），绝不能回退到 shell=True。"""
    # 未闭合引号会令 shlex.split 抛 ValueError
    result = controller.shell_exec('echo "unterminated')
    assert result.success is False
    assert "解析失败" in result.error


def test_shell_exec_rejects_dangerous_command(controller) -> None:
    """危险命令黑名单仍作为纵深防御生效。"""
    result = controller.shell_exec("rm -rf /")
    assert result.success is False
    assert "安全策略拒绝" in result.error


def test_shell_exec_uses_shell_false(controller, monkeypatch) -> None:
    """验证底层 subprocess.run 以 shell=False 调用（杜绝元字符注入）。"""
    captured = {}

    import subprocess

    real_run = subprocess.run

    def fake_run(args, **kwargs):
        captured["shell"] = kwargs.get("shell", False)
        # 不真正执行，直接返回成功哑结果
        class _R:
            returncode = 0
            stdout = "ok"
            stderr = ""
        return _R()

    monkeypatch.setattr(subprocess, "run", fake_run)
    # 一个可被 shlex 正常解析的命令
    controller.shell_exec("dir" if sys.platform == "win32" else "ls")
    assert captured.get("shell") is False
