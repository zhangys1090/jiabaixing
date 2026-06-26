import { JiabaixingCore } from '../../../src/core/JiabaixingCore';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('JiabaixingCore 清理验证', () => {
  let core: JiabaixingCore;

  beforeEach(() => {
    jest.clearAllMocks();
    core = new JiabaixingCore();
  });

  describe('核心功能仍然可用', () => {
    it('processInput 方法应该存在', () => {
      expect(typeof core.processInput).toBe('function');
    });

    it('getLLM 方法应该存在', () => {
      expect(typeof core.getLLM).toBe('function');
    });

    it('getConversationHistoryManager 方法应该存在', () => {
      expect(typeof core.getConversationHistoryManager).toBe('function');
    });

    it('feedbackCollector 仍然存在（被 initHarness 使用）', () => {
      expect(core.feedbackCollector).toBeDefined();
    });

    it('conversationHistoryManager 通过 getter 可访问', () => {
      const manager = core.getConversationHistoryManager();
      expect(manager).toBeDefined();
      expect(typeof manager.getAll).toBe('function');
    });
  });

  describe('死代码已移除', () => {
    it('getLastToolResults 方法不应存在', () => {
      expect(
        typeof (core as unknown as { getLastToolResults?: unknown })
          .getLastToolResults
      ).toBe('undefined');
    });

    it('recentConversationHistory 不应作为属性存在', () => {
      // recentConversationHistory 是 private getter/setter，已移除
      // 验证实例没有该属性
      expect(
        (core as unknown as { recentConversationHistory?: unknown })
          .recentConversationHistory
      ).toBeUndefined();
    });
  });
});
