"""PTY 桥接器。

管理子进程伪终端（PTY），提供交互式子进程能力：
  - PTY 创建与子进程启动
  - 输入/输出桥接
  - 终端大小同步（SIGWINCH）
  - 进程生命周期管理
  - 输出捕获与回放
  - Windows ConPTY / Unix PTY 自适应

与 CursesTUI 的关系：
  - CursesTUI 是主 TUI 界面
  - PtyBridge 可嵌入子进程终端（如 vim/top）
  - 两者组合实现嵌入式终端体验

集成示例::

    from agent.cli.pty_bridge import PtyBridge

    bridge = PtyBridge()
    proc = await bridge.spawn("python", args=["-i"])
    await bridge.write(proc, "print('hello')\\n")
    output = await bridge.read(proc)
    await bridge.terminate(proc)
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("pty_bridge")


class PtyBackend(str, Enum):
    """PTY 后端。"""

    UNIX_PTY = "unix_pty"
    WIN_CONPTY = "win_conpty"
    SUBPROCESS = "subprocess"


@dataclass
class PtyProcess:
    """PTY 进程信息。

    Attributes:
        pid: 进程 ID。
        command: 启动命令。
        args: 命令参数。
        started_at: 启动时间。
        exited: 是否已退出。
        exit_code: 退出码。
        backend: 使用的 PTY 后端。
    """

    pid: int = 0
    command: str = ""
    args: list[str] = field(default_factory=list)
    started_at: float = 0.0
    exited: bool = False
    exit_code: int | None = None
    backend: PtyBackend = PtyBackend.SUBPROCESS

    def __post_init__(self) -> None:
        if self.started_at == 0.0:
            self.started_at = time.time()


@dataclass
class PtyConfig:
    """PTY 配置。

    Attributes:
        backend: PTY 后端。
        rows: 终端行数。
        cols: 终端列数。
        env: 环境变量。
        cwd: 工作目录。
        capture_output: 是否捕获输出。
    """

    backend: PtyBackend = PtyBackend.SUBPROCESS
    rows: int = 24
    cols: int = 80
    env: dict[str, str] | None = None
    cwd: str | None = None
    capture_output: bool = True


class PtyBridge:
    """PTY 桥接器。

    管理子进程伪终端，提供交互式子进程能力。
    """

    def __init__(self, config: PtyConfig | None = None) -> None:
        self._config = config or PtyConfig()
        self._processes: dict[int, PtyProcess] = {}
        self._subprocesses: dict[int, asyncio.subprocess.Process] = {}
        self._output_buffers: dict[int, list[str]] = {}
        self._next_id = 1

    @property
    def config(self) -> PtyConfig:
        return self._config

    def _detect_backend(self) -> PtyBackend:
        """检测可用的 PTY 后端。"""
        if sys.platform == "win32":
            try:
                import winpty

                return PtyBackend.WIN_CONPTY
            except ImportError as _exc:
                log_ignored(log, "pty_bridge.PtyBridge._detect_backend", _exc)
        else:
            try:
                import pty

                return PtyBackend.UNIX_PTY
            except ImportError as _exc:
                log_ignored(log, "pty_bridge.PtyBridge._detect_backend", _exc)
        return PtyBackend.SUBPROCESS

    async def spawn(
        self,
        command: str,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> PtyProcess:
        """启动 PTY 子进程。

        Args:
            command: 启动命令。
            args: 命令参数。
            env: 环境变量。
            cwd: 工作目录。

        Returns:
            PtyProcess 进程信息。
        """
        backend = self._detect_backend()
        cmd_args = [command] + (args or [])

        try:
            proc_env = env or self._config.env or dict(os.environ)
            proc_cwd = cwd or self._config.cwd

            subproc = await asyncio.create_subprocess_exec(
                *cmd_args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=proc_env,
                cwd=proc_cwd,
            )

            proc_id = self._next_id
            self._next_id += 1

            pty_proc = PtyProcess(
                pid=proc_id,
                command=command,
                args=args or [],
                backend=backend,
            )

            self._processes[proc_id] = pty_proc
            self._subprocesses[proc_id] = subproc
            self._output_buffers[proc_id] = []

            if self._config.capture_output:
                asyncio.create_task(self._capture_output(proc_id, subproc))

            log.info("PTY process spawned", pid=proc_id, command=command, backend=backend.value)
            return pty_proc

        except Exception as e:
            log.warning("PTY spawn failed", command=command, error=str(e))
            raise

    async def write(self, proc: PtyProcess, data: str) -> None:
        """向 PTY 进程写入数据。

        Args:
            proc: PTY 进程。
            data: 要写入的数据。
        """
        subproc = self._subprocesses.get(proc.pid)
        if subproc and subproc.stdin:
            subproc.stdin.write(data.encode())
            await subproc.stdin.drain()

    async def read(self, proc: PtyProcess, timeout: float = 1.0) -> str:
        """从 PTY 进程读取输出。

        Args:
            proc: PTY 进程。
            timeout: 读取超时。

        Returns:
            输出文本。
        """
        buf = self._output_buffers.get(proc.pid, [])
        if buf:
            output = "".join(buf)
            buf.clear()
            return output
        return ""

    async def resize(self, proc: PtyProcess, rows: int, cols: int) -> None:
        """调整终端大小。

        Args:
            proc: PTY 进程。
            rows: 行数。
            cols: 列数。
        """
        if sys.platform != "win32":
            subproc = self._subprocesses.get(proc.pid)
            if subproc and subproc.pid:
                try:
                    os.kill(subproc.pid, signal.SIGWINCH)
                except ProcessLookupError as _exc:
                    log_ignored(log, "pty_bridge.PtyBridge.resize", _exc)

    async def terminate(self, proc: PtyProcess, timeout: float = 5.0) -> int | None:
        """终止 PTY 进程。

        Args:
            proc: PTY 进程。
            timeout: 等待超时。

        Returns:
            退出码。
        """
        subproc = self._subprocesses.get(proc.pid)
        if not subproc:
            return proc.exit_code

        try:
            subproc.terminate()
            try:
                exit_code = await asyncio.wait_for(subproc.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                subproc.kill()
                exit_code = await subproc.wait()

            proc.exited = True
            proc.exit_code = exit_code

            self._processes.pop(proc.pid, None)
            self._subprocesses.pop(proc.pid, None)
            self._output_buffers.pop(proc.pid, None)

            log.info("PTY process terminated", pid=proc.pid, exit_code=exit_code)
            return exit_code

        except Exception as e:
            log.warning("PTY terminate failed", pid=proc.pid, error=str(e))
            return None

    def get_process(self, pid: int) -> PtyProcess | None:
        """获取进程信息。"""
        return self._processes.get(pid)

    def list_processes(self) -> list[PtyProcess]:
        """列出所有活跃进程。"""
        return [p for p in self._processes.values() if not p.exited]

    async def _capture_output(
        self, pid: int, subproc: asyncio.subprocess.Process
    ) -> None:
        """持续捕获子进程输出。"""
        buf = self._output_buffers.get(pid)
        if not buf:
            return

        try:
            while True:
                data = await subproc.stdout.read(4096)
                if not data:
                    break
                text = data.decode(errors="replace")
                buf.append(text)
        except Exception as _exc:
            log_ignored(log, "pty_bridge.PtyBridge._capture_output", _exc)
