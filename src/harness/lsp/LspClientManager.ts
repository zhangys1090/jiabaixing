/**
 * LSP 客户端管理器
 *
 * 管理与多个语言服务器的连接生命周期
 * 负责初始化、关闭、能力协商和文档同步
 */

import { EventEmitter } from 'events';
import { Logger } from '../../utils/Logger';
import { LspTransport } from './LspTransport';
import type {
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
    LspVersionedTextDocumentIdentifier,
    LspWorkspaceConfig,
} from './types';
import { LspTextDocumentSyncKind } from './types';

interface ManagedServer {
  config: LspServerConfig;
  transport: LspTransport;
  capabilities?: LspServerCapabilities;
  state: LspConnectionState;
  documentVersions: Map<string, number>;
}

const BUILTIN_SERVERS: LspServerConfig[] = [
  {
    id: 'typescript',
    command: 'npx',
    args: ['typescript-language-server', '--stdio'],
    languages: [
      'typescript',
      'typescriptreact',
      'javascript',
      'javascriptreact',
    ],
  },
  {
    id: 'python',
    command: 'pylsp',
    args: [],
    languages: ['python'],
  },
  {
    id: 'golang',
    command: 'gopls',
    args: [],
    languages: ['go'],
  },
  {
    id: 'rust',
    command: 'rust-analyzer',
    args: [],
    languages: ['rust'],
  },
  {
    id: 'css',
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    languages: ['css', 'scss', 'less'],
  },
  {
    id: 'html',
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    languages: ['html'],
  },
  {
    id: 'json',
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    languages: ['json'],
  },
];

export class LspClientManager extends EventEmitter {
  private static instance: LspClientManager | null = null;
  private servers = new Map<string, ManagedServer>();
  private workspaceConfig: LspWorkspaceConfig | null = null;
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private readonly customServers: LspServerConfig[] = [];

  private constructor() {
    super();
  }

  static create(): LspClientManager {
    return new LspClientManager();
  }

  static getInstance(): LspClientManager {
    if (!LspClientManager.instance) {
      LspClientManager.instance = new LspClientManager();
    }
    return LspClientManager.instance;
  }

  static resetInstance(): void {
    LspClientManager.instance = null;
  }

  configureWorkspace(config: LspWorkspaceConfig): void {
    this.workspaceConfig = config;
  }

  registerServer(config: LspServerConfig): void {
    const existing = this.customServers.find((s) => s.id === config.id);
    if (existing) {
      Object.assign(existing, config);
    } else {
      this.customServers.push(config);
    }
  }

  private getServerConfig(languageId: string): LspServerConfig | undefined {
    const custom = this.customServers.find((s) =>
      s.languages.includes(languageId)
    );
    if (custom) return custom;
    return BUILTIN_SERVERS.find((s) => s.languages.includes(languageId));
  }

  private getServerConfigById(serverId: string): LspServerConfig | undefined {
    const custom = this.customServers.find((s) => s.id === serverId);
    if (custom) return custom;
    return BUILTIN_SERVERS.find((s) => s.id === serverId);
  }

  async connect(languageId: string): Promise<string | null> {
    const config = this.getServerConfig(languageId);
    if (!config) {
      Logger.warn(
        'LspClientManager',
        `未找到语言 ${languageId} 对应的服务器配置`
      );
      return null;
    }

    if (this.servers.has(config.id)) {
      const existing = this.servers.get(config.id)!;
      if (existing.state.status === 'connected') {
        return config.id;
      }
      await this.disconnectServer(config.id);
    }

    return this.connectServer(config);
  }

  async connectServer(config: LspServerConfig): Promise<string> {
    const transport = new LspTransport();
    const state: LspConnectionState = {
      serverId: config.id,
      status: 'connecting',
      languages: config.languages,
    };

    const managed: ManagedServer = {
      config,
      transport,
      state,
      documentVersions: new Map(),
    };

    this.servers.set(config.id, managed);

    try {
      await transport.start(config.command, config.args, config.env);

      transport.on(
        'notification',
        (msg: { method: string; params?: unknown }) => {
          if (msg.method === 'textDocument/publishDiagnostics') {
            const params = msg.params as LspPublishDiagnosticsParams;
            this.diagnosticsCache.set(params.uri, params.diagnostics);
            this.emit('diagnostics', params);
          }
        }
      );

      const rootUri = this.workspaceConfig?.rootUri ?? '';
      const workspaceFolders = this.workspaceConfig?.folders ?? [];

      const initResult = (await transport.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            publishDiagnostics: {
              relatedInformation: true,
            },
            completion: {
              completionItem: {
                snippetSupport: false,
              },
            },
            hover: {
              contentFormat: ['plaintext', 'markdown'],
            },
          },
        },
        workspaceFolders,
      })) as { capabilities?: LspServerCapabilities };

      managed.capabilities = initResult.capabilities;
      managed.state.status = 'connected';

      transport.sendNotification('initialized', {});

      Logger.info('LspClientManager', `语言服务器 ${config.id} 连接成功`);

      this.emit('connected', {
        serverId: config.id,
        languages: config.languages,
      });

      return config.id;
    } catch (error) {
      managed.state.status = 'error';
      managed.state.lastError = (error as Error).message;
      Logger.error(
        'LspClientManager',
        error as Error,
        `连接语言服务器 ${config.id} 失败`
      );
      throw error;
    }
  }

  async disconnectServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) return;

    try {
      await managed.transport.sendRequest('shutdown');
      managed.transport.sendNotification('exit');
    } catch {
      // 服务器可能已关闭
    }

    await managed.transport.stop();
    this.servers.delete(serverId);
    this.emit('disconnected', { serverId });
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map((id) => this.disconnectServer(id)));
  }

  async openDocument(textDocument: LspTextDocumentItem): Promise<void> {
    const serverId = await this.connect(textDocument.languageId);
    if (!serverId) return;

    const managed = this.servers.get(serverId);
    if (!managed || managed.state.status !== 'connected') return;

    managed.documentVersions.set(textDocument.uri, textDocument.version);

    managed.transport.sendNotification('textDocument/didOpen', {
      textDocument,
    });
  }

  async changeDocument(
    uri: string,
    version: number,
    text: string
  ): Promise<void> {
    const managed = this.findServerForUri(uri);
    if (!managed) return;

    managed.documentVersions.set(uri, version);

    const syncKind =
      managed.capabilities?.textDocumentSync ?? LspTextDocumentSyncKind.Full;

    managed.transport.sendNotification('textDocument/didChange', {
      textDocument: { uri, version } as LspVersionedTextDocumentIdentifier,
      contentChanges:
        syncKind === LspTextDocumentSyncKind.Full
          ? [{ text }]
          : [
              {
                text,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 999999, character: 999999 },
                },
              },
            ],
    });
  }

  async closeDocument(uri: string): Promise<void> {
    const managed = this.findServerForUri(uri);
    if (!managed) return;

    managed.documentVersions.delete(uri);
    managed.transport.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  async getDiagnostics(uri: string): Promise<LspDiagnostic[]> {
    const cached = this.diagnosticsCache.get(uri);
    if (cached) return cached;

    const managed = this.findServerForUri(uri);
    if (!managed || !managed.capabilities?.diagnosticProvider) return [];

    try {
      const result = (await managed.transport.sendRequest(
        'textDocument/diagnostic',
        { textDocument: { uri } }
      )) as { items?: LspDiagnostic[] };

      return result.items ?? [];
    } catch (error) {
      Logger.error('LspClientManager', error as Error, `获取诊断失败: ${uri}`);
      return [];
    }
  }

  async getCompletion(
    uri: string,
    position: LspPosition
  ): Promise<
    Array<{
      label: string;
      kind?: number;
      detail?: string;
      documentation?: string;
      insertText?: string;
    }>
  > {
    const managed = this.findServerForUri(uri);
    if (!managed || !managed.capabilities?.completionProvider) return [];

    try {
      const result = (await managed.transport.sendRequest(
        'textDocument/completion',
        {
          textDocument: { uri },
          position,
        }
      )) as {
        items?: Array<{
          label: string;
          kind?: number;
          detail?: string;
          documentation?: string;
          insertText?: string;
        }>;
      };

      return result.items ?? [];
    } catch (error) {
      Logger.error('LspClientManager', error as Error, `获取补全失败: ${uri}`);
      return [];
    }
  }

  async getHover(uri: string, position: LspPosition): Promise<LspHover | null> {
    const managed = this.findServerForUri(uri);
    if (!managed || !managed.capabilities?.hoverProvider) return null;

    try {
      return (await managed.transport.sendRequest('textDocument/hover', {
        textDocument: { uri },
        position,
      })) as LspHover | null;
    } catch (error) {
      Logger.error(
        'LspClientManager',
        error as Error,
        `获取悬停信息失败: ${uri}`
      );
      return null;
    }
  }

  async getDocumentSymbols(uri: string): Promise<LspDocumentSymbol[]> {
    const managed = this.findServerForUri(uri);
    if (!managed || !managed.capabilities?.documentSymbolProvider) return [];

    try {
      return (await managed.transport.sendRequest(
        'textDocument/documentSymbol',
        { textDocument: { uri } }
      )) as LspDocumentSymbol[];
    } catch (error) {
      Logger.error(
        'LspClientManager',
        error as Error,
        `获取文档符号失败: ${uri}`
      );
      return [];
    }
  }

  async getDefinition(
    uri: string,
    position: LspPosition
  ): Promise<LspLocation[]> {
    const managed = this.findServerForUri(uri);
    if (!managed || !managed.capabilities?.definitionProvider) return [];

    try {
      const result = await managed.transport.sendRequest(
        'textDocument/definition',
        {
          textDocument: { uri },
          position,
        }
      );
      if (Array.isArray(result)) return result as LspLocation[];
      if (result && typeof result === 'object' && 'uri' in result)
        return [result as LspLocation];
      return [];
    } catch (error) {
      Logger.error('LspClientManager', error as Error, `获取定义失败: ${uri}`);
      return [];
    }
  }

  async getReferences(
    uri: string,
    position: LspPosition
  ): Promise<LspLocation[]> {
    const managed = this.findServerForUri(uri);
    if (!managed || !managed.capabilities?.referencesProvider) return [];

    try {
      return (await managed.transport.sendRequest('textDocument/references', {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      })) as LspLocation[];
    } catch (error) {
      Logger.error('LspClientManager', error as Error, `获取引用失败: ${uri}`);
      return [];
    }
  }

  getConnectionStates(): LspConnectionState[] {
    return Array.from(this.servers.values()).map((m) => ({ ...m.state }));
  }

  getSupportedLanguages(): string[] {
    const languages = new Set<string>();
    for (const server of [...BUILTIN_SERVERS, ...this.customServers]) {
      for (const lang of server.languages) {
        languages.add(lang);
      }
    }
    return Array.from(languages);
  }

  getServerCapabilities(serverId: string): LspServerCapabilities | undefined {
    return this.servers.get(serverId)?.capabilities;
  }

  getAllDiagnostics(): Map<string, LspDiagnostic[]> {
    return new Map(this.diagnosticsCache);
  }

  clearDiagnosticsCache(uri?: string): void {
    if (uri) {
      this.diagnosticsCache.delete(uri);
    } else {
      this.diagnosticsCache.clear();
    }
  }

  private findServerForUri(uri: string): ManagedServer | undefined {
    const ext = this.extractExtension(uri);
    const languageId = this.extensionToLanguageId(ext);

    for (const managed of this.servers.values()) {
      if (
        managed.state.status === 'connected' &&
        managed.config.languages.includes(languageId)
      ) {
        return managed;
      }
    }
    return undefined;
  }

  private extractExtension(uri: string): string {
    const match = uri.match(/\.([^.?#]+)(?:[?#]|$)/);
    return match ? match[1].toLowerCase() : '';
  }

  extensionToLanguageId(ext: string): string {
    const mapping: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      go: 'go',
      rs: 'rust',
      css: 'css',
      scss: 'scss',
      less: 'less',
      html: 'html',
      htm: 'html',
      json: 'json',
    };
    return mapping[ext] ?? ext;
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    servers: Array<{
      id: string;
      status: string;
      languages: string[];
    }>;
  }> {
    const serverStatuses = Array.from(this.servers.values()).map((m) => ({
      id: m.config.id,
      status: m.state.status,
      languages: m.config.languages,
    }));

    return {
      healthy: serverStatuses.every((s) => s.status === 'connected'),
      servers: serverStatuses,
    };
  }

  static get BUILTIN_SERVERS(): readonly LspServerConfig[] {
    return BUILTIN_SERVERS;
  }
}

export { BUILTIN_SERVERS };
