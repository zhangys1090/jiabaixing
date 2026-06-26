import { DesktopAgent } from '../../../../src/harness/agents/DesktopAgent';
import { ToolCategory } from '../../../../src/harness/types';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('DesktopAgent', () => {
  let agent: DesktopAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new DesktopAgent();
  });

  it('应该有正确的 id', () => {
    expect(agent.id).toBe('desktop-agent');
  });

  it('应该有正确的 name', () => {
    expect(agent.name).toBe('Desktop Agent');
  });

  it('应该声明 desktop 能力', () => {
    expect(agent.capabilities).toContain('desktop_screenshot');
    expect(agent.capabilities).toContain('desktop_automation');
  });

  it('应该持有 DESKTOP 工具分类', () => {
    expect(agent.toolCategories).toContain(ToolCategory.DESKTOP);
  });

  it('应该可以设置和调用执行函数', async () => {
    const mockFn = jest.fn().mockResolvedValue('screenshot taken');
    agent.setExecuteFn(mockFn);

    const result = await agent.execute('截图', 'context');
    expect(result).toBe('screenshot taken');
  });
});
