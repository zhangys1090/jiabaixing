/**
 * GatewayPairing — DM 配对码系统
 *
 * 管理员通过 /pair 生成一次性配对码。
 * 新用户私信 bot 输入该码后自动加入白名单。
 * 码 1 小时后过期，有频率限制。
 */

import crypto from 'crypto';
import { Logger } from '../utils/Logger';

/** 配对码条目 */
interface PairingCode {
  code: string;
  platform: string;
  adminUserId: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/** 配对码长度 */
const CODE_LENGTH = 8;
/** 默认过期时间（毫秒） */
const CODE_TTL_MS = 60 * 60 * 1000; // 1 小时
/** 最大待使用配对码数 */
const MAX_PENDING_CODES = 10;
/** 速率限制：同一 IP/用户每分钟最多生成几个码 */
const RATE_LIMIT_PER_MIN = 3;

export class GatewayPairing {
  // 实例级存储（每个实例独立，重启后失效）
  private pendingCodes = new Map<string, PairingCode>();
  private rateLimitMap = new Map<string, number[]>();
  /**
   * 生成配对码
   * @param platform - 平台名称
   * @param adminUserId - 管理员用户 ID
   * @returns 配对码字符串，失败返回 null
   */
  generateCode(platform: string, adminUserId: string): string | null {
    // 速率限制检查
    const now = Date.now();
    const windowStart = now - 60000;
    const userKey = `${platform}:${adminUserId}`;
    const timestamps = this.rateLimitMap.get(userKey) || [];
    const recent = timestamps.filter((t) => t > windowStart);
    if (recent.length >= RATE_LIMIT_PER_MIN) {
      Logger.warn(`⏳ 配对码速率限制: ${userKey}`, 'GatewayPairing');
      return null;
    }
    this.rateLimitMap.set(userKey, [...recent, now]);

    // 检查待使用码数量
    const pendingCount = Array.from(this.pendingCodes.values()).filter(
      (c) =>
        c.adminUserId === adminUserId && !c.used && Date.now() < c.expiresAt
    ).length;
    if (pendingCount >= MAX_PENDING_CODES) {
      Logger.warn(
        `⚠️ 待使用配对码过多: ${userKey} (${pendingCount})`,
        'GatewayPairing'
      );
      return null;
    }

    // 生成随机码
    const code = crypto
      .randomBytes(CODE_LENGTH / 2)
      .toString('hex')
      .toUpperCase();

    const entry: PairingCode = {
      code,
      platform,
      adminUserId,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
      used: false,
    };

    this.pendingCodes.set(code, entry);

    Logger.info(
      `🔑 配对码已生成: ${code} (平台: ${platform}, 管理员: ${adminUserId}, 过期: ${new Date(entry.expiresAt).toLocaleTimeString()})`,
      'GatewayPairing'
    );

    return code;
  }

  /**
   * 尝试验证并消费配对码
   * @param input - 用户输入的内容
   * @returns 验证成功时返回配对信息，否则 null
   */
  tryConsume(input: string): {
    platform: string;
    adminUserId: string;
    code: string;
  } | null {
    const trimmed = input.trim().toUpperCase();
    const entry = this.pendingCodes.get(trimmed);
    if (!entry) return null;

    // 检查是否已使用
    if (entry.used) {
      this.pendingCodes.delete(trimmed);
      return null;
    }

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.pendingCodes.delete(trimmed);
      Logger.info(`🔑 配对码已过期: ${trimmed}`, 'GatewayPairing');
      return null;
    }

    // 标记已使用
    entry.used = true;
    this.pendingCodes.delete(trimmed);

    Logger.info(
      `✅ 配对码已使用: ${trimmed} → 平台: ${entry.platform}, 管理员: ${entry.adminUserId}`,
      'GatewayPairing'
    );

    return {
      platform: entry.platform,
      adminUserId: entry.adminUserId,
      code: trimmed,
    };
  }

  /**
   * 检查输入是否为配对码格式
   */
  looksLikePairingCode(input: string): boolean {
    const trimmed = input.trim().toUpperCase();
    return /^[A-F0-9]{8}$/.test(trimmed);
  }

  /** 清理过期配对码 */
  cleanExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [code, entry] of this.pendingCodes) {
      if (now > entry.expiresAt) {
        this.pendingCodes.delete(code);
        count++;
      }
    }
    return count;
  }

  /** 获取待使用配对码数量 */
  getPendingCount(): number {
    this.cleanExpired();
    return this.pendingCodes.size;
  }
}
