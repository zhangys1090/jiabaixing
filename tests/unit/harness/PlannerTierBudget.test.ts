/**
 * P1.1 Planner 智能化升级：5档路由 + 预算感知规划
 *
 * 验证开发计划阶段1.1的核心目标：
 *   - 动态规划层级：none → direct → simple → complex → research
 *   - 预算感知规划：预算紧张时生成"够用"的计划而非"理想"计划
 *
 * 注：CoT 规划、历史经验注入、知识图谱推理已在既有实现中验证，此处聚焦真正缺失的 5 档路由与预算感知。
 */

import { Planner, type PlannerDeps } from '../../../src/harness/loop/Planner';
import type { LoopContext, UserInput } from '../../../src/harness/types';
import { LoopState } from '../../../src/harness/types';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function createMockDeps(): PlannerDeps {
  return {
    llm: {
      chat: jest.fn().mockResolvedValue('NO'),
    },
  };
}

function createMockContext(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    messages: [],
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

function createInput(
  text: string,
  overrides: Partial<UserInput> = {}
): UserInput {
  return {
    text,
    userId: 'test-user',
    traceId: 'test-trace',
    ...overrides,
  };
}

describe('P1.1 Planner 智能化升级：5档路由 + 预算感知', () => {
  describe('5档路由层级 (none → direct → simple → complex → research)', () => {
    it('none: 纯对话 → planTier=none, toolCallMode=none, 不调工具', async () => {
      const planner = new Planner(createMockDeps());
      const plan = await planner.plan(createInput('你好'), createMockContext());

      expect(plan.planTier).toBe('none');
      expect(plan.toolCallMode).toBe('none');
      expect(plan.estimatedBudget.maxToolCalls).toBe(0);
    });

    it('simple: 简单动作任务 → planTier=simple, 明确工具, 跳过LLM规划', async () => {
      const deps = createMockDeps();
      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('读取文件 /etc/hosts'),
        createMockContext()
      );

      expect(plan.planTier).toBe('simple');
      expect(plan.steps[0].toolName).toBeDefined();
      // simple 档不应调用 LLM 进行规划
      expect(deps.llm.chat).not.toHaveBeenCalled();
    });

    it('direct: 普通请求 → planTier=direct, LLM自主决策', async () => {
      const deps = createMockDeps();
      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('帮我写一首关于秋天的诗'),
        createMockContext()
      );

      expect(plan.planTier).toBe('direct');
      expect(plan.toolCallMode).toBe('auto');
    });

    it('complex: 复杂任务 → planTier=complex, 调用LLM生成CoT计划', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue(
        JSON.stringify({
          reasoning: '需要多步骤重构，先分析再迁移',
          steps: [
            { id: 's1', description: '分析现有架构' },
            { id: 's2', description: '迁移到新架构' },
          ],
          dependencies: { s2: ['s1'] },
          estimatedRounds: 4,
        })
      );
      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        createMockContext()
      );

      expect(plan.planTier).toBe('complex');
      expect(deps.llm.chat).toHaveBeenCalled();
      expect(plan.planReasoning).toContain('多步骤');
    });

    it('research: 研究任务 → planTier=research, 搜索+分析+总结模板', async () => {
      const deps = createMockDeps();
      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('研究AI技术发展趋势并总结要点'),
        createMockContext()
      );

      expect(plan.planTier).toBe('research');
      expect(plan.steps.length).toBeGreaterThanOrEqual(3);
      expect(plan.recommendedTools).toContain('web_search');
    });
  });

  describe('预算感知规划', () => {
    function createComplexResponse() {
      return JSON.stringify({
        reasoning: '需要多步骤',
        steps: [
          { id: 's1', description: '步骤1' },
          { id: 's2', description: '步骤2' },
          { id: 's3', description: '步骤3' },
          { id: 's4', description: '步骤4' },
          { id: 's5', description: '步骤5' },
        ],
        estimatedRounds: 6,
      });
    }

    it('预算紧张时缩减计划规模（maxTokens 降低）', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue(createComplexResponse());
      const planner = new Planner(deps);

      const tightContext = createMockContext();
      tightContext.budget.tokensUsed = 7000;
      tightContext.budget.tokenHardLimit = 8000;

      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        tightContext
      );

      // 预算紧张时应缩减 token 预算
      expect(plan.estimatedBudget.maxTokens).toBeLessThan(5000);
    });

    it('预算紧张时缩减轮次和工具调用上限', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue(createComplexResponse());
      const planner = new Planner(deps);

      const tightContext = createMockContext();
      tightContext.budget.tokensUsed = 7500;
      tightContext.budget.tokenHardLimit = 8000;
      tightContext.budget.roundsUsed = 6;
      tightContext.budget.hardRoundLimit = 8;

      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        tightContext
      );

      // 预算紧张时轮次应被缩减
      expect(plan.estimatedBudget.maxRounds).toBeLessThanOrEqual(6);
    });

    it('预算充足时不缩减计划规模', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue(createComplexResponse());
      const planner = new Planner(deps);

      const richContext = createMockContext();
      richContext.budget.tokensUsed = 100;
      richContext.budget.tokenHardLimit = 8000;

      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        richContext
      );

      // 预算充足时保持正常规模
      expect(plan.estimatedBudget.maxTokens).toBeGreaterThanOrEqual(5000);
    });

    it('时间预算紧张时缩减计划规模', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue(createComplexResponse());
      const planner = new Planner(deps);

      const timeTightContext = createMockContext();
      timeTightContext.budget.startTime = Date.now() - 55000;
      timeTightContext.budget.maxDurationMs = 60000;

      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        timeTightContext
      );

      // 时间预算紧张时缩减
      expect(plan.estimatedBudget.maxDurationMs).toBeLessThan(60000);
    });
  });
});
