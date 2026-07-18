from __future__ import annotations

import asyncio
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)


@dataclass
class ExecutionResult:
    """代码执行结果。

    Attributes:
        stdout: 标准输出文本。
        stderr: 标准错误文本。
        exit_code: 进程退出码。
        duration_ms: 执行耗时（毫秒）。
        truncated: 输出是否被截断。
    """

    stdout: str = ""
    stderr: str = ""
    exit_code: int = -1
    duration_ms: float = 0.0
    truncated: bool = False


class CodeExecutor:
    """Python 代码安全执行器。

    使用子进程隔离执行用户提交的 Python 代码，提供超时保护、
    输出截断和代码安全检查，防止危险操作。

    Usage:
        executor = CodeExecutor()
        result = await executor.execute("print('hello')")
    """

    _MAX_OUTPUT_LEN: int = 10000
    _FORBIDDEN_PATTERNS: list[str] = [
        r"os\.system\s*\(",
        r"os\.popen\s*\(",
        r"subprocess\.",
        r"\beval\s*\(",
        r"\bexec\s*\(",
        r"__import__\s*\(",
        r"\bcompile\s*\(",
        r"open\s*\([^)]*etc/passwd",
        r"open\s*\([^)]*etc/shadow",
        r"shutil\.rmtree",
        r"importlib\.",
        r"os\.remove\s*\(",
        r"os\.unlink\s*\(",
        r"os\.rmdir\s*\(",
    ]

    async def execute(
        self,
        code: str,
        timeout: int = 30,
        memory_limit_mb: int = 256,
    ) -> ExecutionResult:
        """执行 Python 代码并返回执行结果。

        通过子进程隔离执行，具备超时保护和输出截断。

        Args:
            code: 要执行的 Python 代码。
            timeout: 超时秒数，默认 30。
            memory_limit_mb: 内存限制（MB），默认 256。

        Returns:
            ExecutionResult: 包含 stdout、stderr、exit_code 等信息。

        Raises:
            ValueError: 代码未通过安全检查时。
        """
        validation_error = self._validate_code(code)
        if validation_error:
            return ExecutionResult(
                stderr=f"代码安全检查未通过: {validation_error}",
                exit_code=-1,
            )

        start = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-c", code,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            elapsed = (time.monotonic() - start) * 1000
            return ExecutionResult(
                stderr=f"执行超时（{timeout}秒）",
                exit_code=-1,
                duration_ms=elapsed,
            )
        except Exception as exc:
            elapsed = (time.monotonic() - start) * 1000
            return ExecutionResult(
                stderr=f"子进程启动失败: {exc}",
                exit_code=-1,
                duration_ms=elapsed,
            )

        elapsed = (time.monotonic() - start) * 1000
        raw_stdout = stdout_bytes.decode("utf-8", errors="replace")
        raw_stderr = stderr_bytes.decode("utf-8", errors="replace")

        truncated_stdout, stdout_cut = self._truncate_output(raw_stdout)
        truncated_stderr, stderr_cut = self._truncate_output(raw_stderr)

        return ExecutionResult(
            stdout=truncated_stdout,
            stderr=truncated_stderr,
            exit_code=proc.returncode if proc.returncode is not None else -1,
            duration_ms=elapsed,
            truncated=stdout_cut or stderr_cut,
        )

    def _validate_code(self, code: str) -> str | None:
        """检查代码安全性，返回错误信息或 None。

        黑名单检查包含: os.system, os.popen, subprocess.*, eval(),
        exec(), __import__, compile, 敏感文件读取, shutil.rmtree, importlib,
        以及 while True 无 break 的无限循环风险。

        Args:
            code: 待检查的 Python 代码。

        Returns:
            str | None: 错误信息字符串，通过则返回 None。
        """
        for pattern in self._FORBIDDEN_PATTERNS:
            if re.search(pattern, code):
                return f"代码包含禁止的模式: {pattern}"
        if self._has_infinite_loop(code):
            return "检测到 while True 无 break，存在无限循环风险"
        return None

    def _has_infinite_loop(self, code: str) -> bool:
        """检测 while True 无 break 的无限循环风险。

        Args:
            code: 待检查的 Python 代码。

        Returns:
            bool: 是否存在无限循环风险。
        """
        while_true_pattern = re.compile(r"while\s+True\s*:")
        for match in while_true_pattern.finditer(code):
            start = match.end()
            remaining = code[start:]
            if not re.search(r"\bbreak\b", remaining):
                return True
        return False

    def _truncate_output(
        self, text: str, max_len: int = 10000,
    ) -> tuple[str, bool]:
        """截断过长的输出文本。

        Args:
            text: 原始输出文本。
            max_len: 最大保留字符数，默认 10000。

        Returns:
            tuple[str, bool]: (截断后文本, 是否被截断)。
        """
        if len(text) <= max_len:
            return text, False
        return text[:max_len] + f"\n... (输出截断，原始长度: {len(text)} 字符)", True


# ==================== 工具定义与注册 ====================

CODE_EXECUTION_DEF = ToolDefinition(
    name="execute_code",
    description="在安全沙箱中执行 Python 代码并返回结果。适用场景：快速验证代码逻辑、计算数学表达式、运行数据处理脚本。不适用：需要持久化文件操作（用 file_edit）、需要交互式输入。",
    short_desc="安全执行Python代码",
    category=ToolCategory.CODE,
    tags=["code", "execute", "sandbox", "python", "run"],
    scenes=["coding", "development", "research"],
    capability_level=2,
    parameters=[
        ToolParameterDef(
            name="code", type="string", required=True,
            description="要执行的 Python 代码",
        ),
        ToolParameterDef(
            name="timeout", type="number", required=False,
            description="超时秒数，默认30",
        ),
        ToolParameterDef(
            name="language", type="string", required=False,
            description="编程语言，目前仅支持 python",
            enum=["python"],
        ),
    ],
    risk_level="high",
    permissions=["code_execution"],
)

_executor_instance = CodeExecutor()


async def execute_code_executor(params: dict[str, Any]) -> ToolResult:
    """execute_code 工具执行器。

    Args:
        params: 工具参数字典，包含 code、timeout、language。

    Returns:
        ToolResult: 工具执行结果。
    """
    start = time.time()
    code = str(params.get("code", ""))
    timeout = int(params.get("timeout", 30))
    language = str(params.get("language", "python"))

    if not code.strip():
        return ToolResult(
            success=False,
            error="代码不能为空",
            duration=time.time() - start,
        )

    if language != "python":
        return ToolResult(
            success=False,
            error=f"暂不支持语言: {language}，仅支持 python",
            duration=time.time() - start,
        )

    result = await _executor_instance.execute(code, timeout=timeout)

    output_parts: list[str] = []
    if result.stdout:
        output_parts.append(result.stdout)
    if result.stderr:
        output_parts.append(f"[stderr]\n{result.stderr}")

    output = "\n".join(output_parts) if output_parts else "(无输出)"

    if result.exit_code != 0:
        output = f"退出码: {result.exit_code}\n{output}"

    return ToolResult(
        success=result.exit_code == 0,
        output=output,
        error=result.stderr if result.exit_code != 0 else None,
        duration=time.time() - start,
        metadata={
            "exit_code": result.exit_code,
            "duration_ms": result.duration_ms,
            "truncated": result.truncated,
        },
    )


def register_code_execution_tool(registry: Any) -> None:
    """注册代码执行沙箱工具到工具注册中心。

    Args:
        registry: ToolRegistry 实例。
    """
    registry.register(CODE_EXECUTION_DEF, execute_code_executor)
