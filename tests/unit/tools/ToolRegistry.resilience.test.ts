/**
 * ToolRegistry 统一执行包装层弹性测试（P1 第3轮：B1 重试 / B2 自愈 / B3 熔断 / C2 并发配额）
 *
 * 覆盖：
 *  - B1: 仅对瞬时可重试错误(429/5xx/ETIMEDOUT/网络抖动)重试，且默认仅网络/LLM 类工具启用(上限 3)。
 *  - B2: 注入自愈处理器后，参数修正(PARAM_FIX)可重执行成功；未注入则诚实返回原失败。
 *  - B3: 抛出型异常也计入熔断（此前的成功路径才更新，吞噬型异常会绕过熔断）；连续 5 次后 open。
 *  - C2: 付费工具(image_generate/tts_speak/web_search)会话级每日配额 + 同参去重；每-agent 并发信号量(默认 4)。
 *
 * 注：本地 node_modules 损坏时 jest 无法运行，可用 .p1_verify/verify.cjs（tsc 转译 + Module._load 桩）做真实运行时验证。
 */
import { ToolRegistry, ToolHealAction } from '../../../src/harness/tools/registry/ToolRegistry';
import type { ToolCategory, ToolContext, ToolResult } from '../../../src/harness/types';

function ctx(meta: Record<string, unknown> = {}): ToolContext {
  return { permissions: new Set(), metadata: meta, userId: 'u1', traceId: 't1' } as ToolContext;
}
function def(name: string, category: ToolCategory) {
  return {
    name,
    description: name,
    parameters: {},
    requiredParams: [],
    requiredPermissions: [],
    riskLevel: 'low' as const,
    category,
    timeout: 1000,
  };
}
function ok(output: unknown): ToolResult {
  return { success: true, output, duration: 1, validated: true };
}

describe('ToolRegistry 弹性包装层 (P1 第3轮)', () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  describe('B1 重试分类', () => {
    it('不可重试错误立即终止（仅执行 1 次）', async () => {
      let calls = 0;
      reg.register(def('net_biz', 'network'), async () => {
        calls++;
        throw new Error('business logic error');
      });
      const r = await reg.execute('net_biz', {}, ctx());
      expect(calls).toBe(1);
      expect(r.success).toBe(false);
    });

    it('网络工具可重试错误(ETIMEDOUT) 默认重试至上限 3 → 共 4 次', async () => {
      let calls = 0;
      reg.register(def('net_to', 'network'), async () => {
        calls++;
        throw new Error('ETIMEDOUT connection reset');
      });
      process.env['TOOL_RETRY_BASE_DELAY'] = '0.001';
      process.env['TOOL_RETRY_MAX_DELAY'] = '0.001';
      const r = await reg.execute('net_to', {}, ctx());
      delete process.env['TOOL_RETRY_BASE_DELAY'];
      delete process.env['TOOL_RETRY_MAX_DELAY'];
      expect(calls).toBe(4);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/ETIMEDOUT/);
    });

    it('非网络工具不默认重试（可重试错误也只执行 1 次）', async () => {
      let calls = 0;
      reg.register(def('code_to', 'code'), async () => {
        calls++;
        throw new Error('ETIMEDOUT');
      });
      const r = await reg.execute('code_to', {}, ctx());
      expect(calls).toBe(1);
      expect(r.success).toBe(false);
    });
  });

  describe('B3 熔断（含抛出型异常）', () => {
    it('连续 5 次抛出型失败 → 熔断 open，后续调用被拒', async () => {
      reg.register(def('boom', 'system'), async () => {
        throw new Error('kaboom');
      });
      for (let i = 0; i < 4; i++) await reg.execute('boom', {}, ctx());
      expect(reg.getCircuitBreakerState('boom')?.state).toBe('closed');
      await reg.execute('boom', {}, ctx());
      expect(reg.getCircuitBreakerState('boom')?.state).toBe('open');
      const blocked = await reg.execute('boom', {}, ctx());
      expect(blocked.success).toBe(false);
      expect(blocked.error).toMatch(/熔断/);
    });
  });

  describe('C2 付费工具配额 + 去重', () => {
    it('会话每日配额耗尽后拒绝', async () => {
      let calls = 0;
      reg.register(def('image_generate', 'network'), async () => {
        calls++;
        return ok('IMG');
      });
      process.env['TOOL_QUOTA_image_generate'] = '2';
      const r1 = await reg.execute('image_generate', { prompt: 'a' }, ctx());
      const r2 = await reg.execute('image_generate', { prompt: 'b' }, ctx());
      const r3 = await reg.execute('image_generate', { prompt: 'c' }, ctx());
      delete process.env['TOOL_QUOTA_image_generate'];
      expect(r1.success && r2.success).toBe(true);
      expect(r3.success).toBe(false);
      expect(r3.metadata?.quotaExceeded).toBe(true);
      expect(calls).toBe(2);
    });

    it('同参数命中缓存去重，不重复执行', async () => {
      let calls = 0;
      reg.register(def('image_generate', 'network'), async () => {
        calls++;
        return ok('IMG');
      });
      process.env['TOOL_QUOTA_image_generate'] = '100';
      await reg.execute('image_generate', { prompt: 'same' }, ctx());
      const r2 = await reg.execute('image_generate', { prompt: 'same' }, ctx());
      delete process.env['TOOL_QUOTA_image_generate'];
      expect(calls).toBe(1);
      expect(r2.metadata?.dedupHit).toBe(true);
      expect(r2.output).toBe('IMG');
    });
  });

  describe('B2 自愈接入', () => {
    it('PARAM_FIX 修正参数后重执行成功', async () => {
      let calls = 0;
      reg.register(def('flaky', 'code'), async (p) => {
        calls++;
        if ((p as { fixed?: boolean }).fixed === true) return ok('OK');
        throw new Error('bad param');
      });
      reg.setSelfHealHandler(async ({ params }) => ({
        action: ToolHealAction.PARAM_FIX,
        params: { ...params, fixed: true },
      }));
      const r = await reg.execute('flaky', { foo: 1 }, ctx());
      expect(r.success).toBe(true);
      expect(r.metadata?.healed).toBe('param_fix');
      expect(calls).toBe(2);
    });

    it('未注入自愈处理器 → 诚实返回原失败（不假成功）', async () => {
      reg.register(def('flaky2', 'code'), async () => {
        throw new Error('bad param');
      });
      const r = await reg.execute('flaky2', {}, ctx());
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/bad param/);
    });
  });

  describe('C2 并发信号量', () => {
    it('默认每-agent 并发上限 4（8 并发不突破）', async () => {
      let active = 0;
      let maxActive = 0;
      reg.register(def('slow', 'network'), async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((res) => setTimeout(res, 20));
        active--;
        return ok('x');
      });
      await Promise.all(
        Array.from({ length: 8 }, () => reg.execute('slow', {}, ctx()))
      );
      expect(maxActive).toBeLessThanOrEqual(4);
    });
  });
});
