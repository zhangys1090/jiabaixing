import { AgentFactory } from '../../../../src/harness/agents/AgentFactory';
import { CodingAgent } from '../../../../src/harness/agents/CodingAgent';
import { FileAgent } from '../../../../src/harness/agents/FileAgent';
import { DesktopAgent } from '../../../../src/harness/agents/DesktopAgent';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('AgentFactory', () => {
  describe('createAgent', () => {
    it('应该根据 coding 场景创建 CodingAgent', () => {
      const agent = AgentFactory.createAgent('coding');
      expect(agent).toBeInstanceOf(CodingAgent);
      expect(agent.id).toBe('coding-agent');
    });

    it('应该根据 file 场景创建 FileAgent', () => {
      const agent = AgentFactory.createAgent('file');
      expect(agent).toBeInstanceOf(FileAgent);
      expect(agent.id).toBe('file-agent');
    });

    it('应该根据 desktop 场景创建 DesktopAgent', () => {
      const agent = AgentFactory.createAgent('desktop');
      expect(agent).toBeInstanceOf(DesktopAgent);
      expect(agent.id).toBe('desktop-agent');
    });

    it('未知场景应该抛出错误', () => {
      expect(() => AgentFactory.createAgent('unknown' as never)).toThrow();
    });
  });

  describe('createAllAgents', () => {
    it('应该创建所有 Agent 实例', () => {
      const agents = AgentFactory.createAllAgents();
      expect(agents).toHaveLength(3);
      expect(agents.some((a) => a instanceof CodingAgent)).toBe(true);
      expect(agents.some((a) => a instanceof FileAgent)).toBe(true);
      expect(agents.some((a) => a instanceof DesktopAgent)).toBe(true);
    });
  });

  describe('selectAgentByGoal', () => {
    it('应该为代码相关目标选择 CodingAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('写一个函数');
      expect(agent).toBeInstanceOf(CodingAgent);
    });

    it('应该为文件相关目标选择 FileAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('读取文件');
      expect(agent).toBeInstanceOf(FileAgent);
    });

    it('应该为桌面相关目标选择 DesktopAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('截图');
      expect(agent).toBeInstanceOf(DesktopAgent);
    });

    it('默认应该选择 CodingAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('你好');
      expect(agent).toBeInstanceOf(CodingAgent);
    });
  });
});
