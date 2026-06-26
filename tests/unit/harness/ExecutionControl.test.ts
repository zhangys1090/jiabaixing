/**
 * P2-2: 执行过程实时控制测试
 *
 * 验证核心目标：
 *   - 执行前风险评估：高风险操作（不可逆/高消耗）触发预警
 *   - 执行后质量评估：低质量结果触发动态重规划
 *   - 自适应控制：基于执行轨迹动态调整策略
 *   - 风险评估降级：LLM不可用时安全降级
 */

import {
  Executor,
  type ExecutorDeps,
} from '../../../src/harness/loop/Executor';
import type { ExecutionPlan, LoopContext } from '../../../src/harness/types';
import { LoopState } from '../../../src/harness/types';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/skills/SkillRegistry', () => ({
  SkillRegistry: {
    getInstance: jest.fn().mockReturnValue({
      executeToolCall: jest
        .fn()
        .mockResolvedValue({ success: false, output: 'no skill' }),
    }),
  },
}));

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn().mockResolvedValue(undefined),
  },
}));

function createMockToolRegistry() {
  return {
    toOpenAITools: jest.fn().mockReturnValue([
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: '搜索网络',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]),
    get: jest.fn().mockReturnValue({
      execute: jest.fn().mockResolvedValue({
        success: true,
        output: '搜索结果',
      }),
    }),
    getReliabilityTracker: jest.fn().mockReturnValue({
      getUnreliableTools: jest.fn().mockReturnValue([]),
      record: jest.fn(),
    }),
  };
}

function createMockDeps(): ExecutorDeps {
  return {
    llm: {
      chatWithTools: jest.fn().mockResolvedValue({
        content: '完成',
        toolCalls: undefined,
      }),
    },
    toolRegistry:
      createMockToolRegistry() as unknown as ExecutorDeps['toolRegistry'],
    schemaValidator: {
      validate: jest.fn().mockReturnValue({ valid: true }),
    } as unknown as ExecutorDeps['schemaValidator'],
    permissionGuard: {
      check: jest.fn().mockReturnValue({ allowed: true }),
    } as unknown as ExecutorDeps['permissionGuard'],
  };
}

function createMockContext(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    messages: [{ role: 'user', content: '测试任务' }],
    plan: null,
    currentStepIndex: 0,
    stepResults: new Map(),
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map(),
    stepStateHistory: [],
    budget: {
      roundsUsed: 0,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 0,
      tokenWarningLimit: 4500,
      tokenHardLimit: 8000,
      startTime: Date.now(),
      maxDurationMs: 60000,
      toolCallsUsed: 0,
      maxToolCalls: 10,
    },
    trace: {
      traceId: 'test-trace',
      state: LoopState.PLANNING,
      stateTransitions: [],
      trajectory: [],
      totalDuration: 0,
      totalToolCalls: 0,
      budgetState: {
        roundsUsed: 0,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 0,
        tokenWarningLimit: 4500,
        tokenHardLimit: 8000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: 0,
        maxToolCalls: 10,
      },
    },
    metadata: {},
    ...overrides,
  };
}

function createMockPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    steps: [],
    dependencies: new Map(),
    estimatedBudget: {
      maxRounds: 3,
      maxToolCalls: 5,
      maxTokens: 3000,
      maxDurationMs: 30000,
    },
    toolCallMode: 'auto',
    recommendedTools: [],
    ...overrides,
  } as ExecutionPlan;
}

describe('P2-2: 执行过程实时控制', () => {
  describe('assessExecutionRisk', () => {
    it('应识别高风险工具调用（不可逆操作）', async () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const risk = await executor.assessExecutionRisk('file_delete', {
        path: '/important/file.ts',
      });

      expect(risk.level).toBe('high');
      expect(risk.reason).toContain('不可逆');
      expect(risk.shouldProceed).toBe(false);
    });

    it('应识别中风险工具调用（高消耗操作）', async () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const risk = await executor.assessExecutionRisk('shell_exec', {
        command: 'npm install',
      });

      expect(risk.level).toBe('medium');
      expect(risk.reason).toBeTruthy();
    });

    it('应将只读操作识别为低风险', async () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const risk = await executor.assessExecutionRisk('file_read', {
        path: '/some/file.ts',
      });

      expect(risk.level).toBe('low');
      expect(risk.shouldProceed).toBe(true);
    });
  });

  describe('evaluateExecutionQuality', () => {
    it('应评估高质量的工具结果', async () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const quality = await executor.evaluateExecutionQuality(
        'web_search',
        { query: 'AI趋势' },
        {
          success: true,
          output:
            'AI在2025年的发展趋势包括大模型、多模态、Agent架构、具身智能、AI安全等多个前沿方向，正在快速演进中。',
          duration: 1200,
        }
      );

      expect(quality.score).toBeGreaterThan(0.6);
      expect(quality.isSufficient).toBe(true);
    });

    it('应识别低质量的工具结果（空输出）', async () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const quality = await executor.evaluateExecutionQuality(
        'web_search',
        { query: 'test' },
        {
          success: true,
          output: '',
          duration: 500,
        }
      );

      expect(quality.score).toBeLessThan(0.4);
      expect(quality.isSufficient).toBe(false);
      expect(quality.issues).toContain('空输出');
    });

    it('应识别失败的工具结果', async () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const quality = await executor.evaluateExecutionQuality(
        'web_search',
        { query: 'test' },
        {
          success: false,
          output: '错误: 网络超时',
          duration: 30000,
        }
      );

      expect(quality.score).toBe(0);
      expect(quality.isSufficient).toBe(false);
    });
  });

  describe('shouldReplan', () => {
    it('连续多次低质量结果应触发重规划', () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const qualityHistory = [
        { score: 0.2, isSufficient: false },
        { score: 0.3, isSufficient: false },
        { score: 0.1, isSufficient: false },
      ];

      const result = executor.shouldReplan(qualityHistory, 3);
      expect(result.shouldReplan).toBe(true);
      expect(result.reason).toContain('连续低质量');
    });

    it('高质量结果不应触发重规划', () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const qualityHistory = [
        { score: 0.8, isSufficient: true },
        { score: 0.7, isSufficient: true },
      ];

      const result = executor.shouldReplan(qualityHistory, 2);
      expect(result.shouldReplan).toBe(false);
    });

    it('轮次耗尽应触发重规划', () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      const result = executor.shouldReplan([], 8);
      expect(result.shouldReplan).toBe(true);
      expect(result.reason).toContain('轮次');
    });
  });

  describe('P3 策略适配闭环: applyStrategyConfig → shouldReplan', () => {
    it('applyStrategyConfig 后应使用策略配置的质量阈值', () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      // 应用高能力 LLM 的策略：质量阈值 0.6
      (
        executor as unknown as {
          applyStrategyConfig: (c: {
            enableAdaptiveControl?: boolean;
            qualityThreshold?: number;
          }) => void;
        }
      ).applyStrategyConfig({
        enableAdaptiveControl: true,
        qualityThreshold: 0.6,
      });

      // 平均质量 0.5 < 阈值 0.6 → 应触发重规划
      const result = executor.shouldReplan(
        [
          { score: 0.5, isSufficient: false },
          { score: 0.5, isSufficient: false },
        ],
        1
      );
      expect(result.shouldReplan).toBe(true);
      expect(result.reason).toContain('0.6');
    });

    it('未应用策略时使用默认阈值 0.3（向后兼容）', () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      // 平均质量 0.4 > 默认阈值 0.3 → 不应触发重规划
      const result = executor.shouldReplan(
        [
          { score: 0.4, isSufficient: false },
          { score: 0.4, isSufficient: false },
        ],
        1
      );
      expect(result.shouldReplan).toBe(false);
    });

    it('应用低阈值策略后，原本不触发的质量应触发重规划', () => {
      const deps = createMockDeps();
      const executor = new Executor(deps);

      // 应用低能力 LLM 的策略：质量阈值 0.4
      (
        executor as unknown as {
          applyStrategyConfig: (c: { qualityThreshold?: number }) => void;
        }
      ).applyStrategyConfig({ qualityThreshold: 0.4 });

      // 平均质量 0.35 < 阈值 0.4 → 应触发重规划
      const result = executor.shouldReplan(
        [
          { score: 0.3, isSufficient: false },
          { score: 0.4, isSufficient: false },
        ],
        1
      );
      expect(result.shouldReplan).toBe(true);
    });
  });
});
