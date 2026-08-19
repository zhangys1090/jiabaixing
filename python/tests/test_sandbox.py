from __future__ import annotations

import asyncio
import os
import shutil
import sys
import time

import pytest

from agent.sandbox.executor import (
    PermissionCheckResult,
    SandboxConfig,
    SandboxExecutionResult,
    SandboxExecutor,
    SecurityLevel,
    _FORBIDDEN_CODE_PATTERNS,
    _HIGH_RISK_TOOLS,
    _JS_DANGEROUS_PATTERNS,
    _MEDIUM_RISK_TOOLS,
    _PYTHON_DANGEROUS_PATTERNS,
)


def _shell_available() -> bool:
    """判断当前环境是否有可用 shell（Windows 的 ComSpec/SystemRoot 或 POSIX 的 sh/bash）。"""
    return bool(
        os.environ.get("ComSpec")
        or os.environ.get("SystemRoot")
        or shutil.which("cmd")
        or shutil.which("sh")
        or shutil.which("bash")
    )


_NODE_AVAILABLE = shutil.which("node") is not None


# ═══════════════════════════════════════════════════════════════════════════
# SandboxConfig 配置测试
# ═══════════════════════════════════════════════════════════════════════════


def test_sandbox_config_defaults():
    config = SandboxConfig()
    assert config.security_level == SecurityLevel.LOW
    assert config.timeout_ms == 30000
    assert config.max_memory_mb == 256
    assert config.max_cpu_percent == 50
    assert config.network_policy == "deny"
    assert config.enable_logging is True
    assert config.max_output_length == 50000


def test_sandbox_config_custom():
    config = SandboxConfig(
        security_level=SecurityLevel.HIGH,
        timeout_ms=5000,
        max_memory_mb=128,
        max_cpu_percent=25,
        network_policy="allow",
        enable_logging=False,
        max_output_length=1000,
    )
    assert config.security_level == SecurityLevel.HIGH
    assert config.timeout_ms == 5000
    assert config.max_memory_mb == 128
    assert config.network_policy == "allow"
    assert config.enable_logging is False


# ═══════════════════════════════════════════════════════════════════════════
# SecurityLevel 枚举测试
# ═══════════════════════════════════════════════════════════════════════════


def test_security_level_values():
    assert SecurityLevel.LOW == "low"
    assert SecurityLevel.MEDIUM == "medium"
    assert SecurityLevel.HIGH == "high"
    assert SecurityLevel.CRITICAL == "critical"


# ═══════════════════════════════════════════════════════════════════════════
# 代码执行 — Python
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_python_simple():
    executor = SandboxExecutor()
    result = await executor.execute_code("print('hello world')", "python")

    assert result.success is True
    assert "hello world" in result.output
    assert result.error is None
    assert result.exit_code == 0
    assert result.duration_ms > 0


@pytest.mark.anyio
async def test_execute_python_with_error():
    executor = SandboxExecutor()
    result = await executor.execute_code("raise ValueError('test error')", "python")

    assert result.success is False
    assert result.error is not None
    assert result.exit_code != 0


@pytest.mark.anyio
async def test_execute_python_with_output():
    executor = SandboxExecutor()
    code = 'print("line1")\nprint("line2")\nprint("line3")'
    result = await executor.execute_code(code, "python")

    assert result.success is True
    assert "line1" in result.output
    assert "line2" in result.output
    assert "line3" in result.output


@pytest.mark.anyio
async def test_execute_python_multiline():
    executor = SandboxExecutor()
    code = "x = 1 + 2\nprint(f'result={x}')"
    result = await executor.execute_code(code, "python")

    assert result.success is True
    assert "result=3" in result.output


# ═══════════════════════════════════════════════════════════════════════════
# 代码执行 — JavaScript
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.skipif(not _NODE_AVAILABLE, reason="Node.js 不可用，跳过 JS 沙箱执行测试")
@pytest.mark.anyio
async def test_execute_javascript_simple():
    executor = SandboxExecutor()
    result = await executor.execute_code("console.log('hello js')", "javascript")

    if "node" not in sys.executable.lower():
        assert result.success is True
        assert "hello js" in result.output or result.error is None


@pytest.mark.skipif(not _NODE_AVAILABLE, reason="Node.js 不可用，跳过 JS 沙箱执行测试")
@pytest.mark.anyio
async def test_execute_javascript_with_error():
    executor = SandboxExecutor()
    result = await executor.execute_code("throw new Error('js error')", "javascript")

    if "node" not in sys.executable.lower():
        assert result.success is False


# ═══════════════════════════════════════════════════════════════════════════
# 代码执行 — 不支持的语音
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_unsupported_language():
    executor = SandboxExecutor()
    result = await executor.execute_code("echo hello", "ruby")

    assert result.success is False
    assert "不支持的语言" in result.error


# ═══════════════════════════════════════════════════════════════════════════
# 代码执行 — 超时
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_python_timeout():
    config = SandboxConfig(timeout_ms=1000)
    executor = SandboxExecutor(config)

    code = "import time\ntime.sleep(10)"
    result = await executor.execute_code(code, "python", timeout_ms=500)

    assert result.success is False
    assert "超时" in (result.error or "")


@pytest.mark.anyio
async def test_execute_python_custom_timeout():
    executor = SandboxExecutor()

    code = "print('fast')"
    result = await executor.execute_code(code, "python", timeout_ms=10000)

    assert result.success is True
    assert "fast" in result.output


# ═══════════════════════════════════════════════════════════════════════════
# 安全检查 — 被禁止的危险代码模式
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_dangerous_rm_rf():
    executor = SandboxExecutor()
    result = await executor.execute_code("rm -rf /home", "shell")

    assert result.success is False
    assert "危险操作" in (result.error or "")
    assert len(result.security_violations) > 0


@pytest.mark.anyio
async def test_execute_dangerous_format():
    executor = SandboxExecutor()
    result = await executor.execute_code("format C:", "shell")

    assert result.success is False
    assert "危险操作" in (result.error or "")


@pytest.mark.anyio
async def test_execute_dangerous_shutdown():
    executor = SandboxExecutor()
    result = await executor.execute_code("shutdown -h now", "shell")

    assert result.success is False
    assert "危险操作" in (result.error or "")


@pytest.mark.anyio
async def test_execute_dangerous_fork_bomb():
    executor = SandboxExecutor()
    result = await executor.execute_code("fork bomb detection", "shell")

    assert result.success is False
    assert "危险操作" in (result.error or "")


@pytest.mark.anyio
async def test_execute_fork_bomb_pattern():
    executor = SandboxExecutor()
    result = await executor.execute_code(":(){:|:&};:", "shell")

    assert result.success is False
    assert "危险操作" in (result.error or "")


# ═══════════════════════════════════════════════════════════════════════════
# 安全检查 — Python 危险函数
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_high_security_blocks_os_system():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("import os; os.system('ls')", "python")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_high_security_blocks_eval():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("eval('1+1')", "python")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_high_security_blocks_exec():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("exec('print(1)')", "python")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_high_security_blocks_subprocess():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("import subprocess; subprocess.run(['ls'])", "python")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_high_security_blocks_open_write():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("open('/tmp/test.txt', 'w')", "python")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_low_security_allows_safe_python():
    config = SandboxConfig(security_level=SecurityLevel.LOW)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("print('safe code')", "python")

    assert result.success is True


# ═══════════════════════════════════════════════════════════════════════════
# 安全检查 — JavaScript 危险函数
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_high_security_blocks_js_eval():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("eval('1+1')", "javascript")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_high_security_blocks_js_require():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("require('fs')", "javascript")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_high_security_blocks_js_child_process():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("const cp = require('child_process')", "javascript")

    assert result.success is False
    assert "受限操作" in (result.error or "")


# ═══════════════════════════════════════════════════════════════════════════
# 工具权限检查
# ═══════════════════════════════════════════════════════════════════════════


def test_check_tool_permission_high_risk_low_security():
    config = SandboxConfig(security_level=SecurityLevel.LOW)
    executor = SandboxExecutor(config)

    result = executor.check_tool_permission("delete_file", {})
    assert result.allowed is True


def test_check_tool_permission_high_risk_medium_security():
    config = SandboxConfig(security_level=SecurityLevel.MEDIUM)
    executor = SandboxExecutor(config)

    result = executor.check_tool_permission("delete_file", {})
    assert result.allowed is False
    assert result.risk_level == SecurityLevel.CRITICAL


def test_check_tool_permission_high_risk_high_security():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    for tool in _HIGH_RISK_TOOLS:
        result = executor.check_tool_permission(tool, {})
        assert result.allowed is False


def test_check_tool_permission_medium_risk_high_security():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    for tool in _MEDIUM_RISK_TOOLS:
        result = executor.check_tool_permission(tool, {})
        assert result.allowed is False


def test_check_tool_permission_medium_risk_medium_security():
    config = SandboxConfig(security_level=SecurityLevel.MEDIUM)
    executor = SandboxExecutor(config)

    for tool in _MEDIUM_RISK_TOOLS:
        result = executor.check_tool_permission(tool, {})
        assert result.allowed is True


def test_check_tool_permission_safe_tool():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    result = executor.check_tool_permission("read_file", {})
    assert result.allowed is True


def test_check_tool_permission_unknown_tool():
    config = SandboxConfig(security_level=SecurityLevel.CRITICAL)
    executor = SandboxExecutor(config)

    result = executor.check_tool_permission("unknown_tool", {})
    assert result.allowed is True


# ═══════════════════════════════════════════════════════════════════════════
# 配置更新
# ═══════════════════════════════════════════════════════════════════════════


def test_update_config_security_level():
    executor = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW))
    executor.update_config({"security_level": "high"})

    assert executor.config.security_level == SecurityLevel.HIGH


def test_update_config_timeout():
    executor = SandboxExecutor()
    executor.update_config({"timeout_ms": 10000})

    assert executor.config.timeout_ms == 10000


def test_update_config_network_policy():
    executor = SandboxExecutor()
    executor.update_config({"network_policy": "allow"})

    assert executor.config.network_policy == "allow"


def test_get_config_returns_copy():
    executor = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.MEDIUM))
    config = executor.get_config()

    assert config.security_level == SecurityLevel.MEDIUM
    assert isinstance(config, SandboxConfig)


# ═══════════════════════════════════════════════════════════════════════════
# SandboxExecutionResult 数据类测试
# ═══════════════════════════════════════════════════════════════════════════


def test_execution_result_success():
    result = SandboxExecutionResult(
        success=True,
        output="hello",
        duration_ms=100,
        exit_code=0,
    )
    assert result.success is True
    assert result.output == "hello"
    assert result.exit_code == 0


def test_execution_result_failure():
    result = SandboxExecutionResult(
        success=False,
        error="something went wrong",
        security_violations=["rm -rf"],
    )
    assert result.success is False
    assert result.error == "something went wrong"
    assert len(result.security_violations) == 1


# ═══════════════════════════════════════════════════════════════════════════
# PermissionCheckResult 数据类测试
# ═══════════════════════════════════════════════════════════════════════════


def test_permission_check_allowed():
    result = PermissionCheckResult(allowed=True)
    assert result.allowed is True
    assert result.reason is None
    assert result.risk_level == SecurityLevel.LOW


def test_permission_check_denied():
    result = PermissionCheckResult(
        allowed=False,
        reason="安全限制",
        risk_level=SecurityLevel.CRITICAL,
    )
    assert result.allowed is False
    assert result.reason == "安全限制"
    assert result.risk_level == SecurityLevel.CRITICAL


# ═══════════════════════════════════════════════════════════════════════════
# 安全检查 — 边界情况
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_empty_code():
    executor = SandboxExecutor()
    result = await executor.execute_code("", "python")

    assert result.success is True


@pytest.mark.anyio
async def test_execute_code_with_special_chars():
    executor = SandboxExecutor()
    result = await executor.execute_code("print('hello\\nworld\\ttab')", "python")

    assert result.success is True
    assert "hello" in result.output


@pytest.mark.anyio
async def test_execute_code_with_unicode():
    executor = SandboxExecutor()
    result = await executor.execute_code("print('hello')", "python")

    assert result.success is True
    assert "hello" in result.output


@pytest.mark.anyio
async def test_high_security_blocks_multiple_dangerous():
    config = SandboxConfig(security_level=SecurityLevel.HIGH)
    executor = SandboxExecutor(config)

    code = "import os; import subprocess; os.system('ls'); subprocess.run(['ls'])"
    result = await executor.execute_code(code, "python")

    assert result.success is False
    assert "受限操作" in (result.error or "")


@pytest.mark.anyio
async def test_medium_security_allows_subprocess():
    config = SandboxConfig(security_level=SecurityLevel.MEDIUM)
    executor = SandboxExecutor(config)

    code = "import subprocess; subprocess.run(['python', '-c', 'print(42)'])"
    result = await executor.execute_code(code, "python")

    assert result.success is True


# ═══════════════════════════════════════════════════════════════════════════
# 安全检查 — 危险模式列表完整性
# ═══════════════════════════════════════════════════════════════════════════


def test_forbidden_patterns_not_empty():
    assert len(_FORBIDDEN_CODE_PATTERNS) > 0


def test_python_dangerous_patterns_not_empty():
    assert len(_PYTHON_DANGEROUS_PATTERNS) > 0


def test_js_dangerous_patterns_not_empty():
    assert len(_JS_DANGEROUS_PATTERNS) > 0


def test_high_risk_tools_not_empty():
    assert len(_HIGH_RISK_TOOLS) > 0


def test_medium_risk_tools_not_empty():
    assert len(_MEDIUM_RISK_TOOLS) > 0


# ═══════════════════════════════════════════════════════════════════════════
# 安全检查 — Shell 执行
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.skipif(not _shell_available(), reason="当前环境无可用 shell（缺 ComSpec/SystemRoot/sh），跳过 shell 沙箱测试")
@pytest.mark.anyio
async def test_execute_shell_safe_command():
    executor = SandboxExecutor()
    result = await executor.execute_code("echo hello", "shell")

    assert result.success is True
    assert "hello" in result.output


@pytest.mark.skipif(not _shell_available(), reason="当前环境无可用 shell（缺 ComSpec/SystemRoot/sh），跳过 shell 沙箱测试")
@pytest.mark.anyio
async def test_execute_shell_dangerous_command():
    executor = SandboxExecutor()
    result = await executor.execute_code("rm -rf /", "shell")

    assert result.success is False
    assert "危险操作" in (result.error or "")


@pytest.mark.anyio
async def test_execute_shell_dd_command():
    executor = SandboxExecutor()
    result = await executor.execute_code("dd if=/dev/zero of=/tmp/test", "shell")

    assert result.success is False
    assert "危险操作" in (result.error or "")


# ═══════════════════════════════════════════════════════════════════════════
# 安全检查 — 临界级别（CRITICAL）只允许安全代码
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_critical_security_blocks_os_system():
    config = SandboxConfig(security_level=SecurityLevel.CRITICAL)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("import os; os.system('ls')", "python")

    assert result.success is False


@pytest.mark.anyio
async def test_critical_security_allows_safe_print():
    config = SandboxConfig(security_level=SecurityLevel.CRITICAL)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("print('safe')", "python")

    assert result.success is True


# ═══════════════════════════════════════════════════════════════════════════
# 输出截断
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_output_truncation():
    config = SandboxConfig(max_output_length=20)
    executor = SandboxExecutor(config)

    result = await executor.execute_code("print('x' * 100)", "python")

    assert result.success is True
    assert len(result.output) <= 20 + 20
    assert "截断" in result.output
