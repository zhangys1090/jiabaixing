/**
 * P1 #5: A2A 协议测试
 *
 * 验证 A2AProtocolManager 的 Agent Card 发布/发现、Task 生命周期管理
 */
import type { A2AAgentCard } from '../../../../src/harness/orchestration/AgentRegistry';
import {
  A2AProtocolManager,
  AgentRegistry,
} from '../../../../src/harness/orchestration/AgentRegistry';

describe('A2AProtocolManager', () => {
  let registry: AgentRegistry;
  let manager: A2AProtocolManager;

  beforeEach(() => {
    registry = new AgentRegistry();
    manager = new A2AProtocolManager(registry);
  });

  describe('Agent Card 发布与发现', () => {
    const card1: A2AAgentCard = {
      id: 'agent_coder',
      name: 'Coder Agent',
      description: '代码编写与审查',
      url: 'http://localhost:3001',
      transport: 'json-rpc',
      capabilities: [
        { type: 'task-execution', name: 'coding', description: '代码编写' },
      ],
      version: '1.0.0',
    };

    const card2: A2AAgentCard = {
      id: 'agent_analyst',
      name: 'Analyst Agent',
      description: '数据分析',
      url: 'http://localhost:3002',
      transport: 'http',
      capabilities: [
        { type: 'data-processing', name: 'analysis', description: '数据分析' },
      ],
      version: '1.0.0',
    };

    it('应发布 Agent Card', () => {
      manager.publishAgentCard(card1);
      const retrieved = manager.getAgentCard('agent_coder');
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Coder Agent');
    });

    it('应发现所有 Agent', () => {
      manager.publishAgentCard(card1);
      manager.publishAgentCard(card2);

      const all = manager.discoverAgents();
      expect(all).toHaveLength(2);
    });

    it('应按能力类型发现 Agent', () => {
      manager.publishAgentCard(card1);
      manager.publishAgentCard(card2);

      const coders = manager.discoverAgents('task-execution');
      expect(coders).toHaveLength(1);
      expect(coders[0].id).toBe('agent_coder');
    });

    it('无匹配能力时应返回空数组', () => {
      manager.publishAgentCard(card1);
      const result = manager.discoverAgents('monitoring');
      expect(result).toHaveLength(0);
    });
  });

  describe('Task 生命周期', () => {
    let card1: A2AAgentCard;
    let card2: A2AAgentCard;

    beforeEach(() => {
      card1 = {
        id: 'agent_a',
        name: 'Agent A',
        description: '发送方',
        url: 'http://localhost:3001',
        transport: 'json-rpc',
        capabilities: [
          { type: 'task-execution', name: 'send', description: '发送' },
        ],
        version: '1.0.0',
      };
      card2 = {
        id: 'agent_b',
        name: 'Agent B',
        description: '接收方',
        url: 'http://localhost:3002',
        transport: 'http',
        capabilities: [
          { type: 'data-processing', name: 'receive', description: '接收' },
        ],
        version: '1.0.0',
      };
      manager.publishAgentCard(card1);
      manager.publishAgentCard(card2);
    });

    it('应创建 Task 并设置初始状态为 submitted', () => {
      const task = manager.createTask({
        fromAgentId: 'agent_a',
        toAgentId: 'agent_b',
        description: '分析代码质量',
        input: { repo: 'test-repo' },
      });

      expect(task.id).toMatch(/^a2a_task_/);
      expect(task.status).toBe('submitted');
      expect(task.fromAgentId).toBe('agent_a');
      expect(task.toAgentId).toBe('agent_b');
    });

    it('应更新 Task 状态', () => {
      const task = manager.createTask({
        fromAgentId: 'agent_a',
        toAgentId: 'agent_b',
        description: '测试任务',
        input: {},
      });

      const updated = manager.updateTaskStatus(task.id, 'working');
      expect(updated?.status).toBe('working');
    });

    it('应完成 Task 并设置输出', () => {
      const task = manager.createTask({
        fromAgentId: 'agent_a',
        toAgentId: 'agent_b',
        description: '测试任务',
        input: {},
      });

      const completed = manager.completeTask(task.id, { result: 'success' });
      expect(completed?.status).toBe('completed');
      expect(completed?.output).toEqual({ result: 'success' });
    });

    it('应记录状态历史', () => {
      const task = manager.createTask({
        fromAgentId: 'agent_a',
        toAgentId: 'agent_b',
        description: '测试任务',
        input: {},
      });

      manager.updateTaskStatus(task.id, 'working');
      manager.updateTaskStatus(task.id, 'completed');

      const retrieved = manager.getTask(task.id);
      expect(retrieved?.statusHistory).toHaveLength(3);
      expect(retrieved?.statusHistory[0].status).toBe('submitted');
      expect(retrieved?.statusHistory[1].status).toBe('working');
      expect(retrieved?.statusHistory[2].status).toBe('completed');
    });

    it('应取消 Task', () => {
      const task = manager.createTask({
        fromAgentId: 'agent_a',
        toAgentId: 'agent_b',
        description: '测试任务',
        input: {},
      });

      const cancelled = manager.cancelTask(task.id, '不再需要');
      expect(cancelled?.status).toBe('cancelled');
    });

    it('应获取 Agent 的所有 Task', () => {
      manager.createTask({
        fromAgentId: 'agent_a',
        toAgentId: 'agent_b',
        description: '任务1',
        input: {},
      });
      manager.createTask({
        fromAgentId: 'agent_a',
        toAgentId: 'agent_b',
        description: '任务2',
        input: {},
      });

      const tasks = manager.getAgentTasks('agent_a', 'from');
      expect(tasks).toHaveLength(2);
    });

    it('不存在的 Task 应返回 null/undefined', () => {
      expect(manager.getTask('nonexistent')).toBeUndefined();
      expect(manager.updateTaskStatus('nonexistent', 'working')).toBeNull();
    });
  });

  describe('Task 事件订阅', () => {
    it('应触发状态变更事件', () => {
      const card: A2AAgentCard = {
        id: 'agent_x',
        name: 'Agent X',
        description: '测试',
        url: 'http://localhost:3003',
        transport: 'http',
        capabilities: [
          { type: 'monitoring', name: 'test', description: '测试' },
        ],
        version: '1.0.0',
      };
      manager.publishAgentCard(card);

      const events: Array<{ type: string; status?: string }> = [];
      const task = manager.createTask({
        fromAgentId: 'agent_x',
        toAgentId: 'agent_x',
        description: '事件测试',
        input: {},
      });

      manager.onTaskEvent(task.id, (event) => {
        events.push({ type: event.type, status: event.status });
      });

      manager.updateTaskStatus(task.id, 'working');
      manager.updateTaskStatus(task.id, 'completed');

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.status === 'working')).toBe(true);
    });
  });

  describe('统计', () => {
    it('应返回正确的统计数据', () => {
      const card: A2AAgentCard = {
        id: 'agent_s',
        name: 'Agent S',
        description: '统计测试',
        url: 'http://localhost:3004',
        transport: 'http',
        capabilities: [
          { type: 'monitoring', name: 'stats', description: '统计' },
        ],
        version: '1.0.0',
      };
      manager.publishAgentCard(card);

      manager.createTask({
        fromAgentId: 'agent_s',
        toAgentId: 'agent_s',
        description: '任务1',
        input: {},
      });

      const stats = manager.getTaskStats();
      expect(stats.total).toBeGreaterThanOrEqual(1);
      expect(stats.byStatus).toBeDefined();
    });
  });
});
