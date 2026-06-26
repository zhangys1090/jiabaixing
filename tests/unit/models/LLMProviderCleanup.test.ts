import { LLMProvider } from '../../../src/models/LLMProvider';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock OpenAICompatibleModel
jest.mock('../../../src/models/OpenAICompatibleModel', () => ({
  OpenAICompatibleModel: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    generate: jest.fn().mockResolvedValue({ text: 'mock response' }),
    isAvailable: jest.fn().mockReturnValue(true),
  })),
}));

describe('LLMProvider 清理验证', () => {
  let provider: LLMProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LLM_MODEL = 'deepseek-chat';
    provider = new LLMProvider();
  });

  describe('门面委托方法仍然可用', () => {
    it('chat 方法应该存在且可调用', () => {
      expect(typeof provider.chat).toBe('function');
    });

    it('chatWithTools 方法应该存在且可调用', () => {
      expect(typeof provider.chatWithTools).toBe('function');
    });

    it('analyzeCode 方法应该存在且可调用', () => {
      expect(typeof provider.analyzeCode).toBe('function');
    });

    it('multimodalChat 方法应该存在且可调用', () => {
      expect(typeof provider.multimodalChat).toBe('function');
    });

    it('devGenerateCode 方法应该存在且可调用', () => {
      expect(typeof provider.devGenerateCode).toBe('function');
    });
  });

  describe('死代码已移除', () => {
    it('executeWithRetry 不应作为 LLMProvider 的方法存在', () => {
      // executeWithRetry 是私有方法，已移除
      // 验证 LLMProvider 实例没有该属性（通过原型链检查）
      const proto = Object.getPrototypeOf(provider);
      expect(proto.hasOwnProperty('executeWithRetry')).toBe(false);
    });
  });

  describe('子 Provider 仍然被持有', () => {
    it('应该持有 chatProvider 实例', () => {
      expect(
        (provider as unknown as { chatProvider: unknown }).chatProvider
      ).toBeDefined();
    });

    it('应该持有 codeProvider 实例', () => {
      expect(
        (provider as unknown as { codeProvider: unknown }).codeProvider
      ).toBeDefined();
    });

    it('应该持有 multimodalProvider 实例', () => {
      expect(
        (provider as unknown as { multimodalProvider: unknown })
          .multimodalProvider
      ).toBeDefined();
    });
  });
});
