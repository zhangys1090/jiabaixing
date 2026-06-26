/**
 * 规划能力 — 步骤级精细调整测试
 *
 * P4: 步骤级精细调整 — suggestStepAdjustment 方法
 * 调整动作：continue / skip / modify / insert / terminate
 */
describe('规划能力 — 步骤级精细调整', () => {
  let executor: any;

  beforeEach(() => {
    const Executor = require('../../../src/harness/loop/Executor').Executor;
    const mockDeps = {
      toolRegistry: {
        execute: jest.fn(),
        get: jest.fn(),
        getRegisteredToolNames: jest.fn().mockReturnValue([]),
      },
      llm: { chat: jest.fn(), chatWithTools: jest.fn() },
    };
    executor = new Executor(mockDeps);
  });

  it('应在步骤失败时建议跳过当前步骤', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: false, error: 'file not found' },
      remainingSteps: [
        { tool: 'file_read', args: { path: '/test' } },
        { tool: 'web_search', args: { query: 'test' } },
      ],
      loopCount: 2,
    });

    expect(adjustment.action).toBe('skip');
    expect(adjustment.reason).toContain('跳过');
  });

  it('应在步骤成功但质量低时建议修正后续步骤参数', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: true, output: '部分结果', quality: 0.3 },
      remainingSteps: [{ tool: 'file_read', args: { path: '/test' } }],
      loopCount: 3,
    });

    expect(adjustment.action).toBe('modify');
    expect(adjustment.modificationHint).toBeDefined();
  });

  it('应在步骤成功且质量高时建议继续执行', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: true, output: '完整结果', quality: 0.9 },
      remainingSteps: [{ tool: 'file_read', args: { path: '/test' } }],
      loopCount: 1,
    });

    expect(adjustment.action).toBe('continue');
  });

  it('应在轮次耗尽时建议终止', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: false, error: 'timeout' },
      remainingSteps: [],
      loopCount: 7,
    });

    expect(adjustment.action).toBe('terminate');
  });

  it('应在连续失败时建议插入新步骤', () => {
    executor['executionQualityHistory'] = [
      { score: 0, isSufficient: false },
      { score: 0, isSufficient: false },
    ];

    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: false, error: 'not found' },
      remainingSteps: [{ tool: 'file_read', args: {} }],
      loopCount: 3,
    });

    expect(adjustment.action).toBe('insert');
    expect(adjustment.newStep).toBeDefined();
    expect(adjustment.newStep.tool).toBeDefined();
  });
});
