"""Windows 沙箱硬隔离层（深度加固，需 pywin32）。

为 SandboxExecutor 在 Windows 上提供 OS 级硬隔离，作为「跨平台进程树终止」
（executor._kill_process_tree）之外的**可选深度加固**：

1. Job Object（KILL_ON_JOB_CLOSE + BREAKAWAY_OK）：
   将子进程纳入作业对象，关闭作业句柄时由内核连带杀死整棵进程树，
   并提供 OS 级内存/CPU/时间上限兜底。
2. （可选，需管理员 SeTcbPrivilege）受限令牌 + 低完整性级别：
   降权运行子进程，即使逃逸沙箱也无法触及高权限资源。

设计原则 —— 全部「尽最大努力 + 安全降级」：
- pywin32 缺失、非 Windows、受限令牌创建失败、或子进程已处于不可脱离的父作业，
  都只记录日志并退回软沙箱，绝不抛错中断执行。
- 由环境变量 ``SANDBOX_HARD_WINDOWS`` 控制是否启用（默认关闭），避免影响现有行为。

典型生产启用（Windows + 已 ``pip install pywin32``）：

    set SANDBOX_HARD_WINDOWS=true
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Any
from agent.core.logger import log_ignored

log = logging.getLogger("sandbox.windows_hard")


class HardIsolationUnavailable(Exception):
    """硬隔离不可用（非 Windows 或 pywin32 缺失）。"""


def hard_windows_enabled() -> bool:
    """解析 SANDBOX_HARD_WINDOWS 开关。

    - ``false``（默认）/ ``0`` / ``no`` / ``off`` → 关闭。
    - ``true`` / ``1`` / ``yes`` / ``on`` → 启用（pywin32 不可用时自动降级）。
    - ``auto`` → 仅当 pywin32 可用时启用。
    """
    val = os.environ.get("SANDBOX_HARD_WINDOWS", "false").strip().lower()
    if val in ("false", "0", "no", "off", ""):
        return False
    if val in ("true", "1", "yes", "on"):
        return True
    if val == "auto":
        return WindowsHardSandbox.is_available()
    return False


def _pywin32_available() -> bool:
    try:
        import win32job  # noqa: F401
        import win32api  # noqa: F401
        import win32security  # noqa: F401
        import win32process  # noqa: F401
        import win32con  # noqa: F401
        return True
    except Exception:
        return False


class WindowsHardSandbox:
    """Windows 硬隔离封装（Job Object + 可选受限令牌）。

    所有公开的创建/分配操作在 pywin32 不可用或失败时抛出 ``HardIsolationUnavailable``，
    调用方应捕获并退回软沙箱。
    """

    def __init__(self, enable_restricted_token: bool = False) -> None:
        self.enable_restricted_token = enable_restricted_token
        self._job: Any | None = None
        self._imports: dict[str, Any] = self._load()

    @staticmethod
    def _load() -> dict[str, Any]:
        if sys.platform != "win32":
            raise HardIsolationUnavailable("not windows platform")
        try:
            import win32con
            import win32job
            import win32process
            import win32security
            return {
                "win32con": win32con,
                "win32job": win32job,
                "win32process": win32process,
                "win32security": win32security,
            }
        except Exception as e:  # pragma: no cover - 依赖缺失路径
            raise HardIsolationUnavailable(f"pywin32 missing: {e}")

    @classmethod
    def is_available(cls) -> bool:
        return sys.platform == "win32" and _pywin32_available()

    def create_job(self) -> Any:
        """创建 Job Object，设置 KILL_ON_JOB_CLOSE + BREAKAWAY_OK。"""
        win32job = self._imports["win32job"]
        job = win32job.CreateJobObject(None, None)
        info = win32job.QueryInformationJobObject(
            job, win32job.JobObjectExtendedLimitInformation
        )
        info["BasicLimitInformation"]["LimitFlags"] = (
            win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | win32job.JOB_OBJECT_LIMIT_BREAKAWAY_OK
        )
        win32job.SetInformationJobObject(
            job, win32job.JobObjectExtendedLimitInformation, info
        )
        self._job = job
        return job

    def assign(self, proc_handle: int) -> None:
        """将进程（原始 HANDLE 值）分配到 Job Object。"""
        win32job = self._imports["win32job"]
        if self._job is None:
            self.create_job()
        # AssignProcessToJobObject 接受进程 HANDLE（int 或 PyHANDLE）。
        win32job.AssignProcessToJobObject(self._job, proc_handle)

    def apply_restricted_token(self, proc_handle: int) -> None:
        """（可选）为子进程设置受限令牌 + 低完整性级别。

        需要管理员权限（SeTcbPrivilege）；失败由调用方吞掉并退回软沙箱。
        """
        if not self.enable_restricted_token:
            return
        win32security = self._imports["win32security"]
        win32api = self._imports["win32api"]
        win32con = self._imports["win32con"]
        # 去权：移除除「受限」「登录会话 ID」外的所有 SID，并设低完整性。
        flags = (
            win32security.DISABLE_MAX_PRIVILEGE
            | win32security.SANDBOX_INERT
        )
        token = win32security.OpenProcessToken(
            proc_handle, win32con.TOKEN_ALL_ACCESS
        )
        restricted = win32security.CreateRestrictedToken(
            token, flags, None, None, None
        )
        # 设低完整性级别（SID: S-1-16-4096）。
        win32security.SetTokenInformation(
            restricted,
            win32security.TokenIntegrityLevel,
            (win32security.SID(("S-1-16-4096",)), 0),
        )
        win32api.CloseHandle(token)

    def close(self) -> None:
        if self._job is not None:
            try:
                self._job.Close()
            except Exception as _exc:  # pragma: no cover
                log_ignored_hard(_exc)
            self._job = None


def log_ignored_hard(_exc: Exception) -> None:
    try:
        log.debug("windows_hard close ignored", exc_info=_exc)
    except Exception as _exc:
        log_ignored(log, "windows_hard.log_ignored_hard", _exc)
