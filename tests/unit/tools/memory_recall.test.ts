/**
 * Unit tests for memory_recall harness tool
 */

import {
  createMemoryRecallExecutor,
  MEMORY_RECALL_DEF,
} from '../../../src/harness/tools/memory/memory_recall';

// Mock MemoryAssistant
class MockMemoryAssistant {
  retrieveContext = jest.fn();
}

describe('memory_recall 工具', () => {
  describe('工具定义', () => {
    it('应该有正确的名称和分类', () => {
      expect(MEMORY_RECALL_DEF.name).toBe('memory_recall');
      expect(MEMORY_RECALL_DEF.category).toBe('memory');
      expect(MEMORY_RECALL_DEF.requiredParams).toContain('query');
      expect(MEMORY_RECALL_DEF.requiredPermissions).toContain('memory:read');
      expect(MEMORY_RECALL_DEF.timeout).toBe(10000);
    });
  });

  describe('无依赖模式（无 retrieveRelevant 和 memoryAssistant）', () => {
    const executor = createMemoryRecallExecutor({});

    it('应返回"暂无可用记忆"', async () => {
      const result = await executor({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.output).toBe('暂无可用记忆');
    });

    it('空查询应提示输入关键词', async () => {
      const result = await executor({ query: '' });
      expect(result.success).toBe(true);
      expect(result.output).toBe('请输入搜索关键词');
    });
  });

  describe('通过 retrieveRelevant 依赖检索', () => {
    const mockRetrieveRelevant = jest.fn();
    const mockUpdateAccessStats = jest.fn();

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('应返回格式化的记忆列表', async () => {
      mockRetrieveRelevant.mockResolvedValue([
        { content: '用户喜欢Python编程' },
        { content: '用户偏好Visual Studio Code' },
      ]);
      const executor = createMemoryRecallExecutor({
        retrieveRelevant: mockRetrieveRelevant,
      });
      const result = await executor({ query: '用户偏好' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('用户喜欢Python编程');
      expect(result.output).toContain('用户偏好Visual Studio Code');
      expect(mockRetrieveRelevant).toHaveBeenCalledWith({
        query: '用户偏好',
        limit: 5,
      });
    });

    it('应包含重要性信息', async () => {
      mockRetrieveRelevant.mockResolvedValue([
        { content: '用户喜欢的音乐类型是摇滚', importance: 0.85 },
      ]);
      const executor = createMemoryRecallExecutor({
        retrieveRelevant: mockRetrieveRelevant,
      });
      const result = await executor({ query: '音乐' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('[重要性:0.85]');
    });

    it('应调用 updateAccessStats', async () => {
      mockRetrieveRelevant.mockResolvedValue([
        { content: '某条记忆', importance: 0.5 },
      ]);
      const executor = createMemoryRecallExecutor({
        retrieveRelevant: mockRetrieveRelevant,
        updateAccessStats: mockUpdateAccessStats,
      });
      await executor({ query: 'test' });
      expect(mockUpdateAccessStats).toHaveBeenCalledWith('test');
    });

    it('空结果应返回"未找到相关记忆"', async () => {
      mockRetrieveRelevant.mockResolvedValue([]);
      const executor = createMemoryRecallExecutor({
        retrieveRelevant: mockRetrieveRelevant,
      });
      const result = await executor({ query: 'nonexistent' });
      expect(result.success).toBe(true);
      expect(result.output).toBe('未找到相关记忆');
    });

    it('检索异常应返回"记忆检索暂不可用"', async () => {
      mockRetrieveRelevant.mockRejectedValue(new Error('db error'));
      const executor = createMemoryRecallExecutor({
        retrieveRelevant: mockRetrieveRelevant,
      });
      const result = await executor({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.output).toBe('记忆检索暂不可用');
    });

    it('应支持自定义 limit 参数', async () => {
      mockRetrieveRelevant.mockResolvedValue([
        { content: 'a' },
        { content: 'b' },
        { content: 'c' },
      ]);
      const executor = createMemoryRecallExecutor({
        retrieveRelevant: mockRetrieveRelevant,
      });
      await executor({ query: 'test', limit: 2 });
      expect(mockRetrieveRelevant).toHaveBeenCalledWith({
        query: 'test',
        limit: 2,
      });
    });
  });

  describe('通过 MemoryAssistant 备用检索', () => {
    let mockAssistant: MockMemoryAssistant;

    beforeEach(() => {
      mockAssistant = new MockMemoryAssistant();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('应使用 memoryAssistant.retrieveContext 检索记忆', async () => {
      mockAssistant.retrieveContext.mockResolvedValue({
        memories: [
          { type: 'preference', relevance: 0.9, content: '用户喜欢Go语言' },
          { type: 'fact', relevance: 0.7, content: '用户从事后端开发' },
        ],
        preferences: { codingStyle: [], namingRules: [] },
      });
      const executor = createMemoryRecallExecutor({
        memoryAssistant: mockAssistant as any,
      });
      const result = await executor({ query: '用户偏好' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('用户喜欢Go语言');
      expect(result.output).toContain('用户从事后端开发');
      expect(result.output).toContain('[类型:preference');
      expect(mockAssistant.retrieveContext).toHaveBeenCalledWith('用户偏好');
    });

    it('应限制返回数量', async () => {
      mockAssistant.retrieveContext.mockResolvedValue({
        memories: [
          { type: 'a', relevance: 0.5, content: '1' },
          { type: 'b', relevance: 0.5, content: '2' },
          { type: 'c', relevance: 0.5, content: '3' },
        ],
        preferences: { codingStyle: [], namingRules: [] },
      });
      const executor = createMemoryRecallExecutor({
        memoryAssistant: mockAssistant as any,
      });
      const result = await executor({ query: 'test', limit: 2 });
      const lines = (result.output as string).split('\n');
      // 过滤空行
      const nonEmptyLines = lines.filter((l) => l.trim());
      expect(nonEmptyLines.length).toBeLessThanOrEqual(2);
    });

    it('空结果应返回"未找到相关记忆"', async () => {
      mockAssistant.retrieveContext.mockResolvedValue({
        memories: [],
        preferences: { codingStyle: [], namingRules: [] },
      });
      const executor = createMemoryRecallExecutor({
        memoryAssistant: mockAssistant as any,
      });
      const result = await executor({ query: 'empty' });
      expect(result.success).toBe(true);
      expect(result.output).toBe('未找到相关记忆');
    });

    it('retrieveContext 异常应返回"记忆检索暂不可用"', async () => {
      mockAssistant.retrieveContext.mockRejectedValue(new Error('error'));
      const executor = createMemoryRecallExecutor({
        memoryAssistant: mockAssistant as any,
      });
      const result = await executor({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.output).toBe('记忆检索暂不可用');
    });
  });

  describe('优先级：retrieveRelevant 优先于 memoryAssistant', () => {
    it('当两者都存在时，应优先使用 retrieveRelevant', async () => {
      const mockRetrieveRelevant = jest
        .fn()
        .mockResolvedValue([
          { content: '来自 retrieveRelevant 的结果' },
        ]);
      const mockAssistant = new MockMemoryAssistant();
      mockAssistant.retrieveContext.mockResolvedValue({
        memories: [{ type: 'a', relevance: 0.5, content: '来自 assistant 的结果' }],
        preferences: { codingStyle: [], namingRules: [] },
      });

      const executor = createMemoryRecallExecutor({
        retrieveRelevant: mockRetrieveRelevant,
        memoryAssistant: mockAssistant as any,
      });
      const result = await executor({ query: 'test' });
      expect(result.output).toContain('来自 retrieveRelevant');
      expect(mockAssistant.retrieveContext).not.toHaveBeenCalled();
    });
  });
});
