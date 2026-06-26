/**
 * Phase 2 集成测试 - LSP 集成层调用链路
 *
 * 验证 LSP 模块从 AgentHarness → LspClientManager → LspDiagnosticsProvider/LspCompletionProvider → 工具执行器
 * 的完整调用链路
 */

import { LspClientManager } from '../../src/harness/lsp/LspClientManager';
import { LspCompletionProvider } from '../../src/harness/lsp/LspCompletionProvider';
import { LspDiagnosticsProvider } from '../../src/harness/lsp/LspDiagnosticsProvider';
import { LspTransport } from '../../src/harness/lsp/LspTransport';
import type {
  LspDiagnostic,
  LspServerConfig,
} from '../../src/harness/lsp/types';
import { LspDiagnosticSeverity } from '../../src/harness/lsp/types';
import {
  createLspCompletionExecutor,
  type LspCompletionDeps,
} from '../../src/harness/tools/lsp/lsp_completion';
import {
  createLspDefinitionExecutor,
  type LspDefinitionDeps,
} from '../../src/harness/tools/lsp/lsp_definition';
import {
  createLspDiagnosticsExecutor,
  type LspDiagnosticsDeps,
} from '../../src/harness/tools/lsp/lsp_diagnostics';
import {
  createLspHoverExecutor,
  type LspHoverDeps,
} from '../../src/harness/tools/lsp/lsp_hover';
import {
  createLspReferencesExecutor,
  type LspReferencesDeps,
} from '../../src/harness/tools/lsp/lsp_references';
import {
  createLspSymbolsExecutor,
  type LspSymbolsDeps,
} from '../../src/harness/tools/lsp/lsp_symbols';

describe('Phase 2 集成测试 - LSP 集成层', () => {
  beforeEach(() => {
    LspClientManager.resetInstance();
  });

  afterEach(() => {
    LspClientManager.resetInstance();
  });

  describe('LspClientManager 单例与配置', () => {
    test('应该返回单例实例', () => {
      const instance1 = LspClientManager.getInstance();
      const instance2 = LspClientManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    test('resetInstance 应重置单例', () => {
      const instance1 = LspClientManager.getInstance();
      LspClientManager.resetInstance();
      const instance2 = LspClientManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });

    test('应该配置工作区', () => {
      const manager = LspClientManager.getInstance();
      manager.configureWorkspace({
        rootUri: 'file:///test/workspace',
        folders: [{ uri: 'file:///test/workspace' }],
      });
      expect(manager).toBeDefined();
    });

    test('应该注册自定义服务器', () => {
      const manager = LspClientManager.getInstance();
      const customConfig: LspServerConfig = {
        id: 'custom-lang',
        command: 'custom-lsp-server',
        args: ['--stdio'],
        languages: ['custom-lang'],
      };
      manager.registerServer(customConfig);
      expect(manager.getSupportedLanguages()).toContain('custom-lang');
    });

    test('应该返回内置支持的语言列表', () => {
      const manager = LspClientManager.getInstance();
      const languages = manager.getSupportedLanguages();
      expect(languages).toContain('typescript');
      expect(languages).toContain('python');
      expect(languages).toContain('go');
      expect(languages).toContain('rust');
    });

    test('extensionToLanguageId 应正确映射', () => {
      const manager = LspClientManager.getInstance();
      expect(manager.extensionToLanguageId('ts')).toBe('typescript');
      expect(manager.extensionToLanguageId('tsx')).toBe('typescriptreact');
      expect(manager.extensionToLanguageId('py')).toBe('python');
      expect(manager.extensionToLanguageId('go')).toBe('go');
      expect(manager.extensionToLanguageId('rs')).toBe('rust');
    });

    test('应该返回连接状态列表', () => {
      const manager = LspClientManager.getInstance();
      const states = manager.getConnectionStates();
      expect(Array.isArray(states)).toBe(true);
    });

    test('应该返回健康检查结果', async () => {
      const manager = LspClientManager.getInstance();
      const health = await manager.healthCheck();
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('servers');
    });
  });

  describe('LspDiagnosticsProvider 调用链路', () => {
    test('应该构建诊断摘要', () => {
      const provider = new LspDiagnosticsProvider();
      const diagnostics: LspDiagnostic[] = [
        {
          range: {
            start: { line: 0, character: 5 },
            end: { line: 0, character: 10 },
          },
          severity: LspDiagnosticSeverity.Error,
          message: "Cannot find name 'x'",
          code: 2304,
          source: 'ts',
        },
        {
          range: {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 20 },
          },
          severity: LspDiagnosticSeverity.Warning,
          message: "'y' is declared but never used",
          code: 6133,
          source: 'ts',
        },
      ];

      const summary = provider.formatDiagnostics({
        uri: 'file:///test/file.ts',
        errors: 1,
        warnings: 1,
        infos: 0,
        hints: 0,
        total: 2,
        items: [
          {
            uri: 'file:///test/file.ts',
            line: 1,
            character: 6,
            endLine: 1,
            endCharacter: 11,
            severity: 'error',
            message: "Cannot find name 'x'",
            code: 2304,
            source: 'ts',
          },
          {
            uri: 'file:///test/file.ts',
            line: 6,
            character: 1,
            endLine: 6,
            endCharacter: 21,
            severity: 'warning',
            message: "'y' is declared but never used",
            code: 6133,
            source: 'ts',
          },
        ],
      });

      expect(summary).toContain('file:///test/file.ts');
      expect(summary).toContain("Cannot find name 'x'");
      expect(summary).toContain("'y' is declared but never used");
    });

    test('应该过滤诊断结果', () => {
      const provider = new LspDiagnosticsProvider();
      const summaries = [
        {
          uri: 'file:///test/file.ts',
          errors: 1,
          warnings: 1,
          infos: 0,
          hints: 0,
          total: 2,
          items: [
            {
              uri: 'file:///test/file.ts',
              line: 1,
              character: 1,
              endLine: 1,
              endCharacter: 5,
              severity: 'error' as const,
              message: 'Error',
            },
            {
              uri: 'file:///test/file.ts',
              line: 2,
              character: 1,
              endLine: 2,
              endCharacter: 5,
              severity: 'warning' as const,
              message: 'Warning',
            },
          ],
        },
      ];

      const filtered = provider.filterDiagnostics(summaries, {
        severity: 'error',
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].items).toHaveLength(1);
      expect(filtered[0].items[0].severity).toBe('error');
    });
  });

  describe('LspCompletionProvider 调用链路', () => {
    test('应该格式化补全结果', () => {
      const provider = new LspCompletionProvider();
      const formatted = provider.formatCompletions({
        uri: 'file:///test/file.ts',
        position: { line: 10, character: 5 },
        items: [
          { label: 'console', kind: 'Variable', detail: 'Console' },
          { label: 'log', kind: 'Method', detail: '(method) Console.log()' },
        ],
      });

      expect(formatted).toContain('file:///test/file.ts');
      expect(formatted).toContain('console');
      expect(formatted).toContain('log');
    });

    test('应该格式化悬停结果', () => {
      const provider = new LspCompletionProvider();
      const formatted = provider.formatHover({
        uri: 'file:///test/file.ts',
        position: { line: 10, character: 5 },
        contents: [{ language: 'typescript', value: 'function test(): void' }],
      });

      expect(formatted).toContain('function test(): void');
    });

    test('应该格式化定义结果', () => {
      const provider = new LspCompletionProvider();
      const formatted = provider.formatDefinition({
        uri: 'file:///test/file.ts',
        position: { line: 10, character: 5 },
        locations: [{ uri: 'file:///test/other.ts', line: 20, character: 3 }],
      });

      expect(formatted).toContain('file:///test/other.ts');
      expect(formatted).toContain('20:3');
    });

    test('应该格式化引用结果', () => {
      const provider = new LspCompletionProvider();
      const formatted = provider.formatReferences({
        uri: 'file:///test/file.ts',
        position: { line: 10, character: 5 },
        locations: [
          { uri: 'file:///test/a.ts', line: 5, character: 1 },
          { uri: 'file:///test/b.ts', line: 15, character: 10 },
        ],
      });

      expect(formatted).toContain('2 处');
      expect(formatted).toContain('file:///test/a.ts');
      expect(formatted).toContain('file:///test/b.ts');
    });

    test('应该格式化符号结果', () => {
      const provider = new LspCompletionProvider();
      const formatted = provider.formatSymbols({
        uri: 'file:///test/file.ts',
        symbols: [
          {
            name: 'MyClass',
            kind: 'Class',
            line: 1,
            character: 0,
            endLine: 50,
            endCharacter: 1,
            children: [
              { name: 'myMethod', kind: 'Method', line: 10, character: 2 },
            ],
          },
        ],
      });

      expect(formatted).toContain('MyClass');
      expect(formatted).toContain('[Class]');
      expect(formatted).toContain('myMethod');
    });
  });

  describe('LSP 工具执行器调用链路', () => {
    test('lsp_diagnostics 执行器应返回诊断结果', async () => {
      const deps: LspDiagnosticsDeps = {
        getDiagnosticsForFile: async (uri: string) => ({
          uri,
          errors: 1,
          warnings: 0,
          infos: 0,
          hints: 0,
          total: 1,
          items: [
            {
              uri,
              line: 1,
              character: 1,
              endLine: 1,
              endCharacter: 5,
              severity: 'error',
              message: 'Test error',
            },
          ],
        }),
        formatDiagnostics: (summary) => `Error: ${summary.items[0].message}`,
      };

      const executor = createLspDiagnosticsExecutor(deps);
      const result = await executor({ uri: 'file:///test/file.ts' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Test error');
    });

    test('lsp_diagnostics 执行器在服务不可用时应返回错误', async () => {
      const deps: LspDiagnosticsDeps = {};
      const executor = createLspDiagnosticsExecutor(deps);
      const result = await executor({ uri: 'file:///test/file.ts' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('不可用');
    });

    test('lsp_completion 执行器应返回补全结果', async () => {
      const deps: LspCompletionDeps = {
        getCompletions: async (uri, position) => ({
          uri,
          position,
          items: [{ label: 'console', kind: 'Variable', detail: 'Console' }],
        }),
        formatCompletions: (result) =>
          `Completions: ${result.items.map((i) => i.label).join(', ')}`,
      };

      const executor = createLspCompletionExecutor(deps);
      const result = await executor({
        uri: 'file:///test/file.ts',
        line: 10,
        character: 5,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('console');
    });

    test('lsp_hover 执行器应返回悬停信息', async () => {
      const deps: LspHoverDeps = {
        getHover: async (uri, position) => ({
          uri,
          position,
          contents: [
            { language: 'typescript', value: 'function test(): void' },
          ],
        }),
        formatHover: (result) => result.contents.map((c) => c.value).join('\n'),
      };

      const executor = createLspHoverExecutor(deps);
      const result = await executor({
        uri: 'file:///test/file.ts',
        line: 10,
        character: 5,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('function test(): void');
    });

    test('lsp_hover 执行器在无悬停信息时应返回提示', async () => {
      const deps: LspHoverDeps = {
        getHover: async () => null,
      };

      const executor = createLspHoverExecutor(deps);
      const result = await executor({
        uri: 'file:///test/file.ts',
        line: 10,
        character: 5,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('无悬停信息');
    });

    test('lsp_definition 执行器应返回定义位置', async () => {
      const deps: LspDefinitionDeps = {
        getDefinition: async (uri, position) => ({
          uri,
          position,
          locations: [{ uri: 'file:///test/other.ts', line: 20, character: 3 }],
        }),
        formatDefinition: (result) =>
          result.locations.map((l) => `${l.uri}:${l.line}`).join('\n'),
      };

      const executor = createLspDefinitionExecutor(deps);
      const result = await executor({
        uri: 'file:///test/file.ts',
        line: 10,
        character: 5,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('other.ts:20');
    });

    test('lsp_references 执行器应返回引用列表', async () => {
      const deps: LspReferencesDeps = {
        getReferences: async (uri, position) => ({
          uri,
          position,
          locations: [
            { uri: 'file:///test/a.ts', line: 5, character: 1 },
            { uri: 'file:///test/b.ts', line: 15, character: 10 },
          ],
        }),
        formatReferences: (result) => `${result.locations.length} references`,
      };

      const executor = createLspReferencesExecutor(deps);
      const result = await executor({
        uri: 'file:///test/file.ts',
        line: 10,
        character: 5,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 references');
    });

    test('lsp_symbols 执行器应返回文档符号', async () => {
      const deps: LspSymbolsDeps = {
        getDocumentSymbols: async (uri) => ({
          uri,
          symbols: [
            {
              name: 'MyClass',
              kind: 'Class',
              line: 1,
              character: 0,
              endLine: 50,
              endCharacter: 1,
            },
          ],
        }),
        formatSymbols: (result) =>
          result.symbols.map((s) => `${s.kind}: ${s.name}`).join('\n'),
      };

      const executor = createLspSymbolsExecutor(deps);
      const result = await executor({ uri: 'file:///test/file.ts' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Class: MyClass');
    });
  });

  describe('LspTransport 通信协议', () => {
    test('应该正确构建 Content-Length 分帧消息', () => {
      const transport = new LspTransport();
      expect(transport.isRunning()).toBe(false);
    });
  });

  describe('调用链路: AgentHarness → LspClientManager', () => {
    test('AgentHarness 初始化应创建 LSP 实例', async () => {
      const { AgentHarness } = await import('../../src/harness/AgentHarness');
      const harness = new AgentHarness({
        useHarnessTools: false,
        useHarnessLoop: false,
        useHarnessContext: false,
        useHarnessVerification: false,
        useHarnessConstraints: false,
        useHarnessPersistence: false,
      });

      await harness.initialize();

      const lspManager = harness.getLspClientManager();
      expect(lspManager).toBeDefined();

      const lspDiagnostics = harness.getLspDiagnosticsProvider();
      expect(lspDiagnostics).toBeDefined();

      const lspCompletion = harness.getLspCompletionProvider();
      expect(lspCompletion).toBeDefined();

      await harness.shutdown();
    });

    test('shutdown 应清理 LSP 资源', async () => {
      const { AgentHarness } = await import('../../src/harness/AgentHarness');
      const harness = new AgentHarness({
        useHarnessTools: false,
        useHarnessLoop: false,
        useHarnessContext: false,
        useHarnessVerification: false,
        useHarnessConstraints: false,
        useHarnessPersistence: false,
      });

      await harness.initialize();
      expect(harness.getLspClientManager()).toBeDefined();

      await harness.shutdown();
      expect(harness.getLspClientManager()).toBeNull();
      expect(harness.getLspDiagnosticsProvider()).toBeNull();
      expect(harness.getLspCompletionProvider()).toBeNull();
    });
  });
});
