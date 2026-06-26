/**
 * BaseIntegrationAdapter 单元测试
 */
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import type {
  PlatformConfig,
  SendMessageResponse,
} from '../../../../src/shared/contracts';

describe('BaseIntegrationAdapter', () => {
  const BaseIntegrationAdapter =
    require('../../../../src/integration/adapters/BaseIntegrationAdapter').BaseIntegrationAdapter;

  class TestAdapter extends BaseIntegrationAdapter {
    constructor(platform: string) {
      super(platform);
    }
    async connect(_config: PlatformConfig): Promise<boolean> {
      this.updateStatus('connected');
      return true;
    }
    async disconnect(): Promise<void> {
      this.updateStatus('disconnected');
    }
    async sendMessage(
      _message: string,
      _to?: string,
      _imageUrls?: string[],
      _mentions?: string[]
    ): Promise<SendMessageResponse> {
      return {
        success: true,
        messageId: 'test',
        timestamp: new Date().toISOString(),
      };
    }
    async handleWebhook(
      _payload: Record<string, unknown>
    ): Promise<{ success: boolean }> {
      return { success: true };
    }
  }

  it('应正确初始化平台信息', () => {
    const adapter = new TestAdapter('telegram');
    expect(adapter.platform).toBe('telegram');
  });

  it('初始状态应为 disconnected', () => {
    const adapter = new TestAdapter('discord');
    expect(adapter.getStatus().connected).toBe(false);
    expect(adapter.getStatus().status).toBe('disconnected');
  });

  it('connect 后状态应更新', async () => {
    const adapter = new TestAdapter('slack');
    await adapter.connect({});
    expect(adapter.getStatus().connected).toBe(true);
    expect(adapter.getStatus().status).toBe('connected');
  });

  it('disconnect 后状态应更新', async () => {
    const adapter = new TestAdapter('qq');
    await adapter.connect({});
    await adapter.disconnect();
    expect(adapter.getStatus().connected).toBe(false);
  });

  it('应支持注册消息处理器', async () => {
    const adapter = new TestAdapter('telegram');
    const handler = jest.fn();
    adapter.onMessage(handler);
    const msg = {
      platform: 'telegram' as any,
      type: 'text' as any,
      content: 'hi',
      from: 'u1',
      timestamp: new Date().toISOString(),
    };
    await (adapter as any).emitMessage(msg);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it('应校验 webhook URL 安全性', () => {
    const adapter = new TestAdapter('telegram');
    expect(
      (adapter as any).validateWebhookUrl('http://127.0.0.1/malicious').valid
    ).toBe(false);
    expect(
      (adapter as any).validateWebhookUrl('http://10.0.0.1/test').valid
    ).toBe(false);
    expect(
      (adapter as any).validateWebhookUrl('https://api.example.com/webhook')
        .valid
    ).toBe(true);
  });
});
