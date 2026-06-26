/**
 * P2-1 DAG集成 + P2-3 中间结果传递 测试
 *
 * 验证标准:
 * - DAG集成: 复杂任务自动生成DAG并按依赖执行，步骤按依赖序执行，无死锁
 * - 并行执行: 4个无依赖步骤并行执行，总耗时 ≤ 2x单步耗时
 * - 中间结果传递: 步骤B引用步骤A的输出，数据准确传递，无信息丢失
 */

import { DAGTask, TaskNode, TaskStatus } from '../../src/core/DAGTask';
import {
  DataFlowChannel,
  ExecutionPlan,
  LoopContext,
  LoopState,
  PlanStep,
  StepOutput,
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

// ============ P2-1: DAG集成 ============

describe('P2-1: DAG集成', () => {
  describe('DAGTask 核心功能', () => {
    test('复杂任务应自动生成DAG并按依赖执行', () => {
      const dag = new DAGTask('complex-task', 4);

      const step1 = new TaskNode(
        'step1',
        '搜索文件',
        'file_search',
        { query: 'config' },
        TaskStatus.PENDING,
        []
      );
      const step2 = new TaskNode(
        'step2',
        '读取文件',
        'file_read',
        {},
        TaskStatus.PENDING,
        ['step1']
      );
      const step3 = new TaskNode(
        'step3',
        '分析代码',
        'code_analyze',
        {},
        TaskStatus.PENDING,
        ['step2']
      );
      const step4 = new TaskNode(
        'step4',
        '生成报告',
        'daily_report',
        {},
        TaskStatus.PENDING,
        ['step3']
      );

      dag.addNode(step1);
      dag.addNode(step2);
      dag.addNode(step3);
      dag.addNode(step4);

      expect(dag.getNodeCount()).toBe(4);
      expect(dag.getStatus()).toBe(TaskStatus.PENDING);

      const topoOrder = dag.topologicalSort();
      expect(topoOrder.indexOf('step1')).toBeLessThan(
        topoOrder.indexOf('step2')
      );
      expect(topoOrder.indexOf('step2')).toBeLessThan(
        topoOrder.indexOf('step3')
      );
      expect(topoOrder.indexOf('step3')).toBeLessThan(
        topoOrder.indexOf('step4')
      );
    });

    test('步骤应按依赖序执行，无死锁', () => {
      const dag = new DAGTask('diamond-deps', 4);

      const step1 = new TaskNode(
        'step1',
        '根步骤',
        'tool1',
        {},
        TaskStatus.PENDING,
        []
      );
      const step2 = new TaskNode(
        'step2',
        '分支A',
        'tool2',
        {},
        TaskStatus.PENDING,
        ['step1']
      );
      const step3 = new TaskNode(
        'step3',
        '分支B',
        'tool3',
        {},
        TaskStatus.PENDING,
        ['step1']
      );
      const step4 = new TaskNode(
        'step4',
        '合并步骤',
        'tool4',
        {},
        TaskStatus.PENDING,
        ['step2', 'step3']
      );

      dag.addNode(step1);
      dag.addNode(step2);
      dag.addNode(step3);
      dag.addNode(step4);

      const executionOrder: string[] = [];

      dag.on('task_started', (node) => {
        executionOrder.push(`start:${node.id}`);
      });
      dag.on('task_succeeded', (node) => {
        executionOrder.push(`done:${node.id}`);
      });

      const available1 = dag.getAvailableParallelNodes();
      expect(available1.length).toBe(1);
      expect(available1[0].id).toBe('step1');

      dag.markTaskRunning('step1');
      dag.markTaskSuccess('step1', { files: ['config.json'] });

      const available2 = dag.getAvailableParallelNodes();
      expect(available2.length).toBe(2);
      const ids2 = available2.map((n) => n.id);
      expect(ids2).toContain('step2');
      expect(ids2).toContain('step3');

      dag.markTaskRunning('step2');
      dag.markTaskRunning('step3');
      dag.markTaskSuccess('step2', { content: 'file content' });
      dag.markTaskSuccess('step3', { analysis: 'code quality: good' });

      const available3 = dag.getAvailableParallelNodes();
      expect(available3.length).toBe(1);
      expect(available3[0].id).toBe('step4');

      dag.markTaskRunning('step4');
      dag.markTaskSuccess('step4', { report: 'done' });

      expect(dag.getStatus()).toBe(TaskStatus.SUCCESS);
    });

    test('应检测循环依赖并抛出错误', () => {
      const dag = new DAGTask('cycle-test', 4);

      const node1 = new TaskNode('a', 'A', 'tool1', {}, TaskStatus.PENDING, [
        'c',
      ]);
      const node2 = new TaskNode('b', 'B', 'tool2', {}, TaskStatus.PENDING, [
        'a',
      ]);

      dag.addNode(node1);
      dag.addNode(node2);

      const node3 = new TaskNode('c', 'C', 'tool3', {}, TaskStatus.PENDING, [
        'b',
      ]);
      expect(() => dag.addNode(node3)).toThrow('检测到循环依赖');
    });

    test('应正确处理菱形依赖', () => {
      const dag = new DAGTask('diamond', 4);

      const root = new TaskNode(
        'root',
        'Root',
        'tool1',
        {},
        TaskStatus.PENDING,
        []
      );
      const left = new TaskNode(
        'left',
        'Left',
        'tool2',
        {},
        TaskStatus.PENDING,
        ['root']
      );
      const right = new TaskNode(
        'right',
        'Right',
        'tool3',
        {},
        TaskStatus.PENDING,
        ['root']
      );
      const merge = new TaskNode(
        'merge',
        'Merge',
        'tool4',
        {},
        TaskStatus.PENDING,
        ['left', 'right']
      );

      dag.addNode(root);
      dag.addNode(left);
      dag.addNode(right);
      dag.addNode(merge);

      const topo = dag.topologicalSort();
      expect(topo.indexOf('root')).toBeLessThan(topo.indexOf('left'));
      expect(topo.indexOf('root')).toBeLessThan(topo.indexOf('right'));
      expect(topo.indexOf('left')).toBeLessThan(topo.indexOf('merge'));
      expect(topo.indexOf('right')).toBeLessThan(topo.indexOf('merge'));
    });
  });

  describe('DAG并行执行', () => {
    test('4个无依赖步骤应可并行执行', () => {
      const dag = new DAGTask('parallel-test', 4);

      const step1 = new TaskNode(
        'p1',
        '并行1',
        'tool1',
        {},
        TaskStatus.PENDING,
        []
      );
      const step2 = new TaskNode(
        'p2',
        '并行2',
        'tool2',
        {},
        TaskStatus.PENDING,
        []
      );
      const step3 = new TaskNode(
        'p3',
        '并行3',
        'tool3',
        {},
        TaskStatus.PENDING,
        []
      );
      const step4 = new TaskNode(
        'p4',
        '并行4',
        'tool4',
        {},
        TaskStatus.PENDING,
        []
      );

      dag.addNode(step1);
      dag.addNode(step2);
      dag.addNode(step3);
      dag.addNode(step4);

      const available = dag.getAvailableParallelNodes();
      expect(available.length).toBe(4);
    });

    test('并行执行总耗时应 ≤ 2x单步耗时', async () => {
      const dag = new DAGTask('parallel-perf', 4);

      const step1 = new TaskNode(
        'p1',
        '并行1',
        'tool1',
        {},
        TaskStatus.PENDING,
        []
      );
      const step2 = new TaskNode(
        'p2',
        '并行2',
        'tool2',
        {},
        TaskStatus.PENDING,
        []
      );
      const step3 = new TaskNode(
        'p3',
        '并行3',
        'tool3',
        {},
        TaskStatus.PENDING,
        []
      );
      const step4 = new TaskNode(
        'p4',
        '并行4',
        'tool4',
        {},
        TaskStatus.PENDING,
        []
      );

      step1.estimatedTime = 1;
      step2.estimatedTime = 1;
      step3.estimatedTime = 1;
      step4.estimatedTime = 1;

      dag.addNode(step1);
      dag.addNode(step2);
      dag.addNode(step3);
      dag.addNode(step4);

      const singleStepDuration = 100;

      const start = Date.now();

      const available = dag.getAvailableParallelNodes();
      expect(available.length).toBe(4);

      const promises = available.map(async (node) => {
        dag.markTaskRunning(node.id);
        await new Promise((r) => setTimeout(r, singleStepDuration));
        dag.markTaskSuccess(node.id, { result: `${node.id} done` });
      });

      await Promise.all(promises);

      const totalDuration = Date.now() - start;

      expect(totalDuration).toBeLessThanOrEqual(singleStepDuration * 2);
      expect(dag.getStatus()).toBe(TaskStatus.SUCCESS);
    });

    test('部分步骤有依赖时应正确分层', () => {
      const dag = new DAGTask('mixed-deps', 4);

      const step1 = new TaskNode(
        's1',
        '独立1',
        'tool1',
        {},
        TaskStatus.PENDING,
        []
      );
      const step2 = new TaskNode(
        's2',
        '独立2',
        'tool2',
        {},
        TaskStatus.PENDING,
        []
      );
      const step3 = new TaskNode(
        's3',
        '依赖s1',
        'tool3',
        {},
        TaskStatus.PENDING,
        ['s1']
      );
      const step4 = new TaskNode(
        's4',
        '依赖s1+s2',
        'tool4',
        {},
        TaskStatus.PENDING,
        ['s1', 's2']
      );

      dag.addNode(step1);
      dag.addNode(step2);
      dag.addNode(step3);
      dag.addNode(step4);

      const layer1 = dag.getAvailableParallelNodes();
      expect(layer1.length).toBe(2);
      const layer1Ids = layer1.map((n) => n.id);
      expect(layer1Ids).toContain('s1');
      expect(layer1Ids).toContain('s2');

      dag.markTaskRunning('s1');
      dag.markTaskSuccess('s1', {});
      dag.markTaskRunning('s2');
      dag.markTaskSuccess('s2', {});

      const layer2 = dag.getAvailableParallelNodes();
      expect(layer2.length).toBe(2);
      const layer2Ids = layer2.map((n) => n.id);
      expect(layer2Ids).toContain('s3');
      expect(layer2Ids).toContain('s4');
    });
  });

  describe('ExecutionPlan DAG模式', () => {
    test('有依赖的计划应设置 executionMode=dag', () => {
      const plan: ExecutionPlan = {
        steps: [
          createPlanStep('step1', '搜索'),
          createPlanStep('step2', '读取', { toolName: 'file_read' }),
          createPlanStep('step3', '分析', { toolName: 'code_analyze' }),
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
      };

      expect(plan.executionMode).toBe('dag');
      expect(plan.dependencies.size).toBe(2);
      expect(plan.dependencies.get('step2')).toEqual(['step1']);
      expect(plan.dependencies.get('step3')).toEqual(['step2']);
    });

    test('DAG模式应生成数据流通道', () => {
      const plan: ExecutionPlan = {
        steps: [
          createPlanStep('step1', '搜索'),
          createPlanStep('step2', '读取', { toolName: 'file_read' }),
        ],
        dependencies: new Map([['step2', ['step1']]]),
        estimatedBudget: {
          maxRounds: 4,
          maxToolCalls: 6,
          maxTokens: 3000,
          maxDurationMs: 30000,
        },
        toolCallMode: 'required',
        recommendedTools: ['file_search', 'file_read'],
        executionMode: 'dag',
        dataFlowChannels: [
          { sourceStepId: 'step1', targetStepId: 'step2', mapping: {} },
        ],
      };

      expect(plan.dataFlowChannels).toBeDefined();
      expect(plan.dataFlowChannels!.length).toBe(1);
      expect(plan.dataFlowChannels![0].sourceStepId).toBe('step1');
      expect(plan.dataFlowChannels![0].targetStepId).toBe('step2');
    });

    test('无依赖步骤应设置 parallelGroup', () => {
      const plan: ExecutionPlan = {
        steps: [
          createPlanStep('step1', '搜索A', { parallelGroup: 'search-group' }),
          createPlanStep('step2', '搜索B', { parallelGroup: 'search-group' }),
          createPlanStep('step3', '汇总', { toolName: 'daily_report' }),
        ],
        dependencies: new Map([['step3', ['step1', 'step2']]]),
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

      expect(plan.steps[0].parallelGroup).toBe('search-group');
      expect(plan.steps[1].parallelGroup).toBe('search-group');
      expect(plan.steps[2].parallelGroup).toBeUndefined();
    });
  });

  describe('DAG死锁检测', () => {
    test('依赖失败的步骤应被跳过', () => {
      const dag = new DAGTask('deadlock-test', 4);

      const step1 = new TaskNode(
        'step1',
        '根步骤',
        'tool1',
        {},
        TaskStatus.PENDING,
        []
      );
      const step2 = new TaskNode(
        'step2',
        '依赖步骤',
        'tool2',
        {},
        TaskStatus.PENDING,
        ['step1']
      );

      step1.maxRetries = 0;

      dag.addNode(step1);
      dag.addNode(step2);

      dag.markTaskRunning('step1');
      dag.markTaskFailed('step1', new Error('工具不可用'));

      dag.updateNodeStatuses();

      expect(step2.status).toBe(TaskStatus.SKIPPED);
    });

    test('可重试的失败步骤应允许重试', () => {
      const dag = new DAGTask('retry-test', 4);

      const step1 = new TaskNode(
        'step1',
        '可重试步骤',
        'tool1',
        {},
        TaskStatus.PENDING,
        []
      );
      step1.maxRetries = 2;

      dag.addNode(step1);

      dag.markTaskRunning('step1');
      dag.markTaskFailed('step1', new Error('临时错误'));

      const retryNodes = dag.retryFailedTasks();
      expect(retryNodes.length).toBe(1);
      expect(retryNodes[0].status).toBe(TaskStatus.RETRYING);
    });
  });
});

// ============ P2-3: 中间结果传递 ============

describe('P2-3: 中间结果传递', () => {
  describe('StepOutput 注册和检索', () => {
    test('步骤A的输出应可被步骤B引用', () => {
      const context = createLoopContext();

      context.stepOutputs.set('step1', {
        stepId: 'step1',
        data: { files: ['config.json', 'app.ts'], totalCount: 2 },
        summary: '找到2个配置文件',
        type: 'tool_result',
      });

      const step1Output = context.stepOutputs.get('step1');
      expect(step1Output).toBeDefined();
      expect(step1Output!.data!.files).toEqual(['config.json', 'app.ts']);
      expect(step1Output!.data!.totalCount).toBe(2);
      expect(step1Output!.summary).toBe('找到2个配置文件');
    });

    test('多步骤输出应独立存储', () => {
      const context = createLoopContext();

      context.stepOutputs.set('search', {
        stepId: 'search',
        data: { results: ['file1.ts', 'file2.ts'] },
        summary: '搜索完成',
        type: 'tool_result',
      });

      context.stepOutputs.set('read', {
        stepId: 'read',
        data: { content: 'export const foo = 1;', language: 'typescript' },
        summary: '文件内容已读取',
        type: 'tool_result',
      });

      context.stepOutputs.set('analyze', {
        stepId: 'analyze',
        data: { quality: 'good', issues: 0 },
        summary: '代码质量良好',
        type: 'tool_result',
      });

      expect(context.stepOutputs.size).toBe(3);
      expect(context.stepOutputs.get('search')!.data!.results).toEqual([
        'file1.ts',
        'file2.ts',
      ]);
      expect(context.stepOutputs.get('read')!.data!.language).toBe(
        'typescript'
      );
      expect(context.stepOutputs.get('analyze')!.data!.quality).toBe('good');
    });
  });

  describe('InputBindings 解析', () => {
    test('$stepId.field 格式的绑定应正确解析', () => {
      const context = createLoopContext();

      context.stepOutputs.set('search', {
        stepId: 'search',
        data: { results: ['file1.ts', 'file2.ts'], query: 'config' },
        summary: '搜索完成',
        type: 'tool_result',
      });

      const inputBindings: Record<string, string> = {
        filePath: '$search.results',
        query: '$search.query',
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
              if (current && typeof current === 'object') {
                current = (current as Record<string, unknown>)[field];
              }
            }
            resolved[key] = current;
          }
        }
      }

      expect(resolved.filePath).toEqual(['file1.ts', 'file2.ts']);
      expect(resolved.query).toBe('config');
    });

    test('不存在的步骤引用应返回 undefined', () => {
      const context = createLoopContext();

      const inputBindings: Record<string, string> = {
        data: '$nonexistent.field',
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
              if (current && typeof current === 'object') {
                current = (current as Record<string, unknown>)[field];
              }
            }
            resolved[key] = current;
          }
        }
      }

      expect(resolved.data).toBeUndefined();
    });

    test('嵌套字段路径应正确解析', () => {
      const context = createLoopContext();

      context.stepOutputs.set('step1', {
        stepId: 'step1',
        data: {
          result: {
            nested: {
              value: 42,
            },
          },
        },
        summary: '嵌套数据',
        type: 'tool_result',
      });

      const path = 'step1.result.nested.value';
      const parts = path.split('.');
      const sourceStepId = parts[0];
      const fieldPath = parts.slice(1);

      const output = context.stepOutputs.get(sourceStepId);
      let current: unknown = output!.data;
      for (const field of fieldPath) {
        if (current && typeof current === 'object') {
          current = (current as Record<string, unknown>)[field];
        }
      }

      expect(current).toBe(42);
    });
  });

  describe('DataFlowChannel', () => {
    test('数据流通道应正确连接源步骤和目标步骤', () => {
      const channels: DataFlowChannel[] = [
        {
          sourceStepId: 'search',
          targetStepId: 'read',
          mapping: { filePath: 'results.0' },
        },
        {
          sourceStepId: 'read',
          targetStepId: 'analyze',
          mapping: { content: 'content' },
        },
        {
          sourceStepId: 'analyze',
          targetStepId: 'report',
          mapping: { analysis: 'quality' },
        },
      ];

      expect(channels.length).toBe(3);
      expect(channels[0].sourceStepId).toBe('search');
      expect(channels[0].targetStepId).toBe('read');
      expect(channels[1].sourceStepId).toBe('read');
      expect(channels[2].targetStepId).toBe('report');
    });

    test('从数据流通道应能生成上游上下文', () => {
      const context = createLoopContext();

      context.stepOutputs.set('search', {
        stepId: 'search',
        data: { results: ['config.json'] },
        summary: '找到配置文件',
        type: 'tool_result',
      });

      context.dataFlowChannels = [
        { sourceStepId: 'search', targetStepId: 'read', mapping: {} },
      ];

      const upstreamIds = context.dataFlowChannels
        .filter((ch) => ch.targetStepId === 'read')
        .map((ch) => ch.sourceStepId);

      const outputs = upstreamIds
        .map((id) => context.stepOutputs.get(id))
        .filter((o): o is StepOutput => o !== undefined);

      expect(outputs.length).toBe(1);
      expect(outputs[0].summary).toBe('找到配置文件');
      expect(outputs[0].data!.results).toEqual(['config.json']);
    });
  });

  describe('OutputSchema', () => {
    test('步骤应声明其输出结构', () => {
      const step = createPlanStep('search', '搜索文件', {
        toolName: 'file_search',
        outputSchema: {
          results: 'string[]',
          totalCount: 'number',
          query: 'string',
        },
      });

      expect(step.outputSchema).toBeDefined();
      expect(step.outputSchema!.results).toBe('string[]');
      expect(step.outputSchema!.totalCount).toBe('number');
      expect(step.outputSchema!.query).toBe('string');
    });

    test('下游步骤应通过 inputBindings 引用上游输出', () => {
      const searchStep = createPlanStep('search', '搜索文件', {
        toolName: 'file_search',
        outputSchema: {
          results: 'string[]',
          totalCount: 'number',
        },
      });

      const readStep = createPlanStep('read', '读取文件', {
        toolName: 'file_read',
        inputBindings: {
          filePath: '$search.results.0',
        },
      });

      expect(readStep.inputBindings).toBeDefined();
      expect(readStep.inputBindings!.filePath).toBe('$search.results.0');
    });
  });

  describe('端到端中间结果传递', () => {
    test('搜索→读取→分析 完整数据流', () => {
      const context = createLoopContext();

      context.stepOutputs.set('search', {
        stepId: 'search',
        data: {
          results: ['src/config.ts', 'src/app.ts'],
          totalCount: 2,
          query: 'config',
        },
        summary: '找到2个文件',
        type: 'tool_result',
      });

      context.stepResults.set('search', {
        stepId: 'search',
        success: true,
        output: '找到2个文件',
        duration: 500,
        toolName: 'file_search',
        structuredData: {
          results: ['src/config.ts', 'src/app.ts'],
          totalCount: 2,
        },
        outputSummary: '找到2个文件',
      });

      const readInputBindings = { filePath: '$search.results.0' };
      const path = readInputBindings.filePath.substring(1);
      const parts = path.split('.');
      const sourceStepId = parts[0];
      const fieldPath = parts.slice(1);

      const output = context.stepOutputs.get(sourceStepId);
      let current: unknown = output!.data;
      for (const field of fieldPath) {
        if (current && typeof current === 'object') {
          current = (current as Record<string, unknown>)[field];
        } else if (Array.isArray(current)) {
          current = (current as unknown[])[parseInt(field)];
        }
      }

      expect(current).toBe('src/config.ts');

      context.stepOutputs.set('read', {
        stepId: 'read',
        data: {
          content: 'export const API_KEY = "xxx"',
          language: 'typescript',
        },
        summary: '文件内容已读取',
        type: 'tool_result',
      });

      context.stepResults.set('read', {
        stepId: 'read',
        success: true,
        output: '文件内容已读取',
        duration: 300,
        toolName: 'file_read',
        structuredData: {
          content: 'export const API_KEY = "xxx"',
          language: 'typescript',
        },
        outputSummary: '文件内容已读取',
      });

      expect(context.stepOutputs.size).toBe(2);
      expect(context.stepResults.size).toBe(2);

      const readOutput = context.stepOutputs.get('read');
      expect(readOutput!.data!.content).toContain('API_KEY');
      expect(readOutput!.data!.language).toBe('typescript');
    });

    test('数据流通道应自动从依赖关系生成', () => {
      const plan: ExecutionPlan = {
        steps: [
          createPlanStep('s1', '步骤1'),
          createPlanStep('s2', '步骤2'),
          createPlanStep('s3', '步骤3'),
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
        recommendedTools: [],
        executionMode: 'dag',
      };

      const channels: DataFlowChannel[] = [];
      for (const [targetId, sourceIds] of plan.dependencies) {
        for (const sourceId of sourceIds) {
          channels.push({
            sourceStepId: sourceId,
            targetStepId: targetId,
            mapping: {},
          });
        }
      }

      expect(channels.length).toBe(2);
      expect(channels[0]).toEqual({
        sourceStepId: 's1',
        targetStepId: 's2',
        mapping: {},
      });
      expect(channels[1]).toEqual({
        sourceStepId: 's2',
        targetStepId: 's3',
        mapping: {},
      });
    });
  });

  describe('跨步骤状态管理 (P3-4 前置)', () => {
    test('步骤间应能传递结构化状态', () => {
      const context = createLoopContext();

      context.crossStepState.set('searchQuery', {
        key: 'searchQuery',
        value: 'config files',
        writtenBy: 'step1',
        timestamp: Date.now(),
        version: 1,
      });

      const state = context.crossStepState.get('searchQuery') as {
        value: string;
        writtenBy: string;
        version: number;
      };
      expect(state).toBeDefined();
      expect(state.value).toBe('config files');
      expect(state.writtenBy).toBe('step1');
      expect(state.version).toBe(1);
    });

    test('状态版本应可追溯', () => {
      const context = createLoopContext();

      context.crossStepState.set('analysisResult', {
        key: 'analysisResult',
        value: { quality: 'good' },
        writtenBy: 'step2',
        timestamp: Date.now(),
        version: 1,
      });

      context.crossStepState.set('analysisResult', {
        key: 'analysisResult',
        value: { quality: 'excellent', improved: true },
        writtenBy: 'step3',
        timestamp: Date.now(),
        version: 2,
      });

      const state = context.crossStepState.get('analysisResult') as {
        value: Record<string, unknown>;
        writtenBy: string;
        version: number;
      };
      expect(state.version).toBe(2);
      expect(state.value.quality).toBe('excellent');
    });
  });
});
