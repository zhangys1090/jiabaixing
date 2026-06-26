/**
 * Reporter 单元测试
 * 测试循环层报告器的质量评分和响应提取功能
 */
import { Reporter } from '../../../src/harness/loop/Reporter';
import type { LoopContext, StepResult } from '../../../src/harness/types';
import { LoopState } from '../../../src/harness/types';

function createMockContext(overrides: Partial<LoopContext> = {}): LoopContext {
  const now = Date.now();
  return {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ],
    plan: null,
    currentStepIndex: 0,
    stepResults: new Map<string, StepResult>(),
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    budget: {
      roundsUsed: 1,
      softRoundLimit: 10,
      hardRoundLimit: 20,
      tokensUsed: 100,
      tokenWarningLimit: 2000,
      tokenHardLimit: 4000,
      startTime: now,
      maxDurationMs: 60000,
      toolCallsUsed: 1,
      maxToolCalls: 10,
    },
    trace: {
      traceId: 'test-trace-001',
      state: LoopState.COMPLETED,
      stateTransitions: [],
      trajectory: [],
      totalDuration: 0,
      totalToolCalls: 0,
      budgetState: {
        roundsUsed: 1,
        softRoundLimit: 10,
        hardRoundLimit: 20,
        tokensUsed: 100,
        tokenWarningLimit: 2000,
        tokenHardLimit: 4000,
        startTime: now,
        maxDurationMs: 60000,
        toolCallsUsed: 1,
        maxToolCalls: 10,
      },
    },
    metadata: {},
    stepStates: new Map(),
    stepStateHistory: [],
    ...overrides,
  };
}

describe('Reporter', () => {
  let reporter: Reporter;

  beforeEach(() => {
    reporter = new Reporter();
  });

  describe('基本功能', () => {
    it('应该正确初始化', () => {
      expect(reporter).toBeInstanceOf(Reporter);
    });
  });

  describe('report', () => {
    it('应该从 assistant 消息中提取响应', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好！有什么可以帮你的吗？' },
        ],
      });
      const output = await reporter.report(context);
      expect(output.response).toBe('你好！有什么可以帮你的吗？');
      expect(output.quality).toBeDefined();
    });

    it('应该从最后一条非 system 消息中提取响应（降级）', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '请计算 1+1' },
          { role: 'user', content: '答案是 2' },
        ],
      });
      const output = await reporter.report(context);
      expect(output.response).toBe('答案是 2');
    });

    it('应该在无可用消息时返回降级文本', async () => {
      const context = createMockContext({
        messages: [{ role: 'system', content: '你是一个助手' }],
      });
      const output = await reporter.report(context);
      expect(output.response).toBe('抱歉，我无法处理您的请求。');
    });
  });

  describe('质量评分', () => {
    it('任务自然完成时 overall 应较高', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '帮我搜索信息' },
          { role: 'assistant', content: '已完成搜索，找到以下结果...' },
        ],
        trace: {
          ...createMockContext().trace,
          state: LoopState.COMPLETED,
        },
      });
      const output = await reporter.report(context);
      expect(output.quality.overall).toBeGreaterThanOrEqual(0.7);
    });

    it('任务预算超时时应降低评分', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '帮我搜索信息' },
          { role: 'assistant', content: '部分结果...' },
        ],
        trace: {
          ...createMockContext().trace,
          state: LoopState.BUDGET_EXCEEDED,
        },
      });
      const output = await reporter.report(context);
      // 预算超时降低 0.3
      expect(output.quality.overall).toBeLessThanOrEqual(0.8);
    });

    it('工具执行成功率应影响 accuracy 评分', async () => {
      const stepResults = new Map<string, StepResult>();
      stepResults.set('step-1', {
        stepId: 'step-1',
        success: true,
        output: 'ok',
        duration: 100,
      });
      stepResults.set('step-2', {
        stepId: 'step-2',
        success: false,
        output: '',
        duration: 50,
        error: '工具执行失败',
      });

      const context = createMockContext({ stepResults });
      const output = await reporter.report(context);
      // 50% 成功率, accuracy = overall * (0.5 + 0.5 * 0.5) = overall * 0.75
      expect(output.quality.accuracy).toBeGreaterThanOrEqual(0.1);
      expect(output.quality.accuracy).toBeLessThanOrEqual(1.0);
    });

    it('空响应或错误响应应降低 usefulness', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '帮我做件事' },
          { role: 'assistant', content: '抱歉，我无法处理您的请求。' },
        ],
      });
      const output = await reporter.report(context);
      // "抱歉" 文本会降低 usefulness
      expect(output.quality.usefulness).toBeLessThan(0.9);
    });

    it('包含行动性内容的响应应提高 usefulness', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '帮我创建一个文件' },
          {
            role: 'assistant',
            content: '已成功创建文件 example.txt',
          },
        ],
      });
      const output = await reporter.report(context);
      expect(output.quality.usefulness).toBeGreaterThanOrEqual(0.7);
    });

    it('friendliness 应受问候语影响', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '~ 好的，马上帮你处理 😊' },
        ],
      });
      const output = await reporter.report(context);
      expect(output.quality.friendliness).toBeGreaterThanOrEqual(0.8);
    });

    it('should produce valid quality score with details', async () => {
      const context = createMockContext({
        messages: [
          { role: 'user', content: '测试' },
          { role: 'assistant', content: '这是一个测试响应。' },
        ],
      });
      const output = await reporter.report(context);
      const q = output.quality;
      expect(q.overall).toBeGreaterThanOrEqual(0.1);
      expect(q.overall).toBeLessThanOrEqual(1.0);
      expect(q.accuracy).toBeGreaterThanOrEqual(0.1);
      expect(q.usefulness).toBeGreaterThanOrEqual(0.1);
      expect(q.friendliness).toBeGreaterThanOrEqual(0.1);
      expect(q.efficiency).toBeGreaterThanOrEqual(0.1);
      expect(q.details).toBeTruthy();
      expect(typeof q.details).toBe('string');
    });
  });
});
