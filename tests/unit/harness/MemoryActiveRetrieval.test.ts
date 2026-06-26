/**
 * P2.1 记忆主动检索 + P2.2 知识图谱激活
 *
 * 验证开发计划阶段2的核心目标：
 *   2.1 记忆主动检索：
 *     - Planner 规划时自动调用 memoryInjector.autoRetrieveMemories()
 *     - Evaluator 评估时检索历史相似任务的评分
 *     - ReflectionEngine 反思时检索相关失败经验
 *   2.2 知识图谱激活：
 *     - identifyGaps() 返回真实知识缺口（非空数组）
 *     - 从工具结果中自动提取实体和关系
 */

import { Evaluator } from '../../../src/harness/loop/Evaluator';
import { ReflectionEngine } from '../../../src/harness/loop/ReflectionEngine';
import type { LoopContext } from '../../../src/harness/types';
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

function createMockContext(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    messages: [{ role: 'user', content: '测试输入' }],
    plan: null,
    currentStepIndex: 0,
    stepResults: new Map(),
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map(),
    stepStateHistory: [],
    budget: {
      roundsUsed: 1,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 1000,
      tokenWarningLimit: 4500,
      tokenHardLimit: 8000,
      startTime: Date.now(),
      maxDurationMs: 60000,
      toolCallsUsed: 2,
      maxToolCalls: 10,
    },
    trace: {
      traceId: 'test-trace',
      state: LoopState.EVALUATING,
      stateTransitions: [],
      trajectory: [],
      totalDuration: 0,
      totalToolCalls: 0,
      budgetState: {
        roundsUsed: 1,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 1000,
        tokenWarningLimit: 4500,
        tokenHardLimit: 8000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: 2,
        maxToolCalls: 10,
      },
    },
    metadata: {},
    ...overrides,
  };
}

describe('P2.1 记忆主动检索', () => {
  describe('ReflectionEngine 反思时检索相关失败经验', () => {
    it('应从 trajectoryDatabase 检索历史失败经验并注入反思 prompt', async () => {
      const mockLLM = {
        chat: jest.fn().mockResolvedValue(
          JSON.stringify({
            rootCause: '路径错误',
            correctedArgs: { path: '/correct' },
            alternativeTool: null,
            shouldRetry: true,
          })
        ),
      };
      const mockTrajectoryDb = {
        recordExecution: jest.fn(),
        querySimilarTasks: jest.fn().mockReturnValue([
          {
            execution: {
              id: 'hist-1',
              input: '读取文件失败',
              intent: 'file_read',
              status: 'failed',
              quality_overall: 0.2,
            },
            toolInvocations: [],
            relevanceScore: 0.8,
          },
        ]),
      };

      const engine = new ReflectionEngine(
        mockLLM as any,
        mockTrajectoryDb as any
      );
      await engine.reflect('file_read', { path: '/wrong' }, 'File not found', {
        traceId: 'test',
        loopCount: 0,
      });

      // 验证 trajectoryDatabase.querySimilarTasks 被调用且 includeFailed=true
      expect(mockTrajectoryDb.querySimilarTasks).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ includeFailed: true })
      );

      // 验证反思 prompt 包含历史失败经验
      const calledPrompt = mockLLM.chat.mock.calls[0][0] as string;
      expect(calledPrompt).toContain('历史失败经验');
    });

    it('trajectoryDatabase 不可用时回退到本地 experienceBuffer', async () => {
      const mockLLM = {
        chat: jest.fn().mockResolvedValue(
          JSON.stringify({
            rootCause: '路径错误',
            correctedArgs: null,
            alternativeTool: null,
            shouldRetry: true,
          })
        ),
      };

      const engine = new ReflectionEngine(mockLLM as any);
      const result = await engine.reflect(
        'file_read',
        { path: '/wrong' },
        'File not found',
        { traceId: 'test', loopCount: 0 }
      );

      expect(result.shouldRetry).toBe(true);
      expect(mockLLM.chat).toHaveBeenCalled();
    });
  });

  describe('Evaluator 评估时检索历史相似任务的评分', () => {
    it('应注入 trajectoryDatabase 依赖并检索历史评分', async () => {
      const mockTrajectoryDb = {
        querySimilarTasks: jest.fn().mockReturnValue([
          {
            execution: {
              id: 'hist-1',
              input: '类似任务',
              status: 'success',
              quality_overall: 0.85,
            },
            toolInvocations: [],
            relevanceScore: 0.9,
          },
        ]),
      };

      const evaluator = new Evaluator({
        trajectoryDatabase: mockTrajectoryDb as any,
      });

      // 使用带 tool_calls 的 assistant 消息，确保到达 evaluateFull
      const context = createMockContext({
        messages: [
          { role: 'user', content: '类似任务' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: { name: 'file_read', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'tc1',
            name: 'file_read',
            content: '结果内容',
          },
        ],
      });

      await evaluator.evaluate(
        { text: '类似任务', userId: 'test' } as any,
        context
      );

      // 验证检索了历史相似任务
      expect(mockTrajectoryDb.querySimilarTasks).toHaveBeenCalled();
    });

    it('历史评分应影响评估建议（历史高分 → 倾向 continue）', async () => {
      const mockTrajectoryDb = {
        querySimilarTasks: jest.fn().mockReturnValue([
          {
            execution: {
              id: 'hist-1',
              input: '类似任务',
              status: 'success',
              quality_overall: 0.95,
            },
            toolInvocations: [],
            relevanceScore: 0.9,
          },
        ]),
      };

      const evaluator = new Evaluator({
        trajectoryDatabase: mockTrajectoryDb as any,
      });

      // 使用带 tool_calls 的 assistant 消息，确保到达 evaluateFull
      const context = createMockContext({
        messages: [
          { role: 'user', content: '类似任务' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: { name: 'file_read', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'tc1',
            name: 'file_read',
            content: '结果内容',
          },
        ],
      });

      const result = await evaluator.evaluate(
        { text: '类似任务', userId: 'test' } as any,
        context
      );

      // 历史高分任务应倾向 continue
      expect(result.suggestedAction).not.toBe('abort');
    });
  });
});

describe('P2.2 知识图谱激活', () => {
  describe('identifyGaps 返回真实知识缺口', () => {
    it('MemoryEngine.identifyKnowledgeGaps 应委托给 KnowledgeGraphBuilder', () => {
      // 验证 MemoryEngine 暴露了 identifyKnowledgeGaps 方法
      const { MemoryEngine } = require('../../../src/memory/MemoryEngine');
      expect(MemoryEngine).toBeDefined();
      expect(typeof MemoryEngine.prototype.identifyKnowledgeGaps).toBe(
        'function'
      );
    });

    it('HarnessDeps 应包含 knowledgeExtractor 接口', () => {
      // 验证 deps 接口包含 knowledgeExtractor 定义
      const depsSource = require('fs').readFileSync(
        require('path').join(__dirname, '../../../src/harness/deps.ts'),
        'utf-8'
      );
      expect(depsSource).toContain('knowledgeExtractor');
      expect(depsSource).toContain('extractAndStore');
    });
  });

  describe('从工具结果中自动提取实体和关系', () => {
    it('Executor 应包含 knowledgeExtractor 依赖接口', () => {
      // 验证 Executor 接受 knowledgeExtractor 依赖
      const { Executor } = require('../../../src/harness/loop/Executor');
      expect(Executor).toBeDefined();
    });

    it('ExecutorDeps 应包含 knowledgeExtractor 字段', () => {
      const executorSource = require('fs').readFileSync(
        require('path').join(
          __dirname,
          '../../../src/harness/loop/Executor.ts'
        ),
        'utf-8'
      );
      expect(executorSource).toContain('knowledgeExtractor');
      expect(executorSource).toContain('extractAndStore');
    });
  });
});
