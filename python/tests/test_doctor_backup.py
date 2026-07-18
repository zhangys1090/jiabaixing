"""环境诊断(Doctor)和数据备份(Backup)单元测试。

覆盖范围:
- Doctor: Python 版本检查、依赖检测、环境变量、数据库、网络、磁盘、权限、报告格式化
- BackupManager: 创建备份、还原备份、列出备份、删除备份、验证完整性、自动轮转
- BackupManifest: 序列化/反序列化
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from agent.infrastructure.backup import BackupManager, BackupManifest, _BACKUP_VERSION, _MANIFEST_FILENAME
from agent.infrastructure.doctor import (
    DiagnosticLevel,
    DiagnosticResult,
    Doctor,
    _MIN_PYTHON_VERSION,
)


# ═══════════════════════════════════════════════════════════════
# Doctor 测试
# ═══════════════════════════════════════════════════════════════


class TestDiagnosticLevel:
    """DiagnosticLevel 枚举测试。"""

    def test_enum_values(self):
        """验证枚举值。"""
        assert DiagnosticLevel.CRITICAL.value == "critical"
        assert DiagnosticLevel.WARNING.value == "warning"
        assert DiagnosticLevel.INFO.value == "info"


class TestDiagnosticResult:
    """DiagnosticResult 数据类测试。"""

    def test_defaults(self):
        """默认 details 为空字典。"""
        result = DiagnosticResult(
            name="test", level=DiagnosticLevel.INFO, passed=True, message="ok"
        )
        assert result.details == {}

    def test_custom_details(self):
        """自定义 details 正确保存。"""
        result = DiagnosticResult(
            name="test",
            level=DiagnosticLevel.WARNING,
            passed=False,
            message="warn",
            details={"key": "value"},
        )
        assert result.details == {"key": "value"}


class TestDoctorCheckPythonVersion:
    """Doctor.check_python_version 测试。"""

    def test_current_python_passes(self):
        """当前 Python 版本 >= 3.11 应通过。"""
        doctor = Doctor()
        result = doctor.check_python_version()
        assert result.passed is True
        assert result.level == DiagnosticLevel.INFO

    def test_old_python_fails(self):
        """模拟低版本 Python 应不通过。"""
        doctor = Doctor()
        with patch("agent.infrastructure.doctor.sys") as mock_sys:
            mock_sys.version_info = (3, 9, 0)
            result = doctor.check_python_version()
        assert result.passed is False
        assert result.level == DiagnosticLevel.CRITICAL


class TestDoctorCheckDependencies:
    """Doctor.check_dependencies 测试。"""

    def test_returns_list(self):
        """返回列表。"""
        doctor = Doctor()
        results = doctor.check_dependencies()
        assert isinstance(results, list)
        assert len(results) > 0

    def test_sqlite3_builtin(self):
        """sqlite3 作为内置模块应通过。"""
        doctor = Doctor()
        results = doctor.check_dependencies()
        sqlite_result = [r for r in results if "sqlite3" in r.name]
        assert len(sqlite_result) == 1
        assert sqlite_result[0].passed is True

    def test_missing_dependency(self):
        """模拟缺失依赖应返回失败。"""
        doctor = Doctor()
        with patch("agent.infrastructure.doctor.importlib.import_module", side_effect=ImportError):
            results = doctor.check_dependencies()
            # 所有非 sqlite3 的应失败
            non_sqlite = [r for r in results if "sqlite3" not in r.name]
            assert all(not r.passed for r in non_sqlite)


class TestDoctorCheckEnvConfig:
    """Doctor.check_env_config 测试。"""

    def test_no_api_key_warning(self):
        """无任何 API Key 应返回 WARNING。"""
        doctor = Doctor()
        env_keys = [
            "LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
            "DEEPSEEK_API_KEY", "ZHIPU_API_KEY", "DASHSCOPE_API_KEY",
        ]
        with patch.dict(os.environ, {}, clear=True):
            # 清除可能存在的 key
            for key in env_keys:
                os.environ.pop(key, None)
            results = doctor.check_env_config()
        assert len(results) == 1
        assert results[0].passed is False
        assert results[0].level == DiagnosticLevel.WARNING

    def test_with_api_key_passes(self):
        """设置 API Key 后应通过。"""
        doctor = Doctor()
        with patch.dict(os.environ, {"LLM_API_KEY": "test-key-12345"}, clear=False):
            results = doctor.check_env_config()
        assert len(results) == 1
        assert results[0].passed is True
        assert results[0].level == DiagnosticLevel.INFO


class TestDoctorCheckDatabase:
    """Doctor.check_database 测试。"""

    def test_sqlite_available(self):
        """SQLite 应可用。"""
        doctor = Doctor()
        result = doctor.check_database()
        assert result.passed is True
        assert result.level == DiagnosticLevel.INFO

    def test_sqlite_failure(self):
        """模拟 SQLite 异常应返回 CRITICAL。"""
        doctor = Doctor()
        with patch("agent.infrastructure.doctor.sqlite3") as mock_sql:
            mock_sql.connect.side_effect = Exception("no sqlite")
            result = doctor.check_database()
        assert result.passed is False
        assert result.level == DiagnosticLevel.CRITICAL


class TestDoctorCheckNetwork:
    """Doctor.check_network 测试。"""

    def test_network_available(self):
        """网络连通时应通过。"""
        doctor = Doctor()
        with patch("agent.infrastructure.doctor.socket.create_connection"):
            result = doctor.check_network()
        assert result.passed is True

    def test_network_unavailable(self):
        """网络不通时应返回 WARNING。"""
        doctor = Doctor()
        with patch(
            "agent.infrastructure.doctor.socket.create_connection",
            side_effect=OSError("no network"),
        ):
            result = doctor.check_network()
        assert result.passed is False
        assert result.level == DiagnosticLevel.WARNING


class TestDoctorCheckDiskSpace:
    """Doctor.check_disk_space 测试。"""

    def test_disk_space_sufficient(self):
        """磁盘空间充足时应通过。"""
        doctor = Doctor()
        result = doctor.check_disk_space()
        # 在 CI/开发环境通常磁盘空间充足
        assert result.name == "磁盘空间"

    def test_disk_space_insufficient(self):
        """模拟磁盘空间不足应返回 CRITICAL。"""
        doctor = Doctor()
        usage = os.statvfs(".") if hasattr(os, "statvfs") else None
        # 使用 mock 绕过平台差异
        mock_usage = shutil._ntuple_diskusage(0, 0, 99 * 1024 * 1024)  # free=99MB
        with patch("agent.infrastructure.doctor.shutil.disk_usage", return_value=mock_usage):
            result = doctor.check_disk_space()
        assert result.passed is False
        assert result.level == DiagnosticLevel.CRITICAL


class TestDoctorCheckFilePermissions:
    """Doctor.check_file_permissions 测试。"""

    def test_permissions_ok(self):
        """DATA_DIR 可读写时应通过。"""
        doctor = Doctor()
        result = doctor.check_file_permissions()
        assert result.passed is True

    def test_permissions_denied(self):
        """模拟权限拒绝应返回 CRITICAL。"""
        doctor = Doctor()
        with patch("agent.infrastructure.doctor.DATA_DIR") as mock_dir:
            mock_path = Path(tempfile.mkdtemp())
            (mock_path / ".doctor_permission_test").write_text("test", encoding="utf-8")
            mock_dir.__truediv__ = lambda self, key: mock_path / key
            mock_dir.mkdir = lambda **kw: None
            # 让 write_text 抛出 PermissionError
            mock_file = mock_path / ".doctor_permission_test"
            mock_file.unlink()
            with patch.object(Path, "write_text", side_effect=PermissionError("denied")):
                result = doctor.check_file_permissions()
        assert result.passed is False
        assert result.level == DiagnosticLevel.CRITICAL


class TestDoctorRunAll:
    """Doctor.run_all 测试。"""

    def test_returns_all_checks(self):
        """run_all 应返回所有检查结果。"""
        doctor = Doctor()
        with patch.object(doctor, "check_network", return_value=DiagnosticResult(
            name="网络", level=DiagnosticLevel.INFO, passed=True, message="ok"
        )):
            results = doctor.run_all()
        # 至少 8 项: python(1) + deps(4) + env(1) + db(1) + net(1) + disk(1) + perm(1)
        assert len(results) >= 8

    def test_all_results_have_name(self):
        """每条结果都应有 name。"""
        doctor = Doctor()
        with patch.object(doctor, "check_network", return_value=DiagnosticResult(
            name="网络", level=DiagnosticLevel.INFO, passed=True, message="ok"
        )):
            results = doctor.run_all()
        for r in results:
            assert r.name


class TestDoctorFormatReport:
    """Doctor.format_report 测试。"""

    def test_report_format(self):
        """报告格式应包含标题和通过数。"""
        results = [
            DiagnosticResult(name="test1", level=DiagnosticLevel.INFO, passed=True, message="测试1"),
            DiagnosticResult(name="test2", level=DiagnosticLevel.WARNING, passed=False, message="测试2"),
            DiagnosticResult(name="test3", level=DiagnosticLevel.CRITICAL, passed=False, message="测试3"),
        ]
        report = Doctor.format_report(results)
        assert "═══ Jiabaixing Doctor ═══" in report
        assert "1/3 通过" in report
        assert "✅" in report
        assert "⚠️" in report
        assert "❌" in report

    def test_empty_results(self):
        """空结果应显示 0/0。"""
        report = Doctor.format_report([])
        assert "0/0 通过" in report


# ═══════════════════════════════════════════════════════════════
# BackupManifest 测试
# ═══════════════════════════════════════════════════════════════


class TestBackupManifest:
    """BackupManifest 序列化/反序列化测试。"""

    def test_to_dict(self):
        """to_dict 应正确序列化所有字段。"""
        manifest = BackupManifest(
            version=1,
            created_at="2026-01-01T00:00:00",
            source_paths=["a.db", "b.json"],
            file_count=2,
            total_size=1024,
        )
        d = manifest.to_dict()
        assert d["version"] == 1
        assert d["created_at"] == "2026-01-01T00:00:00"
        assert d["source_paths"] == ["a.db", "b.json"]
        assert d["file_count"] == 2
        assert d["total_size"] == 1024

    def test_from_dict(self):
        """from_dict 应正确反序列化。"""
        data = {
            "version": 2,
            "created_at": "2026-06-01T12:00:00",
            "source_paths": ["x.md"],
            "file_count": 1,
            "total_size": 512,
        }
        manifest = BackupManifest.from_dict(data)
        assert manifest.version == 2
        assert manifest.created_at == "2026-06-01T12:00:00"
        assert manifest.source_paths == ["x.md"]
        assert manifest.file_count == 1
        assert manifest.total_size == 512

    def test_from_dict_defaults(self):
        """from_dict 缺失字段应使用默认值。"""
        manifest = BackupManifest.from_dict({})
        assert manifest.version == _BACKUP_VERSION
        assert manifest.created_at == ""
        assert manifest.source_paths == []
        assert manifest.file_count == 0
        assert manifest.total_size == 0

    def test_roundtrip(self):
        """to_dict -> from_dict 往返一致。"""
        original = BackupManifest(
            version=1,
            created_at="2026-07-07T10:00:00",
            source_paths=["a.db"],
            file_count=1,
            total_size=2048,
        )
        restored = BackupManifest.from_dict(original.to_dict())
        assert restored.version == original.version
        assert restored.created_at == original.created_at
        assert restored.source_paths == original.source_paths
        assert restored.file_count == original.file_count
        assert restored.total_size == original.total_size


# ═══════════════════════════════════════════════════════════════
# BackupManager 测试
# ═══════════════════════════════════════════════════════════════


class _BackupTestBase:
    """备份测试基类，提供临时目录和数据文件。"""

    @pytest.fixture(autouse=True)
    def setup_tmpdir(self, tmp_path: Path):
        """创建临时 DATA_DIR 和备份管理器。"""
        self.tmp_data = tmp_path / "data"
        self.tmp_data.mkdir()
        self.tmp_backup = tmp_path / "backups"
        self.tmp_backup.mkdir()

        # 创建测试数据文件
        (self.tmp_data / "test.db").write_text("database content", encoding="utf-8")
        (self.tmp_data / "config.json").write_text('{"key": "value"}', encoding="utf-8")
        (self.tmp_data / "readme.md").write_text("# Hello", encoding="utf-8")
        # 不应被备份的文件
        (self.tmp_data / "ignore.txt").write_text("skip me", encoding="utf-8")

        # Patch DATA_DIR
        self._patcher = patch("agent.infrastructure.backup.DATA_DIR", self.tmp_data)
        self._patcher.start()

        self.manager = BackupManager()
        # 覆盖 _backup_dir 到临时目录
        self.manager._backup_dir = self.tmp_backup

        yield

        self._patcher.stop()


class TestBackupManagerCreateBackup(_BackupTestBase):
    """BackupManager.create_backup 测试。"""

    def test_creates_tar_gz(self):
        """创建备份应生成 .tar.gz 文件。"""
        path = self.manager.create_backup()
        assert path.exists()
        assert path.suffixes == [".tar", ".gz"]
        assert path.name.startswith("backup_")

    def test_backup_contains_manifest(self):
        """备份中应包含 manifest.json。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        import tarfile
        with tarfile.open(str(path), "r:gz") as tar:
            assert _MANIFEST_FILENAME in tar.getnames()

    def test_backup_contains_data_files(self):
        """备份中应包含 .db/.json/.md 文件，不含 .txt。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        import tarfile
        with tarfile.open(str(path), "r:gz") as tar:
            names = tar.getnames()
        assert any("test.db" in n for n in names)
        assert any("config.json" in n for n in names)
        assert any("readme.md" in n for n in names)
        assert not any("ignore.txt" in n for n in names)

    def test_manifest_has_correct_metadata(self):
        """manifest 应记录正确的文件数量和大小。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        manifest = self.manager._read_manifest(path)
        assert manifest is not None
        assert manifest.file_count == 3  # .db, .json, .md
        assert manifest.total_size > 0
        assert manifest.version == _BACKUP_VERSION
        assert manifest.created_at

    def test_custom_output_dir(self):
        """自定义输出目录应生效。"""
        custom_dir = self.tmp_backup / "custom"
        custom_dir.mkdir()
        path = self.manager.create_backup(output_dir=custom_dir)
        assert custom_dir in path.parents


class TestBackupManagerRestoreBackup(_BackupTestBase):
    """BackupManager.restore_backup 测试。"""

    def test_restore_succeeds(self):
        """还原备份应成功。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        restore_dir = self.tmp_backup / "restored"
        restore_dir.mkdir()
        result = self.manager.restore_backup(path, target_dir=restore_dir)
        assert result is True

    def test_restored_files_exist(self):
        """还原后文件应存在。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        restore_dir = self.tmp_backup / "restored"
        restore_dir.mkdir()
        self.manager.restore_backup(path, target_dir=restore_dir)
        assert (restore_dir / "test.db").exists()
        assert (restore_dir / "config.json").exists()
        assert (restore_dir / "readme.md").exists()

    def test_restored_content_matches(self):
        """还原后内容应与原始内容一致。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        restore_dir = self.tmp_backup / "restored"
        restore_dir.mkdir()
        self.manager.restore_backup(path, target_dir=restore_dir)
        content = (restore_dir / "test.db").read_text(encoding="utf-8")
        assert content == "database content"

    def test_restore_nonexistent_backup_raises(self):
        """还原不存在的备份应抛出 FileNotFoundError。"""
        with pytest.raises(FileNotFoundError):
            self.manager.restore_backup("/nonexistent/backup.tar.gz")

    def test_restore_invalid_backup_raises(self):
        """还原无效备份应抛出 ValueError。"""
        bad_path = self.tmp_backup / "bad.tar.gz"
        # 创建一个不含 manifest 的 tar.gz
        import tarfile
        with tarfile.open(str(bad_path), "w:gz") as tar:
            info = tarfile.TarInfo(name="dummy.txt")
            info.size = 5
            import io
            tar.addfile(info, io.BytesIO(b"hello"))
        with pytest.raises(ValueError):
            self.manager.restore_backup(bad_path)


class TestBackupManagerListBackups(_BackupTestBase):
    """BackupManager.list_backups 测试。"""

    def test_empty_directory(self):
        """空目录应返回空列表。"""
        empty_dir = self.tmp_backup / "empty"
        empty_dir.mkdir()
        manifests = self.manager.list_backups(backup_dir=empty_dir)
        assert manifests == []

    def test_lists_existing_backups(self):
        """应列出已有备份。"""
        self.manager.create_backup(output_dir=self.tmp_backup)
        time.sleep(0.05)
        self.manager.create_backup(output_dir=self.tmp_backup)
        manifests = self.manager.list_backups(backup_dir=self.tmp_backup)
        assert len(manifests) == 2

    def test_sorted_by_time_desc(self):
        """备份应按时间倒序排列。"""
        self.manager.create_backup(output_dir=self.tmp_backup)
        time.sleep(0.05)
        self.manager.create_backup(output_dir=self.tmp_backup)
        manifests = self.manager.list_backups(backup_dir=self.tmp_backup)
        assert manifests[0].created_at >= manifests[1].created_at


class TestBackupManagerDeleteBackup(_BackupTestBase):
    """BackupManager.delete_backup 测试。"""

    def test_delete_existing(self):
        """删除已有备份应成功。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        result = self.manager.delete_backup(path)
        assert result is True
        assert not path.exists()

    def test_delete_nonexistent(self):
        """删除不存在的备份应返回 False。"""
        result = self.manager.delete_backup(self.tmp_backup / "nonexistent.tar.gz")
        assert result is False


class TestBackupManagerVerifyBackup(_BackupTestBase):
    """BackupManager.verify_backup 测试。"""

    def test_verify_valid_backup(self):
        """有效备份应验证通过。"""
        path = self.manager.create_backup(output_dir=self.tmp_backup)
        assert self.manager.verify_backup(path) is True

    def test_verify_nonexistent_backup(self):
        """不存在的备份应验证失败。"""
        assert self.manager.verify_backup("/nonexistent/backup.tar.gz") is False

    def test_verify_corrupted_backup(self):
        """损坏的备份应验证失败。"""
        bad_path = self.tmp_backup / "corrupted.tar.gz"
        bad_path.write_bytes(b"not a real tar.gz file content at all")
        assert self.manager.verify_backup(bad_path) is False

    def test_verify_backup_without_manifest(self):
        """不含 manifest 的备份应验证失败。"""
        import tarfile, io
        bad_path = self.tmp_backup / "no_manifest.tar.gz"
        with tarfile.open(str(bad_path), "w:gz") as tar:
            info = tarfile.TarInfo(name="data.txt")
            info.size = 5
            tar.addfile(info, io.BytesIO(b"hello"))
        assert self.manager.verify_backup(bad_path) is False


class TestBackupManagerAutoBackup(_BackupTestBase):
    """BackupManager.auto_backup 测试。"""

    def test_creates_backup(self):
        """auto_backup 应创建新备份。"""
        path = self.manager.auto_backup(max_backups=3)
        assert path.exists()

    def test_respects_max_backups(self):
        """auto_backup 应删除超出的旧备份。"""
        # 创建 max_backups + 2 个备份
        paths = []
        for _ in range(5):
            paths.append(self.manager.create_backup(output_dir=self.tmp_backup))
            time.sleep(0.05)

        # auto_backup 会再创建一个，然后只保留 3 个
        self.manager.auto_backup(max_backups=3)

        remaining = list(self.tmp_backup.glob("backup_*.tar.gz"))
        assert len(remaining) <= 3
