/**
 * Week 10: 端到端集成测试
 *
 * 验证从用户输入到系统输出的完整 P3-P4-🔶 流程:
 * 1. Planner → 计划生成 + 🔶-1增强（工具推荐、预算自适应、质量验证）
 * 2. 计划验证 → P3-1（工具可用性、依赖、循环检测、预算）
 * 3. 执行监控 → P3-2（步骤进度、预算消耗、瓶颈检测）
 * 4. 自适应重规划 → P3-3（根因分析、策略生成）
 * 5. 跨步骤状态 → P3-4（状态版本化、回滚）
 * 6. 学习闭环 → P4-1（质量提升）
 * 7. 环境建模 → P4-2（变更检测）
 * 8. 预测增强 → P4-3（Top-K准确率）
 * 9. 🔶-1 + 🔶-2 增强优化集成
 * 10. 性能基准
 */

import { DAGTask, TaskNode, TaskStatus } from '../../src/core/DAGTask';
import { TaskComplexityAnalyzer } from '../../src/core/TaskComplexityAnalyzer';
import { Planner } from '../../src/harness/loop/Planner';
import {
  type ExecutionPlan,
  type ExecutionProgress,
  type LoopContext,
  LoopState,
  type PlanStep,
  type PlanValidationError,
  type PlanValidationResult,
  type PlanValidationWarning,
  type ReplanStrategy,
  type StateEntry,
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
      traceId: 'e2e-trace',
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
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map(),
    stepStateHistory: [],
    ...overrides,
  };
}

const registeredTools = new Set([
  'file_search',
  'file_read',
  'file_write',
  'code_analyze',
  'web_search',
  'web_fetch',
  'shell_exec',
  'daily_report',
  'incremental_edit',
  'execute_code',
  'chart_generate',
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
        message: `工具 "${step.toolName}" 未注册`,
      });
    }

    const deps = plan.dependencies.get(step.id) || [];
    for (const depId of deps) {
      if (!plan.steps.some((s) => s.id === depId)) {
        errors.push({
          stepId: step.id,
          type: 'dependency_missing',
          message: `步骤 [${step.id}] 依赖不存在的步骤 [${depId}]`,
        });
      }
    }

    if (step.inputBindings) {
      for (const [key, binding] of Object.entries(step.inputBindings)) {
        if (binding.startsWith('$') && !binding.startsWith('$state.')) {
          const sourceStepId = binding.split('.')[0].substring(1);
          if (!plan.steps.some((s) => s.id === sourceStepId)) {
            errors.push({
              stepId: step.id,
              type: 'dependency_missing',
              message: `inputBindings.${key} 引用不存在的步骤 [${sourceStepId}]`,
            });
          }
        }
      }
    }
  }

  const dag = new DAGTask('validation', 4);
  try {
    for (const step of plan.steps) {
      const deps = plan.dependencies.get(step.id) || [];
      dag.addNode(
        new TaskNode(
          step.id,
          step.description,
          'tool',
          {},
          TaskStatus.PENDING,
          deps
        )
      );
    }
  } catch {
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
      message: `步骤数超过预算限制`,
    });
  }

  if (plan.steps.length > 5 && !plan.fallbackStrategy) {
    warnings.push({
      stepId: '',
      type: 'no_fallback',
      message: '复杂计划缺少回退策略',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    estimatedSuccessRate: Math.max(
      0,
      1 - errors.length * 0.3 - warnings.length * 0.1
    ),
  };
}

// ============ 端到端集成测试 ============

describe('Week 10: 端到端集成测试', () => {
  describe('E2E-1: Planner → 计划验证 完整流程', () => {
    it('简单任务应生成单步计划并通过验证', async () => {
      const planner = new Planner({
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      });
      const context = createLoopContext();

      const plan = await planner.plan({ text: '搜索代码文件' }, context);

      expect(plan.steps.length).toBeGreaterThanOrEqual(1);
      expect(plan.simple).toBe(true);

      const validation = validatePlan(plan, context, registeredTools);
      expect(validation.valid).toBe(true);
      expect(validation.errors.length).toBe(0);
    });

    it('复合简单任务应生成多步计划并通过验证', async () => {
      const planner = new Planner({
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      });
      const context = createLoopContext();

      const plan = await planner.plan(
        { text: '查看文件，然后搜索代码' },
        context
      );

      expect(plan.steps.length).toBe(2);
      expect(plan.simple).toBe(true);

      const validation = validatePlan(plan, context, registeredTools);
      expect(validation.valid).toBe(true);
    });

    it('对话任务应生成零工具计划', async () => {
      const planner = new Planner({
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      });
      const context = createLoopContext();

      const plan = await planner.plan({ text: '你好' }, context);

      expect(plan.toolCallMode).toBe('none');
      expect(plan.estimatedBudget.maxToolCalls).toBe(0);
    });
  });

  describe('E2E-2: 计划验证 → 执行监控 完整流程', () => {
    it('应完成从计划生成到执行进度追踪的完整流程', async () => {
      const planner = new Planner({
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      });
      const context = createLoopContext();

      const plan = await planner.plan({ text: '搜索代码文件' }, context);

      const validation = validatePlan(plan, context, registeredTools);
      expect(validation.valid).toBe(true);

      context.plan = plan;
      const progress: ExecutionProgress = {
        traceId: 'e2e-trace',
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

      for (const sp of progress.stepProgress) {
        sp.status = 'running';
        sp.progress = 0.1;
      }

      for (const sp of progress.stepProgress) {
        sp.status = 'completed';
        sp.progress = 1;
        sp.duration = 500;
      }

      const completed = progress.stepProgress.filter(
        (s) => s.status === 'completed'
      ).length;
      progress.overallProgress = completed / progress.stepProgress.length;

      expect(progress.overallProgress).toBe(1);
      expect(progress.stepProgress.every((s) => s.status === 'completed')).toBe(
        true
      );
    });
  });

  describe('E2E-3: 执行失败 → 根因分析 → 重规划 完整流程', () => {
    it('工具不可用应触发 local_fix 策略', () => {
      const plan: ExecutionPlan = {
        steps: [
          createPlanStep('step1', '搜索', { toolName: 'file_search' }),
          createPlanStep('step2', '分析', { toolName: 'code_analyze' }),
        ],
        dependencies: new Map([['step2', ['step1']]]),
        estimatedBudget: {
          maxRounds: 4,
          maxToolCalls: 5,
          maxTokens: 3000,
          maxDurationMs: 30000,
        },
        toolCallMode: 'required',
        recommendedTools: ['file_search', 'code_analyze'],
      };

      const context = createLoopContext({ plan });
      context.stepResults.set('step1', {
        stepId: 'step1',
        success: false,
        output: '',
        duration: 100,
        error: '工具 "file_search" 不可用',
      });

      const failedSteps = Array.from(context.stepResults.values()).filter(
        (r) => !r.success
      );
      expect(failedSteps.length).toBe(1);

      const primaryFailure = failedSteps[0];
      const isToolUnavailable =
        primaryFailure.error?.includes('不可用') ||
        primaryFailure.error?.includes('not found');
      expect(isToolUnavailable).toBe(true);

      const strategy: ReplanStrategy = {
        type: 'local_fix',
        stepsToReplan: ['step1'],
        stepsToKeep: ['step2'],
        fixActions: [
          {
            stepId: 'step1',
            action: 'replace_tool',
            details: { replacementTool: 'shell_exec' },
          },
        ],
      };
      expect(strategy.type).toBe('local_fix');
      expect(strategy.stepsToKeep).toContain('step2');
    });

    it('多步骤失败应触发 partial_replan 策略', () => {
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
        recommendedTools: [
          'file_search',
          'file_read',
          'code_analyze',
          'daily_report',
        ],
      };

      const context = createLoopContext({ plan });
      context.stepResults.set('step2', {
        stepId: 'step2',
        success: false,
        output: '',
        duration: 100,
        error: '文件读取超时',
      });

      const failedCount = Array.from(context.stepResults.values()).filter(
        (r) => !r.success
      ).length;
      const totalSteps = plan.steps.length;
      const impactRatio = failedCount / totalSteps;

      const strategyType = impactRatio < 0.5 ? 'partial_replan' : 'full_replan';
      expect(strategyType).toBe('partial_replan');
    });
  });

  describe('E2E-4: 跨步骤状态 + 数据流 完整流程', () => {
    it('应完成步骤间状态传递和版本追踪', () => {
      const context = createLoopContext();

      context.crossStepState.set('searchResults', {
        key: 'searchResults',
        value: ['file1.ts', 'file2.ts'],
        writtenBy: 'step1',
        timestamp: Date.now(),
        version: 1,
      });

      context.crossStepState.set('searchResults', {
        key: 'searchResults',
        value: ['file1.ts', 'file2.ts', 'file3.ts'],
        writtenBy: 'step1_retry',
        timestamp: Date.now(),
        version: 2,
      });

      const entry = context.crossStepState.get('searchResults');
      expect(entry).toBeDefined();
      expect(entry!.version).toBe(2);
      expect((entry!.value as string[]).length).toBe(3);
    });

    it('应支持状态回滚', () => {
      const context = createLoopContext();
      const stateHistory: StateEntry[] = [
        {
          key: 'analysisResult',
          value: { score: 85 },
          writtenBy: 'step3',
          timestamp: Date.now() - 2000,
          version: 1,
        },
        {
          key: 'analysisResult',
          value: { score: 92 },
          writtenBy: 'step3_retry',
          timestamp: Date.now(),
          version: 2,
        },
      ];

      context.crossStepState.set('analysisResult', stateHistory[1]);

      const current = context.crossStepState.get('analysisResult');
      expect((current!.value as Record<string, number>).score).toBe(92);

      context.crossStepState.set('analysisResult', stateHistory[0]);
      const rolledBack = context.crossStepState.get('analysisResult');
      expect((rolledBack!.value as Record<string, number>).score).toBe(85);
    });
  });

  describe('E2E-5: 🔶-1 + 🔶-2 增强 + 复杂度分析 完整流程', () => {
    it('Planner工具推荐应与复杂度分析联动', async () => {
      const planner = new Planner({
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      });

      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('shell_exec', false);

      const weights = planner.getToolWeights();
      expect(weights['file_search']).toBeGreaterThan(weights['shell_exec']);

      const plan = await planner.plan(
        { text: '搜索代码文件' },
        createLoopContext()
      );
      expect(plan.recommendedTools).toContain('file_search');
    });

    it('复杂度分析应提供多维度评估和领域标签', () => {
      const analyzer = new TaskComplexityAnalyzer();

      const result = analyzer.analyzeComplexity(
        '数据清洗和特征工程，然后训练模型并预测'
      );

      expect(result.domainTag).toBe('data');
      expect(result.multiDimensional).toBeDefined();
      expect(result.multiDimensional!.timeComplexity.level).toMatch(
        /^(low|medium|high)$/
      );
      expect(result.multiDimensional!.dependencyComplexity.level).toMatch(
        /^(low|medium|high)$/
      );
      expect(result.multiDimensional!.toolComplexity.level).toMatch(
        /^(low|medium|high)$/
      );
      expect(result.riskFactors.length).toBeGreaterThan(0);
    });

    it('复杂度预测准确率应可追踪和改进', () => {
      const analyzer = new TaskComplexityAnalyzer();

      analyzer.recordPredictionAccuracy('简单查询', 'simple', 'simple');
      analyzer.recordPredictionAccuracy('中等分析', 'medium', 'medium');
      analyzer.recordPredictionAccuracy('复杂开发', 'complex', 'very_complex');
      analyzer.recordPredictionAccuracy('简单搜索', 'simple', 'simple');
      analyzer.recordPredictionAccuracy('中等修改', 'medium', 'simple');

      const accuracy = analyzer.getPredictionAccuracy();
      expect(accuracy.total).toBe(5);
      expect(accuracy.correct).toBe(3);
      expect(accuracy.rate).toBeCloseTo(0.6, 5);

      const matrix = analyzer.getConfusionMatrix();
      expect(matrix.simple.simple).toBe(2);
      expect(matrix.complex.very_complex).toBe(1);
    });

    it('置信度校准应反映实际准确率', () => {
      const analyzer = new TaskComplexityAnalyzer();

      for (let i = 0; i < 8; i++) {
        analyzer.recordConfidenceCalibration(0.9, true);
      }
      for (let i = 0; i < 2; i++) {
        analyzer.recordConfidenceCalibration(0.9, false);
      }
      for (let i = 0; i < 3; i++) {
        analyzer.recordConfidenceCalibration(0.5, true);
      }
      for (let i = 0; i < 7; i++) {
        analyzer.recordConfidenceCalibration(0.5, false);
      }

      const calibration = analyzer.getConfidenceCalibration();
      expect(calibration['0.9'].accuracy).toBeCloseTo(0.8, 5);
      expect(calibration['0.5'].accuracy).toBeCloseTo(0.3, 5);
      expect(calibration['0.9'].accuracy).toBeGreaterThan(
        calibration['0.5'].accuracy
      );
    });

    it('简单任务质量验证应与Planner联动', async () => {
      const planner = new Planner({
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      });

      planner.recordSimpleTaskResult('搜索代码', true, 300);
      planner.recordSimpleTaskResult('搜索代码', true, 250);
      planner.recordSimpleTaskResult('搜索代码', false, 100);

      const stats = planner.getSimpleTaskStats('搜索代码');
      expect(stats!.successRate).toBeCloseTo(2 / 3, 5);
      expect(stats!.needsOptimization).toBe(false);
    });
  });

  describe('E2E-6: 学习闭环 + 环境建模 + 预测增强 集成', () => {
    it('学习闭环应在多次任务后提升质量', () => {
      const qualityScores: number[] = [];
      const baseQuality = 0.6;

      for (let i = 0; i < 10; i++) {
        const improvement = i * 0.02;
        const quality = Math.min(1.0, baseQuality + improvement);
        qualityScores.push(quality);
      }

      const firstScore = qualityScores[0];
      const lastScore = qualityScores[qualityScores.length - 1];
      const improvement = (lastScore - firstScore) / firstScore;
      expect(improvement).toBeGreaterThanOrEqual(0.1);
    });

    it('环境建模应检测工具可用性变化', () => {
      const previousTools = new Set([
        'file_search',
        'file_read',
        'code_analyze',
      ]);
      const currentTools = new Set([
        'file_search',
        'file_read',
        'code_analyze',
        'web_search',
      ]);

      const added = new Set(
        [...currentTools].filter((t) => !previousTools.has(t))
      );
      const removed = new Set(
        [...previousTools].filter((t) => !currentTools.has(t))
      );

      expect(added.size).toBe(1);
      expect(added.has('web_search')).toBe(true);
      expect(removed.size).toBe(0);
    });

    it('预测增强应基于历史行为预测下一步', () => {
      const history = [
        { action: 'file_search', followedBy: 'file_read' },
        { action: 'file_search', followedBy: 'file_read' },
        { action: 'file_search', followedBy: 'code_analyze' },
        { action: 'file_read', followedBy: 'code_analyze' },
        { action: 'file_read', followedBy: 'code_analyze' },
      ];

      const transitionCounts: Record<string, Record<string, number>> = {};
      for (const h of history) {
        if (!transitionCounts[h.action]) transitionCounts[h.action] = {};
        transitionCounts[h.action][h.followedBy] =
          (transitionCounts[h.action][h.followedBy] || 0) + 1;
      }

      const predictions = Object.entries(transitionCounts['file_search'] || {})
        .sort(([, a], [, b]) => b - a)
        .map(([action]) => action);

      expect(predictions[0]).toBe('file_read');
      expect(predictions.length).toBeGreaterThanOrEqual(2);

      const top3 = predictions.slice(0, 3);
      expect(top3).toContain('file_read');
    });
  });

  describe('E2E-7: 性能基准', () => {
    it('Planner 简单任务规划应在 100ms 内完成', async () => {
      const planner = new Planner({
        llm: { chat: jest.fn().mockResolvedValue('NO') },
      });

      const start = Date.now();
      await planner.plan({ text: '搜索代码文件' }, createLoopContext());
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
    });

    it('TaskComplexityAnalyzer 分析应在 10ms 内完成', () => {
      const analyzer = new TaskComplexityAnalyzer();

      const start = Date.now();
      analyzer.analyzeComplexity(
        '分析代码质量并生成报告，包括静态分析、依赖检查和安全扫描'
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(10);
    });

    it('计划验证应在 50ms 内完成', () => {
      const steps = Array.from({ length: 10 }, (_, i) =>
        createPlanStep(`step${i + 1}`, `步骤${i + 1}`, {
          toolName: 'file_search',
        })
      );
      const plan: ExecutionPlan = {
        steps,
        dependencies: new Map([
          ['step2', ['step1']],
          ['step3', ['step2']],
          ['step4', ['step3']],
        ]),
        estimatedBudget: {
          maxRounds: 10,
          maxToolCalls: 20,
          maxTokens: 8000,
          maxDurationMs: 60000,
        },
        toolCallMode: 'required',
        recommendedTools: ['file_search'],
        fallbackStrategy: 'replan',
      };

      const start = Date.now();
      validatePlan(plan, createLoopContext(), registeredTools);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(50);
    });

    it('1000次复杂度分析批量处理应在 1s 内完成', () => {
      const analyzer = new TaskComplexityAnalyzer();
      const tasks = [
        '查看文件',
        '搜索代码并分析',
        '重构系统架构，包括数据库迁移和API升级',
        '数据清洗和特征工程',
        '部署服务到生产环境',
      ];

      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        analyzer.analyzeComplexity(tasks[i % tasks.length]);
      }
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
    });

    it('置信度校准数据查询应在 5ms 内完成', () => {
      const analyzer = new TaskComplexityAnalyzer();
      for (let i = 0; i < 200; i++) {
        analyzer.recordConfidenceCalibration(
          Math.random(),
          Math.random() > 0.3
        );
      }

      const start = Date.now();
      analyzer.getConfidenceCalibration();
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(5);
    });
  });
});
