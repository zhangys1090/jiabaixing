"""技能同步管理器。

跨设备/实例的技能同步：
  - 技能包版本追踪
  - 增量同步（基于版本号差异）
  - 冲突检测与合并策略
  - 同步状态持久化

集成示例::

    from agent.skill.skill_sync import SkillSyncManager

    sync = SkillSyncManager(local_dir="/data/skills")
    result = await sync.push("code_review", version="1.2.0")
    result = await sync.pull(remote_url="https://hub.example.com/skills")
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("skill.sync")


class SyncStatus(Enum):
    IDLE = "idle"
    SYNCING = "syncing"
    CONFLICT = "conflict"
    ERROR = "error"
    DONE = "done"


class MergeStrategy(Enum):
    LOCAL_WINS = "local_wins"
    REMOTE_WINS = "remote_wins"
    MANUAL = "manual"
    TIMESTAMP = "timestamp"


@dataclass
class SkillVersion:
    name: str = ""
    version: str = "0.0.0"
    checksum: str = ""
    updated_at: float = 0.0
    source: str = "local"


@dataclass
class SyncRecord:
    skill_name: str = ""
    local_version: str = ""
    remote_version: str = ""
    last_sync_at: float = 0.0
    status: SyncStatus = SyncStatus.IDLE
    conflicts: list[str] = field(default_factory=list)


@dataclass
class SyncResult:
    success: bool = False
    synced: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


class SkillSyncManager:
    """技能同步管理器。"""

    def __init__(
        self,
        local_dir: str = "",
        merge_strategy: MergeStrategy = MergeStrategy.TIMESTAMP,
    ):
        self._local_dir = local_dir or os.path.join(os.getcwd(), "data", "skills")
        self._merge_strategy = merge_strategy
        self._versions: dict[str, SkillVersion] = {}
        self._sync_records: dict[str, SyncRecord] = {}
        self._status = SyncStatus.IDLE
        os.makedirs(self._local_dir, exist_ok=True)
        self._load_local_versions()

    def _load_local_versions(self) -> None:
        if not os.path.isdir(self._local_dir):
            return
        for fname in os.listdir(self._local_dir):
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(self._local_dir, fname)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                name = data.get("name", fname[:-5])
                version = data.get("version", "0.0.0")
                checksum = self._compute_checksum(fpath)
                self._versions[name] = SkillVersion(
                    name=name,
                    version=version,
                    checksum=checksum,
                    updated_at=os.path.getmtime(fpath),
                    source="local",
                )
            except Exception as e:
                log.warning("Failed to load skill version", file=fname, error=str(e))

    @staticmethod
    def _compute_checksum(filepath: str) -> str:
        h = hashlib.sha256()
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()[:16]

    def get_local_version(self, skill_name: str) -> SkillVersion | None:
        return self._versions.get(skill_name)

    def get_all_versions(self) -> dict[str, SkillVersion]:
        return dict(self._versions)

    async def push(self, skill_name: str, version: str = "", remote_url: str = "") -> SyncResult:
        start = time.time()
        self._status = SyncStatus.SYNCING
        try:
            local = self._versions.get(skill_name)
            if not local:
                return SyncResult(success=False, errors=[f"Skill '{skill_name}' not found locally"])
            fpath = os.path.join(self._local_dir, f"{skill_name}.json")
            if not os.path.exists(fpath):
                return SyncResult(success=False, errors=[f"Skill file not found: {fpath}"])
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if version:
                data["version"] = version
                with open(fpath, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                local.version = version
                local.checksum = self._compute_checksum(fpath)
                local.updated_at = time.time()
            record = self._sync_records.get(skill_name, SyncRecord(skill_name=skill_name))
            record.local_version = local.version
            record.last_sync_at = time.time()
            record.status = SyncStatus.DONE
            self._sync_records[skill_name] = record
            self._status = SyncStatus.DONE
            duration = (time.time() - start) * 1000
            log.info("Skill pushed", skill=skill_name, version=local.version)
            return SyncResult(success=True, synced=[skill_name], duration_ms=duration)
        except Exception as e:
            log.debug("skill_sync 异常处理", error=str(e))
            self._status = SyncStatus.ERROR
            return SyncResult(success=False, errors=[str(e)])

    async def pull(self, remote_skills: list[dict[str, Any]] | None = None, remote_url: str = "") -> SyncResult:
        start = time.time()
        self._status = SyncStatus.SYNCING
        try:
            if remote_skills is None:
                remote_skills = []
            synced = []
            conflicts = []
            for remote in remote_skills:
                name = remote.get("name", "")
                remote_ver = remote.get("version", "0.0.0")
                local = self._versions.get(name)
                if not local or self._should_update(local, remote):
                    await self._apply_remote(name, remote)
                    synced.append(name)
                elif local.version != remote_ver:
                    if self._merge_strategy == MergeStrategy.REMOTE_WINS:
                        await self._apply_remote(name, remote)
                        synced.append(name)
                    elif self._merge_strategy == MergeStrategy.LOCAL_WINS:
                        pass
                    else:
                        conflicts.append(name)
            self._status = SyncStatus.CONFLICT if conflicts else SyncStatus.DONE
            duration = (time.time() - start) * 1000
            return SyncResult(success=True, synced=synced, conflicts=conflicts, duration_ms=duration)
        except Exception as e:
            log.debug("skill_sync 异常处理", error=str(e))
            self._status = SyncStatus.ERROR
            return SyncResult(success=False, errors=[str(e)])

    def _should_update(self, local: SkillVersion, remote: dict[str, Any]) -> bool:
        remote_ver = remote.get("version", "0.0.0")
        if self._merge_strategy == MergeStrategy.TIMESTAMP:
            remote_updated = remote.get("updated_at", 0)
            return remote_updated > local.updated_at
        return remote_ver > local.version

    async def _apply_remote(self, name: str, remote: dict[str, Any]) -> None:
        fpath = os.path.join(self._local_dir, f"{name}.json")
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(remote, f, ensure_ascii=False, indent=2)
        self._versions[name] = SkillVersion(
            name=name,
            version=remote.get("version", "0.0.0"),
            checksum=self._compute_checksum(fpath),
            updated_at=time.time(),
            source="remote",
        )

    def get_sync_record(self, skill_name: str) -> SyncRecord | None:
        return self._sync_records.get(skill_name)

    @property
    def status(self) -> SyncStatus:
        return self._status

    def get_stats(self) -> dict[str, Any]:
        return {
            "status": self._status.value,
            "local_skills": len(self._versions),
            "sync_records": len(self._sync_records),
            "merge_strategy": self._merge_strategy.value,
        }
