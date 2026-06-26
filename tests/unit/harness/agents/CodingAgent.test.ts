import { CodingAgent } from '../../../../src/harness/agents/CodingAgent';
import { ToolCategory } from '../../../../src/harness/types';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('CodingAgent', () => {
  let agent: CodingAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new CodingAgent();
  });

  it('应该有正确的 id', () => {
    expect(agent.id).toBe('coding-agent');
  });

  it('应该有正确的 name', () => {
    expect(agent.name).toBe('Coding Agent');
  });

  it('应该声明 coding 能力', () => {
    expect(agent.capabilities).toContain('coding');
    expect(agent.capabilities).toContain('code_review');
    expect(agent.capabilities).toContain('refactoring');
  });

  it('应该持有 CODE 工具分类', () => {
    expect(agent.toolCategories).toContain(ToolCategory.CODE);
  });

  it('应该可以设置和调用执行函数', async () => {
    const mockFn = jest.fn().mockResolvedValue('code generated');
    agent.setExecuteFn(mockFn);

    const result = await agent.execute('写一个函数', 'context');
    expect(result).toBe('code generated');
  });
});
