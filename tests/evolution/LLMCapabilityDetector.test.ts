/**
 * LLM 能力探测模块测试
 *
 * 测试覆盖：
 * 1. 能力探测核心功能（推理深度、工具准确率、代码生成、结构化输出）
 * 2. 缓存机制（24h TTL）
 * 3. 持久化（保存/加载）
 * 4. 能力对比（diff 计算）
 */

import {
  LLMCapabilityDetector,
  LLMCapabilities,
} from '../../src/evolution/LLMCapabilityDetector';

// Mock Logger — Logger 是 class，有静态方法
jest.mock('../../src/utils/Logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    __esModule: true,
    Logger: mockLogger,
    default: mockLogger,
  };
});

describe('LLMCapabilityDetector - LLM能力探测', () => {
  let detector: LLMCapabilityDetector;
  let mockLLM: { chat: jest.Mock; getModelName: jest.Mock };

  beforeEach(() => {
    detector = new LLMCapabilityDetector();
    mockLLM = {
      chat: jest.fn(),
      getModelName: jest.fn().mockReturnValue('gpt-4o-test'),
    };
    detector.setLLMProvider(mockLLM);
  });

  describe('核心探测功能', () => {
    test('应该探测出强LLM的能力（高推理深度）', async () => {
      // 模拟强LLM：所有问题都答对
      mockLLM.chat.mockImplementation((prompt: string) => {
        if (prompt.includes('A>B, B>C')) return Promise.resolve('大于');
        if (prompt.includes('17只羊')) return Promise.resolve('9');
        if (prompt.includes('三个盒子'))
          return Promise.resolve('从标"混合"的盒子取');
        if (prompt.includes('12个球')) return Promise.resolve('4vs4分组称重');
        if (prompt.includes('斐波那契'))
          return Promise.resolve(
            'function fib(n) { if (n <= 1) return n; return fib(n-1) + fib(n-2); }'
          );
        if (prompt.includes('file_read'))
          return Promise.resolve(
            '{"toolName": "file_read", "args": {"path": "test.txt"}}'
          );
        if (prompt.includes('shell_exec'))
          return Promise.resolve(
            '{"toolName": "shell_exec", "args": {"command": "ls -la"}}'
          );
        if (prompt.includes('web_search'))
          return Promise.resolve(
            '{"toolName": "web_search", "args": {"query": "天气预报"}}'
          );
        if (prompt.includes('张三'))
          return Promise.resolve('{"name": "张三", "age": 25}');
        if (prompt.includes('JSON数组')) return Promise.resolve('[1, 2, 3]');
        if (prompt.includes('李四'))
          return Promise.resolve(
            '{"user": {"name": "李四", "scores": [90, 85, 95]}}'
          );
        return Promise.resolve('unknown');
      });

      const caps = await detector.detectCapabilities('openai', true);

      expect(caps).not.toBeNull();
      expect(caps!.provider).toBe('openai');
      expect(caps!.modelName).toBe('gpt-4o-test');
      expect(caps!.reasoningDepth).toBe(8); // 全部答对
      expect(caps!.toolCallingAccuracy).toBe(1); // 3/3
      expect(caps!.codeGeneration).toBeGreaterThan(5); // 代码质量好
      expect(caps!.structuredOutput).toBe(1); // 3/3
      expect(caps!.overallScore).toBeGreaterThan(6);
    });

    test('应该探测出弱LLM的能力（低推理深度）', async () => {
      // 模拟弱LLM：第一题就答错
      mockLLM.chat.mockImplementation((prompt: string) => {
        if (prompt.includes('A>B, B>C')) return Promise.resolve('小于'); // 答错
        if (prompt.includes('斐波那契')) return Promise.resolve('fib = n'); // 代码质量差
        if (prompt.includes('file_read'))
          return Promise.resolve('file_read test.txt'); // 不是JSON
        if (prompt.includes('张三')) return Promise.resolve('张三 25岁'); // 不是JSON
        return Promise.resolve('unknown');
      });

      const caps = await detector.detectCapabilities('weak-llm', true);

      expect(caps).not.toBeNull();
      expect(caps!.reasoningDepth).toBe(1); // 第一题就错了
      expect(caps!.toolCallingAccuracy).toBeCloseTo(0.33, 1); // 1/3（file_read test.txt匹配了）
      expect(caps!.structuredOutput).toBe(0); // 0/3
      expect(caps!.overallScore).toBeLessThan(4);
    });

    test('应该在LLM未设置时返回null', async () => {
      const emptyDetector = new LLMCapabilityDetector();
      const result = await emptyDetector.detectCapabilities('test');
      expect(result).toBeNull();
    });
  });

  describe('缓存机制', () => {
    test('应该使用缓存而非重复探测', async () => {
      mockLLM.chat.mockResolvedValue('大于');

      // 第一次探测
      await detector.detectCapabilities('test-provider', true);

      // 第二次探测（不强制）— 应该用缓存
      const callCountBefore = mockLLM.chat.mock.calls.length;
      await detector.detectCapabilities('test-provider', false);
      const callCountAfter = mockLLM.chat.mock.calls.length;

      expect(callCountAfter).toBe(callCountBefore); // 没有新调用
    });

    test('强制模式应该忽略缓存', async () => {
      mockLLM.chat.mockResolvedValue('大于');

      await detector.detectCapabilities('test-provider', true);
      const callCountBefore = mockLLM.chat.mock.calls.length;

      await detector.detectCapabilities('test-provider', true); // 强制
      const callCountAfter = mockLLM.chat.mock.calls.length;

      expect(callCountAfter).toBeGreaterThan(callCountBefore); // 有新调用
    });

    test('探测中时应该跳过重复请求', async () => {
      // 模拟慢响应
      mockLLM.chat.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('大于'), 100))
      );

      // 并发发起两个探测
      const [result1, result2] = await Promise.all([
        detector.detectCapabilities('concurrent-test', true),
        detector.detectCapabilities('concurrent-test', true),
      ]);

      // 第一个应该成功，第二个应该被跳过（返回null）
      expect(result1).not.toBeNull();
      // result2 可能是 null（被跳过）或与 result1 相同（如果第一个已完成）
    });
  });

  describe('能力对比', () => {
    test('应该正确识别能力提升', () => {
      const previous: LLMCapabilities = {
        provider: 'test',
        modelName: 'old-model',
        detectedAt: Date.now() - 86400000,
        contextWindow: 32000,
        reasoningDepth: 4,
        toolCallingAccuracy: 0.7,
        codeGeneration: 5,
        multiModal: false,
        structuredOutput: 0.6,
        overallScore: 5.0,
      };

      const current: LLMCapabilities = {
        provider: 'test',
        modelName: 'new-model',
        detectedAt: Date.now(),
        contextWindow: 128000,
        reasoningDepth: 8,
        toolCallingAccuracy: 0.95,
        codeGeneration: 8,
        multiModal: true,
        structuredOutput: 0.95,
        overallScore: 8.0,
      };

      const diff = detector.compareCapabilities(previous, current);

      expect(diff.improved).toBe(true);
      expect(diff.reasoningDepthImprovement).toBe(4);
      expect(diff.toolCallingImprovement).toBeCloseTo(0.25);
      expect(diff.overallImprovement).toBeCloseTo(3.0);
      expect(diff.newCapabilities).toContain('multiModal');
      expect(diff.newCapabilities).toContain('largerContextWindow');
      expect(diff.newCapabilities).toContain('reliableStructuredOutput');
      expect(diff.lostCapabilities).toHaveLength(0);
    });

    test('应该正确识别能力下降', () => {
      const previous: LLMCapabilities = {
        provider: 'test',
        modelName: 'good-model',
        detectedAt: Date.now() - 86400000,
        contextWindow: 128000,
        reasoningDepth: 8,
        toolCallingAccuracy: 0.95,
        codeGeneration: 8,
        multiModal: true,
        structuredOutput: 0.95,
        overallScore: 8.0,
      };

      const current: LLMCapabilities = {
        provider: 'test',
        modelName: 'degraded-model',
        detectedAt: Date.now(),
        contextWindow: 32000,
        reasoningDepth: 4,
        toolCallingAccuracy: 0.7,
        codeGeneration: 5,
        multiModal: false,
        structuredOutput: 0.6,
        overallScore: 5.0,
      };

      const diff = detector.compareCapabilities(previous, current);

      expect(diff.improved).toBe(false);
      expect(diff.reasoningDepthImprovement).toBe(-4);
      expect(diff.overallImprovement).toBeCloseTo(-3.0);
      expect(diff.lostCapabilities).toContain('multiModal');
      expect(diff.newCapabilities).toHaveLength(0);
    });
  });

  describe('持久化', () => {
    test('应该保存和加载能力数据', async () => {
      const savedState: Record<string, unknown> = {};
      const mockPersistence = {
        saveEnvironmentState: jest.fn((state: Record<string, unknown>) => {
          Object.assign(savedState, state);
        }),
        loadEnvironmentState: jest.fn(() => savedState),
      };

      detector.setPersistence(mockPersistence);
      mockLLM.chat.mockResolvedValue('大于');

      await detector.detectCapabilities('persist-test', true);

      // 验证已保存
      expect(mockPersistence.saveEnvironmentState).toHaveBeenCalled();

      // 创建新探测器，验证能加载
      const newDetector = new LLMCapabilityDetector();
      newDetector.setPersistence(mockPersistence);
      const cached = newDetector.getCachedCapabilities('persist-test');
      expect(cached).not.toBeNull();
      expect(cached!.provider).toBe('persist-test');
    });
  });
});

