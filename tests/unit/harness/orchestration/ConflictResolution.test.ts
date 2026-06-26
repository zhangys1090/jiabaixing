/**
 * 冲突仲裁集成测试
 *
 * 验证 OrchestratorAgent 在执行流程中正确调用：
 * 1. resolveConflictsWithLLM — 当 aggregate 检测到冲突时
 * 2. mergeWithConsensus — 当多个子任务结果包含置信度时
 * 3. 无冲突时不调用 resolveConflictsWithLLM
 */

import { OrchestratorAgent } from '../../../../src/harness/orchestration/OrchestratorAgent';
import { AgentRegistry } from '../../../../src/harness/orchestration/AgentRegistry';
import type {
  TaskNode,
  TaskExecutor,
} from '../../../../src/harness/orchestration/TaskDispatcher';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock EvolutionOrchestrator — 提供 getInstance 方法
jest.mock('../../../../src/evolution/EvolutionOrchestrator', () => ({
  EvolutionOrchestrator: {
    getInstance: jest.fn().mockReturnValue({
      recordInteraction: jest.fn(),
    }),
  },
}));

// Mock QualityScorer — 返回包含 dimensions 的完整评分
jest.mock('../../../../src/harness/evaluation/QualityScorer', () => ({
  QualityScorer: jest.fn().mockImplementation(() => ({
    score: jest.fn().mockReturnValue({
      overall: 0.85,
      dimensions: {
        accuracy: 0.9,
        efficiency: 0.8,
        safety: 0.85,
        persona: 0.8,
        stability: 0.9,
      },
    }),
  })),
  ScorerMetadata: {},
}));

// Mock StepEvaluator — 提供 evaluateStep 方法
jest.mock('../../../../src/harness/evaluation/StepEvaluator', () => ({
  StepEvaluator: jest.fn().mockImplementation(() => ({
    evaluateStep: jest.fn().mockReturnValue({ score: 0.85 }),
  })),
}));

// Mock TaskComplexityAnalyzer — 可配置返回值
jest.mock('../../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'complex',
      estimatedSteps: 3,
      parallelizable: true,
      reason: 'test',
    }),
    decomposeTask: jest.fn().mockReturnValue({
      subTasks: [],
      complexity: 'simple',
    }),
  })),
}));

/**
 * 创建注册了多个 Agent 的 AgentRegistry
 * @param count - Agent 数量
 * @returns 注册好的 AgentRegistry
 */
function createRegistryWithAgents(count: number): AgentRegistry {
  const registry = new AgentRegistry();
  for (let i = 0; i < count; i++) {
    registry.register({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      capabilities: [
        {
          name: '通用任务执行',
          description: '处理各类通用任务',
          tools: ['*'],
        },
      ],
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
  }
  return registry;
}

describe('冲突仲裁集成', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = createRegistryWithAgents(5);
  });

  describe('resolveConflictsWithLLM 集成', () => {
    it('当 aggregate 检测到冲突时，resolveConflictsWithLLM 被调用并返回仲裁结果', async () => {
      // 创建两个任务，结果写入同一文件 → 触发 file_write 冲突
      const tasks: TaskNode[] = [
        {
          id: 'task-a',
          goal: '写入配置文件',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
        {
          id: 'task-b',
          goal: '更新配置文件',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
      ];

      const mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue(tasks),
      };

      const mockChatLLM = {
        chat: jest.fn().mockResolvedValue(
          JSON.stringify({
            winnerTaskId: 'task-a',
            reasoning: 'task-a 的结果更完整准确',
          })
        ),
      };

      // executor 返回相同 filePath → 触发 file_write 冲突
      const executor: TaskExecutor = async (task: TaskNode) => {
        if (task.id === 'task-a') {
          return { content: '配置A', filePath: '/config/app.json' };
        }
        return { content: '配置B', filePath: '/config/app.json' };
      };

      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor,
        chatLLM: mockChatLLM,
        config: {
          enableMultiAgent: true,
          complexityThreshold: 'simple',
        },
      });

      const aggregator = orchestrator.getAggregator();
      const resolveSpy = jest.spyOn(aggregator, 'resolveConflictsWithLLM');

      const result = await orchestrator.processGoal('生成用户报告', 'test');

      // 验证 resolveConflictsWithLLM 被调用
      expect(resolveSpy).toHaveBeenCalled();
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      // 验证 chatLLM 被调用
      expect(mockChatLLM.chat).toHaveBeenCalled();

      // 验证仲裁结果记录到 summary
      expect(result.summary).toContain('已仲裁');

      // 验证返回了仲裁结果
      const resolutions = await resolveSpy.mock.results[0].value;
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0].winnerTaskId).toBe('task-a');
    });

    it('无冲突时不调用 resolveConflictsWithLLM', async () => {
      // 创建不同目标的任务 → 无冲突
      const tasks: TaskNode[] = [
        {
          id: 'task-x',
          goal: '任务X',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
        {
          id: 'task-y',
          goal: '任务Y',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
      ];

      const mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue(tasks),
      };

      const mockChatLLM = {
        chat: jest.fn(),
      };

      const executor: TaskExecutor = async (task: TaskNode) => {
        return { result: `结果-${task.id}` };
      };

      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor,
        chatLLM: mockChatLLM,
        config: {
          enableMultiAgent: true,
          complexityThreshold: 'simple',
        },
      });

      const aggregator = orchestrator.getAggregator();
      const resolveSpy = jest.spyOn(aggregator, 'resolveConflictsWithLLM');

      await orchestrator.processGoal('执行不同任务', 'test');

      // 验证 resolveConflictsWithLLM 未被调用
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(mockChatLLM.chat).not.toHaveBeenCalled();
    });
  });

  describe('mergeWithConsensus 集成', () => {
    it('当多个任务结果有置信度时，mergeWithConsensus 被调用并选择最高置信度结果', async () => {
      // 不同目标的任务 → 无冲突，但结果包含 confidence
      const tasks: TaskNode[] = [
        {
          id: 'task-high',
          goal: '高置信度任务',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
        {
          id: 'task-low',
          goal: '低置信度任务',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
      ];

      const mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue(tasks),
      };

      // executor 返回带 confidence 的结果
      const executor: TaskExecutor = async (task: TaskNode) => {
        if (task.id === 'task-high') {
          return { data: '高质量结果', confidence: 0.95 };
        }
        return { data: '低质量结果', confidence: 0.6 };
      };

      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor,
        config: {
          enableMultiAgent: true,
          complexityThreshold: 'simple',
        },
      });

      const aggregator = orchestrator.getAggregator();
      const consensusSpy = jest.spyOn(aggregator, 'mergeWithConsensus');

      await orchestrator.processGoal('执行带置信度的任务', 'test');

      // 验证 mergeWithConsensus 被调用
      expect(consensusSpy).toHaveBeenCalled();
      expect(consensusSpy).toHaveBeenCalledTimes(1);

      // 验证传入的结果包含置信度
      const callArgs = consensusSpy.mock.calls[0][0];
      expect(callArgs).toHaveLength(2);

      // 验证选择了最高置信度的结果
      const consensusResult = consensusSpy.mock.results[0].value;
      expect(consensusResult.selectedTaskId).toBe('task-high');
      expect(consensusResult.averageConfidence).toBeCloseTo(0.775, 2);
    });

    it('结果无 confidence 字段时不调用 mergeWithConsensus', async () => {
      const tasks: TaskNode[] = [
        {
          id: 'task-1',
          goal: '任务一',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
        {
          id: 'task-2',
          goal: '任务二',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
      ];

      const mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue(tasks),
      };

      // executor 返回不带 confidence 的结果
      const executor: TaskExecutor = async (task: TaskNode) => {
        return { data: `结果-${task.id}` };
      };

      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor,
        config: {
          enableMultiAgent: true,
          complexityThreshold: 'simple',
        },
      });

      const aggregator = orchestrator.getAggregator();
      const consensusSpy = jest.spyOn(aggregator, 'mergeWithConsensus');

      await orchestrator.processGoal('执行无置信度任务', 'test');

      // 验证 mergeWithConsensus 未被调用
      expect(consensusSpy).not.toHaveBeenCalled();
    });
  });

  describe('LLM 不可用时的降级', () => {
    it('未提供 chatLLM 时跳过冲突仲裁（不影响主流程）', async () => {
      // 相同目标不同结果 → 有冲突，但无 chatLLM
      const tasks: TaskNode[] = [
        {
          id: 'task-a',
          goal: '写入文件',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
        {
          id: 'task-b',
          goal: '更新文件',
          context: '',
          dependencies: [],
          priority: 5,
          tools: ['*'],
          status: 'pending' as const,
        },
      ];

      const mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue(tasks),
      };

      // executor 返回相同 filePath → 触发 file_write 冲突
      const executor: TaskExecutor = async (task: TaskNode) => {
        if (task.id === 'task-a') {
          return { content: 'A', filePath: '/output.txt' };
        }
        return { content: 'B', filePath: '/output.txt' };
      };

      // 不提供 chatLLM
      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor,
        config: {
          enableMultiAgent: true,
          complexityThreshold: 'simple',
        },
      });

      const aggregator = orchestrator.getAggregator();
      const resolveSpy = jest.spyOn(aggregator, 'resolveConflictsWithLLM');

      const result = await orchestrator.processGoal('写入和更新文件', 'test');

      // 验证主流程未受影响
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      // resolveConflictsWithLLM 不应被调用（因为 getChatLLM 返回 null）
      expect(resolveSpy).not.toHaveBeenCalled();
    });
  });
});
