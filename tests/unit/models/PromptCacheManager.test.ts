/**
 * PromptCacheManager 单元测试
 *
 * 测试缓存策略：key 生成、exact 匹配、前缀检测、工具调用缓存。
 * SqliteCacheStore 被 mock，专注于缓存管理逻辑。
 */

jest.mock('../../../src/models/SqliteCacheStore', () => {
  const mockStore = {
    get: jest.fn(),
    getEntry: jest.fn().mockReturnValue(undefined),
    set: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
    clearByKind: jest.fn(),
    getByPrefix: jest.fn().mockReturnValue([]),
    getStats: jest.fn().mockReturnValue({
      totalEntries: 0,
      activeEntries: 0,
      expiredEntries: 0,
      totalHits: 0,
      totalMisses: 0,
      hitRate: 0,
      sizeBytes: 0,
      cacheKind: 'mock',
    }),
    listEntries: jest.fn().mockReturnValue([]),
    close: jest.fn(),
  };

  return {
    SqliteCacheStore: jest.fn().mockImplementation(() => mockStore),
  };
});

import { PromptCacheManager } from '../../../src/models/PromptCacheManager';
import { SqliteCacheStore } from '../../../src/models/SqliteCacheStore';

// 获取 mock store 实例
const mockStore = new SqliteCacheStore() as jest.Mocked<any>;

describe('PromptCacheManager', () => {
  let manager: PromptCacheManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new PromptCacheManager(
      { enabled: true, defaultTTL: 60000 },
      { exactMatch: true, prefixAware: true }
    );
  });

  afterEach(() => {
    manager.close();
  });

  describe('缓存 key 生成', () => {
    it('应基于 systemPrompt + messages + model 生成唯一 key', () => {
      const key1 = manager.generateExactKey({
        systemPrompt: '你是一个助手',
        messages: [{ role: 'user', content: '你好' }],
        modelName: 'deepseek-v4',
      });

      const key2 = manager.generateExactKey({
        systemPrompt: '你是一个助手',
        messages: [{ role: 'user', content: '再见' }],
        modelName: 'deepseek-v4',
      });

      expect(key1).not.toBe(key2);
    });

    it('相同输入应生成相同 key', () => {
      const params = {
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'model-x',
        temperature: 0.7,
      };

      const k1 = manager.generateExactKey(params);
      const k2 = manager.generateExactKey(params);
      expect(k1).toBe(k2);
    });

    it('不同 modelName 应生成不同 key', () => {
      const k1 = manager.generateExactKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'model-a',
      });
      const k2 = manager.generateExactKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'model-b',
      });
      expect(k1).not.toBe(k2);
    });

    it('不同 temperature 应生成不同 key', () => {
      const k1 = manager.generateExactKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
        temperature: 0.5,
      });
      const k2 = manager.generateExactKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
        temperature: 0.8,
      });
      expect(k1).not.toBe(k2);
    });

    it('前缀 key 应包含 system + 历史，不包含最后一条用户消息', () => {
      const result = manager.generatePrefixKey({
        systemPrompt: 'sys',
        messages: [
          { role: 'user', content: '历史消息' },
          { role: 'assistant', content: '回复' },
          { role: 'user', content: '当前输入' },
        ],
        modelName: 'm',
      });

      expect(result.lastUserMessage).toBe('当前输入');
      expect(result.prefixKey).toContain('prefix:');
    });

    it('工具调用 key 应包含工具 schema hash', () => {
      const tools = [
        {
          function: {
            name: 'get_weather',
            description: '获取天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        },
        {
          function: {
            name: 'search_web',
            description: '搜索',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
            },
          },
        },
      ];

      const toolKey1 = manager.generateToolKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: '天气如何' }],
        modelName: 'm',
        tools,
      });

      const toolKey2 = manager.generateToolKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: '天气如何' }],
        modelName: 'm',
        tools, // same tools
      });

      expect(toolKey1).toBe(toolKey2);
    });

    it('工具排序后应生成相同 key', () => {
      const tools1 = [
        { function: { name: 'get_weather' } },
        { function: { name: 'search_web' } },
      ];
      const tools2 = [
        { function: { name: 'search_web' } },
        { function: { name: 'get_weather' } },
      ];

      const k1 = manager.generateToolKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
        tools: tools1,
      });
      const k2 = manager.generateToolKey({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
        tools: tools2,
      });

      expect(k1).toBe(k2);
    });

    it('空白符规范化后 key 应一致', () => {
      const k1 = manager.generateExactKey({
        systemPrompt: '  你好  世界  ',
        messages: [{ role: 'user', content: '  测试  ' }],
        modelName: 'm',
      });
      const k2 = manager.generateExactKey({
        systemPrompt: '你好 世界',
        messages: [{ role: 'user', content: '测试' }],
        modelName: 'm',
      });
      expect(k1).toBe(k2);
    });
  });

  describe('exact 匹配缓存', () => {
    it('未命中时应返回 miss', () => {
      const result = manager.tryGetExact({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      });

      expect(result.hit).toBe(false);
      expect(result.value).toBeNull();
      expect(result.matchType).toBe('none');
    });

    it('命中时应返回缓存值', () => {
      const params = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
        temperature: 0.7,
      };

      mockStore.getEntry.mockReturnValueOnce({
        key: 'exact:xxx',
        value: 'cached response',
        hitCount: 1,
      });

      const result = manager.tryGetExact(params);
      expect(result.hit).toBe(true);
      expect(result.value).toBe('cached response');
      expect(result.matchType).toBe('exact');
    });

    it('存储后应可命中', () => {
      const params = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      };

      // 第一次 - miss
      mockStore.getEntry.mockReturnValueOnce(undefined);
      const miss = manager.tryGetExact(params);
      expect(miss.hit).toBe(false);

      // 存储
      manager.storeExact(params, 'cached response');

      // 第二次 - hit
      mockStore.getEntry.mockReturnValueOnce({
        key: 'exact:xxx',
        value: 'cached response',
        hitCount: 1,
      });
      const hit = manager.tryGetExact(params);
      expect(hit.hit).toBe(true);
      expect(hit.value).toBe('cached response');
    });

    it('短响应不应存储', () => {
      const params = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      };

      manager.storeExact(params, 'ab'); // 长度 < 5
      expect(mockStore.set).not.toHaveBeenCalled();
    });

    it('禁用缓存时应跳过', () => {
      manager.enabled = false;

      const result = manager.tryGetExact({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      });

      expect(result.hit).toBe(false);
      expect(mockStore.get).not.toHaveBeenCalled();
    });
  });

  describe('前缀感知', () => {
    it('相同前缀不同用户输入应检测为 prefix_miss', () => {
      const params1 = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: '帮我分析这段代码' }],
        modelName: 'm',
      };

      const params2 = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: '帮我重构这段代码' }],
        modelName: 'm',
      };

      // 先缓存 params1
      manager.storeExact(params1, '分析结果');

      // 模拟前缀命中但 exact miss
      mockStore.getEntry.mockReturnValueOnce(undefined); // exact miss
      mockStore.getEntry.mockReturnValueOnce({
        // prefix hit
        key: 'prefix:xxx',
        value: '1',
        hitCount: 1,
      });

      const result = manager.tryGetExact(params2);
      expect(result.hit).toBe(false);
      expect(result.matchType).toBe('prefix_miss');
    });
  });

  describe('工具调用缓存', () => {
    it('相同输入应命中工具缓存', () => {
      const params = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: '今天天气如何' }],
        modelName: 'm',
        tools: [{ function: { name: 'get_weather' } }],
      };

      mockStore.getEntry.mockReturnValueOnce({
        key: 'tool:xxx',
        value: '今天天气晴朗',
        hitCount: 2,
      });

      const result = manager.tryGetToolCall(params);
      expect(result.hit).toBe(true);
      expect(result.value).toBe('今天天气晴朗');
    });

    it('首次调用未命中应返回 miss', () => {
      const params = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      };

      mockStore.getEntry.mockReturnValueOnce(undefined);

      const result = manager.tryGetToolCall(params);
      expect(result.hit).toBe(false);
    });

    it('无 toolCalls 的请求应缓存', () => {
      const params = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      };

      manager.storeToolCall(params, 'hello!');
      expect(mockStore.set).toHaveBeenCalled();
    });

    it('短响应不应缓存工具调用', () => {
      const params = {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      };

      manager.storeToolCall(params, 'ab');
      expect(mockStore.set).not.toHaveBeenCalled();
    });
  });

  describe('统计', () => {
    it('应返回正确的命中率', () => {
      mockStore.getEntry.mockReturnValueOnce({
        key: 'exact:xxx',
        value: 'cached',
        hitCount: 1,
      });

      manager.tryGetExact({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        modelName: 'm',
      }); // hit

      const stats = manager.getSessionStats();
      expect(stats.hits).toBe(1);
      expect(stats.hitRate).toBe(1);
    });

    it('应返回完整统计报告', () => {
      const report = manager.getFullStats();
      expect(report).toHaveProperty('session');
      expect(report).toHaveProperty('store');
      expect(report).toHaveProperty('config');
      expect(report.status).toBe('active');
    });
  });

  describe('管理操作', () => {
    it('应支持按类型清空', () => {
      manager.clear('response');
      expect(mockStore.clearByKind).toHaveBeenCalledWith('response');
    });

    it('清空全部应调用 store.clear', () => {
      manager.clear();
      expect(mockStore.clear).toHaveBeenCalled();
    });
  });
});
