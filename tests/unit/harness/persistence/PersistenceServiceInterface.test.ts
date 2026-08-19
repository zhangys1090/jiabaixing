/**
 * PersistenceService 接口兼容性测试
 *
 * 验证 PersistenceService 能接受符合 IMemoryEngine 接口的对象作为 memoryEngine 依赖，
 * 替代原有的内联类型定义，减少类型重复。
 */

import { PersistenceService } from '../../../../src/harness/persistence/PersistenceService';
import type { PersistenceServiceDeps } from '../../../../src/harness/persistence/PersistenceService';
import type { IMemoryEngine } from '../../../../src/core/IMemoryEngine';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

/**
 * 创建符合 IMemoryEngine 接口的 mock 对象
 */
function createMockMemoryEngine(): IMemoryEngine {
  return {
    storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
    storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
    storeInstantMemory: jest.fn().mockResolvedValue(undefined),
    preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
    storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
  };
}

describe('PersistenceService 接口兼容性', () => {
  let service: PersistenceService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('IMemoryEngine 接口注入', () => {
    it('应该能接受符合 IMemoryEngine 接口的对象作为 memoryEngine 依赖', () => {
      const mockEngine = createMockMemoryEngine();

      // 验证 mock 对象符合 IMemoryEngine 接口
      const deps: PersistenceServiceDeps = {
        memoryEngine: mockEngine,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);

      expect(service).toBeDefined();
      expect(deps.memoryEngine).toBe(mockEngine);
    });

    it('应该能接受 null 作为 memoryEngine 依赖', () => {
      const deps: PersistenceServiceDeps = {
        memoryEngine: null,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);

      expect(service).toBeDefined();
      expect(deps.memoryEngine).toBeNull();
    });
  });

  describe('preciseHybridRetrieval 方法调用', () => {
    it('应该能通过 IMemoryEngine 接口正确调用 preciseHybridRetrieval', async () => {
      const mockMemories = [
        {
          id: 'mem-1',
          content: '测试记忆内容',
          type: 'short_term',
          timestamp: Date.now(),
          scene: 'coding',
          emotion: 'neutral',
          relevanceScore: 0.9,
        },
      ];

      const mockEngine = createMockMemoryEngine();
      (mockEngine.preciseHybridRetrieval as jest.Mock).mockResolvedValue(
        mockMemories
      );

      const deps: PersistenceServiceDeps = {
        memoryEngine: mockEngine,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);
      const results = await service.recallMemory('测试查询', {
        scene: 'coding',
        limit: 5,
      });

      expect(mockEngine.preciseHybridRetrieval).toHaveBeenCalledWith(
        '测试查询',
        'coding',
        undefined,
        5
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-1');
    });

    it('当 memoryEngine 为 null 时应该返回空数组', async () => {
      const deps: PersistenceServiceDeps = {
        memoryEngine: null,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);
      const results = await service.recallMemory('测试查询');

      expect(results).toEqual([]);
    });
  });

  describe('storeFeedbackSignal 方法调用', () => {
    it('应该能通过 IMemoryEngine 接口正确调用 storeFeedbackSignal', async () => {
      const mockEngine = createMockMemoryEngine();

      const deps: PersistenceServiceDeps = {
        memoryEngine: mockEngine,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);
      await service.storeFeedback({
        feedbackType: 'success',
        rating: 5,
        message: '测试反馈',
        traceId: 'trace-1',
        toolName: 'test-tool',
      });

      expect(mockEngine.storeFeedbackSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          feedbackType: 'success',
          rating: 5,
          message: '测试反馈',
          traceId: 'trace-1',
          toolName: 'test-tool',
          timestamp: expect.any(Number),
        })
      );
    });

    it('当 memoryEngine 为 null 时应该跳过反馈存储', async () => {
      const deps: PersistenceServiceDeps = {
        memoryEngine: null,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);
      // memoryEngine 为 null 时 storeFeedback 应跳过存储且不抛异常
      await expect(
        service.storeFeedback({
          feedbackType: 'success',
          rating: 5,
        })
      ).resolves.not.toThrow();
    });
  });

  describe('记忆存储方法调用', () => {
    it('应该能通过 IMemoryEngine 接口调用 storeShortTermMemory', async () => {
      const mockEngine = createMockMemoryEngine();

      const deps: PersistenceServiceDeps = {
        memoryEngine: mockEngine,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);
      await service.storeMemory('短期记忆内容', {
        type: 'short_term',
        scene: 'coding',
      });

      expect(mockEngine.storeShortTermMemory).toHaveBeenCalledWith(
        '短期记忆内容',
        'coding',
        undefined
      );
    });

    it('应该能通过 IMemoryEngine 接口调用 storeLongTermMemory', async () => {
      const mockEngine = createMockMemoryEngine();

      const deps: PersistenceServiceDeps = {
        memoryEngine: mockEngine,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);
      await service.storeMemory('长期记忆内容', {
        type: 'long_term',
      });

      expect(mockEngine.storeLongTermMemory).toHaveBeenCalledWith(
        '长期记忆内容',
        undefined,
        undefined
      );
    });

    it('应该能通过 IMemoryEngine 接口调用 storeInstantMemory', async () => {
      const mockEngine = createMockMemoryEngine();

      const deps: PersistenceServiceDeps = {
        memoryEngine: mockEngine,
        conversationHistory: null,
        userProfile: null,
      };

      service = new PersistenceService(deps);
      await service.storeMemory('即时记忆内容', {
        type: 'instant',
      });

      expect(mockEngine.storeInstantMemory).toHaveBeenCalledWith(
        '即时记忆内容',
        undefined,
        undefined
      );
    });
  });
});