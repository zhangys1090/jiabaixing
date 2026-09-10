"""AutoRollback — 自动回滚。

当操作满足回滚条件时，自动恢复到还原点。回滚触发条件：
1. 超时：操作超过指定时间未完成
2. 异常：操作抛出未捕获异常
3. 作用域违反：操作超出 OperationScope 限制
4. 质量不达标：LLM 评估结果低于阈值

与 CheckpointManager 的关系：
- AutoRollback 在操作前创建还原点
- 操作失败时调用 CheckpointManager.restore_checkpoint() 回滚

Usage:
    from agent.safety.auto_rollback import AutoRollback, RollbackPolicy

    rb = AutoRollback(checkpoint_manager, rollback_policy=RollbackPolicy(timeout_seconds=60))
    async with rb.guard(paths=["/project"], label="重构"):
        # 执行操作...
        pass  # 正常完成，不回滚
"""

from __future__ import annotations

import asyncio
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from agent.safety.checkpoint_manager import CheckpointManager, Checkpoint
from agent.safety.operation_scope import OperationScope, ScopeViolation
from agent.core.logger import StructuredLogger

log = StructuredLogger("auto_rollback")



@dataclass
class RollbackPolicy:
    """回滚策略。

    Attributes:
        timeout_seconds: 执行超时（秒）。
        max_error_count: 最大错误次数。
        quality_threshold: 质量评估阈值（0-1）。
        auto_rollback_on_violation: 作用域违反时是否自动回滚。
        max_rollback_attempts: 最大回滚尝试次数。
    """

    timeout_seconds: float = 300.0
    max_error_count: int = 3
    quality_threshold: float = 0.6
    auto_rollback_on_violation: bool = True
    max_rollback_attempts: int = 1


@dataclass
class RollbackRecord:
    """回滚记录。

    Attributes:
        id: 回滚记录 ID。
        checkpoint_id: 关联的还原点 ID。
        trigger: 回滚触发原因（timeout/error/violation/quality/manual）。
        detail: 回滚详情。
        started_at: 回滚开始时间。
        completed_at: 回滚完成时间。
        success: 回滚是否成功。
        restored_files: 恢复的文件数。
        errors: 回滚过程中的错误。
    """

    id: str
    checkpoint_id: str = ""
    trigger: str = ""
    detail: str = ""
    started_at: float = 0.0
    completed_at: float = 0.0
    success: bool = False
    restored_files: int = 0
    errors: list[str] = field(default_factory=list)


class RollbackGuard:
    """回滚保护上下文管理器。

    使用 async with 语法包裹需要保护的操作：

    async with rb.guard(paths=["/project"], label="重构") as guard:
        # guard.checkpoint 可获取还原点信息
        # guard.scope 可检查作用域
        # 操作失败时自动回滚
    """

    def __init__(
        self,
        rollback: AutoRollback,
        paths: list[str] | None,
        label: str,
        trigger: str,
        scope: OperationScope | None,
    ) -> None:
        self._rollback = rollback
        self._paths = paths
        self._label = label
        self._trigger = trigger
        self._scope = scope
        self.checkpoint: Checkpoint | None = None
        self._error_count = 0
        self._start_time = time.time()
        self._locked_paths: list[str] = []

    async def __aenter__(self) -> RollbackGuard:
        self._locked_paths = await self._rollback.acquire_path_locks(self._paths)
        self.checkpoint = self._rollback._cp_mgr.create_checkpoint(
            paths=self._paths,
            label=self._label,
            trigger=self._trigger,
        )
        self._rollback._active_guards.append(self)
        log.info("回滚保护启动", checkpoint=self.checkpoint.id, label=self._label)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        self._rollback._active_guards.remove(self)
        try:
            if not self.checkpoint:
                return False

            should_rollback = False
            trigger = ""
            detail = ""

            if exc_type is not None:
                should_rollback = True
                trigger = "error"
                detail = f"{exc_type.__name__}: {exc_val}"
                self._error_count += 1
            elif self._scope:
                violations = self._scope.violations
                if violations and self._rollback._policy.auto_rollback_on_violation:
                    should_rollback = True
                    trigger = "violation"
                    detail = f"作用域违反 {len(violations)} 次: {violations[-1].detail}"
                elapsed = time.time() - self._start_time
                if elapsed > self._rollback._policy.timeout_seconds:
                    should_rollback = True
                    trigger = "timeout"
                    detail = f"操作超时 {elapsed:.1f}s"

            if should_rollback and self.checkpoint:
                record = self._rollback.execute_rollback(
                    self.checkpoint.id, trigger=trigger, detail=detail,
                )
                log.warning(
                    "自动回滚触发",
                    trigger=trigger,
                    checkpoint=self.checkpoint.id,
                    success=record.success,
                )

            return should_rollback
        finally:
            if self._locked_paths:
                await self._rollback.release_path_locks(self._locked_paths)
                self._locked_paths = []

    def record_error(self) -> None:
        self._error_count += 1

    @property
    def error_count(self) -> int:
        return self._error_count


class AutoRollback:
    """自动回滚引擎。

    在操作前创建还原点，操作失败时自动恢复。支持：
    - 超时回滚
    - 异常回滚
    - 作用域违反回滚
    - 手动回滚

    Usage:
        cp_mgr = CheckpointManager()
        rb = AutoRollback(cp_mgr, rollback_policy=RollbackPolicy(timeout_seconds=60))
        async with rb.guard(paths=["/project"], label="重构") as guard:
            await do_something_risky()
    """

    def __init__(
        self,
        checkpoint_manager: CheckpointManager,
        rollback_policy: RollbackPolicy | None = None,
    ) -> None:
        self._cp_mgr = checkpoint_manager
        self._policy = rollback_policy or RollbackPolicy()
        self._active_guards: list[RollbackGuard] = []
        self._history: list[RollbackRecord] = []
        self._path_locks: dict[str, asyncio.Lock] = {}
        self._active_path_set: set[str] = set()
        self._master_lock = asyncio.Lock()
        self._MAX_HISTORY = 5000
        self._MAX_PATH_LOCKS = 10000

    def guard(
        self,
        paths: list[str] | None = None,
        label: str = "",
        trigger: str = "pre-batch",
        scope: OperationScope | None = None,
    ) -> RollbackGuard:
        """创建回滚保护上下文。

        Args:
            paths: 需要保护的路径列表。
            label: 还原点标签。
            trigger: 触发原因。
            scope: 操作作用域（用于检测违反）。

        Returns:
            RollbackGuard: async with 上下文管理器。
        """
        return RollbackGuard(self, paths, label, trigger, scope)

    async def acquire_path_locks(self, paths: list[str] | None) -> list[str]:
        """P1: 获取路径锁，防止并发操作同一文件。

        Returns:
            已获取锁的路径列表。
        """
        if not paths:
            return []

        resolved = [str(p) for p in paths]
        acquired: list[str] = []

        async with self._master_lock:
            overlap = [p for p in resolved if p in self._active_path_set]
            if overlap:
                log.warning(
                    "并发路径冲突检测",
                    conflicting_paths=overlap,
                    action="排队等待",
                )

            for p in resolved:
                if p not in self._path_locks:
                    self._path_locks[p] = asyncio.Lock()

        for p in resolved:
            try:
                await self._path_locks[p].acquire()
                acquired.append(p)
            except BaseException:
                for ap in reversed(acquired):
                    self._path_locks[ap].release()
                raise

        async with self._master_lock:
            self._active_path_set.update(acquired)

        return acquired

    async def release_path_locks(self, paths: list[str]) -> None:
        """P1: 释放路径锁。"""
        for p in paths:
            lock = self._path_locks.get(p)
            if lock and lock.locked():
                lock.release()
        async with self._master_lock:
            self._active_path_set -= set(paths)
            if len(self._path_locks) > self._MAX_PATH_LOCKS:
                stale = [p for p in self._path_locks if p not in self._active_path_set]
                for p in stale[: len(self._path_locks) - (self._MAX_PATH_LOCKS * 3 // 4)]:
                    del self._path_locks[p]

    def execute_rollback(
        self,
        checkpoint_id: str,
        trigger: str = "manual",
        detail: str = "",
    ) -> RollbackRecord:
        """执行回滚操作。

        Args:
            checkpoint_id: 要恢复到的还原点 ID。
            trigger: 回滚触发原因。
            detail: 回滚详情。

        Returns:
            RollbackRecord: 回滚记录。
        """
        record = RollbackRecord(
            id=uuid.uuid4().hex[:12],
            checkpoint_id=checkpoint_id,
            trigger=trigger,
            detail=detail,
            started_at=time.time(),
        )

        result = self._cp_mgr.restore_checkpoint(checkpoint_id)
        record.completed_at = time.time()
        record.success = result.get("success", False)
        record.restored_files = result.get("restored_files", 0)
        record.errors = result.get("errors", [])

        self._history.append(record)
        if len(self._history) > self._MAX_HISTORY:
            self._history = self._history[-self._MAX_HISTORY * 3 // 4:]
        log.info(
            "回滚执行完成",
            id=record.id,
            trigger=trigger,
            success=record.success,
            restored_files=record.restored_files,
        )
        return record

    def manual_rollback(self, checkpoint_id: str, reason: str = "") -> RollbackRecord:
        """手动触发回滚。"""
        return self.execute_rollback(checkpoint_id, trigger="manual", detail=reason)

    @property
    def history(self) -> list[RollbackRecord]:
        return list(self._history)

    @property
    def active_guards(self) -> list[RollbackGuard]:
        return list(self._active_guards)

    @property
    def policy(self) -> RollbackPolicy:
        return self._policy
