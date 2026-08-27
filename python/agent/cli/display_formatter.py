"""统一显示格式化器。

提供统一的输出格式化能力，支持多种输出格式：
  - JSON 美化输出
  - YAML 输出
  - Table 表格输出
  - Plain 纯文本输出
  - 自动格式选择（基于终端能力/用户偏好）
  - 分页输出
  - 管道模式（stdout pipe 检测）

与 CliOutput 的关系：
  - CliOutput 提供彩色终端输出
  - DisplayFormatter 提供结构化数据格式化
  - 两者可组合使用

集成示例::

    from agent.cli.display_formatter import DisplayFormatter, OutputFormat

    fmt = DisplayFormatter()
    data = [{"name": "alpha", "status": "running"}, {"name": "beta", "status": "stopped"}]
    fmt.display(data, format=OutputFormat.TABLE, headers=["name", "status"])
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("display_formatter")




class OutputFormat(str, Enum):
    """输出格式。"""

    JSON = "json"
    YAML = "yaml"
    TABLE = "table"
    PLAIN = "plain"
    AUTO = "auto"


@dataclass
class DisplayConfig:
    """显示配置。

    Attributes:
        format: 输出格式。
        indent: JSON 缩进空格数。
        max_width: 最大显示宽度。
        color: 是否使用颜色。
        pager: 是否使用分页器。
        pipe_friendly: 管道模式下是否简化输出。
    """

    format: OutputFormat = OutputFormat.AUTO
    indent: int = 2
    max_width: int = 80
    color: bool = True
    pager: bool = False
    pipe_friendly: bool = True


class DisplayFormatter:
    """统一显示格式化器。

    支持多种输出格式的结构化数据格式化。
    """

    def __init__(self, config: DisplayConfig | None = None) -> None:
        self._config = config or DisplayConfig()
        self._is_pipe = not sys.stdout.isatty()

    @property
    def config(self) -> DisplayConfig:
        return self._config

    def display(
        self,
        data: Any,
        format: OutputFormat | None = None,
        headers: list[str] | None = None,
        title: str = "",
    ) -> str:
        """格式化并显示数据。

        Args:
            data: 要显示的数据。
            format: 输出格式（None 使用配置默认）。
            headers: 表头（表格模式）。
            title: 标题。

        Returns:
            格式化后的文本。
        """
        fmt = format or self._config.format
        if fmt == OutputFormat.AUTO:
            fmt = self._auto_detect_format(data)

        if fmt == OutputFormat.JSON:
            result = self._format_json(data)
        elif fmt == OutputFormat.YAML:
            result = self._format_yaml(data)
        elif fmt == OutputFormat.TABLE:
            result = self._format_table(data, headers=headers, title=title)
        elif fmt == OutputFormat.PLAIN:
            result = self._format_plain(data)
        else:
            result = self._format_json(data)

        if self._config.pipe_friendly and self._is_pipe:
            result = self._strip_ansi(result)

        return result

    def print(
        self,
        data: Any,
        format: OutputFormat | None = None,
        headers: list[str] | None = None,
        title: str = "",
    ) -> None:
        """格式化并打印数据。"""
        text = self.display(data, format=format, headers=headers, title=title)
        print(text)

    def _auto_detect_format(self, data: Any) -> OutputFormat:
        """自动检测最佳输出格式。"""
        if self._is_pipe:
            return OutputFormat.JSON

        if isinstance(data, list) and data and isinstance(data[0], dict):
            return OutputFormat.TABLE

        if isinstance(data, dict):
            return OutputFormat.JSON

        return OutputFormat.PLAIN

    def _format_json(self, data: Any) -> str:
        """格式化为 JSON。"""
        return json.dumps(data, indent=self._config.indent, ensure_ascii=False, default=str)

    def _format_yaml(self, data: Any) -> str:
        """格式化为 YAML。"""
        try:
            import yaml

            return yaml.dump(data, allow_unicode=True, default_flow_style=False, sort_keys=False)
        except ImportError:
            return self._format_json(data)

    def _format_table(
        self,
        data: Any,
        headers: list[str] | None = None,
        title: str = "",
    ) -> str:
        """格式化为表格。"""
        if not isinstance(data, list):
            return self._format_json(data)

        if not data:
            return "(empty)"

        if isinstance(data[0], dict):
            cols = headers or list(data[0].keys())
            rows = [[str(item.get(c, "")) for c in cols] for item in data]
        elif isinstance(data[0], list | tuple):
            cols = headers or [f"Col{i}" for i in range(len(data[0]))]
            rows = [[str(v) for v in row] for row in data]
        else:
            return "\n".join(str(item) for item in data)

        col_widths = [len(c) for c in cols]
        for row in rows:
            for i, cell in enumerate(row):
                if i < len(col_widths):
                    col_widths[i] = max(col_widths[i], len(cell))

        lines: list[str] = []
        if title:
            lines.append(f"**{title}**")
            lines.append("")

        header_parts = [c.ljust(col_widths[i]) for i, c in enumerate(cols)]
        lines.append("| " + " | ".join(header_parts) + " |")

        sep_parts = ["-" * w for w in col_widths]
        lines.append("| " + " | ".join(sep_parts) + " |")

        for row in rows:
            row_parts = []
            for i, cell in enumerate(row):
                w = col_widths[i] if i < len(col_widths) else len(cell)
                row_parts.append(cell.ljust(w))
            lines.append("| " + " | ".join(row_parts) + " |")

        return "\n".join(lines)

    def _format_plain(self, data: Any) -> str:
        """格式化为纯文本。"""
        if isinstance(data, list):
            return "\n".join(str(item) for item in data)
        if isinstance(data, dict):
            return "\n".join(f"{k}: {v}" for k, v in data.items())
        return str(data)

    def _strip_ansi(self, text: str) -> str:
        """去除 ANSI 转义码。"""
        import re

        return re.sub(r"\033\[[0-9;]*m", "", text)
