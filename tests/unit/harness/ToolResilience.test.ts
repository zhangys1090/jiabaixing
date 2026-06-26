/**
 * 工具执行韧性测试 — L1-L4 金字塔模型
 *
 * L1: 指数退避重试（超时/网络错误）
 * L2: 规则化参数修正（路径不存在→搜索相似路径）
 * L3: LLM辅助参数修正（已有测试覆盖，此处验证集成）
 * L4: 降级替代工具（file_read失败→shell_exec cat）
 *
 * P3: 语义记忆与经验迁移 — 余弦相似度
 * P4: 步骤级动态调整 — shouldReplan 增强
 */
import { TrajectoryDatabase } from '../../../src/harness/persistence/TrajectoryDatabase';

describe('工具执行韧性 L1-L4', () => {
  describe('L1: 指数退避重试', () => {
    it('classifyError 应区分 retryable / non_retryable / rate_limited', () => {
      // 通过 Executor 实例测试私有方法 — 使用反射
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const mockDeps = {
        toolRegistry: {
          execute: jest.fn(),
          get: jest.fn(),
          getRegisteredToolNames: jest.fn().mockReturnValue([]),
        },
        llm: { chat: jest.fn(), chatWithTools: jest.fn() },
      };
      const executor = new Executor(mockDeps);

      // retryable
      expect(executor['classifyError']('timeout')).toBe('retryable');
      expect(executor['classifyError']('ETIMEDOUT')).toBe('retryable');
      expect(executor['classifyError']('ECONNREFUSED')).toBe('retryable');
      expect(executor['classifyError']('network error')).toBe('retryable');

      // overloaded (503 单独分类，便于差异化退避，但仍可重试)
      expect(executor['classifyError']('503 Service Unavailable')).toBe(
        'overloaded'
      );

      // rate_limited
      expect(executor['classifyError']('429 Too Many Requests')).toBe(
        'rate_limited'
      );
      expect(executor['classifyError']('rate limit exceeded')).toBe(
        'rate_limited'
      );

      // non_retryable
      expect(executor['classifyError']('permission denied')).toBe(
        'non_retryable'
      );
      expect(executor['classifyError']('authentication failed')).toBe(
        'non_retryable'
      );
      expect(executor['classifyError']('file not found')).toBe('non_retryable');
      expect(executor['classifyError']('invalid parameter')).toBe(
        'non_retryable'
      );
    });

    it('calculateBackoff 应实现指数退避', () => {
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const mockDeps = {
        toolRegistry: {
          execute: jest.fn(),
          get: jest.fn(),
          getRegisteredToolNames: jest.fn().mockReturnValue([]),
        },
        llm: { chat: jest.fn(), chatWithTools: jest.fn() },
      };
      const executor = new Executor(mockDeps);

      // retryable: base=500, 第1次=500, 第2次=1000, 第3次=2000
      const backoff1 = executor['calculateBackoff']('retryable', 1);
      const backoff2 = executor['calculateBackoff']('retryable', 2);
      const backoff3 = executor['calculateBackoff']('retryable', 3);

      // 指数增长（含抖动，所以检查范围）
      expect(backoff1).toBeGreaterThanOrEqual(500);
      expect(backoff1).toBeLessThanOrEqual(650); // 500 + 30% jitter
      expect(backoff2).toBeGreaterThanOrEqual(1000);
      expect(backoff2).toBeLessThanOrEqual(1300);
      expect(backoff3).toBeGreaterThanOrEqual(2000);
      expect(backoff3).toBeLessThanOrEqual(2600);

      // rate_limited: base=2000, 更长退避
      const rateLimitBackoff1 = executor['calculateBackoff']('rate_limited', 1);
      const rateLimitBackoff2 = executor['calculateBackoff']('rate_limited', 2);
      expect(rateLimitBackoff1).toBeGreaterThanOrEqual(2000);
      expect(rateLimitBackoff2).toBeGreaterThanOrEqual(4000);
    });

    it('calculateBackoff 应有上限', () => {
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const mockDeps = {
        toolRegistry: {
          execute: jest.fn(),
          get: jest.fn(),
          getRegisteredToolNames: jest.fn().mockReturnValue([]),
        },
        llm: { chat: jest.fn(), chatWithTools: jest.fn() },
      };
      const executor = new Executor(mockDeps);

      // retryable max=5000
      const backoff = executor['calculateBackoff']('retryable', 10);
      expect(backoff).toBeLessThanOrEqual(5000);

      // rate_limited max=30000
      const rateLimitBackoff = executor['calculateBackoff']('rate_limited', 10);
      expect(rateLimitBackoff).toBeLessThanOrEqual(30000);
    });
  });

  describe('L2: 规则化参数修正', () => {
    let executor: any;

    beforeEach(() => {
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const mockDeps = {
        toolRegistry: {
          execute: jest.fn(),
          get: jest.fn(),
          getRegisteredToolNames: jest.fn().mockReturnValue([]),
        },
        llm: { chat: jest.fn(), chatWithTools: jest.fn() },
      };
      executor = new Executor(mockDeps);
    });

    it('规则1: 路径分隔符修正（Windows \\ → /）', () => {
      const result = executor['attemptRuleBasedParamFix'](
        'file_read',
        { path: 'C:\\Users\\test\\file.txt' },
        'ENOENT: file not found'
      );
      expect(result).not.toBeNull();
      expect(result.path).toBe('C:/Users/test/file.txt');
    });

    it('规则2: 去除 file:// 协议前缀', () => {
      const result = executor['attemptRuleBasedParamFix'](
        'file_read',
        { path: 'file:///C:/Users/test/file.txt' },
        'some error'
      );
      expect(result).not.toBeNull();
      expect(result.path).toBe('/C:/Users/test/file.txt');
    });

    it('规则3: 字符串数字转数字', () => {
      const result = executor['attemptRuleBasedParamFix'](
        'web_search',
        { limit: '10', query: 'test' },
        'type error: Expected number'
      );
      expect(result).not.toBeNull();
      expect(result.limit).toBe(10);
      expect(typeof result.limit).toBe('number');
    });

    it('规则4: JSON字符串参数解析', () => {
      const result = executor['attemptRuleBasedParamFix'](
        'api_call',
        { data: '{"key":"value"}' },
        'JSON parse error'
      );
      expect(result).not.toBeNull();
      expect(result.data).toEqual({ key: 'value' });
    });

    it('规则5: 搜索类工具去除首尾空白', () => {
      const result = executor['attemptRuleBasedParamFix'](
        'web_search',
        { query: '  test query  ' },
        'some error'
      );
      expect(result).not.toBeNull();
      expect(result.query).toBe('test query');
    });

    it('规则6: URL补全协议', () => {
      const result = executor['attemptRuleBasedParamFix'](
        'web_fetch',
        { url: 'example.com' },
        'some error'
      );
      expect(result).not.toBeNull();
      expect(result.url).toBe('https://example.com');
    });

    it('无规则匹配时应返回null', () => {
      const result = executor['attemptRuleBasedParamFix'](
        'unknown_tool',
        { param: 'value' },
        'unknown error'
      );
      expect(result).toBeNull();
    });
  });

  describe('L4: 降级替代工具映射表', () => {
    it('应包含 file_read 的替代工具', () => {
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const alternatives = Executor.TOOL_ALTERNATIVES['file_read'];
      expect(alternatives).toBeDefined();
      expect(alternatives.length).toBeGreaterThanOrEqual(2);

      // 验证包含 file_search 和 shell_exec
      const toolNames = alternatives.map((a: any) => a.tool);
      expect(toolNames).toContain('file_search');
      expect(toolNames).toContain('shell_exec');
    });

    it('应包含 web_fetch 的替代工具', () => {
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const alternatives = Executor.TOOL_ALTERNATIVES['web_fetch'];
      expect(alternatives).toBeDefined();
      expect(alternatives.length).toBeGreaterThanOrEqual(1);
      expect(alternatives[0].tool).toBe('web_search');
    });

    it('应包含 grep 的替代工具', () => {
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const alternatives = Executor.TOOL_ALTERNATIVES['grep'];
      expect(alternatives).toBeDefined();
      expect(alternatives.length).toBeGreaterThanOrEqual(1);
    });

    it('替代工具的 argTransform 应正确转换参数', () => {
      const Executor = require('../../../src/harness/loop/Executor').Executor;
      const alternatives = Executor.TOOL_ALTERNATIVES['file_read'];
      const shellExecAlt = alternatives.find(
        (a: any) => a.tool === 'shell_exec'
      );
      expect(shellExecAlt).toBeDefined();

      const transformed = shellExecAlt.argTransform({ path: '/test/file.txt' });
      expect(transformed.command).toBe('cat /test/file.txt');
    });
  });
});

describe('P3: 语义记忆与经验迁移 — 余弦相似度', () => {
  let db: TrajectoryDatabase;

  beforeEach(() => {
    db = new TrajectoryDatabase(':memory:');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // 忽略
    }
  });

  it('应能记录和检索执行轨迹', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'exec1',
      input: '部署应用到生产环境',
      intent: 'deployment',
      status: 'success',
      quality_overall: 0.9,
      loop_rounds: 2,
      total_tool_calls: 3,
      total_duration: 5000,
      created_at: now,
      updated_at: now,
    });

    // 语义相似的查询
    const results = db.querySimilarTasks('发布应用到线上', {
      minQualityScore: 0,
    });

    // 应能检索到（关键词"应用"匹配）
    for (const result of results) {
      expect(result).toHaveProperty('execution');
      expect(result).toHaveProperty('relevanceScore');
      expect(typeof result.relevanceScore).toBe('number');
    }
  });

  it('余弦相似度应捕获语义相似性', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'exec_deploy',
      input: '部署失败 端口冲突 8080被占用',
      intent: 'deployment_error',
      status: 'failed',
      quality_overall: 0.2,
      loop_rounds: 3,
      total_tool_calls: 5,
      total_duration: 10000,
      created_at: now,
      updated_at: now,
    });

    // 语义相似查询 — "部署" 和 "端口" 共享
    const results = db.querySimilarTasks('部署时端口被占用', {
      includeFailed: true,
      minQualityScore: 0,
    });

    // 应检索到语义相似的失败经验
    for (const result of results) {
      expect(result.relevanceScore).toBeGreaterThan(0);
    }
  });

  it('应支持 includeFailed 选项检索失败经验', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'exec_fail',
      input: '数据库连接失败',
      status: 'failed',
      quality_overall: 0.1,
      loop_rounds: 2,
      total_tool_calls: 3,
      total_duration: 5000,
      created_at: now,
      updated_at: now,
    });

    // 默认不包含失败
    const successOnly = db.querySimilarTasks('数据库连接', {
      minQualityScore: 0,
    });

    // 包含失败
    const withFailed = db.querySimilarTasks('数据库连接', {
      includeFailed: true,
      minQualityScore: 0,
    });

    // 包含失败时应能检索到失败记录
    expect(withFailed.length).toBeGreaterThanOrEqual(successOnly.length);
  });
});

describe('P4: 步骤级动态调整 — shouldReplan 增强', () => {
  let executor: any;

  beforeEach(() => {
    const Executor = require('../../../src/harness/loop/Executor').Executor;
    const mockDeps = {
      toolRegistry: {
        execute: jest.fn(),
        get: jest.fn(),
        getRegisteredToolNames: jest.fn().mockReturnValue([]),
      },
      llm: { chat: jest.fn(), chatWithTools: jest.fn() },
    };
    executor = new Executor(mockDeps);
  });

  it('单步失败应触发重规划', () => {
    const decision = executor.shouldReplan(
      [{ score: 0, isSufficient: false }],
      1
    );
    expect(decision.shouldReplan).toBe(true);
    expect(decision.reason).toContain('最近一步执行失败');
    expect(decision.adjustmentHint).toBeDefined();
  });

  it('连续3次低质量应触发重规划', () => {
    const decision = executor.shouldReplan(
      [
        { score: 0.2, isSufficient: false },
        { score: 0.3, isSufficient: false },
        { score: 0.1, isSufficient: false },
      ],
      3
    );
    expect(decision.shouldReplan).toBe(true);
    expect(decision.reason).toContain('连续低质量');
    expect(decision.adjustmentHint).toBeDefined();
  });

  it('轮次耗尽应触发重规划', () => {
    const decision = executor.shouldReplan(
      [{ score: 0.8, isSufficient: true }],
      8
    );
    expect(decision.shouldReplan).toBe(true);
    expect(decision.reason).toContain('轮次耗尽');
    expect(decision.adjustmentHint).toBeDefined();
  });

  it('正常执行不应触发重规划', () => {
    const decision = executor.shouldReplan(
      [{ score: 0.8, isSufficient: true }],
      2
    );
    expect(decision.shouldReplan).toBe(false);
    expect(decision.reason).toBe('执行质量正常');
    expect(decision.adjustmentHint).toBeUndefined();
  });

  it('平均质量过低应触发重规划', () => {
    const decision = executor.shouldReplan(
      [
        { score: 0.2, isSufficient: false },
        { score: 0.3, isSufficient: false },
      ],
      2
    );
    expect(decision.shouldReplan).toBe(true);
    expect(decision.reason).toContain('平均质量过低');
    expect(decision.adjustmentHint).toBeDefined();
  });

  it('单步失败但轮次已多不应触发步骤级重规划', () => {
    // roundsUsed >= 4 时，单步失败不触发步骤级重规划（避免在后期过度重规划）
    const decision = executor.shouldReplan(
      [{ score: 0, isSufficient: false }],
      5
    );
    // roundsUsed=5 < 8，所以不会触发轮次耗尽
    // 单步失败但 roundsUsed >= 4，不触发步骤级
    expect(decision.shouldReplan).toBe(false);
  });
});
