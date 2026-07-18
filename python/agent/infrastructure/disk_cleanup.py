"""磁盘自动清理模块——按规则清理过期临时文件、日志、缓存等。

提供 DiskCleaner 类，支持按文件模式与最大保留天数配置清理规则，
支持 dry-run 预览与实际清理，并生成格式化报告。

默认清理规则:
- DATA_DIR/logs/*.log, 7 天
- DATA_DIR/cache/*, 30 天
- DATA_DIR/tmp/*, 1 天
- DATA_DIR/backups/*.tar.gz, 90 天
- **/__pycache__/**, 0 天（立即清理）
- **/*.pyc, 0 天

Usage:
    cleaner = DiskCleaner()
    # 预览清理效果
    estimate = cleaner.estimate_cleanup()
    # 执行清理
    results = cleaner.run(dry_run=False)
    print(DiskCleaner.format_report(results))
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from agent.config import DATA_DIR

logger = logging.getLogger(__name__)


@dataclass
class CleanupRule:
    """清理规则定义。

    Attributes:
        pattern: 文件匹配模式（glob 语法），如 "logs/*.log"。
        max_age_days: 文件最大保留天数，超过即被清理；0 表示立即清理。
        description: 规则描述。
        enabled: 是否启用该规则，默认 True。
    """

    pattern: str
    max_age_days: int
    description: str = ""
    enabled: bool = True


@dataclass
class CleanupResult:
    """单条规则的清理结果。

    Attributes:
        files_removed: 删除的文件数量。
        bytes_freed: 释放的字节数。
        errors: 清理过程中的错误列表。
        rule_name: 对应的规则标识（pattern）。
    """

    files_removed: int = 0
    bytes_freed: int = 0
    errors: list[str] = field(default_factory=list)
    rule_name: str = ""


def _default_rules() -> list[CleanupRule]:
    """生成默认清理规则列表。

    Returns:
        list[CleanupRule]: 默认清理规则。
    """
    return [
        CleanupRule(
            pattern="logs/*.log",
            max_age_days=7,
            description="清理 7 天前的日志文件",
        ),
        CleanupRule(
            pattern="cache/*",
            max_age_days=30,
            description="清理 30 天前的缓存文件",
        ),
        CleanupRule(
            pattern="tmp/*",
            max_age_days=1,
            description="清理 1 天前的临时文件",
        ),
        CleanupRule(
            pattern="backups/*.tar.gz",
            max_age_days=90,
            description="清理 90 天前的备份文件",
        ),
        CleanupRule(
            pattern="**/__pycache__/**",
            max_age_days=0,
            description="立即清理 __pycache__ 目录",
        ),
        CleanupRule(
            pattern="**/*.pyc",
            max_age_days=0,
            description="立即清理 .pyc 编译缓存文件",
        ),
    ]


class DiskCleaner:
    """磁盘自动清理器——按规则清理过期文件。

    支持添加自定义清理规则、dry-run 预览、磁盘用量查询，
    以及格式化清理报告生成。

    Attributes:
        _rules: 当前清理规则列表。
        _base_dir: 清理的基础目录（默认 DATA_DIR）。

    Usage:
        cleaner = DiskCleaner()
        results = cleaner.run(dry_run=True)
        print(DiskCleaner.format_report(results))
    """

    def __init__(
        self,
        base_dir: Path | None = None,
        rules: list[CleanupRule] | None = None,
    ) -> None:
        """初始化磁盘清理器。

        Args:
            base_dir: 清理的基础目录，默认为 DATA_DIR。
            rules: 自定义清理规则列表，默认使用内置规则。
        """
        self._base_dir: Path = base_dir or DATA_DIR
        self._rules: list[CleanupRule] = rules if rules is not None else _default_rules()

    def add_rule(self, rule: CleanupRule) -> None:
        """添加清理规则。

        Args:
            rule: 清理规则实例。
        """
        self._rules.append(rule)

    def run(self, dry_run: bool = False) -> list[CleanupResult]:
        """执行磁盘清理。

        遍历所有启用的规则，清理匹配且超过保留天数的文件或目录。

        Args:
            dry_run: True 为预览模式，仅统计不实际删除。

        Returns:
            list[CleanupResult]: 每条规则的清理结果列表。
        """
        results: list[CleanupResult] = []
        now = time.time()

        for rule in self._rules:
            if not rule.enabled:
                continue

            result = CleanupResult(rule_name=rule.pattern)
            cutoff = now - (rule.max_age_days * 86400)

            # 匹配文件
            matched_files = self._match_files(rule.pattern)

            for file_path in matched_files:
                try:
                    # 对目录和文件分别处理
                    if file_path.is_dir():
                        # 目录：检查目录本身的修改时间
                        stat = file_path.stat()
                        if stat.st_mtime < cutoff or rule.max_age_days == 0:
                            # 计算目录大小
                            dir_size = sum(
                                f.stat().st_size
                                for f in file_path.rglob("*")
                                if f.is_file()
                            )
                            result.files_removed += 1
                            result.bytes_freed += dir_size

                            if not dry_run:
                                shutil.rmtree(str(file_path), ignore_errors=True)
                    elif file_path.is_file():
                        stat = file_path.stat()
                        if stat.st_mtime < cutoff or rule.max_age_days == 0:
                            result.files_removed += 1
                            result.bytes_freed += stat.st_size

                            if not dry_run:
                                file_path.unlink(missing_ok=True)
                except OSError as exc:
                    error_msg = f"{file_path}: {exc}"
                    result.errors.append(error_msg)
                    logger.warning("清理文件失败: %s", error_msg)

            results.append(result)

        return results

    def get_disk_usage(self) -> dict:
        """获取磁盘使用情况。

        Returns:
            dict: 包含 total（总空间）、used（已用）、free（可用）字段的字典，
                  单位为字节。若基础目录不存在则返回空字典。
        """
        if not self._base_dir.exists():
            return {}

        try:
            usage = shutil.disk_usage(str(self._base_dir))
        except OSError as exc:
            logger.warning("获取磁盘使用情况失败: %s", exc)
            return {}

        return {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "usage_percent": round(usage.used / usage.total * 100, 2)
            if usage.total > 0
            else 0.0,
            "path": str(self._base_dir),
        }

    def estimate_cleanup(self) -> dict:
        """估算可释放的磁盘空间。

        以 dry-run 模式运行所有规则，统计可释放空间。

        Returns:
            dict: 包含 total_files（可清理文件数）、total_bytes（可释放字节数）、
                  by_rule（按规则分类的详细信息）的字典。
        """
        results = self.run(dry_run=True)

        total_files = 0
        total_bytes = 0
        by_rule: dict[str, dict] = {}

        for r in results:
            total_files += r.files_removed
            total_bytes += r.bytes_freed
            by_rule[r.rule_name] = {
                "files": r.files_removed,
                "bytes": r.bytes_freed,
                "errors": len(r.errors),
            }

        return {
            "total_files": total_files,
            "total_bytes": total_bytes,
            "by_rule": by_rule,
        }

    @staticmethod
    def format_report(results: list[CleanupResult]) -> str:
        """格式化清理报告为可读文本。

        Args:
            results: run() 方法返回的清理结果列表。

        Returns:
            str: 格式化后的报告文本。
        """
        if not results:
            return "🧹 无需清理。"

        lines: list[str] = ["🧹 磁盘清理报告", "=" * 50]
        total_files = 0
        total_bytes = 0
        total_errors = 0

        for r in results:
            total_files += r.files_removed
            total_bytes += r.bytes_freed
            total_errors += len(r.errors)

            status = "✅" if not r.errors else "⚠️"
            lines.append(
                f"\n{status} 规则 [{r.rule_name}]: "
                f"删除 {r.files_removed} 项, "
                f"释放 {_human_size(r.bytes_freed)}"
            )
            for err in r.errors:
                lines.append(f"  ❌ {err}")

        lines.append(f"\n{'=' * 50}")
        lines.append(
            f"📊 总计: 删除 {total_files} 项, "
            f"释放 {_human_size(total_bytes)}, "
            f"错误 {total_errors} 个"
        )

        return "\n".join(lines)

    def _match_files(self, pattern: str) -> list[Path]:
        """按 glob 模式匹配文件。

        对于含 ** 的模式使用 rglob，否则使用 glob。
        匹配在 _base_dir 下进行。

        Args:
            pattern: glob 模式字符串。

        Returns:
            list[Path]: 匹配到的文件/目录路径列表。
        """
        if not self._base_dir.exists():
            return []

        results: list[Path] = []

        # 判断是否为递归模式
        if "**" in pattern:
            # 去掉开头的 **/ 再搜索
            sub_pattern = pattern.lstrip("*").lstrip("/").lstrip("*").lstrip("/")
            for p in self._base_dir.rglob(sub_pattern):
                results.append(p)
        else:
            for p in self._base_dir.glob(pattern):
                results.append(p)

        return results


def _human_size(num_bytes: int) -> str:
    """将字节数转换为人类可读的大小字符串。

    Args:
        num_bytes: 字节数。

    Returns:
        str: 可读的大小字符串（如 "1.5 MB"）。
    """
    if num_bytes < 1024:
        return f"{num_bytes} B"
    elif num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    elif num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{num_bytes / (1024 * 1024 * 1024):.2f} GB"
