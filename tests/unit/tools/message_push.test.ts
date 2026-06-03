/**
 * Unit tests for message_push harness tool
 *
 * Mocks global.fetch instead of httpClient deps.
 */

import {
  createMessagePushExecutor,
  MESSAGE_PUSH_DEF,
} from '../../../src/harness/tools/network/message_push';

// Mock global.fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('message_push 工具', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('工具定义', () => {
    it('应该有正确的名称和分类', () => {
      expect(MESSAGE_PUSH_DEF.name).toBe('message_push');
      expect(MESSAGE_PUSH_DEF.category).toBe('network');
      expect(MESSAGE_PUSH_DEF.requiredParams).toContain('channel');
      expect(MESSAGE_PUSH_DEF.requiredParams).toContain('title');
      expect(MESSAGE_PUSH_DEF.requiredParams).toContain('content');
      expect(MESSAGE_PUSH_DEF.requiredPermissions).toContain('network:access');
      expect(MESSAGE_PUSH_DEF.riskLevel).toBe('low');
      expect(MESSAGE_PUSH_DEF.timeout).toBe(15000);
    });
  });

  describe('参数校验', () => {
    const executor = createMessagePushExecutor();

    it('拒绝不支持的渠道', async () => {
      const result = await executor({
        channel: 'slack',
        title: 'Test',
        content: 'Hello',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('不支持的推送渠道');
    });

    it('拒绝空标题', async () => {
      const result = await executor({
        channel: 'serverchan',
        title: '',
        content: 'Hello',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('消息标题不能为空');
    });

    it('拒绝空内容', async () => {
      const result = await executor({
        channel: 'serverchan',
        title: 'Test',
        content: '',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('消息内容不能为空');
    });

    it('拒绝不支持的消息类型', async () => {
      const result = await executor({
        channel: 'dingtalk',
        title: 'Test',
        content: 'Hello',
        message_type: 'html',
        webhook_url: 'https://oapi.dingtalk.com/robot/send',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('不支持的消息类型');
    });
  });

  describe('渠道: serverchan', () => {
    const executor = createMessagePushExecutor();

    it('成功推送', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('{"code":0,"message":"success"}'),
      });

      const result = await executor({
        channel: 'serverchan',
        title: 'Test Title',
        content: 'Test Content',
        send_key: 'test-key-123',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('ServerChan');
      expect(result.output).toContain('Test Title');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('test-key-123');
      expect(calledUrl).toContain('Test%20Title');
    });

    it('HTTP错误应失败', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });

      const result = await executor({
        channel: 'serverchan',
        title: 'Test',
        content: 'Content',
        send_key: 'test-key',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('网络异常应失败', async () => {
      mockFetch.mockRejectedValue(new Error('Connection timeout'));

      const result = await executor({
        channel: 'serverchan',
        title: 'Test',
        content: 'Content',
        send_key: 'test-key',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection timeout');
    });

    it('无 send_key 且环境变量未设置应失败', async () => {
      const result = await executor({
        channel: 'serverchan',
        title: 'Test',
        content: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('SendKey 未配置');
    });
  });

  describe('渠道: dingtalk', () => {
    const executor = createMessagePushExecutor();

    it('成功推送 markdown', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('{"errcode":0}'),
      });

      const result = await executor({
        channel: 'dingtalk',
        title: '钉钉通知',
        content: '# 标题\n内容正文',
        webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=xxx',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('钉钉');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body || '{}') as Record<string, unknown>;
      expect(callBody.msgtype).toBe('markdown');
      expect((callBody.markdown as Record<string, unknown>).title).toBe('钉钉通知');
    });

    it('成功推送 text + @', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('{"errcode":0}'),
      });

      const result = await executor({
        channel: 'dingtalk',
        title: '告警',
        content: '服务异常',
        webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=xxx',
        message_type: 'text',
        at_mobiles: ['13800138000'],
      });

      expect(result.success).toBe(true);
      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body || '{}') as Record<string, unknown>;
      expect(callBody.msgtype).toBe('text');
      expect((callBody.at as Record<string, unknown>).atMobiles).toContain('13800138000');
    });

    it('缺少 webhook_url 应失败', async () => {
      const result = await executor({
        channel: 'dingtalk',
        title: 'Test',
        content: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('webhook_url');
    });

    it('HTTP错误应失败', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: jest.fn().mockResolvedValue('Forbidden'),
      });

      const result = await executor({
        channel: 'dingtalk',
        title: 'Test',
        content: 'Content',
        webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=xxx',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 403');
    });
  });

  describe('渠道: wecom', () => {
    const executor = createMessagePushExecutor();

    it('成功推送 markdown', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('{"errcode":0}'),
      });

      const result = await executor({
        channel: 'wecom',
        title: '企微通知',
        content: '# 报告\n数据已更新',
        webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('企业微信');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body || '{}') as Record<string, unknown>;
      expect(callBody.msgtype).toBe('markdown');
      expect((callBody.markdown as Record<string, unknown>).content).toBe('# 报告\n数据已更新');
    });

    it('成功推送 text', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('{"errcode":0}'),
      });

      const result = await executor({
        channel: 'wecom',
        title: '通知',
        content: '普通文本消息',
        webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
        message_type: 'text',
      });

      expect(result.success).toBe(true);
      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body || '{}') as Record<string, unknown>;
      expect(callBody.msgtype).toBe('text');
    });

    it('缺少 webhook_url 应失败', async () => {
      const result = await executor({
        channel: 'wecom',
        title: 'Test',
        content: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('webhook_url');
    });

    it('网络异常应失败', async () => {
      mockFetch.mockRejectedValue(new Error('Request failed'));

      const result = await executor({
        channel: 'wecom',
        title: 'Test',
        content: 'Content',
        webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Request failed');
    });
  });
});
