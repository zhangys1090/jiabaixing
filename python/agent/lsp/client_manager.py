from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.lsp.transport import LspTransport
from agent.lsp.types import (
    BUILTIN_SERVERS,
    EXTENSION_MAP,
    LspConnectionState,
    LspDiagnostic,
    LspDocumentSymbol,
    LspHover,
    LspLocation,
    LspPosition,
    LspPublishDiagnosticsParams,
    LspServerCapabilities,
    LspServerConfig,
    LspTextDocumentItem,
    LspTextDocumentSyncKind,
    LspVersionedTextDocumentIdentifier,
    LspWorkspaceConfig,
)

log = StructuredLogger("lsp.manager")


@dataclass
class ManagedServer:
    config: LspServerConfig
    transport: LspTransport
    capabilities: LspServerCapabilities | None = None
    state: LspConnectionState = field(default_factory=lambda: LspConnectionState(
        server_id="", status="disconnected", languages=[]
    ))
    document_versions: dict[str, int] = field(default_factory=dict)


class LspClientManager:
    _instance: LspClientManager | None = None

    def __init__(self) -> None:
        self._servers: dict[str, ManagedServer] = {}
        self._workspace_config: LspWorkspaceConfig | None = None
        self._diagnostics_cache: dict[str, list[LspDiagnostic]] = {}
        self._custom_servers: list[LspServerConfig] = []
        self._event_handlers: dict[str, list[Callable]] = {}

    @classmethod
    def get_instance(cls) -> LspClientManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        if cls._instance:
            for server_id in list(cls._instance._servers.keys()):
                cls._instance._servers.pop(server_id, None)
        cls._instance = None

    def configure_workspace(self, config: LspWorkspaceConfig) -> None:
        self._workspace_config = config

    def register_server(self, config: LspServerConfig) -> None:
        for i, s in enumerate(self._custom_servers):
            if s.id == config.id:
                self._custom_servers[i] = config
                return
        self._custom_servers.append(config)

    def on(self, event: str, handler: Callable) -> None:
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def _emit(self, event: str, data: Any = None) -> None:
        for handler in self._event_handlers.get(event, []):
            try:
                handler(data)
            except Exception as e:
                log.error(f"事件处理失败 [{event}]: {e}")

    def _get_server_config(self, language_id: str) -> LspServerConfig | None:
        for s in self._custom_servers:
            if language_id in s.languages:
                return s
        for s in BUILTIN_SERVERS:
            if language_id in s.languages:
                return s
        return None

    def _get_server_config_by_id(self, server_id: str) -> LspServerConfig | None:
        for s in self._custom_servers:
            if s.id == server_id:
                return s
        for s in BUILTIN_SERVERS:
            if s.id == server_id:
                return s
        return None

    async def connect(self, language_id: str) -> str | None:
        config = self._get_server_config(language_id)
        if not config:
            log.warning(f"未找到语言 {language_id} 对应的服务器配置")
            return None

        if config.id in self._servers:
            existing = self._servers[config.id]
            if existing.state.status == "connected":
                return config.id
            await self.disconnect_server(config.id)

        return await self._connect_server(config)

    async def _connect_server(self, config: LspServerConfig) -> str:
        transport = LspTransport()
        state = LspConnectionState(
            server_id=config.id,
            status="connecting",
            languages=config.languages,
        )

        managed = ManagedServer(
            config=config,
            transport=transport,
            state=state,
        )
        self._servers[config.id] = managed

        transport.on_notification(
            "textDocument/publishDiagnostics",
            self._on_publish_diagnostics,
        )

        try:
            await transport.start(config.command, config.args, config.env)

            root_uri = self._workspace_config.root_uri if self._workspace_config else ""
            workspace_folders = self._workspace_config.folders if self._workspace_config else []

            init_result = await transport.send_request("initialize", {
                "processId": os.getpid(),
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "publishDiagnostics": {"relatedInformation": True},
                        "completion": {
                            "completionItem": {"snippetSupport": False},
                        },
                        "hover": {
                            "contentFormat": ["plaintext", "markdown"],
                        },
                    },
                },
                "workspaceFolders": workspace_folders,
            })

            capabilities = self._parse_capabilities(
                init_result.get("capabilities", {}) if isinstance(init_result, dict) else {}
            )
            managed.capabilities = capabilities
            managed.state.status = "connected"

            transport.send_notification("initialized", {})

            log.info(f"语言服务器 {config.id} 连接成功")
            self._emit("connected", {
                "serverId": config.id,
                "languages": config.languages,
            })

            return config.id

        except Exception as e:
            managed.state.status = "error"
            managed.state.last_error = str(e)
            log.error(f"连接语言服务器 {config.id} 失败: {e}")
            raise

    async def disconnect_server(self, server_id: str) -> None:
        managed = self._servers.get(server_id)
        if not managed:
            return

        try:
            await managed.transport.send_request("shutdown", None)
            managed.transport.send_notification("exit", None)
        except Exception as _exc:
            log_ignored(log, "client_manager.LspClientManager.disconnect_server", _exc)

        await managed.transport.stop()
        self._servers.pop(server_id, None)
        self._emit("disconnected", {"serverId": server_id})

    async def disconnect_all(self) -> None:
        for server_id in list(self._servers.keys()):
            await self.disconnect_server(server_id)

    async def open_document(self, text_document: LspTextDocumentItem) -> None:
        server_id = await self.connect(text_document.language_id)
        if not server_id:
            return

        managed = self._servers.get(server_id)
        if not managed or managed.state.status != "connected":
            return

        managed.document_versions[text_document.uri] = text_document.version
        managed.transport.send_notification("textDocument/didOpen", {
            "textDocument": {
                "uri": text_document.uri,
                "languageId": text_document.language_id,
                "version": text_document.version,
                "text": text_document.text,
            },
        })

    async def change_document(self, uri: str, version: int, text: str) -> None:
        managed = self._find_server_for_uri(uri)
        if not managed:
            return

        managed.document_versions[uri] = version
        sync_kind = (
            managed.capabilities.text_document_sync
            if managed.capabilities
            else LspTextDocumentSyncKind.FULL
        )

        if sync_kind == LspTextDocumentSyncKind.FULL:
            content_changes = [{"text": text}]
        else:
            content_changes = [{
                "text": text,
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 999999, "character": 999999},
                },
            }]

        managed.transport.send_notification("textDocument/didChange", {
            "textDocument": {"uri": uri, "version": version},
            "contentChanges": content_changes,
        })

    async def close_document(self, uri: str) -> None:
        managed = self._find_server_for_uri(uri)
        if not managed:
            return

        managed.document_versions.pop(uri, None)
        managed.transport.send_notification("textDocument/didClose", {
            "textDocument": {"uri": uri},
        })

    async def get_diagnostics(self, uri: str) -> list[LspDiagnostic]:
        cached = self._diagnostics_cache.get(uri)
        if cached:
            return cached

        managed = self._find_server_for_uri(uri)
        if not managed or not (managed.capabilities and managed.capabilities.diagnostic_provider):
            return []

        try:
            result = await managed.transport.send_request("textDocument/diagnostic", {
                "textDocument": {"uri": uri},
            })
            items = result.get("items", []) if isinstance(result, dict) else []
            return self._parse_diagnostics(items)
        except Exception as e:
            log.error(f"获取诊断失败 [{uri}]: {e}")
            return []

    async def get_completion(
        self, uri: str, position: LspPosition
    ) -> list[dict]:
        managed = self._find_server_for_uri(uri)
        if not managed or not (managed.capabilities and managed.capabilities.completion_provider):
            return []

        try:
            result = await managed.transport.send_request("textDocument/completion", {
                "textDocument": {"uri": uri},
                "position": {"line": position.line, "character": position.character},
            })
            if isinstance(result, dict):
                items = result.get("items", [])
            elif isinstance(result, list):
                items = result
            else:
                items = []
            return items
        except Exception as e:
            log.error(f"获取补全失败 [{uri}]: {e}")
            return []

    async def get_hover(self, uri: str, position: LspPosition) -> LspHover | None:
        managed = self._find_server_for_uri(uri)
        if not managed or not (managed.capabilities and managed.capabilities.hover_provider):
            return None

        try:
            result = await managed.transport.send_request("textDocument/hover", {
                "textDocument": {"uri": uri},
                "position": {"line": position.line, "character": position.character},
            })
            if isinstance(result, dict):
                return LspHover(
                    contents=result.get("contents", {}).get("value", ""),
                    range=None,
                )
            return None
        except Exception as e:
            log.error(f"获取悬停信息失败 [{uri}]: {e}")
            return None

    async def get_document_symbols(self, uri: str) -> list[LspDocumentSymbol]:
        managed = self._find_server_for_uri(uri)
        if not managed or not (managed.capabilities and managed.capabilities.document_symbol_provider):
            return []

        try:
            result = await managed.transport.send_request("textDocument/documentSymbol", {
                "textDocument": {"uri": uri},
            })
            return self._parse_document_symbols(result if isinstance(result, list) else [])
        except Exception as e:
            log.error(f"获取文档符号失败 [{uri}]: {e}")
            return []

    async def get_definition(self, uri: str, position: LspPosition) -> list[LspLocation]:
        managed = self._find_server_for_uri(uri)
        if not managed or not (managed.capabilities and managed.capabilities.definition_provider):
            return []

        try:
            result = await managed.transport.send_request("textDocument/definition", {
                "textDocument": {"uri": uri},
                "position": {"line": position.line, "character": position.character},
            })
            return self._parse_locations(result)
        except Exception as e:
            log.error(f"获取定义失败 [{uri}]: {e}")
            return []

    async def get_references(self, uri: str, position: LspPosition) -> list[LspLocation]:
        managed = self._find_server_for_uri(uri)
        if not managed or not (managed.capabilities and managed.capabilities.references_provider):
            return []

        try:
            result = await managed.transport.send_request("textDocument/references", {
                "textDocument": {"uri": uri},
                "position": {"line": position.line, "character": position.character},
                "context": {"includeDeclaration": True},
            })
            return self._parse_locations(result)
        except Exception as e:
            log.error(f"获取引用失败 [{uri}]: {e}")
            return []

    def get_connection_states(self) -> list[LspConnectionState]:
        return [m.state for m in self._servers.values()]

    def get_supported_languages(self) -> list[str]:
        languages: set[str] = set()
        for server in BUILTIN_SERVERS + self._custom_servers:
            for lang in server.languages:
                languages.add(lang)
        return list(languages)

    def get_server_capabilities(self, server_id: str) -> LspServerCapabilities | None:
        managed = self._servers.get(server_id)
        return managed.capabilities if managed else None

    def get_all_diagnostics(self) -> dict[str, list[LspDiagnostic]]:
        return dict(self._diagnostics_cache)

    def clear_diagnostics_cache(self, uri: str | None = None) -> None:
        if uri:
            self._diagnostics_cache.pop(uri, None)
        else:
            self._diagnostics_cache.clear()

    def _on_publish_diagnostics(self, params: dict) -> None:
        uri = params.get("uri", "")
        raw_diags = params.get("diagnostics", [])
        self._diagnostics_cache[uri] = self._parse_diagnostics(raw_diags)
        self._emit("diagnostics", LspPublishDiagnosticsParams(
            uri=uri,
            diagnostics=self._diagnostics_cache[uri],
        ))

    def _find_server_for_uri(self, uri: str) -> ManagedServer | None:
        ext = self._extract_extension(uri)
        language_id = EXTENSION_MAP.get(ext, "")
        if not language_id:
            return None

        for managed in self._servers.values():
            if managed.state.status == "connected" and language_id in managed.config.languages:
                return managed
        return None

    @staticmethod
    def _extract_extension(uri: str) -> str:
        match = os.path.splitext(uri)
        ext = match[1] if match else ""
        return ext.lstrip(".").lower()

    @staticmethod
    def _parse_capabilities(raw: dict) -> LspServerCapabilities:
        return LspServerCapabilities(
            completion_provider=raw.get("completionProvider"),
            hover_provider=bool(raw.get("hoverProvider")),
            diagnostic_provider=raw.get("diagnosticProvider"),
            document_symbol_provider=bool(raw.get("documentSymbolProvider")),
            definition_provider=bool(raw.get("definitionProvider")),
            references_provider=bool(raw.get("referencesProvider")),
            text_document_sync=LspTextDocumentSyncKind(
                raw.get("textDocumentSync", LspTextDocumentSyncKind.FULL.value)
            ) if isinstance(raw.get("textDocumentSync"), int) else LspTextDocumentSyncKind.FULL,
        )

    @staticmethod
    def _parse_diagnostics(raw: list[dict]) -> list[LspDiagnostic]:
        from agent.lsp.types import LspDiagnosticSeverity, LspPosition, LspRange

        result: list[LspDiagnostic] = []
        for d in raw:
            rng = d.get("range", {})
            start = rng.get("start", {})
            end = rng.get("end", {})
            result.append(LspDiagnostic(
                range=LspRange(
                    start=LspPosition(line=start.get("line", 0), character=start.get("character", 0)),
                    end=LspPosition(line=end.get("line", 0), character=end.get("character", 0)),
                ),
                severity=LspDiagnosticSeverity(d.get("severity", 1)),
                message=d.get("message", ""),
                code=d.get("code"),
                source=d.get("source"),
            ))
        return result

    @staticmethod
    def _parse_locations(raw: Any) -> list[LspLocation]:
        from agent.lsp.types import LspPosition, LspRange

        items: list[dict] = []
        if isinstance(raw, list):
            items = raw
        elif isinstance(raw, dict) and "uri" in raw:
            items = [raw]

        result: list[LspLocation] = []
        for item in items:
            rng = item.get("range", {})
            start = rng.get("start", {})
            end = rng.get("end", {})
            result.append(LspLocation(
                uri=item.get("uri", ""),
                range=LspRange(
                    start=LspPosition(line=start.get("line", 0), character=start.get("character", 0)),
                    end=LspPosition(line=end.get("line", 0), character=end.get("character", 0)),
                ),
            ))
        return result

    @staticmethod
    def _parse_document_symbols(raw: list[dict]) -> list[LspDocumentSymbol]:
        from agent.lsp.types import LspPosition, LspRange, LspSymbolKind

        result: list[LspDocumentSymbol] = []
        for s in raw:
            rng = s.get("range", {})
            sel = s.get("selectionRange", {})
            children_raw = s.get("children", [])
            result.append(LspDocumentSymbol(
                name=s.get("name", ""),
                kind=LspSymbolKind(s.get("kind", 1)),
                range=LspRange(
                    start=LspPosition(line=rng.get("start", {}).get("line", 0),
                                      character=rng.get("start", {}).get("character", 0)),
                    end=LspPosition(line=rng.get("end", {}).get("line", 0),
                                    character=rng.get("end", {}).get("character", 0)),
                ),
                selection_range=LspRange(
                    start=LspPosition(line=sel.get("start", {}).get("line", 0),
                                      character=sel.get("start", {}).get("character", 0)),
                    end=LspPosition(line=sel.get("end", {}).get("line", 0),
                                    character=sel.get("end", {}).get("character", 0)),
                ),
                children=LspClientManager._parse_document_symbols(children_raw) if children_raw else None,
            ))
        return result
