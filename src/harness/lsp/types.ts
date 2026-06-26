/**
 * LSP 集成层类型定义
 *
 * 基于 Language Server Protocol 3.17 规范
 * 使用 JSON-RPC 2.0 与语言服务器通信
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export enum LspDiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface LspDiagnostic {
  range: LspRange;
  severity: LspDiagnosticSeverity;
  code?: number | string;
  source?: string;
  message: string;
  relatedInformation?: Array<{
    location: LspLocation;
    message: string;
  }>;
}

export interface LspCompletionItem {
  label: string;
  kind?: LspCompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
}

export enum LspCompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 6,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  File = 17,
  Folder = 19,
}

export interface LspHover {
  contents: Array<{
    language?: string;
    value: string;
  }>;
  range?: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  kind: LspSymbolKind;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export enum LspSymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
}

export interface LspServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  languages: string[];
  initializationOptions?: Record<string, unknown>;
}

export interface LspWorkspaceConfig {
  rootUri: string;
  folders: Array<{
    uri: string;
    name?: string;
  }>;
}

export interface LspConnectionState {
  serverId: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  languages: string[];
  lastError?: string;
}

export interface LspTextDocumentIdentifier {
  uri: string;
}

export interface LspVersionedTextDocumentIdentifier extends LspTextDocumentIdentifier {
  version: number;
}

export interface LspTextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export enum LspTextDocumentSyncKind {
  None = 0,
  Full = 1,
  Incremental = 2,
}

export interface LspServerCapabilities {
  completionProvider?: {
    triggerCharacters?: string[];
    resolveProvider?: boolean;
  };
  hoverProvider?: boolean;
  diagnosticProvider?: {
    identifier?: string;
    interFileDependencies: boolean;
    workspaceDiagnostics: boolean;
  };
  documentSymbolProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  textDocumentSync?: LspTextDocumentSyncKind;
}

export interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

export type LspNotificationHandler<T> = (params: T) => void;
