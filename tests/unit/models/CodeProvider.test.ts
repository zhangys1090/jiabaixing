/**
 * CodeProvider 单元测试
 * 测试代码分析与生成服务：analyzeCode/devGenerateCode/generateModificationPlan/generateModifiedFileContent
 */
import { CodeProvider } from '../../../src/models/CodeProvider';

// Mock Model — 返回标准 ModelOutput 对象（与真实 Model 接口一致）
const mockGenerate = jest.fn().mockResolvedValue({
  text: 'mock code response',
  tokens: { prompt: 10, completion: 5, total: 15 },
});
const mockModel = {
  generate: mockGenerate,
  getName: jest.fn().mockReturnValue('mock-model'),
  initialize: jest.fn(),
  stream: jest.fn(),
  getModelInfo: jest.fn(),
  shutdown: jest.fn(),
} as any;

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock PreferenceInjector — 透传 prompt，便于断言
jest.mock('../../../src/memory/PreferenceInjector', () => ({
  injectPreferences: jest.fn((prompt: string) => prompt),
}));

// Mock prompt-templates
jest.mock('../../../src/llm/prompt-templates', () => ({
  getPromptTemplate: jest.fn().mockReturnValue('mock code system prompt'),
}));

describe('CodeProvider', () => {
  let provider: CodeProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    // 恢复默认成功响应
    mockGenerate.mockResolvedValue({ text: 'mock code response' });
    provider = new CodeProvider(mockModel, 'mock-model');
  });

  describe('analyzeCode', () => {
    it('应该调用 model.generate 分析代码', async () => {
      const result = await provider.analyzeCode(
        'test.ts',
        'const x = 1;',
        '这个变量是什么？'
      );
      expect(result).toBe('mock code response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('这个变量是什么？'),
          systemPrompt: 'mock code system prompt',
          temperature: 0.7,
          maxTokens: 2048,
        })
      );
    });

    it('应该在 prompt 中包含文件路径和内容', async () => {
      await provider.analyzeCode('src/test.ts', 'console.log(1)', '分析');
      const callArgs = mockGenerate.mock.calls[0][0];
      expect(callArgs.prompt).toContain('src/test.ts');
      expect(callArgs.prompt).toContain('console.log(1)');
    });
  });

  describe('devGenerateCode', () => {
    it('应该生成代码', async () => {
      const result = await provider.devGenerateCode(
        '创建一个函数',
        'src/new.ts'
      );
      expect(result).toBe('mock code response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('创建一个函数'),
          temperature: 0.3,
          maxTokens: 4096,
        })
      );
    });

    it('应该在 prompt 中包含现有文件内容', async () => {
      await provider.devGenerateCode(
        '修改函数',
        'src/exist.ts',
        'existing code'
      );
      const callArgs = mockGenerate.mock.calls[0][0];
      expect(callArgs.prompt).toContain('existing code');
    });
  });

  describe('generateModificationPlan', () => {
    it('应该生成修改计划', async () => {
      const result = await provider.generateModificationPlan(
        'test.ts',
        'const x = 1;',
        '修改为 const y = 2'
      );
      expect(result).toBe('mock code response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('修改为 const y = 2'),
          systemPrompt: 'mock code system prompt',
          temperature: 0.7,
          maxTokens: 2048,
        })
      );
    });
  });

  describe('generateModifiedFileContent', () => {
    it('应该生成修改后的文件内容', async () => {
      const result = await provider.generateModifiedFileContent(
        'test.ts',
        'old content',
        'add new function',
        true
      );
      expect(result).toBe('mock code response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('add new function'),
          temperature: 0.7,
          maxTokens: 4096,
        })
      );
    });
  });
});
