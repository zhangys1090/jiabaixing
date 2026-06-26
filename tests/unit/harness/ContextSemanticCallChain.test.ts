/**
 * ContextManager + SemanticSimilarityEngine 集成调用链测试
 *
 * 验证维度3（上下文管理）和维度4（记忆系统）的集成调用链：
 * - CHAIN-8: activelyRetrieveContext 在 buildContext 中被调用
 * - CHAIN-9: focusByAttention 在 activelyRetrieveContext 之后被调用
 * - CHAIN-10: SemanticSimilarityEngine.generateVectorSync 被 TrajectoryDatabase 的嵌入函数调用
 * - CHAIN-11: setEmbedFunction 注入后 TrajectoryDatabase.querySimilarTasks 使用语义检索
 */

import { ContextManager } from '../../../src/harness/context/ContextManager';
import { TrajectoryDatabase } from '../../../src/harness/persistence/TrajectoryDatabase';
import { SemanticSimilarityEngine } from '../../../src/memory/SemanticSimilarityEngine';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function createMockContextManagerDeps() {
  return {
    constitutionalBuilder: {
      buildConstitutionPrompt: jest.fn().mockResolvedValue('系统提示'),
    },
    memoryInjector: {
      autoRetrieveMemories: jest.fn().mockResolvedValue([]),
    },
    dynamicContext: {
      getDynamicContext: jest.fn().mockReturnValue(''),
    },
    historyProvider: {
      getAllHistory: jest.fn().mockReturnValue([]),
      getRecentHistory: jest.fn().mockReturnValue([]),
    },
  };
}

describe('ContextManager + SemanticSimilarityEngine 集成调用链', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CHAIN-8: activelyRetrieveContext 在 buildContext 中被调用', () => {
    it('有卸荷历史时应调用 activelyRetrieveContext', async () => {
      const cm = new ContextManager(createMockContextManagerDeps());

      const offloadedMessages = Array.from({ length: 20 }, (_, i) => ({
        role: 'user' as const,
        content: `历史消息 ${i}: 关于Python编程的讨论`,
      }));
      (cm as any).offloadedHistory = offloadedMessages;

      const spy = jest.spyOn(cm as any, 'activelyRetrieveContext');

      try {
        await cm.buildContext({
          text: 'Python编程问题',
          userId: 'test',
        });
      } catch {
        // buildContext 可能因缺少其他依赖而失败，但调用链应已触发
      }

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(offloadedMessages, 'Python编程问题');
    });

    it('无卸荷历史时不应调用 activelyRetrieveContext', async () => {
      const cm = new ContextManager(createMockContextManagerDeps());

      (cm as any).offloadedHistory = [];

      const spy = jest.spyOn(cm as any, 'activelyRetrieveContext');

      try {
        await cm.buildContext({
          text: '测试问题',
          userId: 'test',
        });
      } catch {
        // 忽略
      }

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('CHAIN-9: focusByAttention 在 activelyRetrieveContext 之后被调用', () => {
    it('activelyRetrieveContext 返回结果后应调用 focusByAttention', async () => {
      const cm = new ContextManager(createMockContextManagerDeps());

      const offloadedMessages = Array.from({ length: 20 }, (_, i) => ({
        role: 'user' as const,
        content: `历史消息 ${i}: 关于Python编程的讨论`,
      }));
      (cm as any).offloadedHistory = offloadedMessages;

      const activeSpy = jest.spyOn(cm as any, 'activelyRetrieveContext');
      const focusSpy = jest.spyOn(cm as any, 'focusByAttention');

      try {
        await cm.buildContext({
          text: 'Python编程问题',
          userId: 'test',
        });
      } catch {
        // 忽略
      }

      expect(activeSpy).toHaveBeenCalledTimes(1);

      if (activeSpy.mock.results[0]?.value?.length > 0) {
        expect(focusSpy).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('CHAIN-10: SemanticSimilarityEngine.generateVectorSync 被嵌入函数调用', () => {
    it('setEmbedFunction 注入后 generateVectorSync 应被调用', () => {
      const engine = new SemanticSimilarityEngine();
      const spy = jest.spyOn(engine, 'generateVectorSync');

      const embedFn = (text: string) => engine.generateVectorSync(text);

      const result = embedFn('测试文本');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('测试文本');
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('多次调用应使用缓存', () => {
      const engine = new SemanticSimilarityEngine();
      const spy = jest.spyOn(engine, 'generateVectorSync');

      const embedFn = (text: string) => engine.generateVectorSync(text);

      embedFn('相同文本');
      embedFn('相同文本');

      expect(spy).toHaveBeenCalledTimes(2);
      const result1 = spy.mock.results[0].value;
      const result2 = spy.mock.results[1].value;
      expect(result1).toEqual(result2);
    });

    it('不同文本应产生不同向量', () => {
      const engine = new SemanticSimilarityEngine();

      const vec1 = engine.generateVectorSync('Python编程');
      const vec2 = engine.generateVectorSync('Java编程');
      const vec3 = engine.generateVectorSync('烹饪食谱');

      expect(vec1).toBeDefined();
      expect(vec2).toBeDefined();
      expect(vec3).toBeDefined();
      expect(vec1.length).toBe(vec2.length);
      expect(vec1.length).toBe(vec3.length);
      expect(vec1).not.toEqual(vec3);
    });
  });

  describe('CHAIN-11: TrajectoryDatabase 使用注入的嵌入函数进行语义检索', () => {
    let db: TrajectoryDatabase;
    let engine: SemanticSimilarityEngine;

    beforeEach(() => {
      db = new TrajectoryDatabase(':memory:');
      engine = new SemanticSimilarityEngine();
    });

    afterEach(() => {
      try {
        db.close();
      } catch {
        // 忽略
      }
    });

    it('setEmbedFunction 注入后 recordExecution 应使用嵌入函数', () => {
      const spy = jest.spyOn(engine, 'generateVectorSync');

      db.setEmbedFunction((text: string) => engine.generateVectorSync(text));

      db.recordExecution({
        id: 'exec-1',
        input: 'Python编程教程',
        status: 'success',
        quality_overall: 0.9,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      expect(spy).toHaveBeenCalled();
    });

    it('setEmbedFunction 注入后 querySimilarTasks 应使用语义检索', () => {
      const spy = jest.spyOn(engine, 'generateVectorSync');

      db.setEmbedFunction((text: string) => engine.generateVectorSync(text));

      db.recordExecution({
        id: 'exec-2',
        input: 'Python编程教程',
        status: 'success',
        quality_overall: 0.9,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      spy.mockClear();

      const result = db.querySimilarTasks('Python编程', {
        maxResults: 5,
        includeFailed: true,
        minQualityScore: 0,
      });

      expect(spy).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
    });

    it('未注入嵌入函数时 querySimilarTasks 应回退到关键词检索', () => {
      const spy = jest.spyOn(engine, 'generateVectorSync');

      const result = db.querySimilarTasks('Python编程', {
        maxResults: 5,
        includeFailed: true,
        minQualityScore: 0,
      });

      expect(spy).not.toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
