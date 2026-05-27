/**
 * Harness 验证层 + 约束层 单元测试
 */

import {
  VerificationService,
  ConstraintsService,
  PermissionGuard,
} from '../../src/harness';
import { Permission, LifecycleEvent } from '../../src/harness/types';
import type { ToolResult, ToolContext } from '../../src/harness/types';

// ============ VerificationService 测试 ============

describe('VerificationService', () => {
  let service: VerificationService;

  beforeEach(() => {
    service = new VerificationService();
  });

  test('应该验证成功的工具结果', () => {
    const result: ToolResult = {
      success: true,
      output: '操作成功完成',
      duration: 100,
      validated: false,
    };
    const validation = service.validateToolResult('test_tool', result);
    expect(validation.valid).toBe(true);
    expect(validation.sanitizedOutput).toBe('操作成功完成');
  });

  test('应该检测失败的工具结果', () => {
    const result: ToolResult = {
      success: false,
      output: null,
      error: '执行失败',
      duration: 100,
      validated: false,
    };
    const validation = service.validateToolResult('test_tool', result);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  test('应该检测空输出', () => {
    const result: ToolResult = {
      success: true,
      output: '',
      duration: 100,
      validated: false,
    };
    const validation = service.validateToolResult('test_tool', result);
    expect(validation.valid).toBe(false);
  });

  test('应该截断过长输出', () => {
    const result: ToolResult = {
      success: true,
      output: 'x'.repeat(5000),
      duration: 100,
      validated: false,
    };
    const validation = service.validateToolResult('test_tool', result);
    expect(validation.valid).toBe(true);
    expect(validation.autoFixed).toBe(true);
    expect(validation.sanitizedOutput).toContain('截断');
  });

  test('应该检测输出中的错误标记', () => {
    const result: ToolResult = {
      success: true,
      output: 'error: something failed',
      duration: 100,
      validated: false,
    };
    const validation = service.validateToolResult('test_tool', result);
    expect(validation.warnings.length).toBeGreaterThan(0);
  });

  test('应该检测安全输出', () => {
    const check = service.checkOutputSafety('这是一段正常的输出');
    expect(check.safe).toBe(true);
    expect(check.riskLevel).toBe('none');
  });

  test('应该检测敏感信息', () => {
    const check = service.checkOutputSafety('密码: mypassword123');
    expect(check.safe).toBe(false);
    expect(check.riskLevel).toBe('critical');
    expect(check.sanitizedOutput).toContain('脱敏');
  });

  test('应该计算质量评分', () => {
    const score = service.scoreQuality({
      loopCount: 2,
      totalToolCalls: 3,
      totalToolDuration: 5000,
      totalDuration: 10000,
      completedSuccessfully: true,
    });
    expect(score.overall).toBeGreaterThan(0.5);
    expect(score.efficiency).toBeGreaterThan(0.5);
  });

  test('未完成时应降低评分', () => {
    const score = service.scoreQuality({
      loopCount: 6,
      totalToolCalls: 10,
      totalToolDuration: 60000,
      totalDuration: 45000,
      completedSuccessfully: false,
    });
    expect(score.overall).toBeLessThan(0.7);
  });

  test('应该评估目标达成度', async () => {
    const progress = await service.evaluateGoalProgress(
      '帮我查看文件',
      '文件内容如下：...'
    );
    expect(progress.progress).toBeGreaterThan(0);
  });

  test('空输出应标记为未达成', async () => {
    const progress = await service.evaluateGoalProgress(
      '帮我查看文件',
      ''
    );
    expect(progress.achieved).toBe(false);
    expect(progress.progress).toBeLessThan(0.5);
  });
});

// ============ ConstraintsService 测试 ============

describe('ConstraintsService', () => {
  let service: ConstraintsService;
  let permissionGuard: PermissionGuard;

  beforeEach(() => {
    permissionGuard = new PermissionGuard();
    service = new ConstraintsService({ permissionGuard });
  });

  test('应该检查预算是否在范围内', () => {
    const result = service.checkBudget({
      roundsUsed: 2,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 2000,
      tokenWarningLimit: 4500,
      tokenHardLimit: 6000,
      startTime: Date.now() - 5000,
      maxDurationMs: 60000,
      toolCallsUsed: 5,
      maxToolCalls: 20,
    });
    expect(result.withinBudget).toBe(true);
    expect(result.remaining.rounds).toBe(6);
  });

  test('应该检测预算超限', () => {
    const result = service.checkBudget({
      roundsUsed: 8,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 6000,
      tokenWarningLimit: 4500,
      tokenHardLimit: 6000,
      startTime: Date.now() - 70000,
      maxDurationMs: 60000,
      toolCallsUsed: 20,
      maxToolCalls: 20,
    });
    expect(result.withinBudget).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('应该检查权限', () => {
    const context: ToolContext = {
      permissions: new Set([Permission.MEMORY_READ]),
      metadata: {},
    };
    const result = service.checkPermission(
      'memory_recall',
      [Permission.MEMORY_READ],
      'low',
      context
    );
    expect(result.allowed).toBe(true);
  });

  test('应该拒绝缺少权限的操作', () => {
    const context: ToolContext = {
      permissions: new Set([Permission.MEMORY_READ]),
      metadata: {},
    };
    const result = service.checkPermission(
      'desktop_automate',
      [Permission.DESKTOP_CONTROL],
      'high',
      context
    );
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain(Permission.DESKTOP_CONTROL);
  });

  test('应该阻止危险操作', () => {
    const result = service.checkSafetyBoundary('test', 'rm -rf /');
    expect(result.allowed).toBe(false);
  });

  test('应该允许安全操作', () => {
    const result = service.checkSafetyBoundary('test', 'read file');
    expect(result.allowed).toBe(true);
  });

  test('应该注册和执行生命周期钩子', async () => {
    let hookCalled = false;
    service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => {
      hookCalled = true;
      return { proceed: true };
    });

    const result = await service.executeHooks(
      LifecycleEvent.BEFORE_TOOL_CALL,
      { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} }
    );
    expect(result.proceed).toBe(true);
    expect(hookCalled).toBe(true);
  });

  test('钩子可以拦截操作', async () => {
    service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, async () => {
      return { proceed: false, reason: '被钩子拦截' };
    });

    const result = await service.executeHooks(
      LifecycleEvent.BEFORE_TOOL_CALL,
      { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} }
    );
    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('被钩子拦截');
  });

  test('应该检查行为约束', () => {
    const result = service.enforceBehaviorConstraint(
      'no-unbounded-recursion',
      {}
    );
    expect(result.compliant).toBe(true);
  });
});
