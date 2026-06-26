/**
 * E5: 社会协作 — 基础能力测试
 *
 * 对应设计文档 TOP_LEVEL_DESIGN.md §7.2 已实现的E5能力
 *
 * 验证核心目标：
 *   E5-1: Agent协商协议（startNegotiation/sendNegotiationMessage）
 *   E5-2: 任务竞标机制（publishBidding/evaluateBids，balanced/fastest/most_confident）
 *   E5-3: 共享知识库（publishKnowledge/queryKnowledge/referenceKnowledge/subscribeToKnowledge）
 */

import {
  AgentRegistry,
  Bid,
  NegotiationMessage,
  SharedKnowledgeEntry,
} from '../../../../src/harness/orchestration/AgentRegistry';

describe('E5: 社会协作', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  // ============ E5-1: Agent协商协议 ============
  describe('E5-1: Agent协商协议', () => {
    beforeEach(() => {
      registry.register({
        id: 'agent_a',
        name: 'Agent A',
        capabilities: [
          {
            name: 'file_ops',
            description: '文件操作',
            tools: ['file_read', 'file_write'],
            score: 80,
          },
        ],
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });
      registry.register({
        id: 'agent_b',
        name: 'Agent B',
        capabilities: [
          {
            name: 'code_ops',
            description: '代码操作',
            tools: ['code_analyze', 'code_generate'],
            score: 90,
          },
        ],
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });
    });

    describe('startNegotiation', () => {
      it('应创建协商会话并广播初始提议', () => {
        const session = registry.startNegotiation(
          'orchestrator',
          ['agent_a', 'agent_b'],
          '任务分配: 代码审查',
          { taskId: 'task_1', taskGoal: '审查代码质量' }
        );

        expect(session.id).toMatch(/^neg_/);
        expect(session.initiatorId).toBe('orchestrator');
        expect(session.participants).toEqual(['agent_a', 'agent_b']);
        expect(session.status).toBe('active');
        expect(session.messages.length).toBe(1);
        expect(session.messages[0].type).toBe('task_proposal');
      });
    });

    describe('sendNegotiationMessage', () => {
      it('应处理接受消息并完成协商', () => {
        const session = registry.startNegotiation(
          'orchestrator',
          ['agent_a'],
          '任务分配',
          { taskId: 'task_1' }
        );

        const acceptance: NegotiationMessage = {
          id: 'msg_accept',
          fromAgentId: 'agent_a',
          toAgentId: 'orchestrator',
          type: 'acceptance',
          payload: { confidence: 0.9, estimatedTime: 5000 },
          sessionId: session.id,
          timestamp: Date.now(),
        };

        registry.sendNegotiationMessage(acceptance);

        const updated = registry.getNegotiationSession(session.id);
        expect(updated?.status).toBe('completed');
        expect(updated?.result?.agreedAgentId).toBe('agent_a');
      });

      it('所有参与者拒绝应标记协商失败', () => {
        const session = registry.startNegotiation(
          'orchestrator',
          ['agent_a'],
          '任务分配',
          { taskId: 'task_1' }
        );

        const rejection: NegotiationMessage = {
          id: 'msg_reject',
          fromAgentId: 'agent_a',
          toAgentId: 'orchestrator',
          type: 'rejection',
          payload: { reason: '当前忙碌' },
          sessionId: session.id,
          timestamp: Date.now(),
        };

        registry.sendNegotiationMessage(rejection);

        const updated = registry.getNegotiationSession(session.id);
        expect(updated?.status).toBe('failed');
      });

      it('不存在的会话应返回null', () => {
        const message: NegotiationMessage = {
          id: 'msg_1',
          fromAgentId: 'agent_a',
          toAgentId: 'orchestrator',
          type: 'acceptance',
          payload: {},
          sessionId: 'nonexistent',
          timestamp: Date.now(),
        };

        const result = registry.sendNegotiationMessage(message);
        expect(result).toBeNull();
      });
    });

    describe('getActiveNegotiations', () => {
      it('应返回指定Agent的活跃协商', () => {
        registry.startNegotiation('orchestrator', ['agent_a'], '任务1', {});
        registry.startNegotiation('orchestrator', ['agent_b'], '任务2', {});

        const activeA = registry.getActiveNegotiations('agent_a');
        expect(activeA.length).toBe(1);
        expect(activeA[0].participants).toContain('agent_a');
      });
    });

    describe('registerMessageHandler', () => {
      it('应注册消息处理器', () => {
        const handler = async (msg: NegotiationMessage) => null;
        registry.registerMessageHandler('agent_a', handler);

        const retrieved = registry.getMessageHandler('agent_a');
        expect(retrieved).toBeDefined();
      });
    });
  });

  // ============ E5-2: 任务竞标机制 ============
  describe('E5-2: 任务竞标机制', () => {
    beforeEach(() => {
      registry.register({
        id: 'agent_fast',
        name: 'Fast Agent',
        capabilities: [
          {
            name: 'file_ops',
            description: '文件操作',
            tools: ['file_read', 'file_write'],
            score: 70,
          },
        ],
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });
      registry.register({
        id: 'agent_quality',
        name: 'Quality Agent',
        capabilities: [
          {
            name: 'file_ops',
            description: '文件操作',
            tools: ['file_read', 'file_write'],
            score: 95,
          },
        ],
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });
    });

    describe('publishBidding', () => {
      it('应发布竞标并征集标书', () => {
        // 注册竞标处理器
        registry.registerBidHandler('agent_fast', (task: { id: string }) => ({
          id: `bid_fast_${task.id}`,
          agentId: 'agent_fast',
          taskId: task.id,
          estimatedTime: 3000,
          confidence: 0.8,
          justification: '快速处理',
          resourceRequirements: [],
          timestamp: Date.now(),
        }));

        registry.registerBidHandler(
          'agent_quality',
          (task: { id: string }) => ({
            id: `bid_quality_${task.id}`,
            agentId: 'agent_quality',
            taskId: task.id,
            estimatedTime: 8000,
            confidence: 0.95,
            justification: '高质量处理',
            resourceRequirements: ['code_analyze'],
            timestamp: Date.now(),
          })
        );

        const session = registry.publishBidding('task_1', '审查代码质量', [
          'file_read',
        ]);

        expect(session.id).toMatch(/^bid_/);
        expect(session.status).toBe('open');
        expect(session.bids.length).toBe(2);
      });
    });

    describe('evaluateBids', () => {
      it('balanced策略应选择综合最优的标书', () => {
        registry.registerBidHandler('agent_fast', (task: { id: string }) => ({
          id: `bid_fast_${task.id}`,
          agentId: 'agent_fast',
          taskId: task.id,
          estimatedTime: 2000,
          confidence: 0.7,
          justification: '快速',
          resourceRequirements: [],
          timestamp: Date.now(),
        }));

        registry.registerBidHandler(
          'agent_quality',
          (task: { id: string }) => ({
            id: `bid_quality_${task.id}`,
            agentId: 'agent_quality',
            taskId: task.id,
            estimatedTime: 5000,
            confidence: 0.95,
            justification: '高质量',
            resourceRequirements: [],
            timestamp: Date.now(),
          })
        );

        const session = registry.publishBidding('task_1', '审查代码', [
          'file_read',
        ]);
        const result = registry.evaluateBids(session.id, 'balanced');

        expect(result).not.toBeNull();
        expect(result!.winnerId).toBeDefined();
        expect(session.status).toBe('awarded');
      });

      it('fastest策略应选择最快的标书', () => {
        registry.registerBidHandler('agent_fast', (task: { id: string }) => ({
          id: `bid_fast_${task.id}`,
          agentId: 'agent_fast',
          taskId: task.id,
          estimatedTime: 1000,
          confidence: 0.5,
          justification: '极速',
          resourceRequirements: [],
          timestamp: Date.now(),
        }));

        registry.registerBidHandler(
          'agent_quality',
          (task: { id: string }) => ({
            id: `bid_quality_${task.id}`,
            agentId: 'agent_quality',
            taskId: task.id,
            estimatedTime: 10000,
            confidence: 0.99,
            justification: '高质量',
            resourceRequirements: [],
            timestamp: Date.now(),
          })
        );

        const session = registry.publishBidding('task_1', '快速处理', [
          'file_read',
        ]);
        const result = registry.evaluateBids(session.id, 'fastest');

        expect(result).not.toBeNull();
        expect(result!.winnerId).toBe('agent_fast');
      });

      it('most_confident策略应选择最高自信度', () => {
        registry.registerBidHandler('agent_fast', (task: { id: string }) => ({
          id: `bid_fast_${task.id}`,
          agentId: 'agent_fast',
          taskId: task.id,
          estimatedTime: 1000,
          confidence: 0.5,
          justification: '快速',
          resourceRequirements: [],
          timestamp: Date.now(),
        }));

        registry.registerBidHandler(
          'agent_quality',
          (task: { id: string }) => ({
            id: `bid_quality_${task.id}`,
            agentId: 'agent_quality',
            taskId: task.id,
            estimatedTime: 10000,
            confidence: 0.99,
            justification: '高质量',
            resourceRequirements: [],
            timestamp: Date.now(),
          })
        );

        const session = registry.publishBidding('task_1', '高质量处理', [
          'file_read',
        ]);
        const result = registry.evaluateBids(session.id, 'most_confident');

        expect(result).not.toBeNull();
        expect(result!.winnerId).toBe('agent_quality');
      });

      it('无标书时应返回null', () => {
        const session = registry.publishBidding('task_1', '无人能做', [
          'nonexistent_tool',
        ]);
        const result = registry.evaluateBids(session.id);
        expect(result).toBeNull();
      });
    });

    describe('submitBid', () => {
      it('应接受有效标书', () => {
        const session = registry.publishBidding('task_1', '测试任务', [
          'file_read',
        ]);

        const bid: Bid = {
          id: 'bid_manual',
          agentId: 'agent_fast',
          taskId: session.taskId,
          estimatedTime: 5000,
          confidence: 0.8,
          justification: '手动提交',
          resourceRequirements: [],
          timestamp: Date.now(),
        };

        const accepted = registry.submitBid(bid);
        expect(accepted).toBe(true);
      });
    });
  });

  // ============ E5-3: 共享知识库 ============
  describe('E5-3: 共享知识库', () => {
    describe('publishKnowledge', () => {
      it('应发布知识条目', () => {
        const entry = registry.publishKnowledge({
          publisherId: 'agent_a',
          type: 'best_practice',
          title: '代码审查最佳实践',
          content: '先检查安全漏洞，再检查代码风格',
          tags: ['code_review', 'security'],
          applicableScenes: ['coding'],
          qualityScore: 0.9,
        });

        expect(entry.id).toMatch(/^know_/);
        expect(entry.referenceCount).toBe(0);
        expect(entry.createdAt).toBeGreaterThan(0);
      });
    });

    describe('queryKnowledge', () => {
      beforeEach(() => {
        registry.publishKnowledge({
          publisherId: 'agent_a',
          type: 'best_practice',
          title: '代码审查最佳实践',
          content: '先检查安全漏洞，再检查代码风格',
          tags: ['code_review', 'security'],
          applicableScenes: ['coding'],
          qualityScore: 0.9,
        });
        registry.publishKnowledge({
          publisherId: 'agent_b',
          type: 'error_resolution',
          title: '文件读取超时解决方案',
          content: '增加重试机制和超时配置',
          tags: ['file_read', 'timeout'],
          applicableScenes: ['daily'],
          qualityScore: 0.7,
        });
      });

      it('应返回所有知识（无过滤）', () => {
        const results = registry.queryKnowledge({});
        expect(results.length).toBe(2);
      });

      it('应按类型过滤', () => {
        const results = registry.queryKnowledge({ type: 'best_practice' });
        expect(results.length).toBe(1);
        expect(results[0].type).toBe('best_practice');
      });

      it('应按场景过滤', () => {
        const results = registry.queryKnowledge({ scene: 'coding' });
        expect(results.length).toBe(1);
        expect(results[0].title).toContain('代码审查');
      });

      it('应按最低质量评分过滤', () => {
        const results = registry.queryKnowledge({ minQualityScore: 0.8 });
        expect(results.length).toBe(1);
        expect(results[0].qualityScore).toBeGreaterThanOrEqual(0.8);
      });

      it('应按关键词过滤', () => {
        const results = registry.queryKnowledge({ keywords: ['安全', '漏洞'] });
        expect(results.length).toBe(1);
        expect(results[0].title).toContain('代码审查');
      });

      it('应限制结果数', () => {
        const results = registry.queryKnowledge({ maxResults: 1 });
        expect(results.length).toBe(1);
      });
    });

    describe('referenceKnowledge', () => {
      it('应增加引用计数', () => {
        const entry = registry.publishKnowledge({
          publisherId: 'agent_a',
          type: 'task_solution',
          title: '搜索文件方案',
          content: '使用file_search工具',
          tags: ['file_search'],
          applicableScenes: [],
          qualityScore: 0.8,
        });

        registry.referenceKnowledge(entry.id);
        registry.referenceKnowledge(entry.id);

        const results = registry.queryKnowledge({ keywords: ['搜索'] });
        const found = results.find((r: { id: string }) => r.id === entry.id);
        expect(found?.referenceCount).toBe(2);
      });
    });

    describe('subscribeToKnowledge', () => {
      it('应在发布匹配知识时通知订阅者', () => {
        const notified: SharedKnowledgeEntry[] = [];
        const subId = registry.subscribeToKnowledge({
          subscriberId: 'agent_b',
          type: 'best_practice',
          onNewKnowledge: (entry: SharedKnowledgeEntry) => notified.push(entry),
        });

        registry.publishKnowledge({
          publisherId: 'agent_a',
          type: 'best_practice',
          title: '新最佳实践',
          content: '测试内容',
          tags: [],
          applicableScenes: [],
          qualityScore: 0.8,
        });

        expect(notified.length).toBe(1);
        expect(notified[0].title).toBe('新最佳实践');

        // 不匹配的类型不应通知
        registry.publishKnowledge({
          publisherId: 'agent_a',
          type: 'error_resolution',
          title: '错误解决',
          content: '测试',
          tags: [],
          applicableScenes: [],
          qualityScore: 0.7,
        });

        expect(notified.length).toBe(1); // 仍然是1
        registry.unsubscribeFromKnowledge(subId);
      });
    });

    describe('getKnowledgeStats', () => {
      it('应返回正确的统计信息', () => {
        registry.publishKnowledge({
          publisherId: 'agent_a',
          type: 'best_practice',
          title: '实践1',
          content: '内容',
          tags: [],
          applicableScenes: [],
          qualityScore: 0.9,
        });
        registry.publishKnowledge({
          publisherId: 'agent_a',
          type: 'error_resolution',
          title: '解决1',
          content: '内容',
          tags: [],
          applicableScenes: [],
          qualityScore: 0.7,
        });

        const stats = registry.getKnowledgeStats();
        expect(stats.totalEntries).toBe(2);
        expect(stats.entriesByType['best_practice']).toBe(1);
        expect(stats.entriesByType['error_resolution']).toBe(1);
        expect(stats.topContributors[0].agentId).toBe('agent_a');
        expect(stats.avgQualityScore).toBeCloseTo(0.8, 1);
      });
    });
  });
});
