/**
 * MessageSanitizer 统一消息净化器单元测试
 *
 * 验证收敛后的三类净化逻辑：
 *   1. sanitizeMessagesForAPI — 消息级净化（合并 system / 校验 tool 顺序 / 跳过空 assistant）
 *   2. sanitizeText — PII 脱敏（委托 SensitiveDetector）
 *   3. repairToolCallArguments — JSON 参数修复（从 Executor 迁移）
 */

import { MessageSanitizer } from '../../../src/models/MessageSanitizer';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('MessageSanitizer', () => {
  let sanitizer: MessageSanitizer;

  beforeEach(() => {
    sanitizer = new MessageSanitizer();
  });

  // ==================== sanitizeMessagesForAPI ====================

  describe('sanitizeMessagesForAPI', () => {
    it('应合并多条 system 消息为一条', () => {
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'system', content: '规则一' },
        { role: 'system', content: '规则二' },
        { role: 'user', content: '你好' },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        role: 'system',
        content: '规则一\n\n规则二',
      });
      expect(result[1]).toMatchObject({ role: 'user', content: '你好' });
    });

    it('应跳过空 content 的 system 消息', () => {
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'system', content: '' },
        { role: 'user', content: '你好' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ role: 'user', content: '你好' });
    });

    it('应跳过空 content 的 assistant 消息（无 tool_calls）', () => {
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: null },
        { role: 'assistant', content: '回复' },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ role: 'user', content: '你好' });
      expect(result[1]).toMatchObject({ role: 'assistant', content: '回复' });
    });

    it('应保留有 tool_calls 的 assistant 消息（content 可为空）', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"q":"test"}' },
        },
      ];
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'user', content: '搜索' },
        { role: 'assistant', content: null, tool_calls: toolCalls },
      ]);
      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({ role: 'assistant' });
      expect(result[1].tool_calls).toEqual(toolCalls);
      expect(result[1].content).toBe('');
    });

    it('应跳过前无 assistant+tool_calls 的孤立 tool 消息', () => {
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'user', content: '你好' },
        { role: 'tool', content: '结果', tool_call_id: 'orphan' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ role: 'user', content: '你好' });
    });

    it('应保留合法的 tool 消息（前有 assistant+tool_calls）', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{}' },
        },
      ];
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'user', content: '搜索' },
        { role: 'assistant', content: '', tool_calls: toolCalls },
        {
          role: 'tool',
          content: '结果',
          tool_call_id: 'call_1',
          name: 'web_search',
        },
      ]);
      expect(result).toHaveLength(3);
      expect(result[2]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '结果',
        name: 'web_search',
      });
    });

    it('应处理连续多条 tool 消息', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 't1', arguments: '{}' },
        },
        {
          id: 'call_2',
          type: 'function',
          function: { name: 't2', arguments: '{}' },
        },
      ];
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'user', content: '搜索' },
        { role: 'assistant', content: '', tool_calls: toolCalls },
        { role: 'tool', content: 'r1', tool_call_id: 'call_1' },
        { role: 'tool', content: 'r2', tool_call_id: 'call_2' },
      ]);
      expect(result).toHaveLength(4);
    });

    it('应为无 content 的 user 消息填充空字符串', () => {
      const result = sanitizer.sanitizeMessagesForAPI([
        { role: 'user', content: null },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ role: 'user', content: '' });
    });

    it('应处理空数组输入', () => {
      const result = sanitizer.sanitizeMessagesForAPI([]);
      expect(result).toHaveLength(0);
    });
  });

  // ==================== sanitizeText ====================

  describe('sanitizeText', () => {
    it('应脱敏 API 密钥', () => {
      const result = sanitizer.sanitizeText(
        '使用 sk-1234567890abcdefghijklmnop 认证'
      );
      expect(result).toContain('[API密钥-已脱敏]');
      expect(result).not.toContain('sk-1234567890abcdefghijklmnop');
    });

    it('应脱敏手机号', () => {
      const result = sanitizer.sanitizeText('联系我 13812345678');
      expect(result).toContain('[手机号-已脱敏]');
    });

    it('应脱敏邮箱', () => {
      const result = sanitizer.sanitizeText('发到 test@example.com');
      expect(result).toContain('[邮箱-已脱敏]');
    });

    it('应脱敏密码字段', () => {
      const result = sanitizer.sanitizeText('password=secret123');
      expect(result).toContain('[已脱敏]');
      expect(result).not.toContain('secret123');
    });

    it('应保留无敏感信息的文本', () => {
      const text = '这是一段普通文本，没有敏感信息。';
      expect(sanitizer.sanitizeText(text)).toBe(text);
    });
  });

  // ==================== repairToolCallArguments ====================

  describe('repairToolCallArguments', () => {
    it('应修复未闭合的大括号', () => {
      const result = sanitizer.repairToolCallArguments('{"path": "/tmp/test"');
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应修复尾随逗号', () => {
      const result = sanitizer.repairToolCallArguments('{"path": "/tmp",}');
      expect(result).toEqual({ path: '/tmp' });
    });

    it('应修复单引号', () => {
      const result = sanitizer.repairToolCallArguments("{'path': '/tmp/test'}");
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应修复未加引号的键名', () => {
      const result = sanitizer.repairToolCallArguments('{path: "/tmp/test"}');
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应剥离代码块标记', () => {
      const result = sanitizer.repairToolCallArguments(
        '```json\n{"path": "/tmp/test"}\n```'
      );
      expect(result).toEqual({ path: '/tmp/test' });
    });

    it('应转义字符串内的换行符', () => {
      const result = sanitizer.repairToolCallArguments(
        '{"text": "line1\nline2"}'
      );
      expect(result).toEqual({ text: 'line1\nline2' });
    });

    it('应提取首个 JSON 对象（去除尾随文本）', () => {
      const result = sanitizer.repairToolCallArguments(
        'Here is the args: {"path": "/tmp"} done'
      );
      expect(result).toEqual({ path: '/tmp' });
    });

    it('应修复复合错误（单引号+尾随逗号+未闭合）', () => {
      const result = sanitizer.repairToolCallArguments(
        "{'path': '/tmp', 'limit': 10"
      );
      expect(result).toEqual({ path: '/tmp', limit: 10 });
    });

    it('应对空字符串返回 null', () => {
      expect(sanitizer.repairToolCallArguments('')).toBeNull();
    });

    it('应对非 JSON 字符串返回 null', () => {
      expect(sanitizer.repairToolCallArguments('not a json at all')).toBeNull();
    });

    it('应对有效 JSON 原样解析', () => {
      const result = sanitizer.repairToolCallArguments(
        '{"path": "/tmp/test", "limit": 10}'
      );
      expect(result).toEqual({ path: '/tmp/test', limit: 10 });
    });

    it('应修复数组格式的 JSON', () => {
      const result = sanitizer.repairToolCallArguments('[1, 2, 3,');
      expect(result).toEqual([1, 2, 3]);
    });

    it('应对 null/undefined 输入返回 null', () => {
      expect(
        sanitizer.repairToolCallArguments(null as unknown as string)
      ).toBeNull();
      expect(
        sanitizer.repairToolCallArguments(undefined as unknown as string)
      ).toBeNull();
    });
  });

  // ==================== 静态方法便捷入口 ====================

  describe('静态便捷方法', () => {
    it('MessageSanitizer.sanitizeMessages 应等效于实例方法', () => {
      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ];
      const instanceResult = sanitizer.sanitizeMessagesForAPI(messages);
      const staticResult = MessageSanitizer.sanitizeMessages(messages);
      expect(staticResult).toEqual(instanceResult);
    });

    it('MessageSanitizer.repairJson 应等效于实例方法', () => {
      const raw = '{"a": 1';
      expect(MessageSanitizer.repairJson(raw)).toEqual(
        sanitizer.repairToolCallArguments(raw)
      );
    });
  });
});
