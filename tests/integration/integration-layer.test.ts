import { JiabaixingCore } from '../../src/core/JiabaixingCore';
import { IntegrationLayer } from '../../src/integration/IntegrationLayer';
import { InteractionEngine } from '../../src/interaction/InteractionEngine';
import { MemoryEngine } from '../../src/memory/MemoryEngine';
import EventBus from '../../src/shared/EventBus';
import { Logger } from '../../src/utils/Logger';

describe('整合层测试', () => {
  let integrationLayer: IntegrationLayer;
  let core: JiabaixingCore;
  let memory: MemoryEngine;
  let interaction: InteractionEngine;

  beforeAll(async () => {
    await EventBus.startTrace?.('test_setup', 'integration_test_setup');

    core = new JiabaixingCore();
    memory = new MemoryEngine();
    interaction = new InteractionEngine();

    await core.initialize();
    await memory.initialize();
    await interaction.initialize();

    integrationLayer = new IntegrationLayer(core, memory, interaction);

    EventBus.completeTrace?.('test_setup', true);
  });

  afterAll(async () => {
    await integrationLayer.shutdown();
    await memory.shutdown();
    await interaction.shutdown();
    EventBus.clearTraceHistory?.();
  });

  describe('基础功能测试', () => {
    it('应该成功处理简单问候', async () => {
      const result = await integrationLayer.processUserInput(
        '你好',
        'test_user'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.metadata.traceId).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThan(0);
      expect(result.metadata.steps).toHaveLength(4);
    });

    it('应该成功处理开发相关问题', async () => {
      const result = await integrationLayer.processUserInput(
        '帮我创建一个TypeScript类',
        'test_user'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.metadata.scene?.type).toBe('development');
    });

    it('应该成功处理情绪相关输入', async () => {
      const result = await integrationLayer.processUserInput(
        '我今天工作很累，感觉很焦虑',
        'test_user'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.metadata.emotion).toBe('焦虑');
      expect(result.metadata.persona).toBe('御姐秘书');
    });

    it('应该记录每个步骤的执行时间', async () => {
      const result = await integrationLayer.processUserInput(
        '测试性能追踪',
        'test_user'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.steps).toHaveLength(4);

      for (const step of result.metadata.steps) {
        expect(step.name).toBeDefined();
        expect(step.duration).toBeGreaterThanOrEqual(0);
        expect(step.success).toBe(true);
      }
    });

    it('应该正确处理错误情况', async () => {
      const result = await integrationLayer.processUserInput('', 'test_user');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThan(0);
    });
  });

  describe('EventBus追踪测试', () => {
    it('应该正确追踪完整的数据流', async () => {
      const traceId = Logger.generateTraceId();
      await integrationLayer.processUserInput('测试追踪功能', 'test_user');

      const history = EventBus.getTraceHistory?.(undefined, 10) || [];
      expect(history.length).toBeGreaterThan(0);

      const integrationTrace = history.find((t: any) => t.traceId === traceId);
      expect(integrationTrace).toBeDefined();
    });

    it('应该提供准确的统计信息', async () => {
      await integrationLayer.processUserInput('测试统计1', 'test_user');
      await integrationLayer.processUserInput('测试统计2', 'test_user');
      await integrationLayer.processUserInput('测试统计3', 'test_user');

      const stats = integrationLayer.getIntegrationStatistics();

      expect(stats.totalTraces).toBeGreaterThan(0);
      expect(stats.successRate).toBeGreaterThan(0);
      expect(stats.averageDuration).toBeGreaterThan(0);
      expect(stats.eventNameStats).toBeDefined();
    });
  });

  describe('记忆集成测试', () => {
    it('应该正确存储和检索记忆', async () => {
      const testInput = '我喜欢用TypeScript开发';
      const result = await integrationLayer.processUserInput(
        testInput,
        'test_user'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.memoryContext).toBeDefined();

      const memoryResult = await memory.retrieveWithTracking(
        'TypeScript',
        undefined,
        undefined,
        5
      );
      expect(memoryResult.success).toBe(true);
    });

    it('应该验证记忆数据的有效性', async () => {
      const validMemory = {
        id: 'test_123',
        type: 'short_term' as any,
        content: '测试内容',
        timestamp: new Date(),
      };

      const validation = (memory as any).validateItem(validMemory);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  describe('交互智能性测试', () => {
    it('应该根据情感调整响应', async () => {
      const happyResult = await integrationLayer.processUserInput(
        '我今天很开心',
        'test_user'
      );
      const sadResult = await integrationLayer.processUserInput(
        '我今天很难过',
        'test_user'
      );

      expect(happyResult.success).toBe(true);
      expect(sadResult.success).toBe(true);

      expect(happyResult.metadata.emotion).toBe('开心');
      expect(sadResult.metadata.emotion).toBe('难过');

      expect(happyResult.response).toContain('😊');
      expect(sadResult.response).toContain('抱抱');
    });

    it('应该根据场景调整响应', async () => {
      const devResult = await integrationLayer.processUserInput(
        '帮我调试代码',
        'test_user'
      );
      const dailyResult = await integrationLayer.processUserInput(
        '今天天气怎么样',
        'test_user'
      );

      expect(devResult.success).toBe(true);
      expect(dailyResult.success).toBe(true);

      expect(devResult.metadata.scene?.type).toBe('development');
      expect(dailyResult.metadata.scene?.type).toBe('daily');
    });

    it('应该保持人设一致性', async () => {
      const result1 = await integrationLayer.processUserInput(
        '你是谁',
        'test_user'
      );
      const result2 = await integrationLayer.processUserInput(
        '你会什么',
        'test_user'
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      expect(result1.metadata.persona).toBe('御姐秘书');
      expect(result2.metadata.persona).toBe('御姐秘书');
    });
  });

  describe('性能测试', () => {
    it('应该在合理时间内完成处理', async () => {
      const startTime = Date.now();
      const result = await integrationLayer.processUserInput(
        '性能测试',
        'test_user'
      );
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000);
    });

    it('应该能够处理并发请求', async () => {
      const requests = Array.from({ length: 5 }, (_, i) =>
        integrationLayer.processUserInput(`并发测试${i}`, 'test_user')
      );

      const results = await Promise.all(requests);

      for (const result of results) {
        expect(result.success).toBe(true);
      }
    });
  });
});
