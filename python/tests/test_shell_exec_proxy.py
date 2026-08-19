"""F1 Phase1 — shell_exec Python canonical 验证。

验证 Python 端 shell_exec 是可作为 canonical 实现被 TS 经 /api/tools/execute 派发的:
  1. 定义存在且为 system_admin 高危工具;
  2. 经 ToolRegistry.execute (与 /api/tools/execute 同一调度路径) 可真实执行 echo hello;
  3. 白名单前缀模型生效: 未知首命令被安全策略拒绝(security_violation), 证明 Python 端
     比 TS 本地 shell:true 更严格 —— 这正是 shell_exec 归 Python canonical 的依据。
"""
from __future__ import annotations

import asyncio
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from agent.tools.code_tools import SHELL_EXEC_DEF, shell_exec_executor  # noqa: E402
from agent.tools.registry import ToolRegistry  # noqa: E402


def _reg() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(SHELL_EXEC_DEF, shell_exec_executor)
    return reg


def test_shell_exec_def_identity():
    assert SHELL_EXEC_DEF.name == "shell_exec"
    assert SHELL_EXEC_DEF.permissions == ["system_admin"]
    assert SHELL_EXEC_DEF.risk_level == "high"


def test_shell_exec_registry_dispatch_executes():
    reg = _reg()
    assert reg.get_definition("shell_exec") is not None
    result = asyncio.run(reg.execute("shell_exec", {"command": "echo hello"}))
    assert result.success is True
    assert "hello" in result.output


def test_shell_exec_whitelist_blocks_unknown_prefix():
    reg = _reg()
    result = asyncio.run(reg.execute("shell_exec", {"command": "mycustomtool --help"}))
    assert result.success is False
    assert result.metadata.get("security_violation") is True


def test_shell_exec_forbidden_pattern_blocked():
    reg = _reg()
    # 命中 _FORBIDDEN_PATTERNS 分支(如 nohup, 不在 _FORBIDDEN_COMMANDS 子串列表中),
    # 该分支会标注 security_violation; 此命令在预检即被拦截, 不会真正执行。
    result = asyncio.run(reg.execute("shell_exec", {"command": "nohup ls"}))
    assert result.success is False
    assert result.metadata.get("security_violation") is True
