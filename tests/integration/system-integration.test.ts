/**
 * 系统集成测试
 * 覆盖：JiabaixingCore + IntegrationManager + EventBus 集成
 */

jest.mock('../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    on: jest.fn(),
    startTrace: jest.fn(),
    failTrace: jest.fn(),
    endTrace: jest.fn(),
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

jest.mock('../../src/models/LLMProvider', () => ({
  LLMProvider: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest
      .fn()
      .mockResolvedValue({ available: true, message: 'ok' }),
    chat: jest.fn().mockResolvedValue('集成测试回复'),
    isAvailable: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../../src/persona/PersonaRules', () => ({
  PersonaRules: jest.fn().mockImplementation(() => ({
    applyRules: jest.fn((c: string) => c),
    buildSystemPrompt: jest.fn().mockReturnValue('system prompt'),
    checkSecurityRedlines: jest.fn().mockReturnValue(false),
    initialize: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  watchFile: jest.fn(),
}));

import { JiabaixingCore } from '../../src/core/JiabaixingCore';
import { IntegrationManager } from '../../src/integration/IntegrationManager';

describe('系统集成测试', () => {
  describe('JiabaixingCore + IntegrationManager', () => {
    it('Core 和 IntegrationManager 可独立实例化', () => {
      const core = new JiabaixingCore();
      const integration = IntegrationManager.getInstance(true);
      expect(core).toBeDefined();
      expect(integration).toBeDefined();
    });

    it('IntegrationManager 可获取平台列表', () => {
      const integration = IntegrationManager.getInstance(true);
      const platforms = integration.getPlatforms();
      expect(Array.isArray(platforms)).toBe(true);
    });
  });

  describe('Python 后端路由集成', () => {
    it('AGENT_BACKEND=python 时 processInput 路由到 Python 后端', async () => {
      const originalEnv = process.env.AGENT_BACKEND;
      process.env.AGENT_BACKEND = 'python';

      const core = new JiabaixingCore();
      const mockBridge = {
        processInput: jest.fn().mockResolvedValue({
          response: 'Python 集成回复',
          traceId: 'py-trace-002',
          intent: 'python_backend',
        }),
      };
      (core as any).pythonBridgeResolver = () => mockBridge;
      (core as any).initialized = true;

      const result = await core.processInput('集成测试', 'user1', 'trace-002');

      expect(mockBridge.processInput).toHaveBeenCalledWith(
        '集成测试',
        'user1',
        'trace-002',
        undefined
      );
      expect(result.response).toBe('Python 集成回复');
      expect(result.intent).toBe('python_backend');

      process.env.AGENT_BACKEND = originalEnv;
    });
  });

  describe('降级路径集成', () => {
    it('无 Python 后端时走降级路径', async () => {
      const core = new JiabaixingCore();
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

      const result = await core.processInput('降级集成测试');

      expect(result).toBeDefined();
      expect(result.traceId).toBeDefined();
    });
  });
});
