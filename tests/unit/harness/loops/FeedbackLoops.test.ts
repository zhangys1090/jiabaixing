import { FeedbackLoops } from '../../../../src/harness/loops/FeedbackLoops';
import { LifecycleEvent } from '../../../../src/harness/types';

// Mock EvolutionOrchestrator 单例
const mockRecordInteraction = jest.fn();
jest.mock('../../../../src/evolution/EvolutionOrchestrator', () => ({
  EvolutionOrchestrator: {
    getInstance: () => ({
      recordInteraction: mockRecordInteraction,
    }),
  },
}));

// Mock PreferenceManager 单例
const mockApplyCorrection = jest.fn().mockReturnValue(null);
jest.mock('../../../../src/memory/PreferenceManager', () => ({
  PreferenceManager: {
    getInstance: () => ({
      applyCorrection: mockApplyCorrection,
    }),
  },
}));

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('FeedbackLoops', () => {
  let feedbackLoops: FeedbackLoops;
  let mockFeedbackCollector: any;
  let mockEvolutionEngine: any;
  let mockMemoryAssistant: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFeedbackCollector = {
      analyzeUserInput: jest.fn().mockReturnValue(null),
      recordToolFailure: jest.fn(),
      recordLowQuality: jest.fn(),
    };

    mockEvolutionEngine = {
      collectFeedback: jest.fn(),
    };

    mockMemoryAssistant = {
      autoExtractKnowledge: jest.fn().mockResolvedValue(undefined),
    };

    feedbackLoops = new FeedbackLoops({
      feedbackCollector: mockFeedbackCollector,
      evolutionEngine: mockEvolutionEngine,
      memoryAssistant: mockMemoryAssistant,
    });
  });

  /** 辅助：构造 AFTER_RESPONSE 钩子上下文 */
  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      event: LifecycleEvent.AFTER_RESPONSE,
      metadata: {
        input: '测试输入',
        response: '测试响应',
        quality: { overall: 0.8 },
        traceId: 'test-trace',
        toolsUsed: [],
        userId: 'test-user',
        trace: { trajectory: [], totalDuration: 100 },
        ...overrides,
      },
    };
  }

  /** 辅助：等待 setImmediate 完成 */
  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  describe('createAFTER_RESPONSEHook', () => {
    it('应该返回 proceed=true', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      const result = await hook(makeCtx() as any);
      expect(result.proceed).toBe(true);
    });

    it('应该在高质量交互后记录进化指标', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(makeCtx({
        input: '帮我写代码',
        response: '这是代码...',
        quality: { overall: 0.9 },
        traceId: 'trace-2',
        userId: 'user-2',
        trace: {
          trajectory: [
            { type: 'tool_call', toolName: 'code_generate', duration: 500 },
            { type: 'tool_result', toolName: 'code_generate', toolResult: { success: true } },
          ],
          totalDuration: 600,
        },
      }) as any);
      await flushMicrotasks();

      expect(mockRecordInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-2',
          input: '帮我写代码',
          response: '这是代码...',
          success: true,
          qualityScore: 0.9,
        })
      );
    });

    it('应该在低质量交互时记录低质量反馈', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(makeCtx({
        input: '测试',
        response: '不好',
        quality: { overall: 0.3 },
        traceId: 'trace-3',
        userId: 'user-3',
      }) as any);
      await flushMicrotasks();

      expect(mockFeedbackCollector.recordLowQuality).toHaveBeenCalledWith(
        '测试',
        '不好',
        0.3,
        'user-3',
        expect.any(String)
      );
    });

    it('应该在工具失败时记录工具失败反馈', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(makeCtx({
        input: '读取文件',
        response: '文件读取失败',
        quality: { overall: 0.6 },
        traceId: 'trace-4',
        userId: 'user-4',
        trace: {
          trajectory: [
            { type: 'tool_call', toolName: 'file_read', duration: 100 },
            { type: 'tool_result', toolName: 'file_read', toolResult: { success: false } },
          ],
          totalDuration: 200,
        },
      }) as any);
      await flushMicrotasks();

      expect(mockFeedbackCollector.recordToolFailure).toHaveBeenCalledWith(
        'file_read',
        '工具执行失败',
        '读取文件',
        'user-4'
      );
    });

    it('应该在用户纠正时触发偏好学习', async () => {
      mockFeedbackCollector.analyzeUserInput.mockReturnValue({
        type: 'correction',
        input: '不对',
        response: '之前的回答',
      });

      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(makeCtx({
        input: '不对，应该是另一个',
        response: '之前的回答',
        previousResponse: '之前的回答',
      }) as any);

      expect(mockFeedbackCollector.analyzeUserInput).toHaveBeenCalled();
      expect(mockEvolutionEngine.collectFeedback).toHaveBeenCalled();
      expect(mockApplyCorrection).toHaveBeenCalledWith('不对，应该是另一个', 'general');
    });

    it('应该触发自动知识提取', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(makeCtx({
        input: '学习一下这个',
        response: '好的',
        userId: 'user-6',
      }) as any);
      await flushMicrotasks();

      expect(mockMemoryAssistant.autoExtractKnowledge).toHaveBeenCalledWith(
        '学习一下这个',
        '好的',
        'user-6'
      );
    });

    it('应该在没有 memoryAssistant 时不报错', async () => {
      const loops = new FeedbackLoops({
        feedbackCollector: mockFeedbackCollector,
      });
      const hook = loops.createAFTER_RESPONSEHook();
      const result = await hook(makeCtx() as any);
      expect(result.proceed).toBe(true);
    });

    it('应该在没有 evolutionEngine 时不报错', async () => {
      mockFeedbackCollector.analyzeUserInput.mockReturnValue({
        type: 'correction',
      });
      const loops = new FeedbackLoops({
        feedbackCollector: mockFeedbackCollector,
      });
      const hook = loops.createAFTER_RESPONSEHook();
      const result = await hook(makeCtx() as any);
      expect(result.proceed).toBe(true);
    });
  });
});
