/**
 * JiabaixingCore 单元测试
 * V5.0 重写：覆盖 processInput（Python后端路由 + Harness路径 + 降级路径）、
 * generateProactiveMessage、treeOfThoughtReasoning
 */

// ── Mocks must be before imports ──

const mockLLMChat = jest.fn();
const mockLLMInitialize = jest.fn().mockResolvedValue(undefined);
const mockLLMHealthCheck = jest
  .fn()
  .mockResolvedValue({ available: true, message: 'ok' });
const mockLLMAnalyzeCode = jest.fn();
const mockLLMGenerateModified = jest.fn();

jest.mock('../../../src/models/LLMProvider', () => ({
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
const mockPersonaCheckRedlines = jest.fn().mockReturnValue(false);

jest.mock('../../../src/persona/PersonaRules', () => ({
  PersonaRules: jest.fn().mockImplementation(() => ({
    applyRules: mockPersonaApply,
    buildSystemPrompt: mockPersonaBuildPrompt,
    checkSecurityRedlines: mockPersonaCheckRedlines,
    initialize: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    on: jest.fn(),
    startTrace: jest.fn(),
    failTrace: jest.fn(),
    endTrace: jest.fn(),
  },
}));

jest.mock('../../../src/utils/Logger', () => ({
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
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  watchFile: jest.fn(),
}));

import { JiabaixingCore } from '../../../src/core/JiabaixingCore';

describe('JiabaixingCore', () => {
  let core: JiabaixingCore;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMChat.mockResolvedValue('这是一个测试回复');
    core = new JiabaixingCore();
  });

  describe('processInput — Python 后端路由', () => {
    it('AGENT_BACKEND=python 且 bridge 可用时路由到 Python 后端', async () => {
      const originalEnv = process.env.AGENT_BACKEND;
      process.env.AGENT_BACKEND = 'python';

      const mockBridgeResult = {
        response: 'Python 后端回复',
        traceId: 'py-trace-001',
        intent: 'python_backend',
      };
      const mockBridge = {
        processInput: jest.fn().mockResolvedValue(mockBridgeResult),
      };
      (core as any).pythonBridgeResolver = () => mockBridge;
      (core as any).initialized = true;

      const result = await core.processInput('你好', 'user1', 'trace-001');

      expect(mockBridge.processInput).toHaveBeenCalledWith(
        '你好',
        'user1',
        'trace-001',
        undefined
      );
      expect(result.response).toBe('Python 后端回复');
      expect(result.intent).toBe('python_backend');

      process.env.AGENT_BACKEND = originalEnv;
    });

    it('AGENT_BACKEND=python 但 bridge 不可用时走降级路径', async () => {
      const originalEnv = process.env.AGENT_BACKEND;
      process.env.AGENT_BACKEND = 'python';

      (core as any).pythonBridgeResolver = () => null;
      (core as any).initialized = true;

      const result = await core.processInput('你好');

      expect(result).toBeDefined();
      expect(result.traceId).toBeDefined();

      process.env.AGENT_BACKEND = originalEnv;
    });
  });

  describe('processInput — 降级处理', () => {
    it('无 Harness 时走降级路径返回结果', async () => {
      (core as any).initialized = true;
      (core as any).harness = null;
      (core as any).pythonBridgeResolver = null;
      (core as any).memoryEngine = { markUserActive: jest.fn() };
      (core as any).scenarioScheduler = { updateUserActivity: jest.fn() };
      (core as any).securityAuditor = { logAuditEntry: jest.fn() };
      (core as any).conversationHistoryManager = {
        getPreviousAssistantMessage: jest.fn().mockReturnValue(''),
        addUserMessage: jest.fn(),
        addAssistantMessage: jest.fn(),
        getLength: jest.fn().mockReturnValue(1),
      };
      (core as any).loadAndInjectProjectContext = jest
        .fn()
        .mockResolvedValue(undefined);
      mockPersonaApply.mockImplementation((s: string) => s);

      mockLLMChat.mockResolvedValue('降级回复');

      const result = await core.processInput('帮我看看代码');

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
    });
  });

  describe('generateProactiveMessage', () => {
    beforeEach(() => {
      (core as any).personaCore = {
        buildPersonaSummary: jest.fn().mockReturnValue('家百星秘书'),
      };
    });

    it('生成早晨问候消息', async () => {
      mockLLMChat.mockResolvedValue('早上好！今天有什么计划？');

      const msg = await core.generateProactiveMessage({
        reason: 'morning_greeting',
        context: '周一 08:30',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockLLMChat).toHaveBeenCalled();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    });

    it('LLM 失败时返回降级消息', async () => {
      mockLLMChat.mockRejectedValue(new Error('LLM unavailable'));

      const msg = await core.generateProactiveMessage({
        reason: 'long_silence',
        context: '',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    });

    it('负面情绪触发温和关切', async () => {
      mockLLMChat.mockResolvedValue('今天还好吗？');

      const msg = await core.generateProactiveMessage({
        reason: 'negative_emotion_trend',
        context: '用户最近关注：加班调试',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockLLMChat).toHaveBeenCalled();
      expect(typeof msg).toBe('string');
    });

    it('晚间 checkin 消息', async () => {
      mockLLMChat.mockResolvedValue('晚上好，今天辛苦了~');

      const msg = await core.generateProactiveMessage({
        reason: 'evening_checkin',
        context: '周三 19:00',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockLLMChat).toHaveBeenCalled();
      expect(typeof msg).toBe('string');
    });

    it('未知 reason 使用默认引导', async () => {
      mockLLMChat.mockResolvedValue('在呢~');

      const msg = await core.generateProactiveMessage({
        reason: 'unknown_reason',
        context: '',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockLLMChat).toHaveBeenCalled();
      expect(typeof msg).toBe('string');
    });
  });

  describe('treeOfThoughtReasoning', () => {
    beforeEach(() => {
      (core as any).llm = { chat: mockLLMChat };
    });

    it('应返回推理结果结构', async () => {
      mockLLMChat
        .mockResolvedValueOnce(
          'THOUGHT_1: 分析问题\nTHOUGHT_2: 提出假设\nTHOUGHT_3: 验证假设'
        )
        .mockResolvedValueOnce('8')
        .mockResolvedValueOnce('7')
        .mockResolvedValueOnce('6');

      const result = await core.treeOfThoughtReasoning('如何优化代码性能？', {
        maxDepth: 1,
        branchCount: 3,
        evaluationTopK: 2,
      });

      expect(result).toHaveProperty('answer');
      expect(result).toHaveProperty('reasoningPaths');
      expect(result).toHaveProperty('bestPath');
      expect(result).toHaveProperty('evaluations');
      expect(Array.isArray(result.reasoningPaths)).toBe(true);
    });

    it('LLM 返回非标准格式时应降级处理', async () => {
      mockLLMChat
        .mockResolvedValueOnce('这是一段非标准格式的回复，没有THOUGHT标记')
        .mockResolvedValueOnce('5');

      const result = await core.treeOfThoughtReasoning('简单问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      expect(result).toHaveProperty('answer');
      expect(result.reasoningPaths.length).toBeGreaterThan(0);
    });

    it('LLM 失败时应返回降级结果', async () => {
      mockLLMChat.mockRejectedValue(new Error('LLM error'));

      const result = await core.treeOfThoughtReasoning('测试问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      expect(result).toHaveProperty('answer');
      expect(result.answer).toBeDefined();
    });
  });

  describe('processInputWithTracking', () => {
    it('应调用 processInput 并返回带追踪信息的结果', async () => {
      (core as any).initialized = true;
      (core as any).harness = null;
      (core as any).pythonBridgeResolver = null;
      (core as any).memoryEngine = { markUserActive: jest.fn() };
      (core as any).scenarioScheduler = { updateUserActivity: jest.fn() };
      (core as any).securityAuditor = { logAuditEntry: jest.fn() };
      (core as any).conversationHistoryManager = {
        getPreviousAssistantMessage: jest.fn().mockReturnValue(''),
        addUserMessage: jest.fn(),
        addAssistantMessage: jest.fn(),
        getLength: jest.fn().mockReturnValue(1),
      };
      (core as any).loadAndInjectProjectContext = jest
        .fn()
        .mockResolvedValue(undefined);
      mockPersonaApply.mockImplementation((s: string) => s);
      mockLLMChat.mockResolvedValue('追踪测试回复');

      const result = await core.processInputWithTracking('你好', 'user1');

      expect(result).toBeDefined();
      expect(result.traceId).toBeDefined();
    });
  });
});
