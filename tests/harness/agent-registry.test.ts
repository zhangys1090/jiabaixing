/**
 * AgentRegistry 单元测试
 */
import { AgentRegistry, AgentRegistration } from '../../src/harness/orchestration/AgentRegistry';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  test('应该能注册和查找Agent', () => {
    registry.register({
      id: 'agent-1',
      name: '代码助手',
      capabilities: [
        { name: 'write', description: '写文件', tools: ['write_file'] },
      ],
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    const found = registry.findAgentByCapability('write_file');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('agent-1');
  });

  test('没有匹配能力时返回null', () => {
    const found = registry.findAgentByCapability('nonexistent_tool');
    expect(found).toBeNull();
  });

  test('应该能更新Agent状态', () => {
    registry.register({
      id: 'agent-1',
      name: '测试Agent',
      capabilities: [],
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    registry.updateStatus('agent-1', 'busy');
    const agent = registry.getAgent('agent-1');
    expect(agent?.status).toBe('busy');
  });

  test('应该能按状态过滤Agent列表', () => {
    registry.register({
      id: 'agent-1', name: 'a1', capabilities: [], status: 'idle',
      createdAt: new Date(), lastActiveAt: new Date(),
    });
    registry.register({
      id: 'agent-2', name: 'a2', capabilities: [], status: 'busy',
      createdAt: new Date(), lastActiveAt: new Date(),
    });
    registry.register({
      id: 'agent-3', name: 'a3', capabilities: [], status: 'idle',
      createdAt: new Date(), lastActiveAt: new Date(),
    });

    const idleAgents = registry.listAgents('idle');
    expect(idleAgents).toHaveLength(2);
  });

  test('应该能注销Agent', () => {
    registry.register({
      id: 'agent-1', name: 'a1', capabilities: [], status: 'idle',
      createdAt: new Date(), lastActiveAt: new Date(),
    });
    expect(registry.listAgents()).toHaveLength(1);

    registry.unregister('agent-1');
    expect(registry.listAgents()).toHaveLength(0);
  });
});
