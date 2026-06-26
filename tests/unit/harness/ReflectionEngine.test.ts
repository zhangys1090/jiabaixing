import { ReflectionEngine } from '../../../src/harness/loop/ReflectionEngine';

function createMockLLM(responses: string[]) {
  let callIndex = 0;
  return {
    chat: jest.fn().mockImplementation(() => {
      const response = responses[callIndex % responses.length];
      callIndex++;
      return Promise.resolve(response);
    }),
  };
}

describe('ReflectionEngine', () => {
  describe('reflect', () => {
    it('should parse LLM response and return reflection result', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: '参数路径不存在',
          correctedArgs: { path: '/correct/path' },
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      const result = await engine.reflect(
        'file_read',
        { path: '/wrong/path' },
        'File not found',
        { traceId: 'test', loopCount: 0 }
      );

      expect(result.rootCause).toBe('参数路径不存在');
      expect(result.correctedArgs).toEqual({ path: '/correct/path' });
      expect(result.alternativeTool).toBeNull();
      expect(result.shouldRetry).toBe(true);
    });

    it('should suggest alternative tool', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: '工具不可用',
          correctedArgs: null,
          alternativeTool: 'shell_exec',
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      const result = await engine.reflect(
        'file_read',
        { path: '/some/file' },
        'Permission denied',
        { traceId: 'test', loopCount: 0 }
      );

      expect(result.alternativeTool).toBe('shell_exec');
      expect(result.shouldRetry).toBe(true);
    });

    it('should suggest not to retry for fundamental errors', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: '参数逻辑错误，重试无意义',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: false,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      const result = await engine.reflect(
        'web_search',
        { query: '' },
        'Empty query',
        { traceId: 'test', loopCount: 2 }
      );

      expect(result.shouldRetry).toBe(false);
    });

    it('should fallback when LLM returns invalid JSON', async () => {
      const llm = createMockLLM(['not json at all']);
      const engine = new ReflectionEngine(llm);

      const result = await engine.reflect(
        'file_read',
        { path: '/test' },
        'Some error',
        { traceId: 'test', loopCount: 0 }
      );

      expect(result.rootCause).toContain('file_read');
      expect(result.shouldRetry).toBe(true);
    });

    it('should fallback when LLM throws error', async () => {
      const llm = {
        chat: jest.fn().mockRejectedValue(new Error('LLM unavailable')),
      };
      const engine = new ReflectionEngine(llm);

      const result = await engine.reflect(
        'file_read',
        { path: '/test' },
        'Some error',
        { traceId: 'test', loopCount: 0 }
      );

      expect(result.rootCause).toContain('file_read');
      expect(result.correctedArgs).toBeNull();
    });

    it('should include similar experience in prompt', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/old/path' },
        error: 'File not found',
        rootCause: '路径不存在',
        resolution: '修正路径后成功',
        success: true,
      });

      await engine.reflect(
        'file_read',
        { path: '/new/path' },
        'File not found',
        { traceId: 'test', loopCount: 0 }
      );

      expect(llm.chat).toHaveBeenCalledTimes(1);
      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('历史相似经验');
    });
  });

  describe('deepReflect', () => {
    it('should analyze trajectory and return deep reflection', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          diagnosis: '搜索结果不相关',
          rootCause: '查询关键词太宽泛',
          fixStrategy: '使用更精确的搜索词',
          correctedPlan: [
            {
              stepDescription: '使用精确关键词搜索',
              toolName: 'web_search',
              args: { query: '精确关键词' },
            },
          ],
        }),
      ]);
      const engine = new ReflectionEngine(llm, undefined, {
        enableDeepReflection: true,
      });

      const result = await engine.deepReflect(
        '如何在网上挣钱',
        [
          { toolName: 'web_search', success: true, output: '大量不相关结果' },
          { toolName: 'web_search', success: false, error: '结果不相关' },
        ],
        {
          goalProgress: 0.2,
          suggestedAction: 'replan',
          reason: '搜索结果不相关',
        }
      );

      expect(result.rootCause).toBe('查询关键词太宽泛');
      expect(result.fixStrategy).toBe('使用更精确的搜索词');
      expect(result.correctedPlan).toHaveLength(1);
    });

    it('should skip deep reflection when disabled', async () => {
      const llm = createMockLLM([]);
      const engine = new ReflectionEngine(llm, undefined, {
        enableDeepReflection: false,
      });

      const result = await engine.deepReflect('test', [], {
        goalProgress: 0,
        suggestedAction: 'replan',
        reason: 'test',
      });

      expect(result.diagnosis).toBe('深度反思已禁用');
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('should fallback when LLM returns invalid response', async () => {
      const llm = createMockLLM(['invalid']);
      const engine = new ReflectionEngine(llm);

      const result = await engine.deepReflect(
        'test',
        [{ toolName: 'test', success: false, error: 'err' }],
        { goalProgress: 0, suggestedAction: 'replan', reason: 'failed' }
      );

      expect(result.diagnosis).toBe('深度反思失败，使用规则化分析');
    });
  });

  describe('recordExperience', () => {
    it('should store experience and find similar ones', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/a' },
        error: 'ENOENT: file not found',
        rootCause: '文件路径错误',
        resolution: '修正路径',
        success: true,
      });

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/b' },
        error: 'ENOENT: file not found',
        rootCause: '文件路径错误',
        resolution: '修正路径',
        success: true,
      });

      await engine.reflect(
        'file_read',
        { path: '/c' },
        'ENOENT: file not found',
        { traceId: 'test', loopCount: 0 }
      );

      expect(llm.chat).toHaveBeenCalledTimes(1);
      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('历史相似经验');
      expect(callArg).toContain('文件路径错误');
    });

    it('should limit experience buffer size', () => {
      const llm = createMockLLM([]);
      const engine = new ReflectionEngine(llm, undefined, {
        maxExperienceRecords: 5,
      });

      for (let i = 0; i < 10; i++) {
        engine.recordExperience({
          toolName: `tool_${i}`,
          args: {},
          error: `error_${i}`,
          rootCause: `cause_${i}`,
          resolution: `fix_${i}`,
          success: i % 2 === 0,
        });
      }

      const llm2 = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine2 = new ReflectionEngine(llm2, undefined, {
        maxExperienceRecords: 5,
      });
      for (let i = 0; i < 10; i++) {
        engine2.recordExperience({
          toolName: `tool_${i}`,
          args: {},
          error: `error_${i}`,
          rootCause: `cause_${i}`,
          resolution: `fix_${i}`,
          success: i % 2 === 0,
        });
      }

      expect((engine2 as any).experienceBuffer.length).toBeLessThanOrEqual(5);
    });
  });

  describe('integration with TrajectoryDatabase', () => {
    it('should persist experience to TrajectoryDatabase when available', () => {
      const mockDb = {
        recordExecution: jest.fn(),
      };
      const llm = createMockLLM([]);
      const engine = new ReflectionEngine(llm, mockDb as any);

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/test' },
        error: 'not found',
        rootCause: '路径错误',
        resolution: '修正路径',
        success: true,
      });

      expect(mockDb.recordExecution).toHaveBeenCalledTimes(1);
      const callArg = mockDb.recordExecution.mock.calls[0][0];
      expect(callArg.intent).toBe('reflection:file_read');
      expect(callArg.status).toBe('success');
    });

    it('should handle TrajectoryDatabase errors gracefully', () => {
      const mockDb = {
        recordExecution: jest.fn().mockImplementation(() => {
          throw new Error('DB error');
        }),
      };
      const llm = createMockLLM([]);
      const engine = new ReflectionEngine(llm, mockDb as any);

      expect(() => {
        engine.recordExperience({
          toolName: 'file_read',
          args: {},
          error: 'err',
          rootCause: 'cause',
          resolution: 'fix',
          success: false,
        });
      }).not.toThrow();
    });
  });

  describe('setTrajectoryDatabase: 动态注入修复经验持久化断裂', () => {
    it('应在动态注入后通过 reflect() 检索历史失败经验', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      // 创建时不传 trajectoryDb（模拟 initHarness 的断裂场景）
      const engine = new ReflectionEngine(llm);

      const mockDb = {
        recordExecution: jest.fn(),
        querySimilarTasks: jest.fn().mockReturnValue([
          {
            execution: {
              input: '历史失败: file_read 路径错误',
              status: 'failed',
              quality_overall: 0.2,
            },
          },
        ]),
      };

      // 动态注入 — 修复断裂
      engine.setTrajectoryDatabase(mockDb as any);

      await engine.reflect('file_read', { path: '/x' }, 'File not found', {
        traceId: 't1',
        loopCount: 0,
      });

      expect(mockDb.querySimilarTasks).toHaveBeenCalledTimes(1);
      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('历史失败经验');
      expect(callArg).toContain('历史失败: file_read');
    });

    it('应在动态注入后通过 recordExperience() 持久化经验', () => {
      const llm = createMockLLM([]);
      const engine = new ReflectionEngine(llm);

      const mockDb = {
        recordExecution: jest.fn(),
        querySimilarTasks: jest.fn().mockReturnValue([]),
      };

      engine.setTrajectoryDatabase(mockDb as any);

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/test' },
        error: 'not found',
        rootCause: '路径错误',
        resolution: '修正路径',
        success: true,
      });

      expect(mockDb.recordExecution).toHaveBeenCalledTimes(1);
      const callArg = mockDb.recordExecution.mock.calls[0][0];
      expect(callArg.intent).toBe('reflection:file_read');
    });

    it('应在动态注入后通过 reflectOnTaskFailure() 检索历史任务失败经验', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          taskDiagnosis: '诊断',
          rootCause: '根因',
          strategyAdjustment: '策略',
          correctedPlan: null,
          lessonsLearned: '教训',
          confidence: 0.6,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      const mockDb = {
        recordExecution: jest.fn(),
        querySimilarTasks: jest.fn().mockReturnValue([
          {
            execution: {
              input: '历史失败任务: 搜索医疗AI',
              status: 'failed',
              quality_overall: 0.1,
            },
          },
        ]),
      };

      engine.setTrajectoryDatabase(mockDb as any);

      await engine.reflectOnTaskFailure({
        userInput: '当前任务',
        taskGoal: '目标',
        executionTrace: [],
        failures: [],
        goalProgress: 0,
        roundsUsed: 1,
      });

      expect(mockDb.querySimilarTasks).toHaveBeenCalledTimes(1);
      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('历史任务失败经验');
      expect(callArg).toContain('历史失败任务: 搜索医疗AI');
    });

    it('应在动态注入后持久化任务级反思经验', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          taskDiagnosis: '诊断',
          rootCause: '根因',
          strategyAdjustment: '策略',
          correctedPlan: null,
          lessonsLearned: '教训',
          confidence: 0.8,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      const mockDb = {
        recordExecution: jest.fn(),
        querySimilarTasks: jest.fn().mockReturnValue([]),
      };

      engine.setTrajectoryDatabase(mockDb as any);

      await engine.reflectOnTaskFailure({
        userInput: '任务',
        taskGoal: '目标',
        executionTrace: [],
        failures: [],
        goalProgress: 0,
        roundsUsed: 1,
      });

      // recordExecution 被调用：1次任务级反思经验持久化
      expect(mockDb.recordExecution).toHaveBeenCalledTimes(1);
      const callArg = mockDb.recordExecution.mock.calls[0][0];
      expect(callArg.intent).toBe('task_reflection');
      expect(callArg.status).toBe('success');
    });

    it('应在未注入 TrajectoryDatabase 时不崩溃', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      // 不调用 setTrajectoryDatabase，trajectoryDb 为 undefined
      const result = await engine.reflect('file_read', {}, 'error', {
        traceId: 't1',
        loopCount: 0,
      });

      expect(result.rootCause).toBeTruthy();
      expect(result.shouldRetry).toBe(true);
    });
  });

  describe('P2-7: 反思引擎效果度量', () => {
    it('应追踪反思次数', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      await engine.reflect('file_read', { path: '/a' }, 'error', {
        traceId: 't1',
        loopCount: 0,
      });
      await engine.reflect('web_search', { query: 'test' }, 'timeout', {
        traceId: 't2',
        loopCount: 1,
      });

      const metrics = engine.getReflectionMetrics();
      expect(metrics.totalReflections).toBe(2);
    });

    it('应计算重试成功率', () => {
      const llm = createMockLLM([]);
      const engine = new ReflectionEngine(llm);

      engine.recordExperience({
        toolName: 'file_read',
        args: {},
        error: 'e1',
        rootCause: 'c1',
        resolution: 'r1',
        success: true,
      });
      engine.recordExperience({
        toolName: 'file_read',
        args: {},
        error: 'e2',
        rootCause: 'c2',
        resolution: 'r2',
        success: true,
      });
      engine.recordExperience({
        toolName: 'file_read',
        args: {},
        error: 'e3',
        rootCause: 'c3',
        resolution: 'r3',
        success: false,
      });

      const metrics = engine.getReflectionMetrics();
      expect(metrics.retrySuccessRate).toBeCloseTo(2 / 3);
    });

    it('应计算经验复用率', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/a' },
        error: 'ENOENT',
        rootCause: '路径错误',
        resolution: '修正',
        success: true,
      });

      await engine.reflect('file_read', { path: '/b' }, 'ENOENT', {
        traceId: 't1',
        loopCount: 0,
      });
      await engine.reflect('web_search', { query: 'x' }, 'timeout', {
        traceId: 't2',
        loopCount: 0,
      });

      const metrics = engine.getReflectionMetrics();
      expect(metrics.experienceReuseRate).toBe(0.5);
      expect(metrics.experienceRecordCount).toBe(1);
    });

    it('应追踪深度反思成功率', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          diagnosis: 'd1',
          rootCause: 'r1',
          fixStrategy: 'f1',
          correctedPlan: null,
        }),
        'invalid json',
      ]);
      const engine = new ReflectionEngine(llm, undefined, {
        enableDeepReflection: true,
      });

      await engine.deepReflect('test', [{ toolName: 't', success: false }], {
        goalProgress: 0,
        suggestedAction: 'replan',
        reason: 'fail',
      });
      await engine.deepReflect('test2', [{ toolName: 't', success: false }], {
        goalProgress: 0,
        suggestedAction: 'replan',
        reason: 'fail',
      });

      const metrics = engine.getReflectionMetrics();
      expect(metrics.deepReflectionSuccessRate).toBe(0.5);
    });

    it('无数据时度量应返回零值', () => {
      const llm = createMockLLM([]);
      const engine = new ReflectionEngine(llm);

      const metrics = engine.getReflectionMetrics();
      expect(metrics.totalReflections).toBe(0);
      expect(metrics.retrySuccessRate).toBe(0);
      expect(metrics.deepReflectionSuccessRate).toBe(0);
      expect(metrics.experienceReuseRate).toBe(0);
    });
  });

  describe('semantic experience matching', () => {
    it('should rank same-tool experiences higher than different-tool ones', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      engine.recordExperience({
        toolName: 'web_search',
        args: { query: 'test' },
        error: 'network timeout',
        rootCause: '网络超时',
        resolution: '重试',
        success: true,
      });

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/a' },
        error: 'network timeout',
        rootCause: '网络超时',
        resolution: '重试',
        success: true,
      });

      await engine.reflect('file_read', { path: '/b' }, 'network timeout', {
        traceId: 'test',
        loopCount: 0,
      });

      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('历史相似经验');
      expect(callArg).toContain('file_read');
    });

    it('should match errors by error type category', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/a' },
        error: 'EPERM: operation not permitted',
        rootCause: '权限不足',
        resolution: '使用shell_exec替代',
        success: true,
      });

      await engine.reflect(
        'file_read',
        { path: '/b' },
        'EACCES: permission denied',
        { traceId: 'test', loopCount: 0 }
      );

      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('权限不足');
    });

    it('should prefer recent experiences over old ones', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          rootCause: 'test',
          correctedArgs: null,
          alternativeTool: null,
          shouldRetry: true,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/old' },
        error: 'ENOENT: not found',
        rootCause: '旧经验',
        resolution: '旧方案',
        success: true,
      });

      const recentEngine = engine as any;
      recentEngine.experienceBuffer[
        recentEngine.experienceBuffer.length - 1
      ].timestamp = Date.now() - 100 * 24 * 60 * 60 * 1000;

      engine.recordExperience({
        toolName: 'file_read',
        args: { path: '/new' },
        error: 'ENOENT: not found',
        rootCause: '新经验',
        resolution: '新方案',
        success: true,
      });

      await engine.reflect('file_read', { path: '/c' }, 'ENOENT: not found', {
        traceId: 'test',
        loopCount: 0,
      });

      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('新经验');
    });
  });

  describe('P2-3: 任务级反思闭环 reflectOnTaskFailure', () => {
    it('应对任务失败进行全局诊断并返回修正计划', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          taskDiagnosis: '任务目标理解偏差，搜索方向错误',
          rootCause: '未识别用户真实意图，导致整个搜索路径偏离',
          strategyAdjustment: '重新分析用户意图，调整搜索策略',
          correctedPlan: [
            {
              stepDescription: '重新分析用户意图',
              toolName: 'web_search',
              args: { query: '精确意图关键词' },
            },
            {
              stepDescription: '基于精确结果总结',
            },
          ],
          lessonsLearned: '复杂查询需先明确意图再执行',
          confidence: 0.85,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      const result = await engine.reflectOnTaskFailure({
        userInput: '帮我研究AI在医疗领域的应用',
        taskGoal: '生成医疗AI应用研究报告',
        executionTrace: [
          {
            toolName: 'web_search',
            args: { query: 'AI' },
            success: true,
            output: '大量不相关结果',
            duration: 1200,
          },
          {
            toolName: 'web_search',
            args: { query: '医疗' },
            success: false,
            error: '结果过于宽泛',
            duration: 800,
          },
        ],
        failures: [
          {
            toolName: 'web_search',
            error: '结果过于宽泛',
            stepDescription: '搜索医疗相关信息',
          },
        ],
        goalProgress: 0.15,
        roundsUsed: 3,
      });

      expect(result.taskDiagnosis).toContain('任务目标理解偏差');
      expect(result.rootCause).toContain('未识别用户真实意图');
      expect(result.strategyAdjustment).toContain('重新分析用户意图');
      expect(result.correctedPlan).toHaveLength(2);
      expect(result.correctedPlan![0].toolName).toBe('web_search');
      expect(result.lessonsLearned).toContain('复杂查询');
      expect(result.confidence).toBe(0.85);
    });

    it('应在LLM返回无效JSON时降级为规则化分析', async () => {
      const llm = createMockLLM(['invalid response']);
      const engine = new ReflectionEngine(llm);

      const result = await engine.reflectOnTaskFailure({
        userInput: '测试任务',
        taskGoal: '测试目标',
        executionTrace: [
          {
            toolName: 'file_read',
            args: { path: '/test' },
            success: false,
            error: '文件不存在',
            duration: 100,
          },
        ],
        failures: [
          {
            toolName: 'file_read',
            error: '文件不存在',
            stepDescription: '读取文件',
          },
        ],
        goalProgress: 0,
        roundsUsed: 2,
      });

      expect(result.taskDiagnosis).toContain('规则化分析');
      expect(result.rootCause).toBeTruthy();
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('应在LLM调用异常时安全降级', async () => {
      const llm = {
        chat: jest.fn().mockRejectedValue(new Error('LLM 不可用')),
      };
      const engine = new ReflectionEngine(llm as any);

      const result = await engine.reflectOnTaskFailure({
        userInput: '测试',
        taskGoal: '目标',
        executionTrace: [],
        failures: [],
        goalProgress: 0,
        roundsUsed: 0,
      });

      expect(result.taskDiagnosis).toContain('降级');
      expect(result.correctedPlan).toBeUndefined();
    });

    it('应注入历史任务失败经验到反思Prompt', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          taskDiagnosis: '诊断',
          rootCause: '根因',
          strategyAdjustment: '策略调整',
          correctedPlan: null,
          lessonsLearned: '教训',
          confidence: 0.5,
        }),
      ]);
      const mockDb = {
        recordExecution: jest.fn(),
        querySimilarTasks: jest.fn().mockReturnValue([
          {
            execution: {
              input: '类似失败任务',
              status: 'failed',
              quality_overall: 0.2,
            },
            toolInvocations: [],
            relevanceScore: 0.8,
          },
        ]),
      };
      const engine = new ReflectionEngine(llm, mockDb as any);

      await engine.reflectOnTaskFailure({
        userInput: '当前失败任务',
        taskGoal: '目标',
        executionTrace: [
          {
            toolName: 'web_search',
            args: {},
            success: false,
            error: '失败',
            duration: 100,
          },
        ],
        failures: [
          { toolName: 'web_search', error: '失败', stepDescription: '搜索' },
        ],
        goalProgress: 0.1,
        roundsUsed: 2,
      });

      const callArg = llm.chat.mock.calls[0][0];
      expect(callArg).toContain('历史任务失败经验');
      expect(callArg).toContain('类似失败任务');
    });

    it('应记录任务级反思经验供后续复用', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          taskDiagnosis: '诊断',
          rootCause: '根因',
          strategyAdjustment: '策略',
          correctedPlan: null,
          lessonsLearned: '重要教训',
          confidence: 0.7,
        }),
      ]);
      const engine = new ReflectionEngine(llm);

      await engine.reflectOnTaskFailure({
        userInput: '任务',
        taskGoal: '目标',
        executionTrace: [],
        failures: [],
        goalProgress: 0,
        roundsUsed: 1,
      });

      const experiences = engine.getTaskReflectionExperiences();
      expect(experiences).toHaveLength(1);
      expect(experiences[0].lessonsLearned).toBe('重要教训');
    });

    it('应追踪任务级反思度量指标', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          taskDiagnosis: 'd1',
          rootCause: 'r1',
          strategyAdjustment: 's1',
          correctedPlan: [{ stepDescription: '步骤' }],
          lessonsLearned: 'l1',
          confidence: 0.8,
        }),
        'invalid',
      ]);
      const engine = new ReflectionEngine(llm);

      await engine.reflectOnTaskFailure({
        userInput: 'task1',
        taskGoal: 'goal1',
        executionTrace: [],
        failures: [],
        goalProgress: 0,
        roundsUsed: 1,
      });
      await engine.reflectOnTaskFailure({
        userInput: 'task2',
        taskGoal: 'goal2',
        executionTrace: [],
        failures: [],
        goalProgress: 0,
        roundsUsed: 1,
      });

      const metrics = engine.getReflectionMetrics();
      expect(metrics.taskReflections).toBe(2);
      expect(metrics.taskReflectionSuccessRate).toBe(0.5);
    });
  });
});
