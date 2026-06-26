import { BaseAgent } from '../../../../src/harness/agents/BaseAgent';
import { ToolCategory } from '../../../../src/harness/types';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// 创建一个具体 Agent 用于测试抽象基类
class TestAgent extends BaseAgent {
  constructor() {
    super({
      id: 'test-agent',
      name: 'Test Agent',
      description: '测试用 Agent',
      capabilities: ['testing'],
      toolCategories: [ToolCategory.SYSTEM],
    });
  }
}

describe('BaseAgent', () => {
  let agent: TestAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new TestAgent();
  });

  describe('基本信息', () => {
    it('应该有正确的 id', () => {
      expect(agent.id).toBe('test-agent');
    });

    it('应该有正确的 name', () => {
      expect(agent.name).toBe('Test Agent');
    });

    it('应该有正确的 description', () => {
      expect(agent.description).toBe('测试用 Agent');
    });

    it('应该声明 capabilities', () => {
      expect(agent.capabilities).toContain('testing');
    });

    it('应该声明 toolCategories', () => {
      expect(agent.toolCategories).toContain(ToolCategory.SYSTEM);
    });
  });

  describe('状态管理', () => {
    it('初始状态应该是 idle', () => {
      expect(agent.status).toBe('idle');
    });

    it('执行时状态应该是 busy', async () => {
      const mockExecute = jest.fn().mockResolvedValue('result');
      agent.setExecuteFn(mockExecute);

      const promise = agent.execute('test goal', 'test context');
      expect(agent.status).toBe('busy');

      await promise;
      expect(agent.status).toBe('idle');
    });

    it('执行失败后状态应该是 error', async () => {
      const mockExecute = jest.fn().mockRejectedValue(new Error('fail'));
      agent.setExecuteFn(mockExecute);

      await expect(agent.execute('goal')).rejects.toThrow('fail');
      expect(agent.status).toBe('error');
    });

    it('执行失败后可以重置为 idle', async () => {
      const mockExecute = jest.fn().mockRejectedValue(new Error('fail'));
      agent.setExecuteFn(mockExecute);

      await expect(agent.execute('goal')).rejects.toThrow('fail');
      agent.reset();
      expect(agent.status).toBe('idle');
    });
  });

  describe('execute', () => {
    it('应该调用设置的执行函数', async () => {
      const mockExecute = jest.fn().mockResolvedValue('success');
      agent.setExecuteFn(mockExecute);

      const result = await agent.execute('goal', 'context');
      expect(result).toBe('success');
      expect(mockExecute).toHaveBeenCalledWith('goal', 'context', agent);
    });

    it('没有设置执行函数时应该抛出错误', async () => {
      await expect(agent.execute('goal')).rejects.toThrow('executeFn');
    });
  });

  describe('工具过滤', () => {
    it('应该能获取工具分类列表', () => {
      expect(agent.toolCategories).toEqual([ToolCategory.SYSTEM]);
    });
  });
});
