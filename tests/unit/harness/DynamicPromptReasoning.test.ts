/**
 * P2-1: 动态 Prompt 推理生成测试
 *
 * 验证核心目标：
 *   - LLM 先推理任务本质，再动态生成任务专属 Prompt
 *   - 任务分析包含：任务类型、关键约束、风险点、推荐策略
 *   - 动态 Prompt 根据任务分析结果定制化构建
 *   - 分析失败时降级为静态 Prompt
 *   - 任务分析结果注入到规划 Prompt 中
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

describe('P2-1: 动态 Prompt 推理生成', () => {
  describe('analyzeTaskNature', () => {
    it('应推理任务本质并返回结构化任务分析', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue(
        JSON.stringify({
          taskType: 'code_refactoring',
          essence: '将认证系统从回调风格迁移到Promise风格',
          keyConstraints: ['保持向后兼容', '不影响现有API调用方'],
          riskPoints: ['遗漏边界用例', '异步错误处理不当'],
          recommendedStrategy: '先编写适配层，逐步迁移，保留旧接口',
          complexity: 'high',
        })
      );
      const planner = new Planner(deps);

      const analysis = await planner.analyzeTaskNature(
        '重构认证系统从回调风格迁移到Promise风格'
      );

      expect(analysis.taskType).toBe('code_refactoring');
      expect(analysis.essence).toContain('迁移');
      expect(analysis.keyConstraints).toHaveLength(2);
      expect(analysis.riskPoints).toHaveLength(2);
      expect(analysis.recommendedStrategy).toContain('适配层');
      expect(analysis.complexity).toBe('high');
    });

    it('应在LLM返回无效JSON时降级为规则化分析', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue('invalid response');
      const planner = new Planner(deps);

      const analysis = await planner.analyzeTaskNature('搜索天气信息');

      expect(analysis.taskType).toBeTruthy();
      expect(analysis.essence).toBeTruthy();
      expect(analysis.complexity).toBeDefined();
    });

    it('应在LLM异常时安全降级', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockRejectedValue(new Error('LLM 不可用'));
      const planner = new Planner(deps);

      const analysis = await planner.analyzeTaskNature('测试任务');

      expect(analysis.taskType).toBeTruthy();
      expect(analysis.essence).toContain('测试任务');
    });

    it('应缓存任务分析结果避免重复推理', async () => {
      const deps = createMockDeps();
      deps.llm.chat = jest.fn().mockResolvedValue(
        JSON.stringify({
          taskType: 'research',
          essence: '调研',
          keyConstraints: [],
          riskPoints: [],
          recommendedStrategy: '搜索',
          complexity: 'medium',
        })
      );
      const planner = new Planner(deps);

      await planner.analyzeTaskNature('研究AI趋势');
      await planner.analyzeTaskNature('研究AI趋势');

      expect(deps.llm.chat).toHaveBeenCalledTimes(1);
    });
  });

  describe('动态 Prompt 生成集成', () => {
    it('复杂任务规划时应注入任务分析结果到Prompt', async () => {
      const deps = createMockDeps();
      deps.totConfig = { enableTaskNatureAnalysis: true };
      const capturedPrompts: string[] = [];
      deps.llm.chat = jest.fn().mockImplementation((prompt: string) => {
        capturedPrompts.push(prompt);
        if (prompt.includes('任务分析引擎')) {
          return Promise.resolve(
            JSON.stringify({
              taskType: 'migration',
              essence: '数据库迁移',
              keyConstraints: ['数据完整性'],
              riskPoints: ['数据丢失'],
              recommendedStrategy: '分批迁移',
              complexity: 'high',
            })
          );
        }
        if (prompt.includes('候选执行计划')) {
          return Promise.resolve(
            JSON.stringify({
              candidates: [
                {
                  strategy: '分批迁移',
                  reasoning: '迁移分析',
                  steps: [{ id: 's1', description: '分批迁移' }],
                  estimatedRounds: 3,
                },
              ],
            })
          );
        }
        return Promise.resolve(
          JSON.stringify({
            evaluations: [
              {
                candidateIndex: 0,
                feasibilityScore: 0.8,
                reasoning: '可行',
                risks: [],
              },
            ],
          })
        );
      });
      const planner = new Planner(deps);

      await planner.plan(
        createInput('将数据库从MySQL迁移到PostgreSQL'),
        createMockContext()
      );

      // 找到候选生成 Prompt（包含任务本质分析）
      const candidatePrompt = capturedPrompts.find((p) =>
        p.includes('候选执行计划')
      );
      expect(candidatePrompt).toBeDefined();
      expect(candidatePrompt!).toContain('任务本质');
      expect(candidatePrompt!).toContain('数据库迁移');
      expect(candidatePrompt!).toContain('推荐策略');
    });

    it('任务分析应影响规划Prompt的推理引导', async () => {
      const deps = createMockDeps();
      deps.totConfig = { enableTaskNatureAnalysis: true };
      const capturedPrompts: string[] = [];
      deps.llm.chat = jest.fn().mockImplementation((prompt: string) => {
        capturedPrompts.push(prompt);
        if (prompt.includes('任务分析引擎')) {
          return Promise.resolve(
            JSON.stringify({
              taskType: 'refactoring',
              essence: '重构',
              keyConstraints: ['向后兼容'],
              riskPoints: ['破坏现有功能'],
              recommendedStrategy: '渐进式重构',
              complexity: 'high',
            })
          );
        }
        if (prompt.includes('候选执行计划')) {
          return Promise.resolve(
            JSON.stringify({
              candidates: [
                {
                  strategy: '渐进式重构',
                  reasoning: '重构',
                  steps: [{ id: 's1', description: '分析' }],
                  estimatedRounds: 2,
                },
              ],
            })
          );
        }
        return Promise.resolve(
          JSON.stringify({
            evaluations: [
              {
                candidateIndex: 0,
                feasibilityScore: 0.8,
                reasoning: '可行',
                risks: [],
              },
            ],
          })
        );
      });
      const planner = new Planner(deps);

      await planner.plan(
        createInput('重构整个项目的错误处理机制，包括日志和异常捕获'),
        createMockContext()
      );

      const candidatePrompt = capturedPrompts.find((p) =>
        p.includes('候选执行计划')
      );
      expect(candidatePrompt).toBeDefined();
      expect(candidatePrompt!).toContain('风险点');
      expect(candidatePrompt!).toContain('向后兼容');
    });
  });
});
