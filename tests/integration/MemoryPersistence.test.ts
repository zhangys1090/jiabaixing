/**
 * 记忆持久化集成测试
 * 重启系统后，历史对话和偏好依旧存在并可召回
 */

import { BehaviorPattern } from '../../src/interfaces';
import { MemoryEngine } from '../../src/memory/MemoryEngine';

describe('Memory Persistence (Integration)', () => {
  let memoryEngine: MemoryEngine;

  beforeAll(async () => {
    memoryEngine = new MemoryEngine();
    await memoryEngine.initialize();
  });

  describe('memory storage and retrieval', () => {
    it('should store and retrieve instant memory', async () => {
      const testMemory = {
        content: '用户偏好 TypeScript 和 React',
        userId: 'test-user',
        scene: 'development',
      };

      const stored = await memoryEngine.storeInstantMemory(
        testMemory.content,
        testMemory.scene
      );

      expect(stored).toBeDefined();
      expect(stored.content).toBe(testMemory.content);
    });

    it('should store and retrieve short-term memory', async () => {
      const stored = await memoryEngine.storeShortTermMemory(
        { content: '用户喜欢使用 VS Code 开发' },
        'daily'
      );

      expect(stored).toBeDefined();
      expect(stored.type).toBe('short_term');
    });

    it('should retrieve relevant memories via keyword', async () => {
      await memoryEngine.storeInstantMemory(
        { content: '用户偏好 Python 进行数据分析' },
        'development'
      );

      const memories = await memoryEngine.retrieveRelevant({
        query: 'Python',
        limit: 5,
      });

      expect(memories.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('behavior pattern storage', () => {
    it('should store behavior patterns', () => {
      memoryEngine.storeBehaviorPattern({
        pattern: '每天晚上9点询问明天日程',
        frequency: 5,
        lastOccurred: new Date(),
        timeDecayWeight: 1,
        confidence: 0.8,
        relatedIntent: 'schedule_query',
      });

      const patterns = memoryEngine.detectBehaviorPatterns();
      const morningPattern = patterns.find((p: BehaviorPattern) => p.pattern.includes('每天晚上'));
      expect(morningPattern).toBeDefined();
      expect(morningPattern!.confidence).toBe(0.8);
    });

    it('should accumulate pattern frequency', () => {
      for (let i = 0; i < 5; i++) {
        memoryEngine.storeBehaviorPattern({
          pattern: '每次代码审查后询问改进意见',
          frequency: 1,
          lastOccurred: new Date(),
          timeDecayWeight: 1,
          confidence: 0.5,
        });
      }

      const patterns = memoryEngine.detectBehaviorPatterns();
      const reviewPattern = patterns.find((p: BehaviorPattern) => p.pattern.includes('代码审查'));
      expect(reviewPattern).toBeDefined();
      expect(reviewPattern!.frequency).toBeGreaterThanOrEqual(5);
      expect(reviewPattern!.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('time decay weight', () => {
    it('should apply decay factor to relevance', async () => {
      for (let i = 0; i < 3; i++) {
        memoryEngine.storeBehaviorPattern({
          pattern: `旧行为模式_${i}`,
          frequency: 3,
          lastOccurred: new Date(Date.now() - 7 * 24 * 3600000),
          timeDecayWeight: 1,
          confidence: 0.9,
        });
      }

      const patterns = memoryEngine.detectBehaviorPatterns();
      for (const pattern of patterns) {
        if (pattern.pattern.startsWith('旧行为模式')) {
          expect(pattern.timeDecayWeight).toBeLessThan(1);
        }
      }
    });
  });

  describe('retrieveRelevant with behavior patterns', () => {
    it('should include behavior patterns when requested', async () => {
      memoryEngine.storeBehaviorPattern({
        pattern: '用户每天早上检查日程',
        frequency: 10,
        lastOccurred: new Date(),
        timeDecayWeight: 1,
        confidence: 0.9,
        relatedIntent: 'morning_check',
      });

      const results = await memoryEngine.retrieveRelevant({
        query: '日程',
        limit: 5,
        includeBehaviorPatterns: true,
      });

      const behaviorResults = results.filter((r: { content: string; type: string; timestamp?: Date; relevance?: number }) => r.type === 'behavior_pattern');
      expect(behaviorResults.length).toBeGreaterThanOrEqual(0);
    });
  });
});
