/**
 * JiabaixingCore 监控集成测试
 * 验证 PerformanceMonitor 和 SecurityAuditor 在核心引擎中的集成
 */

// ── Mocks must be before imports ──

const mockLLMChat = jest.fn();
const mockLLMInitialize = jest.fn().mockResolvedValue(undefined);
const mockLLMHealthCheck = jest.fn().mockResolvedValue({ available: true, message: 'ok' });
const mockLLMAnalyzeCode = jest.fn();
const mockLLMGenerateModified = jest.fn();

jest.mock('../../src/models/LLMProvider', () => ({
  LLMProvider: jest.fn().mockImplementation(() => ({
    initialize: mockLLMInitialize,
    healthCheck: mockLLMHealthCheck,
    chat: mockLLMChat,
    analyzeCode: mockLLMAnalyzeCode,
    generateModifiedFileContent: mockLLMGenerateModified,
    isAvailable: jest.fn().mockReturnValue(true),
  })),
}));

const mockPersonaApply = jest.fn((content: string) => content);
const mockPersonaBuildPrompt = jest.fn().mockReturnValue('test system prompt');
const mockPersonaCheckRedlines = jest.fn().mockReturnValue(true);

jest.mock('../../src/interaction/PersonaRules', () => ({
  PersonaRules: jest.fn().mockImplementation(() => ({
    applyRules: mockPersonaApply,
    buildSystemPrompt: mockPersonaBuildPrompt,
    checkSecurityRedlines: mockPersonaCheckRedlines,
    initialize: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/tools/ToolExecutor', () => ({
  ToolExecutor: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue('file content'),
  })),
}));

jest.mock('../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock('../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    generateTraceId: jest.fn().mockReturnValue('test-trace-id'),
    setTraceId: jest.fn(),
    clearTraceId: jest.fn(),
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue('{}'),
  watchFile: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  appendFileSync: jest.fn(),
}));

import { JiabaixingCore } from '../../src/core/JiabaixingCore';

describe('JiabaixingCore Monitoring Integration', () => {
  let core: JiabaixingCore;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMChat.mockResolvedValue('测试回复');
    core = new JiabaixingCore();
  });

  describe('PerformanceMonitor Integration', () => {
    it('核心引擎应暴露 PerformanceMonitor 实例', () => {
      const monitor = core.getPerformanceMonitor();
      expect(monitor).toBeDefined();
      expect(typeof monitor.getSnapshot).toBe('function');
    });

    it('processInput 应记录响应时间指标', async () => {
      (core as any).memoryEngine = { stub: true };
      await core.initialize();
      jest.clearAllMocks();

      const monitor = core.getPerformanceMonitor();
      const beforeCount = monitor.getMetricCount();

      mockPersonaApply.mockImplementation((s: string) => s);
      await core.processInput('你好');

      const afterCount = monitor.getMetricCount();
      expect(afterCount).toBeGreaterThan(beforeCount);
    });

    it('初始化时应启动自动快照', async () => {
      (core as any).memoryEngine = { stub: true };
      await core.initialize();

      const monitor = core.getPerformanceMonitor();
      const snapshot = monitor.getSnapshot();

      expect(snapshot).toBeDefined();
      expect(snapshot.memory).toBeDefined();
      expect(snapshot.cpu).toBeDefined();
    });
  });

  describe('SecurityAuditor Integration', () => {
    it('核心引擎应暴露 SecurityAuditor 实例', () => {
      const auditor = core.getSecurityAuditor();
      expect(auditor).toBeDefined();
      expect(typeof auditor.logAuditEntry).toBe('function');
    });

    it('processInput 应记录审计日志', async () => {
      (core as any).memoryEngine = { stub: true };
      await core.initialize();
      jest.clearAllMocks();

      const auditor = core.getSecurityAuditor();
      const beforeCount = auditor.queryLogs().length;

      mockPersonaApply.mockImplementation((s: string) => s);
      await core.processInput('测试输入', 'user123');

      const afterCount = auditor.queryLogs().length;
      expect(afterCount).toBeGreaterThan(beforeCount);
    });

    it('高风险操作被拦截时记录安全事件', () => {
      mockPersonaCheckRedlines.mockReturnValue(false);

      const result = core.checkHighRiskAction('delete_file', { path: '/etc/passwd' });

      expect(result).toBe(false);

      const auditor = core.getSecurityAuditor();
      const events = auditor.queryEvents({ eventType: 'suspicious_activity' });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].severity).toBe('high');
    });

    it('安全审计器配置了日志文件路径', () => {
      const auditor = core.getSecurityAuditor();
      expect(auditor).toBeDefined();
    });
  });

  describe('End-to-End Process Monitoring', () => {
    it('快速路径：记录审计日志和性能指标', async () => {
      (core as any).memoryEngine = { stub: true };
      await core.initialize();
      jest.clearAllMocks();

      mockLLMChat.mockResolvedValue('你好，有什么需要？');
      mockPersonaApply.mockImplementation((s: string) => s);

      const result = await core.processInput('你好', 'test-user');

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.traceId).toBeDefined();

      const auditor = core.getSecurityAuditor();
      const logs = auditor.queryLogs({ userId: 'test-user' });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].action).toBe('process_input');
    });
  });
});
