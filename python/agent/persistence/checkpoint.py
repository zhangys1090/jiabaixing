from __future__ import annotations

import hashlib
import json
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import log_ignored


@dataclass
class CheckpointFile:
    relative_path: str
    hash: str = ""
    size: int = 0


@dataclass
class CheckpointEntry:
    id: str = ""
    label: str = ""
    timestamp: float = 0.0
    file_count: int = 0
    total_size: int = 0
    files: list[CheckpointFile] = field(default_factory=list)


_DEFAULT_IGNORE = {
    "node_modules", ".git", "dist", "build", ".next", "data",
    ".checkpoints", "coverage", "__pycache__", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", "*.pyc",
}

_MAX_CHECKPOINTS = 10
_MAX_FILE_SIZE = 1024 * 1024


class CheckpointService:
    def __init__(
        self,
        project_root: str | Path,
        data_dir: str | Path | None = None,
        max_checkpoints: int = _MAX_CHECKPOINTS,
        ignore_patterns: set[str] | None = None,
    ) -> None:
        self._root = Path(project_root).resolve()
        self._snapshots_dir = Path(data_dir) / "snapshots" if data_dir else DATA_DIR / "checkpoints" / "snapshots"
        self._snapshots_dir.mkdir(parents=True, exist_ok=True)
        self._max_checkpoints = max_checkpoints
        self._ignore = ignore_patterns or _DEFAULT_IGNORE

    async def create_checkpoint(self, label: str) -> CheckpointEntry:
        cp_id = f"cp_{int(time.time())}_{hashlib.md5(label.encode()).hexdigest()[:8]}"
        snapshot_dir = self._snapshots_dir / cp_id
        snapshot_dir.mkdir(parents=True, exist_ok=True)

        files = self._scan_project_files()
        total_size = 0

        for f in files:
            src = self._root / f.relative_path
            dst = snapshot_dir / f.relative_path
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(str(src), str(dst))
                total_size += f.size
            except Exception as _exc:
                log_ignored(None, "checkpoint.CheckpointService.create_checkpoint", _exc)

        entry = CheckpointEntry(
            id=cp_id,
            label=label,
            timestamp=time.time(),
            file_count=len(files),
            total_size=total_size,
            files=files,
        )

        meta_path = snapshot_dir / "_checkpoint.json"
        meta_path.write_text(
            json.dumps(_checkpoint_to_dict(entry), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        self._prune_old_checkpoints()
        return entry

    def list_checkpoints(self) -> list[CheckpointEntry]:
        entries: list[CheckpointEntry] = []
        try:
            for d in self._snapshots_dir.iterdir():
                meta = d / "_checkpoint.json"
                if meta.exists():
                    try:
                        data = json.loads(meta.read_text(encoding="utf-8"))
                        entries.append(_dict_to_checkpoint(data))
                    except Exception as _exc:
                        log_ignored(None, "checkpoint.CheckpointService.list_checkpoints", _exc)
        except Exception as _exc:
            log_ignored(None, "checkpoint.CheckpointService.list_checkpoints", _exc)

        entries.sort(key=lambda e: e.timestamp, reverse=True)
        return entries

    async def rollback(self, label_or_id: str) -> bool:
        checkpoints = self.list_checkpoints()
        target = None
        for cp in checkpoints:
            if cp.id == label_or_id or cp.label == label_or_id:
                target = cp
                break

        if not target:
            return False

        missing = self._validate_snapshot(target)
        if missing:
            return False

        snapshot_dir = self._snapshots_dir / target.id
        restored: list[str] = []
        rollback_failed = False

        try:
            for f in target.files:
                src = snapshot_dir / f.relative_path
                dst = self._root / f.relative_path

                resolved = dst.resolve()
                if not str(resolved).startswith(str(self._root)):
                    continue

                if not src.exists():
                    continue

                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(src), str(dst))
                restored.append(f.relative_path)
        except Exception:
            rollback_failed = True

        return not rollback_failed

    def _scan_project_files(self) -> list[CheckpointFile]:
        files: list[CheckpointFile] = []

        for path in self._root.rglob("*"):
            if not path.is_file():
                continue
            if path.stat().st_size > _MAX_FILE_SIZE:
                continue

            rel = path.relative_to(self._root)
            parts = rel.parts
            if any(p in self._ignore for p in parts):
                continue
            if any(p.startswith(".") for p in parts):
                continue

            try:
                content = path.read_bytes()
                h = hashlib.md5(content).hexdigest()[:8]
                files.append(CheckpointFile(
                    relative_path=str(rel).replace("\\", "/"),
                    hash=h,
                    size=len(content),
                ))
            except Exception as _exc:
                log_ignored(None, "checkpoint.CheckpointService._scan_project_files", _exc)

        return files

    def _validate_snapshot(self, target: CheckpointEntry) -> list[str]:
        snapshot_dir = self._snapshots_dir / target.id
        missing: list[str] = []
        for f in target.files:
            if not (snapshot_dir / f.relative_path).exists():
                missing.append(f.relative_path)
        return missing

    def _prune_old_checkpoints(self) -> None:
        checkpoints = self.list_checkpoints()
        if len(checkpoints) <= self._max_checkpoints:
            return
        for cp in checkpoints[self._max_checkpoints:]:
            d = self._snapshots_dir / cp.id
            try:
                shutil.rmtree(d, ignore_errors=True)
            except Exception as _exc:
                log_ignored(None, "checkpoint.CheckpointService._prune_old_checkpoints", _exc)


def _checkpoint_to_dict(entry: CheckpointEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "label": entry.label,
        "timestamp": entry.timestamp,
        "fileCount": entry.file_count,
        "totalSize": entry.total_size,
        "files": [
            {"relativePath": f.relative_path, "hash": f.hash, "size": f.size}
            for f in entry.files
        ],
    }


def _dict_to_checkpoint(data: dict[str, Any]) -> CheckpointEntry:
    return CheckpointEntry(
        id=data.get("id", ""),
        label=data.get("label", ""),
        timestamp=data.get("timestamp", 0.0),
        file_count=data.get("fileCount", 0),
        total_size=data.get("totalSize", 0),
        files=[
            CheckpointFile(
                relative_path=f.get("relativePath", ""),
                hash=f.get("hash", ""),
                size=f.get("size", 0),
            )
            for f in data.get("files", [])
        ],
    )
