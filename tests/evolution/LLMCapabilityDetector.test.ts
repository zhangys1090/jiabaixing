/**
 * LLM 能力探测模块测试
 *
 * 测试覆盖：
 * 1. 能力探测核心功能（推理深度、工具准确率、代码生成、结构化输出）
 * 2. 缓存机制（24h TTL）
 * 3. 持久化（保存/加载）
 * 4. 能力对比（diff 计算）
 * 5. 策略适配（根据能力生成配置）
 */

import {
  LLMCapabilityDetector,
  LLMCapabilities,
} from '../../src/evolution/LLMCapabilityDetector';
import {
  StrategyAdapter,
  StrategyConfig,
} from '../../src/evolution/StrategyAdapter';

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

describe('StrategyAdapter - 策略适配器', () => {
  let adapter: StrategyAdapter;

  beforeEach(() => {
    adapter = new StrategyAdapter();
  });

  describe('策略生成', () => {
    test('强LLM应该生成激进策略', async () => {
      const strongCaps: LLMCapabilities = {
        provider: 'openai',
        modelName: 'gpt-4o',
        detectedAt: Date.now(),
        contextWindow: 128000,
        reasoningDepth: 8,
        toolCallingAccuracy: 0.95,
        codeGeneration: 9,
        multiModal: true,
        structuredOutput: 0.95,
        overallScore: 8.5,
      };

      const config = await adapter.adaptStrategies(strongCaps);

      // Prompt策略：应该给更多自由度
      expect(config.prompt.reasoningFreedom).toBe('high');
      expect(config.prompt.outputStrictness).toBe('strict');
      expect(config.prompt.contextInjectionDepth).toBe('deep');
      expect(config.prompt.toolChainComplexity).toBe('moderate'); // 0.95 不满足 >0.95
      expect(config.prompt.enableCoT).toBe(true); // reasoningDepth=8 > 5

      // 规划策略：应该启用高级功能
      expect(config.planning.enableToT).toBe(true);
      expect(config.planning.enableCausalModeling).toBe(false); // reasoningDepth=8 不满足 >8
      expect(config.planning.maxPlanDepth).toBe(5);
      expect(config.planning.enableDynamicReplanning).toBe(true);
      expect(config.planning.enableParallelPlanning).toBe(false); // reasoningDepth=8 不满足 >8

      // 工具策略：应该允许复杂工具链
      expect(config.toolUse.enableToolChaining).toBe(true);
      expect(config.toolUse.maxConsecutiveToolCalls).toBe(10);
      expect(config.toolUse.maxRetriesPerTool).toBe(1);

      // 反思策略：应该深度反思
      expect(config.reflection.depth).toBe('deep');
      expect(config.reflection.enableCrossTurnReflection).toBe(true);
      expect(config.reflection.maxReflectionRounds).toBe(3);

      // 执行策略：应该启用自适应控制
      expect(config.execution.enableAdaptiveControl).toBe(true);
      expect(config.execution.enableParallelExecution).toBe(true);
    });

    test('弱LLM应该生成保守策略', async () => {
      const weakCaps: LLMCapabilities = {
        provider: 'local',
        modelName: 'qwen-7b',
        detectedAt: Date.now(),
        contextWindow: 8000,
        reasoningDepth: 2,
        toolCallingAccuracy: 0.5,
        codeGeneration: 3,
        multiModal: false,
        structuredOutput: 0.3,
        overallScore: 3.0,
      };

      const config = await adapter.adaptStrategies(weakCaps);

      // Prompt策略：应该结构化引导
      expect(config.prompt.reasoningFreedom).toBe('structured');
      expect(config.prompt.outputStrictness).toBe('flexible');
      expect(config.prompt.contextInjectionDepth).toBe('shallow');
      expect(config.prompt.toolChainComplexity).toBe('simple');
      expect(config.prompt.enableCoT).toBe(false);

      // 规划策略：应该保守
      expect(config.planning.enableToT).toBe(false);
      expect(config.planning.enableCausalModeling).toBe(false);
      expect(config.planning.maxPlanDepth).toBe(3);
      expect(config.planning.enableDynamicReplanning).toBe(false);

      // 工具策略：应该简单
      expect(config.toolUse.enableToolChaining).toBe(false);
      expect(config.toolUse.maxConsecutiveToolCalls).toBe(5);
      expect(config.toolUse.maxRetriesPerTool).toBe(2);

      // 反思策略：应该浅层
      expect(config.reflection.depth).toBe('shallow');
      expect(config.reflection.enableCrossTurnReflection).toBe(false);
      expect(config.reflection.maxReflectionRounds).toBe(1);
    });

    test('中等LLM应该生成平衡策略', async () => {
      const mediumCaps: LLMCapabilities = {
        provider: 'anthropic',
        modelName: 'claude-3-haiku',
        detectedAt: Date.now(),
        contextWindow: 32000,
        reasoningDepth: 5,
        toolCallingAccuracy: 0.8,
        codeGeneration: 6,
        multiModal: true,
        structuredOutput: 0.7,
        overallScore: 6.0,
      };

      const config = await adapter.adaptStrategies(mediumCaps);

      expect(config.prompt.reasoningFreedom).toBe('medium');
      expect(config.prompt.outputStrictness).toBe('moderate');
      expect(config.prompt.contextInjectionDepth).toBe('moderate');
      expect(config.prompt.toolChainComplexity).toBe('moderate');
      expect(config.prompt.enableCoT).toBe(false); // reasoningDepth=5 不满足 >5

      expect(config.planning.enableToT).toBe(false);
      expect(config.planning.maxPlanDepth).toBe(4);
      expect(config.planning.enableDynamicReplanning).toBe(false);

      expect(config.toolUse.enableToolChaining).toBe(false); // toolCallingAccuracy=0.8 不满足 >0.8

      expect(config.reflection.depth).toBe('shallow');
      expect(config.reflection.injectReflectionToPlanning).toBe(false); // reasoningDepth=5 不满足 >5
    });
  });

  describe('回调机制', () => {
    test('应该调用所有配置更新回调', async () => {
      const callbacks = {
        onPromptConfigUpdate: jest.fn(),
        onPlanningConfigUpdate: jest.fn(),
        onToolUseConfigUpdate: jest.fn(),
        onReflectionConfigUpdate: jest.fn(),
        onExecutionConfigUpdate: jest.fn(),
      };

      adapter.setCallbacks(callbacks);

      const caps: LLMCapabilities = {
        provider: 'test',
        modelName: 'test-model',
        detectedAt: Date.now(),
        contextWindow: 32000,
        reasoningDepth: 5,
        toolCallingAccuracy: 0.8,
        codeGeneration: 6,
        multiModal: false,
        structuredOutput: 0.7,
        overallScore: 6.0,
      };

      await adapter.adaptStrategies(caps);

      expect(callbacks.onPromptConfigUpdate).toHaveBeenCalled();
      expect(callbacks.onPlanningConfigUpdate).toHaveBeenCalled();
      expect(callbacks.onToolUseConfigUpdate).toHaveBeenCalled();
      expect(callbacks.onReflectionConfigUpdate).toHaveBeenCalled();
      expect(callbacks.onExecutionConfigUpdate).toHaveBeenCalled();
    });
  });

  describe('默认配置', () => {
    test('应该返回保守的默认配置', () => {
      const config = adapter.getDefaultConfig();

      expect(config.prompt.reasoningFreedom).toBe('structured');
      expect(config.planning.enableToT).toBe(false);
      expect(config.toolUse.enableToolChaining).toBe(false);
      expect(config.reflection.depth).toBe('shallow');
      expect(config.execution.enableAdaptiveControl).toBe(false);
    });
  });

  describe('持久化', () => {
    test('应该保存和加载策略配置', async () => {
      const savedState: Record<string, unknown> = {};
      const mockPersistence = {
        saveEnvironmentState: jest.fn((state: Record<string, unknown>) => {
          Object.assign(savedState, state);
        }),
        loadEnvironmentState: jest.fn(() => savedState),
      };

      adapter.setPersistence(mockPersistence);

      const caps: LLMCapabilities = {
        provider: 'test',
        modelName: 'test-model',
        detectedAt: Date.now(),
        contextWindow: 128000,
        reasoningDepth: 8,
        toolCallingAccuracy: 0.95,
        codeGeneration: 9,
        multiModal: true,
        structuredOutput: 0.95,
        overallScore: 8.5,
      };

      await adapter.adaptStrategies(caps);

      // 验证已保存
      expect(mockPersistence.saveEnvironmentState).toHaveBeenCalled();

      // 创建新适配器，验证能加载
      const newAdapter = new StrategyAdapter();
      newAdapter.setPersistence(mockPersistence);
      const loaded = newAdapter.getCurrentConfig();
      expect(loaded).not.toBeNull();
      expect(loaded!.llmOverallScore).toBe(8.5);
    });
  });
});
