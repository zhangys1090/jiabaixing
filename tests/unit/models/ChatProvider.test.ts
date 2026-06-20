/**
 * ChatProvider 单元测试
 * 测试从 LLMProvider 中提取的对话服务：chat / chatWithTools / executeWithRetry
 */
import { ChatProvider } from '../../../src/models/ChatProvider';
import { Model, ModelInput, ModelOutput } from '../../../src/core/ModelInterface';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock PreferenceInjector — 直接返回原 prompt，避免 PreferenceManager 副作用
jest.mock('../../../src/memory/PreferenceInjector', () => ({
  injectPreferences: jest.fn((prompt: string) => prompt),
}));

// Mock prompt-templates — 返回可识别的测试 prompt
jest.mock('../../../src/llm/prompt-templates', () => ({
  getPromptTemplate: jest.fn((id: string) => `test-prompt-${id}`),
}));

// Mock LLMResponseCache — 避免 Redis/性能监控副作用
jest.mock('../../../src/models/LLMResponseCache', () => ({
  LLMResponseCache: jest.fn().mockImplementation(() => ({
    generateKey: jest.fn(() => 'test-cache-key'),
    get: jest.fn(() => null),
    set: jest.fn(),
    clear: jest.fn(),
    destroy: jest.fn(),
  })),
}));

// Mock RequestQueue — 直接执行，跳过 setImmediate 调度
jest.mock('../../../src/models/RequestQueue', () => ({
  RequestQueue: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn(<T>(execute: () => Promise<T>): Promise<T> => execute()),
    getActiveCount: jest.fn(() => 0),
    getQueueLength: jest.fn(() => 0),
  })),
}));

/**
 * 创建 Mock Model 实例
 */
function createMockModel(
  generateImpl?: (input: ModelInput) => Promise<ModelOutput>
): jest.Mocked<Model> {
  return {
    initialize: jest.fn(),
    generate: jest.fn(
      generateImpl ||
        (async () => ({ text: 'test response' } as ModelOutput))
    ),
    stream: jest.fn(),
    getModelInfo: jest.fn(),
    shutdown: jest.fn(),
    getName: jest.fn(() => 'test-model'),
  } as unknown as jest.Mocked<Model>;
}

describe('ChatProvider', () => {
  let provider: ChatProvider;
  let mockModel: jest.Mocked<Model>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockModel = createMockModel();
    provider = new ChatProvider(mockModel, 'test-model');
  });

  describe('chat', () => {
    it('应该调用 model.generate 并返回响应', async () => {
      const result = await provider.chat('你好');
      expect(result).toBe('test response');
      expect(mockModel.generate).toHaveBeenCalledTimes(1);
    });

    it('应该使用默认 system prompt 当未提供时', async () => {
      await provider.chat('你好');
      const callArgs = (mockModel.generate as jest.Mock).mock
        .calls[0][0] as ModelInput;
      expect(callArgs.systemPrompt).toBe('test-prompt-chat');
    });

    it('应该使用自定义 system prompt 当提供时', async () => {
      await provider.chat('你好', [], 'custom-system-prompt');
      const callArgs = (mockModel.generate as jest.Mock).mock
        .calls[0][0] as ModelInput;
      expect(callArgs.systemPrompt).toBe('custom-system-prompt');
    });

    it('应该在连接错误时重试', async () => {
      const connectionError = new Error('ECONNREFUSED');
      mockModel = createMockModel();
      (mockModel.generate as jest.Mock)
        .mockRejectedValueOnce(connectionError)
        .mockResolvedValueOnce({ text: 'retried response' } as ModelOutput);
      provider = new ChatProvider(mockModel, 'test-model');

      const result = await provider.chat('你好');
      expect(result).toBe('retried response');
      expect(mockModel.generate).toHaveBeenCalledTimes(2);
    });

    it('应该在模型返回 error 时抛出异常', async () => {
      mockModel = createMockModel();
      (mockModel.generate as jest.Mock).mockResolvedValue({
        error: 'model error',
      } as ModelOutput);
      provider = new ChatProvider(mockModel, 'test-model');

      await expect(provider.chat('你好')).rejects.toThrow('model error');
    });
  });

  describe('chatWithTools', () => {
    it('应该返回带 toolCalls 的结果', async () => {
      const toolCalls = [
        {
          id: 'tc_1',
          type: 'function',
          function: { name: 'test_tool', arguments: '{}' },
        },
      ];

      mockModel = createMockModel(async () => ({
        text: 'tool response',
        toolCalls,
      } as ModelOutput));
      provider = new ChatProvider(mockModel, 'test-model');

      const result = await provider.chatWithTools(
        [{ role: 'user', content: '调用工具' }],
        [{ type: 'function', function: { name: 'test_tool' } }]
      );

      expect(result.content).toBe('tool response');
      expect(result.toolCalls).toEqual(toolCalls);
    });

    it('应该在无 toolCalls 时返回空 content', async () => {
      mockModel = createMockModel(async () => ({
        text: 'plain response',
      } as ModelOutput));
      provider = new ChatProvider(mockModel, 'test-model');

      const result = await provider.chatWithTools(
        [{ role: 'user', content: '你好' }],
        []
      );

      expect(result.content).toBe('plain response');
      expect(result.toolCalls).toBeUndefined();
    });

    it('应该规范化缺失的 toolCalls 字段', async () => {
      mockModel = createMockModel(async () => ({
        text: '',
        toolCalls: [
          {
            // 缺失 id 和 type
            function: { name: 'incomplete_tool' },
          } as unknown as ModelOutput['toolCalls'] extends Array<infer T>
            ? T
            : never,
        ],
      } as ModelOutput));
      provider = new ChatProvider(mockModel, 'test-model');

      const result = await provider.chatWithTools(
        [{ role: 'user', content: 'test' }],
        []
      );

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls![0].id).toBeDefined();
      expect(result.toolCalls![0].type).toBe('function');
      expect(result.toolCalls![0].function.name).toBe('incomplete_tool');
      expect(result.toolCalls![0].function.arguments).toBe('{}');
    });
  });

  describe('executeWithRetry', () => {
    it('应该在成功时直接返回结果', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      const result = await provider.executeWithRetry(operation, 'test-op');
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('应该在认证错误时不重试', async () => {
      const authError = new Error('401 Unauthorized');
      const operation = jest.fn().mockRejectedValue(authError);

      await expect(
        provider.executeWithRetry(operation, 'test-op')
      ).rejects.toThrow('401');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('应该在连接错误时重试', async () => {
      const connectionError = new Error('fetch failed');
      const operation = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(connectionError)
        .mockResolvedValueOnce('recovered');

      const result = await provider.executeWithRetry(operation, 'test-op');
      expect(result).toBe('recovered');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('应该在达到最大重试次数后抛出最后一次错误', async () => {
      const error = new Error('persistent failure');
      const operation = jest.fn().mockRejectedValue(error);

      await expect(
        provider.executeWithRetry(operation, 'test-op', 2)
      ).rejects.toThrow('persistent failure');
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('getModelName', () => {
    it('应该返回构造时传入的模型名称', () => {
      expect(provider.getModelName()).toBe('test-model');
    });
  });
});
