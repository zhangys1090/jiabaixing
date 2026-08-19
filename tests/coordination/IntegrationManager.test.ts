/**
 * IntegrationManager 单元测试
 * 覆盖：平台信息、消息发送、Webhook 管理
 */

jest.mock('../../src/shared/EventBus', () => ({
  EventBus: { emit: jest.fn(), on: jest.fn() },
}));

jest.mock('../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { IntegrationManager } from '../../src/integration/IntegrationManager';

describe('IntegrationManager', () => {
  let manager: IntegrationManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = IntegrationManager.getInstance(true);
  });

  describe('平台信息', () => {
    it('getPlatforms 应返回平台列表', () => {
      const platforms = manager.getPlatforms();
      expect(Array.isArray(platforms)).toBe(true);
    });

    it('getPlatformStatus 应返回指定平台状态', () => {
      const status = manager.getPlatformStatus('wechat');
      expect(status).toBeDefined();
    });

    it('getPlatformStatus 不存在的平台返回 undefined', () => {
      const status = manager.getPlatformStatus('nonexistent' as any);
      expect(status).toBeUndefined();
    });
  });

  describe('消息发送', () => {
    it('sendMessage 未连接时应返回失败', async () => {
      const result = await manager.sendMessage({
        platform: 'wechat' as any,
        message: 'test',
        to: 'test',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Webhook 管理', () => {
    it('registerWebhook 应注册端点', () => {
      manager.registerWebhook({
        id: 'test-wh',
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        events: ['message'],
        enabled: true,
      });

      const webhooks = manager.listWebhooks();
      expect(webhooks.length).toBeGreaterThanOrEqual(1);
    });

    it('getWebhook 应返回指定端点', () => {
      manager.registerWebhook({
        id: 'test-wh-2',
        name: 'Test Webhook 2',
        url: 'https://example.com/hook2',
        events: ['message'],
        enabled: true,
      });

      const wh = manager.getWebhook('test-wh-2');
      expect(wh).toBeDefined();
      expect(wh?.name).toBe('Test Webhook 2');
    });

    it('getWebhook 不存在的端点返回 undefined', () => {
      const wh = manager.getWebhook('nonexistent');
      expect(wh).toBeUndefined();
    });

    it('listWebhooks 无注册时返回空或已有列表', () => {
      const webhooks = manager.listWebhooks();
      expect(Array.isArray(webhooks)).toBe(true);
    });
  });
});
