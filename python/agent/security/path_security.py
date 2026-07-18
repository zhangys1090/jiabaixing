"""路径安全守卫模块——防止路径遍历攻击。

提供路径验证、文件名清理和扩展名白名单检查，确保文件操作
仅在受控目录内执行，防止攻击者通过 ``../`` 或符号链接逃逸。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import ClassVar


class PathSecurityError(Exception):
    """路径安全违规异常。

    当目标路径解析后位于基础目录之外，或包含路径遍历攻击特征时抛出。

    Attributes:
        path: 触发违规的路径。
        reason: 违规原因。
    """

    def __init__(self, path: str, reason: str) -> None:
        self.path = path
        self.reason = reason
        super().__init__(f"路径安全违规: {reason} (路径: {path})")


class PathSecurityGuard:
    """路径遍历防护守卫。

    验证文件路径是否位于指定基础目录内，检测路径遍历攻击，
    清理文件名中的危险字符，并检查文件扩展名白名单。

    Attributes:
        ALLOWED_EXTENSIONS: 默认允许的文件扩展名集合（小写，含点号）。

    Usage:
        guard = PathSecurityGuard()
        safe_path = guard.validate_path("/data", "/data/ok/file.txt")
        clean = guard.sanitize_filename("con|cept<>*.txt")
    """

    ALLOWED_EXTENSIONS: ClassVar[frozenset[str]] = frozenset(
        {
            ".txt", ".md", ".json", ".yaml", ".yml", ".csv",
            ".py", ".js", ".ts", ".tsx", ".jsx",
            ".html", ".css", ".xml",
            ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
            ".pdf", ".doc", ".docx", ".xls", ".xlsx",
            ".zip", ".tar", ".gz",
            ".log", ".cfg", ".ini", ".toml",
        }
    )

    # 路径遍历特征模式
    _TRAVERSAL_PATTERNS: ClassVar[list[re.Pattern[str]]] = [
        re.compile(r"\.\.[/\\]"),
        re.compile(r"[/\\]\.\.[/\\]"),
        re.compile(r"[/\\]\.\.$"),
        re.compile(r"^\.\.[/\\]"),
    ]

    # Windows 保留设备名
    _WINDOWS_RESERVED: ClassVar[frozenset[str]] = frozenset(
        {
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5",
            "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
            "LPT6", "LPT7", "LPT8", "LPT9",
        }
    )

    def validate_path(self, base_dir: str | Path, target_path: str | Path) -> Path:
        """验证目标路径是否安全地位于基础目录内。

        解析符号链接和 ``..`` 后，检查解析后的绝对路径是否
        仍在 ``base_dir`` 内。若不在，抛出 :class:`PathSecurityError`。

        Args:
            base_dir: 允许的根目录。
            target_path: 待验证的目标路径。

        Returns:
            Path: 解析后的安全绝对路径。

        Raises:
            PathSecurityError: 目标路径位于基础目录之外时抛出。
        """
        base = Path(base_dir).resolve()
        target = Path(base_dir).joinpath(target_path).resolve()

        # 检查目标是否在基础目录内（含基础目录本身）
        try:
            target.relative_to(base)
        except ValueError:
            raise PathSecurityError(
                str(target_path),
                f"路径解析后位于基础目录之外 (base={base}, target={target})",
            )

        return target

    def is_path_traversal(self, path: str | Path) -> bool:
        """检测路径是否包含路径遍历攻击特征。

        检查路径字符串中是否包含 ``../`` 等 traversal 模式。

        Args:
            path: 待检测的路径字符串或 Path 对象。

        Returns:
            bool: 包含遍历特征返回 ``True``，否则返回 ``False``。
        """
        path_str = str(path)
        for pattern in self._TRAVERSAL_PATTERNS:
            if pattern.search(path_str):
                return True
        return False

    def sanitize_filename(self, name: str) -> str:
        """清理文件名中的危险字符。

        移除或替换文件名中可能导致安全问题的字符，包括：
        - 路径分隔符 ``/`` ``\\``
        - Shell 特殊字符 ``|`` ``;`` ``&`` ``$`` ````
        - 重定向符号 ``<`` ``>``
        - 通配符 ``*`` ``?``
        - 空字节 ``\\0``
        - Windows 保留设备名

        Args:
            name: 原始文件名。

        Returns:
            str: 清理后的安全文件名。
        """
        # 移除空字节
        result = name.replace("\0", "")

        # 替换路径分隔符
        result = result.replace("/", "_").replace("\\", "_")

        # 移除危险字符
        result = re.sub(r'[|;&$`<>*?"]', "", result)

        # 移除前后空格和点号（Windows 不允许结尾点号）
        result = result.strip(" .")

        # 处理 Windows 保留设备名
        stem = result.split(".")[0].upper() if result else ""
        if stem in self._WINDOWS_RESERVED:
            result = f"_{result}"

        # 空文件名兜底
        if not result:
            result = "unnamed"

        return result

    def is_allowed_extension(self, path: str | Path) -> bool:
        """检查文件扩展名是否在白名单内。

        Args:
            path: 文件路径。

        Returns:
            bool: 扩展名在白名单内返回 ``True``，否则返回 ``False``。
        """
        ext = Path(path).suffix.lower()
        return ext in self.ALLOWED_EXTENSIONS
