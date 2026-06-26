/**
 * 阶段 4.1: Tree of Thoughts 规划测试
 *
 * 验证核心目标：
 *   - 复杂任务生成多个候选计划
 *   - LLM 评估每个候选的可行性
 *   - 选择最优路径执行
 *   - simple 任务仍走单计划（回归）
 *   - 评估失败时降级容错
 */

import { Planner, type PlannerDeps } from '../../../src/harness/loop/Planner';
import type {
  ExecutionPlan,
  LoopContext,
  UserInput,
} from '../../../src/harness/types';
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

/** 构造多候选 LLM 响应（candidates 数组格式） */
function createMultiCandidateResponse(): string {
  return JSON.stringify({
    candidates: [
      {
        strategy: '保守方案',
        reasoning: '逐步迁移，风险最低',
        steps: [
          { id: 's1', description: '分析现有架构' },
          { id: 's2', description: '迁移到新架构' },
        ],
        dependencies: { s2: ['s1'] },
        estimatedRounds: 4,
      },
      {
        strategy: '激进方案',
        reasoning: '一次性重构，速度最快',
        steps: [
          { id: 's1', description: '整体重构' },
          { id: 's2', description: '验证结果' },
        ],
        dependencies: { s2: ['s1'] },
        estimatedRounds: 3,
      },
      {
        strategy: '均衡方案',
        reasoning: '分阶段重构，平衡风险与速度',
        steps: [
          { id: 's1', description: '分析架构' },
          { id: 's2', description: '第一阶段迁移' },
          { id: 's3', description: '第二阶段迁移' },
        ],
        dependencies: { s2: ['s1'], s3: ['s2'] },
        estimatedRounds: 5,
      },
    ],
  });
}

/** 构造评估响应（scores 数组格式） */
function createEvaluationResponse(): string {
  return JSON.stringify({
    evaluations: [
      {
        candidateIndex: 0,
        feasibilityScore: 0.8,
        reasoning: '保守方案风险低但耗时',
        risks: ['耗时长'],
      },
      {
        candidateIndex: 1,
        feasibilityScore: 0.4,
        reasoning: '激进方案风险高',
        risks: ['一次性重构易失败'],
      },
      {
        candidateIndex: 2,
        feasibilityScore: 0.9,
        reasoning: '均衡方案最优',
        risks: ['需协调多阶段'],
      },
    ],
  });
}

describe('阶段 4.1: Tree of Thoughts 规划', () => {
  describe('多候选生成与择优', () => {
    it('complex 任务生成 ≥2 候选并选择最优', async () => {
      const deps = createMockDeps();
      const chatMock = jest.fn();
      // 第1次：生成候选；第2次：评估
      chatMock
        .mockResolvedValueOnce(createMultiCandidateResponse())
        .mockResolvedValueOnce(createEvaluationResponse());
      deps.llm.chat = chatMock;

      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        createMockContext()
      );

      expect(plan.planTier).toBe('complex');
      // ToT 元信息应记录候选数与选中排名
      expect(plan.totMeta).toBeDefined();
      expect(plan.totMeta?.candidateCount).toBeGreaterThanOrEqual(2);
      // 应选择分数最高的均衡方案（candidateIndex=2, score=0.9）
      expect(plan.totMeta?.selectedRank).toBeGreaterThanOrEqual(0);
      // 选中策略应为均衡方案
      expect(plan.totMeta?.selectedStrategy).toContain('均衡');
    });

    it('评估器对候选打分且选择最高分候选', async () => {
      const deps = createMockDeps();
      const chatMock = jest.fn();
      chatMock
        .mockResolvedValueOnce(createMultiCandidateResponse())
        .mockResolvedValueOnce(createEvaluationResponse());
      deps.llm.chat = chatMock;

      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        createMockContext()
      );

      // 最优候选是 index=2（score=0.9），其步骤数为 3
      expect(plan.steps.length).toBe(3);
      expect(plan.steps[0].description).toContain('分析架构');
    });

    it('注入自定义 planEvaluator 时使用外部评估器', async () => {
      const deps = createMockDeps();
      const chatMock = jest.fn();
      chatMock.mockResolvedValueOnce(createMultiCandidateResponse());
      deps.llm.chat = chatMock;

      // 自定义评估器：始终选第2个候选（index=1）
      deps.planEvaluator = {
        evaluate: jest.fn().mockResolvedValue([
          {
            plan: {} as ExecutionPlan,
            feasibilityScore: 0.3,
            reasoning: '候选0',
            risks: [],
          },
          {
            plan: {} as ExecutionPlan,
            feasibilityScore: 0.95,
            reasoning: '候选1最优',
            risks: [],
          },
          {
            plan: {} as ExecutionPlan,
            feasibilityScore: 0.5,
            reasoning: '候选2',
            risks: [],
          },
        ]),
      };

      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        createMockContext()
      );

      expect(deps.planEvaluator.evaluate).toHaveBeenCalled();
      // 选中的应是候选1（激进方案，步骤数2）
      expect(plan.steps.length).toBe(2);
      expect(plan.steps[0].description).toContain('整体重构');
    });
  });

  describe('回归与容错', () => {
    it('simple 任务仍走单计划，不触发 ToT', async () => {
      const deps = createMockDeps();
      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('读取文件 /etc/hosts'),
        createMockContext()
      );

      expect(plan.planTier).toBe('simple');
      expect(plan.totMeta).toBeUndefined();
      // simple 档不应调用 LLM 规划
      expect(deps.llm.chat).not.toHaveBeenCalled();
    });

    it('LLM 返回旧格式单计划时降级为单候选（向后兼容）', async () => {
      const deps = createMockDeps();
      const chatMock = jest.fn();
      // 第1次返回旧格式单计划；第2次评估返回空（容错）
      chatMock
        .mockResolvedValueOnce(
          JSON.stringify({
            reasoning: '需要多步骤重构',
            steps: [
              { id: 's1', description: '分析现有架构' },
              { id: 's2', description: '迁移到新架构' },
            ],
            dependencies: { s2: ['s1'] },
            estimatedRounds: 4,
          })
        )
        .mockResolvedValueOnce('INVALID JSON');
      deps.llm.chat = chatMock;

      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        createMockContext()
      );

      // 降级为单候选，仍应返回有效计划
      expect(plan.planTier).toBe('complex');
      expect(plan.steps.length).toBe(2);
      expect(plan.planReasoning).toContain('多步骤');
    });

    it('评估失败时降级取首个候选（容错）', async () => {
      const deps = createMockDeps();
      const chatMock = jest.fn();
      chatMock
        .mockResolvedValueOnce(createMultiCandidateResponse())
        .mockResolvedValueOnce('BROKEN');
      deps.llm.chat = chatMock;

      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        createMockContext()
      );

      // 评估失败时取首个候选（保守方案）
      expect(plan.planTier).toBe('complex');
      expect(plan.steps[0].description).toContain('分析现有架构');
    });

    it('可通过 totConfig 关闭 ToT（向后兼容）', async () => {
      const deps = createMockDeps();
      const chatMock = jest.fn();
      chatMock.mockResolvedValue(
        JSON.stringify({
          reasoning: '需要多步骤重构',
          steps: [
            { id: 's1', description: '分析现有架构' },
            { id: 's2', description: '迁移到新架构' },
          ],
          dependencies: { s2: ['s1'] },
          estimatedRounds: 4,
        })
      );
      deps.llm.chat = chatMock;
      deps.totConfig = { enabled: false };

      const planner = new Planner(deps);
      const plan = await planner.plan(
        createInput('重构整个认证系统并迁移到新架构'),
        createMockContext()
      );

      expect(plan.planTier).toBe('complex');
      expect(plan.totMeta).toBeUndefined();
      // 关闭 ToT 时只调用一次 LLM
      expect(chatMock).toHaveBeenCalledTimes(1);
    });
  });
});
