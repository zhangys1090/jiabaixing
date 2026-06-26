/**
 * 进化知识库测试 (P3-2)
 *
 * 验证核心目标：
 *   - 结构化存储进化经验（触发器、动作、结果）
 *   - 按语义相似度检索历史进化经验
 *   - 提取可复用的进化模式
 *   - 持久化加载/保存
 */

import { EvolutionKnowledgeBase } from '../../../src/evolution/EvolutionKnowledgeBase';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function createMockPersistence() {
  const store = new Map<string, string>();
  return {
    saveEnvironmentState: jest.fn((state: Record<string, unknown>) => {
      store.set('evolution_kb', JSON.stringify(state));
    }),
    loadEnvironmentState: jest.fn((): Record<string, unknown> | null => {
      const data = store.get('evolution_kb');
      return data ? JSON.parse(data) : null;
    }),
  };
}

describe('P3-2: 进化知识库', () => {
  describe('recordEvolutionOutcome', () => {
    it('应结构化存储进化经验', () => {
      const kb = new EvolutionKnowledgeBase();
      kb.recordEvolutionOutcome({
        trigger: {
          type: 'low_quality',
          context: '工具调用失败率过高',
          metrics: { failureRate: 0.6 },
        },
        action: {
          type: 'prompt_adjustment',
          description: '增加工具选择约束提示',
          target: 'Planner',
        },
        outcome: {
          success: true,
          qualityImprovement: 0.15,
          sideEffects: [],
        },
        llmProvider: 'gpt-4o',
      });

      const all = kb.getAllExperiences();
      expect(all).toHaveLength(1);
      expect(all[0].trigger.type).toBe('low_quality');
      expect(all[0].action.description).toContain('工具选择');
      expect(all[0].outcome.qualityImprovement).toBe(0.15);
    });

    it('应限制最大存储数量避免无限增长', () => {
      const kb = new EvolutionKnowledgeBase({ maxExperiences: 5 });
      for (let i = 0; i < 10; i++) {
        kb.recordEvolutionOutcome({
          trigger: { type: 'test', context: `场景${i}`, metrics: {} },
          action: { type: 'test', description: `动作${i}`, target: 'test' },
          outcome: { success: true, qualityImprovement: 0.1, sideEffects: [] },
          llmProvider: 'test',
        });
      }
      expect(kb.getAllExperiences()).toHaveLength(5);
      // 应保留最新的（后5条）
      const all = kb.getAllExperiences();
      expect(all[0].action.description).toBe('动作5');
    });
  });

  describe('findRelevantEvolutionExperience', () => {
    it('应按语义相似度检索历史进化经验', () => {
      const kb = new EvolutionKnowledgeBase();
      kb.recordEvolutionOutcome({
        trigger: {
          type: 'low_quality',
          context: '文件搜索工具调用失败',
          metrics: {},
        },
        action: {
          type: 'prompt_adjustment',
          description: '修正工具名',
          target: 'Planner',
        },
        outcome: { success: true, qualityImprovement: 0.2, sideEffects: [] },
        llmProvider: 'gpt-4o',
      });
      kb.recordEvolutionOutcome({
        trigger: { type: 'timeout', context: '代码执行超时', metrics: {} },
        action: {
          type: 'timeout_adjustment',
          description: '增加超时阈值',
          target: 'Executor',
        },
        outcome: { success: true, qualityImprovement: 0.1, sideEffects: [] },
        llmProvider: 'gpt-4o',
      });

      const relevant = kb.findRelevantEvolutionExperience({
        description: '文件搜索工具调用失败',
        type: 'low_quality',
      });

      expect(relevant.length).toBeGreaterThan(0);
      expect(relevant[0].trigger.context).toContain('文件搜索');
    });

    it('无匹配经验时应返回空数组', () => {
      const kb = new EvolutionKnowledgeBase();
      const relevant = kb.findRelevantEvolutionExperience({
        description: '完全不相关的场景',
        type: 'unknown',
      });
      expect(relevant).toEqual([]);
    });
  });

  describe('extractReusablePatterns', () => {
    it('应从历史经验提取可复用的成功模式', () => {
      const kb = new EvolutionKnowledgeBase();
      // 3次相同类型的成功改进
      for (let i = 0; i < 3; i++) {
        kb.recordEvolutionOutcome({
          trigger: { type: 'low_quality', context: `场景${i}`, metrics: {} },
          action: {
            type: 'prompt_adjustment',
            description: '增加约束提示',
            target: 'Planner',
          },
          outcome: { success: true, qualityImprovement: 0.15, sideEffects: [] },
          llmProvider: 'gpt-4o',
        });
      }

      const patterns = kb.extractReusablePatterns();
      expect(patterns.length).toBeGreaterThan(0);
      const promptPattern = patterns.find((p) =>
        p.actionType.includes('prompt_adjustment')
      );
      expect(promptPattern).toBeDefined();
      expect(promptPattern?.occurrenceCount).toBeGreaterThanOrEqual(3);
      expect(promptPattern?.averageGain).toBeGreaterThan(0);
    });
  });

  describe('持久化', () => {
    it('应保存并加载进化经验', () => {
      const persistence = createMockPersistence();
      const kb = new EvolutionKnowledgeBase({
        persistence: persistence as never,
      });
      kb.recordEvolutionOutcome({
        trigger: { type: 'test', context: '测试', metrics: {} },
        action: { type: 'test', description: '测试动作', target: 'test' },
        outcome: { success: true, qualityImprovement: 0.1, sideEffects: [] },
        llmProvider: 'test',
      });

      kb.save();
      expect(persistence.saveEnvironmentState).toHaveBeenCalled();

      // 新实例加载
      const kb2 = new EvolutionKnowledgeBase({
        persistence: persistence as never,
      });
      kb2.load();
      expect(kb2.getAllExperiences()).toHaveLength(1);
      expect(kb2.getAllExperiences()[0].action.description).toBe('测试动作');
    });
  });
});
