import {
  createDelegateTaskExecutor,
  DELEGATE_TASK_DEF,
} from '../../../src/harness/tools/system/delegate_task';

describe('delegate_task 工具', () => {
  const mockToolRegistry = {
    toOpenAITools: jest.fn().mockReturnValue([
      { function: { name: 'file_read', description: '读取文件' } },
      { function: { name: 'code_analyze', description: '分析代码' } },
    ]),
    execute: jest.fn().mockResolvedValue({ success: true, output: '文件内容', duration: 100 }),
  };

  it('应该有正确的工具定义', () => {
    expect(DELEGATE_TASK_DEF.name).toBe('delegate_task');
    expect(DELEGATE_TASK_DEF.requiredParams).toContain('goal');
    expect(DELEGATE_TASK_DEF.timeout).toBe(120000);
    expect(DELEGATE_TASK_DEF.riskLevel).toBe('medium');
  });

  it('应该拒绝空目标', async () => {
    const executor = createDelegateTaskExecutor({
      llm: { chat: jest.fn() },
      toolRegistry: mockToolRegistry as never,
    });
    const result = await executor({ goal: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('目标描述不能为空');
  });

  it('应该执行子任务并返回结果', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue('这是一个测试结果'),
    };
    const executor = createDelegateTaskExecutor({
      llm: mockLLM,
      toolRegistry: mockToolRegistry as never,
    });
    const result = await executor({ goal: '分析项目结构' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('子 Agent 完成');
    expect(result.output).toContain('分析项目结构');
    expect(result.metadata?.goal).toBe('分析项目结构');
    expect(mockLLM.chat).toHaveBeenCalled();
  });

  it('应该支持上下文传递', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue('完成'),
    };
    const executor = createDelegateTaskExecutor({
      llm: mockLLM,
      toolRegistry: mockToolRegistry as never,
    });
    await executor({ goal: '审查文件', context: '文件路径: src/core/test.ts' });

    const callArgs = mockLLM.chat.mock.calls[0];
    expect(callArgs[0]).toContain('审查文件');
    expect(callArgs[0]).toContain('src/core/test.ts');
  });

  it('应该支持工具集限制', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue('完成'),
    };
    const executor = createDelegateTaskExecutor({
      llm: mockLLM,
      toolRegistry: mockToolRegistry as never,
    });
    await executor({ goal: '读取文件', tools: ['file_read'] });

    // 验证 toOpenAITools 被调用
    expect(mockToolRegistry.toOpenAITools).toHaveBeenCalled();
  });

  it('应该处理 LLM 调用失败', async () => {
    const mockLLM = {
      chat: jest.fn().mockRejectedValue(new Error('API 超时')),
    };
    const executor = createDelegateTaskExecutor({
      llm: mockLLM,
      toolRegistry: mockToolRegistry as never,
    });
    const result = await executor({ goal: '测试任务' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('API 超时');
  });

  it('应该记录使用的工具', async () => {
    const mockLLM = {
      chat: jest.fn()
        .mockResolvedValueOnce('[file_read]\n{"path": "test.ts"}')
        .mockResolvedValueOnce('最终结果'),
    };
    const executor = createDelegateTaskExecutor({
      llm: mockLLM,
      toolRegistry: mockToolRegistry as never,
    });
    const result = await executor({ goal: '读取并分析文件' });

    expect(result.success).toBe(true);
    expect(result.metadata?.toolsUsed).toContain('file_read');
  });
});