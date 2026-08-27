"""Markdown 表格渲染器。

提供 Markdown 表格的高级渲染能力：
  - 列对齐（左/右/居中）
  - 自动列宽计算
  - 表格合并与拆分
  - CSV / JSON 到 Markdown 表格转换
  - 表格排序与过滤
  - 跨平台终端表格渲染

与 MessageContentProcessor 的关系：
  - MessageContentProcessor 提取和对齐表格
  - MarkdownTables 提供更丰富的渲染和转换能力

集成示例::

    from agent.gateway.markdown_tables import MarkdownTables

    mt = MarkdownTables()
    table = mt.from_data(
        headers=["Name", "Status", "Score"],
        rows=[["alpha", "running", "0.95"], ["beta", "stopped", "0.80"]],
    )
    logger.info(table)
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable
from agent.core.logger import StructuredLogger

log = StructuredLogger("markdown_tables")




class Align(str, Enum):
    """列对齐方式。"""

    LEFT = "left"
    RIGHT = "right"
    CENTER = "center"


@dataclass
class ColumnSpec:
    """列规格。

    Attributes:
        name: 列名。
        align: 对齐方式。
        min_width: 最小宽度。
        max_width: 最大宽度（0 表示不限）。
    """

    name: str = ""
    align: Align = Align.LEFT
    min_width: int = 0
    max_width: int = 0


@dataclass
class TableData:
    """表格数据。

    Attributes:
        headers: 表头。
        rows: 数据行。
        specs: 列规格。
        caption: 表格标题。
    """

    headers: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    specs: list[ColumnSpec] = field(default_factory=list)
    caption: str = ""


class MarkdownTables:
    """Markdown 表格渲染器。

    提供表格创建、渲染和转换能力。
    """

    def from_data(
        self,
        headers: list[str],
        rows: list[list[str]],
        aligns: list[Align] | None = None,
        caption: str = "",
    ) -> str:
        """从数据创建 Markdown 表格。

        Args:
            headers: 表头。
            rows: 数据行。
            aligns: 各列对齐方式。
            caption: 表格标题。

        Returns:
            Markdown 表格文本。
        """
        specs: list[ColumnSpec] = []
        for i, h in enumerate(headers):
            align = aligns[i] if aligns and i < len(aligns) else Align.LEFT
            specs.append(ColumnSpec(name=h, align=align))

        data = TableData(headers=headers, rows=rows, specs=specs, caption=caption)
        return self.render(data)

    def from_csv(self, csv_text: str, delimiter: str = ",") -> str:
        """从 CSV 文本创建 Markdown 表格。

        Args:
            csv_text: CSV 文本。
            delimiter: 分隔符。

        Returns:
            Markdown 表格文本。
        """
        reader = csv.reader(io.StringIO(csv_text), delimiter=delimiter)
        rows_raw = list(reader)
        if not rows_raw:
            return ""

        headers = rows_raw[0]
        rows = rows_raw[1:]
        return self.from_data(headers=headers, rows=rows)

    def from_json(self, json_text: str) -> str:
        """从 JSON 数组创建 Markdown 表格。

        Args:
            json_text: JSON 文本（对象数组）。

        Returns:
            Markdown 表格文本。
        """
        data = json.loads(json_text)
        if not isinstance(data, list) or not data:
            return ""

        headers = list(data[0].keys())
        rows = [[str(item.get(h, "")) for h in headers] for item in data]
        return self.from_data(headers=headers, rows=rows)

    def render(self, data: TableData) -> str:
        """渲染 Markdown 表格。

        Args:
            data: 表格数据。

        Returns:
            Markdown 表格文本。
        """
        if not data.headers:
            return ""

        col_widths = self._calc_widths(data)
        lines: list[str] = []

        if data.caption:
            lines.append(f"**{data.caption}**")
            lines.append("")

        header_line = self._render_row(data.headers, col_widths, data.specs)
        lines.append(header_line)

        sep_line = self._render_separator(col_widths, data.specs)
        lines.append(sep_line)

        for row in data.rows:
            row_line = self._render_row(row, col_widths, data.specs)
            lines.append(row_line)

        return "\n".join(lines)

    def sort_table(
        self,
        data: TableData,
        column: str,
        reverse: bool = False,
    ) -> TableData:
        """按列排序表格。

        Args:
            data: 表格数据。
            column: 排序列名。
            reverse: 是否倒序。

        Returns:
            排序后的 TableData。
        """
        if column not in data.headers:
            return data

        col_idx = data.headers.index(column)

        def _sort_key(row: list[str]) -> str:
            return row[col_idx] if col_idx < len(row) else ""

        sorted_rows = sorted(data.rows, key=_sort_key, reverse=reverse)
        return TableData(
            headers=data.headers,
            rows=sorted_rows,
            specs=data.specs,
            caption=data.caption,
        )

    def filter_table(
        self,
        data: TableData,
        column: str,
        predicate: Callable[[str], bool] | None = None,
        value: str | None = None,
    ) -> TableData:
        """按列过滤表格。

        Args:
            data: 表格数据。
            column: 过滤列名。
            predicate: 过滤谓词。
            value: 精确匹配值（predicate 为 None 时使用）。

        Returns:
            过滤后的 TableData。
        """
        if column not in data.headers:
            return data

        col_idx = data.headers.index(column)

        if predicate is None:
            target = value or ""
            filtered = [r for r in data.rows if col_idx < len(r) and r[col_idx] == target]
        else:
            filtered = [r for r in data.rows if col_idx < len(r) and predicate(r[col_idx])]

        return TableData(
            headers=data.headers,
            rows=filtered,
            specs=data.specs,
            caption=data.caption,
        )

    def _calc_widths(self, data: TableData) -> list[int]:
        """计算列宽。"""
        widths = [len(h) for h in data.headers]
        for row in data.rows:
            for i, cell in enumerate(row):
                if i < len(widths):
                    widths[i] = max(widths[i], len(str(cell)))
                else:
                    widths.append(len(str(cell)))

        for i, spec in enumerate(data.specs):
            if i < len(widths):
                if spec.min_width > 0:
                    widths[i] = max(widths[i], spec.min_width)
                if spec.max_width > 0:
                    widths[i] = min(widths[i], spec.max_width)

        return widths

    def _render_row(
        self, cells: list[str], widths: list[int], specs: list[ColumnSpec]
    ) -> str:
        """渲染一行。"""
        parts: list[str] = []
        for i, cell in enumerate(cells):
            w = widths[i] if i < len(widths) else len(str(cell))
            spec = specs[i] if i < len(specs) else ColumnSpec()
            text = str(cell)
            parts.append(self._align_text(text, w, spec.align))
        return "| " + " | ".join(parts) + " |"

    def _render_separator(
        self, widths: list[int], specs: list[ColumnSpec]
    ) -> str:
        """渲染分隔行。"""
        parts: list[str] = []
        for i, w in enumerate(widths):
            spec = specs[i] if i < len(specs) else ColumnSpec()
            if spec.align == Align.CENTER:
                parts.append(f":{'─' * (w - 2)}:")
            elif spec.align == Align.RIGHT:
                parts.append(f"{'─' * (w - 1)}:")
            else:
                parts.append(f":{'─' * (w - 1)}")
        return "| " + " | ".join(parts) + " |"

    def _align_text(self, text: str, width: int, align: Align) -> str:
        """对齐文本。"""
        if align == Align.CENTER:
            return text.center(width)
        elif align == Align.RIGHT:
            return text.rjust(width)
        return text.ljust(width)