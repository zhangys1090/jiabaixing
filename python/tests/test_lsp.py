from __future__ import annotations

import json
import asyncio
import pytest

from agent.lsp.types import (
    BUILTIN_SERVERS,
    EXTENSION_MAP,
    LspDiagnosticSeverity,
    LspPosition,
    LspRange,
    LspServerConfig,
    LspSymbolKind,
    LspTextDocumentItem,
    LspTextDocumentSyncKind,
    LspDiagnostic,
    LspServerCapabilities,
    LspConnectionState,
    LspWorkspaceConfig,
    LspCompletionItemKind,
    LspDocumentSymbol,
    LspHover,
    LspLocation,
)
from agent.lsp.transport import LspTransport
from agent.lsp.client_manager import LspClientManager
from agent.lsp.completion_provider import (
    LspCompletionProvider,
    CompletionItem,
    CompletionResult,
    HoverResult,
    DefinitionResult,
    ReferencesResult,
    SymbolResult,
    SymbolEntry,
    LocationEntry,
)
from agent.lsp.diagnostics_provider import (
    LspDiagnosticsProvider,
    DiagnosticFilter,
    DiagnosticItem,
    DiagnosticSummary,
)


# ═══════════════════════════════════════════════════════════════
# Types tests
# ═══════════════════════════════════════════════════════════════


class TestLspTypes:
    def test_position(self):
        pos = LspPosition(line=3, character=15)
        assert pos.line == 3
        assert pos.character == 15

    def test_range(self):
        rng = LspRange(
            start=LspPosition(line=0, character=0),
            end=LspPosition(line=10, character=5),
        )
        assert rng.start.line == 0
        assert rng.end.line == 10

    def test_diagnostic_severity_values(self):
        assert LspDiagnosticSeverity.ERROR == 1
        assert LspDiagnosticSeverity.WARNING == 2
        assert LspDiagnosticSeverity.INFORMATION == 3
        assert LspDiagnosticSeverity.HINT == 4

    def test_server_config(self):
        config = LspServerConfig(
            id="python",
            command="pylsp",
            languages=["python"],
        )
        assert config.id == "python"
        assert config.command == "pylsp"

    def test_builtin_servers(self):
        assert len(BUILTIN_SERVERS) == 7
        server_ids = [s.id for s in BUILTIN_SERVERS]
        assert "typescript" in server_ids
        assert "python" in server_ids
        assert "golang" in server_ids
        assert "rust" in server_ids

    def test_extension_map(self):
        assert EXTENSION_MAP["py"] == "python"
        assert EXTENSION_MAP["ts"] == "typescript"
        assert EXTENSION_MAP["go"] == "go"
        assert EXTENSION_MAP["js"] == "javascript"

    def test_text_document_item(self):
        doc = LspTextDocumentItem(
            uri="file:///test.py",
            language_id="python",
            version=1,
            text="print('hello')",
        )
        assert doc.uri == "file:///test.py"
        assert doc.language_id == "python"

    def test_workspace_config(self):
        config = LspWorkspaceConfig(
            root_uri="file:///workspace",
            folders=[{"uri": "file:///workspace/src", "name": "src"}],
        )
        assert config.root_uri == "file:///workspace"
        assert len(config.folders) == 1

    def test_connection_state(self):
        state = LspConnectionState(
            server_id="python",
            status="connected",
            languages=["python"],
        )
        assert state.status == "connected"

    def test_capabilities_defaults(self):
        caps = LspServerCapabilities()
        assert caps.hover_provider is False
        assert caps.definition_provider is False
        assert caps.text_document_sync == LspTextDocumentSyncKind.FULL

    def test_diagnostic_data_class(self):
        diag = LspDiagnostic(
            range=LspRange(
                start=LspPosition(line=0, character=0),
                end=LspPosition(line=0, character=10),
            ),
            severity=LspDiagnosticSeverity.ERROR,
            message="test error",
            code="E001",
            source="mypy",
        )
        assert diag.message == "test error"
        assert diag.severity == LspDiagnosticSeverity.ERROR

    def test_completion_item_kind_values(self):
        assert LspCompletionItemKind.FUNCTION == 3
        assert LspCompletionItemKind.CLASS == 7
        assert LspCompletionItemKind.VARIABLE == 6

    def test_symbol_kind_values(self):
        assert LspSymbolKind.FUNCTION == 12
        assert LspSymbolKind.CLASS == 5
        assert LspSymbolKind.VARIABLE == 13


# ═══════════════════════════════════════════════════════════════
# Transport tests
# ═══════════════════════════════════════════════════════════════


class TestLspTransport:
    def test_transport_creation(self):
        transport = LspTransport()
        assert transport is not None

    def test_send_notification_before_start(self):
        transport = LspTransport()
        transport.send_notification("test/method", {"key": "value"})

    def test_request_timeout_default(self):
        transport = LspTransport()
        assert transport._request_timeout == 30.0

    def test_request_timeout_custom(self):
        transport = LspTransport(request_timeout=10.0)
        assert transport._request_timeout == 10.0

    def test_message_id_increment(self):
        transport = LspTransport()
        assert transport._message_id == 0

    def test_notification_handler_registration(self):
        transport = LspTransport()
        received: list[dict] = []

        async def handler(params: dict):
            received.append(params)

        transport.on_notification("test/event", handler)
        assert "test/event" in transport._notification_handlers


# ═══════════════════════════════════════════════════════════════
# LspClientManager tests
# ═══════════════════════════════════════════════════════════════


class TestLspClientManager:
    def setup_method(self):
        LspClientManager.reset_instance()

    def test_singleton(self):
        m1 = LspClientManager.get_instance()
        m2 = LspClientManager.get_instance()
        assert m1 is m2

    def test_reset_instance(self):
        m1 = LspClientManager.get_instance()
        LspClientManager.reset_instance()
        m2 = LspClientManager.get_instance()
        assert m1 is not m2

    def test_configure_workspace(self):
        manager = LspClientManager()
        config = LspWorkspaceConfig(root_uri="file:///test")
        manager.configure_workspace(config)
        assert manager._workspace_config is not None
        assert manager._workspace_config.root_uri == "file:///test"

    def test_register_custom_server(self):
        manager = LspClientManager()
        config = LspServerConfig(
            id="custom-lang",
            command="custom-ls",
            languages=["custom"],
        )
        manager.register_server(config)
        assert len(manager._custom_servers) == 1
        assert manager._custom_servers[0].id == "custom-lang"

    def test_register_server_overwrites_by_id(self):
        manager = LspClientManager()
        config1 = LspServerConfig(id="test", command="cmd1", languages=["a"])
        config2 = LspServerConfig(id="test", command="cmd2", languages=["b"])
        manager.register_server(config1)
        manager.register_server(config2)
        assert len(manager._custom_servers) == 1
        assert manager._custom_servers[0].command == "cmd2"

    def test_get_supported_languages(self):
        manager = LspClientManager()
        languages = manager.get_supported_languages()
        assert "python" in languages
        assert "typescript" in languages
        assert "go" in languages

    def test_get_server_config_found(self):
        manager = LspClientManager()
        config = manager._get_server_config("python")
        assert config is not None
        assert config.id == "python"

    def test_get_server_config_not_found(self):
        manager = LspClientManager()
        config = manager._get_server_config("unknown-language")
        assert config is None

    def test_event_handler(self):
        manager = LspClientManager()
        received: list[dict] = []

        def handler(data):
            received.append(data)

        manager.on("connected", handler)
        manager._emit("connected", {"serverId": "test"})
        assert len(received) == 1
        assert received[0]["serverId"] == "test"

    def test_connection_states_empty(self):
        manager = LspClientManager()
        states = manager.get_connection_states()
        assert states == []

    def test_diagnostics_cache_empty(self):
        manager = LspClientManager()
        diags = manager.get_all_diagnostics()
        assert diags == {}

    def test_clear_diagnostics_cache(self):
        manager = LspClientManager()
        manager._diagnostics_cache["file:///a.py"] = [
            LspDiagnostic(
                range=LspRange(
                    start=LspPosition(0, 0),
                    end=LspPosition(0, 5),
                ),
                severity=LspDiagnosticSeverity.ERROR,
                message="test",
            )
        ]
        manager.clear_diagnostics_cache("file:///a.py")
        assert manager.get_all_diagnostics() == {}

    def test_parse_capabilities_full(self):
        raw = {
            "completionProvider": {"triggerCharacters": ["."]},
            "hoverProvider": True,
            "definitionProvider": True,
            "referencesProvider": True,
            "documentSymbolProvider": True,
            "textDocumentSync": 1,
        }
        caps = LspClientManager._parse_capabilities(raw)
        assert caps.completion_provider is not None
        assert caps.hover_provider is True
        assert caps.definition_provider is True
        assert caps.references_provider is True
        assert caps.document_symbol_provider is True
        assert caps.text_document_sync == LspTextDocumentSyncKind.FULL

    def test_extract_extension(self):
        assert LspClientManager._extract_extension("file:///test.py") == "py"
        assert LspClientManager._extract_extension("file:///src/app.ts") == "ts"
        assert LspClientManager._extract_extension("file:///main.go") == "go"

    def test_parse_diagnostics(self):
        raw = [{
            "range": {
                "start": {"line": 1, "character": 2},
                "end": {"line": 1, "character": 10},
            },
            "severity": 1,
            "message": "syntax error",
            "source": "mypy",
        }]
        diags = LspClientManager._parse_diagnostics(raw)
        assert len(diags) == 1
        assert diags[0].message == "syntax error"
        assert diags[0].severity == LspDiagnosticSeverity.ERROR

    def test_parse_locations_list(self):
        raw = [{
            "uri": "file:///a.py",
            "range": {
                "start": {"line": 5, "character": 0},
                "end": {"line": 5, "character": 10},
            },
        }]
        locs = LspClientManager._parse_locations(raw)
        assert len(locs) == 1
        assert locs[0].uri == "file:///a.py"

    def test_parse_locations_single(self):
        raw = {
            "uri": "file:///b.py",
            "range": {
                "start": {"line": 3, "character": 1},
                "end": {"line": 3, "character": 8},
            },
        }
        locs = LspClientManager._parse_locations(raw)
        assert len(locs) == 1
        assert locs[0].uri == "file:///b.py"

    def test_parse_document_symbols(self):
        raw = [{
            "name": "MyClass",
            "kind": 5,
            "range": {
                "start": {"line": 0, "character": 0},
                "end": {"line": 10, "character": 1},
            },
            "selectionRange": {
                "start": {"line": 0, "character": 6},
                "end": {"line": 0, "character": 13},
            },
            "children": [{
                "name": "method1",
                "kind": 6,
                "range": {
                    "start": {"line": 2, "character": 4},
                    "end": {"line": 5, "character": 5},
                },
                "selectionRange": {
                    "start": {"line": 2, "character": 8},
                    "end": {"line": 2, "character": 15},
                },
            }],
        }]
        symbols = LspClientManager._parse_document_symbols(raw)
        assert len(symbols) == 1
        assert symbols[0].name == "MyClass"
        assert symbols[0].children is not None
        assert len(symbols[0].children) == 1
        assert symbols[0].children[0].name == "method1"


# ═══════════════════════════════════════════════════════════════
# CompletionProvider tests
# ═══════════════════════════════════════════════════════════════


class TestLspCompletionProvider:
    def test_completion_item(self):
        item = CompletionItem(
            label="print",
            kind="Function",
            detail="print(value, ...)",
            documentation="Prints values to stdout",
        )
        assert item.label == "print"
        assert item.kind == "Function"

    def test_completion_result(self):
        result = CompletionResult(
            uri="file:///test.py",
            position=LspPosition(line=5, character=0),
            items=[CompletionItem(label="print")],
        )
        assert result.uri == "file:///test.py"
        assert len(result.items) == 1

    def test_location_entry(self):
        entry = LocationEntry(
            uri="file:///a.py",
            line=10,
            character=5,
        )
        assert entry.line == 10
        assert entry.character == 5

    def test_symbol_entry(self):
        child = SymbolEntry(
            name="inner",
            kind="Function",
            line=3,
            character=4,
            end_line=5,
            end_character=1,
        )
        parent = SymbolEntry(
            name="outer",
            kind="Class",
            line=1,
            character=0,
            end_line=10,
            end_character=1,
            children=[child],
        )
        assert parent.name == "outer"
        assert len(parent.children) == 1
        assert parent.children[0].name == "inner"

    def test_provider_creation(self):
        LspClientManager.reset_instance()
        provider = LspCompletionProvider()
        assert provider is not None

    def test_symbol_kind_map(self):
        from agent.lsp.completion_provider import SYMBOL_KIND_MAP
        assert SYMBOL_KIND_MAP[5] == "Class"
        assert SYMBOL_KIND_MAP[12] == "Function"
        assert SYMBOL_KIND_MAP[13] == "Variable"

    def test_completion_kind_map(self):
        from agent.lsp.completion_provider import COMPLETION_KIND_MAP
        assert COMPLETION_KIND_MAP[3] == "Function"
        assert COMPLETION_KIND_MAP[7] == "Class"


# ═══════════════════════════════════════════════════════════════
# DiagnosticsProvider tests
# ═══════════════════════════════════════════════════════════════


class TestLspDiagnosticsProvider:
    def test_diagnostic_item(self):
        item = DiagnosticItem(
            uri="file:///test.py",
            line=1,
            character=5,
            end_line=1,
            end_character=10,
            severity="error",
            message="undefined variable",
            source="mypy",
        )
        assert item.severity == "error"
        assert item.source == "mypy"

    def test_diagnostic_summary(self):
        items = [
            DiagnosticItem(
                uri="file:///test.py",
                line=1, character=0, end_line=1, end_character=5,
                severity="error", message="err1",
            ),
            DiagnosticItem(
                uri="file:///test.py",
                line=2, character=0, end_line=2, end_character=3,
                severity="warning", message="warn1",
            ),
        ]
        summary = DiagnosticSummary(
            uri="file:///test.py",
            errors=1,
            warnings=1,
            infos=0,
            hints=0,
            total=2,
            items=items,
        )
        assert summary.errors == 1
        assert summary.warnings == 1
        assert summary.total == 2

    def test_provider_creation(self):
        LspClientManager.reset_instance()
        provider = LspDiagnosticsProvider()
        assert provider is not None

    def test_format_diagnostics(self):
        provider = LspDiagnosticsProvider()
        items = [
            DiagnosticItem(
                uri="file:///test.py",
                line=1, character=0, end_line=1, end_character=5,
                severity="error", message="NameError", source="mypy",
            ),
            DiagnosticItem(
                uri="file:///test.py",
                line=3, character=2, end_line=3, end_character=8,
                severity="warning", message="unused import", source="ruff",
            ),
        ]
        summary = DiagnosticSummary(
            uri="file:///test.py",
            errors=1, warnings=1, infos=0, hints=0, total=2,
            items=items,
        )
        formatted = provider.format_diagnostics(summary)
        assert "file:///test.py" in formatted
        assert "1E 1W" in formatted
        assert "NameError" in formatted
        assert "unused import" in formatted

    def test_filter_by_severity(self):
        provider = LspDiagnosticsProvider()
        items = [
            DiagnosticItem(
                uri="file:///a.py", line=1, character=0,
                end_line=1, end_character=5, severity="error", message="e",
            ),
            DiagnosticItem(
                uri="file:///a.py", line=2, character=0,
                end_line=2, end_character=3, severity="warning", message="w",
            ),
        ]
        summaries = [
            DiagnosticSummary(
                uri="file:///a.py", errors=1, warnings=1, infos=0, hints=0,
                total=2, items=items,
            )
        ]

        filtered = provider.filter_diagnostics(
            summaries, DiagnosticFilter(severity="error")
        )
        assert len(filtered) == 1
        assert filtered[0].total == 1
        assert filtered[0].items[0].severity == "error"

    def test_filter_by_min_severity(self):
        provider = LspDiagnosticsProvider()
        items = [
            DiagnosticItem(
                uri="file:///a.py", line=1, character=0,
                end_line=1, end_character=5, severity="hint", message="h",
            ),
            DiagnosticItem(
                uri="file:///a.py", line=2, character=0,
                end_line=2, end_character=3, severity="error", message="e",
            ),
        ]
        summaries = [
            DiagnosticSummary(
                uri="file:///a.py", errors=1, warnings=0, infos=0, hints=1,
                total=2, items=items,
            )
        ]

        filtered = provider.filter_diagnostics(
            summaries, DiagnosticFilter(min_severity="warning")
        )
        assert len(filtered) == 1
        assert filtered[0].total == 1
        assert filtered[0].items[0].severity == "error"

    def test_filter_by_source(self):
        provider = LspDiagnosticsProvider()
        items = [
            DiagnosticItem(
                uri="file:///a.py", line=1, character=0,
                end_line=1, end_character=5, severity="error", message="e",
                source="mypy",
            ),
            DiagnosticItem(
                uri="file:///a.py", line=2, character=0,
                end_line=2, end_character=3, severity="warning", message="w",
                source="ruff",
            ),
        ]
        summaries = [
            DiagnosticSummary(
                uri="file:///a.py", errors=1, warnings=1, infos=0, hints=0,
                total=2, items=items,
            )
        ]

        filtered = provider.filter_diagnostics(
            summaries, DiagnosticFilter(source="mypy")
        )
        assert len(filtered) == 1
        assert filtered[0].total == 1

    def test_filter_by_uri(self):
        provider = LspDiagnosticsProvider()
        items_a = [
            DiagnosticItem(
                uri="file:///a.py", line=1, character=0,
                end_line=1, end_character=5, severity="error", message="e",
            ),
        ]
        items_b = [
            DiagnosticItem(
                uri="file:///b.py", line=2, character=0,
                end_line=2, end_character=3, severity="warning", message="w",
            ),
        ]
        summaries = [
            DiagnosticSummary(
                uri="file:///a.py", errors=1, warnings=0, infos=0, hints=0,
                total=1, items=items_a,
            ),
            DiagnosticSummary(
                uri="file:///b.py", errors=0, warnings=1, infos=0, hints=0,
                total=1, items=items_b,
            ),
        ]

        filtered = provider.filter_diagnostics(
            summaries, DiagnosticFilter(uri="file:///a.py")
        )
        assert len(filtered) == 1
        assert filtered[0].uri == "file:///a.py"

    def test_no_match_returns_empty(self):
        provider = LspDiagnosticsProvider()
        items = [
            DiagnosticItem(
                uri="file:///a.py", line=1, character=0,
                end_line=1, end_character=5, severity="error", message="e",
            ),
        ]
        summaries = [
            DiagnosticSummary(
                uri="file:///a.py", errors=1, warnings=0, infos=0, hints=0,
                total=1, items=items,
            )
        ]

        filtered = provider.filter_diagnostics(
            summaries, DiagnosticFilter(severity="warning")
        )
        assert len(filtered) == 0

    def test_get_all_cached_empty(self):
        provider = LspDiagnosticsProvider()
        result = provider.get_all_cached_diagnostics()
        assert result == []

    def test_severity_map(self):
        from agent.lsp.diagnostics_provider import SEVERITY_MAP
        assert SEVERITY_MAP[1] == "error"
        assert SEVERITY_MAP[2] == "warning"
        assert SEVERITY_MAP[3] == "info"
        assert SEVERITY_MAP[4] == "hint"

    def test_is_position_in_range_inside(self):
        pos = LspPosition(line=2, character=5)
        rng = LspRange(
            start=LspPosition(line=1, character=0),
            end=LspPosition(line=3, character=10),
        )
        assert LspDiagnosticsProvider._is_position_in_range(pos, rng) is True

    def test_is_position_in_range_before(self):
        pos = LspPosition(line=0, character=5)
        rng = LspRange(
            start=LspPosition(line=1, character=0),
            end=LspPosition(line=3, character=10),
        )
        assert LspDiagnosticsProvider._is_position_in_range(pos, rng) is False

    def test_is_position_in_range_after(self):
        pos = LspPosition(line=5, character=5)
        rng = LspRange(
            start=LspPosition(line=1, character=0),
            end=LspPosition(line=3, character=10),
        )
        assert LspDiagnosticsProvider._is_position_in_range(pos, rng) is False

    def test_is_position_in_range_start_boundary(self):
        pos = LspPosition(line=1, character=0)
        rng = LspRange(
            start=LspPosition(line=1, character=0),
            end=LspPosition(line=3, character=10),
        )
        assert LspDiagnosticsProvider._is_position_in_range(pos, rng) is True

    def test_is_position_in_range_before_start_character(self):
        pos = LspPosition(line=1, character=0)
        rng = LspRange(
            start=LspPosition(line=1, character=5),
            end=LspPosition(line=3, character=10),
        )
        assert LspDiagnosticsProvider._is_position_in_range(pos, rng) is False
