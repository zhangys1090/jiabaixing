"use strict";
/**
 * LSP 诊断提供器
 *
 * 聚合多个语言服务器的诊断结果
 * 提供统一的问题查询和过滤接口
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LspDiagnosticsProvider = void 0;
const LspClientManager_1 = require("./LspClientManager");
const types_1 = require("./types");
const SEVERITY_MAP = {
    [types_1.LspDiagnosticSeverity.Error]: 'error',
    [types_1.LspDiagnosticSeverity.Warning]: 'warning',
    [types_1.LspDiagnosticSeverity.Information]: 'info',
    [types_1.LspDiagnosticSeverity.Hint]: 'hint',
};
const SEVERITY_ORDER = {
    error: 0,
    warning: 1,
    info: 2,
    hint: 3,
};
class LspDiagnosticsProvider {
    constructor(clientManager) {
        this.clientManager = clientManager ?? LspClientManager_1.LspClientManager.getInstance();
    }
    async getDiagnosticsForFile(uri) {
        const diagnostics = await this.clientManager.getDiagnostics(uri);
        return this.buildSummary(uri, diagnostics);
    }
    async getDiagnosticsForFiles(uris) {
        const results = await Promise.all(uris.map((uri) => this.getDiagnosticsForFile(uri)));
        return results;
    }
    async getDiagnosticsAtPosition(uri, position) {
        const diagnostics = await this.clientManager.getDiagnostics(uri);
        return diagnostics
            .filter((d) => this.isPositionInRange(position, d.range))
            .map((d) => this.toDiagnosticItem(uri, d));
    }
    getAllCachedDiagnostics() {
        const allDiags = this.clientManager.getAllDiagnostics();
        const summaries = [];
        for (const [uri, diagnostics] of allDiags) {
            if (diagnostics.length > 0) {
                summaries.push(this.buildSummary(uri, diagnostics));
            }
        }
        return summaries;
    }
    filterDiagnostics(summaries, filter) {
        return summaries
            .map((summary) => {
            const filtered = summary.items.filter((item) => {
                if (filter.uri && item.uri !== filter.uri)
                    return false;
                if (filter.source && item.source !== filter.source)
                    return false;
                if (filter.severity && item.severity !== filter.severity)
                    return false;
                if (filter.minSeverity &&
                    SEVERITY_ORDER[item.severity] > SEVERITY_ORDER[filter.minSeverity])
                    return false;
                return true;
            });
            return {
                ...summary,
                items: filtered,
                errors: filtered.filter((i) => i.severity === 'error').length,
                warnings: filtered.filter((i) => i.severity === 'warning').length,
                infos: filtered.filter((i) => i.severity === 'info').length,
                hints: filtered.filter((i) => i.severity === 'hint').length,
                total: filtered.length,
            };
        })
            .filter((s) => s.total > 0);
    }
    formatDiagnostics(summary) {
        const lines = [];
        lines.push(`📄 ${summary.uri} (${summary.errors}E ${summary.warnings}W ${summary.infos}I ${summary.hints}H)`);
        for (const item of summary.items) {
            const icon = item.severity === 'error'
                ? '❌'
                : item.severity === 'warning'
                    ? '⚠️'
                    : item.severity === 'info'
                        ? 'ℹ️'
                        : '💡';
            lines.push(`  ${icon} L${item.line}:${item.character} [${item.source ?? 'lsp'}] ${item.message}`);
        }
        return lines.join('\n');
    }
    buildSummary(uri, diagnostics) {
        const items = diagnostics.map((d) => this.toDiagnosticItem(uri, d));
        return {
            uri,
            errors: items.filter((i) => i.severity === 'error').length,
            warnings: items.filter((i) => i.severity === 'warning').length,
            infos: items.filter((i) => i.severity === 'info').length,
            hints: items.filter((i) => i.severity === 'hint').length,
            total: items.length,
            items,
        };
    }
    toDiagnosticItem(uri, diagnostic) {
        return {
            uri,
            line: diagnostic.range.start.line + 1,
            character: diagnostic.range.start.character + 1,
            endLine: diagnostic.range.end.line + 1,
            endCharacter: diagnostic.range.end.character + 1,
            severity: SEVERITY_MAP[diagnostic.severity] ?? 'info',
            message: diagnostic.message,
            code: diagnostic.code,
            source: diagnostic.source,
        };
    }
    isPositionInRange(position, range) {
        if (position.line < range.start.line || position.line > range.end.line)
            return false;
        if (position.line === range.start.line &&
            position.character < range.start.character)
            return false;
        if (position.line === range.end.line &&
            position.character > range.end.character)
            return false;
        return true;
    }
}
exports.LspDiagnosticsProvider = LspDiagnosticsProvider;
