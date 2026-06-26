from __future__ import annotations

from dataclasses import dataclass, field

from agent.lsp.client_manager import LspClientManager
from agent.lsp.types import LspCompletionItemKind, LspPosition, LspSymbolKind

COMPLETION_KIND_MAP: dict[int, str] = {
    1: "Text", 2: "Method", 3: "Function", 5: "Field",
    6: "Variable", 7: "Class", 8: "Interface", 9: "Module",
    10: "Property", 13: "Enum", 14: "Keyword", 15: "Snippet",
    17: "File", 19: "Folder",
}

SYMBOL_KIND_MAP: dict[int, str] = {
    1: "File", 2: "Module", 3: "Namespace", 4: "Package",
    5: "Class", 6: "Method", 7: "Property", 8: "Field",
    9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
    13: "Variable", 14: "Constant",
}


@dataclass
class CompletionItem:
    label: str
    kind: str | None = None
    detail: str | None = None
    documentation: str | None = None
    insert_text: str | None = None


@dataclass
class CompletionResult:
    uri: str
    position: LspPosition
    items: list[CompletionItem]


@dataclass
class HoverResult:
    uri: str
    position: LspPosition
    contents: list[dict]


@dataclass
class LocationEntry:
    uri: str
    line: int
    character: int


@dataclass
class DefinitionResult:
    uri: str
    position: LspPosition
    locations: list[LocationEntry]


@dataclass
class ReferencesResult:
    uri: str
    position: LspPosition
    locations: list[LocationEntry]


@dataclass
class SymbolEntry:
    name: str
    kind: str
    line: int
    character: int
    end_line: int
    end_character: int
    children: list[SymbolEntry] = field(default_factory=list)


@dataclass
class SymbolResult:
    uri: str
    symbols: list[SymbolEntry]


class LspCompletionProvider:
    def __init__(self, client_manager: LspClientManager | None = None) -> None:
        self._client_manager = client_manager or LspClientManager.get_instance()

    async def get_completions(
        self, uri: str, position: LspPosition
    ) -> CompletionResult:
        items = await self._client_manager.get_completion(uri, position)

        return CompletionResult(
            uri=uri,
            position=position,
            items=[
                CompletionItem(
                    label=item.get("label", ""),
                    kind=COMPLETION_KIND_MAP.get(item.get("kind", 0)),
                    detail=item.get("detail"),
                    documentation=item.get("documentation"),
                    insert_text=item.get("insertText"),
                )
                for item in items
            ],
        )

    async def get_hover(self, uri: str, position: LspPosition) -> HoverResult | None:
        hover = await self._client_manager.get_hover(uri, position)
        if not hover:
            return None

        return HoverResult(
            uri=uri,
            position=position,
            contents=hover.contents,
        )

    async def get_definition(
        self, uri: str, position: LspPosition
    ) -> DefinitionResult:
        locations = await self._client_manager.get_definition(uri, position)

        return DefinitionResult(
            uri=uri,
            position=position,
            locations=[
                LocationEntry(
                    uri=loc.uri,
                    line=loc.range.start.line + 1,
                    character=loc.range.start.character + 1,
                )
                for loc in locations
            ],
        )

    async def get_references(
        self, uri: str, position: LspPosition
    ) -> ReferencesResult:
        locations = await self._client_manager.get_references(uri, position)

        return ReferencesResult(
            uri=uri,
            position=position,
            locations=[
                LocationEntry(
                    uri=loc.uri,
                    line=loc.range.start.line + 1,
                    character=loc.range.start.character + 1,
                )
                for loc in locations
            ],
        )

    async def get_document_symbols(self, uri: str) -> SymbolResult:
        symbols = await self._client_manager.get_document_symbols(uri)

        return SymbolResult(
            uri=uri,
            symbols=[self._convert_symbol(s) for s in symbols],
        )

    def _convert_symbol(self, sym) -> SymbolEntry:
        return SymbolEntry(
            name=sym.name,
            kind=SYMBOL_KIND_MAP.get(sym.kind.value, "Unknown"),
            line=sym.range.start.line + 1,
            character=sym.range.start.character + 1,
            end_line=sym.range.end.line + 1,
            end_character=sym.range.end.character + 1,
            children=[self._convert_symbol(c) for c in sym.children] if sym.children else [],
        )
