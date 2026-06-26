import { Planner } from '../../../../src/harness/loop/Planner';
import {
  TaskDispatcher,
  type TaskNode,
} from '../../../../src/harness/orchestration/TaskDispatcher';
import type { ExecutionPlan, PlanStep } from '../../../../src/harness/types';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock TaskComplexityAnalyzer
jest.mock('../../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'complex',
      estimatedSteps: 3,
      parallelizable: true,
      reason: 'test',
    }),
  })),
}));

/**
 * 创建 Mock LLM，返回指定的计划 JSON
 */
function createMockLLM(responseJson: string) {
  return {
    chat: jest.fn().mockResolvedValue(responseJson),
  };
}

/**
 * 创建 Mock 记忆注入器
 */
function createMockMemoryInjector(memories: string[] = []) {
  return {
    autoRetrieveMemories: jest.fn().mockResolvedValue(memories),
  };
}

describe('Planner 依赖传递', () => {
  describe('toUnifiedTaskNode 依赖传递', () => {
    it('LLM 生成的 dependencies 应该正确传递到 UnifiedTaskNode', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [
            { id: 'step1', description: '搜索文件', toolName: 'file_search' },
            { id: 'step2', description: '分析内容', toolName: 'code_analyze' },
            {
              id: 'step3',
              description: '生成报告',
              toolName: 'incremental_edit',
            },
          ],
          dependencies: {
            step2: ['step1'],
            step3: ['step2'],
          },
          estimatedRounds: 3,
          needsConfirmation: false,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan(
        { text: '分析项目代码并生成报告', userId: 'test' },
        { phase: 'planning' } as never
      );

      // 验证 ExecutionPlan 的 dependencies Map 正确
      expect(plan.dependencies.get('step2')).toEqual(['step1']);
      expect(plan.dependencies.get('step3')).toEqual(['step2']);

      // 验证每个 step 的 toUnifiedTaskNode 传递了正确的 dependencies
      const step1Node = plan.steps[0].toUnifiedTaskNode();
      const step2Node = plan.steps[1].toUnifiedTaskNode();
      const step3Node = plan.steps[2].toUnifiedTaskNode();

      // step1 无依赖
      expect(step1Node.dependencies).toEqual([]);
      // step2 依赖 step1
      expect(step2Node.dependencies).toEqual(['step1']);
      // step3 依赖 step2
      expect(step3Node.dependencies).toEqual(['step2']);
    });

    it('无依赖的步骤 dependencies 应该为空数组', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [
            { id: 'step1', description: '独立任务A' },
            { id: 'step2', description: '独立任务B' },
          ],
          dependencies: {},
          estimatedRounds: 2,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan(
        { text: '同时执行两个独立任务', userId: 'test' },
        { phase: 'planning' } as never
      );

      const step1Node = plan.steps[0].toUnifiedTaskNode();
      const step2Node = plan.steps[1].toUnifiedTaskNode();

      expect(step1Node.dependencies).toEqual([]);
      expect(step2Node.dependencies).toEqual([]);
    });
  });

  describe('toTaskNodes 转换方法', () => {
    it('应该能将 ExecutionPlan 转换为 TaskNode[]', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [
            { id: 'step1', description: '搜索文件', toolName: 'file_search' },
            { id: 'step2', description: '分析内容', toolName: 'code_analyze' },
            { id: 'step3', description: '生成报告' },
          ],
          dependencies: {
            step2: ['step1'],
            step3: ['step2'],
          },
          estimatedRounds: 3,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan(
        { text: '分析项目代码并生成报告', userId: 'test' },
        { phase: 'planning' } as never
      );

      // 调用 toTaskNodes 转换
      const taskNodes: TaskNode[] = (
        planner as unknown as {
          toTaskNodes: (plan: ExecutionPlan) => TaskNode[];
        }
      ).toTaskNodes(plan);

      expect(taskNodes).toHaveLength(3);

      // 验证 step1
      expect(taskNodes[0].id).toBe('step1');
      expect(taskNodes[0].dependencies).toEqual([]);
      expect(taskNodes[0].goal).toBe('搜索文件');
      expect(taskNodes[0].tools).toContain('file_search');

      // 验证 step2 依赖 step1
      expect(taskNodes[1].id).toBe('step2');
      expect(taskNodes[1].dependencies).toEqual(['step1']);

      // 验证 step3 依赖 step2
      expect(taskNodes[2].id).toBe('step3');
      expect(taskNodes[2].dependencies).toEqual(['step2']);
    });

    it('转换后的 TaskNode 应该有正确的 priority 和 status', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [{ id: 's1', description: '任务1' }],
          dependencies: {},
          estimatedRounds: 1,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan({ text: '单个任务', userId: 'test' }, {
        phase: 'planning',
      } as never);

      const taskNodes: TaskNode[] = (
        planner as unknown as {
          toTaskNodes: (plan: ExecutionPlan) => TaskNode[];
        }
      ).toTaskNodes(plan);

      expect(taskNodes[0].priority).toBeGreaterThanOrEqual(1);
      expect(taskNodes[0].priority).toBeLessThanOrEqual(10);
      expect(taskNodes[0].status).toBe('pending');
    });
  });
});
