import { JiabaixingCore } from '../../src/core/JiabaixingCore';
import { IntegrationLayer } from '../../src/integration/IntegrationLayer';
import { InteractionEngine } from '../../src/interaction/InteractionEngine';
import { MemoryEngine } from '../../src/memory/MemoryEngine';
import { EventBus } from '../../src/shared/EventBus';

describe.skip('系统完整集成测试', () => {
  let integrationLayer: IntegrationLayer;
  let core: JiabaixingCore;
  let memory: MemoryEngine;
  let interaction: InteractionEngine;

  beforeAll(async () => {
    core = new JiabaixingCore();
    memory = new MemoryEngine();
    interaction = new InteractionEngine();

    await core.initialize?.();
    await memory.initialize?.();
    await interaction.initialize?.();

    integrationLayer = new IntegrationLayer(core, memory, interaction);
  });

  afterAll(async () => {
    await integrationLayer.shutdown();
    await memory.shutdown?.();
    await interaction.shutdown?.();
    EventBus.clearTraceHistory?.();
  });

  describe('日常对话场景', () => {
    it('应该成功处理简单问候', async () => {
      const result = await integrationLayer.processUserInput(
        '你好',
        'test_user_1'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.metadata.traceId).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThan(0);
      expect(result.metadata.steps).toHaveLength(4);
      expect(result.metadata.steps.every((step) => step.success)).toBe(true);
    });

    it('应该成功处理情感表达', async () => {
      const result = await integrationLayer.processUserInput(
        '我今天很开心',
        'test_user_1'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.emotion).toBe('开心');
      expect(result.response).toContain('😊');
    });

    it('应该成功处理情感困扰', async () => {
      const result = await integrationLayer.processUserInput(
        '我最近很焦虑',
        'test_user_1'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.emotion).toBe('焦虑');
      expect(result.response).toContain('别担心');
    });

    it('应该成功处理日常咨询', async () => {
      const result = await integrationLayer.processUserInput(
        '今天天气怎么样？',
        'test_user_1'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.metadata.scene?.type).toBe('daily');
    });
  });

  describe('开发场景', () => {
    it('应该成功处理代码生成请求', async () => {
      const result = await integrationLayer.processUserInput(
        '帮我创建一个TypeScript类',
        'test_user_2'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.intent).toBeDefined();
      expect(result.metadata.scene?.type).toBe('development');
    });

    it('应该成功处理代码分析请求', async () => {
      const result = await integrationLayer.processUserInput(
        '分析这个项目的代码结构',
        'test_user_2'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.intent).toBeDefined();
      expect(result.metadata.steps).toHaveLength(4);
    });

    it('应该成功处理重构请求', async () => {
      const result = await integrationLayer.processUserInput(
        '帮我重构这个函数',
        'test_user_2'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
    });

    it('应该成功处理调试请求', async () => {
      const result = await integrationLayer.processUserInput(
        '帮我调试这段代码',
        'test_user_2'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.scene?.type).toBe('development');
    });
  });

  describe('工作场景', () => {
    it('应该成功处理任务管理', async () => {
      const result = await integrationLayer.processUserInput(
        '帮我安排今天的任务',
        'test_user_3'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.scene?.type).toBe('work');
    });

    it('应该成功处理日程安排', async () => {
      const result = await integrationLayer.processUserInput(
        '添加一个会议提醒',
        'test_user_3'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
    });

    it('应该成功处理文档管理', async () => {
      const result = await integrationLayer.processUserInput(
        '帮我整理项目文档',
        'test_user_3'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.steps.every((step) => step.success)).toBe(true);
    });
  });

  describe('多轮对话场景', () => {
    it('应该保持对话上下文', async () => {
      const result1 = await integrationLayer.processUserInput(
        '我叫小明',
        'test_user_4'
      );
      expect(result1.success).toBe(true);

      const result2 = await integrationLayer.processUserInput(
        '我的名字是什么？',
        'test_user_4'
      );
      expect(result2.success).toBe(true);
      expect(result2.response).toContain('小明');
    });

    it('应该理解上下文引用', async () => {
      const result1 = await integrationLayer.processUserInput(
        '创建一个用户类',
        'test_user_5'
      );
      expect(result1.success).toBe(true);

      const result2 = await integrationLayer.processUserInput(
        '添加一个登录方法',
        'test_user_5'
      );
      expect(result2.success).toBe(true);
    });

    it('应该处理连续的情感变化', async () => {
      const result1 = await integrationLayer.processUserInput(
        '我很生气',
        'test_user_6'
      );
      expect(result1.success).toBe(true);
      expect(result1.metadata.emotion).toBe('生气');

      const result2 = await integrationLayer.processUserInput(
        '现在好多了',
        'test_user_6'
      );
      expect(result2.success).toBe(true);
      expect(result2.metadata.emotion).toBe('平静');
    });
  });

  describe('错误处理场景', () => {
    it('应该处理空输入', async () => {
      const result = await integrationLayer.processUserInput('', 'test_user_7');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('应该处理超长输入', async () => {
      const longInput = 'a'.repeat(10000);
      const result = await integrationLayer.processUserInput(
        longInput,
        'test_user_7'
      );

      expect(result).toBeDefined();
    });

    it('应该处理特殊字符', async () => {
      const result = await integrationLayer.processUserInput(
        '测试特殊字符：@#$%^&*()',
        'test_user_7'
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
    });
  });

  describe('性能测试', () => {
    it('应该在合理时间内完成简单请求', async () => {
      const startTime = Date.now();
      const result = await integrationLayer.processUserInput(
        '你好',
        'test_user_8'
      );
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000);
    });

    it('应该处理并发请求', async () => {
      const requests = Array.from({ length: 5 }, (_, i) =>
        integrationLayer.processUserInput(`测试请求${i}`, 'test_user_9')
      );

      const results = await Promise.all(requests);

      expect(results.every((r) => r.success)).toBe(true);
    });

    it('应该保持稳定的响应时间', async () => {
      const durations: number[] = [];

      for (let i = 0; i < 5; i++) {
        const startTime = Date.now();
        const result = await integrationLayer.processUserInput(
          '测试性能',
          'test_user_10'
        );
        const duration = Date.now() - startTime;

        expect(result.success).toBe(true);
        durations.push(duration);
      }

      const avgDuration =
        durations.reduce((a, b) => a + b, 0) / durations.length;
      const maxDuration = Math.max(...durations);
      const minDuration = Math.min(...durations);

      expect(maxDuration - minDuration).toBeLessThan(avgDuration * 0.5);
    });
  });

  describe('追踪和监控', () => {
    it('应该正确追踪每个步骤', async () => {
      const result = await integrationLayer.processUserInput(
        '测试追踪',
        'test_user_11'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.steps).toHaveLength(4);
      expect(result.metadata.steps[0].name).toBe('core_processing');
      expect(result.metadata.steps[1].name).toBe('memory_retrieval');
      expect(result.metadata.steps[2].name).toBe('interaction_generation');
      expect(result.metadata.steps[3].name).toBe('memory_storage');
    });

    it('应该提供详细的追踪信息', async () => {
      const result = await integrationLayer.processUserInput(
        '测试追踪信息',
        'test_user_11'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.traceId).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThan(0);
      expect(result.metadata.steps.every((step) => step.duration > 0)).toBe(
        true
      );
    });

    it('应该正确记录错误', async () => {
      const result = await integrationLayer.processUserInput(
        '',
        'test_user_12'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.metadata.traceId).toBeDefined();
    });

    it('应该提供整合统计信息', () => {
      const stats = integrationLayer.getIntegrationStatistics();

      expect(stats).toBeDefined();
      expect(stats.totalTraces).toBeGreaterThan(0);
      expect(stats.successRate).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeLessThanOrEqual(1);
      expect(stats.averageDuration).toBeGreaterThan(0);
    });
  });

  describe('记忆和上下文', () => {
    it('应该正确存储和检索记忆', async () => {
      const result1 = await integrationLayer.processUserInput(
        '我喜欢编程',
        'test_user_13'
      );
      expect(result1.success).toBe(true);

      const result2 = await integrationLayer.processUserInput(
        '我的爱好是什么？',
        'test_user_13'
      );
      expect(result2.success).toBe(true);
      expect(result2.response).toContain('编程');
    });

    it('应该提供记忆上下文', async () => {
      const result = await integrationLayer.processUserInput(
        '测试记忆上下文',
        'test_user_14'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.memoryContext).toBeDefined();
      expect(Array.isArray(result.metadata.memoryContext)).toBe(true);
    });

    it('应该区分不同用户的记忆', async () => {
      const result1 = await integrationLayer.processUserInput(
        '我是用户A',
        'user_a'
      );
      expect(result1.success).toBe(true);

      const result2 = await integrationLayer.processUserInput(
        '我是用户B',
        'user_b'
      );
      expect(result2.success).toBe(true);

      const result3 = await integrationLayer.processUserInput(
        '我是谁？',
        'user_a'
      );
      expect(result3.success).toBe(true);
      expect(result3.response).toContain('用户A');
    });
  });

  describe('人设和情感', () => {
    it('应该根据情感调整响应', async () => {
      const happyResult = await integrationLayer.processUserInput(
        '我很开心',
        'test_user_15'
      );
      expect(happyResult.success).toBe(true);
      expect(happyResult.metadata.emotion).toBe('开心');
      expect(happyResult.response).toContain('😊');

      const sadResult = await integrationLayer.processUserInput(
        '我很伤心',
        'test_user_15'
      );
      expect(sadResult.success).toBe(true);
      expect(sadResult.metadata.emotion).toBe('难过');
      expect(sadResult.response).toContain('抱抱你');
    });

    it('应该保持人设一致性', async () => {
      const results = await Promise.all([
        integrationLayer.processUserInput('你好', 'test_user_16'),
        integrationLayer.processUserInput('帮我写代码', 'test_user_16'),
        integrationLayer.processUserInput('今天天气怎么样', 'test_user_16'),
      ]);

      expect(results.every((r) => r.success)).toBe(true);
      expect(results.every((r) => r.metadata.persona)).toBe(true);
    });

    it('应该计算响应置信度', async () => {
      const result = await integrationLayer.processUserInput(
        '测试置信度',
        'test_user_17'
      );

      expect(result.success).toBe(true);
      expect(result.metadata.confidence).toBeDefined();
      expect(result.metadata.confidence).toBeGreaterThan(0);
      expect(result.metadata.confidence).toBeLessThanOrEqual(1);
    });
  });
});
