/**
 * DeliveryRouter — 投递路由抽象层
 *
 * 将投递目标解析为具体的平台调用。
 * 源自 Hermes gateway/delivery.py 模式。
 *
 * 目标格式:
 *   origin          — 发回原始会话（由调用方提供）
 *   local           — 保存到本地文件
 *   telegram        — Telegram 主频道
 *   telegram:chatId — 指定聊天
 *   discord         — Discord 主频道
 *   discord:chanId  — 指定频道
 *   slack           — Slack 主频道
 *   signal:+phone   — Signal 指定号码
 */

import { Logger } from '../utils/Logger';
import { IntegrationManager } from './IntegrationManager';

/** 解析后的投递指令 */
export interface DeliveryTarget {
  /** 目标平台 */
  platform: string;
  /** 目标频道/用户 ID */
  to?: string;
  /** 是否仅本地保存 */
  local: boolean;
}

/** 投递请求 */
export interface DeliveryRequest {
  /** 消息内容 */
  message: string;
  /** 投递目标（如 "telegram", "local", "telegram:chatId"） */
  target: string;
  /** 回退平台（origin 不可用时） */
  fallbackPlatform?: string;
  /** 回退频道 */
  fallbackTo?: string;
}

export class DeliveryRouter {
  /**
   * 解析投递目标字符串为 DeliveryTarget
   *
   * "telegram"           → { platform: "telegram", local: false }
   * "telegram:123"       → { platform: "telegram", to: "123", local: false }
   * "local"              → { platform: "local", local: true }
   * "origin"             → 使用 origin 参数
   */
  parseTarget(target: string): DeliveryTarget {
    const trimmed = target.trim();

    if (trimmed === 'local') {
      return { platform: 'local', local: true };
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      return {
        platform: trimmed.substring(0, colonIdx),
        to: trimmed.substring(colonIdx + 1),
        local: false,
      };
    }

    return { platform: trimmed, local: false };
  }

  /**
   * 执行投递
   * @returns 投递是否成功
   */
  async deliver(
    request: DeliveryRequest,
    originPlatform?: string,
    originTo?: string
  ): Promise<boolean> {
    const target = this.parseTarget(request.target);

    // local → 仅日志记录
    if (target.local) {
      Logger.info(
        `📋 [本地投递] ${request.message.substring(0, 100)}`,
        'DeliveryRouter'
      );
      return true;
    }

    // origin → 发回原始会话
    if (target.platform === 'origin') {
      if (originPlatform) {
        return this.sendTo(originPlatform, request.message, originTo || '');
      }
      if (request.fallbackPlatform) {
        return this.sendTo(
          request.fallbackPlatform,
          request.message,
          request.fallbackTo || ''
        );
      }
      Logger.warn('⚠️ origin 投递缺少原始平台信息', 'DeliveryRouter');
      return false;
    }

    // 指定平台
    return this.sendTo(target.platform, request.message, target.to || '');
  }

  /**
   * 将投递请求发送到多个目标
   */
  async deliverMulti(
    request: DeliveryRequest,
    targets: string[],
    originPlatform?: string,
    originTo?: string
  ): Promise<number> {
    let successCount = 0;
    for (const target of targets) {
      const ok = await this.deliver(
        { ...request, target },
        originPlatform,
        originTo
      );
      if (ok) successCount++;
    }
    return successCount;
  }

  /** 底层发送 */
  private async sendTo(
    platform: string,
    message: string,
    to: string
  ): Promise<boolean> {
    try {
      const im = IntegrationManager.getInstance();
      const result = await im.sendMessage({
        platform: platform as any,
        message,
        to,
      });
      Logger.debug(
        `📤 投递 ${platform}${to ? '/' + to : ''}: ${result.success ? '✅' : '❌'}`,
        'DeliveryRouter'
      );
      return result.success;
    } catch (err) {
      Logger.error(
        `❌ 投递到 ${platform} 失败`,
        err as Error,
        'DeliveryRouter'
      );
      return false;
    }
  }
}
