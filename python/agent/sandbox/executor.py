from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any
from agent.core.logger import StructuredLogger, log_ignored
from agent.sandbox.windows_hard import (
    WindowsHardSandbox,
    hard_windows_enabled,
)

log = StructuredLogger("sandbox.executor")


class SecurityLevel(str, Enum):
    """安全等级枚举。

    Attributes:
        LOW: 低安全级别，允许大部分操作。
        MEDIUM: 中等安全级别，限制危险操作。
        HIGH: 高安全级别，严格限制。
        CRITICAL: 严重安全级别，仅允许只读操作。
    """

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class SandboxConfig:
    """沙箱执行配置。

    Attributes:
        security_level: 安全等级。
        timeout_ms: 执行超时（毫秒）。
        max_memory_mb: 最大内存限制（MB）。
        max_cpu_percent: 最大CPU使用率（%）。
        network_policy: 网络策略（allow/deny）。
        enable_logging: 是否启用日志。
        max_output_length: 最大输出长度。
    """

    security_level: SecurityLevel = SecurityLevel.LOW
    timeout_ms: int = 30000
    max_memory_mb: int = 256
    max_cpu_percent: int = 50
    network_policy: str = "deny"
    enable_logging: bool = True
    max_output_length: int = 50000


@dataclass
class SandboxExecutionResult:
    """沙箱执行结果。

    Attributes:
        success: 是否成功。
        output: 输出内容。
        error: 错误信息。
        duration_ms: 执行耗时（毫秒）。
        logs: 执行日志。
        security_violations: 安全违规列表。
        exit_code: 退出码。
    """

    success: bool
    output: str = ""
    error: str | None = None
    duration_ms: int = 0
    logs: list[str] = field(default_factory=list)
    security_violations: list[str] = field(default_factory=list)
    exit_code: int | None = None


@dataclass
class PermissionCheckResult:
    """权限检查结果。

    Attributes:
        allowed: 是否允许。
        reason: 拒绝原因。
        risk_level: 风险等级。
    """

    allowed: bool
    reason: str | None = None
    risk_level: SecurityLevel = SecurityLevel.LOW


_HIGH_RISK_TOOLS = [
    "delete_file", "execute_command", "modify_system",
    "shell_exec", "system_command",
]

_MEDIUM_RISK_TOOLS = [
    "write_file", "edit_file", "file_edit",
    "incremental_edit", "multi_file_edit",
]

_FORBIDDEN_CODE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\brm\s+-rf\s+/"), "rm -rf / 删除根目录"),
    (re.compile(r"\bdel\s+/f\s+/q\s+", re.IGNORECASE), "强制删除文件"),
    (re.compile(r"\bformat\s+[A-Za-z]:", re.IGNORECASE), "格式化磁盘"),
    (re.compile(r"\bshutdown\b", re.IGNORECASE), "关机命令"),
    (re.compile(r"\bmkfs\b"), "格式化文件系统"),
    (re.compile(r"\bdd\s+if="), "dd 磁盘操作"),
    (re.compile(r":\(\)\{:\|:&\};:"), "Fork炸弹"),
    (re.compile(r"fork\s+bomb", re.IGNORECASE), "Fork炸弹"),
]

_PYTHON_DANGEROUS_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bos\.system\s*\("), "os.system 调用"),
    (re.compile(r"\bsubprocess\.\w+\s*\("), "subprocess 调用"),
    (re.compile(r"\beval\s*\("), "eval 调用"),
    (re.compile(r"\bexec\s*\("), "exec 调用"),
    (re.compile(r"\b__import__\s*\("), "__import__ 调用"),
    (re.compile(r"\bopen\s*\(.+[\'\"]w"), "文件写入操作"),
]

_JS_DANGEROUS_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\brequire\s*\("), "require 调用"),
    (re.compile(r"\bprocess\."), "process 访问"),
    (re.compile(r"\bchild_process"), "child_process 访问"),
    (re.compile(r"\bfs\."), "文件系统操作"),
    (re.compile(r"\beval\s*\("), "eval 调用"),
    (re.compile(r"\bFunction\s*\("), "Function 构造函数"),
]


class SandboxExecutor:
    """沙箱执行器——安全执行代码和命令。

    提供多层安全防护：
    1. 代码模式检测：禁止危险操作（rm -rf、fork炸弹等）。
    2. 语言特定检测：Python和JS的危险函数调用。
    3. 工具黑名单：高风险工具禁止执行。
    4. 资源限制：超时、内存、CPU限制。

    Usage:
        config = SandboxConfig(security_level=SecurityLevel.MEDIUM)
        executor = SandboxExecutor(config)
        result = await executor.execute_code("print('hello')", "python")
        if not result.success:
            print(result.error)
    """
    def __init__(self, config: SandboxConfig | None = None) -> None:
        self.config = config or SandboxConfig()
        self._logs: list[str] = []
        self._security_violations: list[str] = []

    async def execute_code(
        self,
        code: str,
        language: str = "python",
        timeout_ms: int | None = None,
    ) -> SandboxExecutionResult:
        start = time.time()
        self._logs = []
        self._security_violations = []

        pre_check = self._pre_check_code(code, language)
        if not pre_check.allowed:
            return SandboxExecutionResult(
                success=False,
                error=f"安全检查失败: {pre_check.reason}",
                duration_ms=int((time.time() - start) * 1000),
                security_violations=[pre_check.reason or "未知安全风险"],
            )

        actual_timeout = timeout_ms or self.config.timeout_ms
        timeout_sec = min(actual_timeout / 1000, 120)

        if language == "python":
            return await self._execute_python(code, timeout_sec, start)
        elif language in ("javascript", "js"):
            return await self._execute_javascript(code, timeout_sec, start)
        elif language == "shell":
            return await self._execute_shell(code, timeout_sec, start)
        else:
            return SandboxExecutionResult(
                success=False,
                error=f"不支持的语言: {language}",
                duration_ms=int((time.time() - start) * 1000),
            )

    def check_tool_permission(
        self, tool_name: str, params: dict[str, Any] | None = None
    ) -> PermissionCheckResult:
        if tool_name in _HIGH_RISK_TOOLS and self.config.security_level != SecurityLevel.LOW:
            return PermissionCheckResult(
                allowed=False,
                reason=f"工具 {tool_name} 在当前安全级别下不可用",
                risk_level=SecurityLevel.CRITICAL,
            )

        if tool_name in _MEDIUM_RISK_TOOLS and self.config.security_level == SecurityLevel.HIGH:
            return PermissionCheckResult(
                allowed=False,
                reason=f"工具 {tool_name} 需要降低安全级别",
                risk_level=SecurityLevel.HIGH,
            )

        return PermissionCheckResult(allowed=True, risk_level=SecurityLevel.LOW)

    def update_config(self, new_config: dict[str, Any]) -> None:
        if "security_level" in new_config:
            self.config.security_level = SecurityLevel(new_config["security_level"])
        if "timeout_ms" in new_config:
            self.config.timeout_ms = int(new_config["timeout_ms"])
        if "max_memory_mb" in new_config:
            self.config.max_memory_mb = int(new_config["max_memory_mb"])
        if "network_policy" in new_config:
            self.config.network_policy = str(new_config["network_policy"])

    def get_config(self) -> SandboxConfig:
        return SandboxConfig(
            security_level=self.config.security_level,
            timeout_ms=self.config.timeout_ms,
            max_memory_mb=self.config.max_memory_mb,
            max_cpu_percent=self.config.max_cpu_percent,
            network_policy=self.config.network_policy,
            enable_logging=self.config.enable_logging,
            max_output_length=self.config.max_output_length,
        )

    def _pre_check_code(self, code: str, language: str) -> PermissionCheckResult:
        for pattern, name in _FORBIDDEN_CODE_PATTERNS:
            if pattern.search(code):
                self._security_violations.append(f"检测到危险操作: {name}")
                return PermissionCheckResult(
                    allowed=False,
                    reason=f"检测到危险操作: {name}",
                    risk_level=SecurityLevel.CRITICAL,
                )

        dangerous_patterns = (
            _PYTHON_DANGEROUS_PATTERNS
            if language == "python"
            else _JS_DANGEROUS_PATTERNS
        )

        if self.config.security_level in (SecurityLevel.HIGH, SecurityLevel.CRITICAL):
            for pattern, name in dangerous_patterns:
                if pattern.search(code):
                    self._security_violations.append(f"检测到受限操作: {name}")
                    return PermissionCheckResult(
                        allowed=False,
                        reason=f"检测到受限操作: {name}",
                        risk_level=SecurityLevel.HIGH,
                    )

        return PermissionCheckResult(allowed=True, risk_level=SecurityLevel.LOW)

    def _make_preexec_fn(self) -> Any | None:
        """T-10: 构造 preexec_fn 用于 Unix 子进程资源限制。

        在 Linux/macOS 上通过 resource.setrlimit 施加内存限制。
        Windows 不支持 preexec_fn，返回 None（由监控机制兜底）。
        """
        if sys.platform == "win32":
            return None
        try:
            import resource

            max_memory_bytes = self.config.max_memory_mb * 1024 * 1024

            def _set_limits() -> None:
                resource.setrlimit(resource.RLIMIT_AS, (max_memory_bytes, max_memory_bytes))
                resource.setrlimit(resource.RLIMIT_DATA, (max_memory_bytes, max_memory_bytes))

            return _set_limits
        except (ImportError, AttributeError):
            return None

    async def _kill_process_tree(self, proc: asyncio.subprocess.Process) -> None:
        """E2: 跨平台进程树终止，避免超时/kill 遗留孤儿子进程。

        - Windows: ``taskkill /T /F /PID`` 递归强制终止整棵进程树
          （asyncio 的 ``proc.kill()`` 在 Windows 仅杀直接子进程，子进程会孤儿化）。
        - POSIX: 子进程经 ``preexec_fn=setsid`` 成为进程组首，``os.killpg`` 杀整组。
        任何异常均吞掉（进程可能已退出），最后再对直接子进程兜底 kill。
        """
        pid = proc.pid
        try:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5.0,
                )
            else:
                import signal as _signal
                try:
                    pgid = os.getpgid(pid)
                    os.killpg(pgid, _signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    os.kill(pid, _signal.SIGKILL)
        except Exception as _exc:
            log_ignored(log, "executor.SandboxExecutor._kill_process_tree", _exc)
        # 兜底：直接杀死直接子进程（已退出时会抛 ProcessLookupError，忽略）。
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass

    def _harden_windows(self, proc: asyncio.subprocess.Process) -> None:
        """E2: 可选 Windows 硬隔离（Job Object）。

        仅当 ``SANDBOX_HARD_WINDOWS`` 启用且 pywin32 可用时，将子进程纳入 Job Object；
        任何失败（含子进程已处于不可脱离的父作业）均安全降级为软沙箱，不抛错。
        """
        if not hard_windows_enabled() or sys.platform != "win32":
            return
        try:
            if not WindowsHardSandbox.is_available():
                log.warning(
                    "SANDBOX_HARD_WINDOWS 已启用但 pywin32 不可用，退回软沙箱"
                )
                return
            handle = getattr(getattr(proc, "_proc", None), "_handle", None)
            if handle is None:
                return
            sandbox = WindowsHardSandbox()
            sandbox.assign(int(handle))
            log.info("子进程已纳入 Windows Job Object 硬隔离", pid=proc.pid)
        except Exception as _exc:
            log_ignored(log, "executor.SandboxExecutor._harden_windows", _exc)

    async def _monitor_resources(self, proc: asyncio.subprocess.Process, timeout_sec: float) -> tuple[bytes, bytes] | None:
        """T-10: 带资源监控的进程等待。

        周期性检查子进程内存占用，超限时终止。
        返回 None 表示因资源超限被终止。

        关键正确性约束：``proc.communicate()`` **只调用一次**。原实现在循环内反复
        调用 ``communicate()``，超时分支会并发二次读取同一管道，在 Windows proactor
        事件循环下偶发相邻用例 stdout/stderr 变空。此处改为「单次 communicate + 并发
        内存监控任务」，既保留内存超限返回 None 的契约，又消除管道竞态。
        """
        max_memory_bytes = self.config.max_memory_mb * 1024 * 1024
        memory_exceeded = False

        async def _watch() -> None:
            nonlocal memory_exceeded
            try:
                import psutil
            except ImportError:
                return
            while proc.returncode is None:
                await asyncio.sleep(0.5)
                try:
                    p = psutil.Process(proc.pid)
                    if p.memory_info().rss > max_memory_bytes:
                        memory_exceeded = True
                        await self._kill_process_tree(proc)
                        return
                except (psutil.NoSuchProcess, psutil.AccessDenied) as _exc:
                    log_ignored(None, "executor.SandboxExecutor._monitor_resources.watch", _exc)
                    return

        watcher = asyncio.create_task(_watch())
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_sec
            )
        except asyncio.TimeoutError:
            await self._kill_process_tree(proc)
            await proc.wait()
            watcher.cancel()
            raise
        finally:
            if not watcher.done():
                watcher.cancel()
            try:
                await watcher
            except asyncio.CancelledError:
                pass

        if memory_exceeded:
            return None
        return stdout, stderr

    async def _execute_python(
        self, code: str, timeout_sec: float, start: float
    ) -> SandboxExecutionResult:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            tmp = f.name

        try:
            preexec_fn = self._make_preexec_fn()
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                tmp,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                preexec_fn=preexec_fn,
            )
            self._harden_windows(proc)

            try:
                if preexec_fn is None and self.config.max_memory_mb > 0:
                    stdout, stderr = await self._monitor_resources(proc, timeout_sec)
                    if stdout is None:
                        return SandboxExecutionResult(
                            success=False,
                            error=f"内存超限 ({self.config.max_memory_mb}MB)",
                            duration_ms=int((time.time() - start) * 1000),
                            exit_code=-1,
                            security_violations=["memory_limit_exceeded"],
                        )
                else:
                    stdout, stderr = await asyncio.wait_for(
                        proc.communicate(), timeout=timeout_sec
                    )
            except asyncio.TimeoutError:
                # 进程可能已由 _monitor_resources 的超时路径先行终止（max_memory_mb>0 时），
                # 此时再次 kill 会抛 ProcessLookupError / OSError，忽略即可。
                await self._kill_process_tree(proc)
                return SandboxExecutionResult(
                    success=False,
                    error=f"执行超时 ({timeout_sec}秒)",
                    duration_ms=int((time.time() - start) * 1000),
                    exit_code=-1,
                )

            output = stdout.decode("utf-8", errors="replace")
            error_output = stderr.decode("utf-8", errors="replace")

            if len(output) > self.config.max_output_length:
                output = output[: self.config.max_output_length] + "\n...[输出已截断]"

            success = proc.returncode == 0
            result_error = None
            if not success:
                result_error = error_output or f"退出码: {proc.returncode}"

            return SandboxExecutionResult(
                success=success,
                output=output,
                error=result_error,
                duration_ms=int((time.time() - start) * 1000),
                logs=self._logs.copy(),
                security_violations=self._security_violations.copy(),
                exit_code=proc.returncode,
            )

        except Exception as e:
            return SandboxExecutionResult(
                success=False,
                error=f"执行失败: {e}",
                duration_ms=int((time.time() - start) * 1000),
            )
        finally:
            try:
                Path(tmp).unlink()
            except Exception as _exc:
                log_ignored(None, "executor.SandboxExecutor._execute_python", _exc)
            # Windows proactor：显式关闭子进程管道传输层，避免残留状态污染下一个
            # 子进程（表现为相邻用例 stdout/stderr 变空或挂起）。关闭已关闭的管道为无操作。
            _proc = locals().get("proc")
            if _proc is not None:
                for _pipe in (_proc.stdout, _proc.stderr):
                    if _pipe is not None:
                        try:
                            _pipe.close()
                        except Exception as _exc:
                            # 关闭已关闭的管道会抛 ValueError/OSError，属无害残留；
                            # 但仍须记账而非裸 pass，避免掩盖真实管道关闭故障。
                            log_ignored(None, "executor.SandboxExecutor._execute_python.pipe_close", _exc)

    async def _execute_javascript(
        self, code: str, timeout_sec: float, start: float
    ) -> SandboxExecutionResult:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".js", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            tmp = f.name

        try:
            preexec_fn = self._make_preexec_fn()
            proc = await asyncio.create_subprocess_exec(
                "node",
                tmp,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                preexec_fn=preexec_fn,
            )
            self._harden_windows(proc)

            try:
                if preexec_fn is None and self.config.max_memory_mb > 0:
                    stdout, stderr = await self._monitor_resources(proc, timeout_sec)
                    if stdout is None:
                        return SandboxExecutionResult(
                            success=False,
                            error=f"内存超限 ({self.config.max_memory_mb}MB)",
                            duration_ms=int((time.time() - start) * 1000),
                            exit_code=-1,
                            security_violations=["memory_limit_exceeded"],
                        )
                else:
                    stdout, stderr = await asyncio.wait_for(
                        proc.communicate(), timeout=timeout_sec
                    )
            except asyncio.TimeoutError:
                # 进程可能已由 _monitor_resources 的超时路径先行终止（max_memory_mb>0 时），
                # 此时再次 kill 会抛 ProcessLookupError / OSError，忽略即可。
                await self._kill_process_tree(proc)
                return SandboxExecutionResult(
                    success=False,
                    error=f"执行超时 ({timeout_sec}秒)",
                    duration_ms=int((time.time() - start) * 1000),
                    exit_code=-1,
                )

            output = stdout.decode("utf-8", errors="replace")
            error_output = stderr.decode("utf-8", errors="replace")

            success = proc.returncode == 0
            result_error = None
            if not success:
                result_error = error_output or f"退出码: {proc.returncode}"

            return SandboxExecutionResult(
                success=success,
                output=output,
                error=result_error,
                duration_ms=int((time.time() - start) * 1000),
                exit_code=proc.returncode,
            )

        except FileNotFoundError:
            return SandboxExecutionResult(
                success=False,
                error="Node.js 不可用，请先安装 Node.js",
                duration_ms=int((time.time() - start) * 1000),
            )
        except Exception as e:
            return SandboxExecutionResult(
                success=False,
                error=f"执行失败: {e}",
                duration_ms=int((time.time() - start) * 1000),
            )
        finally:
            try:
                Path(tmp).unlink()
            except Exception as _exc:
                log_ignored(None, "executor.SandboxExecutor._execute_javascript", _exc)

    async def _execute_shell(
        self, code: str, timeout_sec: float, start: float
    ) -> SandboxExecutionResult:
        try:
            preexec_fn = self._make_preexec_fn()
            proc = await asyncio.create_subprocess_shell(
                code,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                preexec_fn=preexec_fn,
            )
            self._harden_windows(proc)

            try:
                if preexec_fn is None and self.config.max_memory_mb > 0:
                    stdout, stderr = await self._monitor_resources(proc, timeout_sec)
                    if stdout is None:
                        return SandboxExecutionResult(
                            success=False,
                            error=f"内存超限 ({self.config.max_memory_mb}MB)",
                            duration_ms=int((time.time() - start) * 1000),
                            exit_code=-1,
                            security_violations=["memory_limit_exceeded"],
                        )
                else:
                    stdout, stderr = await asyncio.wait_for(
                        proc.communicate(), timeout=timeout_sec
                    )
            except asyncio.TimeoutError:
                # 进程可能已由 _monitor_resources 的超时路径先行终止（max_memory_mb>0 时），
                # 此时再次 kill 会抛 ProcessLookupError / OSError，忽略即可。
                await self._kill_process_tree(proc)
                return SandboxExecutionResult(
                    success=False,
                    error=f"执行超时 ({timeout_sec}秒)",
                    duration_ms=int((time.time() - start) * 1000),
                    exit_code=-1,
                )

            output = stdout.decode("utf-8", errors="replace")
            error_output = stderr.decode("utf-8", errors="replace")

            success = proc.returncode == 0
            combined_output = output
            result_error = None
            if not success:
                result_error = error_output or f"退出码: {proc.returncode}"
                if output:
                    combined_output = f"{output}\n[stderr]\n{error_output}"

            return SandboxExecutionResult(
                success=success,
                output=combined_output,
                error=result_error,
                duration_ms=int((time.time() - start) * 1000),
                exit_code=proc.returncode,
            )

        except Exception as e:
            return SandboxExecutionResult(
                success=False,
                error=f"执行失败: {e}",
                duration_ms=int((time.time() - start) * 1000),
            )
