/**
 * ContextWindowManager 单元测试
 *
 * 测试循环内动态上下文窗口管理:
 *   - token 估算（中英文区分）
 *   - 工具结果截断（头部+尾部+中间省略）
 *   - 历史压缩（保留近期 + 摘要早期）
 *   - 预算管理（阈值触发 + 可配置）
 */

import { ContextWindowManager } from '../../../src/harness/context/ContextWindowManager';
import type { ChatMessage } from '../../../src/harness/types';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeMessage(
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string | null,
  extra?: Partial<ChatMessage>
): ChatMessage {
  return { role, content, ...extra } as ChatMessage;
}

function makeLongContent(tokens: number): string {
  // 生成约 N tokens 的英文内容（4字符≈1token）
  return 'word '.repeat(tokens);
}

function makeLongChineseContent(tokens: number): string {
  // 生成约 N tokens 的中文内容（2字符≈1token）
  return '你好'.repeat(tokens);
}

describe('ContextWindowManager', () => {
  describe('Token 估算', () => {
    let manager: ContextWindowManager;

    beforeEach(() => {
      manager = new ContextWindowManager();
    });

    it('应该估算英文文本 token（约4字符=1token）', () => {
      const tokens = manager.estimateTextTokens('hello world test');
      expect(tokens).toBeGreaterThan(2);
      expect(tokens).toBeLessThan(6);
    });

    it('应该估算中文文本 token（约2字符=1token）', () => {
      const tokens = manager.estimateTextTokens('你好世界测试');
      expect(tokens).toBe(3);
    });

    it('应该处理空字符串', () => {
      expect(manager.estimateTextTokens('')).toBe(0);
      expect(manager.estimateTextTokens(null as unknown as string)).toBe(0);
    });

    it('应该估算消息列表 token（含固定开销）', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', '你是助手'),
        makeMessage('user', '你好'),
      ];
      const tokens = manager.estimateTokens(messages);
      expect(tokens).toBeGreaterThan(10);
    });

    it('应该估算含 tool_calls 的消息 token', () => {
      const messages: ChatMessage[] = [
        makeMessage('assistant', null, {
          tool_calls: [
            {
              id: 'tc_1',
              type: 'function',
              function: {
                name: 'file_read',
                arguments: '{"path":"/test.txt"}',
              },
            },
          ],
        }),
      ];
      const tokens = manager.estimateTokens(messages);
      expect(tokens).toBeGreaterThan(5);
    });
  });

  describe('工具结果截断', () => {
    let manager: ContextWindowManager;

    beforeEach(() => {
      manager = new ContextWindowManager({
        maxToolResultTokens: 100,
      });
    });

    it('短结果不应截断', () => {
      const result = manager.truncateToolResult('short content', 'file_read');
      expect(result.truncated).toBe(false);
      expect(result.content).toBe('short content');
    });

    it('长结果应截断为头部+中间提示+尾部', () => {
      const longContent = makeLongContent(500); // ~500 tokens
      const result = manager.truncateToolResult(longContent, 'shell_exec');
      expect(result.truncated).toBe(true);
      expect(result.originalLength).toBe(longContent.length);
      expect(result.content).toContain('[...已截断');
      expect(result.content.length).toBeLessThan(longContent.length);
    });

    it('截断后应保留头部内容', () => {
      const longContent = 'HEAD_' + makeLongContent(500) + '_TAIL';
      const result = manager.truncateToolResult(longContent, 'shell_exec');
      expect(result.content).toContain('HEAD_');
    });

    it('截断后应保留尾部内容', () => {
      const longContent = 'HEAD_' + makeLongContent(500) + '_TAIL';
      const result = manager.truncateToolResult(longContent, 'shell_exec');
      expect(result.content).toContain('_TAIL');
    });

    it('空内容应返回空结果', () => {
      const result = manager.truncateToolResult('', 'file_read');
      expect(result.content).toBe('');
      expect(result.truncated).toBe(false);
    });

    it('中文长结果也应正确截断', () => {
      const longContent = makeLongChineseContent(500);
      const result = manager.truncateToolResult(longContent, 'shell_exec');
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('[...已截断');
    });
  });

  describe('历史压缩', () => {
    let manager: ContextWindowManager;

    beforeEach(() => {
      manager = new ContextWindowManager({
        maxContextTokens: 1000,
        compressionThreshold: 0.5,
        keepRecentMessages: 4,
        maxToolResultTokens: 500,
        reservedForCompletion: 100,
      });
    });

    it('消息数不足时不应压缩', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        makeMessage('user', 'hi'),
        makeMessage('assistant', 'hello'),
      ];
      const result = manager.compressHistory(messages);
      expect(result.strategy).toBe('no-op');
      expect(result.messages).toEqual(messages);
    });

    it('应保留最近N条消息', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        makeMessage('user', 'msg1'),
        makeMessage('assistant', 'resp1'),
        makeMessage('user', 'msg2'),
        makeMessage('assistant', 'resp2'),
        makeMessage('user', 'msg3'),
        makeMessage('assistant', 'resp3'),
        makeMessage('user', 'recent1'),
        makeMessage('assistant', 'recent2'),
      ];
      const result = manager.compressHistory(messages);
      // 保留最近4条
      const nonSystem = result.messages.filter((m) => m.role !== 'system');
      expect(nonSystem.length).toBeLessThanOrEqual(4);
    });

    it('应生成历史摘要', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        makeMessage('user', '早期问题1'),
        makeMessage('assistant', '早期回答1'),
        makeMessage('user', '早期问题2'),
        makeMessage('assistant', '早期回答2'),
        makeMessage('user', '最近问题'),
        makeMessage('assistant', '最近回答'),
      ];
      const result = manager.compressHistory(messages);
      const summaryMsg = result.messages.find(
        (m) => m.role === 'system' && m.content?.includes('历史摘要')
      );
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.content).toContain('早期问题1');
    });

    it('应保持 assistant+tool_calls/tool 配对完整', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        makeMessage('user', 'q1'),
        makeMessage('assistant', null, {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'file_read', arguments: '{}' },
            },
          ],
        }),
        makeMessage('tool', 'result1', { tool_call_id: 'tc1' }),
        makeMessage('assistant', 'answer1'),
        makeMessage('user', 'q2'),
        makeMessage('assistant', 'answer2'),
        makeMessage('user', 'q3'),
        makeMessage('assistant', 'answer3'),
      ];
      const result = manager.compressHistory(messages);
      // 检查是否有孤立的 tool 消息（没有对应 assistant+tool_calls）
      const nonSystem = result.messages.filter((m) => m.role !== 'system');
      for (let i = 0; i < nonSystem.length; i++) {
        if (nonSystem[i].role === 'tool') {
          // 前一条应该是 assistant 且有 tool_calls
          const prev = nonSystem[i - 1];
          expect(prev?.role).toBe('assistant');
          expect((prev as { tool_calls?: unknown[] }).tool_calls).toBeDefined();
        }
      }
    });

    it('应返回压缩比', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        ...Array(10)
          .fill(null)
          .map((_, i) => makeMessage('user', `问题${i}_${'x'.repeat(50)}`)),
        ...Array(10)
          .fill(null)
          .map((_, i) =>
            makeMessage('assistant', `回答${i}_${'y'.repeat(50)}`)
          ),
      ];
      const result = manager.compressHistory(messages);
      expect(result.compressionRatio).toBeLessThan(1.0);
      expect(result.compressedTokenCount).toBeLessThan(
        result.originalTokenCount
      );
    });
  });

  describe('窗口管理（manageWindow）', () => {
    let manager: ContextWindowManager;

    beforeEach(() => {
      manager = new ContextWindowManager({
        maxContextTokens: 500,
        compressionThreshold: 0.8,
        keepRecentMessages: 4,
        maxToolResultTokens: 100,
        reservedForCompletion: 50,
      });
    });

    it('未超阈值时不应修改消息', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        makeMessage('user', 'hi'),
      ];
      const result = manager.manageWindow(messages);
      expect(result).toEqual(messages);
    });

    it('超阈值时应触发压缩', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        ...Array(20)
          .fill(null)
          .map((_, i) =>
            makeMessage('user', `问题${i}_${'content'.repeat(20)}`)
          ),
        ...Array(20)
          .fill(null)
          .map((_, i) =>
            makeMessage('assistant', `回答${i}_${'content'.repeat(20)}`)
          ),
      ];
      const result = manager.manageWindow(messages);
      expect(result.length).toBeLessThan(messages.length);
    });

    it('应先截断工具结果再压缩历史', () => {
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        makeMessage('user', 'q1'),
        makeMessage('assistant', null, {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'shell_exec', arguments: '{}' },
            },
          ],
        }),
        makeMessage('tool', makeLongContent(500), { tool_call_id: 'tc1' }),
        makeMessage('assistant', 'answer'),
        makeMessage('user', 'q2'),
        makeMessage('assistant', 'answer2'),
      ];
      const result = manager.manageWindow(messages);
      // 工具结果应被截断
      const toolMsg = result.find((m) => m.role === 'tool');
      if (toolMsg?.content) {
        expect(toolMsg.content).toContain('[...已截断');
      }
    });
  });

  describe('配置管理', () => {
    it('应支持运行时更新配置', () => {
      const manager = new ContextWindowManager();
      manager.updateConfig({ maxContextTokens: 32000 });
      const config = manager.getConfig();
      expect(config.maxContextTokens).toBe(32000);
    });

    it('应支持适配大窗口模型（32K）', () => {
      const manager = new ContextWindowManager({
        maxContextTokens: 32000,
        compressionThreshold: 0.85,
        maxToolResultTokens: 4000,
      });
      const config = manager.getConfig();
      expect(config.maxContextTokens).toBe(32000);
      expect(config.compressionThreshold).toBe(0.85);
      expect(config.maxToolResultTokens).toBe(4000);
    });

    it('应支持适配小窗口模型（4K）', () => {
      const manager = new ContextWindowManager({
        maxContextTokens: 4096,
        compressionThreshold: 0.75,
        maxToolResultTokens: 800,
        keepRecentMessages: 4,
      });
      const config = manager.getConfig();
      expect(config.maxContextTokens).toBe(4096);
      expect(config.maxToolResultTokens).toBe(800);
    });
  });

  describe('使用情况查询', () => {
    it('应返回当前使用情况', () => {
      const manager = new ContextWindowManager({
        maxContextTokens: 1000,
        compressionThreshold: 0.8,
      });
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        makeMessage('user', '你好'),
      ];
      const usage = manager.getUsage(messages);
      expect(usage.used).toBeGreaterThan(0);
      expect(usage.total).toBe(1000);
      expect(usage.ratio).toBeGreaterThan(0);
      expect(usage.ratio).toBeLessThan(1);
      expect(usage.needsCompression).toBe(false);
    });

    it('needsCompression 应正确判断', () => {
      const manager = new ContextWindowManager({
        maxContextTokens: 100,
        compressionThreshold: 0.5,
      });
      const messages: ChatMessage[] = [
        makeMessage('system', 'sys'),
        ...Array(20)
          .fill(null)
          .map(() => makeMessage('user', 'content '.repeat(10))),
      ];
      expect(manager.needsCompression(messages)).toBe(true);
    });
  });

  describe('端到端场景', () => {
    it('模拟 ReAct 循环多轮工具调用后的上下文管理', () => {
      const manager = new ContextWindowManager({
        maxContextTokens: 800,
        compressionThreshold: 0.75,
        keepRecentMessages: 6,
        maxToolResultTokens: 150,
        reservedForCompletion: 100,
      });

      // 模拟5轮工具调用后的消息
      const messages: ChatMessage[] = [
        makeMessage('system', '你是助手'),
        makeMessage('user', '请读取多个文件'),
      ];

      for (let i = 0; i < 5; i++) {
        messages.push(
          makeMessage('assistant', null, {
            tool_calls: [
              {
                id: `tc_${i}`,
                type: 'function',
                function: { name: 'file_read', arguments: `{"path":"f${i}"}` },
              },
            ],
          })
        );
        messages.push(
          makeMessage('tool', `文件${i}内容: ${'line\n'.repeat(100)}`, {
            tool_call_id: `tc_${i}`,
            name: 'file_read',
          })
        );
      }

      const result = manager.manageWindow(messages);
      const usage = manager.getUsage(result);

      // 压缩后应在预算内
      expect(usage.needsCompression).toBe(false);
      // 工具结果应被截断
      const toolMsgs = result.filter((m) => m.role === 'tool');
      for (const tm of toolMsgs) {
        if (tm.content) {
          const tokens = manager.estimateTextTokens(tm.content);
          expect(tokens).toBeLessThanOrEqual(200);
        }
      }
    });
  });
});
