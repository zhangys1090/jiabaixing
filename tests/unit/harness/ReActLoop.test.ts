/**
 * P1.3 ReAct 循环增强：推理步骤显式化 + 观察步骤注入
 *
 * 验证开发计划阶段1.3的核心目标：
 *   - 推理步骤显式化：Executor 每轮工具调用前，LLM 先输出推理（为什么选这个工具）
 *   - 观察步骤注入：工具结果返回后，LLM 先分析观察再决定下一步
 *
 * 真正的 ReAct（Reasoning + Acting）循环，而非线性 Plan-Execute-Evaluate。
 */

import { Executor } from '../../../src/harness/loop/Executor';
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

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    addTracePhase: jest.fn(),
    completeTracePhase: jest.fn(),
    startFullTrace: jest.fn(),
    completeFullTrace: jest.fn(),
    recordTokenUsage: jest.fn(),
    recordToolCall: jest.fn(),
    on: jest.fn(),
    onDynamic: jest.fn(),
    offDynamic: jest.fn(),
  },
}));

jest.mock('../../../src/skills/SkillRegistry', () => ({
  SkillRegistry: {
    getInstance: jest.fn().mockReturnValue({
      executeToolCall: jest.fn(),
      syncToLegacySkillRegistry: jest.fn(),
    }),
  },
}));

jest.mock('../../../src/harness/tools/registry/ToolCallGuard', () => ({
  ToolCallGuard: jest.fn().mockImplementation(() => ({
    check: jest.fn().mockReturnValue({ blocked: false }),
  })),
}));

function createMockToolRegistry() {
  return {
    toOpenAITools: jest.fn().mockReturnValue([
      {
        type: 'function',
        function: {
          name: 'file_read',
          description: '读取文件内容',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]),
    getReliabilityTracker: jest.fn().mockReturnValue({
      getUnreliableTools: jest.fn().mockReturnValue([]),
    }),
    getRegisteredToolNames: jest.fn().mockReturnValue(['file_read']),
    get: jest.fn().mockReturnValue(undefined),
  } as any;
}

function createMockContext(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    messages: [{ role: 'user', content: '读取配置文件' }],
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
      state: LoopState.EXECUTING,
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

function createPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    steps: [
      {
        id: 'step-1',
        description: '读取文件',
        retryCount: 0,
        maxRetries: 2,
        toUnifiedTaskNode: () => ({ id: 'step-1', status: 'pending' }) as any,
      },
    ],
    dependencies: new Map(),
    estimatedBudget: {
      maxRounds: 4,
      maxToolCalls: 10,
      maxTokens: 4000,
      maxDurationMs: 30000,
    },
    toolCallMode: 'auto',
    recommendedTools: [],
    ...overrides,
  };
}

describe('P1.3 ReAct 循环增强：推理步骤显式化 + 观察步骤注入', () => {
  describe('推理步骤显式化', () => {
    it('首次LLM调用前注入ReAct推理提示（auto模式）', async () => {
      const capturedMessages: any[][] = [];
      const mockLLM = {
        chatWithTools: jest.fn().mockImplementation((messages: any[]) => {
          capturedMessages.push([...messages]);
          return Promise.resolve({ content: '已完成', toolCalls: undefined });
        }),
      };

      const executor = new Executor({
        llm: mockLLM as any,
        toolRegistry: createMockToolRegistry(),
        schemaValidator: { validate: jest.fn().mockReturnValue(true) } as any,
        permissionGuard: {
          check: jest.fn().mockReturnValue({ allowed: true }),
        } as any,
      });

      await executor.execute(createPlan(), createMockContext());

      expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
      const firstCallMessages = capturedMessages[0];
      const reasoningHint = firstCallMessages.find(
        (m) => typeof m.content === 'string' && m.content.includes('ReAct')
      );
      expect(reasoningHint).toBeDefined();
      expect(reasoningHint.content).toContain('推理');
    });

    it('none模式不注入ReAct推理提示', async () => {
      const capturedMessages: any[][] = [];
      const mockLLM = {
        chatWithTools: jest.fn().mockImplementation((messages: any[]) => {
          capturedMessages.push([...messages]);
          return Promise.resolve({ content: '你好！', toolCalls: undefined });
        }),
      };

      const executor = new Executor({
        llm: mockLLM as any,
        toolRegistry: createMockToolRegistry(),
        schemaValidator: { validate: jest.fn().mockReturnValue(true) } as any,
        permissionGuard: {
          check: jest.fn().mockReturnValue({ allowed: true }),
        } as any,
      });

      await executor.execute(
        createPlan({ toolCallMode: 'none' }),
        createMockContext()
      );

      const firstCallMessages = capturedMessages[0];
      const reasoningHint = firstCallMessages.find(
        (m) => typeof m.content === 'string' && m.content.includes('ReAct')
      );
      expect(reasoningHint).toBeUndefined();
    });
  });

  describe('观察步骤注入', () => {
    it('工具结果后注入ReAct观察提示', async () => {
      const capturedMessages: any[][] = [];
      let callCount = 0;
      const mockLLM = {
        chatWithTools: jest.fn().mockImplementation((messages: any[]) => {
          capturedMessages.push([...messages]);
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              content: '我来读取文件',
              toolCalls: [
                {
                  id: 'tc-1',
                  type: 'function',
                  function: { name: 'file_read', arguments: '{}' },
                },
              ],
            });
          }
          return Promise.resolve({
            content: '文件内容已分析',
            toolCalls: undefined,
          });
        }),
      };

      const mockToolRegistry = createMockToolRegistry();
      // 让 SkillRegistry.executeToolCall 返回成功结果
      const { SkillRegistry } = require('../../../src/skills/SkillRegistry');
      SkillRegistry.getInstance.mockReturnValue({
        executeToolCall: jest.fn().mockResolvedValue({
          success: true,
          output: '文件内容: config=value',
        }),
        syncToLegacySkillRegistry: jest.fn(),
      });

      const executor = new Executor({
        llm: mockLLM as any,
        toolRegistry: mockToolRegistry,
        schemaValidator: { validate: jest.fn().mockReturnValue(true) } as any,
        permissionGuard: {
          check: jest.fn().mockReturnValue({ allowed: true }),
        } as any,
      });

      await executor.execute(createPlan(), createMockContext());

      // 第二次调用应包含观察提示
      expect(capturedMessages.length).toBeGreaterThanOrEqual(2);
      const secondCallMessages = capturedMessages[1];
      const observationHint = secondCallMessages.find(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('ReAct') &&
          m.content.includes('观察')
      );
      expect(observationHint).toBeDefined();
    });
  });

  describe('动态 replan（执行后立即检查，不等 Evaluate）', () => {
    it('工具全部失败 → 触发动态 replan', () => {
      const {
        LoopController,
      } = require('../../../src/harness/loop/LoopController');
      const controller = new LoopController({} as any);
      const checkDynamicReplan = (controller as any).checkDynamicReplan.bind(
        controller
      );

      const executorOutput = {
        messages: [
          { role: 'assistant', content: '调用工具' },
          { role: 'tool', name: 'file_read', content: '错误: 文件不存在' },
        ],
        toolCallsCount: 1,
        toolDuration: 100,
        completedNaturally: false,
      };
      const context = createMockContext();

      const result = checkDynamicReplan(executorOutput, context);

      expect(result.shouldReplan).toBe(true);
      expect(result.reason).toContain('全部失败');
    });

    it('工具失败率 > 50% → 触发动态 replan', () => {
      const {
        LoopController,
      } = require('../../../src/harness/loop/LoopController');
      const controller = new LoopController({} as any);
      const checkDynamicReplan = (controller as any).checkDynamicReplan.bind(
        controller
      );

      const executorOutput = {
        messages: [
          { role: 'assistant', content: '调用工具' },
          { role: 'tool', name: 'file_read', content: 'ok' },
          { role: 'tool', name: 'file_write', content: '错误: 权限不足' },
          { role: 'tool', name: 'file_delete', content: '错误: 不存在' },
        ],
        toolCallsCount: 3,
        toolDuration: 200,
        completedNaturally: false,
      };
      const context = createMockContext();

      const result = checkDynamicReplan(executorOutput, context);

      expect(result.shouldReplan).toBe(true);
      expect(result.reason).toContain('失败率');
    });

    it('执行卡住（无工具调用且未自然完成）→ 触发动态 replan', () => {
      const {
        LoopController,
      } = require('../../../src/harness/loop/LoopController');
      const controller = new LoopController({} as any);
      const checkDynamicReplan = (controller as any).checkDynamicReplan.bind(
        controller
      );

      const executorOutput = {
        messages: [{ role: 'assistant', content: '我需要更多信息' }],
        toolCallsCount: 0,
        toolDuration: 0,
        completedNaturally: false,
      };
      const context = createMockContext();
      context.plan = createPlan();

      const result = checkDynamicReplan(executorOutput, context);

      expect(result.shouldReplan).toBe(true);
      expect(result.reason).toContain('卡住');
    });

    it('工具全部成功 → 不触发动态 replan', () => {
      const {
        LoopController,
      } = require('../../../src/harness/loop/LoopController');
      const controller = new LoopController({} as any);
      const checkDynamicReplan = (controller as any).checkDynamicReplan.bind(
        controller
      );

      const executorOutput = {
        messages: [
          { role: 'assistant', content: '调用工具' },
          { role: 'tool', name: 'file_read', content: '文件内容' },
          { role: 'tool', name: 'file_write', content: '写入成功' },
        ],
        toolCallsCount: 2,
        toolDuration: 150,
        completedNaturally: true,
      };
      const context = createMockContext();

      const result = checkDynamicReplan(executorOutput, context);

      expect(result.shouldReplan).toBe(false);
    });

    it('none 模式执行卡住 → 不触发动态 replan', () => {
      const {
        LoopController,
      } = require('../../../src/harness/loop/LoopController');
      const controller = new LoopController({} as any);
      const checkDynamicReplan = (controller as any).checkDynamicReplan.bind(
        controller
      );

      const executorOutput = {
        messages: [{ role: 'assistant', content: '你好' }],
        toolCallsCount: 0,
        toolDuration: 0,
        completedNaturally: false,
      };
      const context = createMockContext();
      context.plan = createPlan({ toolCallMode: 'none' });

      const result = checkDynamicReplan(executorOutput, context);

      expect(result.shouldReplan).toBe(false);
    });
  });
});
