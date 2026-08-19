/**
 * MemoryEngineBridge 单元测试
 *
 * 依据 AGENTS.md §0.1：TS 侧 MemoryEngine 已迁为桥接实现(MemoryEngine 别名即 MemoryEngineBridge)，
 * 所有存储/检索方法委托 Python FastAPI(:3112)，本地仅保留 getUserProfile(UserProfile 存根)
 * 与最小降级。本测试验证桥接契约：委托正确、字段映射正确、降级安全。
 */

import { MemoryEngine, MemoryType } from '../../../src/memory/MemoryEngine';
import { UserProfile } from '../../../src/memory/UserProfile';
import { getActivePythonBridge } from '../../../src/ide/bridgeRegistry';

// 将 bridgeRegistry 替换为可控的 mock，从而验证 MemoryEngineBridge 的委托行为
jest.mock('../../../src/ide/bridgeRegistry', () => ({
  getActivePythonBridge: jest.fn(),
}));

const mockGetBridge = getActivePythonBridge as jest.Mock;

function makeFakeBridge() {
  return {
    memoryStoreShortTerm: jest.fn().mockResolvedValue('id-st'),
    memoryStoreLongTerm: jest.fn().mockResolvedValue('id-lt'),
    memoryStoreInstant: jest.fn().mockResolvedValue('id-inst'),
    memoryStoreFeedback: jest.fn().mockResolvedValue(undefined),
    memoryHybridRetrieval: jest
      .fn()
      .mockResolvedValue([
        {
          id: 'r1',
          type: 'short_term',
          content: 'TypeScript 类型系统',
          timestamp: 1700000000000,
          scene: 'development',
          emotion: 'calm',
          relevanceScore: 0.9,
          decayScore: 1,
        },
      ]),
    memoryRetrieveContext: jest
      .fn()
      .mockResolvedValue([
        {
          id: 'c1',
          type: 'long_term',
          content: '偏好 React',
          timestamp: 1700000000000,
          scene: 'development',
          emotion: 'calm',
          relevanceScore: 0.8,
        },
      ]),
    memoryQueryRecentFeedback: jest
      .fn()
      .mockResolvedValue([{ feedbackType: 'success', rating: 5 }]),
    memoryUpdate: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MemoryEngineBridge', () => {
  let memoryEngine: MemoryEngine;
  let fakeBridge: ReturnType<typeof makeFakeBridge>;

  beforeEach(() => {
    fakeBridge = makeFakeBridge();
    mockGetBridge.mockReturnValue(fakeBridge);
    memoryEngine = new MemoryEngine();
  });

  describe('用户画像（本地存根）', () => {
    it('getUserProfile 返回本地 UserProfile 实例，供同步调用 getBasicInfo 等', () => {
      const profile = (memoryEngine as unknown as { getUserProfile(): UserProfile }).getUserProfile();
      expect(profile).toBeInstanceOf(UserProfile);
      expect(typeof profile.getBasicInfo).toBe('function');
      expect(typeof profile.getDevelopmentHabits).toBe('function');
      expect(profile.getBasicInfo()).toHaveProperty('name');
    });

    it('getUserProfileSummary 从本地 UserProfile 派生摘要', async () => {
      const summary = await (
        memoryEngine as unknown as {
          getUserProfileSummary(userId: string): Promise<{
            name?: string;
            preferredFrameworks?: string[];
          }>;
        }
      ).getUserProfileSummary('u1');
      expect(summary).toHaveProperty('preferredFrameworks');
      expect(Array.isArray(summary.preferredFrameworks)).toBe(true);
    });
  });

  describe('存储方法委托 Python', () => {
    it('storeShortTermMemory 委托 bridge.memoryStoreShortTerm 并返回 MemoryItem', async () => {
      const item = await memoryEngine.storeShortTermMemory('hello', 'dev', 'calm');
      expect(fakeBridge.memoryStoreShortTerm).toHaveBeenCalledWith('hello', 'dev', 'calm');
      expect(item.id).toBe('id-st');
      expect(item.type).toBe(MemoryType.SHORT_TERM);
      expect(item.content).toBe('hello');
      expect(item.scene).toBe('dev');
      expect(item.emotion).toBe('calm');
      expect(item.timestamp).toBeInstanceOf(Date);
    });

    it('storeLongTermMemory / storeInstantMemory 同样委托并返回正确 MemoryItem', async () => {
      const lt = await memoryEngine.storeLongTermMemory({ a: 1 }, 'learn', 'focused');
      expect(fakeBridge.memoryStoreLongTerm).toHaveBeenCalledWith(
        JSON.stringify({ a: 1 }),
        'learn',
        'focused'
      );
      expect(lt.type).toBe(MemoryType.LONG_TERM);

      const inst = await memoryEngine.storeInstantMemory('瞬时', 'work', 'happy');
      expect(fakeBridge.memoryStoreInstant).toHaveBeenCalledWith('瞬时', 'work', 'happy');
      expect(inst.type).toBe(MemoryType.INSTANT);
    });

    it('storeFeedbackSignal 委托 bridge.memoryStoreFeedback', async () => {
      await memoryEngine.storeFeedbackSignal({ feedbackType: 'success', rating: 5 });
      expect(fakeBridge.memoryStoreFeedback).toHaveBeenCalledTimes(1);
      const arg = fakeBridge.memoryStoreFeedback.mock.calls[0][0];
      expect(arg.feedbackType).toBe('success');
      expect(arg.rating).toBe(5);
    });

    it('updateMemory 委托 bridge.memoryUpdate', async () => {
      await memoryEngine.updateMemory('m1', { content: 'updated', scene: 'dev' });
      expect(fakeBridge.memoryUpdate).toHaveBeenCalledWith('m1', {
        content: 'updated',
        scene: 'dev',
        emotion: undefined,
        metadata: undefined,
      });
    });
  });

  describe('检索方法委托 Python 并映射字段', () => {
    it('preciseHybridRetrieval 委托并返回映射后的 MemoryItem[]', async () => {
      const items = await memoryEngine.preciseHybridRetrieval('TypeScript', 'dev', 'calm', 5);
      expect(fakeBridge.memoryHybridRetrieval).toHaveBeenCalledWith('TypeScript', 'dev', 'calm', 5);
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('r1');
      expect(items[0].relevanceScore).toBe(0.9);
      expect(items[0].content).toBe('TypeScript 类型系统');
    });

    it('retrieveRelevant 是 preciseHybridRetrieval 的薄包装', async () => {
      const items = await memoryEngine.retrieveRelevant({ query: 'q', limit: 3 });
      expect(fakeBridge.memoryHybridRetrieval).toHaveBeenCalledWith('q', undefined, undefined, 3);
      expect(Array.isArray(items)).toBe(true);
    });

    it('retrieveContext 委托并返回 {memories, preferences}', async () => {
      const ctx = await memoryEngine.retrieveContext('用户输入');
      expect(fakeBridge.memoryRetrieveContext).toHaveBeenCalledWith('用户输入', undefined);
      expect(ctx.memories).toHaveLength(1);
      expect(ctx.memories[0].type).toBe('long_term');
      expect(ctx.memories[0].content).toBe('偏好 React');
      expect(ctx.preferences).toEqual({ codingStyle: [], namingRules: [] });
    });

    it('queryRecentFeedback 委托并返回数组', async () => {
      const fb = await memoryEngine.queryRecentFeedback(12);
      expect(fakeBridge.memoryQueryRecentFeedback).toHaveBeenCalledWith(12);
      expect(Array.isArray(fb)).toBe(true);
    });
  });

  describe('初始化 / 内部方法', () => {
    it('initialize 可解析；isInitialized 反映 bridge 是否可用', async () => {
      await expect(memoryEngine.initialize()).resolves.toBeUndefined();
      expect(memoryEngine.isInitialized()).toBe(true);
    });

    it('markUserActive 为 no-op 不抛错', () => {
      expect(() => (memoryEngine as unknown as { markUserActive(): void }).markUserActive()).not.toThrow();
    });

    it('getEpisodicMemoryStats / detectBehaviorPatterns 返回最小降级结果', () => {
      expect(
        (memoryEngine as unknown as { getEpisodicMemoryStats(): Record<string, unknown> }).getEpisodicMemoryStats()
      ).toEqual({});
      expect(
        (memoryEngine as unknown as { detectBehaviorPatterns(): unknown[] }).detectBehaviorPatterns()
      ).toEqual([]);
    });
  });

  describe('Python 不可用时的降级', () => {
    beforeEach(() => {
      mockGetBridge.mockReturnValue(null);
    });

    it('storeShortTermMemory 降级返回空 id 但字段完整', async () => {
      const item = await memoryEngine.storeShortTermMemory('x', 'd', 'e');
      expect(item.id).toBe('');
      expect(item.type).toBe(MemoryType.SHORT_TERM);
      expect(item.content).toBe('x');
    });

    it('preciseHybridRetrieval 降级返回空数组', async () => {
      const items = await memoryEngine.preciseHybridRetrieval('q');
      expect(items).toEqual([]);
    });

    it('retrieveContext 降级返回 {memories:[],preferences}', async () => {
      const ctx = await memoryEngine.retrieveContext('q');
      expect(ctx).toEqual({ memories: [], preferences: { codingStyle: [], namingRules: [] } });
    });

    it('isInitialized 在无 bridge 时为 false', () => {
      expect(memoryEngine.isInitialized()).toBe(false);
    });
  });
});
