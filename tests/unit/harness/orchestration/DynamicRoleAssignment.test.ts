import { OrchestratorAgent } from '../../../../src/harness/orchestration/OrchestratorAgent';
import { AgentRegistry } from '../../../../src/harness/orchestration/AgentRegistry';
import type { TaskNode } from '../../../../src/harness/orchestration/TaskDispatcher';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock EvolutionOrchestrator
jest.mock('../../../../src/evolution/EvolutionOrchestrator', () => ({
  EvolutionOrchestrator: jest.fn().mockImplementation(() => ({
    recordExecution: jest.fn(),
  })),
}));

// Mock QualityScorer
jest.mock('../../../../src/harness/evaluation/QualityScorer', () => ({
  QualityScorer: jest.fn().mockImplementation(() => ({
    score: jest.fn().mockReturnValue({ overall: 0.8 }),
  })),
  ScorerMetadata: {},
}));

// Mock StepEvaluator
jest.mock('../../../../src/harness/evaluation/StepEvaluator', () => ({
  StepEvaluator: jest.fn().mockImplementation(() => ({
    evaluate: jest.fn(),
  })),
}));

// Mock TaskComplexityAnalyzer
jest.mock('../../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'simple',
      estimatedSteps: 1,
      parallelizable: false,
      reason: 'test',
    }),
    decomposeTask: jest.fn().mockReturnValue({
      subTasks: [],
      complexity: 'simple',
    }),
  })),
}));

/**
 * 创建带指定能力 Agent 的 AgentRegistry
 * @param agents - Agent 配置列表
 * @returns 注册好的 AgentRegistry 实例
 */
function createRegistryWithAgents(
  agents: Array<{
    id: string;
    name: string;
    capabilities: Array<{
      name: string;
      description: string;
      tools: string[];
      score?: number;
    }>;
    status: 'idle' | 'busy' | 'error';
  }>
): AgentRegistry {
  const registry = new AgentRegistry();
  for (const agent of agents) {
    registry.register({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities,
      status: agent.status,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
  }
  return registry;
}

/**
 * 创建基础 TaskNode
 * @param overrides - 覆盖字段
 * @returns TaskNode 实例
 */
function createTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'task-default',
    goal: '默认任务',
    context: '',
    dependencies: [],
    priority: 5,
    status: 'pending',
    ...overrides,
  };
}

describe('动态角色分配 (DynamicRoleAssignment)', () => {
  let registry: AgentRegistry;
  let orchestrator: OrchestratorAgent;
  let mockLLM: { decomposeGoal: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('assignDynamicRoles', () => {
    it('测试1: 多任务场景时应被调用并返回角色分配结果', async () => {
      registry = createRegistryWithAgents([
        {
          id: 'agent-coder',
          name: 'Coder Agent',
          capabilities: [
            {
              name: 'coding',
              description: '代码编写',
              tools: ['code_generate', 'code_analyze'],
              score: 90,
            },
          ],
          status: 'idle',
        },
        {
          id: 'agent-researcher',
          name: 'Researcher Agent',
          capabilities: [
            {
              name: 'web_search',
              description: '网络搜索',
              tools: ['web_search', 'web_fetch'],
              score: 85,
            },
          ],
          status: 'idle',
        },
      ]);

      mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue([]),
      };

      orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
      });

      const tasks: TaskNode[] = [
        createTask({
          id: 'task-code',
          goal: '编写代码',
          tools: ['code_generate'],
        }),
        createTask({
          id: 'task-search',
          goal: '搜索资料',
          tools: ['web_search'],
        }),
      ];

      const assignments = await orchestrator.assignDynamicRoles(tasks);

      expect(assignments).toHaveLength(2);
      expect(assignments[0].agentId).toBe('agent-coder');
      expect(assignments[0].taskId).toBe('task-code');
      expect(assignments[0].role).toBe('developer');
      expect(assignments[0].capability).toBe('coding');

      expect(assignments[1].agentId).toBe('agent-researcher');
      expect(assignments[1].taskId).toBe('task-search');
      expect(assignments[1].role).toBe('researcher');
      expect(assignments[1].capability).toBe('web_search');
    });

    it('测试2: 任务有 tools 字段时应根据工具匹配 Agent', async () => {
      registry = createRegistryWithAgents([
        {
          id: 'agent-file',
          name: 'File Agent',
          capabilities: [
            {
              name: 'file_operation',
              description: '文件操作',
              tools: ['file_read', 'file_write'],
              score: 80,
            },
          ],
          status: 'idle',
        },
      ]);

      mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue([]),
      };

      orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
      });

      const tasks: TaskNode[] = [
        createTask({
          id: 'task-file',
          goal: '读取文件',
          tools: ['file_read'],
        }),
      ];

      const assignments = await orchestrator.assignDynamicRoles(tasks);

      expect(assignments).toHaveLength(1);
      expect(assignments[0].agentId).toBe('agent-file');
      expect(assignments[0].taskId).toBe('task-file');
      expect(assignments[0].role).toBe('file_manager');
      expect(assignments[0].capability).toBe('file_operation');
    });

    it('测试3: Agent 过载时 rebalanceRoles 应将任务转移给空闲 Agent', async () => {
      // 第一个 Agent busy（过载），第二个 idle（可接收）
      registry = createRegistryWithAgents([
        {
          id: 'agent-busy',
          name: 'Busy Agent',
          capabilities: [
            {
              name: 'coding',
              description: '代码编写',
              tools: ['code_generate'],
              score: 90,
            },
          ],
          status: 'busy',
        },
        {
          id: 'agent-idle',
          name: 'Idle Agent',
          capabilities: [
            {
              name: 'coding',
              description: '代码编写',
              tools: ['code_generate'],
              score: 85,
            },
          ],
          status: 'idle',
        },
      ]);

      mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue([]),
      };

      orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
      });

      const tasks: TaskNode[] = [
        createTask({
          id: 'task-rebalance',
          goal: '编写代码',
          tools: ['code_generate'],
        }),
      ];

      // 先生成初始分配 — 由于 agent-busy 状态为 busy，findBestAgent 会跳过它
      // 所以初始分配会落到 agent-idle 上
      const initialAssignments = await orchestrator.assignDynamicRoles(tasks);
      expect(initialAssignments).toHaveLength(1);
      expect(initialAssignments[0].agentId).toBe('agent-idle');

      // 模拟初始分配指向 busy agent 的情况（手动构造 previousAssignments）
      const previousAssignments = [
        {
          agentId: 'agent-busy',
          role: 'developer',
          taskId: 'task-rebalance',
          capability: 'coding',
        },
      ];

      const rebalanced = await orchestrator.rebalanceRoles(
        tasks,
        previousAssignments
      );

      expect(rebalanced).toHaveLength(1);
      expect(rebalanced[0].agentId).toBe('agent-idle');
      expect(rebalanced[0].agentId).not.toBe('agent-busy');
    });

    it('测试4: 无 tools 的任务应跳过角色分配', async () => {
      registry = createRegistryWithAgents([
        {
          id: 'agent-1',
          name: 'Agent 1',
          capabilities: [
            {
              name: 'coding',
              description: '代码编写',
              tools: ['code_generate'],
              score: 90,
            },
          ],
          status: 'idle',
        },
      ]);

      mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue([]),
      };

      orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
      });

      const tasks: TaskNode[] = [
        createTask({
          id: 'task-no-tools',
          goal: '无工具任务',
          // 不设置 tools 字段
        }),
        createTask({
          id: 'task-empty-tools',
          goal: '空工具任务',
          tools: [],
        }),
      ];

      const assignments = await orchestrator.assignDynamicRoles(tasks);

      expect(assignments).toHaveLength(0);
    });

    it('测试5: 无匹配 Agent 时应返回空分配列表', async () => {
      registry = createRegistryWithAgents([
        {
          id: 'agent-1',
          name: 'Agent 1',
          capabilities: [
            {
              name: 'coding',
              description: '代码编写',
              tools: ['code_generate'],
              score: 90,
            },
          ],
          status: 'idle',
        },
      ]);

      mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue([]),
      };

      orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
      });

      const tasks: TaskNode[] = [
        createTask({
          id: 'task-unmatched',
          goal: '需要不存在的工具',
          tools: ['non_existent_tool'],
        }),
      ];

      const assignments = await orchestrator.assignDynamicRoles(tasks);

      expect(assignments).toHaveLength(0);
    });
  });

  describe('rebalanceRoles 边界场景', () => {
    it('空闲 Agent 不应被重平衡', async () => {
      registry = createRegistryWithAgents([
        {
          id: 'agent-idle',
          name: 'Idle Agent',
          capabilities: [
            {
              name: 'coding',
              description: '代码编写',
              tools: ['code_generate'],
              score: 90,
            },
          ],
          status: 'idle',
        },
      ]);

      mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue([]),
      };

      orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
      });

      const tasks: TaskNode[] = [
        createTask({
          id: 'task-1',
          goal: '任务',
          tools: ['code_generate'],
        }),
      ];

      const previousAssignments = [
        {
          agentId: 'agent-idle',
          role: 'developer',
          taskId: 'task-1',
          capability: 'coding',
        },
      ];

      const rebalanced = await orchestrator.rebalanceRoles(
        tasks,
        previousAssignments
      );

      expect(rebalanced).toHaveLength(1);
      expect(rebalanced[0].agentId).toBe('agent-idle');
    });

    it('无备选 Agent 时应保留原分配', async () => {
      // 只有 busy agent，没有 idle 备选
      registry = createRegistryWithAgents([
        {
          id: 'agent-only',
          name: 'Only Agent',
          capabilities: [
            {
              name: 'coding',
              description: '代码编写',
              tools: ['code_generate'],
              score: 90,
            },
          ],
          status: 'busy',
        },
      ]);

      mockLLM = {
        decomposeGoal: jest.fn().mockResolvedValue([]),
      };

      orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
      });

      const tasks: TaskNode[] = [
        createTask({
          id: 'task-1',
          goal: '任务',
          tools: ['code_generate'],
        }),
      ];

      const previousAssignments = [
        {
          agentId: 'agent-only',
          role: 'developer',
          taskId: 'task-1',
          capability: 'coding',
        },
      ];

      const rebalanced = await orchestrator.rebalanceRoles(
        tasks,
        previousAssignments
      );

      expect(rebalanced).toHaveLength(1);
      expect(rebalanced[0].agentId).toBe('agent-only');
    });
  });
});
