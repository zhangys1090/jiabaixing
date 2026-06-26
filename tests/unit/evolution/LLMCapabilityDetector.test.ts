/**
 * LLM 能力探测器测试
 *
 * 验证核心目标：
 *   - 探测推理深度、工具调用准确率、结构化输出等能力
 *   - 24h 缓存机制
 *   - force 强制重新探测
 *   - 能力差异对比
 *   - 持久化加载/保存
 *   - 无 LLM / 防重入等边界
 */

import type { LLMCapabilities } from '../../../src/evolution/LLMCapabilityDetector';
import { LLMCapabilityDetector } from '../../../src/evolution/LLMCapabilityDetector';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

/** 构造 mock LLM：根据 prompt 内容返回预设答案 */
function createMockLLM(opts: {
  reasoningPassUpTo?: number; // 通过到第几题（0=全错）
  toolCallingPass?: number; // 通过几个工具题
  structuredPass?: number; // 通过几个结构化题
  codeQuality?: 'good' | 'poor';
  modelName?: string;
}) {
  const {
    reasoningPassUpTo = 4,
    toolCallingPass = 3,
    structuredPass = 3,
    codeQuality = 'good',
    modelName = 'gpt-4o',
  } = opts;

  const chat = jest.fn(async (message: string): Promise<string> => {
    // 推理题
    if (message.includes('A>B, B>C')) {
      return reasoningPassUpTo >= 1 ? '大于' : '小于';
    }
    if (message.includes('17只羊')) {
      return reasoningPassUpTo >= 2 ? '9' : '8';
    }
    if (message.includes('三个盒子')) {
      return reasoningPassUpTo >= 3 ? '从标"混合"的盒子取' : '不知道';
    }
    if (message.includes('12个球')) {
      return reasoningPassUpTo >= 4 ? '4vs4称' : '不知道';
    }

    // 工具调用题
    if (message.includes('file_read')) {
      return toolCallingPass >= 1
        ? '{"toolName": "file_read", "args": {"path": "test.txt"}}'
        : '无法执行';
    }
    if (message.includes('shell_exec')) {
      return toolCallingPass >= 2
        ? '{"toolName": "shell_exec", "args": {"command": "ls -la"}}'
        : '无法执行';
    }
    if (message.includes('web_search')) {
      return toolCallingPass >= 3
        ? '{"toolName": "web_search", "args": {"query": "天气预报"}}'
        : '无法执行';
    }

    // 代码生成题
    if (message.includes('斐波那契')) {
      return codeQuality === 'good'
        ? 'function fibonacci(n: number): number { if (n <= 1) return n; return fibonacci(n-1) + fibonacci(n-2); }'
        : '不知道怎么写';
    }

    // 结构化输出题
    if (message.includes('张三')) {
      return structuredPass >= 1 ? '{"name": "张三", "age": 25}' : '张三 25';
    }
    if (message.includes('1, 2, 3')) {
      return structuredPass >= 2 ? '[1, 2, 3]' : '1 2 3';
    }
    if (message.includes('李四')) {
      return structuredPass >= 3
        ? '{"user": {"name": "李四", "scores": [90, 85, 95]}}'
        : '李四';
    }

    return 'unknown';
  });

  return { chat, getModelName: () => modelName };
}

/** 构造 mock 持久化 */
function createMockPersistence() {
  let store: Record<string, unknown> = {};
  return {
    saveEnvironmentState: jest.fn((state: Record<string, unknown>) => {
      store = { ...store, ...state };
    }),
    loadEnvironmentState: jest.fn((): Record<string, unknown> | null => {
      return Object.keys(store).length > 0 ? store : null;
    }),
    _getStore: () => store,
  };
}

describe('LLMCapabilityDetector', () => {
  let detector: LLMCapabilityDetector;

  beforeEach(() => {
    detector = new LLMCapabilityDetector();
  });

  describe('基础探测', () => {
    it('未设置 LLM 时返回 null', async () => {
      const result = await detector.detectCapabilities('test-provider');
      expect(result).toBeNull();
    });

    it('强模型探测出高能力评分', async () => {
      const llm = createMockLLM({
        reasoningPassUpTo: 4,
        toolCallingPass: 3,
        structuredPass: 3,
        codeQuality: 'good',
        modelName: 'gpt-4o',
      });
      detector.setLLMProvider(llm);

      const caps = await detector.detectCapabilities('gpt-4o');

      expect(caps).not.toBeNull();
      expect(caps!.provider).toBe('gpt-4o');
      expect(caps!.modelName).toBe('gpt-4o');
      // 强模型推理深度应 >= 6
      expect(caps!.reasoningDepth).toBeGreaterThanOrEqual(6);
      // 工具调用准确率应为 1.0（3/3）
      expect(caps!.toolCallingAccuracy).toBe(1);
      // 结构化输出应为 1.0（3/3）
      expect(caps!.structuredOutput).toBe(1);
      // 总体评分应较高
      expect(caps!.overallScore).toBeGreaterThan(6);
    });

    it('弱模型探测出低能力评分', async () => {
      const llm = createMockLLM({
        reasoningPassUpTo: 1,
        toolCallingPass: 0,
        structuredPass: 0,
        codeQuality: 'poor',
        modelName: 'gpt-3.5-turbo',
      });
      detector.setLLMProvider(llm);

      const caps = await detector.detectCapabilities('gpt-3.5');

      expect(caps).not.toBeNull();
      // 弱模型推理深度低
      expect(caps!.reasoningDepth).toBeLessThanOrEqual(2);
      // 工具调用准确率低
      expect(caps!.toolCallingAccuracy).toBeLessThan(0.5);
      // 总体评分低
      expect(caps!.overallScore).toBeLessThan(5);
    });

    it('上下文窗口基于模型名启发式判断', async () => {
      const llm = createMockLLM({ modelName: 'claude-3-5-sonnet' });
      detector.setLLMProvider(llm);

      const caps = await detector.detectCapabilities('claude');
      expect(caps!.contextWindow).toBeGreaterThanOrEqual(32000);
    });
  });

  describe('缓存机制', () => {
    it('24h 内重复探测使用缓存', async () => {
      const llm = createMockLLM({});
      detector.setLLMProvider(llm);

      const first = await detector.detectCapabilities('cached-provider');
      const firstCallCount = llm.chat.mock.calls.length;

      const second = await detector.detectCapabilities('cached-provider');

      // 应返回缓存，不额外调用 LLM
      expect(second).toEqual(first);
      expect(llm.chat.mock.calls.length).toBe(firstCallCount);
    });

    it('force=true 强制重新探测', async () => {
      const llm = createMockLLM({});
      detector.setLLMProvider(llm);

      await detector.detectCapabilities('force-provider');
      const firstCallCount = llm.chat.mock.calls.length;

      await detector.detectCapabilities('force-provider', true);

      // force 应触发新的 LLM 调用
      expect(llm.chat.mock.calls.length).toBeGreaterThan(firstCallCount);
    });

    it('探测中防重入', async () => {
      const llm = createMockLLM({});
      detector.setLLMProvider(llm);

      // 故意让 chat 慢一点
      llm.chat.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve('大于'), 50))
      );

      // 并发触发两次
      const [first, second] = await Promise.all([
        detector.detectCapabilities('concurrent'),
        detector.detectCapabilities('concurrent'),
      ]);

      // 第二次因防重入应返回 null
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('能力对比', () => {
    it('能力提升时 diff.improved=true', () => {
      const previous: LLMCapabilities = {
        provider: 'p',
        modelName: 'm',
        detectedAt: 0,
        contextWindow: 8000,
        reasoningDepth: 4,
        toolCallingAccuracy: 0.6,
        codeGeneration: 4,
        multiModal: false,
        structuredOutput: 0.5,
        overallScore: 4,
      };
      const current: LLMCapabilities = {
        provider: 'p',
        modelName: 'm',
        detectedAt: 1,
        contextWindow: 128000,
        reasoningDepth: 8,
        toolCallingAccuracy: 0.95,
        codeGeneration: 8,
        multiModal: true,
        structuredOutput: 0.95,
        overallScore: 8,
      };

      const diff = detector.compareCapabilities(previous, current);

      expect(diff.improved).toBe(true);
      expect(diff.reasoningDepthImprovement).toBe(4);
      expect(diff.newCapabilities).toContain('multiModal');
      expect(diff.newCapabilities).toContain('largerContextWindow');
      expect(diff.newCapabilities).toContain('reliableStructuredOutput');
    });

    it('能力下降时 diff.improved=false', () => {
      const previous: LLMCapabilities = {
        provider: 'p',
        modelName: 'm',
        detectedAt: 0,
        contextWindow: 128000,
        reasoningDepth: 8,
        toolCallingAccuracy: 0.95,
        codeGeneration: 8,
        multiModal: true,
        structuredOutput: 0.95,
        overallScore: 8,
      };
      const current: LLMCapabilities = {
        provider: 'p',
        modelName: 'm',
        detectedAt: 1,
        contextWindow: 8000,
        reasoningDepth: 4,
        toolCallingAccuracy: 0.6,
        codeGeneration: 4,
        multiModal: false,
        structuredOutput: 0.5,
        overallScore: 4,
      };

      const diff = detector.compareCapabilities(previous, current);

      expect(diff.improved).toBe(false);
      expect(diff.overallImprovement).toBeLessThan(0);
      expect(diff.lostCapabilities).toContain('multiModal');
    });
  });

  describe('持久化', () => {
    it('设置持久化后加载缓存数据', async () => {
      const persistence = createMockPersistence();
      const llm = createMockLLM({});

      // 第一次探测器
      const d1 = new LLMCapabilityDetector();
      d1.setLLMProvider(llm);
      d1.setPersistence(persistence);
      await d1.detectCapabilities('persist-provider');

      // 第二次探测器（模拟重启）共享同一持久化
      const d2 = new LLMCapabilityDetector();
      d2.setPersistence(persistence);

      // 应能从持久化恢复缓存
      const cached = d2.getCachedCapabilities('persist-provider');
      expect(cached).not.toBeNull();
      expect(cached!.provider).toBe('persist-provider');
    });

    it('探测后持久化保存被调用', async () => {
      const persistence = createMockPersistence();
      const llm = createMockLLM({});
      detector.setLLMProvider(llm);
      detector.setPersistence(persistence);

      await detector.detectCapabilities('save-provider');

      expect(persistence.saveEnvironmentState).toHaveBeenCalled();
    });
  });

  describe('回调', () => {
    it('探测成功触发 onCapabilitiesDetected', async () => {
      const llm = createMockLLM({});
      detector.setLLMProvider(llm);
      const onDetected = jest.fn();
      detector.setCallbacks({ onCapabilitiesDetected: onDetected });

      await detector.detectCapabilities('callback-provider');

      expect(onDetected).toHaveBeenCalledTimes(1);
      expect(onDetected).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'callback-provider' })
      );
    });

    it('探测失败触发 onDetectionError', async () => {
      const llm = createMockLLM({});
      // getModelName 同步抛错会传播到 detectCapabilities 外层 catch
      llm.getModelName = jest.fn(() => {
        throw new Error('LLM 不可用');
      });
      detector.setLLMProvider(llm);
      const onError = jest.fn();
      detector.setCallbacks({ onDetectionError: onError });

      await detector.detectCapabilities('error-provider');

      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  describe('缓存查询', () => {
    it('getCachedCapabilities 返回最近探测结果', async () => {
      const llm = createMockLLM({});
      detector.setLLMProvider(llm);

      await detector.detectCapabilities('latest-provider');

      const cached = detector.getCachedCapabilities();
      expect(cached).not.toBeNull();
      expect(cached!.provider).toBe('latest-provider');
    });

    it('无数据时 getCachedCapabilities 返回 null', () => {
      const cached = detector.getCachedCapabilities('nonexistent');
      expect(cached).toBeNull();
    });
  });
});
