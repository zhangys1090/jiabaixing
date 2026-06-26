import { ContextManager } from '../../../src/harness/context/ContextManager';
import type { ChatMessage } from '../../../src/harness/types';

describe('上下文管理 — 主动检索+注意力聚焦', () => {
  it('应基于当前任务主动检索相关上下文', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 8000 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages: ChatMessage[] = [
      { role: 'user', content: '部署应用到生产环境' },
      { role: 'assistant', content: '开始部署流程...' },
      { role: 'user', content: '检查端口占用情况' },
      { role: 'assistant', content: '端口8080被占用' },
      { role: 'user', content: '如何解决端口冲突？' },
    ];

    const retrieved = cm['activelyRetrieveContext'](messages, '解决端口冲突');

    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.some((m: any) => m.content.includes('端口'))).toBe(true);
  });

  it('应计算消息的注意力权重', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 8000 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages: ChatMessage[] = [
      { role: 'user', content: '部署应用' },
      { role: 'assistant', content: '端口8080被占用，需要释放' },
      { role: 'user', content: '好的' },
      { role: 'assistant', content: '已释放端口，部署成功' },
    ];

    const weights = cm['calculateAttentionWeights'](messages, '端口冲突');

    expect(weights[1]).toBeGreaterThan(weights[2]);
    expect(weights[3]).toBeGreaterThan(weights[2]);
  });

  it('应在token预算内聚焦高权重消息', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 100 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages: ChatMessage[] = [
      { role: 'user', content: '部署应用' },
      {
        role: 'assistant',
        content: '端口8080被占用，需要释放端口才能继续部署',
      },
      { role: 'user', content: '好的' },
      { role: 'assistant', content: '已释放端口，部署成功完成' },
    ];

    const focused = cm['focusByAttention'](messages, '端口冲突', 100);

    expect(focused.length).toBeLessThanOrEqual(messages.length);
    expect(focused.some((m: any) => m.content.includes('端口'))).toBe(true);
  });

  it('应在无相关上下文时返回空数组', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 8000 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages: ChatMessage[] = [
      { role: 'user', content: '今天天气如何' },
      { role: 'assistant', content: '天气晴朗' },
    ];

    const retrieved = cm['activelyRetrieveContext'](messages, '部署应用');
    expect(retrieved.length).toBe(0);
  });
});
