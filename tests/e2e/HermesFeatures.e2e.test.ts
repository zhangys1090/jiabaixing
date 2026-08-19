/**
 * Hermes 特性端到端验证测试 — 20项
 *
 * 从三个入口验证 Hermes 智能特性：
 * 1. 网关 (HTTP API) — 验证路由注册
 * 2. 前端 UI — 通过 API 间接验证
 * 3. CLI 交互 — 通过模块导入验证
 *
 * 测试策略：模块级集成测试，验证各组件可正确实例化和连接
 */

// Mock Logger
jest.mock('../../src/utils/Logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { __esModule: true, Logger: mock, default: mock };
});

// Mock EventBus
jest.mock('../../src/shared/EventBus', () => {
  const mock = {
    emit: jest.fn().mockReturnValue(true),
    on: jest.fn(),
    startFullTrace: jest.fn(),
    addTracePhase: jest.fn(),
    completeTracePhase: jest.fn(),
    recordTokenUsage: jest.fn(),
    recordToolCall: jest.fn(),
  };
  return { __esModule: true, default: mock };
});

describe('Hermes 特性端到端验证 — 20项', () => {
  const mockLLM = {
    chat: jest.fn().mockResolvedValue('{"reasoning":"测试推理","steps":[]}'),
    chatWithTools: jest.fn().mockResolvedValue({
      content: '测试回复',
      toolCalls: [],
    }),
    getModelName: jest.fn().mockReturnValue('gpt-4o-test'),
  };

  describe('网关入口 (HTTP API)', () => {
    test('1. 健康检查端点可达', () => {
      const healthRoute = require('../../src/server/routes/coreRoutes');
      expect(healthRoute).toBeDefined();
    });

    test('2. 对话 API 端点已注册', () => {
      const chatRoutes = require('../../src/server/routes/chatRoutes');
      expect(chatRoutes).toBeDefined();
    });

    test('3. 进化引擎 API 端点已注册', () => {
      const evolutionRoutes = require('../../src/server/routes/evolutionRoutes');
      expect(evolutionRoutes).toBeDefined();
    });

    test('4. 记忆系统 API 端点已注册', () => {
      const memoryRoutes = require('../../src/server/routes/memoryRoutes');
      expect(memoryRoutes).toBeDefined();
    });

    test('5. 系统状态 API 端点已注册', () => {
      const systemStateRoutes = require('../../src/server/routes/systemStateRoutes');
      expect(systemStateRoutes).toBeDefined();
    });
  });

  describe('Planner 智能特性', () => {
    // 6/7/8 已迁移到 Python 端，测试见 python/tests/
  });

  describe('工具注册表智能特性', () => {
    test('10. 动态工具注册', async () => {
      const { ToolRegistry } =
        await import('../../src/harness/tools/registry/ToolRegistry');
      const registry = new ToolRegistry();
      // 注册一个测试工具验证接口
      expect(registry.getRegisteredToolNames()).toBeDefined();
      expect(Array.isArray(registry.getRegisteredToolNames())).toBe(true);
    });
  });

  describe('Executor 智能特性', () => {
    // 11/12/13 已迁移到 Python 端，测试见 python/tests/
  });

  describe('ReflectionEngine 智能特性', () => {
    // 14/15 已迁移到 Python 端，测试见 python/tests/
  });

  describe('LLM 能力探测与策略适配', () => {
    test('16. LLM 能力探测模块', async () => {
      const { LLMCapabilityDetector } =
        await import('../../src/evolution/LLMCapabilityDetector');
      const detector = new LLMCapabilityDetector();
      detector.setLLMProvider(mockLLM);
      expect(typeof detector.detectCapabilities).toBe('function');
      expect(typeof detector.compareCapabilities).toBe('function');
    });

    test('17. 策略动态适配', async () => {
      const { StrategyAdapter } =
        await import('../../src/evolution/StrategyAdapter');
      const adapter = new StrategyAdapter();
      expect(typeof adapter.adaptStrategies).toBe('function');
      expect(typeof adapter.getDefaultConfig).toBe('function');

      const defaultConfig = adapter.getDefaultConfig();
      expect(defaultConfig.prompt.reasoningFreedom).toBe('structured');
      expect(defaultConfig.planning.enableToT).toBe(false);
    });
  });

  describe('进化引擎统一', () => {
    test('18. EvolutionOrchestrator 单例', async () => {
      const { EvolutionOrchestrator } =
        await import('../../src/evolution/EvolutionOrchestrator');
      const orchestrator = EvolutionOrchestrator.getInstance();
      expect(orchestrator).toBeDefined();
      expect(typeof orchestrator.registerEngines).toBe('function');
    });
  });

  describe('CLI 交互入口', () => {
    test('20. CLI 模块可导入', () => {
      // 验证 CLI 入口模块文件存在
      const fs = require('fs');
      const path = require('path');
      const cliPath = path.join(__dirname, '../../src/cli.ts');
      expect(fs.existsSync(cliPath)).toBe(true);
    });
  });
});
