/**
 * fenceContext + NFS pragma 降级测试
 *
 * 验证:
 *   1. ContextManager.fenceContext() — 上下文围栏，限制消息窗口范围
 *   2. SessionStore NFS 检测与 pragma 降级
 */

import type { ContextManagerDeps } from '../../src/harness/context/ContextManager';
import { ContextManager } from '../../src/harness/context/ContextManager';

jest.mock('../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function createMockDeps(): ContextManagerDeps {
  return {
    constitutionalBuilder: {
      buildConstitutionPrompt: jest.fn().mockResolvedValue('宪法 prompt'),
    },
    memoryInjector: {
      autoRetrieveMemories: jest.fn().mockResolvedValue([]),
    },
    dynamicContext: {
      getDynamicContext: jest.fn().mockReturnValue('动态上下文'),
    },
    historyProvider: {
      getRecentHistory: jest.fn().mockReturnValue([]),
      getAllHistory: jest.fn().mockReturnValue([]),
    },
  };
}

describe('ContextManager.fenceContext', () => {
  let manager: ContextManager;
  let deps: ContextManagerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    manager = new ContextManager(deps, 8000);
  });

  it('应返回指定范围内的消息', () => {
    const messages = [
      { role: 'system' as const, content: '系统' },
      { role: 'user' as const, content: '消息1' },
      { role: 'assistant' as const, content: '回复1' },
      { role: 'user' as const, content: '消息2' },
      { role: 'assistant' as const, content: '回复2' },
      { role: 'user' as const, content: '消息3' },
    ];
    const fenced = manager.fenceContext(messages, { from: 2, to: 4 });
    expect(fenced).toHaveLength(3);
    expect(fenced[0].content).toBe('系统');
    expect(fenced[1].content).toBe('消息2');
    expect(fenced[2].content).toBe('回复2');
  });

  it('应保留 system 消息（不受围栏限制）', () => {
    const messages = [
      { role: 'system' as const, content: '系统' },
      { role: 'user' as const, content: '消息1' },
      { role: 'assistant' as const, content: '回复1' },
      { role: 'user' as const, content: '消息2' },
    ];
    const fenced = manager.fenceContext(messages, { from: 2, to: 3 });
    expect(fenced[0].role).toBe('system');
    expect(fenced[0].content).toBe('系统');
  });

  it('应支持 maxTokens 限制', () => {
    const messages = [
      { role: 'system' as const, content: '系统' },
      {
        role: 'user' as const,
        content: '这是一条较长的消息内容，包含足够多的文字来消耗token预算',
      },
      {
        role: 'assistant' as const,
        content: '这是回复，同样包含足够多的文字来消耗token预算',
      },
      {
        role: 'user' as const,
        content: '另一条消息，包含足够多的文字来消耗token预算',
      },
    ];
    const fenced = manager.fenceContext(messages, { maxTokens: 5 });
    expect(fenced.length).toBeLessThan(messages.length);
  });

  it('应支持 fromEnd 偏移（从末尾往前取）', () => {
    const messages = [
      { role: 'system' as const, content: '系统' },
      { role: 'user' as const, content: '消息1' },
      { role: 'assistant' as const, content: '回复1' },
      { role: 'user' as const, content: '消息2' },
      { role: 'assistant' as const, content: '回复2' },
    ];
    const fenced = manager.fenceContext(messages, { fromEnd: 2 });
    expect(fenced).toHaveLength(3);
    expect(fenced[0].content).toBe('系统');
    expect(fenced[1].content).toBe('消息2');
    expect(fenced[2].content).toBe('回复2');
  });

  it('应处理空消息数组', () => {
    const fenced = manager.fenceContext([], { from: 0, to: 5 });
    expect(fenced).toHaveLength(0);
  });

  it('应处理越界索引（自动裁剪到有效范围）', () => {
    const messages = [
      { role: 'user' as const, content: '消息1' },
      { role: 'assistant' as const, content: '回复1' },
    ];
    const fenced = manager.fenceContext(messages, { from: 0, to: 100 });
    expect(fenced).toHaveLength(2);
  });

  it('应同时支持 fromEnd + maxTokens', () => {
    const messages = [
      { role: 'system' as const, content: '系统' },
      ...Array(10)
        .fill(null)
        .flatMap((_, i) => [
          { role: 'user' as const, content: `用户消息${i}` },
          { role: 'assistant' as const, content: `助手回复${i}` },
        ]),
    ];
    const fenced = manager.fenceContext(messages, {
      fromEnd: 4,
      maxTokens: 30,
    });
    expect(fenced.length).toBeLessThanOrEqual(messages.length);
    expect(fenced[0].role).toBe('system');
  });
});

describe('NFS pragma 降级', () => {
  it('detectNfsEnvironment 应在非 NFS 环境返回 false', () => {
    const {
      detectNfsEnvironment,
    } = require('../../src/persistence/nfs-detect');
    expect(detectNfsEnvironment()).toBe(false);
  });

  it('resolveJournalMode 在非 NFS 环境应返回 wal', () => {
    const { resolveJournalMode } = require('../../src/persistence/nfs-detect');
    expect(resolveJournalMode()).toBe('wal');
  });
});
