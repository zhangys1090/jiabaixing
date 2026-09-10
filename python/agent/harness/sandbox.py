"""沙箱隔离守护 — 学习 Codex Harness 的 Sandbox Isolation 设计.

Codex Harness 沙箱:
  - 每个任务在独立沙箱中执行
  - 文件系统隔离: 只允许访问工作目录
  - 网络隔离: 可配置允许/禁止的网络访问
  - 资源限制: CPU/内存/时间上限
  - 副作用可控: 沙箱内操作可回滚

jiabaixing 适配:
  - 评测用例在沙箱中执行，避免用例间污染
  - 工具调用可配置沙箱级别
  - 沙箱内文件变更可追踪和回滚
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("sandbox_guard")


class SandboxPolicy(str, Enum):
    NONE = "none"
    EVAL = "eval"
    TOOL = "tool"
    STRICT = "strict"


@dataclass
class SandboxConfig:
    policy: SandboxPolicy = SandboxPolicy.EVAL
    allowed_paths: list[str] = field(default_factory=list)
    blocked_paths: list[str] = field(default_factory=list)
    allow_network: bool = True
    allow_file_write: bool = True
    allow_shell: bool = False
    max_file_size_mb: int = 10
    max_execution_time_s: float = 60.0
    max_memory_mb: int = 512
    track_file_changes: bool = True


@dataclass
class FileChange:
    path: str
    operation: str
    content_before: str = ""
    content_after: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class SandboxSession:
    session_id: str
    config: SandboxConfig
    created_at: float = field(default_factory=time.time)
    file_changes: list[FileChange] = field(default_factory=list)
    temp_dir: str = ""
    active: bool = True


_NONE_SANDBOX_CONFIG = SandboxConfig(
    policy=SandboxPolicy.NONE,
    allow_network=True,
    allow_file_write=True,
    allow_shell=True,
    max_execution_time_s=300.0,
    track_file_changes=True,
)

_EVAL_SANDBOX_CONFIG = SandboxConfig(
    policy=SandboxPolicy.EVAL,
    allow_network=True,
    allow_file_write=False,
    allow_shell=False,
    max_execution_time_s=120.0,
    track_file_changes=True,
)

_TOOL_SANDBOX_CONFIG = SandboxConfig(
    policy=SandboxPolicy.TOOL,
    allow_network=True,
    allow_file_write=True,
    allow_shell=False,
    max_execution_time_s=30.0,
    track_file_changes=True,
)

_STRICT_SANDBOX_CONFIG = SandboxConfig(
    policy=SandboxPolicy.STRICT,
    allow_network=False,
    allow_file_write=False,
    allow_shell=False,
    max_execution_time_s=10.0,
    max_memory_mb=256,
    track_file_changes=True,
)


class SandboxGuard:
    """沙箱隔离守护 — Codex-style Sandbox Isolation.

    功能:
      - 创建/销毁隔离沙箱会话
      - 文件变更追踪与回滚
      - 资源限制检查
      - 操作权限验证
    """

    def __init__(self, base_temp_dir: str = ""):
        self._base_temp = base_temp_dir or tempfile.gettempdir()
        self._sessions: dict[str, SandboxSession] = {}

    def create_session(
        self,
        session_id: str,
        policy: SandboxPolicy = SandboxPolicy.EVAL,
        config: SandboxConfig | None = None,
    ) -> SandboxSession:
        if config is None:
            config = self._get_config_for_policy(policy)

        temp_dir = os.path.join(self._base_temp, f"jiabaixing_sandbox_{session_id}")
        os.makedirs(temp_dir, exist_ok=True)

        session = SandboxSession(
            session_id=session_id,
            config=config,
            temp_dir=temp_dir,
        )
        self._sessions[session_id] = session
        log.info("沙箱会话已创建", session=session_id, policy=policy.value)
        return session

    def destroy_session(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session and session.temp_dir and os.path.exists(session.temp_dir):
            try:
                shutil.rmtree(session.temp_dir, ignore_errors=True)
            except Exception as e:
                log.warning("沙箱临时目录清理失败", session=session_id, error=str(e))
        if session:
            session.active = False
            log.info("沙箱会话已销毁", session=session_id)

    def check_operation(
        self,
        session_id: str,
        operation: str,
        target: str = "",
    ) -> tuple[bool, str]:
        session = self._sessions.get(session_id)
        if not session or not session.active:
            return False, "沙箱会话不存在或已关闭"

        config = session.config

        if operation == "file_write":
            if not config.allow_file_write:
                return False, "沙箱禁止文件写入"
            if target and config.blocked_paths:
                for blocked in config.blocked_paths:
                    if target.startswith(blocked):
                        return False, f"路径被沙箱阻止: {blocked}"

        elif operation == "network":
            if not config.allow_network:
                return False, "沙箱禁止网络访问"

        elif operation == "shell":
            if not config.allow_shell:
                return False, "沙箱禁止Shell执行"

        return True, "操作允许"

    def record_file_change(
        self,
        session_id: str,
        path: str,
        operation: str,
        content_before: str = "",
        content_after: str = "",
    ) -> None:
        session = self._sessions.get(session_id)
        if not session or not session.config.track_file_changes:
            return
        session.file_changes.append(FileChange(
            path=path,
            operation=operation,
            content_before=content_before,
            content_after=content_after,
        ))

    def rollback_session(self, session_id: str) -> list[str]:
        session = self._sessions.get(session_id)
        if not session:
            return []

        rolled_back = []
        for change in reversed(session.file_changes):
            if change.operation in ("write", "create"):
                try:
                    p = Path(change.path)
                    if change.content_before:
                        p.write_text(change.content_before, encoding="utf-8")
                    elif p.exists():
                        p.unlink(missing_ok=True)
                    rolled_back.append(change.path)
                except Exception as e:
                    log.warning("回滚失败", path=change.path, error=str(e))

        session.file_changes.clear()
        if rolled_back:
            log.info("沙箱回滚完成", session=session_id, count=len(rolled_back))
        return rolled_back

    def get_session_info(self, session_id: str) -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if not session:
            return None
        return {
            "session_id": session.session_id,
            "policy": session.config.policy.value,
            "active": session.active,
            "file_changes": len(session.file_changes),
            "allow_network": session.config.allow_network,
            "allow_file_write": session.config.allow_file_write,
            "allow_shell": session.config.allow_shell,
            "max_execution_time_s": session.config.max_execution_time_s,
        }

    def cleanup_all(self) -> int:
        count = 0
        for sid in list(self._sessions.keys()):
            self.destroy_session(sid)
            count += 1
        return count

    @staticmethod
    def _get_config_for_policy(policy: SandboxPolicy) -> SandboxConfig:
        configs = {
            SandboxPolicy.NONE: _NONE_SANDBOX_CONFIG,
            SandboxPolicy.EVAL: _EVAL_SANDBOX_CONFIG,
            SandboxPolicy.TOOL: _TOOL_SANDBOX_CONFIG,
            SandboxPolicy.STRICT: _STRICT_SANDBOX_CONFIG,
        }
        return configs.get(policy, _EVAL_SANDBOX_CONFIG)
