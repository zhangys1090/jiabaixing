"""CheckpointManager — 还原点管理。

提供文件快照的创建、查询和恢复能力，是 SafetyNet 的核心组件。

快照策略（按优先级）：
1. Git 快照：如果目标路径在 Git 仓库内，使用 git stash + git commit 创建还原点
2. Copy-on-Write 快照：将文件复制到 .jiabaixing/checkpoints/ 目录
3. 空快照：无文件需要保护时创建标记性还原点

Usage:
    from agent.safety.checkpoint_manager import CheckpointManager

    mgr = CheckpointManager()
    cp = mgr.create_checkpoint(["/path/to/project"], label="重构前")
    # ... 执行操作 ...
    mgr.restore_checkpoint(cp.id)
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("checkpoint_manager")

_CHECKPOINTS_DIR = DATA_ROOT / "safety" / "checkpoints"
_DB_PATH = DATA_ROOT / "safety" / "checkpoints.db"


@dataclass
class FileSnapshot:
    """文件快照条目。

    Attributes:
        path: 原始文件路径。
        snapshot_path: 快照存储路径。
        hash: 文件内容 SHA256（前 16 字符）。
        size: 文件大小（字节）。
        mtime: 文件修改时间戳。
    """

    path: str
    snapshot_path: str = ""
    hash: str = ""
    size: int = 0
    mtime: float = 0.0


@dataclass
class Checkpoint:
    """还原点。

    Attributes:
        id: 唯一标识。
        label: 用户可读标签。
        created_at: 创建时间戳。
        trigger: 触发原因（auto/manual/pre-batch/pre-workflow）。
        file_snapshots: 文件快照映射 {原始路径: FileSnapshot}。
        git_commit: Git 还原点 commit hash（如有）。
        git_stash_ref: Git stash 引用（如有）。
        metadata: 扩展元数据。
        restored: 是否已被恢复。
    """

    id: str
    label: str = ""
    created_at: float = 0.0
    trigger: str = "auto"
    file_snapshots: dict[str, FileSnapshot] = field(default_factory=dict)
    git_commit: str = ""
    git_stash_ref: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    restored: bool = False


def _file_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _is_git_repo(path: str) -> bool:
    return (Path(path) / ".git").is_dir()


def _git_current_commit(repo_path: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception as _exc:
        log_ignored(log, "checkpoint_manager._git_current_commit", _exc)
    return None


def _git_stash_create(repo_path: str, label: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "stash", "push", "-m", f"jiabaixing-checkpoint: {label}"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and "No local changes" not in result.stdout:
            ref_result = subprocess.run(
                ["git", "stash", "list", "-1", "--format=%H"],
                cwd=repo_path,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if ref_result.returncode == 0:
                return ref_result.stdout.strip()
    except Exception as _exc:
        log_ignored(log, "checkpoint_manager._git_stash_create", _exc)
    return None


class CheckpointStore:
    """SQLite 持久化存储，记录还原点元数据。"""

    def __init__(self, db_path: str | None = None) -> None:
        self._db_path = db_path or str(_DB_PATH)
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS checkpoints (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    trigger TEXT NOT NULL DEFAULT 'auto',
                    git_commit TEXT NOT NULL DEFAULT '',
                    git_stash_ref TEXT NOT NULL DEFAULT '',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    restored INTEGER NOT NULL DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS file_snapshots (
                    checkpoint_id TEXT NOT NULL,
                    original_path TEXT NOT NULL,
                    snapshot_path TEXT NOT NULL DEFAULT '',
                    file_hash TEXT NOT NULL DEFAULT '',
                    file_size INTEGER NOT NULL DEFAULT 0,
                    file_mtime REAL NOT NULL DEFAULT 0,
                    PRIMARY KEY (checkpoint_id, original_path),
                    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id)
                )
            """)

    def save(self, cp: Checkpoint) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO checkpoints (id, label, created_at, trigger, git_commit, git_stash_ref, metadata, restored) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (cp.id, cp.label, cp.created_at, cp.trigger, cp.git_commit, cp.git_stash_ref, json.dumps(cp.metadata), int(cp.restored)),
            )
            for path, snap in cp.file_snapshots.items():
                conn.execute(
                    "INSERT OR REPLACE INTO file_snapshots (checkpoint_id, original_path, snapshot_path, file_hash, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?)",
                    (cp.id, path, snap.snapshot_path, snap.hash, snap.size, snap.mtime),
                )

    def load(self, checkpoint_id: str) -> Checkpoint | None:
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute("SELECT * FROM checkpoints WHERE id = ?", (checkpoint_id,)).fetchone()
            if not row:
                return None
            cp = Checkpoint(
                id=row[0], label=row[1], created_at=row[2], trigger=row[3],
                git_commit=row[4], git_stash_ref=row[5],
                metadata=safe_json_loads(row[6], {}, context="safety.checkpoint_manager.metadata"), restored=bool(row[7]),
            )
            snap_rows = conn.execute("SELECT original_path, snapshot_path, file_hash, file_size, file_mtime FROM file_snapshots WHERE checkpoint_id = ?", (checkpoint_id,)).fetchall()
            for sr in snap_rows:
                cp.file_snapshots[sr[0]] = FileSnapshot(
                    path=sr[0], snapshot_path=sr[1], hash=sr[2], size=sr[3], mtime=sr[4],
                )
            return cp

    def list_recent(self, limit: int = 20) -> list[Checkpoint]:
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute("SELECT id FROM checkpoints ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            results = []
            for r in rows:
                cp = self.load(r[0])
                if cp:
                    results.append(cp)
            return results

    def mark_restored(self, checkpoint_id: str) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("UPDATE checkpoints SET restored = 1 WHERE id = ?", (checkpoint_id,))

    def cleanup_older_than(self, days: int = 30) -> int:
        cutoff = time.time() - days * 86400
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute("SELECT id FROM checkpoints WHERE created_at < ? AND restored = 0", (cutoff,)).fetchall()
            for r in rows:
                self._delete_checkpoint_files(r[0])
            conn.execute("DELETE FROM file_snapshots WHERE checkpoint_id IN (SELECT id FROM checkpoints WHERE created_at < ? AND restored = 0)", (cutoff,))
            conn.execute("DELETE FROM checkpoints WHERE created_at < ? AND restored = 0", (cutoff,))
            return len(rows)

    def _delete_checkpoint_files(self, checkpoint_id: str) -> None:
        cp_dir = _CHECKPOINTS_DIR / checkpoint_id
        if cp_dir.exists():
            shutil.rmtree(cp_dir, ignore_errors=True)


class CheckpointManager:
    """还原点管理器 — 创建、查询、恢复还原点。

    快照策略（按优先级）：
    1. Git 快照：目标在 Git 仓库内 → stash + 记录 commit hash
    2. CoW 快照：复制文件到 checkpoints 目录
    3. 空快照：无文件时创建标记性还原点

    Usage:
        mgr = CheckpointManager()
        cp = mgr.create_checkpoint(["/path/to/project"], label="重构前")
        mgr.restore_checkpoint(cp.id)
    """

    def __init__(self, store: CheckpointStore | None = None) -> None:
        self._store = store or CheckpointStore()
        _CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)

    def create_checkpoint(
        self,
        paths: list[str] | None = None,
        label: str = "",
        trigger: str = "auto",
        metadata: dict[str, Any] | None = None,
    ) -> Checkpoint:
        """创建还原点。

        Args:
            paths: 需要保护的文件/目录路径列表。
            label: 用户可读标签。
            trigger: 触发原因（auto/manual/pre-batch/pre-workflow）。
            metadata: 扩展元数据。

        Returns:
            Checkpoint: 创建的还原点。
        """
        cp_id = uuid.uuid4().hex[:12]
        cp = Checkpoint(
            id=cp_id,
            label=label or f"checkpoint-{cp_id}",
            created_at=time.time(),
            trigger=trigger,
            metadata=metadata or {},
        )

        if not paths:
            self._store.save(cp)
            log.info("创建空还原点", id=cp_id, label=cp.label)
            return cp

        git_root = self._find_git_root(paths)
        if git_root:
            cp.git_commit = _git_current_commit(git_root) or ""
            stash_ref = _git_stash_create(git_root, cp.label)
            if stash_ref:
                cp.git_stash_ref = stash_ref
            cp.metadata["git_root"] = git_root

        for p in paths:
            self._snapshot_path(cp, p)

        self._store.save(cp)
        log.info(
            "创建还原点",
            id=cp_id,
            label=cp.label,
            files=len(cp.file_snapshots),
            has_git=bool(cp.git_commit),
        )
        return cp

    def restore_checkpoint(self, checkpoint_id: str) -> dict[str, Any]:
        """恢复到指定还原点。

        优先使用 Git 恢复（git stash pop / git checkout），
        退化为文件复制恢复。

        Args:
            checkpoint_id: 还原点 ID。

        Returns:
            dict: 恢复结果 {success, restored_files, errors}。
        """
        cp = self._store.load(checkpoint_id)
        if not cp:
            return {"success": False, "restored_files": 0, "errors": [f"还原点 {checkpoint_id} 不存在"]}

        errors: list[str] = []
        restored = 0

        if cp.git_stash_ref:
            restored += self._git_restore(cp, errors)
        elif cp.git_commit:
            restored += self._git_checkout_restore(cp, errors)

        for path, snap in cp.file_snapshots.items():
            if snap.snapshot_path and Path(snap.snapshot_path).exists():
                try:
                    Path(path).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(snap.snapshot_path, path)
                    restored += 1
                except Exception as e:
                    errors.append(f"恢复 {path} 失败: {e}")

        self._store.mark_restored(checkpoint_id)
        success = len(errors) == 0
        log.info(
            "恢复还原点",
            id=checkpoint_id,
            success=success,
            restored_files=restored,
            errors=len(errors),
        )
        return {"success": success, "restored_files": restored, "errors": errors}

    def list_checkpoints(self, limit: int = 20) -> list[Checkpoint]:
        return self._store.list_recent(limit)

    def get_checkpoint(self, checkpoint_id: str) -> Checkpoint | None:
        return self._store.load(checkpoint_id)

    def cleanup(self, days: int = 30) -> int:
        return self._store.cleanup_older_than(days)

    def _find_git_root(self, paths: list[str]) -> str | None:
        for p in paths:
            resolved = Path(p).resolve()
            for cand in [resolved, *resolved.parents]:
                if (cand / ".git").is_dir():
                    return str(cand)
        return None

    def _snapshot_path(self, cp: Checkpoint, path: str) -> None:
        p = Path(path)
        if p.is_file():
            self._snapshot_file(cp, p)
        elif p.is_dir():
            for child in p.rglob("*"):
                if child.is_file() and not self._should_skip(child):
                    self._snapshot_file(cp, child)

    def _snapshot_file(self, cp: Checkpoint, file_path: Path) -> None:
        try:
            src = str(file_path)
            if src in cp.file_snapshots:
                return
            fhash = _file_hash(src)
            stat = file_path.stat()
            cp_dir = _CHECKPOINTS_DIR / cp.id
            cp_dir.mkdir(parents=True, exist_ok=True)
            rel = file_path.relative_to(Path.cwd()) if file_path.is_relative_to(Path.cwd()) else file_path.name
            dest = cp_dir / f"{rel}_{fhash}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, str(dest))
            cp.file_snapshots[src] = FileSnapshot(
                path=src,
                snapshot_path=str(dest),
                hash=fhash,
                size=stat.st_size,
                mtime=stat.st_mtime,
            )
        except Exception as e:
            log.warning("快照文件失败", path=str(file_path), error=str(e))

    def _git_restore(self, cp: Checkpoint, errors: list[str]) -> int:
        git_root = cp.metadata.get("git_root", "")
        if not git_root:
            return 0
        try:
            result = subprocess.run(
                ["git", "stash", "pop"],
                cwd=git_root,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0:
                log.info("Git stash 恢复成功", checkpoint=cp.id)
                return 1
            else:
                errors.append(f"git stash pop 失败: {result.stderr}")
        except Exception as e:
            errors.append(f"Git 恢复异常: {e}")
        return 0

    def _git_checkout_restore(self, cp: Checkpoint, errors: list[str]) -> int:
        git_root = cp.metadata.get("git_root", "")
        if not git_root or not cp.git_commit:
            return 0
        try:
            result = subprocess.run(
                ["git", "checkout", cp.git_commit, "--", "."],
                cwd=git_root,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode == 0:
                log.info("Git checkout 恢复成功", checkpoint=cp.id, commit=cp.git_commit[:8])
                return 1
            else:
                errors.append(f"git checkout 失败: {result.stderr}")
        except Exception as e:
            errors.append(f"Git checkout 异常: {e}")
        return 0

    @staticmethod
    def _should_skip(path: Path) -> bool:
        skip_dirs = {".git", "__pycache__", "node_modules", ".venv", ".mypy_cache", ".pytest_cache"}
        for part in path.parts:
            if part in skip_dirs:
                return True
        return False
