import {
  createWebFetchExecutor,
  WEB_FETCH_DEF,
} from '../../../src/harness/tools/network/web_fetch';
import {
  createImageGenerateExecutor,
  IMAGE_GENERATE_DEF,
} from '../../../src/harness/tools/network/image_generate';
import {
  createShellExecExecutor,
  SHELL_EXEC_DEF,
} from '../../../src/harness/tools/system/shell_exec';

describe('web_fetch 工具', () => {
  const executor = createWebFetchExecutor();

  it('应该有正确的工具定义', () => {
    expect(WEB_FETCH_DEF.name).toBe('web_fetch');
    expect(WEB_FETCH_DEF.requiredParams).toContain('url');
    expect(WEB_FETCH_DEF.timeout).toBe(30000);
  });

  it('应该拒绝非HTTP URL', async () => {
    const result = await executor({ url: 'ftp://example.com' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('http://');
  });

  it('应该拒绝空URL', async () => {
    const result = await executor({ url: '' });
    expect(result.success).toBe(false);
  });

  it('应该处理网络错误', async () => {
    const result = await executor({ url: 'https://nonexistent.invalid/page' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('失败');
  });

  it('应该支持自定义httpClient依赖注入', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue('<html><body><h1>Test</h1><p>Hello</p></body></html>'),
    };
    const execWithDeps = createWebFetchExecutor({ httpClient: mockClient });
    const result = await execWithDeps({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Test');
    expect(mockClient.get).toHaveBeenCalledWith('https://example.com');
  });

  it('应该正确转换HTML到Markdown', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue(
        '<html><body><h1>Title</h1><p>Paragraph</p><a href="http://link">Link</a></body></html>'
      ),
    };
    const execWithDeps = createWebFetchExecutor({ httpClient: mockClient });
    const result = await execWithDeps({ url: 'https://example.com', format: 'markdown' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('# Title');
    expect(result.output).toContain('[Link](http://link)');
  });

  it('应该支持text格式输出', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue('<html><body><h1>Title</h1></body></html>'),
    };
    const execWithDeps = createWebFetchExecutor({ httpClient: mockClient });
    const result = await execWithDeps({ url: 'https://example.com', format: 'text' });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('#');
  });

  it('应该支持html格式输出', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue('<html><body><h1>Title</h1></body></html>'),
    };
    const execWithDeps = createWebFetchExecutor({ httpClient: mockClient });
    const result = await execWithDeps({ url: 'https://example.com', format: 'html' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('<h1>');
  });

  it('应该截断超长内容', async () => {
    const longContent = '<html><body><p>' + 'A'.repeat(20000) + '</p></body></html>';
    const mockClient = {
      get: jest.fn().mockResolvedValue(longContent),
    };
    const execWithDeps = createWebFetchExecutor({ httpClient: mockClient });
    const result = await execWithDeps({ url: 'https://example.com', max_length: 100 });
    expect(result.success).toBe(true);
    expect((result.output as string).length).toBeLessThan(200);
    expect(result.output).toContain('截断');
  });

  it('应该去除script和style标签', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue(
        '<html><head><script>alert(1)</script><style>.x{}</style></head><body><p>Content</p></body></html>'
      ),
    };
    const execWithDeps = createWebFetchExecutor({ httpClient: mockClient });
    const result = await execWithDeps({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('alert');
    expect(result.output).not.toContain('.x{}');
    expect(result.output).toContain('Content');
  });
});

describe('image_generate 工具', () => {
  const executor = createImageGenerateExecutor();

  it('应该有正确的工具定义', () => {
    expect(IMAGE_GENERATE_DEF.name).toBe('image_generate');
    expect(IMAGE_GENERATE_DEF.requiredParams).toContain('prompt');
    expect(IMAGE_GENERATE_DEF.timeout).toBe(60000);
  });

  it('应该拒绝空prompt', async () => {
    const result = await executor({ prompt: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('不能为空');
  });

  it('应该支持自定义imageApiClient依赖注入', async () => {
    const mockClient = {
      generate: jest.fn().mockResolvedValue({
        url: 'https://cdn.example.com/img.png',
        base64: 'data:image/png;base64,abc',
      }),
    };
    const execWithDeps = createImageGenerateExecutor({ imageApiClient: mockClient });
    const result = await execWithDeps({ prompt: 'a cat', size: 'square' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('img.png');
    expect(mockClient.generate).toHaveBeenCalledWith('a cat', 'square');
  });

  it('应该将style追加到prompt', async () => {
    const mockClient = {
      generate: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/img.png' }),
    };
    const execWithDeps = createImageGenerateExecutor({ imageApiClient: mockClient });
    await execWithDeps({ prompt: 'a cat', style: 'watercolor' });
    expect(mockClient.generate).toHaveBeenCalledWith('a cat, watercolor style', 'square');
  });

  it('应该支持所有尺寸选项', async () => {
    const mockClient = {
      generate: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/img.png' }),
    };
    const execWithDeps = createImageGenerateExecutor({ imageApiClient: mockClient });
    const sizes = ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'];
    for (const size of sizes) {
      const result = await execWithDeps({ prompt: 'test', size });
      expect(result.success).toBe(true);
    }
  });
});

describe('shell_exec 工具', () => {
  const executor = createShellExecExecutor();

  it('应该有正确的工具定义', () => {
    expect(SHELL_EXEC_DEF.name).toBe('shell_exec');
    expect(SHELL_EXEC_DEF.requiredParams).toContain('command');
    expect(SHELL_EXEC_DEF.riskLevel).toBe('high');
  });

  it('应该拦截format命令', async () => {
    const result = await executor({ command: 'format C:' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('安全策略拦截');
  });

  it('应该拦截shutdown命令', async () => {
    const result = await executor({ command: 'shutdown /s /t 0' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('安全策略拦截');
  });

  it('应该拦截rm -rf /命令', async () => {
    const result = await executor({ command: 'rm -rf /' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('安全策略拦截');
  });

  it('应该拦截reg delete命令', async () => {
    const result = await executor({ command: 'reg delete HKLM\\Software\\Test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('安全策略拦截');
  });

  it('应该拦截diskpart命令', async () => {
    const result = await executor({ command: 'diskpart' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('安全策略拦截');
  });

  it('应该支持自定义shellRunner依赖注入', async () => {
    const mockRunner = jest.fn().mockResolvedValue({
      stdout: 'hello world',
      stderr: '',
      exitCode: 0,
    });
    const execWithDeps = createShellExecExecutor({ shellRunner: mockRunner });
    const result = await execWithDeps({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('shellRunner返回非零退出码应标记为失败', async () => {
    const mockRunner = jest.fn().mockResolvedValue({
      stdout: '',
      stderr: 'command not found',
      exitCode: 127,
    });
    const execWithDeps = createShellExecExecutor({ shellRunner: mockRunner });
    const result = await execWithDeps({ command: 'unknown_cmd' });
    expect(result.success).toBe(false);
  });

  it('应该允许安全的echo命令', async () => {
    const mockRunner = jest.fn().mockResolvedValue({
      stdout: 'test output',
      stderr: '',
      exitCode: 0,
    });
    const execWithDeps = createShellExecExecutor({ shellRunner: mockRunner });
    const result = await execWithDeps({ command: 'echo test' });
    expect(result.success).toBe(true);
  });

  it('应该支持自定义工作目录', async () => {
    const mockRunner = jest.fn().mockResolvedValue({
      stdout: 'C:\\Users',
      stderr: '',
      exitCode: 0,
    });
    const execWithDeps = createShellExecExecutor({ shellRunner: mockRunner });
    const result = await execWithDeps({ command: 'cd', cwd: 'C:\\Users' });
    expect(result.success).toBe(true);
    expect(mockRunner).toHaveBeenCalledWith('cd', expect.objectContaining({ cwd: 'C:\\Users' }));
  });

  it('应该支持自定义超时', async () => {
    const mockRunner = jest.fn().mockResolvedValue({
      stdout: 'done',
      stderr: '',
      exitCode: 0,
    });
    const execWithDeps = createShellExecExecutor({ shellRunner: mockRunner });
    await execWithDeps({ command: 'long_task', timeout: 60000 });
    expect(mockRunner).toHaveBeenCalledWith('long_task', expect.objectContaining({ timeout: 60000 }));
  });
});
