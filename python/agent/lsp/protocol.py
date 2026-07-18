"""LSP 协议类型与消息处理。

定义 Language Server Protocol 的核心数据类型、消息构建/解析，
以及 JSON-RPC 2.0 传输帧处理。

核心类型:
    - LspMessage: JSON-RPC 消息封装
    - LspRequest / LspResponse / LspNotification: 具体消息类型
    - LspPosition / LspRange / LspLocation: 位置与范围
    - LspDiagnostic: 诊断信息
    - LspCompletionItem: 补全项
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class LspMessageType(Enum):
    REQUEST = "request"
    RESPONSE = "response"
    NOTIFICATION = "notification"


@dataclass
class LspPosition:
    line: int = 0
    character: int = 0


@dataclass
class LspRange:
    start: LspPosition = field(default_factory=LspPosition)
    end: LspPosition = field(default_factory=LspPosition)


@dataclass
class LspLocation:
    uri: str = ""
    range: LspRange = field(default_factory=LspRange)


class DiagnosticSeverity(Enum):
    ERROR = 1
    WARNING = 2
    INFORMATION = 3
    HINT = 4


@dataclass
class LspDiagnostic:
    range: LspRange = field(default_factory=LspRange)
    severity: DiagnosticSeverity = DiagnosticSeverity.ERROR
    code: str | int = ""
    source: str = ""
    message: str = ""


@dataclass
class LspCompletionItem:
    label: str = ""
    kind: int = 1
    detail: str = ""
    documentation: str = ""
    insert_text: str = ""


@dataclass
class LspDocumentSymbol:
    name: str = ""
    kind: int = 1
    range: LspRange = field(default_factory=LspRange)
    children: list[LspDocumentSymbol] = field(default_factory=list)


@dataclass
class LspServerCapabilities:
    completion_provider: dict[str, Any] | None = None
    hover_provider: bool = False
    definition_provider: bool = False
    references_provider: bool = False
    document_symbol_provider: bool = False
    diagnostic_provider: dict[str, Any] | None = None
    text_document_sync: int = 1


class LspProtocol:
    """LSP 协议消息构建与解析。"""

    def __init__(self):
        self._request_id = 0

    def next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def build_request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": method,
            "params": params or {},
        }

    def build_notification(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }

    def build_response(self, request_id: int | str, result: Any = None) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result,
        }

    def build_error(self, request_id: int | str, code: int, message: str, data: Any = None) -> dict[str, Any]:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {"jsonrpc": "2.0", "id": request_id, "error": error}

    @staticmethod
    def parse_message(raw: str | bytes) -> dict[str, Any]:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return json.loads(raw)

    @staticmethod
    def encode_message(msg: dict[str, Any]) -> bytes:
        body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
        return header + body

    @staticmethod
    def decode_frame(data: bytes) -> tuple[dict[str, Any], bytes]:
        header_end = data.find(b"\r\n\r\n")
        if header_end == -1:
            return {}, data
        header = data[:header_end].decode("utf-8")
        body_start = header_end + 4
        content_length = 0
        for line in header.split("\r\n"):
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":")[1].strip())
                break
        if len(data) - body_start < content_length:
            return {}, data
        body = data[body_start:body_start + content_length]
        remaining = data[body_start + content_length:]
        return json.loads(body.decode("utf-8")), remaining

    def initialize_params(self, root_uri: str = "", capabilities: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "processId": None,
            "rootUri": root_uri or None,
            "capabilities": capabilities or {
                "textDocument": {
                    "completion": {"completionItem": {"snippetSupport": True}},
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "diagnostics": {"dynamicRegistration": True},
                },
            },
        }

    def did_open_params(self, uri: str, language_id: str, version: int, text: str) -> dict[str, Any]:
        return {
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": version,
                "text": text,
            },
        }

    def did_change_params(self, uri: str, version: int, changes: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "textDocument": {"uri": uri, "version": version},
            "contentChanges": changes,
        }

    def completion_params(self, uri: str, line: int, character: int) -> dict[str, Any]:
        return {
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": character},
        }

    def hover_params(self, uri: str, line: int, character: int) -> dict[str, Any]:
        return {
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": character},
        }

    def definition_params(self, uri: str, line: int, character: int) -> dict[str, Any]:
        return {
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": character},
        }
