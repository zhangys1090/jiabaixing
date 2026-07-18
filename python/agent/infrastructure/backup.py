"""数据备份与恢复模块，为 Agent 数据提供安全的备份和还原能力。

提供 BackupManager 类，支持将 DATA_DIR 下的数据库和配置文件
打包为 tar.gz 压缩包，附带 manifest.json 元信息，
以及从备份还原、列出门控、验证完整性、自动轮转等操作。

典型用法::

    manager = BackupManager()
    path = manager.create_backup()
    print(f"备份已创建: {path}")

    manifests = manager.list_backups()
    ok = manager.verify_backup(path)
    manager.restore_backup(path)
"""

from __future__ import annotations

import json
import os
import tarfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR

# 备份版本号，随格式升级递增
_BACKUP_VERSION = 1

# 备份文件扩展名
_BACKUP_SUFFIX = ".tar.gz"

# 备份中包含的文件模式
_INCLUDE_PATTERNS = ("*.db", "*.json", "*.md")

# manifest 文件名
_MANIFEST_FILENAME = "manifest.json"


@dataclass
class BackupManifest:
    """备份元信息清单，记录单次备份的完整描述。

    Attributes:
        version: 备份格式版本号。
        created_at: 备份创建时间戳（ISO 8601 格式）。
        source_paths: 被备份的源文件相对路径列表。
        file_count: 备份中的文件数量。
        total_size: 备份中文件的总大小（字节）。
    """

    version: int = _BACKUP_VERSION
    created_at: str = ""
    source_paths: list[str] = field(default_factory=list)
    file_count: int = 0
    total_size: int = 0

    def to_dict(self) -> dict[str, Any]:
        """将清单序列化为字典。

        Returns:
            dict[str, Any]: 可 JSON 序列化的字典。
        """
        return {
            "version": self.version,
            "created_at": self.created_at,
            "source_paths": self.source_paths,
            "file_count": self.file_count,
            "total_size": self.total_size,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BackupManifest:
        """从字典反序列化为清单实例。

        Args:
            data: 由 to_dict 生成的字典。

        Returns:
            BackupManifest: 反序列化后的清单实例。
        """
        return cls(
            version=data.get("version", _BACKUP_VERSION),
            created_at=data.get("created_at", ""),
            source_paths=data.get("source_paths", []),
            file_count=data.get("file_count", 0),
            total_size=data.get("total_size", 0),
        )


class BackupManager:
    """数据备份与恢复管理器。

    支持 DATA_DIR 下所有 .db/.json/.md 文件的打包备份、
    从备份还原、列出历史备份、验证备份完整性及自动轮转。

    存储位置: DATA_DIR/backups/
    命名格式: backup_YYYYMMDD_HHMMSS.tar.gz

    Usage::

        manager = BackupManager()
        path = manager.create_backup()
        manifests = manager.list_backups()
        manager.restore_backup(path)
    """

    def __init__(self) -> None:
        """初始化备份管理器，确保备份目录存在。"""
        self._backup_dir: Path = DATA_DIR / "backups"
        self._backup_dir.mkdir(parents=True, exist_ok=True)

    # ── 公共接口 ──────────────────────────────────────────────

    def create_backup(self, output_dir: Path | str | None = None) -> Path:
        """创建完整备份，将 DATA_DIR 下匹配文件打包为 tar.gz。

        Args:
            output_dir: 备份输出目录，默认为 DATA_DIR/backups/。

        Returns:
            Path: 生成的备份压缩包路径。

        Raises:
            FileNotFoundError: DATA_DIR 不存在且为空目录时仍可备份（空备份）。
        """
        target_dir = Path(output_dir) if output_dir else self._backup_dir
        target_dir.mkdir(parents=True, exist_ok=True)

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        ms = int((time.time() % 1) * 1000)
        backup_name = f"backup_{timestamp}_{ms:03d}{_BACKUP_SUFFIX}"
        backup_path = target_dir / backup_name

        # 收集需要备份的文件
        source_files = self._collect_source_files()

        # 计算总大小
        total_size = sum(f.stat().st_size for f in source_files)
        relative_paths = [str(f.relative_to(DATA_DIR)) for f in source_files]

        # 创建压缩包
        with tarfile.open(str(backup_path), "w:gz") as tar:
            for file_path in source_files:
                arcname = str(file_path.relative_to(DATA_DIR))
                tar.add(str(file_path), arcname=arcname)

            # 写入 manifest
            manifest = BackupManifest(
                version=_BACKUP_VERSION,
                created_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                source_paths=relative_paths,
                file_count=len(source_files),
                total_size=total_size,
            )
            manifest_data = json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2)
            import io
            manifest_bytes = manifest_data.encode("utf-8")
            info = tarfile.TarInfo(name=_MANIFEST_FILENAME)
            info.size = len(manifest_bytes)
            info.mtime = time.time()
            tar.addfile(info, io.BytesIO(manifest_bytes))

        return backup_path

    def restore_backup(self, backup_path: Path | str, target_dir: Path | str | None = None) -> bool:
        """从备份还原数据到指定目录。

        Args:
            backup_path: 备份压缩包路径。
            target_dir: 还原目标目录，默认为 DATA_DIR。

        Returns:
            bool: 还原是否成功。

        Raises:
            FileNotFoundError: 备份文件不存在时。
            ValueError: 备份 manifest 不完整时。
        """
        backup_path = Path(backup_path)
        if not backup_path.exists():
            raise FileNotFoundError(f"备份文件不存在: {backup_path}")

        # 验证 manifest
        if not self.verify_backup(backup_path):
            raise ValueError(f"备份验证失败: {backup_path}")

        dest = Path(target_dir) if target_dir else DATA_DIR
        dest.mkdir(parents=True, exist_ok=True)

        try:
            with tarfile.open(str(backup_path), "r:gz") as tar:
                # 安全过滤：只解压非 manifest 文件，且排除绝对路径和路径遍历
                members = []
                for member in tar.getmembers():
                    if member.name == _MANIFEST_FILENAME:
                        continue
                    # 防止路径遍历攻击
                    if member.name.startswith("/") or ".." in member.name:
                        continue
                    members.append(member)
                tar.extractall(path=str(dest), members=members, filter="data")
            return True
        except Exception:
            return False

    def list_backups(self, backup_dir: Path | str | None = None) -> list[BackupManifest]:
        """列出指定目录下所有可用备份的清单。

        Args:
            backup_dir: 备份目录，默认为 DATA_DIR/backups/。

        Returns:
            list[BackupManifest]: 按时间倒序排列的备份清单列表。
        """
        search_dir = Path(backup_dir) if backup_dir else self._backup_dir
        if not search_dir.exists():
            return []

        manifests: list[BackupManifest] = []
        for f in search_dir.iterdir():
            if f.is_file() and f.name.endswith(_BACKUP_SUFFIX) and f.name.startswith("backup_"):
                manifest = self._read_manifest(f)
                if manifest is not None:
                    manifests.append(manifest)

        # 按创建时间倒序
        manifests.sort(key=lambda m: m.created_at, reverse=True)
        return manifests

    def delete_backup(self, backup_path: Path | str) -> bool:
        """删除指定备份文件。

        Args:
            backup_path: 要删除的备份文件路径。

        Returns:
            bool: 是否删除成功。
        """
        backup_path = Path(backup_path)
        try:
            if backup_path.exists():
                backup_path.unlink()
                return True
            return False
        except OSError:
            return False

    def verify_backup(self, backup_path: Path | str) -> bool:
        """验证备份文件完整性，检查 manifest 是否存在且格式正确。

        Args:
            backup_path: 备份压缩包路径。

        Returns:
            bool: 备份是否完整有效。
        """
        backup_path = Path(backup_path)
        if not backup_path.exists():
            return False

        try:
            with tarfile.open(str(backup_path), "r:gz") as tar:
                names = tar.getnames()
                if _MANIFEST_FILENAME not in names:
                    return False
                # 读取并验证 manifest 格式
                member = tar.getmember(_MANIFEST_FILENAME)
                f = tar.extractfile(member)
                if f is None:
                    return False
                data = json.loads(f.read().decode("utf-8"))
                manifest = BackupManifest.from_dict(data)
                # 基本字段校验
                if manifest.version < 1 or not manifest.created_at:
                    return False
                return True
        except (tarfile.TarError, json.JSONDecodeError, KeyError, OSError):
            return False

    def auto_backup(self, max_backups: int = 5) -> Path:
        """执行自动备份，保留最近 N 个备份，超出部分自动删除。

        Args:
            max_backups: 最多保留的备份数量。

        Returns:
            Path: 新创建的备份路径。
        """
        # 创建新备份
        new_backup = self.create_backup()

        # 列出所有备份并按时间倒序
        all_backups = sorted(
            self._backup_dir.glob(f"backup_*{_BACKUP_SUFFIX}"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )

        # 删除超出限额的旧备份
        if len(all_backups) > max_backups:
            for old_backup in all_backups[max_backups:]:
                self.delete_backup(old_backup)

        return new_backup

    # ── 私有方法 ──────────────────────────────────────────────

    @staticmethod
    def _collect_source_files() -> list[Path]:
        """收集 DATA_DIR 下所有匹配模式的文件。

        Returns:
            list[Path]: 匹配的文件路径列表。
        """
        files: list[Path] = []
        if not DATA_DIR.exists():
            return files

        # 排除 backups 目录本身
        for pattern in _INCLUDE_PATTERNS:
            for file_path in DATA_DIR.rglob(pattern):
                # 跳过备份目录内的文件，避免递归
                if "backups" in file_path.parts:
                    continue
                if file_path.is_file():
                    files.append(file_path)
        return files

    @staticmethod
    def _read_manifest(backup_path: Path) -> BackupManifest | None:
        """从备份压缩包中读取 manifest。

        Args:
            backup_path: 备份文件路径。

        Returns:
            BackupManifest | None: 清单实例，读取失败返回 None。
        """
        try:
            with tarfile.open(str(backup_path), "r:gz") as tar:
                if _MANIFEST_FILENAME not in tar.getnames():
                    return None
                member = tar.getmember(_MANIFEST_FILENAME)
                f = tar.extractfile(member)
                if f is None:
                    return None
                data = json.loads(f.read().decode("utf-8"))
                return BackupManifest.from_dict(data)
        except (tarfile.TarError, json.JSONDecodeError, KeyError, OSError):
            return None
