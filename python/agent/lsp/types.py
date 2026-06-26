from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum, auto
from typing import Any


class LspDiagnosticSeverity(IntEnum):
    ERROR = 1
    WARNING = 2
    INFORMATION = 3
    HINT = 4


class LspCompletionItemKind(IntEnum):
    TEXT = 1
    METHOD = 2
    FUNCTION = 3
    CONSTRUCTOR = 4
    FIELD = 5
    VARIABLE = 6
    CLASS = 7
    INTERFACE = 8
    MODULE = 9
    PROPERTY = 10
    ENUM = 13
    KEYWORD = 14
    SNIPPET = 15
    FILE = 17
    FOLDER = 19


class LspSymbolKind(IntEnum):
    FILE = 1
    MODULE = 2
    NAMESPACE = 3
    PACKAGE = 4
    CLASS = 5
    METHOD = 6
    PROPERTY = 7
    FIELD = 8
    CONSTRUCTOR = 9
    ENUM = 10
    INTERFACE = 11
    FUNCTION = 12
    VARIABLE = 13
    CONSTANT = 14


class LspTextDocumentSyncKind(IntEnum):
    NONE = 0
    FULL = 1
    INCREMENTAL = 2


@dataclass
class LspPosition:
    line: int
    character: int


@dataclass
class LspRange:
    start: LspPosition
    end: LspPosition


@dataclass
class LspLocation:
    uri: str
    range: LspRange


@dataclass
class LspDiagnostic:
    range: LspRange
    severity: LspDiagnosticSeverity
    message: str
    code: int | str | None = None
    source: str | None = None
    related_information: list[dict] | None = None


@dataclass
class LspCompletionItem:
    label: str
    kind: LspCompletionItemKind | None = None
    detail: str | None = None
    documentation: str | None = None
    insert_text: str | None = None
    sort_text: str | None = None


@dataclass
class LspHover:
    contents: list[dict]
    range: LspRange | None = None


@dataclass
class LspDocumentSymbol:
    name: str
    kind: LspSymbolKind
    range: LspRange
    selection_range: LspRange
    children: list[LspDocumentSymbol] | None = None


@dataclass
class LspServerConfig:
    id: str
    command: str
    languages: list[str]
    args: list[str] = field(default_factory=list)
    env: dict[str, str] | None = None
    initialization_options: dict[str, Any] | None = None


@dataclass
class LspWorkspaceConfig:
    root_uri: str
    folders: list[dict] = field(default_factory=list)


@dataclass
class LspConnectionState:
    server_id: str
    status: str
    languages: list[str]
    last_error: str | None = None


@dataclass
class LspTextDocumentIdentifier:
    uri: str


@dataclass
class LspVersionedTextDocumentIdentifier(LspTextDocumentIdentifier):
    version: int


@dataclass
class LspTextDocumentItem:
    uri: str
    language_id: str
    version: int
    text: str


@dataclass
class LspServerCapabilities:
    completion_provider: dict | None = None
    hover_provider: bool = False
    diagnostic_provider: dict | None = None
    document_symbol_provider: bool = False
    definition_provider: bool = False
    references_provider: bool = False
    text_document_sync: LspTextDocumentSyncKind = LspTextDocumentSyncKind.FULL


@dataclass
class LspPublishDiagnosticsParams:
    uri: str
    diagnostics: list[LspDiagnostic]


BUILTIN_SERVERS: list[LspServerConfig] = [
    LspServerConfig(
        id="typescript",
        command="npx",
        args=["typescript-language-server", "--stdio"],
        languages=["typescript", "typescriptreact", "javascript", "javascriptreact"],
    ),
    LspServerConfig(
        id="python",
        command="pylsp",
        args=[],
        languages=["python"],
    ),
    LspServerConfig(
        id="golang",
        command="gopls",
        args=[],
        languages=["go"],
    ),
    LspServerConfig(
        id="rust",
        command="rust-analyzer",
        args=[],
        languages=["rust"],
    ),
    LspServerConfig(
        id="css",
        command="vscode-css-language-server",
        args=["--stdio"],
        languages=["css", "scss", "less"],
    ),
    LspServerConfig(
        id="html",
        command="vscode-html-language-server",
        args=["--stdio"],
        languages=["html"],
    ),
    LspServerConfig(
        id="json",
        command="vscode-json-language-server",
        args=["--stdio"],
        languages=["json"],
    ),
]

EXTENSION_MAP: dict[str, str] = {
    "ts": "typescript",
    "tsx": "typescriptreact",
    "js": "javascript",
    "jsx": "javascriptreact",
    "py": "python",
    "go": "go",
    "rs": "rust",
    "css": "css",
    "scss": "scss",
    "less": "less",
    "html": "html",
    "htm": "html",
    "json": "json",
}
