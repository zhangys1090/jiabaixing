"""环境诊断模块，一键检测系统运行环境是否满足要求。

提供 Doctor 类，对 Python 版本、依赖包、环境变量、数据库、
网络连通性、磁盘空间、文件权限等进行全面诊断，
并以结构化 DiagnosticResult 和人类可读报告两种形式输出结果。

典型用法::

    doctor = Doctor()
    results = doctor.run_all()
    logger.info(doctor.format_report(results))
"""

from __future__ import annotations

import importlib
import logging
import os
import shutil
import socket
import sqlite3
import sys
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import log_ignored, StructuredLogger
log = StructuredLogger("doctor")

log = logging.getLogger(__name__)

# 最低 Python 版本要求
_MIN_PYTHON_VERSION = (3, 11)

# 关键依赖包列表
_REQUIRED_DEPENDENCIES = ["httpx", "litellm", "jieba", "sqlite3"]

# LLM API Key 环境变量列表（任一即可）
_LLM_API_KEY_ENVS = [
    "LLM_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "ZHIPU_API_KEY",
    "DASHSCOPE_API_KEY",
]

# 磁盘空间最低要求（字节）
_MIN_DISK_SPACE_BYTES = 100 * 1024 * 1024  # 100 MB

# 网络检测目标
_NETWORK_CHECK_HOST = "8.8.8.8"
_NETWORK_CHECK_PORT = 53
_NETWORK_CHECK_TIMEOUT = 5


class DiagnosticLevel(Enum):
    """诊断结果严重级别。

    Attributes:
        CRITICAL: 严重问题，系统无法正常运行。
        WARNING: 警告，可能影响部分功能。
        INFO: 信息性提示，不影响运行。
    """

    CRITICAL = "critical"
    WARNING = "warning"
    INFO = "info"


@dataclass
class DiagnosticResult:
    """单条诊断结果。

    Attributes:
        name: 检查项名称。
        level: 严重级别。
        passed: 是否通过。
        message: 人类可读描述。
        details: 附加详情键值对。
    """

    name: str
    level: DiagnosticLevel
    passed: bool
    message: str
    details: dict[str, Any] = field(default_factory=dict)


class Doctor:
    """一键环境诊断，检测系统运行条件是否满足。

    涵盖 Python 版本、依赖包、环境变量、数据库、网络、磁盘、权限等检查，
    输出结构化结果与可读报告。

    Usage::

        doctor = Doctor()
        results = doctor.run_all()
        logger.info(doctor.format_report(results))
    """

    # ── 公共接口 ──────────────────────────────────────────────

    def run_all(self) -> list[DiagnosticResult]:
        """运行所有诊断检查，返回结果列表。

        Returns:
            list[DiagnosticResult]: 所有检查项的结果。
        """
        results: list[DiagnosticResult] = []

        # Python 版本
        results.append(self.check_python_version())

        # 依赖包
        results.extend(self.check_dependencies())

        # 环境变量
        results.extend(self.check_env_config())

        # 数据库
        results.append(self.check_database())

        # 网络
        results.append(self.check_network())

        # 磁盘空间
        results.append(self.check_disk_space())

        # 文件权限
        results.append(self.check_file_permissions())

        return results

    def check_python_version(self) -> DiagnosticResult:
        """检查 Python 版本是否 >= 3.11。

        Returns:
            DiagnosticResult: 版本检查结果。
        """
        current = sys.version_info[:3]
        passed = current[:2] >= _MIN_PYTHON_VERSION
        version_str = f"{current[0]}.{current[1]}.{current[2]}"
        min_str = f"{_MIN_PYTHON_VERSION[0]}.{_MIN_PYTHON_VERSION[1]}"

        if passed:
            return DiagnosticResult(
                name="Python 版本",
                level=DiagnosticLevel.INFO,
                passed=True,
                message=f"Python {version_str} (>= {min_str})",
                details={"version": version_str, "minimum": min_str},
            )
        return DiagnosticResult(
            name="Python 版本",
            level=DiagnosticLevel.CRITICAL,
            passed=False,
            message=f"Python {version_str} 低于最低要求 {min_str}",
            details={"version": version_str, "minimum": min_str},
        )

    def check_dependencies(self) -> list[DiagnosticResult]:
        """检查关键依赖包是否已安装。

        检测 httpx, litellm, jieba, sqlite3 是否可导入。

        Returns:
            list[DiagnosticResult]: 每个依赖的检查结果。
        """
        results: list[DiagnosticResult] = []
        for dep in _REQUIRED_DEPENDENCIES:
            results.append(self._check_single_dependency(dep))
        return results

    def check_env_config(self) -> list[DiagnosticResult]:
        """检查环境变量配置，确保至少有一个 LLM API Key。

        Returns:
            list[DiagnosticResult]: 环境变量检查结果。
        """
        found_keys = [key for key in _LLM_API_KEY_ENVS if os.getenv(key)]
        if found_keys:
            return [
                DiagnosticResult(
                    name="环境变量",
                    level=DiagnosticLevel.INFO,
                    passed=True,
                    message=f"已设置 LLM API Key: {', '.join(found_keys)}",
                    details={"found_keys": found_keys},
                )
            ]
        return [
            DiagnosticResult(
                name="环境变量",
                level=DiagnosticLevel.WARNING,
                passed=False,
                message="未设置任何 LLM API Key",
                details={"checked_keys": _LLM_API_KEY_ENVS},
            )
        ]

    def check_database(self) -> DiagnosticResult:
        """检查 SQLite 是否可用。

        Returns:
            DiagnosticResult: 数据库可用性检查结果。
        """
        try:
            conn = sqlite3.connect(":memory:")
            version = sqlite3.sqlite_version
            conn.execute("SELECT 1")
            conn.close()
            return DiagnosticResult(
                name="SQLite",
                level=DiagnosticLevel.INFO,
                passed=True,
                message=f"SQLite {version} 可用",
                details={"version": version},
            )
        except Exception as exc:
            log.debug("doctor 异常处理", error=str(exc))
            return DiagnosticResult(
                name="SQLite",
                level=DiagnosticLevel.CRITICAL,
                passed=False,
                message=f"SQLite 不可用: {exc}",
                details={"error": str(exc)},
            )

    def check_network(self) -> DiagnosticResult:
        """检查网络连通性，尝试连接 8.8.8.8:53。

        Returns:
            DiagnosticResult: 网络连通性检查结果。
        """
        try:
            sock = socket.create_connection(
                (_NETWORK_CHECK_HOST, _NETWORK_CHECK_PORT),
                timeout=_NETWORK_CHECK_TIMEOUT,
            )
            sock.close()
            return DiagnosticResult(
                name="网络",
                level=DiagnosticLevel.INFO,
                passed=True,
                message="网络连通正常",
                details={"host": _NETWORK_CHECK_HOST, "port": _NETWORK_CHECK_PORT},
            )
        except OSError as exc:
            return DiagnosticResult(
                name="网络",
                level=DiagnosticLevel.WARNING,
                passed=False,
                message=f"网络不可达: {exc}",
                details={"host": _NETWORK_CHECK_HOST, "port": _NETWORK_CHECK_PORT, "error": str(exc)},
            )

    def check_disk_space(self) -> DiagnosticResult:
        """检查 DATA_DIR 所在磁盘剩余空间是否 >= 100MB。

        Returns:
            DiagnosticResult: 磁盘空间检查结果。
        """
        try:
            usage = shutil.disk_usage(str(DATA_DIR))
            free_gb = usage.free / (1024 ** 3)
            passed = usage.free >= _MIN_DISK_SPACE_BYTES
            if passed:
                return DiagnosticResult(
                    name="磁盘空间",
                    level=DiagnosticLevel.INFO,
                    passed=True,
                    message=f"磁盘空间充足 ({free_gb:.1f}GB 可用)",
                    details={"free_bytes": usage.free, "free_gb": round(free_gb, 2)},
                )
            free_mb = usage.free / (1024 ** 2)
            return DiagnosticResult(
                name="磁盘空间",
                level=DiagnosticLevel.CRITICAL,
                passed=False,
                message=f"磁盘空间不足 ({free_mb:.1f}MB 可用，需 >= 100MB)",
                details={"free_bytes": usage.free, "free_mb": round(free_mb, 2)},
            )
        except Exception as exc:
            log.debug("doctor 异常处理", error=str(exc))
            return DiagnosticResult(
                name="磁盘空间",
                level=DiagnosticLevel.CRITICAL,
                passed=False,
                message=f"无法检测磁盘空间: {exc}",
                details={"error": str(exc)},
            )

    def check_file_permissions(self) -> DiagnosticResult:
        """检查 DATA_DIR 是否可读写。

        Returns:
            DiagnosticResult: 文件权限检查结果。
        """
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            test_file = DATA_DIR / ".doctor_permission_test"
            test_file.write_text("test", encoding="utf-8")
            content = test_file.read_text(encoding="utf-8")
            # 仅做清理：Path.unlink 已被全局包装为 fail-closed 的安全删除（回收站）。
            # 在无回收站环境（如 Windows 沙箱）会失败，不应影响"可读写"诊断结论。
            # best-effort：先尝试安全删除，失败再原生 os.remove（该临时文件由本诊断
            # 自建，硬删除安全）；两处异常以 log_ignored 记录，不静默吞掉。
            try:
                test_file.unlink()
            except Exception as _exc:
                log.debug("doctor 异常处理", error=str(_exc))
                log_ignored(log, "Doctor.check_file_permissions", _exc)
                try:
                    os.remove(str(test_file))
                except Exception as _exc2:
                    log.debug("doctor 异常处理", error=str(_exc2))
                    log_ignored(log, "Doctor.check_file_permissions", _exc2)
            if content == "test":
                return DiagnosticResult(
                    name="文件权限",
                    level=DiagnosticLevel.INFO,
                    passed=True,
                    message=f"DATA_DIR 可读写 ({DATA_DIR})",
                    details={"path": str(DATA_DIR)},
                )
            return DiagnosticResult(
                name="文件权限",
                level=DiagnosticLevel.CRITICAL,
                passed=False,
                message="DATA_DIR 读写内容不一致",
                details={"path": str(DATA_DIR)},
            )
        except PermissionError:
            return DiagnosticResult(
                name="文件权限",
                level=DiagnosticLevel.CRITICAL,
                passed=False,
                message=f"DATA_DIR 无读写权限 ({DATA_DIR})",
                details={"path": str(DATA_DIR)},
            )
        except Exception as exc:
            log.debug("doctor 异常处理", error=str(exc))
            return DiagnosticResult(
                name="文件权限",
                level=DiagnosticLevel.CRITICAL,
                passed=False,
                message=f"DATA_DIR 权限检查失败: {exc}",
                details={"path": str(DATA_DIR), "error": str(exc)},
            )

    @staticmethod
    def format_report(results: list[DiagnosticResult]) -> str:
        """将诊断结果格式化为人类可读的文本报告。

        Args:
            results: 诊断结果列表。

        Returns:
            str: 格式化后的诊断报告。
        """
        lines: list[str] = []
        lines.append("═══ Jiabaixing Doctor ═══")

        passed_count = 0
        for r in results:
            if r.passed:
                passed_count += 1
                icon = "✅"
            elif r.level == DiagnosticLevel.WARNING:
                icon = "⚠️ "
            else:
                icon = "❌"
            lines.append(f"{icon} {r.message}")

        total = len(results)
        lines.append(f"═══ {passed_count}/{total} 通过 ═══")
        return "\n".join(lines)

    # ── 私有方法 ──────────────────────────────────────────────

    @staticmethod
    def _check_single_dependency(dep_name: str) -> DiagnosticResult:
        """检查单个依赖包是否可导入。

        Args:
            dep_name: 依赖包名称。

        Returns:
            DiagnosticResult: 依赖检查结果。
        """
        # sqlite3 是内置模块，特殊处理
        if dep_name == "sqlite3":
            try:
                mod = importlib.import_module(dep_name)
                version = getattr(mod, "sqlite_version", "unknown")
                return DiagnosticResult(
                    name=f"依赖:{dep_name}",
                    level=DiagnosticLevel.INFO,
                    passed=True,
                    message=f"依赖: {dep_name} (v{version})",
                    details={"version": str(version)},
                )
            except ImportError as exc:
                return DiagnosticResult(
                    name=f"依赖:{dep_name}",
                    level=DiagnosticLevel.CRITICAL,
                    passed=False,
                    message=f"依赖缺失: {dep_name}",
                    details={"error": str(exc)},
                )

        try:
            mod = importlib.import_module(dep_name)
            version = getattr(mod, "__version__", "unknown")
            return DiagnosticResult(
                name=f"依赖:{dep_name}",
                level=DiagnosticLevel.INFO,
                passed=True,
                message=f"依赖: {dep_name} (v{version})",
                details={"version": str(version)},
            )
        except ImportError:
            return DiagnosticResult(
                name=f"依赖:{dep_name}",
                level=DiagnosticLevel.CRITICAL,
                passed=False,
                message=f"依赖缺失: {dep_name}",
                details={},
            )