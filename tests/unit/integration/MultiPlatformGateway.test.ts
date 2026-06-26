/**
 * MultiPlatformGateway 单元测试
 * 测试多平台网关的统一协调能力
 */

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../src/integration/IntegrationManager', () => ({
  IntegrationManager: {
    getInstance: jest.fn().mockReturnValue({
      getPlatforms: jest.fn().mockReturnValue([
        {
          id: 'wechat',
          name: '微信',
          enabled: true,
          available: true,
          status: {
            platform: 'wechat',
            connected: false,
            status: 'disconnected',
          },
        },
        {
          id: 'feishu',
          name: '飞书',
          enabled: true,
          available: true,
          status: {
            platform: 'feishu',
            connected: true,
            status: 'connected',
            lastConnectedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        {
          id: 'dingtalk',
          name: '钉钉',
          enabled: true,
          available: true,
          status: {
            platform: 'dingtalk',
            connected: false,
            status: 'disconnected',
          },
        },
      ]),
      connectPlatform: jest.fn().mockResolvedValue(true),
      disconnectPlatform: jest.fn().mockResolvedValue(undefined),
      getPlatformStatus: jest.fn().mockReturnValue({
        platform: 'wechat',
        connected: false,
        status: 'disconnected',
      }),
      sendMessage: jest.fn().mockResolvedValue({ success: true }),
      handleWebhook: jest.fn().mockResolvedValue({ success: true }),
      registerWebhook: jest.fn(),
      unregisterWebhook: jest.fn(),
      listWebhooks: jest.fn().mockReturnValue([]),
    }),
  },
}));

jest.mock('../../../src/integration/GatewayBridge', () => ({
  GatewayBridge: {
    getInstance: jest.fn().mockReturnValue({
      isWorkerAlive: jest.fn().mockReturnValue(false),
      getPlatforms: jest.fn().mockReturnValue([]),
      connectPlatform: jest.fn().mockResolvedValue(true),
      disconnectPlatform: jest.fn().mockResolvedValue(undefined),
      getPlatformStatus: jest.fn().mockReturnValue(undefined),
      sendMessage: jest.fn().mockResolvedValue({ success: true }),
      handleWebhook: jest.fn().mockResolvedValue({ success: true }),
      setIncomingMessageHandler: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/mcp/MCPServerManager', () => ({
  MCPServerManager: {
    getInstance: jest.fn().mockReturnValue({
      registerServer: jest.fn(),
      startServer: jest.fn().mockResolvedValue(true),
      stopServer: jest.fn().mockReturnValue(true),
      getAllServerHealth: jest.fn().mockReturnValue({
        filesystem: {
          name: 'filesystem',
          running: false,
          initialized: false,
          healthy: false,
          restartCount: 0,
          lastHealthCheck: null,
          uptime: 0,
        },
        browser: {
          name: 'browser',
          running: true,
          initialized: true,
          healthy: true,
          restartCount: 0,
          lastHealthCheck: null,
          uptime: 0,
        },
      }),
      getAllServerStatus: jest.fn().mockReturnValue({
        filesystem: {
          name: 'filesystem',
          running: false,
          healthy: false,
        },
        browser: {
          name: 'browser',
          running: true,
          healthy: true,
        },
      }),
      callTool: jest.fn().mockResolvedValue({ success: true }),
    }),
  },
}));

import { MultiPlatformGateway } from '../../../src/integration/MultiPlatformGateway';

describe('MultiPlatformGateway', () => {
  beforeEach(() => {
    MultiPlatformGateway.resetInstance();
  });

  describe('初始化与单例', () => {
    it('应正确初始化单例', () => {
      const gateway = MultiPlatformGateway.getInstance();
      expect(gateway).toBeInstanceOf(MultiPlatformGateway);
    });

    it('getInstance 应返回同一实例', () => {
      const instance1 = MultiPlatformGateway.getInstance();
      const instance2 = MultiPlatformGateway.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('resetInstance 后应创建新实例', () => {
      const instance1 = MultiPlatformGateway.getInstance();
      MultiPlatformGateway.resetInstance();
      const instance2 = MultiPlatformGateway.getInstance();
      expect(instance1).not.toBe(instance2);
    });

    it('initialize 后 getOverview 应返回 hybrid 模式', () => {
      const gateway = MultiPlatformGateway.getInstance({ mode: 'hybrid' });
      gateway.initialize();
      const overview = gateway.getOverview();
      expect(overview.mode).toBe('hybrid');
      expect(overview.initialized).toBe(true);
    });
  });

  describe('网关概览', () => {
    it('getOverview 应包含 IM 平台和 MCP 平台', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const overview = gateway.getOverview();

      expect(overview.imPlatforms).toBeDefined();
      expect(overview.mcpPlatforms).toBeDefined();
      expect(overview.webhooks).toBeDefined();
      expect(overview.totalPlatforms).toBeGreaterThan(0);
    });

    it('应返回队列状态应包含微信和飞书的状态', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const overview = gateway.getOverview();

      expect(overview.imPlatforms['wechat']).toBeDefined();
      expect(overview.imPlatforms['feishu']).toBeDefined();
      expect(overview.imPlatforms['wechat'].kind).toBe('im_platform');
      expect(overview.imPlatforms['feishu'].connected).toBe(true);
    });

    it('应返回 MCP 服务器状态', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const overview = gateway.getOverview();

      expect(overview.mcpPlatforms['filesystem']).toBeDefined();
      expect(overview.mcpPlatforms['browser']).toBeDefined();
      expect(overview.mcpPlatforms['browser'].connected).toBe(true);
      expect(overview.mcpPlatforms['browser'].kind).toBe('mcp_server');
    });

    it('应统计 activePlatforms 正确', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const overview = gateway.getOverview();

      expect(overview.activePlatforms).toBeGreaterThanOrEqual(1);
      expect(overview.totalPlatforms).toBeGreaterThan(overview.activePlatforms);
    });

    it('应返回生成时间戳', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const overview = gateway.getOverview();
      expect(overview.generatedAt).toBeTruthy();
      expect(Date.parse(overview.generatedAt)).toBeGreaterThan(0);
    });
  });

  describe('IM 平台操作', () => {
    it('connectIMPlatform 应调用底层 manager', async () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const success = await gateway.connectIMPlatform('wechat', { mode: 'qr' });
      expect(success).toBe(true);
    });

    it('disconnectIMPlatform 应调用底层 manager', async () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      await gateway.disconnectIMPlatform('wechat');
    });

    it('sendIMMessage 应调用底层 manager', async () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const result = await gateway.sendIMMessage({
        platform: 'feishu',
        message: 'test',
        to: 'user123',
      });
      expect(result.success).toBe(true);
    });

    it('handleIMWebhook 应调用底层 manager', async () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const result = await gateway.handleIMWebhook('feishu', {});
      expect(result.success).toBe(true);
    });

    it('listIMPlatforms 应返回平台列表', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const platforms = gateway.listIMPlatforms();
      expect(platforms.length).toBeGreaterThan(0);
      expect(platforms[0].id).toBe('wechat');
    });
  });

  describe('MCP 操作', () => {
    it('registerMCPServer 应调用 MCP 管理器', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      gateway.registerMCPServer({
        name: 'test-server',
        command: 'node',
        args: ['test.js'],
      });
    });

    it('startMCPServer 应启动服务器', async () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const success = await gateway.startMCPServer('test');
      expect(success).toBe(true);
    });

    it('stopMCPServer 应停止服务器', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const success = gateway.stopMCPServer('test');
      expect(success).toBe(true);
    });

    it('listMCPServers 应返回服务器列表', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const servers = gateway.listMCPServers();
      expect(servers).toBeDefined();
      expect(servers['filesystem']).toBeDefined();
    });

    it('callMCPTool 应调用工具', async () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const result = await gateway.callMCPTool('filesystem', 'read_file', {
        path: '/tmp/test.txt',
      });
      expect(result).toBeDefined();
    });
  });

  describe('Webhook 操作', () => {
    it('registerWebhook 应调用底层', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      gateway.registerWebhook({
        id: 'test-hook',
        name: 'Test Hook',
        url: 'http://localhost/hook',
        enabled: true,
        events: ['integration_message'],
      });
    });

    it('unregisterWebhook 应调用底层', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      gateway.unregisterWebhook('test-hook');
    });

    it('listWebhooks 应返回列表', () => {
      const gateway = MultiPlatformGateway.getInstance();
      gateway.initialize();
      const list = gateway.listWebhooks();
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('模式切换', () => {
    it('inline 模式应跳过 Worker 检查', () => {
      MultiPlatformGateway.resetInstance();
      const gateway = MultiPlatformGateway.getInstance({ mode: 'inline' });
      gateway.initialize();
      const overview = gateway.getOverview();
      expect(overview.mode).toBe('inline');
    });

    it('mcp_only 模式应正确', () => {
      MultiPlatformGateway.resetInstance();
      const gateway = MultiPlatformGateway.getInstance({ mode: 'mcp_only' });
      gateway.initialize();
      const overview = gateway.getOverview();
      expect(overview.mode).toBe('mcp_only');
    });
  });
});
