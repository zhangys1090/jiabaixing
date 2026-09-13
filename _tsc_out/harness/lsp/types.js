"use strict";
/**
 * LSP 集成层类型定义
 *
 * 基于 Language Server Protocol 3.17 规范
 * 使用 JSON-RPC 2.0 与语言服务器通信
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LspTextDocumentSyncKind = exports.LspSymbolKind = exports.LspCompletionItemKind = exports.LspDiagnosticSeverity = void 0;
var LspDiagnosticSeverity;
(function (LspDiagnosticSeverity) {
    LspDiagnosticSeverity[LspDiagnosticSeverity["Error"] = 1] = "Error";
    LspDiagnosticSeverity[LspDiagnosticSeverity["Warning"] = 2] = "Warning";
    LspDiagnosticSeverity[LspDiagnosticSeverity["Information"] = 3] = "Information";
    LspDiagnosticSeverity[LspDiagnosticSeverity["Hint"] = 4] = "Hint";
})(LspDiagnosticSeverity || (exports.LspDiagnosticSeverity = LspDiagnosticSeverity = {}));
var LspCompletionItemKind;
(function (LspCompletionItemKind) {
    LspCompletionItemKind[LspCompletionItemKind["Text"] = 1] = "Text";
    LspCompletionItemKind[LspCompletionItemKind["Method"] = 2] = "Method";
    LspCompletionItemKind[LspCompletionItemKind["Function"] = 3] = "Function";
    LspCompletionItemKind[LspCompletionItemKind["Constructor"] = 6] = "Constructor";
    LspCompletionItemKind[LspCompletionItemKind["Field"] = 5] = "Field";
    LspCompletionItemKind[LspCompletionItemKind["Variable"] = 6] = "Variable";
    LspCompletionItemKind[LspCompletionItemKind["Class"] = 7] = "Class";
    LspCompletionItemKind[LspCompletionItemKind["Interface"] = 8] = "Interface";
    LspCompletionItemKind[LspCompletionItemKind["Module"] = 9] = "Module";
    LspCompletionItemKind[LspCompletionItemKind["Property"] = 10] = "Property";
    LspCompletionItemKind[LspCompletionItemKind["Enum"] = 13] = "Enum";
    LspCompletionItemKind[LspCompletionItemKind["Keyword"] = 14] = "Keyword";
    LspCompletionItemKind[LspCompletionItemKind["Snippet"] = 15] = "Snippet";
    LspCompletionItemKind[LspCompletionItemKind["File"] = 17] = "File";
    LspCompletionItemKind[LspCompletionItemKind["Folder"] = 19] = "Folder";
})(LspCompletionItemKind || (exports.LspCompletionItemKind = LspCompletionItemKind = {}));
var LspSymbolKind;
(function (LspSymbolKind) {
    LspSymbolKind[LspSymbolKind["File"] = 1] = "File";
    LspSymbolKind[LspSymbolKind["Module"] = 2] = "Module";
    LspSymbolKind[LspSymbolKind["Namespace"] = 3] = "Namespace";
    LspSymbolKind[LspSymbolKind["Package"] = 4] = "Package";
    LspSymbolKind[LspSymbolKind["Class"] = 5] = "Class";
    LspSymbolKind[LspSymbolKind["Method"] = 6] = "Method";
    LspSymbolKind[LspSymbolKind["Property"] = 7] = "Property";
    LspSymbolKind[LspSymbolKind["Field"] = 8] = "Field";
    LspSymbolKind[LspSymbolKind["Constructor"] = 9] = "Constructor";
    LspSymbolKind[LspSymbolKind["Enum"] = 10] = "Enum";
    LspSymbolKind[LspSymbolKind["Interface"] = 11] = "Interface";
    LspSymbolKind[LspSymbolKind["Function"] = 12] = "Function";
    LspSymbolKind[LspSymbolKind["Variable"] = 13] = "Variable";
    LspSymbolKind[LspSymbolKind["Constant"] = 14] = "Constant";
})(LspSymbolKind || (exports.LspSymbolKind = LspSymbolKind = {}));
var LspTextDocumentSyncKind;
(function (LspTextDocumentSyncKind) {
    LspTextDocumentSyncKind[LspTextDocumentSyncKind["None"] = 0] = "None";
    LspTextDocumentSyncKind[LspTextDocumentSyncKind["Full"] = 1] = "Full";
    LspTextDocumentSyncKind[LspTextDocumentSyncKind["Incremental"] = 2] = "Incremental";
})(LspTextDocumentSyncKind || (exports.LspTextDocumentSyncKind = LspTextDocumentSyncKind = {}));
