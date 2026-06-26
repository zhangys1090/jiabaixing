/**
 * 策略适配器测试
 *
 * 验证核心目标：
 *   - 根据 LLM 能力生成策略配置
 *   - 推理深度高 → 启用 ToT / 因果建模 / 动态重规划
 *   - 工具准确率高 → 工具链复杂度 complex
 *   - 结构化输出强 → 输出严格度 strict
 *   - 上下文窗口大 → 上下文注入深度 deep
 *   - 默认配置（保守策略）
 *   - 回调触发
 *   - 持久化加载/保存
 */

import type { LLMCapabilities } from '../../../src/evolution/LLMCapabilityDetector';
import type { StrategyConfig } from '../../../src/evolution/StrategyAdapter';
import { StrategyAdapter } from '../../../src/evolution/StrategyAdapter';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

/** 构造 LLM 能力对象 */
function createCapabilities(
  overrides: Partial<LLMCapabilities> = {}
): LLMCapabilities {
  return {
    provider: 'test',
    modelName: 'test-model',
    detectedAt: Date.now(),
    contextWindow: 8000,
    reasoningDepth: 5,
    toolCallingAccuracy: 0.7,
    codeGeneration: 5,
    multiModal: false,
    structuredOutput: 0.6,
    overallScore: 5,
    ...overrides,
  };
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

describe('StrategyAdapter', () => {
  let adapter: StrategyAdapter;

  beforeEach(() => {
    adapter = new StrategyAdapter();
  });

  describe('Prompt 策略', () => {
    it('推理深度高 → reasoningFreedom=high', async () => {
      const caps = createCapabilities({ reasoningDepth: 8 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.reasoningFreedom).toBe('high');
      expect(config.prompt.enableCoT).toBe(true);
    });

    it('推理深度中 → reasoningFreedom=medium', async () => {
      const caps = createCapabilities({ reasoningDepth: 5 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.reasoningFreedom).toBe('medium');
    });

    it('推理深度低 → reasoningFreedom=structured', async () => {
      const caps = createCapabilities({ reasoningDepth: 2 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.reasoningFreedom).toBe('structured');
      expect(config.prompt.enableCoT).toBe(false);
    });

    it('结构化输出强 → outputStrictness=strict', async () => {
      const caps = createCapabilities({ structuredOutput: 0.95 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.outputStrictness).toBe('strict');
    });

    it('结构化输出弱 → outputStrictness=flexible', async () => {
      const caps = createCapabilities({ structuredOutput: 0.3 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.outputStrictness).toBe('flexible');
    });

    it('上下文窗口大 → contextInjectionDepth=deep', async () => {
      const caps = createCapabilities({ contextWindow: 128000 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.contextInjectionDepth).toBe('deep');
    });

    it('工具准确率高 → toolChainComplexity=complex', async () => {
      const caps = createCapabilities({ toolCallingAccuracy: 0.97 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.toolChainComplexity).toBe('complex');
    });

    it('工具准确率低 → toolChainComplexity=simple', async () => {
      const caps = createCapabilities({ toolCallingAccuracy: 0.5 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.prompt.toolChainComplexity).toBe('simple');
    });
  });

  describe('规划策略', () => {
    it('推理深度 >6 → 启用 ToT 和动态重规划', async () => {
      const caps = createCapabilities({ reasoningDepth: 7 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.planning.enableToT).toBe(true);
      expect(config.planning.enableDynamicReplanning).toBe(true);
    });

    it('推理深度 <=6 → 禁用 ToT', async () => {
      const caps = createCapabilities({ reasoningDepth: 5 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.planning.enableToT).toBe(false);
    });

    it('推理深度 >8 → 启用因果建模和并行规划', async () => {
      const caps = createCapabilities({ reasoningDepth: 9 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.planning.enableCausalModeling).toBe(true);
      expect(config.planning.enableParallelPlanning).toBe(true);
      expect(config.planning.maxPlanDepth).toBe(5);
    });

    it('推理深度低 → maxPlanDepth=3', async () => {
      const caps = createCapabilities({ reasoningDepth: 3 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.planning.maxPlanDepth).toBe(3);
    });
  });

  describe('工具使用策略', () => {
    it('工具准确率高 → 启用工具链和预测', async () => {
      const caps = createCapabilities({
        toolCallingAccuracy: 0.92,
        overallScore: 7,
      });
      const config = await adapter.adaptStrategies(caps);
      expect(config.toolUse.enableToolChaining).toBe(true);
      expect(config.toolUse.enableToolPrediction).toBe(true);
      expect(config.toolUse.maxConsecutiveToolCalls).toBe(10);
      expect(config.toolUse.maxRetriesPerTool).toBe(1);
    });

    it('工具准确率低 → 禁用工具链，增加重试', async () => {
      const caps = createCapabilities({ toolCallingAccuracy: 0.6 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.toolUse.enableToolChaining).toBe(false);
      expect(config.toolUse.maxRetriesPerTool).toBe(2);
    });
  });

  describe('反思策略', () => {
    it('推理深度高 → 深度反思 + 跨轮次', async () => {
      const caps = createCapabilities({ reasoningDepth: 8 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.reflection.depth).toBe('deep');
      expect(config.reflection.enableCrossTurnReflection).toBe(true);
      expect(config.reflection.maxReflectionRounds).toBe(3);
    });

    it('推理深度低 → 浅层反思', async () => {
      const caps = createCapabilities({ reasoningDepth: 4 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.reflection.depth).toBe('shallow');
      expect(config.reflection.enableCrossTurnReflection).toBe(false);
      expect(config.reflection.maxReflectionRounds).toBe(1);
    });
  });

  describe('执行策略', () => {
    it('推理深度高 → 启用自适应控制和并行执行', async () => {
      const caps = createCapabilities({ reasoningDepth: 8, overallScore: 8 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.execution.enableAdaptiveControl).toBe(true);
      expect(config.execution.enableParallelExecution).toBe(true);
      expect(config.execution.riskAssessmentThreshold).toBe(0.8);
    });

    it('能力低 → 保守执行策略', async () => {
      const caps = createCapabilities({ reasoningDepth: 3, overallScore: 4 });
      const config = await adapter.adaptStrategies(caps);
      expect(config.execution.enableAdaptiveControl).toBe(false);
      expect(config.execution.riskAssessmentThreshold).toBe(0.6);
      expect(config.execution.qualityThreshold).toBe(0.4);
    });
  });

  describe('默认配置', () => {
    it('getDefaultConfig 返回保守策略', () => {
      const config = adapter.getDefaultConfig();

      expect(config.planning.enableToT).toBe(false);
      expect(config.planning.enableCausalModeling).toBe(false);
      expect(config.planning.maxPlanDepth).toBe(3);
      expect(config.reflection.depth).toBe('shallow');
      expect(config.execution.enableAdaptiveControl).toBe(false);
      expect(config.toolUse.enableToolChaining).toBe(false);
      expect(config.prompt.reasoningFreedom).toBe('structured');
    });
  });

  describe('回调触发', () => {
    it('适配后触发所有回调', async () => {
      const caps = createCapabilities({ reasoningDepth: 8 });
      const callbacks = {
        onPromptConfigUpdate: jest.fn(),
        onPlanningConfigUpdate: jest.fn(),
        onToolUseConfigUpdate: jest.fn(),
        onReflectionConfigUpdate: jest.fn(),
        onExecutionConfigUpdate: jest.fn(),
      };
      adapter.setCallbacks(callbacks);

      await adapter.adaptStrategies(caps);

      expect(callbacks.onPromptConfigUpdate).toHaveBeenCalledTimes(1);
      expect(callbacks.onPlanningConfigUpdate).toHaveBeenCalledTimes(1);
      expect(callbacks.onToolUseConfigUpdate).toHaveBeenCalledTimes(1);
      expect(callbacks.onReflectionConfigUpdate).toHaveBeenCalledTimes(1);
      expect(callbacks.onExecutionConfigUpdate).toHaveBeenCalledTimes(1);
    });

    it('回调抛错不影响适配主流程', async () => {
      const caps = createCapabilities({ reasoningDepth: 8 });
      adapter.setCallbacks({
        onPromptConfigUpdate: () => {
          throw new Error('回调失败');
        },
      });

      // 不应抛出
      const config = await adapter.adaptStrategies(caps);
      expect(config).toBeDefined();
    });
  });

  describe('持久化', () => {
    it('适配后持久化保存', async () => {
      const persistence = createMockPersistence();
      adapter.setPersistence(persistence);

      const caps = createCapabilities({ reasoningDepth: 7 });
      await adapter.adaptStrategies(caps);

      expect(persistence.saveEnvironmentState).toHaveBeenCalled();
    });

    it('设置持久化后加载已保存配置', () => {
      const persistence = createMockPersistence();
      // 预存一份配置
      const savedConfig: StrategyConfig = {
        prompt: {
          reasoningFreedom: 'high',
          outputStrictness: 'strict',
          contextInjectionDepth: 'deep',
          toolChainComplexity: 'complex',
          enableCoT: true,
        },
        planning: {
          enableToT: true,
          enableCausalModeling: true,
          maxPlanDepth: 5,
          enableDynamicReplanning: true,
          enableParallelPlanning: true,
        },
        toolUse: {
          enableToolChaining: true,
          maxConsecutiveToolCalls: 10,
          enableToolPrediction: true,
          maxRetriesPerTool: 1,
        },
        reflection: {
          depth: 'deep',
          enableCrossTurnReflection: true,
          injectReflectionToPlanning: true,
          maxReflectionRounds: 3,
        },
        execution: {
          enableAdaptiveControl: true,
          riskAssessmentThreshold: 0.8,
          enableParallelExecution: true,
          qualityThreshold: 0.6,
        },
        version: '1.0.0',
        appliedAt: 1000,
        llmOverallScore: 8,
      };
      persistence.saveEnvironmentState({ strategy_config: savedConfig });

      adapter.setPersistence(persistence);

      const loaded = adapter.getCurrentConfig();
      expect(loaded).not.toBeNull();
      expect(loaded!.planning.enableToT).toBe(true);
      expect(loaded!.llmOverallScore).toBe(8);
    });
  });

  describe('getCurrentConfig', () => {
    it('未适配前 getCurrentConfig 返回 null', () => {
      expect(adapter.getCurrentConfig()).toBeNull();
    });

    it('适配后 getCurrentConfig 返回最新配置', async () => {
      const caps = createCapabilities({ reasoningDepth: 7 });
      const config = await adapter.adaptStrategies(caps);
      const current = adapter.getCurrentConfig();
      expect(current).toEqual(config);
    });
  });
});
