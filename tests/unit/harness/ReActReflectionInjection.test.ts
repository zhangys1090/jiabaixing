import { LoopController } from '../../../src/harness/loop/LoopController';

describe('ReAct循环 — 反思结论深度注入Thought', () => {
  it('应在ReAct循环的Thought阶段注入上一轮反思结论', () => {
    const mockDeps = {
      planner: {
        plan: jest.fn().mockResolvedValue({ steps: [{ tool: 'test' }] }),
      },
      executor: {
        execute: jest.fn().mockResolvedValue({ success: true, output: 'ok' }),
      },
      evaluator: {
        evaluate: jest
          .fn()
          .mockResolvedValue({
            goalProgress: 0.5,
            suggestedAction: 'continue',
          }),
      },
      reflectionEngine: {
        reflect: jest.fn().mockResolvedValue({
          rootCause: '参数路径错误',
          correctedArgs: { path: '/correct/path' },
          shouldRetry: true,
        }),
        deepReflect: jest.fn().mockResolvedValue({
          diagnosis: '需要更换工具',
          fixStrategy: '使用file_search替代',
        }),
      },
      contextManager: {
        buildContext: jest.fn().mockReturnValue({ messages: [] }),
        compressHistory: jest.fn(),
      },
      toolRegistry: { getRegisteredToolNames: jest.fn().mockReturnValue([]) },
      complexityAnalyzer: {
        analyzeComplexity: jest.fn().mockReturnValue('medium'),
      },
      stateManager: { transition: jest.fn() },
      permissionGuard: {
        check: jest
          .fn()
          .mockReturnValue({ allowed: true, missing: [], reason: undefined }),
      },
    } as any;

    const controller = new LoopController(mockDeps);

    // 模拟上一轮反思结论
    controller['_lastReflectionInsight'] = {
      rootCause: '参数路径错误',
      correctedArgs: { path: '/correct/path' },
      shouldRetry: true,
      diagnosis: '需要更换工具',
      fixStrategy: '使用file_search替代',
    };

    // 执行一轮循环
    const thoughtPrompt = controller['buildThoughtPrompt']({
      userInput: '读取文件',
      currentStep: { tool: 'file_read', args: { path: '/wrong/path' } },
    });

    // 验证Thought阶段包含反思结论
    expect(thoughtPrompt).toContain('参数路径错误');
    expect(thoughtPrompt).toContain('使用file_search替代');
    expect(thoughtPrompt).toContain('/correct/path');
  });

  it('应在无反思结论时正常构建Thought', () => {
    const mockDeps = {
      planner: { plan: jest.fn().mockResolvedValue({ steps: [] }) },
      executor: { execute: jest.fn() },
      evaluator: { evaluate: jest.fn() },
      contextManager: {
        buildContext: jest.fn().mockReturnValue({ messages: [] }),
        compressHistory: jest.fn(),
      },
      toolRegistry: { getRegisteredToolNames: jest.fn().mockReturnValue([]) },
      complexityAnalyzer: {
        analyzeComplexity: jest.fn().mockReturnValue('medium'),
      },
      stateManager: { transition: jest.fn() },
      permissionGuard: {
        check: jest
          .fn()
          .mockReturnValue({ allowed: true, missing: [], reason: undefined }),
      },
    } as any;

    const controller = new LoopController(mockDeps);
    controller['_lastReflectionInsight'] = null;

    const thoughtPrompt = controller['buildThoughtPrompt']({
      userInput: '读取文件',
      currentStep: { tool: 'file_read', args: { path: '/test' } },
    });

    expect(thoughtPrompt).not.toContain('上一轮反思');
    expect(thoughtPrompt).toContain('读取文件');
  });

  it('应在反思触发后保存结论供下一轮使用', async () => {
    const mockDeps = {
      planner: {
        plan: jest.fn().mockResolvedValue({ steps: [{ tool: 'file_read' }] }),
      },
      executor: {
        execute: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'not found' }),
      },
      evaluator: {
        evaluate: jest
          .fn()
          .mockResolvedValue({
            goalProgress: 0.2,
            suggestedAction: 'continue',
          }),
      },
      reflectionEngine: {
        reflect: jest.fn().mockResolvedValue({
          rootCause: '路径不存在',
          correctedArgs: { path: '/new/path' },
          shouldRetry: true,
        }),
      },
      contextManager: {
        buildContext: jest.fn().mockReturnValue({ messages: [] }),
        compressHistory: jest.fn(),
      },
      toolRegistry: { getRegisteredToolNames: jest.fn().mockReturnValue([]) },
      complexityAnalyzer: {
        analyzeComplexity: jest.fn().mockReturnValue('medium'),
      },
      stateManager: { transition: jest.fn() },
      permissionGuard: {
        check: jest
          .fn()
          .mockReturnValue({ allowed: true, missing: [], reason: undefined }),
      },
    } as any;

    const controller = new LoopController(mockDeps);

    // 触发反思
    await controller['triggerReflectionIfNeeded']({
      userInput: '读取文件',
      toolResult: { success: false, error: 'not found' },
      loopCount: 1,
    });

    // 验证反思结论已保存
    expect(controller['_lastReflectionInsight']).not.toBeNull();
    expect(controller['_lastReflectionInsight']!.rootCause).toBe('路径不存在');
  });
});
