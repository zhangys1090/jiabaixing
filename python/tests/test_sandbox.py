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
    SandboxTier,
    SandboxTierInfo,
    SecurityLevel,
    _FORBIDDEN_CODE_PATTERNS,
    _HIGH_RISK_TOOLS,
    _JS_DANGEROUS_PATTERNS,
    _MEDIUM_RISK_TOOLS,
    _PYTHON_DANGEROUS_PATTERNS,
    resolve_sandbox_tier,
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


# ═══════════════════════════════════════════════════════════════════════════
# E2E: 沙箱层级降级链测试
# ═══════════════════════════════════════════════════════════════════════════


def test_sandbox_tier_enum_values():
    assert SandboxTier.KERNEL.value == "kernel"
    assert SandboxTier.CONTAINER.value == "container"
    assert SandboxTier.PROCESS.value == "process"
    assert SandboxTier.LOGICAL.value == "logical"


def test_sandbox_tier_order():
    from agent.sandbox.executor import _SANDBOX_TIER_ORDER

    assert _SANDBOX_TIER_ORDER[0] == SandboxTier.KERNEL
    assert _SANDBOX_TIER_ORDER[-1] == SandboxTier.LOGICAL


def test_sandbox_tier_info_dataclass():
    info = SandboxTierInfo(tier=SandboxTier.PROCESS, available=True, reason="WindowsHardSandbox")
    assert info.tier == SandboxTier.PROCESS
    assert info.available is True
    assert info.reason == "WindowsHardSandbox"


@pytest.mark.anyio
async def test_resolve_sandbox_tier_logical_always_available():
    result = await resolve_sandbox_tier(SandboxTier.LOGICAL)
    assert result.available is True
    assert result.tier == SandboxTier.LOGICAL


@pytest.mark.anyio
async def test_resolve_sandbox_tier_kernel_may_degrade():
    result = await resolve_sandbox_tier(SandboxTier.KERNEL)
    assert result.tier in (SandboxTier.KERNEL, SandboxTier.CONTAINER, SandboxTier.PROCESS, SandboxTier.LOGICAL)
    if result.tier != SandboxTier.KERNEL:
        assert "degrad" in result.reason.lower() or "unavail" in result.reason.lower() or result.reason != ""


@pytest.mark.anyio
async def test_resolve_sandbox_tier_container_may_degrade():
    result = await resolve_sandbox_tier(SandboxTier.CONTAINER)
    assert result.tier in (SandboxTier.CONTAINER, SandboxTier.PROCESS, SandboxTier.LOGICAL)


@pytest.mark.anyio
async def test_resolve_sandbox_tier_process_may_degrade():
    result = await resolve_sandbox_tier(SandboxTier.PROCESS)
    assert result.tier in (SandboxTier.PROCESS, SandboxTier.LOGICAL)


# ═══════════════════════════════════════════════════════════════════════════
# E2E: 内核虚拟化框架测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_kernel_isolation_type_enum():
    from agent.sandbox.kernel_isolation import KernelIsolationType

    assert KernelIsolationType.GVISOR.value == "gvisor"
    assert KernelIsolationType.FIRECRACKER.value == "firecracker"
    assert KernelIsolationType.WINDOWS_SANDBOX.value == "windows_sandbox"


@pytest.mark.anyio
async def test_kernel_sandbox_config_defaults():
    from agent.sandbox.kernel_isolation import KernelSandboxConfig, KernelIsolationType

    config = KernelSandboxConfig()
    assert config.isolation_type == KernelIsolationType.GVISOR
    assert config.memory_mb == 256
    assert config.cpu_count == 1.0
    assert config.timeout_sec == 30.0
    assert config.network == "none"
    assert config.read_only_root is True


@pytest.mark.anyio
async def test_kernel_sandbox_result_dataclass():
    from agent.sandbox.kernel_isolation import KernelSandboxResult, KernelIsolationType

    result = KernelSandboxResult(success=True, output="ok", exit_code=0, duration_ms=50, isolation_type=KernelIsolationType.GVISOR, vm_id="vm-1")
    assert result.success is True
    assert result.output == "ok"
    assert result.exit_code == 0
    assert result.isolation_type == KernelIsolationType.GVISOR
    assert result.vm_id == "vm-1"


@pytest.mark.anyio
async def test_kernel_provider_list_backends():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider, KernelIsolationType

    backends = KernelIsolationProvider.list_backends()
    assert len(backends) >= 3
    names = [b.name for b in backends]
    assert KernelIsolationType.GVISOR in names
    assert KernelIsolationType.FIRECRACKER in names
    assert KernelIsolationType.WINDOWS_SANDBOX in names


@pytest.mark.anyio
async def test_kernel_provider_register_unregister():
    from agent.sandbox.kernel_isolation import (
        KernelIsolationProvider,
        KernelIsolationType,
        KernelIsolationBackend,
        KernelSandboxConfig,
        KernelSandboxResult,
    )

    class DummyBackend(KernelIsolationBackend):
        async def is_available(self) -> bool:
            return True
        async def spawn(self, code: str, language: str, config: KernelSandboxConfig) -> KernelSandboxResult:
            return KernelSandboxResult(success=True, output="dummy")
        async def destroy(self, vm_id: str) -> None:
            pass

    custom_type = KernelIsolationType.GVISOR
    KernelIsolationProvider.register_backend(custom_type, DummyBackend, priority=5, description="test dummy")
    backends = KernelIsolationProvider.list_backends()
    assert backends[0].name == custom_type
    assert backends[0].priority == 5

    KernelIsolationProvider.reset()


@pytest.mark.anyio
async def test_kernel_provider_auto_select():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    selected = await KernelIsolationProvider.auto_select()
    assert selected is None or isinstance(selected.value, str)


@pytest.mark.anyio
async def test_gvisor_backend_not_available_on_windows():
    from agent.sandbox.kernel_isolation import GVisorBackend

    if sys.platform == "win32":
        backend = GVisorBackend()
        assert await backend.is_available() is False


@pytest.mark.anyio
async def test_firecracker_backend_not_available_on_windows():
    from agent.sandbox.kernel_isolation import FirecrackerBackend

    if sys.platform == "win32":
        backend = FirecrackerBackend()
        assert await backend.is_available() is False


@pytest.mark.anyio
async def test_windows_sandbox_backend_not_available_on_linux():
    from agent.sandbox.kernel_isolation import WindowsSandboxBackend

    if sys.platform == "linux":
        backend = WindowsSandboxBackend()
        assert await backend.is_available() is False


# ═══════════════════════════════════════════════════════════════════════════
# E2E: 执行器内核级集成测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_code_with_kernel_tier_fallback():
    executor = SandboxExecutor()
    result = await executor.execute_code("print('kernel_fallback')", "python", sandbox_tier=SandboxTier.KERNEL)
    assert result.success is True
    assert "kernel_fallback" in result.output


@pytest.mark.anyio
async def test_execute_code_with_logical_tier():
    executor = SandboxExecutor()
    result = await executor.execute_code("print('logical_tier')", "python", sandbox_tier=SandboxTier.LOGICAL)
    assert result.success is True
    assert "logical_tier" in result.output


@pytest.mark.anyio
async def test_execute_code_tier_param_default_none():
    executor = SandboxExecutor()
    result = await executor.execute_code("print('default_tier')", "python")
    assert result.success is True
    assert "default_tier" in result.output


# ═══════════════════════════════════════════════════════════════════════════
# E2E: 性能基准测试框架
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_benchmark_tier_detection():
    from agent.sandbox.benchmark import benchmark_tier_detection

    results = await benchmark_tier_detection()
    assert SandboxTier.KERNEL in results
    assert SandboxTier.LOGICAL in results
    assert results[SandboxTier.LOGICAL] >= 0


@pytest.mark.anyio
async def test_benchmark_tier_execution_logical():
    from agent.sandbox.benchmark import benchmark_tier_execution

    result = await benchmark_tier_execution(SandboxTier.LOGICAL, runs=2, warmup=1)
    assert result.tier == SandboxTier.LOGICAL
    assert result.available is True
    assert len(result.execution_ms) > 0


@pytest.mark.anyio
async def test_benchmark_result_serialization():
    from agent.sandbox.benchmark import benchmark_tier_execution

    result = await benchmark_tier_execution(SandboxTier.LOGICAL, runs=1, warmup=0)
    d = result.to_dict()
    assert "tier" in d
    assert "available" in d
    assert "avg_execution_ms" in d
    assert d["tier"] == "logical"


# ═══════════════════════════════════════════════════════════════════════════
# Phase 3+4: 内核虚拟化框架插件化增强 + 审计集成测试
# ═══════════════════════════════════════════════════════════════════════════


def test_provider_metrics_defaults():
    from agent.sandbox.kernel_isolation import ProviderMetrics

    m = ProviderMetrics()
    assert m.spawn_count == 0
    assert m.spawn_success_count == 0
    assert m.spawn_error_count == 0
    assert m.destroy_count == 0
    assert m.degrade_count == 0
    assert m.avg_spawn_ms == 0.0
    assert m.error_rate == 0.0


def test_provider_metrics_record_spawn():
    from agent.sandbox.kernel_isolation import ProviderMetrics

    m = ProviderMetrics()
    m.record_spawn("gvisor", 100.0, True)
    assert m.spawn_count == 1
    assert m.spawn_success_count == 1
    assert m.spawn_error_count == 0
    assert m.avg_spawn_ms == 100.0
    assert m.error_rate == 0.0
    assert m.backend_spawn_counts["gvisor"] == 1

    m.record_spawn("gvisor", 200.0, False)
    assert m.spawn_count == 2
    assert m.spawn_success_count == 1
    assert m.spawn_error_count == 1
    assert m.avg_spawn_ms == 150.0
    assert m.error_rate == 0.5
    assert m.backend_error_counts["gvisor"] == 1


def test_provider_metrics_record_destroy():
    from agent.sandbox.kernel_isolation import ProviderMetrics

    m = ProviderMetrics()
    m.record_destroy(50.0)
    assert m.destroy_count == 1
    assert m.total_destroy_ms == 50.0


def test_provider_metrics_record_degrade():
    from agent.sandbox.kernel_isolation import ProviderMetrics

    m = ProviderMetrics()
    m.record_degrade()
    m.record_degrade()
    assert m.degrade_count == 2


def test_provider_metrics_to_dict():
    from agent.sandbox.kernel_isolation import ProviderMetrics

    m = ProviderMetrics()
    m.record_spawn("gvisor", 100.0, True)
    m.record_spawn("firecracker", 200.0, False)
    m.record_destroy(50.0)
    m.record_degrade()
    d = m.to_dict()
    assert d["spawn_count"] == 2
    assert d["spawn_success_count"] == 1
    assert d["spawn_error_count"] == 1
    assert d["destroy_count"] == 1
    assert d["degrade_count"] == 1
    assert "backends" in d
    assert "gvisor" in d["backends"]
    assert "firecracker" in d["backends"]


def test_provider_metrics_latency_sampling_cap():
    from agent.sandbox.kernel_isolation import ProviderMetrics

    m = ProviderMetrics(_max_latency_samples=10)
    for i in range(20):
        m.record_spawn("gvisor", float(i), True)
    assert len(m.backend_latency_ms["gvisor"]) <= 10


def test_backend_health_status_dataclass():
    from agent.sandbox.kernel_isolation import BackendHealthStatus, KernelIsolationType

    s = BackendHealthStatus(
        backend_type=KernelIsolationType.GVISOR,
        available=True,
        last_check_ms=5.0,
        consecutive_failures=0,
        uptime_ratio=1.0,
    )
    assert s.available is True
    assert s.consecutive_failures == 0
    assert s.uptime_ratio == 1.0

    s2 = BackendHealthStatus(
        backend_type=KernelIsolationType.FIRECRACKER,
        available=False,
        consecutive_failures=3,
        last_error="unavailable",
        uptime_ratio=0.0,
    )
    assert s2.available is False
    assert s2.consecutive_failures == 3


def test_kernel_event_hooks_registration():
    from agent.sandbox.kernel_isolation import KernelEventHooks

    hooks = KernelEventHooks()
    call_log = []

    hooks.on_spawn(lambda **kw: call_log.append(("spawn", kw)))
    hooks.on_destroy(lambda **kw: call_log.append(("destroy", kw)))
    hooks.on_error(lambda **kw: call_log.append(("error", kw)))
    hooks.on_degrade(lambda **kw: call_log.append(("degrade", kw)))
    hooks.on_health_change(lambda **kw: call_log.append(("health_change", kw)))

    assert len(hooks._on_spawn) == 1
    assert len(hooks._on_destroy) == 1
    assert len(hooks._on_error) == 1
    assert len(hooks._on_degrade) == 1
    assert len(hooks._on_health_change) == 1


@pytest.mark.anyio
async def test_kernel_event_hooks_emit():
    from agent.sandbox.kernel_isolation import KernelEventHooks

    hooks = KernelEventHooks()
    call_log = []

    hooks.on_spawn(lambda **kw: call_log.append(("spawn", kw)))
    hooks.on_error(lambda **kw: call_log.append(("error", kw)))

    await hooks.emit_spawn(backend="gvisor", vm_id="test-vm", duration_ms=100.0)
    assert len(call_log) == 1
    assert call_log[0][0] == "spawn"
    assert call_log[0][1]["backend"] == "gvisor"

    await hooks.emit_error(backend="firecracker", error="timeout")
    assert len(call_log) == 2
    assert call_log[1][0] == "error"


@pytest.mark.anyio
async def test_kernel_event_hooks_async_callback():
    from agent.sandbox.kernel_isolation import KernelEventHooks

    hooks = KernelEventHooks()
    call_log = []

    async def async_on_spawn(**kw):
        call_log.append(("async_spawn", kw))

    hooks.on_spawn(async_on_spawn)
    await hooks.emit_spawn(backend="gvisor", vm_id="vm1")
    assert len(call_log) == 1
    assert call_log[0][0] == "async_spawn"


@pytest.mark.anyio
async def test_kernel_event_hooks_error_in_callback():
    from agent.sandbox.kernel_isolation import KernelEventHooks

    hooks = KernelEventHooks()

    def bad_callback(**kw):
        raise ValueError("test error")

    hooks.on_spawn(bad_callback)
    await hooks.emit_spawn(backend="gvisor")
    # Should not raise, error is caught internally


@pytest.mark.anyio
async def test_kernel_provider_health_check():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    health = await KernelIsolationProvider.health_check(force=True)
    assert isinstance(health, dict)
    for backend_type, status in health.items():
        assert hasattr(status, "available")
        assert hasattr(status, "consecutive_failures")
        assert hasattr(status, "uptime_ratio")


@pytest.mark.anyio
async def test_kernel_provider_health_check_caching():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    KernelIsolationProvider._health_check_interval_sec = 9999.0
    health1 = await KernelIsolationProvider.health_check(force=True)
    KernelIsolationProvider._last_health_check = time.time()
    health2 = await KernelIsolationProvider.health_check(force=False)
    assert health2 is not None


def test_kernel_provider_update_backend_priority():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider, KernelIsolationType

    KernelIsolationProvider.reset()
    result = KernelIsolationProvider.update_backend_priority(KernelIsolationType.GVISOR, 5)
    assert result is True
    backends = KernelIsolationProvider.list_backends()
    gvisor = next(b for b in backends if b.name == KernelIsolationType.GVISOR)
    assert gvisor.priority == 5

    result = KernelIsolationProvider.update_backend_priority(KernelIsolationType.GVISOR, 10)
    assert result is True


def test_kernel_provider_update_nonexistent_backend():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider, KernelIsolationType

    KernelIsolationProvider.reset()
    KernelIsolationProvider.unregister_backend(KernelIsolationType.GVISOR)
    result = KernelIsolationProvider.update_backend_priority(KernelIsolationType.GVISOR, 5)
    assert result is False


def test_kernel_provider_get_metrics():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    metrics = KernelIsolationProvider.get_metrics()
    assert metrics.spawn_count == 0
    assert metrics.error_rate == 0.0


def test_kernel_provider_get_hooks():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    hooks = KernelIsolationProvider.get_hooks()
    assert len(hooks._on_spawn) == 0


def test_kernel_provider_get_health_status():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    status = KernelIsolationProvider.get_health_status()
    assert isinstance(status, dict)


def test_kernel_provider_reset_clears_metrics_and_hooks():
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    hooks = KernelIsolationProvider.get_hooks()
    hooks.on_spawn(lambda **kw: None)
    KernelIsolationProvider.reset()
    hooks2 = KernelIsolationProvider.get_hooks()
    assert len(hooks2._on_spawn) == 0
    assert KernelIsolationProvider.get_metrics().spawn_count == 0


# ═══════════════════════════════════════════════════════════════════════════
# Phase 3+4: 沙箱审计子代理测试
# ═══════════════════════════════════════════════════════════════════════════


def test_audit_severity_enum():
    from agent.sandbox.sandbox_audit_agent import AuditSeverity

    assert AuditSeverity.INFO.value == "info"
    assert AuditSeverity.WARNING.value == "warning"
    assert AuditSeverity.CRITICAL.value == "critical"


def test_audit_finding_dataclass():
    from agent.sandbox.sandbox_audit_agent import AuditFinding, AuditSeverity

    f = AuditFinding(
        severity=AuditSeverity.CRITICAL,
        category="backend_availability",
        message="gVisor 连续 3 次不可用",
        backend="gvisor",
        remediation="检查 runsc 安装",
    )
    assert f.severity == AuditSeverity.CRITICAL
    assert f.category == "backend_availability"
    assert f.remediation == "检查 runsc 安装"


def test_audit_report_dataclass():
    from agent.sandbox.sandbox_audit_agent import AuditReport, AuditFinding, AuditSeverity

    report = AuditReport(
        findings=[
            AuditFinding(severity=AuditSeverity.CRITICAL, category="test", message="critical issue"),
            AuditFinding(severity=AuditSeverity.WARNING, category="test", message="warning issue"),
            AuditFinding(severity=AuditSeverity.INFO, category="test", message="info issue"),
        ],
        overall_status="critical",
    )
    assert report.has_critical is True
    assert report.has_warnings is True
    assert report.overall_status == "critical"


def test_audit_report_to_dict():
    from agent.sandbox.sandbox_audit_agent import AuditReport, AuditFinding, AuditSeverity

    report = AuditReport(
        findings=[
            AuditFinding(severity=AuditSeverity.WARNING, category="latency", message="high latency"),
        ],
        overall_status="warning",
    )
    d = report.to_dict()
    assert d["overall_status"] == "warning"
    assert d["finding_count"] == 1
    assert d["warning_count"] == 1
    assert d["critical_count"] == 0
    assert len(d["findings"]) == 1


def test_sandbox_audit_agent_defaults():
    from agent.sandbox.sandbox_audit_agent import SandboxAuditAgent

    agent = SandboxAuditAgent()
    assert agent.is_running is False
    assert agent.last_report is None


def test_sandbox_audit_agent_custom_thresholds():
    from agent.sandbox.sandbox_audit_agent import SandboxAuditAgent

    agent = SandboxAuditAgent(
        error_rate_threshold=0.5,
        latency_ms_threshold=60000.0,
        degrade_count_threshold=20,
        check_interval_sec=300.0,
    )
    assert agent._error_rate_threshold == 0.5
    assert agent._latency_ms_threshold == 60000.0
    assert agent._degrade_count_threshold == 20
    assert agent._check_interval_sec == 300.0


@pytest.mark.anyio
async def test_sandbox_audit_agent_run_audit():
    from agent.sandbox.sandbox_audit_agent import SandboxAuditAgent
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    agent = SandboxAuditAgent()
    report = await agent.run_audit()
    assert report is not None
    assert report.overall_status in ("healthy", "warning", "critical")
    assert isinstance(report.findings, list)
    assert isinstance(report.health_summary, dict)
    assert isinstance(report.metrics_summary, dict)


@pytest.mark.anyio
async def test_sandbox_audit_agent_report_history():
    from agent.sandbox.sandbox_audit_agent import SandboxAuditAgent
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    agent = SandboxAuditAgent()
    await agent.run_audit()
    await agent.run_audit()
    history = agent.get_report_history(limit=5)
    assert len(history) == 2


@pytest.mark.anyio
async def test_sandbox_audit_agent_on_report_callback():
    from agent.sandbox.sandbox_audit_agent import SandboxAuditAgent
    from agent.sandbox.kernel_isolation import KernelIsolationProvider

    KernelIsolationProvider.reset()
    agent = SandboxAuditAgent()
    callback_results = []
    agent.on_report(lambda r: callback_results.append(r))
    await agent.run_audit()
    assert len(callback_results) == 1


@pytest.mark.anyio
async def test_sandbox_audit_agent_start_stop():
    from agent.sandbox.sandbox_audit_agent import SandboxAuditAgent

    agent = SandboxAuditAgent(check_interval_sec=9999.0)
    await agent.start()
    assert agent.is_running is True
    await agent.stop()
    assert agent.is_running is False


# ═══════════════════════════════════════════════════════════════════════════
# Phase 3+4: SandboxAuditMiddleware 测试
# ═══════════════════════════════════════════════════════════════════════════


def test_sandbox_audit_middleware_name():
    from agent.loop.middleware import SandboxAuditMiddleware

    mw = SandboxAuditMiddleware()
    assert mw.name == "sandbox_audit"


def test_sandbox_audit_middleware_disabled():
    from agent.loop.middleware import SandboxAuditMiddleware

    mw = SandboxAuditMiddleware(enabled=False)
    assert mw._enabled is False
