from __future__ import annotations

from dataclasses import dataclass, field

from agent.lsp.client_manager import LspClientManager
from agent.lsp.types import LspDiagnosticSeverity, LspPosition, LspRange

SEVERITY_MAP: dict[int, str] = {
    LspDiagnosticSeverity.ERROR.value: "error",
    LspDiagnosticSeverity.WARNING.value: "warning",
    LspDiagnosticSeverity.INFORMATION.value: "info",
    LspDiagnosticSeverity.HINT.value: "hint",
}

SEVERITY_ORDER: dict[str, int] = {
    "error": 0,
    "warning": 1,
    "info": 2,
    "hint": 3,
}


@dataclass
class DiagnosticItem:
    uri: str
    line: int
    character: int
    end_line: int
    end_character: int
    severity: str
    message: str
    code: int | str | None = None
    source: str | None = None


@dataclass
class DiagnosticSummary:
    uri: str
    errors: int
    warnings: int
    infos: int
    hints: int
    total: int
    items: list[DiagnosticItem] = field(default_factory=list)


@dataclass
class DiagnosticFilter:
    severity: str | None = None
    min_severity: str | None = None
    uri: str | None = None
    source: str | None = None


class LspDiagnosticsProvider:
    def __init__(self, client_manager: LspClientManager | None = None) -> None:
        self._client_manager = client_manager or LspClientManager.get_instance()

    async def get_diagnostics_for_file(self, uri: str) -> DiagnosticSummary:
        diagnostics = await self._client_manager.get_diagnostics(uri)
        return self._build_summary(uri, diagnostics)

    async def get_diagnostics_for_files(self, uris: list[str]) -> list[DiagnosticSummary]:
        results = await asyncio_gather_many(
            *(self.get_diagnostics_for_file(uri) for uri in uris)
        )
        return results

    async def get_diagnostics_at_position(
        self, uri: str, position: LspPosition
    ) -> list[DiagnosticItem]:
        diagnostics = await self._client_manager.get_diagnostics(uri)
        return [
            self._to_diagnostic_item(uri, d)
            for d in diagnostics
            if self._is_position_in_range(position, d.range)
        ]

    def get_all_cached_diagnostics(self) -> list[DiagnosticSummary]:
        all_diags = self._client_manager.get_all_diagnostics()
        summaries: list[DiagnosticSummary] = []
        for uri, diagnostics in all_diags.items():
            if diagnostics:
                summaries.append(self._build_summary(uri, diagnostics))
        return summaries

    def filter_diagnostics(
        self,
        summaries: list[DiagnosticSummary],
        filter_: DiagnosticFilter,
    ) -> list[DiagnosticSummary]:
        result: list[DiagnosticSummary] = []
        for summary in summaries:
            filtered = []
            for item in summary.items:
                if filter_.uri and item.uri != filter_.uri:
                    continue
                if filter_.source and item.source != filter_.source:
                    continue
                if filter_.severity and item.severity != filter_.severity:
                    continue
                if (
                    filter_.min_severity
                    and SEVERITY_ORDER.get(item.severity, 99)
                    > SEVERITY_ORDER.get(filter_.min_severity, 99)
                ):
                    continue
                filtered.append(item)

            if filtered:
                result.append(DiagnosticSummary(
                    uri=summary.uri,
                    errors=sum(1 for i in filtered if i.severity == "error"),
                    warnings=sum(1 for i in filtered if i.severity == "warning"),
                    infos=sum(1 for i in filtered if i.severity == "info"),
                    hints=sum(1 for i in filtered if i.severity == "hint"),
                    total=len(filtered),
                    items=filtered,
                ))

        return result

    def format_diagnostics(self, summary: DiagnosticSummary) -> str:
        lines: list[str] = []
        lines.append(
            f"\U0001F4C4 {summary.uri} "
            f"({summary.errors}E {summary.warnings}W {summary.infos}I {summary.hints}H)"
        )

        for item in summary.items:
            icon = {"error": "\u274C", "warning": "\u26A0\uFE0F",
                    "info": "\u2139\uFE0F", "hint": "\U0001F4A1"}.get(item.severity, "?")
            lines.append(
                f"  {icon} L{item.line}:{item.character} "
                f"[{item.source or 'lsp'}] {item.message}"
            )

        return "\n".join(lines)

    def _build_summary(self, uri: str, diagnostics) -> DiagnosticSummary:
        items = [self._to_diagnostic_item(uri, d) for d in diagnostics]
        return DiagnosticSummary(
            uri=uri,
            errors=sum(1 for i in items if i.severity == "error"),
            warnings=sum(1 for i in items if i.severity == "warning"),
            infos=sum(1 for i in items if i.severity == "info"),
            hints=sum(1 for i in items if i.severity == "hint"),
            total=len(items),
            items=items,
        )

    @staticmethod
    def _to_diagnostic_item(uri: str, diagnostic) -> DiagnosticItem:
        return DiagnosticItem(
            uri=uri,
            line=diagnostic.range.start.line + 1,
            character=diagnostic.range.start.character + 1,
            end_line=diagnostic.range.end.line + 1,
            end_character=diagnostic.range.end.character + 1,
            severity=SEVERITY_MAP.get(diagnostic.severity.value, "info"),
            message=diagnostic.message,
            code=diagnostic.code,
            source=diagnostic.source,
        )

    @staticmethod
    def _is_position_in_range(position: LspPosition, rng: LspRange) -> bool:
        if position.line < rng.start.line or position.line > rng.end.line:
            return False
        if position.line == rng.start.line and position.character < rng.start.character:
            return False
        if position.line == rng.end.line and position.character > rng.end.character:
            return False
        return True


async def asyncio_gather_many(*coros):
    import asyncio
    return await asyncio.gather(*coros)
