"""CLI 输出格式化器。

提供终端彩色输出、Banner 渲染、进度条等显示能力：
  - 彩色文本输出（ANSI 转义码）
  - Banner 渲染（ASCII Art / 简洁模式）
  - 进度条（单行 / 多行）
  - 表格格式化
  - 自动检测终端能力（颜色支持 / 宽度）
  - JSON/YAML 美化输出

与 cli_tui.py 的关系：
  - cli_tui.py 提供完整 TUI 界面
  - cli_output.py 提供轻量级输出格式化
  - 两者可独立使用

集成示例::

    from agent.cli.cli_output import CliOutput

    out = CliOutput()
    out.banner("Jiabaixing Agent", version="1.0.0")
    out.success("系统初始化完成")
    out.error("连接失败")
    out.progress("加载技能", current=3, total=10)
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("cli_output")


class ColorMode(str, Enum):
    """颜色模式。"""

    AUTO = "auto"
    ALWAYS = "always"
    NEVER = "never"


class LogLevel(str, Enum):
    """日志级别样式。"""

    DEBUG = "debug"
    INFO = "info"
    SUCCESS = "success"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


ANSI_COLORS: dict[str, str] = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "dim": "\033[2m",
    "red": "\033[31m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "blue": "\033[34m",
    "magenta": "\033[35m",
    "cyan": "\033[36m",
    "white": "\033[37m",
    "bg_red": "\033[41m",
    "bg_green": "\033[42m",
    "bg_yellow": "\033[43m",
    "bg_blue": "\033[44m",
}

LEVEL_STYLES: dict[LogLevel, tuple[str, str]] = {
    LogLevel.DEBUG: ("dim", "white"),
    LogLevel.INFO: ("", "cyan"),
    LogLevel.SUCCESS: ("bold", "green"),
    LogLevel.WARNING: ("bold", "yellow"),
    LogLevel.ERROR: ("bold", "red"),
    LogLevel.CRITICAL: ("bg_red", "white"),
}

LEVEL_ICONS: dict[LogLevel, str] = {
    LogLevel.DEBUG: "•",
    LogLevel.INFO: "ℹ",
    LogLevel.SUCCESS: "✔",
    LogLevel.WARNING: "⚠",
    LogLevel.ERROR: "✖",
    LogLevel.CRITICAL: "✖",
}


@dataclass
class TerminalInfo:
    """终端信息。

    Attributes:
        width: 终端宽度。
        height: 终端高度。
        supports_color: 是否支持颜色。
        supports_unicode: 是否支持 Unicode。
        is_tty: 是否为 TTY。
    """

    width: int = 80
    height: int = 24
    supports_color: bool = False
    supports_unicode: bool = False
    is_tty: bool = False


def detect_terminal() -> TerminalInfo:
    """检测终端能力。"""
    is_tty = sys.stdout.isatty()
    width, height = shutil.get_terminal_size((80, 24))

    supports_color = False
    if is_tty:
        colorterm = os.environ.get("COLORTERM", "")
        term = os.environ.get("TERM", "")
        if colorterm in ("truecolor", "24bit") or "256color" in term:
            supports_color = True
        elif os.environ.get("WT_SESSION") or os.environ.get("CONEMUPID"):
            supports_color = True
        elif term:
            supports_color = True

    supports_unicode = is_tty and os.environ.get("PYTHONIOENCODING", "").lower() != "ascii"

    return TerminalInfo(
        width=width,
        height=height,
        supports_color=supports_color,
        supports_unicode=supports_unicode,
        is_tty=is_tty,
    )


class CliOutput:
    """CLI 输出格式化器。

    提供彩色输出、Banner、进度条等终端显示能力。
    """

    def __init__(self, color_mode: ColorMode = ColorMode.AUTO) -> None:
        self._terminal = detect_terminal()
        if color_mode == ColorMode.ALWAYS:
            self._use_color = True
        elif color_mode == ColorMode.NEVER:
            self._use_color = False
        else:
            self._use_color = self._terminal.supports_color

    @property
    def terminal(self) -> TerminalInfo:
        return self._terminal

    def _color(self, text: str, *codes: str) -> str:
        """应用颜色代码。"""
        if not self._use_color:
            return text
        prefix = "".join(ANSI_COLORS.get(c, "") for c in codes)
        if not prefix:
            return text
        return f"{prefix}{text}{ANSI_COLORS['reset']}"

    def banner(
        self,
        title: str,
        version: str = "",
        subtitle: str = "",
        style: str = "simple",
    ) -> None:
        """渲染 Banner。

        Args:
            title: 主标题。
            version: 版本号。
            subtitle: 副标题。
            style: 样式（simple / box）。
        """
        w = self._terminal.width
        if style == "box":
            inner = w - 4
            line = "─" * inner
            self.print(f"┌{line}┐")
            self.print(f"│ {self._color(title.center(inner - 2), 'bold', 'cyan')} │")
            if version:
                ver_text = f"v{version}"
                self.print(f"│ {ver_text.center(inner - 2)} │")
            if subtitle:
                self.print(f"│ {subtitle.center(inner - 2)} │")
            self.print(f"└{line}┘")
        else:
            self.print()
            self.print(self._color(f"  {title}", "bold", "cyan"))
            if version:
                self.print(self._color(f"  v{version}", "dim"))
            if subtitle:
                self.print(f"  {subtitle}")
            self.print()

    def success(self, message: str) -> None:
        """输出成功消息。"""
        self._log(LogLevel.SUCCESS, message)

    def error(self, message: str) -> None:
        """输出错误消息。"""
        self._log(LogLevel.ERROR, message)

    def warning(self, message: str) -> None:
        """输出警告消息。"""
        self._log(LogLevel.WARNING, message)

    def info(self, message: str) -> None:
        """输出信息消息。"""
        self._log(LogLevel.INFO, message)

    def debug(self, message: str) -> None:
        """输出调试消息。"""
        self._log(LogLevel.DEBUG, message)

    def progress(
        self,
        label: str,
        current: int,
        total: int,
        width: int = 30,
    ) -> None:
        """渲染进度条。

        Args:
            label: 标签。
            current: 当前进度。
            total: 总数。
            width: 进度条宽度。
        """
        if total <= 0:
            pct = 0
        else:
            pct = min(current / total, 1.0)

        filled = int(width * pct)
        empty = width - filled

        if self._use_color:
            bar = self._color("█" * filled, "green") + self._color("░" * empty, "dim")
        else:
            bar = "#" * filled + "-" * empty

        pct_str = f"{pct * 100:5.1f}%"
        count_str = f"{current}/{total}"
        line = f"\r  {label} [{bar}] {pct_str} {count_str}"

        sys.stdout.write(line)
        sys.stdout.flush()

        if current >= total:
            sys.stdout.write("\n")
            sys.stdout.flush()

    def table(
        self,
        headers: list[str],
        rows: list[list[str]],
        title: str = "",
    ) -> None:
        """渲染表格。

        Args:
            headers: 表头。
            rows: 数据行。
            title: 表格标题。
        """
        if title:
            self.print(self._color(f"  {title}", "bold"))

        col_widths = [len(h) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                if i < len(col_widths):
                    col_widths[i] = max(col_widths[i], len(str(cell)))

        header_parts = []
        for i, h in enumerate(headers):
            w = col_widths[i] if i < len(col_widths) else len(h)
            header_parts.append(self._color(h.ljust(w), "bold"))
        self.print("  " + " │ ".join(header_parts))

        sep_parts = ["─" * w for w in col_widths]
        self.print("  " + "─┼─".join(sep_parts))

        for row in rows:
            row_parts = []
            for i, cell in enumerate(row):
                w = col_widths[i] if i < len(col_widths) else len(str(cell))
                row_parts.append(str(cell).ljust(w))
            self.print("  " + " │ ".join(row_parts))

    def print(self, text: str = "") -> None:
        """输出文本。"""
        print(text)

    def _log(self, level: LogLevel, message: str) -> None:
        """格式化日志输出。"""
        icon = LEVEL_ICONS.get(level, "•")
        styles = LEVEL_STYLES.get(level, ("", "white"))
        label = level.value.upper().ljust(8)
        colored_label = self._color(label, *styles) if styles[0] or styles[1] else label
        self.print(f"  {icon} {colored_label} {message}")
