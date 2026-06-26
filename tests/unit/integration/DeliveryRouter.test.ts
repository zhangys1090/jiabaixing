/**
 * DeliveryRouter 单元测试
 */
import { DeliveryRouter } from '../../../src/integration/DeliveryRouter';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock IntegrationManager
const mockSendMessage = jest.fn().mockResolvedValue({ success: true });
jest.mock('../../../src/integration/IntegrationManager', () => ({
  IntegrationManager: {
    getInstance: jest.fn().mockReturnValue({
      sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    }),
  },
}));

describe('DeliveryRouter', () => {
  let router: DeliveryRouter;

  beforeEach(() => {
    router = new DeliveryRouter();
    mockSendMessage.mockClear();
  });

  describe('parseTarget', () => {
    it('应解析平台名', () => {
      const t = router.parseTarget('telegram');
      expect(t.platform).toBe('telegram');
      expect(t.local).toBe(false);
      expect(t.to).toBeUndefined();
    });

    it('应解析 platform:target 格式', () => {
      const t = router.parseTarget('telegram:123456');
      expect(t.platform).toBe('telegram');
      expect(t.to).toBe('123456');
    });

    it('应解析 discord:channel', () => {
      const t = router.parseTarget('discord:987654');
      expect(t.platform).toBe('discord');
      expect(t.to).toBe('987654');
    });

    it('应解析 local', () => {
      const t = router.parseTarget('local');
      expect(t.local).toBe(true);
    });

    it('应解析 slack:channel', () => {
      const t = router.parseTarget('slack:ops-alerts');
      expect(t.platform).toBe('slack');
      expect(t.to).toBe('ops-alerts');
    });
  });

  describe('deliver', () => {
    it('local 投递应成功', async () => {
      const ok = await router.deliver({ message: 'test', target: 'local' });
      expect(ok).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('origin 应发回原始平台', async () => {
      const ok = await router.deliver(
        { message: '回复', target: 'origin' },
        'telegram',
        'user123'
      );
      expect(ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith({
        platform: 'telegram',
        message: '回复',
        to: 'user123',
      });
    });

    it('origin 无原始信息时用 fallback', async () => {
      const ok = await router.deliver({
        message: '回退',
        target: 'origin',
        fallbackPlatform: 'discord',
        fallbackTo: 'chan1',
      });
      expect(ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith({
        platform: 'discord',
        message: '回退',
        to: 'chan1',
      });
    });

    it('指定平台应发送到该平台', async () => {
      const ok = await router.deliver({
        message: '告警',
        target: 'slack:alerts',
      });
      expect(ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith({
        platform: 'slack',
        message: '告警',
        to: 'alerts',
      });
    });
  });

  describe('deliverMulti', () => {
    it('应投递到多个目标', async () => {
      const count = await router.deliverMulti(
        { message: '广播', target: '' },
        ['telegram:admin', 'discord:ops', 'local'],
        'origin',
        'user'
      );
      expect(count).toBe(3);
      expect(mockSendMessage).toHaveBeenCalledTimes(2); // local 不调 sendMessage
    });
  });
});
