/**
 * MultimodalProvider 单元测试
 *
 * 验证从 LLMProvider 拆分出的多模态服务：
 *   - multimodalChat: 多模态对话（含图片）
 *   - multimodalCodeAnalysis: 多模态代码分析（图片+代码）
 */
import { MultimodalProvider } from '../../../src/models/MultimodalProvider';
import type { Model, ModelInput, ModelOutput } from '../../../src/core/ModelInterface';

// mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// mock PreferenceInjector - 直接返回原 prompt，避免单例副作用
jest.mock('../../../src/memory/PreferenceInjector', () => ({
  injectPreferences: jest.fn((prompt: string) => prompt),
}));

// mock prompt-templates - 返回固定模板字符串
jest.mock('../../../src/llm/prompt-templates', () => ({
  getPromptTemplate: jest.fn((id: string) => `mock-template:${id}`),
}));

/** 构造 mock Model */
function createMockModel(responseText = 'mock-response'): {
  model: Model;
  generate: jest.Mock;
} {
  const generate = jest.fn(async (input: ModelInput): Promise<ModelOutput> => {
    return { text: responseText, modelName: 'mock-model' };
  });

  const model: Model = {
    initialize: jest.fn().mockResolvedValue(undefined),
    generate,
    stream: jest.fn() as unknown as Model['stream'],
    getModelInfo: jest.fn().mockResolvedValue({ name: 'mock-model' }),
    shutdown: jest.fn().mockResolvedValue(undefined),
    getName: jest.fn().mockReturnValue('mock-model'),
  };

  return { model, generate };
}

describe('MultimodalProvider', () => {
  let provider: MultimodalProvider;
  let mockModel: Model;
  let generate: jest.Mock;

  beforeEach(() => {
    const mock = createMockModel();
    mockModel = mock.model;
    generate = mock.generate;
    provider = new MultimodalProvider(mockModel, 'test-model');
  });

  describe('multimodalChat', () => {
    it('应该调用 model.generate 处理多模态对话', async () => {
      const message = '描述这张图片';
      const images = ['base64-image-data'];

      const result = await provider.multimodalChat(message, images);

      expect(result).toBe('mock-response');
      expect(generate).toHaveBeenCalledTimes(1);

      const callArg = generate.mock.calls[0][0] as ModelInput;
      expect(callArg.prompt).toContain(message);
      expect(callArg.images).toEqual(images);
      expect(callArg.systemPrompt).toContain('mock-template:multimodalChat');
      expect(callArg.temperature).toBe(0.8);
      expect(callArg.maxTokens).toBe(1024);
    });

    it('应该使用空历史作为默认值', async () => {
      const message = '你好';

      await provider.multimodalChat(message);

      expect(generate).toHaveBeenCalledTimes(1);
      const callArg = generate.mock.calls[0][0] as ModelInput;
      // 没有历史记录时，prompt 中不应包含 "role:" 前缀的历史拼接
      expect(callArg.prompt).toContain(message);
      expect(callArg.prompt).not.toMatch(/^role:/);
    });

    it('没有图片时不应传入 images 字段', async () => {
      await provider.multimodalChat('纯文本消息');

      const callArg = generate.mock.calls[0][0] as ModelInput;
      expect(callArg.images).toBeUndefined();
    });

    it('模型返回 error 时应抛出错误', async () => {
      // 使用 mockResolvedValue（持久）确保重试也返回同一错误
      generate.mockResolvedValue({
        text: '',
        error: '模型内部错误',
      } as ModelOutput);

      await expect(provider.multimodalChat('测试')).rejects.toThrow(
        '模型内部错误'
      );
    });

    it('模型未返回内容时应抛出错误', async () => {
      generate.mockResolvedValue({
        text: '',
      } as ModelOutput);

      await expect(provider.multimodalChat('测试')).rejects.toThrow(
        '模型未返回内容'
      );
    });
  });

  describe('multimodalCodeAnalysis', () => {
    it('应该分析带图片的代码问题', async () => {
      const userQuery = '这段代码有什么问题？';
      const images = ['base64-screenshot'];

      const result = await provider.multimodalCodeAnalysis(
        userQuery,
        images,
        'src/example.ts'
      );

      expect(result).toBe('mock-response');
      expect(generate).toHaveBeenCalledTimes(1);

      const callArg = generate.mock.calls[0][0] as ModelInput;
      expect(callArg.prompt).toContain(userQuery);
      expect(callArg.prompt).toContain('src/example.ts');
      expect(callArg.images).toEqual(images);
      expect(callArg.systemPrompt).toContain(
        'mock-template:multimodalCodeAnalysis'
      );
      expect(callArg.temperature).toBe(0.7);
      expect(callArg.maxTokens).toBe(2048);
    });

    it('在没有文件路径时使用简化 prompt', async () => {
      const userQuery = '分析这个界面';

      await provider.multimodalCodeAnalysis(userQuery, ['img-data']);

      const callArg = generate.mock.calls[0][0] as ModelInput;
      expect(callArg.prompt).toContain(userQuery);
      // 简化 prompt 不应包含"相关文件"
      expect(callArg.prompt).not.toContain('相关文件');
      expect(callArg.prompt).toContain('请分析图片并给出建议');
    });

    it('有文件路径时 prompt 应包含相关文件', async () => {
      await provider.multimodalCodeAnalysis(
        '问题',
        ['img'],
        'src/foo.ts'
      );

      const callArg = generate.mock.calls[0][0] as ModelInput;
      expect(callArg.prompt).toContain('相关文件：src/foo.ts');
    });

    it('模型返回 error 时应抛出错误', async () => {
      generate.mockResolvedValue({
        text: '',
        error: '分析失败',
      } as ModelOutput);

      await expect(
        provider.multimodalCodeAnalysis('问题', ['img'])
      ).rejects.toThrow('分析失败');
    });

    it('模型未返回内容时应抛出错误', async () => {
      generate.mockResolvedValue({
        text: '',
      } as ModelOutput);

      await expect(
        provider.multimodalCodeAnalysis('问题', ['img'])
      ).rejects.toThrow('模型未返回内容');
    });
  });
});
