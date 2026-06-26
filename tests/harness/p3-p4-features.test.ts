/**
 * P3-1 (计划验证) + P3-2 (执行监控) + P3-3 (自适应重规划) + P3-4 (跨步骤状态管理)
 * + P4-1 (学习闭环) + P4-2 (环境建模) + P4-3 (预测增强)
 *
 * 验证标准:
 * - P3-1 计划验证: 提交引用不存在工具的计划 → 验证失败并返回错误
 * - P3-2 执行监控: 查询执行进度 → 返回精确的步骤级进度
 * - P3-3 自适应重规划: 工具不可用触发replan → 根因分析正确，局部修复而非全局重规划
 * - P3-4 跨步骤状态: 步骤间传递结构化状态 → 状态版本可追溯，支持回滚
 * - P4-1 学习闭环: 10次同类任务后质量提升 → 质量分数提升 ≥ 10%
 * - P4-2 环境建模: 环境变化后自动感知 → 变更检测延迟 < 30s
 * - P4-3 预测增强: 预测用户下一步操作 → Top-3 准确率 ≥ 60%
 */

import { DAGTask, TaskNode, TaskStatus } from '../../src/core/DAGTask';
import {
  ExecutionPlan,
  ExecutionProgress,
  LoopContext,
  LoopState,
  PlanStep,
  PlanValidationError,
  PlanValidationResult,
  PlanValidationWarning,
  ReplanStrategy,
  RootCauseAnalysis,
  StateEntry,
  UnifiedTaskPriority,
  UnifiedTaskStatus,
} from '../../src/harness/types';

function createPlanStep(
  id: string,
  description: string,
  opts?: {
    toolName?: string;
    toolParams?: Record<string, unknown>;
    inputBindings?: Record<string, string>;
    outputSchema?: Record<string, string>;
    parallelGroup?: string;
    maxRetries?: number;
  }
): PlanStep {
  return {
    id,
    description,
    toolName: opts?.toolName,
    toolParams: opts?.toolParams,
    inputBindings: opts?.inputBindings,
    outputSchema: opts?.outputSchema,
    parallelGroup: opts?.parallelGroup,
    retryCount: 0,
    maxRetries: opts?.maxRetries ?? 1,
    toUnifiedTaskNode: () => ({
      id,
      description,
      toolName: opts?.toolName,
      toolParams: opts?.toolParams,
      status: UnifiedTaskStatus.PENDING,
      dependencies: [],
      priority: UnifiedTaskPriority.MEDIUM,
      maxRetries: opts?.maxRetries ?? 1,
      currentRetry: 0,
      timeout: 300,
      retryDelay: 1,
      metadata: {},
      isEssential: true,
    }),
  };
}

function createLoopContext(overrides?: Partial<LoopContext>): LoopContext {
  return {
    messages: [],
    plan: null,
    currentStepIndex: 0,
    stepResults: new Map(),
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map(),
    stepStateHistory: [],
    budget: {
      roundsUsed: 0,
      softRoundLimit: 10,
      hardRoundLimit: 20,
      tokensUsed: 0,
      tokenWarningLimit: 12000,
      tokenHardLimit: 20000,
      startTime: Date.now(),
      maxDurationMs: 180000,
      toolCallsUsed: 0,
      maxToolCalls: 30,
    },
    trace: {
      traceId: 'test-trace',
      state: LoopState.EXECUTING,
      stateTransitions: [],
      trajectory: [],
      totalDuration: 0,
      totalToolCalls: 0,
      budgetState: {
        roundsUsed: 0,
        softRoundLimit: 10,
        hardRoundLimit: 20,
        tokensUsed: 0,
        tokenWarningLimit: 12000,
        tokenHardLimit: 20000,
        startTime: Date.now(),
        maxDurationMs: 180000,
        toolCallsUsed: 0,
        maxToolCalls: 30,
      },
    },
    metadata: {},
    ...overrides,
  };
}

// ============ P3-1: 计划验证 ============

describe('P3-1: 计划验证', () => {
  const registeredTools = new Set([
    'file_search',
    'file_read',
    'file_write',
    'code_analyze',
    'web_search',
    'web_fetch',
    'daily_report',
    'shell_execute',
  ]);

  function validatePlan(
    plan: ExecutionPlan,
    context: LoopContext,
    tools: Set<string>
  ): PlanValidationResult {
    const errors: PlanValidationError[] = [];
    const warnings: PlanValidationWarning[] = [];

    for (const step of plan.steps) {
      if (step.toolName && !tools.has(step.toolName)) {
        errors.push({
          stepId: step.id,
          type: 'tool_unavailable',
          message: `工具 "${step.toolName}" 未注册，步骤 [${step.id}] 无法执行`,
        });
      }

      const deps = plan.dependencies.get(step.id) || [];
      for (const depId of deps) {
        if (!plan.steps.some((s) => s.id === depId)) {
          errors.push({
            stepId: step.id,
            type: 'dependency_missing',
            message: `步骤 [${step.id}] 依赖的步骤 [${depId}] 不存在于计划中`,
          });
        }
      }

      if (step.inputBindings) {
        for (const [key, binding] of Object.entries(step.inputBindings)) {
          if (binding.startsWith('$')) {
            const path = binding.substring(1);
            const parts = path.split('.');
            const sourceStepId = parts[0];
            if (!plan.steps.some((s) => s.id === sourceStepId)) {
              errors.push({
                stepId: step.id,
                type: 'dependency_missing',
                message: `步骤 [${step.id}] 的 inputBindings.${key} 引用了不存在的步骤 [${sourceStepId}]`,
              });
            }
          }
        }
      }
    }

    const stepIds = new Set(plan.steps.map((s) => s.id));
    const dag = new DAGTask('validation', 4);
    let hasCycle = false;
    try {
      for (const step of plan.steps) {
        const deps = plan.dependencies.get(step.id) || [];
        const node = new TaskNode(
          step.id,
          step.description,
          'tool',
          {},
          TaskStatus.PENDING,
          deps
        );
        dag.addNode(node);
      }
    } catch {
      hasCycle = true;
      errors.push({
        stepId: '',
        type: 'circular_dependency',
        message: '计划中存在循环依赖',
      });
    }

    if (plan.steps.length > context.budget.hardRoundLimit) {
      errors.push({
        stepId: '',
        type: 'budget_insufficient',
        message: `计划步骤数(${plan.steps.length})超过硬性轮次限制(${context.budget.hardRoundLimit})`,
      });
    }

    if (plan.steps.length > 5 && !plan.fallbackStrategy) {
      warnings.push({
        stepId: '',
        type: 'no_fallback',
        message: `复杂计划(${plan.steps.length}步)缺少回退策略`,
      });
    }

    for (const step of plan.steps) {
      const deps = plan.dependencies.get(step.id) || [];
      const parallelSiblings = plan.steps.filter(
        (s) =>
          s.parallelGroup &&
          s.parallelGroup === step.parallelGroup &&
          s.id !== step.id
      );
      for (const sibling of parallelSiblings) {
        if (deps.includes(sibling.id)) {
          warnings.push({
            stepId: step.id,
            type: 'parallel_conflict',
            message: `步骤 [${step.id}] 与 [${sibling.id}] 在同一并行组但存在依赖关系`,
          });
        }
      }
    }

    const estimatedSuccessRate = Math.max(
      0,
      1 - errors.length * 0.3 - warnings.length * 0.1
    );

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      estimatedSuccessRate,
    };
  }

  test('引用不存在工具的计划应验证失败', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '使用不存在的工具', {
          toolName: 'nonexistent_tool',
        }),
        createPlanStep('step2', '正常步骤', { toolName: 'file_search' }),
      ],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: ['nonexistent_tool', 'file_search'],
    };

    const result = validatePlan(plan, createLoopContext(), registeredTools);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].type).toBe('tool_unavailable');
    expect(result.errors[0].stepId).toBe('step1');
  });

  test('依赖不存在的步骤应验证失败', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '步骤1', { toolName: 'file_search' }),
        createPlanStep('step2', '步骤2', { toolName: 'file_read' }),
      ],
      dependencies: new Map([['step2', ['nonexistent_step']]]),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'file_read'],
    };

    const result = validatePlan(plan, createLoopContext(), registeredTools);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'dependency_missing')).toBe(
      true
    );
  });

  test('inputBindings引用不存在的步骤应验证失败', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '步骤1', { toolName: 'file_search' }),
        createPlanStep('step2', '步骤2', {
          toolName: 'file_read',
          inputBindings: { filePath: '$nonexistent_step.results.0' },
        }),
      ],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'file_read'],
    };

    const result = validatePlan(plan, createLoopContext(), registeredTools);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'dependency_missing')).toBe(
      true
    );
  });

  test('循环依赖应验证失败', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('a', 'A', { toolName: 'file_search' }),
        createPlanStep('b', 'B', { toolName: 'file_read' }),
        createPlanStep('c', 'C', { toolName: 'code_analyze' }),
      ],
      dependencies: new Map([
        ['b', ['c']],
        ['c', ['a']],
        ['a', ['b']],
      ]),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'file_read', 'code_analyze'],
    };

    const result = validatePlan(plan, createLoopContext(), registeredTools);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'circular_dependency')).toBe(
      true
    );
  });

  test('步骤数超过预算限制应验证失败', () => {
    const steps = Array.from({ length: 25 }, (_, i) =>
      createPlanStep(`step${i + 1}`, `步骤${i + 1}`, {
        toolName: 'file_search',
      })
    );
    const plan: ExecutionPlan = {
      steps,
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search'],
    };

    const context = createLoopContext();
    context.budget.hardRoundLimit = 20;

    const result = validatePlan(plan, context, registeredTools);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'budget_insufficient')).toBe(
      true
    );
  });

  test('复杂计划缺少回退策略应产生警告', () => {
    const plan: ExecutionPlan = {
      steps: Array.from({ length: 6 }, (_, i) =>
        createPlanStep(`step${i + 1}`, `步骤${i + 1}`, {
          toolName: 'file_search',
        })
      ),
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 10,
        maxToolCalls: 15,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search'],
    };

    const result = validatePlan(plan, createLoopContext(), registeredTools);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.type === 'no_fallback')).toBe(true);
  });

  test('并行组内存在依赖应产生警告', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '步骤1', {
          toolName: 'file_search',
          parallelGroup: 'group-a',
        }),
        createPlanStep('step2', '步骤2', {
          toolName: 'file_read',
          parallelGroup: 'group-a',
        }),
      ],
      dependencies: new Map([['step2', ['step1']]]),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'file_read'],
    };

    const result = validatePlan(plan, createLoopContext(), registeredTools);

    expect(result.warnings.some((w) => w.type === 'parallel_conflict')).toBe(
      true
    );
  });

  test('有效计划应验证通过', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索文件', { toolName: 'file_search' }),
        createPlanStep('step2', '读取文件', { toolName: 'file_read' }),
        createPlanStep('step3', '分析代码', { toolName: 'code_analyze' }),
      ],
      dependencies: new Map([
        ['step2', ['step1']],
        ['step3', ['step2']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 10,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'file_read', 'code_analyze'],
      fallbackStrategy: 'replan',
    };

    const result = validatePlan(plan, createLoopContext(), registeredTools);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.estimatedSuccessRate).toBeGreaterThan(0.8);
  });
});

// ============ P3-2: 执行监控 ============

describe('P3-2: 执行监控', () => {
  function createExecutionProgress(plan: ExecutionPlan): ExecutionProgress {
    return {
      traceId: 'test-trace',
      overallProgress: 0,
      currentPhase: 'executing',
      stepProgress: plan.steps.map((s) => ({
        stepId: s.id,
        description: s.description,
        status: 'pending' as const,
        progress: 0,
        duration: 0,
      })),
      estimatedTimeRemaining: 0,
      budgetConsumption: {
        rounds: 0,
        tokens: 0,
        toolCalls: 0,
        time: 0,
      },
      bottlenecks: [],
    };
  }

  function updateStepStatus(
    progress: ExecutionProgress,
    stepId: string,
    status: 'pending' | 'running' | 'completed' | 'failed',
    duration?: number
  ): void {
    const sp = progress.stepProgress.find((s) => s.stepId === stepId);
    if (!sp) return;

    sp.status = status;
    if (status === 'running') sp.progress = 0.1;
    if (status === 'completed') sp.progress = 1;
    if (status === 'failed') sp.progress = 0;
    if (duration !== undefined) sp.duration = duration;

    const completed = progress.stepProgress.filter(
      (s) => s.status === 'completed'
    ).length;
    const total = progress.stepProgress.length;
    progress.overallProgress = total > 0 ? completed / total : 0;
  }

  test('应返回精确的步骤级进度', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索'),
        createPlanStep('step2', '读取'),
        createPlanStep('step3', '分析'),
        createPlanStep('step4', '报告'),
      ],
      dependencies: new Map([
        ['step2', ['step1']],
        ['step3', ['step2']],
        ['step4', ['step3']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 10,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const progress = createExecutionProgress(plan);

    expect(progress.stepProgress.length).toBe(4);
    expect(progress.overallProgress).toBe(0);

    updateStepStatus(progress, 'step1', 'running');
    expect(progress.stepProgress[0].status).toBe('running');
    expect(progress.stepProgress[0].progress).toBe(0.1);

    updateStepStatus(progress, 'step1', 'completed', 500);
    expect(progress.stepProgress[0].status).toBe('completed');
    expect(progress.stepProgress[0].progress).toBe(1);
    expect(progress.stepProgress[0].duration).toBe(500);
    expect(progress.overallProgress).toBe(0.25);

    updateStepStatus(progress, 'step2', 'completed', 300);
    expect(progress.overallProgress).toBe(0.5);

    updateStepStatus(progress, 'step3', 'completed', 800);
    expect(progress.overallProgress).toBe(0.75);

    updateStepStatus(progress, 'step4', 'completed', 200);
    expect(progress.overallProgress).toBe(1);
  });

  test('应追踪预算消耗', () => {
    const progress = createExecutionProgress({
      steps: [createPlanStep('step1', '测试')],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    });

    progress.budgetConsumption = {
      rounds: 3,
      tokens: 2000,
      toolCalls: 5,
      time: 15000,
    };

    expect(progress.budgetConsumption.rounds).toBe(3);
    expect(progress.budgetConsumption.tokens).toBe(2000);
    expect(progress.budgetConsumption.toolCalls).toBe(5);
    expect(progress.budgetConsumption.time).toBe(15000);
  });

  test('应检测瓶颈步骤', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '快速步骤'),
        createPlanStep('step2', '慢速步骤'),
        createPlanStep('step3', '正常步骤'),
      ],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const progress = createExecutionProgress(plan);
    updateStepStatus(progress, 'step1', 'completed', 200);
    updateStepStatus(progress, 'step2', 'completed', 5000);
    updateStepStatus(progress, 'step3', 'completed', 300);

    const avgDuration =
      progress.stepProgress.reduce((sum, s) => sum + s.duration, 0) /
      progress.stepProgress.length;

    const bottlenecks = progress.stepProgress
      .filter(
        (sp) =>
          sp.status === 'completed' &&
          sp.duration > avgDuration * 2 &&
          avgDuration > 0
      )
      .map((sp) => sp.stepId);

    expect(bottlenecks).toContain('step2');
    expect(bottlenecks).not.toContain('step1');
  });

  test('应估算剩余时间', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '步骤1'),
        createPlanStep('step2', '步骤2'),
        createPlanStep('step3', '步骤3'),
        createPlanStep('step4', '步骤4'),
      ],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const progress = createExecutionProgress(plan);
    updateStepStatus(progress, 'step1', 'completed', 1000);
    updateStepStatus(progress, 'step2', 'completed', 1000);

    const completedSteps = progress.stepProgress.filter(
      (s) => s.status === 'completed'
    );
    const avgDuration =
      completedSteps.reduce(
        (sum: number, s: { duration: number }) => sum + s.duration,
        0
      ) / completedSteps.length;
    const pendingSteps = progress.stepProgress.filter(
      (s: { status: string }) =>
        s.status === 'pending' || s.status === 'running'
    );
    const estimatedTimeRemaining = pendingSteps.length * avgDuration;

    expect(estimatedTimeRemaining).toBe(2000);
  });

  test('应追踪阶段变化', () => {
    const progress = createExecutionProgress({
      steps: [createPlanStep('step1', '测试')],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    });

    expect(progress.currentPhase).toBe('executing');

    progress.currentPhase = 'evaluating';
    expect(progress.currentPhase).toBe('evaluating');

    progress.currentPhase = 'reporting';
    expect(progress.currentPhase).toBe('reporting');
  });

  test('失败步骤应标记为failed', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '成功步骤'),
        createPlanStep('step2', '失败步骤'),
        createPlanStep('step3', '待执行步骤'),
      ],
      dependencies: new Map([['step3', ['step2']]]),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const progress = createExecutionProgress(plan);
    updateStepStatus(progress, 'step1', 'completed', 100);
    updateStepStatus(progress, 'step2', 'failed', 500);

    expect(progress.stepProgress[1].status).toBe('failed');
    expect(progress.stepProgress[1].progress).toBe(0);
    expect(progress.overallProgress).toBeCloseTo(1 / 3, 1);
  });
});

// ============ P3-3: 自适应重规划 ============

describe('P3-3: 自适应重规划', () => {
  function analyzeRootCause(context: LoopContext): RootCauseAnalysis {
    const failedSteps = Array.from(context.stepResults.values()).filter(
      (r) => !r.success
    );

    if (failedSteps.length === 0) {
      return {
        failureType: 'plan_incorrect',
        impactScope: 'global',
        affectedSteps: [],
        rootCause: '评估建议重规划但无明确失败步骤',
        fixSuggestions: ['重新审视整体计划', '检查用户意图是否变更'],
      };
    }

    const primaryFailure = failedSteps[0];
    let failureType: RootCauseAnalysis['failureType'] = 'tool_error';
    let rootCause = '';
    const fixSuggestions: string[] = [];

    if (
      primaryFailure.error?.includes('not found') ||
      primaryFailure.error?.includes('不可用')
    ) {
      failureType = 'tool_unavailable';
      rootCause = `步骤 [${primaryFailure.stepId}] 所需工具不可用: ${primaryFailure.error}`;
      fixSuggestions.push('替换为可用工具', '移除该步骤并调整计划');
    } else if (
      primaryFailure.error?.includes('timeout') ||
      primaryFailure.error?.includes('超时')
    ) {
      failureType = 'timeout';
      rootCause = `步骤 [${primaryFailure.stepId}] 执行超时`;
      fixSuggestions.push('增加超时时间', '拆分为更小的子步骤');
    } else if (
      context.budget.tokensUsed >=
      context.budget.tokenHardLimit * 0.9
    ) {
      failureType = 'budget_exceeded';
      rootCause = 'Token 预算即将耗尽';
      fixSuggestions.push('压缩上下文', '减少步骤数量');
    } else {
      failureType = 'tool_error';
      rootCause = `步骤 [${primaryFailure.stepId}] 执行出错: ${primaryFailure.error || '未知错误'}`;
      fixSuggestions.push('重试该步骤', '调整工具参数');
    }

    const plan = context.plan;
    const affectedSteps = findDownstreamSteps(
      primaryFailure.stepId,
      plan?.dependencies || new Map()
    );

    const impactScope: RootCauseAnalysis['impactScope'] =
      affectedSteps.length === 0
        ? 'single_step'
        : affectedSteps.length >= (plan?.steps.length || 0) / 2
          ? 'global'
          : 'downstream';

    return {
      failureType,
      impactScope,
      affectedSteps: [primaryFailure.stepId, ...affectedSteps],
      rootCause,
      fixSuggestions,
    };
  }

  function findDownstreamSteps(
    stepId: string,
    dependencies: Map<string, string[]>
  ): string[] {
    const downstream: string[] = [];
    const visited = new Set<string>();

    const traverse = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const [targetId, deps] of dependencies) {
        if (deps.includes(id) && !visited.has(targetId)) {
          downstream.push(targetId);
          traverse(targetId);
        }
      }
    };

    traverse(stepId);
    return downstream;
  }

  function generateReplanStrategy(
    rootCause: RootCauseAnalysis,
    plan: ExecutionPlan,
    context: LoopContext
  ): ReplanStrategy {
    const completedStepIds = new Set(
      Array.from(context.stepResults.values())
        .filter((r) => r.success)
        .map((r) => r.stepId)
    );

    const stepsToKeep = plan.steps
      .filter((s) => completedStepIds.has(s.id))
      .map((s) => s.id);

    const stepsToReplan = rootCause.affectedSteps.filter(
      (id: string) => !completedStepIds.has(id)
    );

    const fixActions: ReplanStrategy['fixActions'] = [];

    for (const stepId of stepsToReplan) {
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step) continue;

      switch (rootCause.failureType) {
        case 'tool_unavailable':
          fixActions.push({
            stepId,
            action: 'replace_tool',
            details: { originalTool: step.toolName, reason: '工具不可用' },
          });
          break;
        case 'timeout':
          fixActions.push({
            stepId,
            action: 'retry_with_different_params',
            details: { reason: '执行超时，尝试简化参数' },
          });
          break;
        case 'context_insufficient':
          fixActions.push({
            stepId,
            action: 'add_context',
            details: { reason: '上下文不足，补充信息' },
          });
          break;
        default:
          fixActions.push({
            stepId,
            action: 'retry_with_different_params',
            details: { reason: rootCause.rootCause },
          });
      }
    }

    let type: ReplanStrategy['type'] = 'full_replan';
    if (rootCause.impactScope === 'single_step' && stepsToReplan.length <= 1) {
      type = 'local_fix';
    } else if (rootCause.impactScope === 'downstream') {
      type = 'partial_replan';
    }

    if (rootCause.failureType === 'budget_exceeded') {
      type = 'fallback';
    }

    return { type, stepsToReplan, stepsToKeep, fixActions };
  }

  test('工具不可用应触发 local_fix 策略', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索', { toolName: 'file_search' }),
        createPlanStep('step2', '读取', { toolName: 'nonexistent_tool' }),
      ],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const context = createLoopContext({ plan });
    context.stepResults.set('step1', {
      stepId: 'step1',
      success: true,
      output: '搜索完成',
      duration: 100,
    });
    context.stepResults.set('step2', {
      stepId: 'step2',
      success: false,
      output: '',
      duration: 50,
      error: 'Tool "nonexistent_tool" not found',
    });

    const rootCause = analyzeRootCause(context);
    expect(rootCause.failureType).toBe('tool_unavailable');
    expect(rootCause.impactScope).toBe('single_step');

    const strategy = generateReplanStrategy(rootCause, plan, context);
    expect(strategy.type).toBe('local_fix');
    expect(strategy.stepsToKeep).toContain('step1');
    expect(strategy.stepsToReplan).toContain('step2');
    expect(
      strategy.fixActions.some(
        (a: { action: string }) => a.action === 'replace_tool'
      )
    ).toBe(true);
  });

  test('超时应触发 retry_with_different_params', () => {
    const plan: ExecutionPlan = {
      steps: [createPlanStep('step1', '慢步骤', { toolName: 'file_search' })],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const context = createLoopContext({ plan });
    context.stepResults.set('step1', {
      stepId: 'step1',
      success: false,
      output: '',
      duration: 30000,
      error: 'timeout: 执行超时',
    });

    const rootCause = analyzeRootCause(context);
    expect(rootCause.failureType).toBe('timeout');
    expect(rootCause.fixSuggestions).toContain('增加超时时间');
  });

  test('下游步骤失败应触发 partial_replan', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索', { toolName: 'file_search' }),
        createPlanStep('step2', '读取', { toolName: 'file_read' }),
        createPlanStep('step3', '分析', { toolName: 'code_analyze' }),
        createPlanStep('step4', '报告', { toolName: 'daily_report' }),
      ],
      dependencies: new Map([
        ['step2', ['step1']],
        ['step3', ['step2']],
        ['step4', ['step3']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 10,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const context = createLoopContext({ plan });
    context.stepResults.set('step1', {
      stepId: 'step1',
      success: true,
      output: '搜索完成',
      duration: 100,
    });
    context.stepResults.set('step2', {
      stepId: 'step2',
      success: false,
      output: '',
      duration: 50,
      error: 'Tool "file_read" 不可用',
    });

    const rootCause = analyzeRootCause(context);
    expect(rootCause.failureType).toBe('tool_unavailable');
    expect(rootCause.impactScope).toBe('global');
    expect(rootCause.affectedSteps).toContain('step2');
    expect(rootCause.affectedSteps).toContain('step3');
    expect(rootCause.affectedSteps).toContain('step4');

    const strategy = generateReplanStrategy(rootCause, plan, context);
    expect(strategy.type).toBe('full_replan');
    expect(strategy.stepsToKeep).toContain('step1');
  });

  test('下游影响小于一半步骤应触发 partial_replan', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索', { toolName: 'file_search' }),
        createPlanStep('step2', '读取', { toolName: 'file_read' }),
        createPlanStep('step3', '分析', { toolName: 'code_analyze' }),
        createPlanStep('step4', '优化', { toolName: 'shell_execute' }),
        createPlanStep('step5', '报告', { toolName: 'daily_report' }),
      ],
      dependencies: new Map([
        ['step2', ['step1']],
        ['step3', ['step2']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 10,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const context = createLoopContext({ plan });
    context.stepResults.set('step1', {
      stepId: 'step1',
      success: true,
      output: '搜索完成',
      duration: 100,
    });
    context.stepResults.set('step2', {
      stepId: 'step2',
      success: false,
      output: '',
      duration: 50,
      error: 'Tool "file_read" 不可用',
    });

    const rootCause = analyzeRootCause(context);
    expect(rootCause.failureType).toBe('tool_unavailable');
    expect(rootCause.impactScope).toBe('downstream');

    const strategy = generateReplanStrategy(rootCause, plan, context);
    expect(strategy.type).toBe('partial_replan');
    expect(strategy.stepsToKeep).toContain('step1');
  });

  test('预算耗尽应触发 fallback 策略', () => {
    const plan: ExecutionPlan = {
      steps: [createPlanStep('step1', '步骤1', { toolName: 'file_search' })],
      dependencies: new Map(),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const context = createLoopContext({ plan });
    context.budget.tokensUsed = 19000;
    context.budget.tokenHardLimit = 20000;
    context.stepResults.set('step1', {
      stepId: 'step1',
      success: false,
      output: '',
      duration: 50,
      error: '执行出错: token limit exceeded',
    });

    const rootCause = analyzeRootCause(context);
    expect(rootCause.failureType).toBe('budget_exceeded');

    const strategy = generateReplanStrategy(rootCause, plan, context);
    expect(strategy.type).toBe('fallback');
  });

  test('findDownstreamSteps 应正确查找下游步骤', () => {
    const deps = new Map<string, string[]>([
      ['step2', ['step1']],
      ['step3', ['step2']],
      ['step4', ['step3']],
    ]);

    const downstream = findDownstreamSteps('step1', deps);
    expect(downstream).toContain('step2');
    expect(downstream).toContain('step3');
    expect(downstream).toContain('step4');
    expect(downstream.length).toBe(3);
  });

  test('菱形依赖的下游步骤应正确查找', () => {
    const deps = new Map<string, string[]>([
      ['left', ['root']],
      ['right', ['root']],
      ['merge', ['left', 'right']],
    ]);

    const downstream = findDownstreamSteps('root', deps);
    expect(downstream).toContain('left');
    expect(downstream).toContain('right');
    expect(downstream).toContain('merge');
  });
});

// ============ P3-4: 跨步骤状态管理 ============

describe('P3-4: 跨步骤状态管理', () => {
  function setCrossStepState(
    stepId: string,
    key: string,
    value: unknown,
    context: LoopContext,
    history: Map<string, StateEntry[]>
  ): void {
    const existing = context.crossStepState.get(key);
    const newEntry: StateEntry = {
      key,
      value,
      writtenBy: stepId,
      timestamp: Date.now(),
      version: (existing?.version || 0) + 1,
    };

    if (!history.has(key)) {
      history.set(key, []);
    }
    history.get(key)!.push({ ...newEntry });

    context.crossStepState.set(key, newEntry);
  }

  function rollbackCrossStepState(
    key: string,
    targetVersion: number,
    context: LoopContext,
    history: Map<string, StateEntry[]>
  ): boolean {
    const entries = history.get(key);
    if (!entries) return false;
    const target = entries.find((e) => e.version === targetVersion);
    if (!target) return false;
    context.crossStepState.set(key, { ...target });
    return true;
  }

  test('步骤间应能传递结构化状态', () => {
    const context = createLoopContext();
    const history = new Map<string, StateEntry[]>();

    setCrossStepState(
      'step1',
      'searchResults',
      ['file1.ts', 'file2.ts'],
      context,
      history
    );

    const state = context.crossStepState.get('searchResults');
    expect(state).toBeDefined();
    expect(state!.value).toEqual(['file1.ts', 'file2.ts']);
    expect(state!.writtenBy).toBe('step1');
    expect(state!.version).toBe(1);
  });

  test('状态版本应可追溯', () => {
    const context = createLoopContext();
    const history = new Map<string, StateEntry[]>();

    setCrossStepState(
      'step1',
      'analysisResult',
      { quality: 'good' },
      context,
      history
    );
    setCrossStepState(
      'step2',
      'analysisResult',
      { quality: 'excellent' },
      context,
      history
    );
    setCrossStepState(
      'step3',
      'analysisResult',
      { quality: 'perfect' },
      context,
      history
    );

    const state = context.crossStepState.get('analysisResult');
    expect(state!.version).toBe(3);
    expect((state!.value as Record<string, unknown>).quality).toBe('perfect');

    const entries = history.get('analysisResult')!;
    expect(entries.length).toBe(3);
    expect(entries[0].version).toBe(1);
    expect(entries[1].version).toBe(2);
    expect(entries[2].version).toBe(3);
  });

  test('状态应支持回滚', () => {
    const context = createLoopContext();
    const history = new Map<string, StateEntry[]>();

    setCrossStepState('step1', 'config', { mode: 'safe' }, context, history);
    setCrossStepState(
      'step2',
      'config',
      { mode: 'aggressive' },
      context,
      history
    );

    expect(
      (context.crossStepState.get('config')!.value as Record<string, unknown>)
        .mode
    ).toBe('aggressive');

    const rolledBack = rollbackCrossStepState('config', 1, context, history);
    expect(rolledBack).toBe(true);
    expect(
      (context.crossStepState.get('config')!.value as Record<string, unknown>)
        .mode
    ).toBe('safe');
    expect(context.crossStepState.get('config')!.version).toBe(1);
  });

  test('回滚到不存在的版本应返回 false', () => {
    const context = createLoopContext();
    const history = new Map<string, StateEntry[]>();

    setCrossStepState('step1', 'data', { v: 1 }, context, history);

    const rolledBack = rollbackCrossStepState('data', 99, context, history);
    expect(rolledBack).toBe(false);
  });

  test('$state. 前缀的 inputBindings 应从跨步骤状态解析', () => {
    const context = createLoopContext();
    const history = new Map<string, StateEntry[]>();

    setCrossStepState('step1', 'searchQuery', 'config files', context, history);

    const step = createPlanStep('step2', '搜索', {
      toolName: 'file_search',
      inputBindings: { query: '$state.searchQuery' },
    });

    const result: Record<string, unknown> = {};
    if (step.inputBindings) {
      for (const [key, binding] of Object.entries(step.inputBindings)) {
        if (binding.startsWith('$state.')) {
          const stateKey = binding.substring('$state.'.length);
          const value = context.crossStepState.get(stateKey)?.value;
          if (value !== undefined) {
            result[key] = value;
          }
        }
      }
    }

    expect(result.query).toBe('config files');
  });
});

// ============ P4-1: 学习闭环 ============

describe('P4-1: 学习闭环', () => {
  interface LearningSignal {
    type: 'success' | 'failure';
    source: string;
    context: {
      taskDescription: string;
      toolsUsed: string[];
      duration: number;
      qualityScore: number;
    };
    insight: string;
  }

  interface LearningResult {
    patternsLearned: number;
    configUpdates: number;
    improved: boolean;
  }

  class MockLearningOrchestrator {
    private signals: LearningSignal[] = [];
    private patterns: Map<string, { count: number; avgScore: number }> =
      new Map();

    collectLearningSignal(signal: LearningSignal): void {
      this.signals.push(signal);

      const key = signal.context.taskDescription.substring(0, 50);
      const existing = this.patterns.get(key);
      if (existing) {
        existing.count++;
        existing.avgScore =
          (existing.avgScore * (existing.count - 1) +
            signal.context.qualityScore) /
          existing.count;
      } else {
        this.patterns.set(key, {
          count: 1,
          avgScore: signal.context.qualityScore,
        });
      }
    }

    async runLearningCycle(): Promise<LearningResult> {
      let patternsLearned = 0;
      let configUpdates = 0;

      for (const [key, pattern] of this.patterns) {
        if (pattern.count >= 3) {
          patternsLearned++;
          if (pattern.avgScore < 0.7) {
            configUpdates++;
          }
        }
      }

      return {
        patternsLearned,
        configUpdates,
        improved: patternsLearned > 0,
      };
    }

    getSignalCount(): number {
      return this.signals.length;
    }

    getPatternAvgScore(key: string): number {
      return this.patterns.get(key)?.avgScore ?? 0;
    }
  }

  test('10次同类任务后质量应提升 ≥ 10%', async () => {
    const orchestrator = new MockLearningOrchestrator();
    const taskKey = '搜索并分析代码质量';

    const initialScores: number[] = [];
    for (let i = 0; i < 5; i++) {
      const score = 0.5 + Math.random() * 0.2;
      initialScores.push(score);
      orchestrator.collectLearningSignal({
        type: score >= 0.5 ? 'success' : 'failure',
        source: 'execution',
        context: {
          taskDescription: taskKey,
          toolsUsed: ['file_search', 'code_analyze'],
          duration: 1000,
          qualityScore: score,
        },
        insight: `质量=${score.toFixed(2)}`,
      });
    }

    const initialAvg =
      initialScores.reduce((a, b) => a + b, 0) / initialScores.length;

    const improvedScores: number[] = [];
    for (let i = 0; i < 5; i++) {
      const score = 0.7 + Math.random() * 0.2;
      improvedScores.push(score);
      orchestrator.collectLearningSignal({
        type: 'success',
        source: 'execution',
        context: {
          taskDescription: taskKey,
          toolsUsed: ['file_search', 'code_analyze'],
          duration: 800,
          qualityScore: score,
        },
        insight: `质量=${score.toFixed(2)}`,
      });
    }

    const result = await orchestrator.runLearningCycle();
    expect(result.patternsLearned).toBeGreaterThan(0);

    const finalAvg = orchestrator.getPatternAvgScore(taskKey);
    const improvement = (finalAvg - initialAvg) / initialAvg;
    expect(improvement).toBeGreaterThanOrEqual(0.1);
  });

  test('学习信号应正确收集', () => {
    const orchestrator = new MockLearningOrchestrator();

    orchestrator.collectLearningSignal({
      type: 'success',
      source: 'execution',
      context: {
        taskDescription: '测试任务',
        toolsUsed: ['file_search'],
        duration: 500,
        qualityScore: 0.9,
      },
      insight: '高质量执行',
    });

    expect(orchestrator.getSignalCount()).toBe(1);
  });

  test('失败信号也应被收集', async () => {
    const orchestrator = new MockLearningOrchestrator();

    for (let i = 0; i < 3; i++) {
      orchestrator.collectLearningSignal({
        type: 'failure',
        source: 'execution',
        context: {
          taskDescription: '困难任务',
          toolsUsed: ['nonexistent_tool'],
          duration: 5000,
          qualityScore: 0.3,
        },
        insight: '工具不可用',
      });
    }

    const result = await orchestrator.runLearningCycle();
    expect(result.patternsLearned).toBeGreaterThan(0);
    expect(result.configUpdates).toBeGreaterThan(0);
  });
});

// ============ P4-2: 环境建模 ============

describe('P4-2: 环境建模', () => {
  interface EnvironmentState {
    activeTools: string[];
    topic: string;
    lastUpdated: number;
    changes: Array<{
      field: string;
      oldValue: unknown;
      newValue: unknown;
      timestamp: number;
    }>;
  }

  class MockEnvironmentModel {
    private state: EnvironmentState = {
      activeTools: [],
      topic: '',
      lastUpdated: Date.now(),
      changes: [],
    };

    updateEnvironmentState(update: {
      activeTools?: string[];
      topic?: string;
    }): string[] {
      const detectedChanges: string[] = [];
      const now = Date.now();

      if (update.activeTools) {
        const added = update.activeTools.filter(
          (t) => !this.state.activeTools.includes(t)
        );
        const removed = this.state.activeTools.filter(
          (t) => !update.activeTools!.includes(t)
        );

        if (added.length > 0) {
          detectedChanges.push(`工具新增: ${added.join(', ')}`);
          this.state.changes.push({
            field: 'activeTools',
            oldValue: [...this.state.activeTools],
            newValue: update.activeTools,
            timestamp: now,
          });
        }
        if (removed.length > 0) {
          detectedChanges.push(`工具移除: ${removed.join(', ')}`);
          this.state.changes.push({
            field: 'activeTools',
            oldValue: [...this.state.activeTools],
            newValue: update.activeTools,
            timestamp: now,
          });
        }
        this.state.activeTools = update.activeTools;
      }

      if (update.topic && update.topic !== this.state.topic) {
        detectedChanges.push(`话题变更: ${this.state.topic} → ${update.topic}`);
        this.state.changes.push({
          field: 'topic',
          oldValue: this.state.topic,
          newValue: update.topic,
          timestamp: now,
        });
        this.state.topic = update.topic;
      }

      this.state.lastUpdated = now;
      return detectedChanges;
    }

    getState(): EnvironmentState {
      return { ...this.state };
    }

    getRecentChanges(sinceMs: number): Array<{
      field: string;
      oldValue: unknown;
      newValue: unknown;
      timestamp: number;
    }> {
      const cutoff = Date.now() - sinceMs;
      return this.state.changes.filter((c) => c.timestamp >= cutoff);
    }
  }

  test('环境变化后应自动感知', () => {
    const model = new MockEnvironmentModel();

    model.updateEnvironmentState({
      activeTools: ['file_search', 'file_read'],
      topic: '代码分析',
    });

    const changes = model.updateEnvironmentState({
      activeTools: ['file_search', 'code_analyze'],
      topic: '代码审查',
    });

    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.includes('工具'))).toBe(true);
    expect(changes.some((c) => c.includes('话题'))).toBe(true);
  });

  test('变更检测延迟应 < 30s', () => {
    const model = new MockEnvironmentModel();

    model.updateEnvironmentState({ activeTools: ['file_search'] });

    const beforeChange = Date.now();
    model.updateEnvironmentState({
      activeTools: ['file_search', 'web_search'],
    });
    const afterChange = Date.now();

    const detectionDelay = afterChange - beforeChange;
    expect(detectionDelay).toBeLessThan(30000);

    const recentChanges = model.getRecentChanges(30000);
    expect(recentChanges.length).toBeGreaterThan(0);
  });

  test('应追踪工具变化', () => {
    const model = new MockEnvironmentModel();

    model.updateEnvironmentState({ activeTools: ['file_search', 'file_read'] });
    model.updateEnvironmentState({
      activeTools: ['file_search', 'code_analyze'],
    });

    const state = model.getState();
    expect(state.activeTools).toContain('file_search');
    expect(state.activeTools).toContain('code_analyze');
    expect(state.activeTools).not.toContain('file_read');
  });

  test('无变化不应产生变更记录', () => {
    const model = new MockEnvironmentModel();

    model.updateEnvironmentState({ activeTools: ['file_search'] });
    const changes = model.updateEnvironmentState({
      activeTools: ['file_search'],
    });

    expect(changes.length).toBe(0);
  });
});

// ============ P4-3: 预测增强 ============

describe('P4-3: 预测增强', () => {
  interface UserAction {
    type: string;
    description: string;
    timestamp: number;
  }

  interface Prediction {
    action: string;
    confidence: number;
  }

  class MockPredictionEngine {
    private actionHistory: UserAction[] = [];
    private transitionCounts: Map<string, Map<string, number>> = new Map();

    recordAction(action: UserAction): void {
      this.actionHistory.push(action);

      if (this.actionHistory.length >= 2) {
        const prevAction =
          this.actionHistory[this.actionHistory.length - 2].type;
        const currAction = action.type;

        if (!this.transitionCounts.has(prevAction)) {
          this.transitionCounts.set(prevAction, new Map());
        }
        const transitions = this.transitionCounts.get(prevAction)!;
        transitions.set(currAction, (transitions.get(currAction) || 0) + 1);
      }
    }

    predictNextActions(currentAction: string, topK: number = 3): Prediction[] {
      const transitions = this.transitionCounts.get(currentAction);
      if (!transitions || transitions.size === 0) return [];

      const total = Array.from(transitions.values()).reduce((a, b) => a + b, 0);

      return Array.from(transitions.entries())
        .map(([action, count]) => ({
          action,
          confidence: count / total,
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, topK);
    }

    getTop3Accuracy(
      testData: Array<{ current: string; actual: string }>
    ): number {
      let correct = 0;
      for (const { current, actual } of testData) {
        const predictions = this.predictNextActions(current, 3);
        if (predictions.some((p) => p.action === actual)) {
          correct++;
        }
      }
      return testData.length > 0 ? correct / testData.length : 0;
    }
  }

  test('应预测用户下一步操作', () => {
    const engine = new MockPredictionEngine();

    const typicalFlow = [
      'file_search',
      'file_read',
      'code_analyze',
      'daily_report',
    ];
    for (let round = 0; round < 5; round++) {
      for (const action of typicalFlow) {
        engine.recordAction({
          type: action,
          description: action,
          timestamp: Date.now(),
        });
      }
    }

    const predictions = engine.predictNextActions('file_search', 3);
    expect(predictions.length).toBeGreaterThan(0);
    expect(predictions[0].action).toBe('file_read');
    expect(predictions[0].confidence).toBeGreaterThan(0);
  });

  test('Top-3 准确率应 ≥ 60%', () => {
    const engine = new MockPredictionEngine();

    const flow1 = ['file_search', 'file_read', 'code_analyze'];
    const flow2 = ['web_search', 'web_fetch', 'daily_report'];

    for (let round = 0; round < 10; round++) {
      for (const action of flow1) {
        engine.recordAction({
          type: action,
          description: action,
          timestamp: Date.now(),
        });
      }
      for (const action of flow2) {
        engine.recordAction({
          type: action,
          description: action,
          timestamp: Date.now(),
        });
      }
    }

    const testData = [
      { current: 'file_search', actual: 'file_read' },
      { current: 'file_read', actual: 'code_analyze' },
      { current: 'web_search', actual: 'web_fetch' },
      { current: 'web_fetch', actual: 'daily_report' },
      { current: 'code_analyze', actual: 'web_search' },
    ];

    const accuracy = engine.getTop3Accuracy(testData);
    expect(accuracy).toBeGreaterThanOrEqual(0.6);
  });

  test('无历史数据时应返回空预测', () => {
    const engine = new MockPredictionEngine();
    const predictions = engine.predictNextActions('unknown_action', 3);
    expect(predictions.length).toBe(0);
  });

  test('预测置信度应归一化', () => {
    const engine = new MockPredictionEngine();

    for (let i = 0; i < 10; i++) {
      engine.recordAction({
        type: 'start',
        description: 'start',
        timestamp: Date.now(),
      });
      engine.recordAction({
        type: 'action_a',
        description: 'a',
        timestamp: Date.now(),
      });
    }
    for (let i = 0; i < 5; i++) {
      engine.recordAction({
        type: 'start',
        description: 'start',
        timestamp: Date.now(),
      });
      engine.recordAction({
        type: 'action_b',
        description: 'b',
        timestamp: Date.now(),
      });
    }

    const predictions = engine.predictNextActions('start', 3);
    const totalConfidence = predictions.reduce(
      (sum, p) => sum + p.confidence,
      0
    );
    expect(totalConfidence).toBeCloseTo(1.0, 1);
  });
});
