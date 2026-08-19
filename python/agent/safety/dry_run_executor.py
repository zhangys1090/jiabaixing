"""DryRunExecutor — 预演执行。

在高风险操作真实执行前，先模拟执行，预测可能的影响。
不产生任何真实副作用，仅返回影响报告。

预演策略：
1. 文件操作：在虚拟文件系统中模拟，记录将创建/修改/删除的文件
2. 命令执行：分析命令参数，预测可能影响的路径和资源
3. 网络请求：仅记录目标 URL，不实际发送

Usage:
    from agent.safety.dry_run_executor import DryRunExecutor

    executor = DryRunExecutor()
    report = executor.preview_file_write("/project/src/main.py", "new content")
    print(report.affected_files)
    print(report.risk_assessment)
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.safety.operation_scope import OperationScope

log = StructuredLogger("dry_run_executor")


@dataclass
class ImpactReport:
    """影响报告。

    Attributes:
        safe: 是否安全（无高风险影响）。
        affected_files: 将受影响的文件列表。
        created_files: 将创建的文件列表。
        deleted_files: 将删除的文件列表。
        modified_files: 将修改的文件列表。
        network_targets: 将访问的网络目标。
        estimated_size_change: 预估大小变化（字节）。
        risk_assessment: 风险评估（safe/low/medium/high/critical）。
        warnings: 警告信息列表。
        details: 详细信息。
    """

    safe: bool = True
    affected_files: list[str] = field(default_factory=list)
    created_files: list[str] = field(default_factory=list)
    deleted_files: list[str] = field(default_factory=list)
    modified_files: list[str] = field(default_factory=list)
    network_targets: list[str] = field(default_factory=list)
    estimated_size_change: int = 0
    risk_assessment: str = "safe"
    warnings: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)


class DryRunExecutor:
    """预演执行器 — 模拟操作，预测影响。

    不产生任何真实副作用，仅返回影响报告。
    支持预演：文件写入/删除、命令执行、网络请求。
    """

    _HIGH_RISK_EXTENSIONS = {
        ".exe", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".reg",
        ".sys", ".dll", ".drv",
    }

    _HIGH_RISK_PATHS = {
        "/etc", "/usr/bin", "/usr/sbin",
        "C:\\Windows", "C:\\Program Files",
    }

    def __init__(self, scope: OperationScope | None = None) -> None:
        self._scope = scope
        self._virtual_fs: dict[str, str | None] = {}

    def preview_file_write(
        self,
        path: str,
        content: str | None = None,
        scope: OperationScope | None = None,
    ) -> ImpactReport:
        """预演文件写入操作。

        Args:
            path: 目标文件路径。
            content: 写入内容（可选，用于大小估算）。
            scope: 操作作用域（覆盖实例级 scope）。

        Returns:
            ImpactReport: 影响报告。
        """
        scope = scope or self._scope
        report = ImpactReport()
        resolved = str(Path(path).resolve())

        if scope:
            allowed, reason = scope.check_path(resolved)
            if not allowed:
                report.safe = False
                report.risk_assessment = "critical"
                report.warnings.append(f"路径不在作用域内: {reason}")
                return report

        exists = Path(resolved).exists()
        if exists:
            report.modified_files.append(resolved)
        else:
            report.created_files.append(resolved)

        report.affected_files.append(resolved)

        ext = Path(resolved).suffix.lower()
        if ext in self._HIGH_RISK_EXTENSIONS:
            report.risk_assessment = "high"
            report.warnings.append(f"高风险文件扩展名: {ext}")
            report.safe = False

        for hrp in self._HIGH_RISK_PATHS:
            if resolved.startswith(hrp) or resolved.lower().startswith(hrp.lower()):
                report.risk_assessment = "critical"
                report.warnings.append(f"高风险路径: {hrp}")
                report.safe = False
                break

        if content:
            report.estimated_size_change = len(content.encode("utf-8"))
            if exists:
                try:
                    old_size = Path(resolved).stat().st_size
                    report.estimated_size_change -= old_size
                except OSError as _exc:
                    log_ignored(log, "dry_run_executor.preview_file_write", _exc)

        if report.risk_assessment == "safe" and report.warnings:
            report.risk_assessment = "low"

        self._virtual_fs[resolved] = content
        return report

    def preview_file_delete(
        self,
        path: str,
        scope: OperationScope | None = None,
    ) -> ImpactReport:
        """预演文件删除操作。"""
        scope = scope or self._scope
        report = ImpactReport()
        resolved = str(Path(path).resolve())

        if scope:
            allowed, reason = scope.check_path(resolved)
            if not allowed:
                report.safe = False
                report.risk_assessment = "critical"
                report.warnings.append(f"路径不在作用域内: {reason}")
                return report

        report.deleted_files.append(resolved)
        report.affected_files.append(resolved)

        if Path(resolved).exists():
            try:
                size = Path(resolved).stat().st_size
                report.estimated_size_change = -size
            except OSError as _exc:
                log_ignored(log, "dry_run_executor.preview_file_delete", _exc)

        if Path(resolved).is_dir():
            file_count = sum(1 for _ in Path(resolved).rglob("*") if _.is_file())
            report.warnings.append(f"目录删除将影响 {file_count} 个文件")
            report.risk_assessment = "high" if file_count > 10 else "medium"
            report.safe = False

        if report.risk_assessment == "safe":
            report.risk_assessment = "medium"
            report.warnings.append("文件删除操作不可逆")

        self._virtual_fs[resolved] = None
        return report

    def preview_command(
        self,
        command: str,
        scope: OperationScope | None = None,
    ) -> ImpactReport:
        """预演命令执行。

        通过正则模式匹配分析命令可能产生的影响。
        """
        report = ImpactReport()

        write_patterns = [
            (r'(?:>|(?:>>|1>>|2>>))\s*([^\s;&|]+)', "重定向输出"),
            (r'\b(?:cp|copy|mv|move|install)\s+\S+\s+(\S+)', "文件复制/移动"),
            (r'\b(?:mkdir|New-Item)\s+(?:.+\s+)?(\S+)', "创建目录"),
            (r'\b(?:rm|del|Remove-Item)\s+(?:.+\s+)?(\S+)', "删除文件"),
            (r'\b(?:pip|npm|yarn)\s+install', "安装包"),
            (r'\b(?:git)\s+(?:push|merge|rebase|reset|checkout)', "Git 写操作"),
        ]

        network_patterns = [
            (r'\b(?:curl|wget|Invoke-WebRequest)\s+\S*?(https?://\S+)', "HTTP 请求"),
            (r'\b(?:ssh|scp|rsync)\s+(\S+)', "远程连接"),
            (r'\b(?:docker)\s+(?:pull|push)', "Docker 远程操作"),
        ]

        for pattern, desc in write_patterns:
            matches = re.findall(pattern, command)
            for m in matches:
                report.affected_files.append(m)
                report.warnings.append(f"{desc}: {m}")

        for pattern, desc in network_patterns:
            matches = re.findall(pattern, command)
            for m in matches:
                report.network_targets.append(m)
                report.warnings.append(f"{desc}: {m}")

        if report.affected_files or report.network_targets:
            report.risk_assessment = "medium"
            if any(kw in command for kw in ["rm -rf", "del /s", "format", "mkfs", "dd"]):
                report.risk_assessment = "critical"
                report.safe = False

        if report.risk_assessment == "safe" and not report.warnings:
            report.risk_assessment = "low"
            report.warnings.append("命令执行可能产生未预见的副作用")

        return report

    def preview_batch(
        self,
        operations: list[dict[str, Any]],
        scope: OperationScope | None = None,
    ) -> ImpactReport:
        """预演批量操作。

        Args:
            operations: 操作列表，每个操作包含 type/path/content/command 等字段。
            scope: 操作作用域。

        Returns:
            ImpactReport: 聚合影响报告。
        """
        combined = ImpactReport()
        for op in operations:
            op_type = op.get("type", "")
            if op_type == "file_write":
                r = self.preview_file_write(op.get("path", ""), op.get("content"), scope)
            elif op_type == "file_delete":
                r = self.preview_file_delete(op.get("path", ""), scope)
            elif op_type == "command":
                r = self.preview_command(op.get("command", ""), scope)
            else:
                continue

            combined.affected_files.extend(r.affected_files)
            combined.created_files.extend(r.created_files)
            combined.deleted_files.extend(r.deleted_files)
            combined.modified_files.extend(r.modified_files)
            combined.network_targets.extend(r.network_targets)
            combined.warnings.extend(r.warnings)
            combined.estimated_size_change += r.estimated_size_change

            risk_order = {"safe": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
            if risk_order.get(r.risk_assessment, 0) > risk_order.get(combined.risk_assessment, 0):
                combined.risk_assessment = r.risk_assessment

        combined.safe = combined.risk_assessment in ("safe", "low")
        combined.affected_files = list(dict.fromkeys(combined.affected_files))
        combined.created_files = list(dict.fromkeys(combined.created_files))
        combined.deleted_files = list(dict.fromkeys(combined.deleted_files))
        combined.modified_files = list(dict.fromkeys(combined.modified_files))

        return combined
