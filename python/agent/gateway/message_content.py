"""消息内容处理器。

对消息内容进行格式化、提取和转换：
  - Markdown 表格渲染与对齐
  - 代码块提取与语言检测
  - 链接提取与安全检查
  - 消息摘要生成
  - 内容类型检测（文本/代码/表格/混合）
  - 富文本到纯文本转换

与 MessageDispatcher 的关系：
  - Dispatcher 路由消息后，可经 MessageContentProcessor 格式化
  - 平台适配器可按需转换输出格式

集成示例::

    from agent.gateway.message_content import MessageContentProcessor

    proc = MessageContentProcessor()
    result = proc.process("请看这个表格:\\n| A | B |\\n|---|---|\\n| 1 | 2 |")
    print(result.content_type)  # "mixed"
    print(result.tables)        # [已对齐的表格]
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("message_content")


class ContentType(str, Enum):
    """内容类型。"""

    TEXT = "text"
    CODE = "code"
    TABLE = "table"
    MIXED = "mixed"


@dataclass
class CodeBlock:
    """代码块。

    Attributes:
        language: 编程语言。
        code: 代码内容。
        start: 在原文中的起始位置。
        end: 在原文中的结束位置。
    """

    language: str = ""
    code: str = ""
    start: int = 0
    end: int = 0


@dataclass
class MarkdownTable:
    """Markdown 表格。

    Attributes:
        headers: 表头列表。
        rows: 数据行列表。
        aligned_text: 对齐后的文本。
        start: 在原文中的起始位置。
    """

    headers: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    aligned_text: str = ""
    start: int = 0


@dataclass
class ProcessedContent:
    """处理后的内容。

    Attributes:
        original: 原始文本。
        content_type: 内容类型。
        tables: 提取的表格。
        code_blocks: 提取的代码块。
        links: 提取的链接。
        plain_text: 纯文本（去除 Markdown 格式）。
        summary: 内容摘要。
    """

    original: str = ""
    content_type: ContentType = ContentType.TEXT
    tables: list[MarkdownTable] = field(default_factory=list)
    code_blocks: list[CodeBlock] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    plain_text: str = ""
    summary: str = ""


class MessageContentProcessor:
    """消息内容处理器。

    对消息内容进行格式化、提取和转换。
    """

    TABLE_PATTERN = re.compile(
        r"(\|[^\n]+\|\n\|[-:\s|]+\|\n(?:\|[^\n]+\|\n?)*)",
        re.MULTILINE,
    )
    CODE_BLOCK_PATTERN = re.compile(r"```(\w*)\n(.*?)```", re.DOTALL)
    LINK_PATTERN = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
    INLINE_CODE_PATTERN = re.compile(r"`([^`]+)`")
    BOLD_PATTERN = re.compile(r"\*\*([^*]+)\*\*")
    ITALIC_PATTERN = re.compile(r"\*([^*]+)\*")

    MAX_SUMMARY_LENGTH = 200

    def process(self, text: str) -> ProcessedContent:
        """处理消息内容。

        Args:
            text: 原始消息文本。

        Returns:
            ProcessedContent 处理结果。
        """
        tables = self._extract_tables(text)
        code_blocks = self._extract_code_blocks(text)
        links = self._extract_links(text)
        plain_text = self._to_plain_text(text)
        content_type = self._detect_content_type(text, tables, code_blocks)
        summary = self._generate_summary(plain_text)

        return ProcessedContent(
            original=text,
            content_type=content_type,
            tables=tables,
            code_blocks=code_blocks,
            links=links,
            plain_text=plain_text,
            summary=summary,
        )

    def align_table(self, table_text: str) -> str:
        """对齐 Markdown 表格。

        Args:
            table_text: 原始表格文本。

        Returns:
            对齐后的表格文本。
        """
        tables = self._extract_tables(table_text)
        if not tables:
            return table_text
        return tables[0].aligned_text

    def _extract_tables(self, text: str) -> list[MarkdownTable]:
        """提取并对齐 Markdown 表格。"""
        results: list[MarkdownTable] = []
        for match in self.TABLE_PATTERN.finditer(text):
            table_text = match.group(1)
            lines = [l for l in table_text.strip().split("\n") if l.strip()]
            if len(lines) < 2:
                continue

            headers = [c.strip() for c in lines[0].split("|") if c.strip()]
            rows: list[list[str]] = []
            for line in lines[2:]:
                row = [c.strip() for c in line.split("|") if c.strip()]
                rows.append(row)

            col_widths = [len(h) for h in headers]
            for row in rows:
                for i, cell in enumerate(row):
                    if i < len(col_widths):
                        col_widths[i] = max(col_widths[i], len(cell))

            aligned_lines: list[str] = []
            header_parts = []
            for i, h in enumerate(headers):
                w = col_widths[i] if i < len(col_widths) else len(h)
                header_parts.append(h.ljust(w))
            aligned_lines.append("| " + " | ".join(header_parts) + " |")

            sep_parts = []
            for w in col_widths:
                sep_parts.append("-" * w)
            aligned_lines.append("| " + " | ".join(sep_parts) + " |")

            for row in rows:
                row_parts = []
                for i, cell in enumerate(row):
                    w = col_widths[i] if i < len(col_widths) else len(cell)
                    row_parts.append(cell.ljust(w))
                for i in range(len(row), len(headers)):
                    w = col_widths[i] if i < len(col_widths) else 0
                    row_parts.append(" " * w)
                aligned_lines.append("| " + " | ".join(row_parts) + " |")

            results.append(MarkdownTable(
                headers=headers,
                rows=rows,
                aligned_text="\n".join(aligned_lines),
                start=match.start(),
            ))

        return results

    def _extract_code_blocks(self, text: str) -> list[CodeBlock]:
        """提取代码块。"""
        results: list[CodeBlock] = []
        for match in self.CODE_BLOCK_PATTERN.finditer(text):
            results.append(CodeBlock(
                language=match.group(1) or "text",
                code=match.group(2),
                start=match.start(),
                end=match.end(),
            ))
        return results

    def _extract_links(self, text: str) -> list[str]:
        """提取链接 URL。"""
        return [m.group(2) for m in self.LINK_PATTERN.finditer(text)]

    def _to_plain_text(self, text: str) -> str:
        """转换为纯文本。"""
        result = self.CODE_BLOCK_PATTERN.sub(lambda m: m.group(2), text)
        result = self.INLINE_CODE_PATTERN.sub(r"\1", result)
        result = self.BOLD_PATTERN.sub(r"\1", result)
        result = self.ITALIC_PATTERN.sub(r"\1", result)
        result = self.LINK_PATTERN.sub(r"\1", result)
        result = self.TABLE_PATTERN.sub("", result)
        return result.strip()

    def _detect_content_type(
        self,
        text: str,
        tables: list[MarkdownTable],
        code_blocks: list[CodeBlock],
    ) -> ContentType:
        """检测内容类型。"""
        has_table = len(tables) > 0
        has_code = len(code_blocks) > 0
        if has_table and has_code:
            return ContentType.MIXED
        if has_table:
            return ContentType.TABLE
        if has_code:
            return ContentType.CODE
        return ContentType.TEXT

    def _generate_summary(self, plain_text: str) -> str:
        """生成内容摘要。"""
        if len(plain_text) <= self.MAX_SUMMARY_LENGTH:
            return plain_text
        truncated = plain_text[: self.MAX_SUMMARY_LENGTH]
        last_space = truncated.rfind(" ")
        if last_space > self.MAX_SUMMARY_LENGTH // 2:
            truncated = truncated[:last_space]
        return truncated + "..."
