/**
 * ToolRegistry 统一执行包装层 —— P2 第4轮能力协同测试
 * (C1 结果缓存接线 / C3 流式截断 / D1-D4 能力协同)
 *
 * 覆盖（镜像 .p2_verify/verify.cjs 的 19 项运行时断言）:
 *  - C1: 幂等外部工具(NETWORK/FILE/MEMORY)经 ToolCallGuard 接入统一结果缓存，二次同参命中不重执行。
 *  - C3: 包装层输出截断(默认 ≤8000 字符)，填充 metadata.truncation，避免撑爆上下文窗口。
 *  - D4: 每次工具执行经 recordCapability 激活此前零调用的 CapabilityMetrics(按工具类别记录)。
 *  - D2: 认知类工具完成后经 EventBus.emit('cognition_result', ...) 回灌认知总线。
 *  - 负向: 非幂等工具不进入缓存，每次都执行。
 *  - D1: knowledge_query 记忆召回不足时自动降级 web_search 并回填记忆(RAG 闭环)；无 webSearch 时诚实返回未找到。
 *  - D3: 代码生成/修复物经共享安全扫描中间件 scanGeneratedCode 检测硬编码密钥，写入 metadata。
 *
 * 注：本地 node_modules 损坏时 jest 无法运行，可用 .p2_verify/verify.cjs（tsc 转译 + Module._load 桩）
 * 做真实运行时验证；本文件为 CI 门禁镜像。
 */
import { ToolRegistry } from '../../../src/harness/tools/registry/ToolRegistry';
import type { ToolCategory, ToolContext, ToolResult } from '../../../src/harness/types';
import { capMetrics } from '../../../src/monitoring/CapabilityMetrics';
import { EventBus } from '../../../src/shared/EventBus';
import { createKnowledgeQueryExecutor } from '../../../src/harness/tools/memory/knowledge_query';
import { createCodeFixExecutor } from '../../../src/harness/tools/code/code_fix';
import { scanGeneratedCode } from '../../../src/harness/tools/code/codeShared';

function ctx(meta: Record<string, unknown> = {}): ToolContext {
  return { permissions: new Set(), metadata: meta, userId: 'u1', traceId: 't1' } as ToolContext;
}
function def(name: string, category: ToolCategory, idempotent = false) {
  return {
    name,
    description: name,
    parameters: {},
    requiredParams: [],
    requiredPermissions: [],
    riskLevel: 'low' as const,
    category,
    timeout: 1000,
    idempotent,
  };
}
function ok(output: unknown): ToolResult {
  return { success: true, output, duration: 1, validated: true };
}

describe('ToolRegistry 能力协同 (P2 第4轮)', () => {
  let reg: ToolRegistry;
  let capSpy: jest.SpyInstance;
  let busSpy: jest.SpyInstance;

  beforeEach(() => {
    reg = new ToolRegistry();
    capSpy = jest.spyOn(capMetrics, 'record').mockImplementation(() => undefined);
    busSpy = jest.spyOn(EventBus, 'emit').mockImplementation(() => true as unknown as boolean);
  });
  afterEach(() => {
    capSpy.mockRestore();
    busSpy.mockRestore();
  });

  describe('C1 结果缓存接线', () => {
    it('幂等 network 工具二次同参命中缓存，不重执行', async () => {
      let calls = 0;
      reg.register(def('web_fetch', 'network', true), async () => {
        calls++;
        return ok('CACHED_BODY');
      });
      const r1 = await reg.execute('web_fetch', { url: 'http://x' }, ctx());
      const r2 = await reg.execute('web_fetch', { url: 'http://x' }, ctx());
      expect(calls).toBe(1);
      expect(r1.output).toBe('CACHED_BODY');
      expect(r2.output).toBe('CACHED_BODY');
    });
  });

  describe('C3 流式截断', () => {
    it('超长输出被截断到 ≤8000 并标记 truncation', async () => {
      const big = 'X'.repeat(20000);
      reg.register(def('web_fetch2', 'network', true), async () => ok(big));
      const r = await reg.execute('web_fetch2', { url: 'http://y' }, ctx());
      expect(typeof r.output).toBe('string');
      const out = r.output as string;
      expect(out.length).toBeLessThanOrEqual(8000);
      expect(out).toContain('...[输出已截断]');
      expect((r.metadata as { truncation?: { truncated: boolean } })?.truncation?.truncated).toBe(true);
    });
  });

  describe('D4 能力指标 capMetrics 接入', () => {
    it('工具执行后按类别记录成功', async () => {
      reg.register(def('net_cap', 'network'), async () => ok('N'));
      await reg.execute('net_cap', {}, ctx());
      expect(capSpy).toHaveBeenCalledWith('network', true);
    });
  });

  describe('D2 认知总线 cognition_result 事件', () => {
    it('认知工具完成后 emit cognition_result', async () => {
      reg.register(def('emotion_detect', 'cognition'), async () => ok('happy'));
      await reg.execute('emotion_detect', {}, ctx());
      expect(busSpy).toHaveBeenCalledWith(
        'cognition_result',
        expect.objectContaining({ tool: 'emotion_detect', category: 'cognition', success: true })
      );
    });
  });

  describe('负向 非幂等不缓存', () => {
    it('非幂等工具每次都执行', async () => {
      let calls = 0;
      reg.register(def('shell_run', 'system', false), async () => {
        calls++;
        return ok('R' + calls);
      });
      await reg.execute('shell_run', { cmd: 'ls' }, ctx());
      await reg.execute('shell_run', { cmd: 'ls' }, ctx());
      expect(calls).toBe(2);
    });
  });

  describe('D1 knowledge_query RAG 降级闭环', () => {
    it('记忆不足时降级 web_search 并回填记忆', async () => {
      const store = jest.fn();
      const exec = createKnowledgeQueryExecutor({
        memoryRecall: async () => [],
        webSearch: async () => [{ content: 'web answer', source: 's' }],
        memoryStore: store,
      });
      const r = await exec({ query: '量子纠缠' }, ctx());
      expect(typeof r.output).toBe('string');
      expect((r.output as string)).toContain('网络检索补强');
      expect(store).toHaveBeenCalled();
    });

    it('无 webSearch 时诚实返回未找到，不回填', async () => {
      const store = jest.fn();
      const exec = createKnowledgeQueryExecutor({
        memoryRecall: async () => [],
      });
      const r = await exec({ query: '不存在的概念' }, ctx());
      expect(typeof r.output).toBe('string');
      expect((r.output as string)).toContain('没有找到');
      expect(store).not.toHaveBeenCalled();
    });
  });

  describe('D3 代码工具共享安全扫描', () => {
    it('scanGeneratedCode 检测硬编码密钥', () => {
      const res = scanGeneratedCode('const k = "AKIA1234567890ABCDEF";');
      expect(res.secretHits.length).toBeGreaterThan(0);
      expect(res.warnings.length).toBeGreaterThan(0);
    });

    it('code_fix 修复物经安全扫描写入 metadata', async () => {
      const exec = createCodeFixExecutor({
        fixCode: async () => ({
          fixedCode: 'const k = "AKIA1234567890ABCDEF";',
          changes: [{ type: 'fix', description: 'fix' }],
        }),
      });
      const r = await exec({ code: 'broken', errorDescription: 'x' }, ctx());
      const meta = r.metadata as { secretHits?: string[]; securityWarnings?: string[] };
      expect(meta.secretHits?.length ?? 0).toBeGreaterThan(0);
      expect(meta.securityWarnings?.length ?? 0).toBeGreaterThan(0);
    });
  });
});
