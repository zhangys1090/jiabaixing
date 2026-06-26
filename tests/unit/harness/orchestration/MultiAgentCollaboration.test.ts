/**
 * E5: 多 Agent 协作增强测试
 *
 * 对应设计文档 TOP_LEVEL_DESIGN.md §7.2 已实现的E5能力
 *
 * 验证核心目标：
 *   - 动态角色分配按能力匹配（OrchestratorAgent.assignDynamicRoles）
 *   - Agent 过载触发 rebalance（OrchestratorAgent.rebalanceRoles）
 *   - 广播消息送达所有 idle Agent（AgentRegistry.broadcastMessage）
 *   - Agent 间直接协商达成一致（AgentRegistry.negotiateBetweenAgents）
 *   - 结果冲突时 LLM 仲裁生效（ResultAggregator.resolveConflictsWithLLM）
 *   - 置信度加权合并正确（ResultAggregator.mergeWithConsensus）
 */

import { AgentRegistry } from '../../../../src/harness/orchestration/AgentRegistry';
import {
  OrchestratorAgent,
  type OrchestratorAgentDeps,
} from '../../../../src/harness/orchestration/OrchestratorAgent';
import { ResultAggregator } from '../../../../src/harness/orchestration/ResultAggregator';
import type { TaskNode } from '../../../../src/harness/orchestration/TaskDispatcher';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function createTaskNode(
  id: string,
  goal: string,
  overrides: Partial<TaskNode> = {}
): TaskNode {
  return {
    id,
    goal,
    context: '',
    dependencies: [],
    priority: 5,
    status: 'pending',
    ...overrides,
  };
}

function registerAgent(
  registry: AgentRegistry,
  id: string,
  capabilities: Array<{ name: string; tools: string[]; score?: number }>,
  status: 'idle' | 'busy' | 'error' = 'idle'
): void {
  registry.register({
    id,
    name: id.toUpperCase(),
    capabilities: capabilities.map((c) => ({
      name: c.name,
      description: `${c.name} capability`,
      tools: c.tools,
      score: c.score ?? 80,
    })),
    status,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  });
}

describe('E5: 多 Agent 协作增强', () => {
  describe('动态角色分配', () => {
    it('按能力匹配分配角色（research 任务分配给 researcher）', async () => {
      const registry = new AgentRegistry();
      registerAgent(registry, 'researcher_a', [
        { name: 'research', tools: ['web_search'], score: 90 },
      ]);
      registerAgent(registry, 'executor_b', [
        { name: 'execution', tools: ['file_write'], score: 85 },
      ]);

      const deps: OrchestratorAgentDeps = {
        registry,
        llm: { decomposeGoal: jest.fn().mockResolvedValue([]) },
      };
      const orchestrator = new OrchestratorAgent(deps);

      const tasks: TaskNode[] = [
        createTaskNode('t1', '研究AI技术趋势', { tools: ['web_search'] }),
        createTaskNode('t2', '生成报告文件', { tools: ['file_write'] }),
      ];

      const assignments = await orchestrator.assignDynamicRoles(tasks);

      expect(assignments.length).toBeGreaterThan(0);
      // researcher_a 应被分配 researcher 角色
      const researcherAssign = assignments.find(
        (a: { agentId: string; role: string }) => a.agentId === 'researcher_a'
      );
      expect(researcherAssign).toBeDefined();
      expect(researcherAssign?.role).toBe('researcher');
    });

    it('Agent 过载时触发 rebalance 重新分配', async () => {
      const registry = new AgentRegistry();
      registerAgent(registry, 'agent_a', [
        { name: 'execution', tools: ['file_write'], score: 90 },
      ]);
      registerAgent(registry, 'agent_b', [
        { name: 'execution', tools: ['file_write'], score: 70 },
      ]);

      const deps: OrchestratorAgentDeps = {
        registry,
        llm: { decomposeGoal: jest.fn().mockResolvedValue([]) },
      };
      const orchestrator = new OrchestratorAgent(deps);

      const tasks: TaskNode[] = [
        createTaskNode('t1', '任务1', { tools: ['file_write'] }),
        createTaskNode('t2', '任务2', { tools: ['file_write'] }),
        createTaskNode('t3', '任务3', { tools: ['file_write'] }),
      ];

      // 初始分配
      const initial = await orchestrator.assignDynamicRoles(tasks);
      // 模拟 agent_a 过载（设为 busy）
      registry.updateStatus('agent_a', 'busy');

      // rebalance
      const rebalanced = await orchestrator.rebalanceRoles(tasks, initial);

      // rebalance 后，过载的 agent_a 不应再承担新任务
      const aStillAssigned = rebalanced.filter(
        (a: { agentId: string; role: string }) =>
          a.agentId === 'agent_a' && a.role === 'executor'
      );
      // 过载 Agent 应被移除或降级
      expect(aStillAssigned.length).toBeLessThan(
        initial.filter(
          (a: { agentId: string; role: string }) => a.agentId === 'agent_a'
        ).length
      );
    });
  });

  describe('结构化通信', () => {
    it('广播消息送达所有 idle Agent', () => {
      const registry = new AgentRegistry();
      registerAgent(registry, 'agent_a', [{ name: 'ops', tools: [] }]);
      registerAgent(registry, 'agent_b', [{ name: 'ops', tools: [] }]);
      registerAgent(registry, 'agent_c', [{ name: 'ops', tools: [] }], 'busy');

      const received: string[] = [];
      registry.registerMessageHandler('agent_a', async (_msg: unknown) => {
        received.push('agent_a');
        return null;
      });
      registry.registerMessageHandler('agent_b', async (_msg: unknown) => {
        received.push('agent_b');
        return null;
      });

      const delivered = registry.broadcastMessage('orchestrator', {
        type: 'status_update' as const,
        payload: { announcement: '新任务到达' },
      });

      // 应送达 idle 的 agent_a 和 agent_b，不送达 busy 的 agent_c
      expect(delivered).toContain('agent_a');
      expect(delivered).toContain('agent_b');
      expect(delivered).not.toContain('agent_c');
    });

    it('Agent 间直接协商达成一致', async () => {
      const registry = new AgentRegistry();
      registerAgent(registry, 'agent_a', [{ name: 'ops', tools: ['tool1'] }]);
      registerAgent(registry, 'agent_b', [{ name: 'ops', tools: ['tool2'] }]);

      // agent_a 向 agent_b 请求协助
      registry.registerMessageHandler(
        'agent_b',
        async (msg: {
          type: string;
          payload: { requestedInfo?: unknown; [key: string]: unknown };
          sessionId: string;
        }) => {
          if (msg.type === 'query' && msg.payload.requestedInfo) {
            return {
              id: `resp_${Date.now()}`,
              fromAgentId: 'agent_b',
              toAgentId: 'agent_a',
              type: 'capability_report' as const,
              payload: { available: true, confidence: 0.85 },
              sessionId: msg.sessionId,
              timestamp: Date.now(),
            };
          }
          return null;
        }
      );

      const result = await registry.negotiateBetweenAgents(
        'agent_a',
        'agent_b',
        '协助完成 tool2 操作'
      );

      expect(result.agreed).toBe(true);
      expect(result.terms).toHaveProperty('confidence');
    });
  });

  describe('冲突仲裁与置信度合并', () => {
    it('结果冲突时 LLM 仲裁生效', async () => {
      const llm = {
        chat: jest.fn().mockResolvedValue(
          JSON.stringify({
            winnerTaskId: 'task_b',
            reasoning: 'task_b 结果更准确，基于最新数据',
          })
        ),
      };
      const aggregator = new ResultAggregator(llm);

      const tasks: TaskNode[] = [
        createTaskNode('task_a', '生成摘要', { status: 'completed' }),
        createTaskNode('task_b', '生成摘要', { status: 'completed' }),
      ];

      const results = new Map<string, unknown>([
        ['task_a', { data: { summary: '版本A' } }],
        ['task_b', { data: { summary: '版本B' } }],
      ]);

      const aggregated = aggregator.aggregate(results, tasks);
      expect(aggregated.conflicts!.length).toBeGreaterThan(0);

      const resolved = await aggregator.resolveConflictsWithLLM(
        aggregated.conflicts!,
        llm
      );

      expect(resolved.length).toBeGreaterThan(0);
      expect(resolved[0].winnerTaskId).toBe('task_b');
      expect(resolved[0].resolution).toContain('task_b');
    });

    it('置信度加权合并选择最高置信度结果', () => {
      const aggregator = new ResultAggregator();

      const results = [
        {
          taskId: 't1',
          result: { answer: 'A' },
          confidence: 0.6,
          agentId: 'a1',
        },
        {
          taskId: 't2',
          result: { answer: 'B' },
          confidence: 0.9,
          agentId: 'a2',
        },
        {
          taskId: 't3',
          result: { answer: 'C' },
          confidence: 0.3,
          agentId: 'a3',
        },
      ];

      const merged = aggregator.mergeWithConsensus(results);

      // 应选择置信度最高的 t2 结果
      expect(merged.selectedTaskId).toBe('t2');
      expect(merged.result).toEqual({ answer: 'B' });
      expect(merged.averageConfidence).toBeCloseTo(0.6, 1);
    });
  });
});
