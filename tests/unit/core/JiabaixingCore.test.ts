/**
 * JiabaixingCore 单元测试
 * 覆盖：classifyIntent、extractFilePath、generateFallbackReply、getTimeContext、
 * processInput 快速/完整路径、generateProactiveMessage、directLLMReply
 */

// ── Mocks must be before imports ──

const mockLLMChat = jest.fn();
const mockLLMInitialize = jest.fn().mockResolvedValue(undefined);
const mockLLMHealthCheck = jest.fn().mockResolvedValue({ available: true, message: 'ok' });
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

jest.mock('../../../src/tools/ToolExecutor', () => ({
  ToolExecutor: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue('file content'),
  })),
}));

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    on: jest.fn(),
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

  // ═══════════════════════════════════════════════════
  // classifyIntent (v3.3: 已移除，LLM处理意图识别)
  // ═══════════════════════════════════════════════════
  describe.skip('intent classification', () => {
    it('"修改" 关键词触发 modify 意图', () => {
      const intent = (core as any).classifyIntent('修改 JiabaixingCore.ts');
      expect(intent).toBe('modify');
    });

    it('"重构" 关键词触发 modify 意图', () => {
      const intent = (core as any).classifyIntent('重构 PersonaRules');
      expect(intent).toBe('modify');
    });

    it('"看" 关键词触发 analyze 意图', () => {
      const intent = (core as any).classifyIntent('看看这个文件');
      expect(intent).toBe('analyze');
    });

    it('"刚才" 关键词触发 context 意图', () => {
      const intent = (core as any).classifyIntent('刚才说的那个');
      expect(intent).toBe('context');
    });

    it('普通对话返回 unknown', () => {
      const intent = (core as any).classifyIntent('你好');
      expect(intent).toBe('unknown');
    });
  });

  // ═══════════════════════════════════════════════════
  // extractFilePath (v3.3: 已委托到 DirectExecutor)
  // ═══════════════════════════════════════════════════
  describe.skip('extractFilePath', () => {
    it('从输入中提取 .ts 文件路径', () => {
      const path = (core as any).extractFilePath('帮我看看 JiabaixingCore.ts');
      expect(path).toContain('JiabaixingCore.ts');
    });

    it('从输入中提取 .json 文件路径', () => {
      const path = (core as any).extractFilePath('修改 package.json');
      expect(path).toContain('package.json');
    });

    it('没有文件路径时返回 null', () => {
      const path = (core as any).extractFilePath('你好世界');
      expect(path).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════
  // generateFallbackReply (v3.3: 已委托到 DirectExecutor)
  // ═══════════════════════════════════════════════════
  describe.skip('generateFallbackReply', () => {
    it('"你好" 回复问候', () => {
      const reply = (core as any).generateFallbackReply('你好');
      expect(reply).toContain('你好');
    });

    it('"早安" 回复早晨问候', () => {
      const reply = (core as any).generateFallbackReply('早安');
      expect(reply).toContain('早上好');
      expect(reply).toContain('计划');
    });

    it('"晚安" 回复晚安', () => {
      const reply = (core as any).generateFallbackReply('晚安');
      expect(reply).toContain('晚安');
    });

    it('"谢谢" 回复不客气', () => {
      const reply = (core as any).generateFallbackReply('谢谢');
      expect(reply).toContain('不客气');
    });

    it('"你是谁" 回复身份介绍', () => {
      const reply = (core as any).generateFallbackReply('你是谁');
      expect(reply).toContain('家百星');
      expect(reply).toContain('秘书');
    });

    it('"在吗" 回复在', () => {
      const reply = (core as any).generateFallbackReply('在吗');
      expect(reply).toContain('在');
    });

    it('未知输入返回兜底回复', () => {
      const reply = (core as any).generateFallbackReply('今天天气真好');
      expect(reply).toContain('收到');
    });
  });

  // ═══════════════════════════════════════════════════
  // getTimeContext (v3.3: 已委托到 ConstitutionPromptBuilder)
  // ═══════════════════════════════════════════════════
  describe.skip('getTimeContext', () => {
    it('清晨 (5-8点)', () => {
      const ctx = (core as any).getTimeContext(6, 1); // 周一 6am
      expect(ctx).toContain('清晨');
      expect(ctx).toContain('周一');
    });

    it('上午 (9-11点)', () => {
      const ctx = (core as any).getTimeContext(10, 3); // 周三 10am
      expect(ctx).toContain('上午');
      expect(ctx).toContain('周三');
    });

    it('中午 (12-13点)', () => {
      const ctx = (core as any).getTimeContext(12, 5);
      expect(ctx).toContain('中午');
    });

    it('下午 (14-17点)', () => {
      const ctx = (core as any).getTimeContext(15, 2);
      expect(ctx).toContain('下午');
    });

    it('晚上 (18-21点)', () => {
      const ctx = (core as any).getTimeContext(20, 4);
      expect(ctx).toContain('晚上');
    });

    it('深夜 (22点以后)', () => {
      const ctx = (core as any).getTimeContext(23, 6);
      expect(ctx).toContain('深夜');
    });
  });

  // ═══════════════════════════════════════════════════
  // processInput — v3.3: LLM-first架构，processInput内部逻辑已变更
  // ═══════════════════════════════════════════════════
  describe.skip('processInput — fast path', () => {
    beforeEach(async () => {
      // 注入最小值让初始化通过
      (core as any).memoryEngine = { stub: true };
      await core.initialize();
      jest.clearAllMocks();
    });

    it('短问候走快速 LLM 路径', async () => {
      mockLLMChat.mockResolvedValue('你好。有什么需要？');
      mockPersonaApply.mockImplementation((s: string) => s);

      const result = await core.processInput('你好');

      expect(mockLLMChat).toHaveBeenCalled();
      // 验证调用包含 system prompt override
      const chatArgs = mockLLMChat.mock.calls[0];
      expect(chatArgs[0]).toBe('你好');
      expect(chatArgs[2]).toBeDefined(); // systemPrompt override
    });

    it('快速路径失败时降级到本地回复', async () => {
      mockLLMChat.mockRejectedValue(new Error('LLM down'));

      const result = await core.processInput('你好');

      expect(result.response).toContain('你好');
      expect(result.intent).toBe('conversation');
    });

    it('返回结果包含 traceId', async () => {
      mockLLMChat.mockResolvedValue('test response');
      const result = await core.processInput('你好');
      expect(result.traceId).toBeDefined();
      expect(result.intent).toBe('conversation');
    });
  });

  // ═══════════════════════════════════════════════════
  // processInput — 完整路径
  // ═══════════════════════════════════════════════════
  describe.skip('processInput — full path', () => {
    it('长文本触发完整推理路径', async () => {
      (core as any).memoryEngine = { stub: true };
      const mockExecute = jest.fn().mockResolvedValue({ response: '分析结果' });
      await core.initialize();
      jest.clearAllMocks();

      const longInput = '请帮我重构 src/core/JiabaixingCore.ts 文件中的 processInput 方法，让它支持更灵活的意图分类和流式输出';
      mockPersonaApply.mockImplementation((s: string) => s);

      const result = await core.processInput(longInput);

      // 长输入应该走完整路径
      expect(mockExecute).toHaveBeenCalled();
      expect(result.intent).toBe('reasoning');
    });
  });

  // ═══════════════════════════════════════════════════
  // generateProactiveMessage
  // ═══════════════════════════════════════════════════
  describe.skip('generateProactiveMessage', () => {
    beforeEach(async () => {
      (core as any).memoryEngine = { stub: true };
      await core.initialize();
      jest.clearAllMocks();
    });

    it('生成早晨问候消息', async () => {
      mockLLMChat.mockResolvedValue('早上好。今天有什么计划？');
      mockPersonaApply.mockImplementation((s: string) => s);

      const msg = await core.generateProactiveMessage({
        reason: 'morning_greeting',
        context: '周一 08:30。用户画像：偏好语言：TypeScript',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockLLMChat).toHaveBeenCalled();
      expect(typeof msg).toBe('string');
    });

    it('生成晚间 checkin 消息', async () => {
      mockLLMChat.mockResolvedValue('今天进展如何？');
      mockPersonaApply.mockImplementation((s: string) => s);

      const msg = await core.generateProactiveMessage({
        reason: 'evening_checkin',
        context: '周三 19:00。用户最近关注：代码重构。近期反馈：3 次正面互动',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockLLMChat).toHaveBeenCalled();
      // 验证 prompt 包含记忆上下文
      const chatArgs = mockLLMChat.mock.calls[0];
      expect(chatArgs[0]).toContain('用户最近关注');
      expect(chatArgs[0]).toContain('近期反馈');
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
      mockLLMChat.mockResolvedValue('在呢。');
      mockPersonaApply.mockImplementation((s: string) => s);

      const msg = await core.generateProactiveMessage({
        reason: 'negative_emotion_trend',
        context: '用户最近关注：加班调试。相关历史：连续3天处理编译错误',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockLLMChat).toHaveBeenCalled();
      const prompt = mockLLMChat.mock.calls[0][0];
      expect(prompt).toContain('负面情绪');
    });

    it('富上下文时引导 LLM 引用具体细节', async () => {
      mockLLMChat.mockResolvedValue('早。今天有个ScenarioAwareScheduler的改动需要收尾。');
      mockPersonaApply.mockImplementation((s: string) => s);

      const richContext = '周一 08:30。用户最近关注：ScenarioAwareScheduler的detectProactiveInsight优化；修改JiabaixingCore.ts。待处理：重构PersonaRules语气映射';
      await core.generateProactiveMessage({
        reason: 'morning_greeting',
        context: richContext,
        scene: '休闲',
        isEmotionBased: false,
      });

      const prompt = mockLLMChat.mock.calls[0][0];
      // 富上下文时 prompt 应引导引用具体细节
      expect(prompt).toContain('记忆上下文');
      expect(prompt).toContain('具体细节');
    });

    it('PersonaRules 润色被调用', async () => {
      mockLLMChat.mockResolvedValue('raw LLM response');
      mockPersonaApply.mockImplementation((s: string) => `[polished] ${s}`);

      const msg = await core.generateProactiveMessage({
        reason: 'scheduled',
        context: '',
        scene: '休闲',
        isEmotionBased: false,
      });

      expect(mockPersonaApply).toHaveBeenCalled();
      expect(msg).toContain('[polished]');
    });
  });

  // ═══════════════════════════════════════════════════
  // processInput — 安全红线
  // ═══════════════════════════════════════════════════
  describe('processInput — 降级处理', () => {
    it('无推理引擎时走降级路径', async () => {
      (core as any).memoryEngine = { stub: true };
      await core.initialize();
      jest.clearAllMocks();

      mockLLMChat.mockResolvedValue('降级回复');
      mockPersonaApply.mockImplementation((s: string) => s);

      const result = await core.processInput('帮我看看代码');

      expect(result.response).toBeDefined();
      expect(result.intent).toBeDefined();
    });
  });
});
