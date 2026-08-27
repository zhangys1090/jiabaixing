"""关闭取证（关闭原因分析）。

记录和分析服务关闭/崩溃的原因：
  - 关闭原因分类（正常/异常/OOM/超时/信号等）
  - 关闭前状态快照
  - 崩溃堆栈捕获
  - 关闭历史统计
  - 自动恢复策略

与 AgentEngine 的关系：
  - AgentEngine 关闭时调用 ShutdownForensics.record()
  - 下次启动时检查上次关闭原因
  - 异常关闭触发恢复流程

集成示例::

    from agent.gateway.forensics import ShutdownForensics

    forensics = ShutdownForensics()
    forensics.record(reason=ShutdownReason.CRASH, details={"error": str(exc)})
    last = forensics.get_last_shutdown()
    if last.reason == ShutdownReason.CRASH:
        await recovery.recover_from(last)
"""

from __future__ import annotations

import json
import os
import platform
import signal
import sys
import threading
import time
import traceback
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_ROOT

from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.forensics")


class ShutdownReason(str, Enum):
    NORMAL = "normal"
    SIGTERM = "sigterm"
    SIGINT = "sigint"
    CRASH = "crash"
    OOM = "oom"
    TIMEOUT = "timeout"
    HEALTH_CHECK = "health_check"
    MANUAL = "manual"
    RESTART = "restart"
    UNKNOWN = "unknown"


class ShutdownSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass
class ShutdownRecord:
    id: str
    reason: ShutdownReason
    severity: ShutdownSeverity
    timestamp: float = 0.0
    uptime_seconds: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)
    stack_trace: str = ""
    system_info: dict[str, Any] = field(default_factory=dict)
    active_sessions: int = 0
    active_tasks: int = 0
    memory_mb: float = 0.0
    cpu_percent: float = 0.0

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "reason": self.reason.value,
            "severity": self.severity.value,
            "timestamp": self.timestamp,
            "uptime_seconds": round(self.uptime_seconds, 1),
            "details": self.details,
            "stack_trace": self.stack_trace[:2000] if self.stack_trace else "",
            "active_sessions": self.active_sessions,
            "active_tasks": self.active_tasks,
            "memory_mb": round(self.memory_mb, 1),
        }


@dataclass
class RecoveryAction:
    action: str
    priority: int = 0
    description: str = ""
    auto_execute: bool = False


_REASON_SEVERITY: dict[ShutdownReason, ShutdownSeverity] = {
    ShutdownReason.NORMAL: ShutdownSeverity.INFO,
    ShutdownReason.SIGTERM: ShutdownSeverity.INFO,
    ShutdownReason.SIGINT: ShutdownSeverity.INFO,
    ShutdownReason.MANUAL: ShutdownSeverity.INFO,
    ShutdownReason.RESTART: ShutdownSeverity.INFO,
    ShutdownReason.CRASH: ShutdownSeverity.CRITICAL,
    ShutdownReason.OOM: ShutdownSeverity.CRITICAL,
    ShutdownReason.TIMEOUT: ShutdownSeverity.ERROR,
    ShutdownReason.HEALTH_CHECK: ShutdownSeverity.WARNING,
    ShutdownReason.UNKNOWN: ShutdownSeverity.WARNING,
}

_RECOVERY_ACTIONS: dict[ShutdownReason, list[RecoveryAction]] = {
    ShutdownReason.CRASH: [
        RecoveryAction(action="check_last_record", priority=1, description="检查上次关闭记录", auto_execute=True),
        RecoveryAction(action="validate_state", priority=2, description="验证状态完整性", auto_execute=True),
        RecoveryAction(action="notify_admin", priority=3, description="通知管理员"),
    ],
    ShutdownReason.OOM: [
        RecoveryAction(action="reduce_cache_size", priority=1, description="减少缓存大小", auto_execute=True),
        RecoveryAction(action="gc_collect", priority=2, description="强制垃圾回收", auto_execute=True),
        RecoveryAction(action="restart_with_limits", priority=3, description="带内存限制重启"),
    ],
    ShutdownReason.TIMEOUT: [
        RecoveryAction(action="increase_timeout", priority=1, description="增加超时时间"),
        RecoveryAction(action="check_network", priority=2, description="检查网络连接"),
    ],
    ShutdownReason.HEALTH_CHECK: [
        RecoveryAction(action="restart_adapters", priority=1, description="重启适配器", auto_execute=True),
        RecoveryAction(action="full_restart", priority=2, description="完全重启"),
    ],
}


class ShutdownForensics:
    """关闭取证管理器。

    记录、分析和服务关闭/崩溃原因。
    """

    def __init__(self, data_dir: Path | None = None) -> None:
        self._dir = data_dir or DATA_ROOT / "forensics"
        self._records: list[ShutdownRecord] = []
        self._start_time: float = time.time()
        self._registered_signals: bool = False
        # 自管道（self-pipe）：信号处理器内仅做 os.write（异步信号安全），
        # 由独立守护线程读取并执行 record + 关闭回调（见 register_signal_handlers）。
        self._signal_rfd: int | None = None
        self._signal_wfd: int | None = None
        self._pending_signal: ShutdownReason | None = None
        self._shutdown_callback: Any = None
        self._load_records()

    def _load_records(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        record_file = self._dir / "shutdown_history.json"
        if record_file.exists():
            try:
                data = json.loads(record_file.read_text(encoding="utf-8"))
                for item in data.get("records", [])[-100:]:
                    record = ShutdownRecord(
                        id=item.get("id", ""),
                        reason=ShutdownReason(item.get("reason", "unknown")),
                        severity=ShutdownSeverity(item.get("severity", "info")),
                        timestamp=item.get("timestamp", 0),
                        uptime_seconds=item.get("uptime_seconds", 0),
                        details=item.get("details", {}),
                        stack_trace=item.get("stack_trace", ""),
                        active_sessions=item.get("active_sessions", 0),
                        active_tasks=item.get("active_tasks", 0),
                        memory_mb=item.get("memory_mb", 0),
                    )
                    self._records.append(record)
            except Exception as e:
                log.warning("加载关闭记录失败", error=str(e))

    def _save_records(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        record_file = self._dir / "shutdown_history.json"
        data = {
            "records": [r.to_dict() for r in self._records[-100:]],
        }
        record_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def _get_system_info(self) -> dict[str, Any]:
        try:
            import psutil
            mem = psutil.virtual_memory()
            return {
                "platform": platform.platform(),
                "python": platform.python_version(),
                "cpu_count": os.cpu_count(),
                "memory_total_mb": round(mem.total / 1024 / 1024),
                "memory_available_mb": round(mem.available / 1024 / 1024),
                "memory_percent": mem.percent,
            }
        except ImportError:
            return {
                "platform": platform.platform(),
                "python": platform.python_version(),
                "cpu_count": os.cpu_count(),
            }

    def _get_memory_mb(self) -> float:
        try:
            import psutil
            process = psutil.Process(os.getpid())
            return process.memory_info().rss / 1024 / 1024
        except (ImportError, Exception):
            return 0.0

    def set_shutdown_callback(self, cb: Any) -> None:
        """注册关闭回调：信号触发且记录完成后调用（如触发进程优雅关闭）。

        回调在独立守护线程中执行，不应做重活或持有 GIL 外的非线程安全资源。
        """
        self._shutdown_callback = cb

    def register_signal_handlers(self) -> None:
        if self._registered_signals:
            return

        try:
            rfd, wfd = os.pipe()
            # 写端非阻塞：避免信号高频时写满管道导致 os.write 阻塞（异步信号安全前提下）
            os.set_blocking(wfd, False)
            self._signal_rfd, self._signal_wfd = rfd, wfd
        except OSError as e:
            log.warning("无法创建信号自管道，信号记录降级为禁用", error=str(e))
            return

        def _sig_handler(signum: int, frame: Any) -> None:
            # 仅执行异步信号安全操作（os.write + 置标志），绝不在处理器内做
            # 对象构造 / 文件 I/O / traceback 等不安全工作（审计 S-05）。
            reason = (
                ShutdownReason.SIGTERM if signum == signal.SIGTERM
                else ShutdownReason.SIGINT
            )
            self._pending_signal = reason
            try:
                os.write(self._signal_wfd, b"\x00")
            except OSError:
                pass

        def _signal_reader() -> None:
            # 守护线程：读取自管道，在「非信号上下文」中执行 record 与关闭回调，
            # 既保证异步信号安全，又真正把信号「转发」给关闭流程。
            while True:
                try:
                    self._signal_rfd is not None and os.read(self._signal_rfd, 1)
                except OSError:
                    return
                reason = self._pending_signal
                if reason is None:
                    continue
                try:
                    signum = (
                        signal.SIGTERM if reason is ShutdownReason.SIGTERM
                        else signal.SIGINT
                    )
                    self.record(reason, {"signal": signum})
                except Exception as _exc:
                    log.warning("关机信号记录失败", error=str(_exc))
                cb = self._shutdown_callback
                if cb is not None:
                    try:
                        cb()
                    except Exception as _exc:
                        log.warning("关机回调执行失败", error=str(_exc))

        try:
            signal.signal(signal.SIGTERM, _sig_handler)
            signal.signal(signal.SIGINT, _sig_handler)
            reader = threading.Thread(
                target=_signal_reader, daemon=True, name="forensics-signal"
            )
            reader.start()
            self._registered_signals = True
            log.debug("关闭信号处理器已注册（自管道模式，异步信号安全）")
        except (OSError, ValueError) as e:
            log.warning("信号处理器注册失败", error=str(e))

    def record(
        self,
        reason: ShutdownReason,
        details: dict[str, Any] | None = None,
        stack_trace: str = "",
        active_sessions: int = 0,
        active_tasks: int = 0,
    ) -> ShutdownRecord:
        if not stack_trace and reason in (ShutdownReason.CRASH, ShutdownReason.UNKNOWN):
            stack_trace = traceback.format_stack()[-10:]

        severity = _REASON_SEVERITY.get(reason, ShutdownSeverity.WARNING)
        uptime = time.time() - self._start_time

        record = ShutdownRecord(
            id=f"shutdown_{int(time.time()*1000)}",
            reason=reason,
            severity=severity,
            uptime_seconds=uptime,
            details=details or {},
            stack_trace=stack_trace,
            system_info=self._get_system_info(),
            active_sessions=active_sessions,
            active_tasks=active_tasks,
            memory_mb=self._get_memory_mb(),
        )

        self._records.append(record)
        self._save_records()

        log.info(
            "关闭已记录",
            reason=reason.value,
            severity=severity.value,
            uptime=f"{uptime:.0f}s",
        )
        return record

    def record_exception(self, exc: BaseException, **kwargs: Any) -> ShutdownRecord:
        stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        details = {
            "exception_type": type(exc).__name__,
            "exception_message": str(exc)[:500],
            **kwargs,
        }
        return self.record(ShutdownReason.CRASH, details=details, stack_trace=stack)

    def get_last_shutdown(self) -> ShutdownRecord | None:
        if not self._records:
            return None
        return self._records[-1]

    def was_clean_shutdown(self) -> bool:
        last = self.get_last_shutdown()
        if last is None:
            return True
        return last.reason in (
            ShutdownReason.NORMAL,
            ShutdownReason.SIGTERM,
            ShutdownReason.SIGINT,
            ShutdownReason.MANUAL,
            ShutdownReason.RESTART,
        )

    def get_recovery_actions(self, reason: ShutdownReason | None = None) -> list[RecoveryAction]:
        target = reason
        if target is None:
            last = self.get_last_shutdown()
            if last is None:
                return []
            target = last.reason
        actions = _RECOVERY_ACTIONS.get(target, [])
        return sorted(actions, key=lambda a: a.priority)

    def get_stats(self) -> dict[str, Any]:
        reason_counts: dict[str, int] = defaultdict(int)
        for r in self._records:
            reason_counts[r.reason.value] += 1

        avg_uptime = 0.0
        if self._records:
            avg_uptime = sum(r.uptime_seconds for r in self._records) / len(self._records)

        return {
            "total_shutdowns": len(self._records),
            "reason_counts": dict(reason_counts),
            "avg_uptime_seconds": round(avg_uptime, 1),
            "last_reason": self._records[-1].reason.value if self._records else None,
            "was_clean": self.was_clean_shutdown(),
        }

    def mark_clean_startup(self) -> None:
        self._start_time = time.time()
        log.info("干净启动标记已设置")
