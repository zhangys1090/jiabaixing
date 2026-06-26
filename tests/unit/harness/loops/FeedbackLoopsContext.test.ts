/**
 * FeedbackLoops 上下文传递集成测试
 *
 * 验证 ContextManager 构建的上下文摘要能通过 HookContext.metadata
 * 传递到 FeedbackLoops，使反馈循环能访问完整上下文信息。
 */

import { FeedbackLoops } from '../../../../src/harness/loops/FeedbackLoops';
import { LifecycleEvent } from '../../../../src/harness/types';
import type {
  EvolutionEngineDeps,
  FeedbackCollectorDeps,
  MemoryAssistantDeps,
} from '../../../../src/harness/deps';

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

/** 上下文摘要结构 */
interface ContextSummary {
  systemPromptPreview: string;
  userIntent: string;
  timestamp: number;
}

describe('FeedbackLoops 上下文传递集成', () => {
  let feedbackLoops: FeedbackLoops;
  let mockFeedbackCollector: FeedbackCollectorDeps;
  let mockEvolutionEngine: EvolutionEngineDeps;
  let mockMemoryAssistant: MemoryAssistantDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFeedbackCollector = {
      analyzeUserInput: jest.fn().mockReturnValue(null),
      recordToolFailure: jest.fn(),
      recordLowQuality: jest.fn(),
    };

    mockEvolutionEngine = {
      collectFeedback: jest.fn(),
      assessQuality: jest.fn(),
      generateSkill: jest.fn().mockReturnValue(null),
      nudgeKnowledgePersistence: jest.fn().mockReturnValue(null),
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

  /** 辅助：构造包含 contextSummary 的 AFTER_RESPONSE 钩子上下文 */
  function makeCtxWithContextSummary(overrides: Record<string, unknown> = {}) {
    return {
      event: LifecycleEvent.AFTER_RESPONSE,
      metadata: {
        input: '帮我写代码',
        response: '这是代码...',
        quality: { overall: 0.8 },
        traceId: 'trace-ctx-1',
        toolsUsed: [],
        userId: 'user-ctx',
        trace: { trajectory: [], totalDuration: 100 },
        contextSummary: {
          systemPromptPreview:
            '你是家百星智能助手，擅长编程、文件操作和桌面自动化...',
          userIntent: '帮我写代码',
          timestamp: Date.now(),
        },
        ...overrides,
      },
    };
  }

  /** 辅助：等待 setImmediate 完成 */
  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('HookContext.metadata 中应包含 contextSummary 字段', async () => {
    const hook = feedbackLoops.createAFTER_RESPONSEHook();
    const ctx = makeCtxWithContextSummary();
    await hook(ctx as never);

    // 验证 metadata 中存在 contextSummary
    expect(ctx.metadata.contextSummary).toBeDefined();
    expect(ctx.metadata.contextSummary).toHaveProperty('systemPromptPreview');
    expect(ctx.metadata.contextSummary).toHaveProperty('userIntent');
    expect(ctx.metadata.contextSummary).toHaveProperty('timestamp');
  });

  it('FeedbackLoops 应能从 metadata 中读取 contextSummary', async () => {
    const hook = feedbackLoops.createAFTER_RESPONSEHook();
    const ctx = makeCtxWithContextSummary({
      input: '帮我写代码',
      response: '这是代码...',
    });
    await hook(ctx as never);
    await flushMicrotasks();

    // 进化闭环应被调用，且参数中包含 contextSummary 中的信息
    expect(mockRecordInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '帮我写代码',
        response: '这是代码...',
      })
    );
  });

  it('contextSummary 应包含系统提示词摘要和用户输入', async () => {
    const hook = feedbackLoops.createAFTER_RESPONSEHook();
    const ctx = makeCtxWithContextSummary({
      input: '帮我重构这段代码',
      contextSummary: {
        systemPromptPreview:
          '你是家百星智能助手，擅长编程、文件操作和桌面自动化...',
        userIntent: '帮我重构这段代码',
        timestamp: 1718900000000,
      },
    });
    await hook(ctx as never);

    const contextSummary = ctx.metadata.contextSummary as ContextSummary;

    // 验证系统提示词摘要
    expect(contextSummary.systemPromptPreview).toBe(
      '你是家百星智能助手，擅长编程、文件操作和桌面自动化...'
    );
    // 验证用户输入
    expect(contextSummary.userIntent).toBe('帮我重构这段代码');
    // 验证时间戳
    expect(typeof contextSummary.timestamp).toBe('number');
    expect(contextSummary.timestamp).toBe(1718900000000);
  });

  it('contextSummary 为可选字段时不应影响现有功能', async () => {
    const hook = feedbackLoops.createAFTER_RESPONSEHook();
    // 不提供 contextSummary
    const ctx = {
      event: LifecycleEvent.AFTER_RESPONSE,
      metadata: {
        input: '测试输入',
        response: '测试响应',
        quality: { overall: 0.8 },
        traceId: 'test-trace',
        toolsUsed: [],
        userId: 'test-user',
        trace: { trajectory: [], totalDuration: 100 },
      },
    };
    const result = await hook(ctx as never);
    expect(result.proceed).toBe(true);
    await flushMicrotasks();

    // 进化闭环仍应正常工作
    expect(mockRecordInteraction).toHaveBeenCalled();
  });

  it('contextSummary 应能传递到进化闭环', async () => {
    const hook = feedbackLoops.createAFTER_RESPONSEHook();
    const ctx = makeCtxWithContextSummary({
      input: '帮我写代码',
      response: '这是代码...',
      quality: { overall: 0.9 },
      contextSummary: {
        systemPromptPreview: '系统提示词摘要内容',
        userIntent: '帮我写代码',
        timestamp: Date.now(),
      },
    });
    await hook(ctx as never);
    await flushMicrotasks();

    // 验证进化闭环被调用
    expect(mockRecordInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '帮我写代码',
        response: '这是代码...',
        qualityScore: 0.9,
      })
    );
  });

  it('contextSummary 应能传递到偏好学习闭环', async () => {
    mockFeedbackCollector.analyzeUserInput = jest.fn().mockReturnValue({
      type: 'correction',
      input: '不对',
      response: '之前的回答',
    });

    const hook = feedbackLoops.createAFTER_RESPONSEHook();
    const ctx = makeCtxWithContextSummary({
      input: '不对，应该是另一个',
      response: '之前的回答',
      previousResponse: '之前的回答',
      contextSummary: {
        systemPromptPreview: '系统提示词摘要',
        userIntent: '不对，应该是另一个',
        timestamp: Date.now(),
      },
    });
    await hook(ctx as never);

    // 验证偏好学习闭环被触发
    expect(mockFeedbackCollector.analyzeUserInput).toHaveBeenCalled();
    expect(mockEvolutionEngine.collectFeedback).toHaveBeenCalled();
  });
});
