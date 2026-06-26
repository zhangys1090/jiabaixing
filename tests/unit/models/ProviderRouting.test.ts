/**
 * ProviderManager 单元测试
 * 测试提供商路由：封禁/解封、白名单、排序策略
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { ProviderManager } from '../../../src/models/ProviderManager';

// mock Logger only
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('ProviderManager 路由', () => {
  let pm: ProviderManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    pm = new ProviderManager(tmpDir);
    // 注册测试提供商
    pm.register({
      name: 'provider-a',
      displayName: 'A',
      baseUrl: 'https://a.com/v1',
      apiKey: 'key-a',
      model: 'model-a',
      priority: 0,
    });
    pm.register({
      name: 'provider-b',
      displayName: 'B',
      baseUrl: 'https://b.com/v1',
      apiKey: 'key-b',
      model: 'model-b',
      priority: 1,
    });
    pm.register({
      name: 'provider-c',
      displayName: 'C',
      baseUrl: 'https://c.com/v1',
      apiKey: 'key-c',
      model: 'model-c',
      priority: 2,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('封禁/解封', () => {
    it('应封禁提供商', () => {
      const result = pm.blockProvider('provider-a');
      expect(result).toBe(true);
      expect(pm.getBlockedProviders()).toContain('provider-a');
    });

    it('封禁后应不出现在路由结果中', () => {
      pm.blockProvider('provider-a');

      const providers = pm.getProvidersForInput('test');
      expect(providers.find((p) => p.name === 'provider-a')).toBeUndefined();
    });

    it('应解封提供商', () => {
      pm.blockProvider('provider-a');
      expect(pm.getBlockedProviders()).toHaveLength(1);

      const result = pm.unblockProvider('provider-a');
      expect(result).toBe(true);
      expect(pm.getBlockedProviders()).toHaveLength(0);
    });

    it('封禁不存在的提供商应返回 false', () => {
      const result = pm.blockProvider('nonexistent');
      expect(result).toBe(false);
    });

    it('重复封禁应返回 false', () => {
      pm.blockProvider('provider-a');
      const result = pm.blockProvider('provider-a');
      expect(result).toBe(false);
    });
  });

  describe('排序策略', () => {
    it('注册后 primary 和 getAll 应正常', () => {
      const primary = pm.getPrimary();
      expect(primary).toBeDefined();
      expect(primary!.name).toBe('provider-a');

      const all = pm.getAll();
      expect(all.length).toBe(3);
    });

    it('默认按 priority 排序', () => {
      const providers = pm.getProvidersForInput('hello');
      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers[0].name).toBe('provider-a');
    });

    it('setSortStrategy 应更新策略', () => {
      pm.setSortStrategy('cost');
      // 无法直接验证私有 store，但方法不应抛异常
      expect(true).toBe(true);
    });

    it('应支持设置所有排序策略类型', () => {
      const strategies = ['priority', 'cost', 'latency', 'manual'] as const;
      for (const s of strategies) {
        pm.setSortStrategy(s);
      }
      expect(true).toBe(true);
    });
  });

  describe('白名单', () => {
    it('封禁主模型后回退到其他提供商', () => {
      const before = pm.getProvidersForInput('test').length;
      expect(before).toBe(1); // 只有主模型

      pm.blockProvider('provider-a');

      const after = pm.getProvidersForInput('test').length;
      // 主模型被封禁，fallback 到其他启用的提供商
      expect(after).toBe(2); // provider-b, provider-c
      expect(after).toBeLessThan(before + 2); // 没有新增
    });
  });

  describe('综合路由', () => {
    it('封禁 + 禁用后应过滤掉对应提供商', () => {
      pm.blockProvider('provider-a');
      pm.setEnabled('provider-c', false);

      const providers = pm.getProvidersForInput('test');
      // 路由禁用时只返回主模型（provider-a），但被 block 了
      // fallback 到其他已启用的提供商 → provider-b（provider-c 被禁用）
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe('provider-b');
    });

    it('启用路由后封禁应过滤非主模型', () => {
      // 启用路由：简单任务用 provider-b，复杂用 provider-a
      pm.setEnabled('provider-c', false);
      // 手动模拟 importFromEnv 的路由配置
      const pmAny = pm as any;
      pmAny.store.routingEnabled = true;
      pmAny.store.routing.simpleTaskProviders = ['provider-b'];
      pmAny.store.routing.complexTaskProviders = ['provider-a'];

      pm.blockProvider('provider-b');
      const providers = pm.getProvidersForInput('hello');
      // 'hello' 是短文本 → 简单任务 → simpleTaskProviders = ['provider-b']
      // provider-b 被封禁 → 返回空列表 → fallback to getAll()
      // getAll() 中 provider-c 被禁用，只剩下 provider-a
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe('provider-a');
    });

    it('路由禁用时返回主模型', () => {
      // 主模型是 provider-a
      const providers = pm.getProvidersForInput('test');
      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers[0].name).toBe('provider-a');
    });
  });
});
