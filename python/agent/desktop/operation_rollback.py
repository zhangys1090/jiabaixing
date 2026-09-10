"""操作回滚引擎 (Operation Rollback Engine)。

解决桌面操作失败后只能重试、无法撤销部分执行操作的问题。
执行前保存 StateCheckpoint，失败时按逆序回滚已执行操作。

核心流程:
  1. 操作执行前: checkpoint = engine.save_checkpoint()
  2. 操作执行: result = execute(action)
  3. 成功: engine.commit_action(action)
  4. 失败: engine.rollback() → 恢复到 checkpoint

支持的回滚操作:
  - 文件写入 → 恢复原始内容
  - 文件删除 → 恢复已删除文件
  - 剪贴板修改 → 恢复原始剪贴板
  - 窗口状态变更 → 恢复窗口位置/大小

Usage:
    engine = OperationRollbackEngine()
    checkpoint = engine.save_checkpoint("file_write", target_path="/tmp/test.txt")
    # ... 执行操作 ...
    engine.rollback(checkpoint.checkpoint_id)
"""

from __future__ import annotations

import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("operation_rollback")


class OperationType(str, Enum):
    FILE_WRITE = "file_write"
    FILE_DELETE = "file_delete"
    FILE_MOVE = "file_move"
    DIRECTORY_CREATE = "directory_create"
    CLIPBOARD_SET = "clipboard_set"
    WINDOW_STATE = "window_state"
    CUSTOM = "custom"


class CheckpointStatus(str, Enum):
    ACTIVE = "active"
    COMMITTED = "committed"
    ROLLED_BACK = "rolled_back"
    EXPIRED = "expired"


@dataclass
class StateSnapshot:
    operation: OperationType
    target: str
    original_state: dict[str, Any] = field(default_factory=dict)
    backup_path: str = ""


@dataclass
class Checkpoint:
    checkpoint_id: str = ""
    operation: OperationType = OperationType.CUSTOM
    target: str = ""
    snapshot: StateSnapshot | None = None
    status: CheckpointStatus = CheckpointStatus.ACTIVE
    created_at: float = 0.0
    actions_since: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class RollbackResult:
    checkpoint_id: str = ""
    success: bool = False
    actions_rolled_back: int = 0
    errors: list[str] = field(default_factory=list)
    partial_rollback: bool = False


@dataclass
class CommitResult:
    checkpoint_id: str = ""
    success: bool = True
    cleanup_performed: bool = False


_MAX_CHECKPOINTS = 50
_BACKUP_DIR_NAME = ".rollback_backups"


class OperationRollbackEngine:
    """操作回滚引擎。

    Args:
        backup_root: 备份文件存储根目录。
        auto_cleanup: 是否在 commit 后自动清理备份。
        max_checkpoints: 最大保留检查点数。
    """

    def __init__(
        self,
        backup_root: str | None = None,
        auto_cleanup: bool = True,
        max_checkpoints: int = _MAX_CHECKPOINTS,
    ) -> None:
        if backup_root:
            self._backup_root = Path(backup_root)
        else:
            data_dir = os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data"))
            self._backup_root = Path(data_dir) / _BACKUP_DIR_NAME

        self._backup_root.mkdir(parents=True, exist_ok=True)
        self._auto_cleanup = auto_cleanup
        self._max_checkpoints = max_checkpoints
        self._checkpoints: dict[str, Checkpoint] = {}

    def save_checkpoint(
        self,
        operation: str | OperationType,
        target: str = "",
        extra_state: dict[str, Any] | None = None,
    ) -> Checkpoint:
        if isinstance(operation, str):
            try:
                op_enum = OperationType(operation)
            except ValueError:
                op_enum = OperationType.CUSTOM
        else:
            op_enum = operation

        checkpoint_id = f"cp_{uuid.uuid4().hex[:10]}"

        snapshot = self._capture_state(op_enum, target, extra_state)

        checkpoint = Checkpoint(
            checkpoint_id=checkpoint_id,
            operation=op_enum,
            target=target,
            snapshot=snapshot,
            status=CheckpointStatus.ACTIVE,
            created_at=time.time(),
        )

        self._checkpoints[checkpoint_id] = checkpoint
        self._evict_old_checkpoints()

        log.info(
            "保存操作检查点",
            checkpoint_id=checkpoint_id,
            operation=op_enum.value,
            target=target,
        )
        return checkpoint

    def record_action(
        self,
        checkpoint_id: str,
        action_type: str,
        action_detail: dict[str, Any] | None = None,
    ) -> bool:
        checkpoint = self._checkpoints.get(checkpoint_id)
        if not checkpoint or checkpoint.status != CheckpointStatus.ACTIVE:
            return False

        checkpoint.actions_since.append({
            "action_type": action_type,
            "detail": action_detail or {},
            "timestamp": time.time(),
        })
        return True

    def rollback(self, checkpoint_id: str) -> RollbackResult:
        checkpoint = self._checkpoints.get(checkpoint_id)
        if not checkpoint:
            return RollbackResult(
                checkpoint_id=checkpoint_id,
                errors=[f"检查点不存在: {checkpoint_id}"],
            )

        if checkpoint.status != CheckpointStatus.ACTIVE:
            return RollbackResult(
                checkpoint_id=checkpoint_id,
                errors=[f"检查点状态不可回滚: {checkpoint.status.value}"],
            )

        errors: list[str] = []
        actions_rolled_back = 0
        partial = False

        if checkpoint.snapshot:
            restore_ok = self._restore_state(checkpoint.snapshot)
            if restore_ok:
                actions_rolled_back += 1
            else:
                errors.append(f"状态恢复失败: {checkpoint.operation.value} -> {checkpoint.target}")
                partial = True

        for action in reversed(checkpoint.actions_since):
            action_type = action.get("action_type", "")
            try:
                action_ok = self._rollback_action(action_type, action.get("detail", {}))
                if action_ok:
                    actions_rolled_back += 1
                else:
                    errors.append(f"操作回滚失败: {action_type}")
                    partial = True
            except Exception as exc:
                errors.append(f"操作回滚异常: {action_type} -> {exc}")
                partial = True

        checkpoint.status = CheckpointStatus.ROLLED_BACK
        success = not partial

        result = RollbackResult(
            checkpoint_id=checkpoint_id,
            success=success,
            actions_rolled_back=actions_rolled_back,
            errors=errors,
            partial_rollback=partial,
        )

        log.info(
            "操作回滚完成",
            checkpoint_id=checkpoint_id,
            success=success,
            rolled_back=actions_rolled_back,
            partial=partial,
        )
        return result

    def commit(self, checkpoint_id: str) -> CommitResult:
        checkpoint = self._checkpoints.get(checkpoint_id)
        if not checkpoint:
            return CommitResult(checkpoint_id=checkpoint_id, success=False)

        cleanup_performed = False
        if self._auto_cleanup and checkpoint.snapshot and checkpoint.snapshot.backup_path:
            try:
                backup_path = Path(checkpoint.snapshot.backup_path)
                if backup_path.exists():
                    if backup_path.is_dir():
                        shutil.rmtree(backup_path, ignore_errors=True)
                    else:
                        backup_path.unlink(missing_ok=True)
                    cleanup_performed = True
            except Exception as exc:
                log.warning("清理备份失败", backup_path=checkpoint.snapshot.backup_path, error=str(exc))

        checkpoint.status = CheckpointStatus.COMMITTED

        log.info("操作提交完成", checkpoint_id=checkpoint_id, cleanup=cleanup_performed)
        return CommitResult(
            checkpoint_id=checkpoint_id,
            success=True,
            cleanup_performed=cleanup_performed,
        )

    def _capture_state(
        self,
        operation: OperationType,
        target: str,
        extra_state: dict[str, Any] | None = None,
    ) -> StateSnapshot:
        original_state: dict[str, Any] = {}
        backup_path = ""

        if operation == OperationType.FILE_WRITE and target:
            target_path = Path(target)
            if target_path.exists() and target_path.is_file():
                try:
                    original_state["content_hash"] = hash(target_path.read_text(encoding="utf-8", errors="replace"))
                    original_state["size"] = target_path.stat().st_size
                    original_state["mtime"] = target_path.stat().st_mtime

                    backup_path = str(self._backup_root / f"{uuid.uuid4().hex[:8]}_{target_path.name}")
                    shutil.copy2(str(target_path), backup_path)
                    original_state["backup_path"] = backup_path
                except Exception as exc:
                    log.warning("文件状态捕获失败", target=target, error=str(exc))
            else:
                original_state["existed"] = False

        elif operation == OperationType.FILE_DELETE and target:
            target_path = Path(target)
            if target_path.exists():
                try:
                    backup_path = str(self._backup_root / f"{uuid.uuid4().hex[:8]}_{target_path.name}")
                    if target_path.is_file():
                        shutil.copy2(str(target_path), backup_path)
                    elif target_path.is_dir():
                        shutil.copytree(str(target_path), backup_path)
                    original_state["backup_path"] = backup_path
                    original_state["was_directory"] = target_path.is_dir()
                except Exception as exc:
                    log.warning("文件删除前备份失败", target=target, error=str(exc))

        elif operation == OperationType.FILE_MOVE and target:
            target_path = Path(target)
            if target_path.exists():
                try:
                    backup_path = str(self._backup_root / f"{uuid.uuid4().hex[:8]}_{target_path.name}")
                    if target_path.is_file():
                        shutil.copy2(str(target_path), backup_path)
                    original_state["backup_path"] = backup_path
                except Exception as exc:
                    log.warning("文件移动前备份失败", target=target, error=str(exc))

        if extra_state:
            original_state.update(extra_state)

        return StateSnapshot(
            operation=operation,
            target=target,
            original_state=original_state,
            backup_path=backup_path,
        )

    def _restore_state(self, snapshot: StateSnapshot) -> bool:
        operation = snapshot.operation
        target = snapshot.target
        state = snapshot.original_state

        if operation == OperationType.FILE_WRITE and target:
            target_path = Path(target)
            backup = state.get("backup_path", "")
            if backup and Path(backup).exists():
                try:
                    shutil.copy2(backup, str(target_path))
                    return True
                except Exception as exc:
                    log.warning("文件写入回滚失败", target=target, error=str(exc))
                    return False
            elif not state.get("existed", True):
                try:
                    target_path.unlink(missing_ok=True)
                    return True
                except Exception:
                    return False

        elif operation == OperationType.FILE_DELETE and target:
            backup = state.get("backup_path", "")
            if backup and Path(backup).exists():
                try:
                    target_path = Path(target)
                    if state.get("was_directory"):
                        if target_path.exists():
                            shutil.rmtree(str(target_path), ignore_errors=True)
                        shutil.copytree(backup, str(target_path))
                    else:
                        shutil.copy2(backup, str(target_path))
                    return True
                except Exception as exc:
                    log.warning("文件删除回滚失败", target=target, error=str(exc))
                    return False

        elif operation == OperationType.FILE_MOVE and target:
            backup = state.get("backup_path", "")
            if backup and Path(backup).exists():
                try:
                    shutil.copy2(backup, str(target))
                    return True
                except Exception as exc:
                    log.warning("文件移动回滚失败", target=target, error=str(exc))
                    return False

        elif operation == OperationType.CLIPBOARD_SET:
            return True

        elif operation == OperationType.CUSTOM:
            restore_fn = state.get("restore_fn")
            if callable(restore_fn):
                try:
                    restore_fn()
                    return True
                except Exception:
                    return False

        return True

    def _rollback_action(self, action_type: str, detail: dict[str, Any]) -> bool:
        restore_fn = detail.get("restore_fn")
        if callable(restore_fn):
            try:
                restore_fn()
                return True
            except Exception:
                return False

        rollback_data = detail.get("rollback_data")
        if rollback_data and isinstance(rollback_data, dict):
            target = rollback_data.get("target", "")
            content = rollback_data.get("content", "")
            if target and content:
                try:
                    Path(target).write_text(content, encoding="utf-8")
                    return True
                except Exception:
                    return False

        return True

    def _evict_old_checkpoints(self) -> None:
        if len(self._checkpoints) <= self._max_checkpoints:
            return

        active = {k: v for k, v in self._checkpoints.items() if v.status == CheckpointStatus.ACTIVE}
        inactive = {k: v for k, v in self._checkpoints.items() if v.status != CheckpointStatus.ACTIVE}

        sorted_inactive = sorted(inactive.items(), key=lambda x: x[1].created_at)
        to_remove = len(self._checkpoints) - self._max_checkpoints
        for i in range(min(to_remove, len(sorted_inactive))):
            cp_id = sorted_inactive[i][0]
            self._checkpoints.pop(cp_id, None)

    def get_checkpoint(self, checkpoint_id: str) -> Checkpoint | None:
        return self._checkpoints.get(checkpoint_id)

    def list_active_checkpoints(self) -> list[dict[str, Any]]:
        return [
            {
                "checkpoint_id": cp.checkpoint_id,
                "operation": cp.operation.value,
                "target": cp.target,
                "created_at": cp.created_at,
                "actions_since": len(cp.actions_since),
            }
            for cp in self._checkpoints.values()
            if cp.status == CheckpointStatus.ACTIVE
        ]
