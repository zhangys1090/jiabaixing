/**
 * Harness Tool: message_push - 消息推送工具
 *
 * 支持三种推送渠道：
 * - ServerChan（微信推送）：https://sctapi.ftqq.com/{SENDKEY}.send
 * - 钉钉机器人 Webhook
 * - 企业微信机器人 Webhook
 *
 * 使用 Node.js 内置 fetch，零额外依赖。
 * 测试用 jest.fn() mock global.fetch。
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const MESSAGE_PUSH_DEF: ToolDefinition = {
  name: 'message_push',
  description:
    '发送消息推送通知到多种渠道（ServerChan微信推送、钉钉群机器人、企业微信机器人）。适用于告警通知、日报推送、任务完成通知、系统监控告警等需要主动推送给用户的场景。不适用于：需要即时双向聊天的场景（请使用 WebSocket）。',
  category: ToolCategory.NETWORK,
  parameters: {
    channel: {
      type: 'string',
      description: '推送渠道',
      enum: ['serverchan', 'dingtalk', 'wecom'],
    },
    title: {
      type: 'string',
      description: '消息标题',
    },
    content: {
      type: 'string',
      description: '消息内容（支持 Markdown）',
    },
    webhook_url: {
      type: 'string',
      description: 'Webhook 地址（钉钉/企微必填；ServerChan 不需要）',
    },
    send_key: {
      type: 'string',
      description: 'ServerChan SendKey（可选，默认从 SERVERCHAN_SENDKEY 环境变量读取）',
    },
    message_type: {
      type: 'string',
      description: '消息类型（仅钉钉/企微有效）',
      enum: ['text', 'markdown'],
      default: 'markdown',
    },
    at_mobiles: {
      type: 'array',
      description: '@ 的手机号列表（仅钉钉）',
      items: { type: 'string', description: '手机号码' },
    },
  },
  requiredParams: ['channel', 'title', 'content'],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: false,
  timeout: 15000,
};

export interface MessagePushDeps {
  // 使用 Node.js 内置 fetch，测试时 mock global.fetch
}

function ok(output: string, duration: number, metadata?: Record<string, unknown>): ToolResult {
  return { success: true, output, duration, validated: false, metadata };
}

function fail(error: string, duration: number): ToolResult {
  return { success: false, output: '', error, duration, validated: false };
}

/**
 * ServerChan 推送
 */
async function pushToServerChan(
  title: string,
  content: string,
  sendKey?: string
): Promise<string> {
  const key = sendKey || process.env.SERVERCHAN_SENDKEY;
  if (!key) {
    throw new Error('ServerChan SendKey 未配置（请设置 SERVERCHAN_SENDKEY 环境变量或传入 send_key 参数）');
  }

  const encodedTitle = encodeURIComponent(title);
  const encodedContent = encodeURIComponent(content);
  const url = `https://sctapi.ftqq.com/${key}.send?title=${encodedTitle}&desp=${encodedContent}`;

  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`ServerChan HTTP ${resp.status}: ${body.substring(0, 100)}`);
  }

  return `ServerChan 推送成功: ${title}`;
}

/**
 * 钉钉机器人推送
 */
async function pushToDingTalk(
  title: string,
  content: string,
  webhookUrl: string,
  messageType: string,
  atMobiles: string[]
): Promise<string> {
  if (!webhookUrl) {
    throw new Error('钉钉推送需要 webhook_url 参数');
  }

  let body: Record<string, unknown>;

  if (messageType === 'text') {
    body = {
      msgtype: 'text',
      text: { content },
    };
  } else {
    body = {
      msgtype: 'markdown',
      markdown: { title, text: content },
    };
  }

  if (atMobiles && atMobiles.length > 0) {
    body.at = { atMobiles };
  }

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const respBody = await resp.text().catch(() => '');
    throw new Error(`钉钉 HTTP ${resp.status}: ${respBody.substring(0, 100)}`);
  }

  return `钉钉推送成功: ${title}`;
}

/**
 * 企业微信机器人推送
 */
async function pushToWecom(
  title: string,
  content: string,
  webhookUrl: string,
  messageType: string
): Promise<string> {
  if (!webhookUrl) {
    throw new Error('企业微信推送需要 webhook_url 参数');
  }

  let body: Record<string, unknown>;

  if (messageType === 'text') {
    body = {
      msgtype: 'text',
      text: { content },
    };
  } else {
    body = {
      msgtype: 'markdown',
      markdown: { content },
    };
  }

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const respBody = await resp.text().catch(() => '');
    throw new Error(`企业微信 HTTP ${resp.status}: ${respBody.substring(0, 100)}`);
  }

  return `企业微信推送成功: ${title}`;
}

export function createMessagePushExecutor(deps: MessagePushDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const channel = String(params.channel || '').toLowerCase();
    const title = String(params.title || '');
    const content = String(params.content || '').trim();
    const webhookUrl = params.webhook_url ? String(params.webhook_url) : '';
    const sendKey = params.send_key ? String(params.send_key) : undefined;
    const messageType = String(params.message_type || 'markdown').toLowerCase();
    const atMobiles = (params.at_mobiles as string[]) || [];

    // 参数校验
    if (!['serverchan', 'dingtalk', 'wecom'].includes(channel)) {
      return fail(`不支持的推送渠道: ${channel}（支持: serverchan, dingtalk, wecom）`, Date.now() - startTime);
    }

    if (!title) {
      return fail('消息标题不能为空', Date.now() - startTime);
    }

    if (!content) {
      return fail('消息内容不能为空', Date.now() - startTime);
    }

    if (!['markdown', 'text'].includes(messageType)) {
      return fail(`不支持的消息类型: ${messageType}（支持: markdown, text）`, Date.now() - startTime);
    }

    try {
      let result: string;

      switch (channel) {
        case 'serverchan':
          result = await pushToServerChan(title, content, sendKey);
          break;
        case 'dingtalk':
          result = await pushToDingTalk(title, content, webhookUrl, messageType, atMobiles);
          break;
        case 'wecom':
          result = await pushToWecom(title, content, webhookUrl, messageType);
          break;
        default:
          return fail(`不支持的推送渠道: ${channel}`, Date.now() - startTime);
      }

      Logger.info(`消息推送成功 [${channel}]: ${title}`, 'MessagePush');
      return ok(result, Date.now() - startTime, { channel, title });
    } catch (error) {
      const errMsg = (error as Error).message;
      Logger.error(`消息推送失败 [${channel}]: ${errMsg}`, 'MessagePush' as any);
      return fail(`推送失败: ${errMsg}`, Date.now() - startTime);
    }
  };
}
