import { JiabaixingCore } from '../../src/core/JiabaixingCore';
import { IntegrationLayer } from '../../src/integration/IntegrationLayer';
import { InteractionEngine } from '../../src/interaction/InteractionEngine';
import { MemoryEngine } from '../../src/memory/MemoryEngine';
import { EventBus } from '../../src/shared/EventBus';

describe('整合层基础功能测试', () => {
  let integrationLayer: IntegrationLayer;
  let core: JiabaixingCore;
  let memory: MemoryEngine;
  let interaction: InteractionEngine;

  beforeAll(async () => {
    core = new JiabaixingCore();
    memory = new MemoryEngine();
    interaction = new InteractionEngine();

    try {
      await core.initialize?.();
    } catch (error) {
      console.log('Core initialization skipped:', error);
    }

    try {
      await memory.initialize?.();
    } catch (error) {
      console.log('Memory initialization skipped:', error);
    }

    try {
      await interaction.initialize?.();
    } catch (error) {
      console.log('Interaction initialization skipped:', error);
    }

    integrationLayer = new IntegrationLayer(core, memory, interaction);
  });

  afterAll(async () => {
    try {
      await integrationLayer.shutdown();
    } catch (error) {
      console.log('IntegrationLayer shutdown skipped:', error);
    }

    try {
      await memory.shutdown?.();
    } catch (error) {
      console.log('Memory shutdown skipped:', error);
    }

    try {
      await interaction.shutdown?.();
    } catch (error) {
      console.log('Interaction shutdown skipped:', error);
    }

    EventBus.clearTraceHistory?.();
  });

  describe('基础功能', () => {
    it('应该成功处理简单问候', async () => {
      const result = await integrationLayer.processUserInput(
        '你好',
        'test_user'
      );

      expect(result).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata.traceId).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThanOrEqual(0);
      expect(result.metadata.steps).toBeDefined();
    });

    it('应该正确追踪执行步骤', async () => {
      const result = await integrationLayer.processUserInput(
        '测试追踪',
        'test_user'
      );

      expect(result.metadata.steps).toBeDefined();
      expect(result.metadata.steps.length).toBeGreaterThan(0);
    });

    it('应该提供整合统计信息', () => {
      const stats = integrationLayer.getIntegrationStatistics();

      expect(stats).toBeDefined();
      expect(stats.totalTraces).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeLessThanOrEqual(1);
    });
  });

  describe('错误处理', () => {
    it('应该处理空输入', async () => {
      const result = await integrationLayer.processUserInput('', 'test_user');

      expect(result).toBeDefined();
      expect(result.metadata).toBeDefined();
    });

    it('应该处理超长输入', async () => {
      const longInput = 'a'.repeat(1000);
      const result = await integrationLayer.processUserInput(
        longInput,
        'test_user'
      );

      expect(result).toBeDefined();
    });
  });

  describe('性能测试', () => {
    it('应该在合理时间内完成请求', async () => {
      const startTime = Date.now();
      const result = await integrationLayer.processUserInput(
        '测试性能',
        'test_user'
      );
      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(duration).toBeLessThan(10000);
    });

    it('应该处理连续请求', async () => {
      const result1 = await integrationLayer.processUserInput(
        '请求1',
        'test_user'
      );
      const result2 = await integrationLayer.processUserInput(
        '请求2',
        'test_user'
      );

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result1.metadata.traceId).not.toBe(result2.metadata.traceId);
    });
  });

  describe('追踪功能', () => {
    it('应该生成唯一的追踪ID', async () => {
      const result1 = await integrationLayer.processUserInput(
        '测试1',
        'test_user'
      );
      const result2 = await integrationLayer.processUserInput(
        '测试2',
        'test_user'
      );

      expect(result1.metadata.traceId).toBeDefined();
      expect(result2.metadata.traceId).toBeDefined();
      expect(result1.metadata.traceId).not.toBe(result2.metadata.traceId);
    });

    it('应该记录每个步骤的执行时间', async () => {
      const result = await integrationLayer.processUserInput(
        '测试步骤时间',
        'test_user'
      );

      expect(result.metadata.steps).toBeDefined();
      result.metadata.steps.forEach((step) => {
        expect(step.duration).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('EventBus集成', () => {
    it('应该正确使用EventBus追踪', async () => {
      const initialStats = EventBus.getTraceStatistics?.();

      await integrationLayer.processUserInput('测试EventBus', 'test_user');

      const finalStats = EventBus.getTraceStatistics?.();

      expect(finalStats).toBeDefined();
      expect(finalStats.totalTraces).toBeGreaterThanOrEqual(
        initialStats?.totalTraces || 0
      );
    });
  });
});
