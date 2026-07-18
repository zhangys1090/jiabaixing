"""LSP 工作区管理。

管理工作区文档状态：
  - 文档打开/关闭/变更追踪
  - 版本号管理
  - 诊断收集与聚合
  - 多服务器文档同步

集成示例::

    from agent.lsp.workspace import LspWorkspace

    ws = LspWorkspace(root_uri="file:///home/user/project")
    ws.open_document("file:///home/user/project/main.py", "python", "print('hello')")
    diagnostics = ws.get_diagnostics("file:///home/user/project/main.py")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from agent.lsp.protocol import LspDiagnostic, LspRange, DiagnosticSeverity, LspPosition
from agent.core.logger import StructuredLogger

log = StructuredLogger("lsp.workspace")


@dataclass
class DocumentState:
    uri: str = ""
    language_id: str = ""
    version: int = 0
    text: str = ""
    last_modified: datetime = field(default_factory=datetime.now)
    is_open: bool = False


@dataclass
class WorkspaceFolder:
    uri: str = ""
    name: str = ""


class LspWorkspace:
    """LSP 工作区管理器。"""

    def __init__(self, root_uri: str = "", folders: list[WorkspaceFolder] | None = None):
        self._root_uri = root_uri
        self._folders = folders or ([WorkspaceFolder(uri=root_uri, name="root")] if root_uri else [])
        self._documents: dict[str, DocumentState] = {}
        self._diagnostics: dict[str, list[LspDiagnostic]] = {}
        self._version_counter: dict[str, int] = {}

    @property
    def root_uri(self) -> str:
        return self._root_uri

    @property
    def folders(self) -> list[WorkspaceFolder]:
        return list(self._folders)

    def add_folder(self, uri: str, name: str = "") -> None:
        self._folders.append(WorkspaceFolder(uri=uri, name=name or uri.rsplit("/", 1)[-1]))

    def open_document(self, uri: str, language_id: str, text: str, version: int | None = None) -> DocumentState:
        ver = version if version is not None else self._next_version(uri)
        doc = DocumentState(
            uri=uri,
            language_id=language_id,
            version=ver,
            text=text,
            is_open=True,
        )
        self._documents[uri] = doc
        self._diagnostics.pop(uri, None)
        log.info("Document opened", uri=uri, language=language_id, version=ver)
        return doc

    def close_document(self, uri: str) -> None:
        doc = self._documents.pop(uri, None)
        if doc:
            doc.is_open = False
            log.info("Document closed", uri=uri)

    def update_document(self, uri: str, changes: list[dict[str, Any]]) -> DocumentState | None:
        doc = self._documents.get(uri)
        if not doc:
            return None
        for change in changes:
            if "range" not in change:
                doc.text = change.get("text", doc.text)
            else:
                doc.text = self._apply_range_edit(doc.text, change["range"], change.get("text", ""))
        doc.version = self._next_version(uri)
        doc.last_modified = datetime.now()
        log.info("Document updated", uri=uri, version=doc.version)
        return doc

    def get_document(self, uri: str) -> DocumentState | None:
        return self._documents.get(uri)

    def get_open_documents(self) -> list[DocumentState]:
        return [d for d in self._documents.values() if d.is_open]

    def set_diagnostics(self, uri: str, diagnostics: list[dict[str, Any]]) -> None:
        parsed = []
        for d in diagnostics:
            range_data = d.get("range", {})
            start = range_data.get("start", {})
            end = range_data.get("end", {})
            severity = d.get("severity", 1)
            parsed.append(LspDiagnostic(
                range=LspRange(
                    start=agent_lsp_position(start.get("line", 0), start.get("character", 0)),
                    end=agent_lsp_position(end.get("line", 0), end.get("character", 0)),
                ),
                severity=DiagnosticSeverity(severity),
                code=d.get("code", ""),
                source=d.get("source", ""),
                message=d.get("message", ""),
            ))
        self._diagnostics[uri] = parsed

    def get_diagnostics(self, uri: str) -> list[LspDiagnostic]:
        return self._diagnostics.get(uri, [])

    def get_all_diagnostics(self) -> dict[str, list[LspDiagnostic]]:
        return dict(self._diagnostics)

    def clear_diagnostics(self, uri: str) -> None:
        self._diagnostics.pop(uri, None)

    def get_diagnostics_summary(self) -> dict[str, int]:
        summary = {"error": 0, "warning": 0, "info": 0, "hint": 0}
        for diags in self._diagnostics.values():
            for d in diags:
                if d.severity == DiagnosticSeverity.ERROR:
                    summary["error"] += 1
                elif d.severity == DiagnosticSeverity.WARNING:
                    summary["warning"] += 1
                elif d.severity == DiagnosticSeverity.INFORMATION:
                    summary["info"] += 1
                else:
                    summary["hint"] += 1
        return summary

    def _next_version(self, uri: str) -> int:
        current = self._version_counter.get(uri, 0)
        current += 1
        self._version_counter[uri] = current
        return current

    @staticmethod
    def _apply_range_edit(text: str, range_data: dict[str, Any], new_text: str) -> str:
        lines = text.split("\n")
        start = range_data.get("start", {})
        end = range_data.get("end", {})
        start_line = start.get("line", 0)
        start_char = start.get("character", 0)
        end_line = end.get("line", 0)
        end_char = end.get("character", 0)
        if start_line == end_line and start_line < len(lines):
            line = lines[start_line]
            lines[start_line] = line[:start_char] + new_text + line[end_char:]
        elif start_line < len(lines) and end_line < len(lines):
            prefix = lines[start_line][:start_char]
            suffix = lines[end_line][end_char:]
            lines[start_line:end_line + 1] = [prefix + new_text + suffix]
        return "\n".join(lines)

    def get_stats(self) -> dict[str, Any]:
        return {
            "root_uri": self._root_uri,
            "folders": len(self._folders),
            "open_documents": len([d for d in self._documents.values() if d.is_open]),
            "total_diagnostics": sum(len(d) for d in self._diagnostics.values()),
        }


def agent_lsp_position(line: int, character: int) -> LspPosition:
    return LspPosition(line=line, character=character)
