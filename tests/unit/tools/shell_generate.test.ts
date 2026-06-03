import {
  createShellGenerateExecutor,
  SHELL_GENERATE_DEF,
} from '../../../src/harness/tools/system/shell_generate';

describe('shell_generate 工具', () => {
  it('应该有正确的工具定义', () => {
    expect(SHELL_GENERATE_DEF.name).toBe('shell_generate');
    expect(SHELL_GENERATE_DEF.requiredParams).toContain('intent');
    expect(SHELL_GENERATE_DEF.riskLevel).toBe('medium');
    expect(SHELL_GENERATE_DEF.timeout).toBe(30000);
  });

  it('应该拒绝空意图', async () => {
    const executor = createShellGenerateExecutor();
    const result = await executor({ intent: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('意图描述不能为空');
  });

  it('无 LLM 时应返回降级提示', async () => {
    const executor = createShellGenerateExecutor();
    const result = await executor({ intent: '查看端口占用' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('无 LLM 可用');
    expect(result.metadata?.fallback).toBe(true);
  });

  it('有 LLM 时应生成命令', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue(JSON.stringify({
        command: 'netstat -ano | findstr :8080',
        explanation: '查找占用 8080 端口的进程',
        risk_level: 'low',
        requires_confirm: false,
      })),
    };
    const executor = createShellGenerateExecutor({ llm: mockLLM });
    const result = await executor({ intent: '查看8080端口被谁占用' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('netstat');
    expect(result.output).toContain('8080');
    expect(result.metadata?.command).toContain('netstat');
    expect(mockLLM.chat).toHaveBeenCalled();
  });

  it('高风险命令应标记需要确认', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue(JSON.stringify({
        command: 'rm -rf /tmp/cache/*',
        explanation: '清理临时缓存',
        risk_level: 'high',
        requires_confirm: true,
      })),
    };
    const executor = createShellGenerateExecutor({ llm: mockLLM });
    const result = await executor({ intent: '清理缓存' });

    expect(result.success).toBe(true);
    expect(result.needsConfirmation).toBe(true);
    expect(result.metadata?.risk_level).toBe('high');
  });

  it('低风险命令不应标记需要确认', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue(JSON.stringify({
        command: 'ls -la',
        explanation: '列出当前目录文件',
        risk_level: 'low',
        requires_confirm: false,
      })),
    };
    const executor = createShellGenerateExecutor({ llm: mockLLM });
    const result = await executor({ intent: '看看当前目录有什么文件' });

    expect(result.success).toBe(true);
    expect(result.needsConfirmation).toBeFalsy();
  });

  it('LLM 返回无效 JSON 时应报错', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue('这不是JSON'),
    };
    const executor = createShellGenerateExecutor({ llm: mockLLM });
    const result = await executor({ intent: '测试' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM 返回格式异常');
  });

  it('应支持指定操作系统', async () => {
    const mockLLM = {
      chat: jest.fn().mockResolvedValue(JSON.stringify({
        command: 'ls -la',
        explanation: '列出文件',
        risk_level: 'low',
        requires_confirm: false,
      })),
    };
    const executor = createShellGenerateExecutor({ llm: mockLLM });
    await executor({ intent: '列出文件', os: 'linux' });

    const prompt = mockLLM.chat.mock.calls[0][0];
    expect(prompt).toContain('Linux');
  });
});
