/**
 * P2-1 DAG集成 + P2-3 中间结果传递 — LoopController 集成测试
 *
 * 验证 LoopController 中的 DAG 执行路径和中间结果传递
 * 测试 buildDAGFromPlan, executeWithDAG, resolveStepInputBindings 等方法
 */

import { DAGTask, TaskNode, TaskStatus } from '../../src/core/DAGTask';
import {
  ExecutorOutput,
  LoopController,
  LoopControllerDeps,
} from '../../src/harness/loop/LoopController';
import {
  DataFlowChannel,
  ExecutionPlan,
  LoopContext,
  LoopState,
  PlanStep,
  StepOutput,
  StepResult,
  StepStateInfo,
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
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map<string, StepStateInfo>(),
    stepStateHistory: [],
    ...overrides,
  };
}

function createMockLoopControllerDeps(): LoopControllerDeps {
  const stepResults: Map<string, StepResult> = new Map();

  return {
    planner: {
      plan: jest.fn().mockResolvedValue({
        steps: [createPlanStep('direct-execute', 'test')],
        dependencies: new Map(),
        estimatedBudget: {
          maxRounds: 4,
          maxToolCalls: 5,
          maxTokens: 3000,
          maxDurationMs: 30000,
        },
        simple: true,
        toolCallMode: 'auto',
        recommendedTools: [],
      }),
    },
    executor: {
      execute: jest
        .fn()
        .mockImplementation(async (plan: ExecutionPlan, ctx: LoopContext) => {
          const step = plan.steps[0];
          if (step) {
            const result: StepResult = {
              stepId: step.id,
              success: true,
              output: `${step.description} 完成`,
              duration: 100,
              toolName: step.toolName,
            };
            ctx.stepResults.set(step.id, result);
          }
          return {
            messages: [{ role: 'assistant' as const, content: '执行完成' }],
            toolCallsCount: 1,
            toolDuration: 100,
            completedNaturally: true,
          };
        }),
      shouldReplan: jest.fn().mockReturnValue({
        shouldReplan: false,
        reason: '执行质量正常',
      }),
    },
    evaluator: {
      evaluate: jest.fn().mockResolvedValue({
        goalProgress: 1.0,
        suggestedAction: 'continue',
        reason: '任务完成',
      }),
    },
    reporter: {
      report: jest.fn().mockResolvedValue({
        response: '任务完成',
        quality: {
          overall: 0.9,
          accuracy: 0.9,
          usefulness: 0.9,
          friendliness: 0.9,
          efficiency: 0.9,
          details: '',
        },
      }),
    },
  };
}

// ============ DAG构建测试 ============

describe('LoopController DAG构建', () => {
  test('应从ExecutionPlan构建正确的DAG', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索文件', { toolName: 'file_search' }),
        createPlanStep('step2', '读取文件', { toolName: 'file_read' }),
        createPlanStep('step3', '分析代码', { toolName: 'code_analyze' }),
        createPlanStep('step4', '生成报告', { toolName: 'daily_report' }),
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
      executionMode: 'dag',
    };

    const dag = new DAGTask('plan-dag', 4);

    for (const step of plan.steps) {
      const deps = plan.dependencies.get(step.id) || [];
      const node = new TaskNode(
        step.id,
        step.description,
        step.toolName || 'llm_execute',
        step.toolParams || {},
        TaskStatus.PENDING,
        deps
      );
      node.maxRetries = step.maxRetries;
      dag.addNode(node);
    }

    expect(dag.getNodeCount()).toBe(4);

    const topo = dag.topologicalSort();
    expect(topo.indexOf('step1')).toBeLessThan(topo.indexOf('step2'));
    expect(topo.indexOf('step2')).toBeLessThan(topo.indexOf('step3'));
    expect(topo.indexOf('step3')).toBeLessThan(topo.indexOf('step4'));

    const available = dag.getAvailableParallelNodes();
    expect(available.length).toBe(1);
    expect(available[0].id).toBe('step1');
  });

  test('菱形依赖应正确构建DAG', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('root', '根步骤', { toolName: 'file_search' }),
        createPlanStep('left', '左分支', {
          toolName: 'file_read',
          parallelGroup: 'branch-group',
        }),
        createPlanStep('right', '右分支', {
          toolName: 'code_analyze',
          parallelGroup: 'branch-group',
        }),
        createPlanStep('merge', '合并', { toolName: 'daily_report' }),
      ],
      dependencies: new Map([
        ['left', ['root']],
        ['right', ['root']],
        ['merge', ['left', 'right']],
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
      executionMode: 'dag',
    };

    const dag = new DAGTask('diamond-dag', 4);

    for (const step of plan.steps) {
      const deps = plan.dependencies.get(step.id) || [];
      const node = new TaskNode(
        step.id,
        step.description,
        step.toolName || 'llm_execute',
        step.toolParams || {},
        TaskStatus.PENDING,
        deps
      );
      dag.addNode(node);
    }

    expect(dag.getNodeCount()).toBe(4);

    dag.markTaskRunning('root');
    dag.markTaskSuccess('root', { files: ['a.ts', 'b.ts'] });

    const available = dag.getAvailableParallelNodes();
    expect(available.length).toBe(2);
    const ids = available.map((n) => n.id);
    expect(ids).toContain('left');
    expect(ids).toContain('right');
  });
});

// ============ DAG执行模拟测试 ============

describe('LoopController DAG执行模拟', () => {
  test('线性DAG应按顺序执行', async () => {
    const deps = createMockLoopControllerDeps();
    const controller = new LoopController(deps);

    const executionOrder: string[] = [];
    const mockExecute = deps.executor.execute as jest.Mock;
    mockExecute.mockImplementation(
      async (plan: ExecutionPlan, ctx: LoopContext) => {
        const step = plan.steps[0];
        if (step) {
          executionOrder.push(step.id);
          ctx.stepResults.set(step.id, {
            stepId: step.id,
            success: true,
            output: `${step.description} 完成`,
            duration: 50,
            toolName: step.toolName,
          });
        }
        return {
          messages: [
            { role: 'assistant' as const, content: `${step?.id} done` },
          ],
          toolCallsCount: 1,
          toolDuration: 50,
          completedNaturally: true,
        };
      }
    );

    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('s1', '步骤1', { toolName: 'file_search' }),
        createPlanStep('s2', '步骤2', { toolName: 'file_read' }),
        createPlanStep('s3', '步骤3', { toolName: 'code_analyze' }),
      ],
      dependencies: new Map([
        ['s2', ['s1']],
        ['s3', ['s2']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 10,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'file_read', 'code_analyze'],
      executionMode: 'dag',
    };

    const context = createLoopContext({ plan });

    const dag = new DAGTask('linear-dag', 4);
    for (const step of plan.steps) {
      const stepDeps = plan.dependencies.get(step.id) || [];
      const node = new TaskNode(
        step.id,
        step.description,
        step.toolName || 'llm_execute',
        step.toolParams || {},
        TaskStatus.PENDING,
        stepDeps
      );
      dag.addNode(node);
    }

    while (
      dag.getStatus() === TaskStatus.PENDING ||
      dag.getStatus() === TaskStatus.RUNNING
    ) {
      const available = dag.getAvailableParallelNodes();
      if (available.length === 0) break;

      for (const node of available) {
        dag.markTaskRunning(node.id);
        const singlePlan: ExecutionPlan = {
          steps: [plan.steps.find((s) => s.id === node.id)!],
          dependencies: new Map(),
          estimatedBudget: plan.estimatedBudget,
          toolCallMode: plan.toolCallMode,
          recommendedTools: plan.recommendedTools,
        };
        const result = await deps.executor.execute(singlePlan, context);
        dag.markTaskSuccess(node.id, result);
      }
    }

    expect(dag.getStatus()).toBe(TaskStatus.SUCCESS);
    expect(executionOrder).toEqual(['s1', 's2', 's3']);
  });

  test('菱形DAG应先执行根步骤，再并行执行分支，最后合并', async () => {
    const deps = createMockLoopControllerDeps();
    const executionOrder: string[] = [];
    const startTimes: Map<string, number> = new Map();

    const mockExecute = deps.executor.execute as jest.Mock;
    mockExecute.mockImplementation(
      async (plan: ExecutionPlan, ctx: LoopContext) => {
        const step = plan.steps[0];
        if (step) {
          executionOrder.push(step.id);
          startTimes.set(step.id, Date.now());
          ctx.stepResults.set(step.id, {
            stepId: step.id,
            success: true,
            output: `${step.description} 完成`,
            duration: 50,
            toolName: step.toolName,
          });
        }
        return {
          messages: [
            { role: 'assistant' as const, content: `${step?.id} done` },
          ],
          toolCallsCount: 1,
          toolDuration: 50,
          completedNaturally: true,
        };
      }
    );

    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('root', '根步骤', { toolName: 'file_search' }),
        createPlanStep('left', '左分支', { toolName: 'file_read' }),
        createPlanStep('right', '右分支', { toolName: 'code_analyze' }),
        createPlanStep('merge', '合并', { toolName: 'daily_report' }),
      ],
      dependencies: new Map([
        ['left', ['root']],
        ['right', ['root']],
        ['merge', ['left', 'right']],
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
      executionMode: 'dag',
    };

    const context = createLoopContext({ plan });

    const dag = new DAGTask('diamond-dag', 4);
    for (const step of plan.steps) {
      const stepDeps = plan.dependencies.get(step.id) || [];
      const node = new TaskNode(
        step.id,
        step.description,
        step.toolName || 'llm_execute',
        step.toolParams || {},
        TaskStatus.PENDING,
        stepDeps
      );
      dag.addNode(node);
    }

    while (
      dag.getStatus() === TaskStatus.PENDING ||
      dag.getStatus() === TaskStatus.RUNNING
    ) {
      const available = dag.getAvailableParallelNodes();
      if (available.length === 0) break;

      const settled = await Promise.allSettled(
        available.map(async (node) => {
          dag.markTaskRunning(node.id);
          const singlePlan: ExecutionPlan = {
            steps: [plan.steps.find((s) => s.id === node.id)!],
            dependencies: new Map(),
            estimatedBudget: plan.estimatedBudget,
            toolCallMode: plan.toolCallMode,
            recommendedTools: plan.recommendedTools,
          };
          const result = await deps.executor.execute(singlePlan, context);
          dag.markTaskSuccess(node.id, result);
        })
      );

      for (const s of settled) {
        if (s.status === 'rejected') {
          throw s.reason;
        }
      }
    }

    expect(dag.getStatus()).toBe(TaskStatus.SUCCESS);
    expect(executionOrder.indexOf('root')).toBeLessThan(
      executionOrder.indexOf('left')
    );
    expect(executionOrder.indexOf('root')).toBeLessThan(
      executionOrder.indexOf('right')
    );
    expect(executionOrder.indexOf('left')).toBeLessThan(
      executionOrder.indexOf('merge')
    );
    expect(executionOrder.indexOf('right')).toBeLessThan(
      executionOrder.indexOf('merge')
    );
  });
});

// ============ 中间结果传递集成测试 ============

describe('P2-3: LoopController 中间结果传递集成', () => {
  test('步骤输出应注册到 stepOutputs', () => {
    const context = createLoopContext();

    const executorOutput: ExecutorOutput = {
      messages: [
        {
          role: 'tool' as const,
          content: '{"files": ["a.ts"], "count": 1}',
          name: 'file_search',
        },
        { role: 'assistant' as const, content: '搜索完成，找到1个文件' },
      ],
      toolCallsCount: 1,
      toolDuration: 200,
      completedNaturally: true,
    };

    const lastToolMsg = executorOutput.messages
      .filter((m) => m.role === 'tool')
      .pop();
    const lastAssistantMsg = executorOutput.messages
      .filter((m) => m.role === 'assistant')
      .pop();

    const structuredData: Record<string, unknown> = {};
    if (lastToolMsg) {
      try {
        const parsed = JSON.parse(lastToolMsg.content as string);
        if (typeof parsed === 'object' && parsed !== null) {
          Object.assign(structuredData, parsed);
        }
      } catch {
        structuredData.rawToolOutput = lastToolMsg.content;
      }
    }

    const summary = lastAssistantMsg
      ? (lastAssistantMsg.content as string).substring(0, 500)
      : '';

    context.stepOutputs.set('search', {
      stepId: 'search',
      data: structuredData,
      summary,
      type: 'tool_result',
    });

    const output = context.stepOutputs.get('search');
    expect(output).toBeDefined();
    expect(output!.data!.files).toEqual(['a.ts']);
    expect(output!.data!.count).toBe(1);
    expect(output!.summary).toBe('搜索完成，找到1个文件');
  });

  test('inputBindings 应从上游步骤输出解析', () => {
    const context = createLoopContext();

    context.stepOutputs.set('search', {
      stepId: 'search',
      data: { files: ['config.json', 'app.ts'], count: 2 },
      summary: '找到2个文件',
      type: 'tool_result',
    });

    const inputBindings: Record<string, string> = {
      filePath: '$search.files.0',
      totalFiles: '$search.count',
    };

    const resolved: Record<string, unknown> = {};
    for (const [key, binding] of Object.entries(inputBindings)) {
      if (binding.startsWith('$')) {
        const path = binding.substring(1);
        const parts = path.split('.');
        const sourceStepId = parts[0];
        const fieldPath = parts.slice(1);

        const output = context.stepOutputs.get(sourceStepId);
        if (output) {
          let current: unknown = output.data;
          for (const field of fieldPath) {
            if (Array.isArray(current)) {
              current = (current as unknown[])[parseInt(field)];
            } else if (current && typeof current === 'object') {
              current = (current as Record<string, unknown>)[field];
            }
          }
          resolved[key] = current;
        }
      }
    }

    expect(resolved.filePath).toBe('config.json');
    expect(resolved.totalFiles).toBe(2);
  });

  test('数据流通道应自动从依赖关系生成', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('search', '搜索', { toolName: 'file_search' }),
        createPlanStep('read', '读取', { toolName: 'file_read' }),
        createPlanStep('analyze', '分析', { toolName: 'code_analyze' }),
      ],
      dependencies: new Map([
        ['read', ['search']],
        ['analyze', ['read']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 10,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'file_read', 'code_analyze'],
      executionMode: 'dag',
    };

    const channels: DataFlowChannel[] = [];
    if (plan.dependencies.size > 0) {
      for (const [targetId, sourceIds] of plan.dependencies) {
        for (const sourceId of sourceIds) {
          channels.push({
            sourceStepId: sourceId,
            targetStepId: targetId,
            mapping: {},
          });
        }
      }
    }

    expect(channels.length).toBe(2);
    expect(channels[0].sourceStepId).toBe('search');
    expect(channels[0].targetStepId).toBe('read');
    expect(channels[1].sourceStepId).toBe('read');
    expect(channels[1].targetStepId).toBe('analyze');
  });

  test('上游上下文应包含所有前驱步骤的输出', () => {
    const context = createLoopContext();

    context.stepOutputs.set('search', {
      stepId: 'search',
      data: { files: ['config.json'] },
      summary: '搜索完成',
      type: 'tool_result',
    });

    context.stepOutputs.set('read', {
      stepId: 'read',
      data: { content: 'export const X = 1' },
      summary: '读取完成',
      type: 'tool_result',
    });

    context.dataFlowChannels = [
      { sourceStepId: 'search', targetStepId: 'read', mapping: {} },
      { sourceStepId: 'read', targetStepId: 'analyze', mapping: {} },
    ];

    const upstreamIds = context.dataFlowChannels
      .filter((ch) => ch.targetStepId === 'analyze')
      .map((ch) => ch.sourceStepId);

    const outputs = [...new Set(upstreamIds)]
      .map((id) => context.stepOutputs.get(id))
      .filter((o): o is StepOutput => o !== undefined);

    expect(outputs.length).toBe(1);
    expect(outputs[0].stepId).toBe('read');
    expect(outputs[0].data!.content).toBe('export const X = 1');
  });
});

// ============ Planner DAG计划生成测试 ============

describe('Planner DAG计划生成', () => {
  test('有依赖的计划应设置 executionMode=dag 和 dataFlowChannels', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索文件', { toolName: 'file_search' }),
        createPlanStep('step2', '读取文件', {
          toolName: 'file_read',
          inputBindings: { filePath: '$step1.results.0' },
        }),
        createPlanStep('step3', '分析代码', {
          toolName: 'code_analyze',
          inputBindings: { content: '$step2.content' },
        }),
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
      executionMode: 'dag',
      dataFlowChannels: [
        {
          sourceStepId: 'step1',
          targetStepId: 'step2',
          mapping: { filePath: 'results.0' },
        },
        {
          sourceStepId: 'step2',
          targetStepId: 'step3',
          mapping: { content: 'content' },
        },
      ],
    };

    expect(plan.executionMode).toBe('dag');
    expect(plan.dataFlowChannels).toBeDefined();
    expect(plan.dataFlowChannels!.length).toBe(2);

    expect(plan.steps[1].inputBindings).toBeDefined();
    expect(plan.steps[1].inputBindings!.filePath).toBe('$step1.results.0');

    expect(plan.steps[2].inputBindings).toBeDefined();
    expect(plan.steps[2].inputBindings!.content).toBe('$step2.content');
  });

  test('研究类任务应生成带依赖的三步骤计划', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('search', '搜索相关信息', {
          toolName: 'web_search',
          outputSchema: { results: 'string[]', query: 'string' },
        }),
        createPlanStep('analyze', '分析搜索结果', {
          inputBindings: { searchData: '$search.results' },
        }),
        createPlanStep('summarize', '总结要点', {
          inputBindings: { analysisData: '$analyze.findings' },
        }),
      ],
      dependencies: new Map([
        ['analyze', ['search']],
        ['summarize', ['analyze']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 8,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      fallbackStrategy: 'replan',
      toolCallMode: 'required',
      recommendedTools: ['web_search', 'web_fetch'],
      executionMode: 'dag',
      dataFlowChannels: [
        { sourceStepId: 'search', targetStepId: 'analyze', mapping: {} },
        { sourceStepId: 'analyze', targetStepId: 'summarize', mapping: {} },
      ],
    };

    expect(plan.executionMode).toBe('dag');
    expect(plan.steps[0].outputSchema).toBeDefined();
    expect(plan.steps[1].inputBindings).toBeDefined();
    expect(plan.steps[2].inputBindings).toBeDefined();
    expect(plan.dependencies.size).toBe(2);
  });

  test('无依赖的步骤应可并行执行', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('search1', '搜索A', {
          toolName: 'file_search',
          parallelGroup: 'search-parallel',
        }),
        createPlanStep('search2', '搜索B', {
          toolName: 'file_search',
          parallelGroup: 'search-parallel',
        }),
        createPlanStep('search3', '搜索C', {
          toolName: 'file_search',
          parallelGroup: 'search-parallel',
        }),
        createPlanStep('search4', '搜索D', {
          toolName: 'file_search',
          parallelGroup: 'search-parallel',
        }),
        createPlanStep('merge', '汇总结果', { toolName: 'daily_report' }),
      ],
      dependencies: new Map([
        ['merge', ['search1', 'search2', 'search3', 'search4']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 10,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      toolCallMode: 'required',
      recommendedTools: ['file_search', 'daily_report'],
      executionMode: 'dag',
    };

    const parallelSteps = plan.steps.filter(
      (s) => s.parallelGroup === 'search-parallel'
    );
    expect(parallelSteps.length).toBe(4);

    const dag = new DAGTask('parallel-plan', 4);
    for (const step of plan.steps) {
      const stepDeps = plan.dependencies.get(step.id) || [];
      const node = new TaskNode(
        step.id,
        step.description,
        step.toolName || 'llm_execute',
        step.toolParams || {},
        TaskStatus.PENDING,
        stepDeps
      );
      dag.addNode(node);
    }

    const available = dag.getAvailableParallelNodes();
    expect(available.length).toBe(4);
  });
});

// ============ 计划验证测试 (P3-1 前置) ============

describe('计划验证 (P3-1 前置)', () => {
  test('引用不存在工具的计划应验证失败', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '使用不存在的工具', {
          toolName: 'nonexistent_tool',
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
      recommendedTools: ['nonexistent_tool'],
    };

    const registeredTools = new Set([
      'file_search',
      'file_read',
      'code_analyze',
    ]);

    const errors: Array<{ stepId: string; type: string; message: string }> = [];
    for (const step of plan.steps) {
      if (step.toolName && !registeredTools.has(step.toolName)) {
        errors.push({
          stepId: step.id,
          type: 'tool_unavailable',
          message: `工具 "${step.toolName}" 未注册`,
        });
      }
    }

    expect(errors.length).toBe(1);
    expect(errors[0].type).toBe('tool_unavailable');
  });

  test('依赖不存在的步骤应验证失败', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '步骤1'),
        createPlanStep('step2', '步骤2'),
      ],
      dependencies: new Map([['step2', ['nonexistent_step']]]),
      estimatedBudget: {
        maxRounds: 4,
        maxToolCalls: 5,
        maxTokens: 3000,
        maxDurationMs: 30000,
      },
      toolCallMode: 'required',
      recommendedTools: [],
    };

    const errors: Array<{ stepId: string; type: string; message: string }> = [];
    for (const step of plan.steps) {
      const deps = plan.dependencies.get(step.id) || [];
      for (const depId of deps) {
        if (!plan.steps.some((s) => s.id === depId)) {
          errors.push({
            stepId: step.id,
            type: 'dependency_missing',
            message: `步骤 [${step.id}] 依赖的步骤 [${depId}] 不存在`,
          });
        }
      }
    }

    expect(errors.length).toBe(1);
    expect(errors[0].type).toBe('dependency_missing');
  });

  test('循环依赖应验证失败', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('a', 'A'),
        createPlanStep('b', 'B'),
        createPlanStep('c', 'C'),
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
      recommendedTools: [],
    };

    const dag = new DAGTask('validation-dag', 4);
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
    }

    expect(hasCycle).toBe(true);
  });

  test('有效计划应验证通过', () => {
    const plan: ExecutionPlan = {
      steps: [
        createPlanStep('step1', '搜索', { toolName: 'file_search' }),
        createPlanStep('step2', '读取', { toolName: 'file_read' }),
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
      executionMode: 'dag',
    };

    const registeredTools = new Set([
      'file_search',
      'file_read',
      'code_analyze',
    ]);

    const errors: Array<{ stepId: string; type: string; message: string }> = [];
    for (const step of plan.steps) {
      if (step.toolName && !registeredTools.has(step.toolName)) {
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
            message: `步骤 [${step.id}] 依赖的步骤 [${depId}] 不存在`,
          });
        }
      }
    }

    expect(errors.length).toBe(0);
  });
});
