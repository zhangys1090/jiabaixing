import { FileAgent } from '../../../../src/harness/agents/FileAgent';
import { ToolCategory } from '../../../../src/harness/types';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('FileAgent', () => {
  let agent: FileAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new FileAgent();
  });

  it('应该有正确的 id', () => {
    expect(agent.id).toBe('file-agent');
  });

  it('应该有正确的 name', () => {
    expect(agent.name).toBe('File Agent');
  });

  it('应该声明 file 能力', () => {
    expect(agent.capabilities).toContain('file_read');
    expect(agent.capabilities).toContain('file_search');
    expect(agent.capabilities).toContain('file_edit');
  });

  it('应该持有 FILE 工具分类', () => {
    expect(agent.toolCategories).toContain(ToolCategory.FILE);
  });

  it('应该可以设置和调用执行函数', async () => {
    const mockFn = jest.fn().mockResolvedValue('file read');
    agent.setExecuteFn(mockFn);

    const result = await agent.execute('读取文件', 'context');
    expect(result).toBe('file read');
  });
});
