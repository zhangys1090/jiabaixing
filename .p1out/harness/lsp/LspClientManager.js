"use strict";
/**
 * LSP 客户端管理器
 *
 * 管理与多个语言服务器的连接生命周期
 * 负责初始化、关闭、能力协商和文档同步
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILTIN_SERVERS = exports.LspClientManager = void 0;
const events_1 = require("events");
const Logger_1 = require("../../utils/Logger");
const LspTransport_1 = require("./LspTransport");
const types_1 = require("./types");
const BUILTIN_SERVERS = [
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
exports.BUILTIN_SERVERS = BUILTIN_SERVERS;
class LspClientManager extends events_1.EventEmitter {
    constructor() {
        super();
        this.servers = new Map();
        this.workspaceConfig = null;
        this.diagnosticsCache = new Map();
        this.customServers = [];
    }
    static getInstance() {
        if (!LspClientManager.instance) {
            LspClientManager.instance = new LspClientManager();
        }
        return LspClientManager.instance;
    }
    static resetInstance() {
        LspClientManager.instance = null;
    }
    configureWorkspace(config) {
        this.workspaceConfig = config;
    }
    registerServer(config) {
        const existing = this.customServers.find((s) => s.id === config.id);
        if (existing) {
            Object.assign(existing, config);
        }
        else {
            this.customServers.push(config);
        }
    }
    getServerConfig(languageId) {
        const custom = this.customServers.find((s) => s.languages.includes(languageId));
        if (custom)
            return custom;
        return BUILTIN_SERVERS.find((s) => s.languages.includes(languageId));
    }
    getServerConfigById(serverId) {
        const custom = this.customServers.find((s) => s.id === serverId);
        if (custom)
            return custom;
        return BUILTIN_SERVERS.find((s) => s.id === serverId);
    }
    async connect(languageId) {
        const config = this.getServerConfig(languageId);
        if (!config) {
            Logger_1.Logger.warn('LspClientManager', `未找到语言 ${languageId} 对应的服务器配置`);
            return null;
        }
        if (this.servers.has(config.id)) {
            const existing = this.servers.get(config.id);
            if (existing.state.status === 'connected') {
                return config.id;
            }
            await this.disconnectServer(config.id);
        }
        return this.connectServer(config);
    }
    async connectServer(config) {
        const transport = new LspTransport_1.LspTransport();
        const state = {
            serverId: config.id,
            status: 'connecting',
            languages: config.languages,
        };
        const managed = {
            config,
            transport,
            state,
            documentVersions: new Map(),
        };
        this.servers.set(config.id, managed);
        try {
            await transport.start(config.command, config.args, config.env);
            transport.on('notification', (msg) => {
                if (msg.method === 'textDocument/publishDiagnostics') {
                    const params = msg.params;
                    this.diagnosticsCache.set(params.uri, params.diagnostics);
                    this.emit('diagnostics', params);
                }
            });
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
            }));
            managed.capabilities = initResult.capabilities;
            managed.state.status = 'connected';
            transport.sendNotification('initialized', {});
            Logger_1.Logger.info('LspClientManager', `语言服务器 ${config.id} 连接成功`);
            this.emit('connected', {
                serverId: config.id,
                languages: config.languages,
            });
            return config.id;
        }
        catch (error) {
            managed.state.status = 'error';
            managed.state.lastError = error.message;
            Logger_1.Logger.error('LspClientManager', error, `连接语言服务器 ${config.id} 失败`);
            throw error;
        }
    }
    async disconnectServer(serverId) {
        const managed = this.servers.get(serverId);
        if (!managed)
            return;
        try {
            await managed.transport.sendRequest('shutdown');
            managed.transport.sendNotification('exit');
        }
        catch {
            // 服务器可能已关闭
        }
        await managed.transport.stop();
        this.servers.delete(serverId);
        this.emit('disconnected', { serverId });
    }
    async disconnectAll() {
        const ids = Array.from(this.servers.keys());
        await Promise.all(ids.map((id) => this.disconnectServer(id)));
    }
    async openDocument(textDocument) {
        const serverId = await this.connect(textDocument.languageId);
        if (!serverId)
            return;
        const managed = this.servers.get(serverId);
        if (!managed || managed.state.status !== 'connected')
            return;
        managed.documentVersions.set(textDocument.uri, textDocument.version);
        managed.transport.sendNotification('textDocument/didOpen', {
            textDocument,
        });
    }
    async changeDocument(uri, version, text) {
        const managed = this.findServerForUri(uri);
        if (!managed)
            return;
        managed.documentVersions.set(uri, version);
        const syncKind = managed.capabilities?.textDocumentSync ?? types_1.LspTextDocumentSyncKind.Full;
        managed.transport.sendNotification('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: syncKind === types_1.LspTextDocumentSyncKind.Full
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
    async closeDocument(uri) {
        const managed = this.findServerForUri(uri);
        if (!managed)
            return;
        managed.documentVersions.delete(uri);
        managed.transport.sendNotification('textDocument/didClose', {
            textDocument: { uri },
        });
    }
    async getDiagnostics(uri) {
        const cached = this.diagnosticsCache.get(uri);
        if (cached)
            return cached;
        const managed = this.findServerForUri(uri);
        if (!managed || !managed.capabilities?.diagnosticProvider)
            return [];
        try {
            const result = (await managed.transport.sendRequest('textDocument/diagnostic', { textDocument: { uri } }));
            return result.items ?? [];
        }
        catch (error) {
            Logger_1.Logger.error('LspClientManager', error, `获取诊断失败: ${uri}`);
            return [];
        }
    }
    async getCompletion(uri, position) {
        const managed = this.findServerForUri(uri);
        if (!managed || !managed.capabilities?.completionProvider)
            return [];
        try {
            const result = (await managed.transport.sendRequest('textDocument/completion', {
                textDocument: { uri },
                position,
            }));
            return result.items ?? [];
        }
        catch (error) {
            Logger_1.Logger.error('LspClientManager', error, `获取补全失败: ${uri}`);
            return [];
        }
    }
    async getHover(uri, position) {
        const managed = this.findServerForUri(uri);
        if (!managed || !managed.capabilities?.hoverProvider)
            return null;
        try {
            return (await managed.transport.sendRequest('textDocument/hover', {
                textDocument: { uri },
                position,
            }));
        }
        catch (error) {
            Logger_1.Logger.error('LspClientManager', error, `获取悬停信息失败: ${uri}`);
            return null;
        }
    }
    async getDocumentSymbols(uri) {
        const managed = this.findServerForUri(uri);
        if (!managed || !managed.capabilities?.documentSymbolProvider)
            return [];
        try {
            return (await managed.transport.sendRequest('textDocument/documentSymbol', { textDocument: { uri } }));
        }
        catch (error) {
            Logger_1.Logger.error('LspClientManager', error, `获取文档符号失败: ${uri}`);
            return [];
        }
    }
    async getDefinition(uri, position) {
        const managed = this.findServerForUri(uri);
        if (!managed || !managed.capabilities?.definitionProvider)
            return [];
        try {
            const result = await managed.transport.sendRequest('textDocument/definition', {
                textDocument: { uri },
                position,
            });
            if (Array.isArray(result))
                return result;
            if (result && typeof result === 'object' && 'uri' in result)
                return [result];
            return [];
        }
        catch (error) {
            Logger_1.Logger.error('LspClientManager', error, `获取定义失败: ${uri}`);
            return [];
        }
    }
    async getReferences(uri, position) {
        const managed = this.findServerForUri(uri);
        if (!managed || !managed.capabilities?.referencesProvider)
            return [];
        try {
            return (await managed.transport.sendRequest('textDocument/references', {
                textDocument: { uri },
                position,
                context: { includeDeclaration: true },
            }));
        }
        catch (error) {
            Logger_1.Logger.error('LspClientManager', error, `获取引用失败: ${uri}`);
            return [];
        }
    }
    getConnectionStates() {
        return Array.from(this.servers.values()).map((m) => ({ ...m.state }));
    }
    getSupportedLanguages() {
        const languages = new Set();
        for (const server of [...BUILTIN_SERVERS, ...this.customServers]) {
            for (const lang of server.languages) {
                languages.add(lang);
            }
        }
        return Array.from(languages);
    }
    getServerCapabilities(serverId) {
        return this.servers.get(serverId)?.capabilities;
    }
    getAllDiagnostics() {
        return new Map(this.diagnosticsCache);
    }
    clearDiagnosticsCache(uri) {
        if (uri) {
            this.diagnosticsCache.delete(uri);
        }
        else {
            this.diagnosticsCache.clear();
        }
    }
    findServerForUri(uri) {
        const ext = this.extractExtension(uri);
        const languageId = this.extensionToLanguageId(ext);
        for (const managed of this.servers.values()) {
            if (managed.state.status === 'connected' &&
                managed.config.languages.includes(languageId)) {
                return managed;
            }
        }
        return undefined;
    }
    extractExtension(uri) {
        const match = uri.match(/\.([^.?#]+)(?:[?#]|$)/);
        return match ? match[1].toLowerCase() : '';
    }
    extensionToLanguageId(ext) {
        const mapping = {
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
    async healthCheck() {
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
    static get BUILTIN_SERVERS() {
        return BUILTIN_SERVERS;
    }
}
exports.LspClientManager = LspClientManager;
LspClientManager.instance = null;
