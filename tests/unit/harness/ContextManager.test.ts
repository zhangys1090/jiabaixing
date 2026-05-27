/**
 * ContextManager 测试用例
 *
 * 测试上下文压缩、摘要、卸荷功能
 */

import { ContextManager } from '../../../src/harness/context/ContextManager';
import type { ChatMessage, UserInput } from '../../../src/harness/types';

// Mock 依赖项
const mockDeps = {
  constitutionalBuilder: {
    buildConstitutionPrompt: jest.fn().mockResolvedValue('宪法 prompt'),
  },
  memoryInjector: {
    autoRetrieveMemories: jest.fn().mockResolvedValue(['记忆1', '记忆2']),
  },
  dynamicContext: {
    getDynamicContext: jest.fn().mockReturnValue('动态上下文'),
  },
  historyProvider: {
    getRecentHistory: jest.fn().mockReturnValue([
      { role: 'user', content: '最近消息1' },
      { role: 'assistant', content: '最近回复1' },
    ]),
    getAllHistory: jest.fn().mockReturnValue([
      { role: 'user', content: '历史消息1' },
      { role: 'assistant', content: '历史回复1' },
      { role: 'user', content: '历史消息2' },
      { role: 'assistant', content: '历史回复2' },
      { role: 'user', content: '历史消息3' },
      { role: 'assistant', content: '历史回复3' },
      { role: 'user', content: '最近消息1' },
      { role: 'assistant', content: '最近回复1' },
    ]),
  },
};

describe('ContextManager', () => {
  let contextManager: ContextManager;

  beforeEach(() => {
    contextManager = new ContextManager(mockDeps, 4000);
    jest.clearAllMocks();
  });

  describe('buildContext', () => {
    it('应该能正常构建上下文', async () => {
      const input: UserInput = { text: '测试输入', userId: 'test' };
      const result = await contextManager.buildContext(input);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('compressContext', () => {
    it('应该在 token 足够时不压缩', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '系统消息' },
        { role: 'user', content: '用户消息' },
        { role: 'assistant', content: '助手回复' },
      ];
      const result = contextManager.compressContext(messages, 1000);
      expect(result.compressionRatio).toBe(1.0);
      expect(result.strategy).toBe('none_needed');
    });

    it('应该在 token 不足时进行压缩', () => {
      // 创建大量消息
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push({
          role: 'user',
          content: `这是第 ${i} 条用户消息，内容非常非常长，会占用很多 token 数。`.repeat(
            10
          ),
        });
        messages.push({
          role: 'assistant',
          content: `这是第 ${i} 条助手回复，内容同样非常非常长，会占用更多 token 数。`.repeat(
            10
          ),
        });
      }
      const result = contextManager.compressContext(messages, 500);
      expect(result.compressed.length).toBeLessThan(messages.length);
      expect(result.compressedTokenCount).toBeLessThan(
        result.originalTokenCount
      );
    });

    it('应该优先保留 system 消息', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '重要的系统消息1' },
        { role: 'system', content: '重要的系统消息2' },
        { role: 'user', content: '普通用户消息' },
        { role: 'assistant', content: '普通助手回复' },
      ];
      const result = contextManager.compressContext(messages, 100);
      const systemMessages = result.compressed.filter(
        (m) => m.role === 'system'
      );
      expect(systemMessages.length).toBeGreaterThan(0);
    });
  });

  describe('summarizeContext', () => {
    it('应该能生成上下文摘要', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '系统消息' },
        { role: 'user', content: '我需要帮助解决问题' },
        { role: 'assistant', content: '好的，我会帮你' },
        { role: 'user', content: '这个功能怎么用？' },
        { role: 'assistant', content: '让我来解释一下...' },
      ];
      const result = contextManager.summarizeContext(messages);
      expect(result.summary.content).toContain('5');
      expect(result.keyPoints.length).toBeGreaterThan(0);
      expect(result.originalCount).toBe(5);
    });

    it('应该能处理空消息', () => {
      const result = contextManager.summarizeContext([]);
      expect(result.originalCount).toBe(0);
      expect(result.summary.content).toBeTruthy();
    });
  });

  describe('offloadOldMessages', () => {
    it('应该能卸荷旧消息', () => {
      const messages: ChatMessage[] = [];
      // 添加很多条消息
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `消息 ${i}` });
        messages.push({ role: 'assistant', content: `回复 ${i}` });
      }
      const result = contextManager.offloadOldMessages(messages, 10);
      expect(result.active.length).toBeLessThan(messages.length);
      expect(result.offloaded.length).toBeGreaterThan(0);
    });

    it('应该支持不同的卸荷策略', () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `消息 ${i}` });
        messages.push({ role: 'assistant', content: `回复 ${i}` });
      }
      const result1 = contextManager.offloadOldMessages(
        messages,
        10,
        'oldest_first'
      );
      expect(result1.offloaded.length).toBeGreaterThan(0);
    });

    it('应该保留 system 消息', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '系统消息1' },
        { role: 'system', content: '系统消息2' },
      ];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `消息 ${i}` });
        messages.push({ role: 'assistant', content: `回复 ${i}` });
      }
      const result = contextManager.offloadOldMessages(messages, 10);
      const systemMessages = result.active.filter(
        (m) => m.role === 'system'
      );
      expect(systemMessages.length).toBe(2);
    });
  });

  describe('retrieveOffloadedMessages', () => {
    it('应该能检索卸荷的消息', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '搜索这个关键词123' },
        { role: 'assistant', content: '好的，我来帮你' },
      ];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `普通消息 ${i}` });
        messages.push({ role: 'assistant', content: `普通回复 ${i}` });
      }
      // 先卸荷
      contextManager.offloadOldMessages(messages, 5);
      // 然后检索
      const retrieved = contextManager.retrieveOffloadedMessages(['关键词']);
      expect(Array.isArray(retrieved)).toBe(true);
    });

    it('应该能在没有关键词时返回最近的卸荷消息', () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `消息 ${i}` });
      }
      contextManager.offloadOldMessages(messages, 5);
      const retrieved = contextManager.retrieveOffloadedMessages(undefined, 10);
      expect(retrieved.length).toBeLessThanOrEqual(10);
    });
  });
});
