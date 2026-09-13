"use strict";
/**
 * GatewayPairing — DM 配对码系统
 *
 * 管理员通过 /pair 生成一次性配对码。
 * 新用户私信 bot 输入该码后自动加入白名单。
 * 码 1 小时后过期，有频率限制。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayPairing = void 0;
const crypto_1 = __importDefault(require("crypto"));
const Logger_1 = require("../utils/Logger");
/** 配对码长度 */
const CODE_LENGTH = 8;
/** 默认过期时间（毫秒） */
const CODE_TTL_MS = 60 * 60 * 1000; // 1 小时
/** 最大待使用配对码数 */
const MAX_PENDING_CODES = 10;
/** 速率限制：同一 IP/用户每分钟最多生成几个码 */
const RATE_LIMIT_PER_MIN = 3;
class GatewayPairing {
    // 实例级存储（每个实例独立，重启后失效）
    pendingCodes = new Map();
    rateLimitMap = new Map();
    /**
     * 生成配对码
     * @param platform - 平台名称
     * @param adminUserId - 管理员用户 ID
     * @returns 配对码字符串，失败返回 null
     */
    generateCode(platform, adminUserId) {
        // 速率限制检查
        const now = Date.now();
        const windowStart = now - 60000;
        const userKey = `${platform}:${adminUserId}`;
        const timestamps = this.rateLimitMap.get(userKey) || [];
        const recent = timestamps.filter((t) => t > windowStart);
        if (recent.length >= RATE_LIMIT_PER_MIN) {
            Logger_1.Logger.warn(`⏳ 配对码速率限制: ${userKey}`, 'GatewayPairing');
            return null;
        }
        this.rateLimitMap.set(userKey, [...recent, now]);
        // 检查待使用码数量
        const pendingCount = Array.from(this.pendingCodes.values()).filter((c) => c.adminUserId === adminUserId && !c.used && Date.now() < c.expiresAt).length;
        if (pendingCount >= MAX_PENDING_CODES) {
            Logger_1.Logger.warn(`⚠️ 待使用配对码过多: ${userKey} (${pendingCount})`, 'GatewayPairing');
            return null;
        }
        // 生成随机码
        const code = crypto_1.default
            .randomBytes(CODE_LENGTH / 2)
            .toString('hex')
            .toUpperCase();
        const entry = {
            code,
            platform,
            adminUserId,
            createdAt: now,
            expiresAt: now + CODE_TTL_MS,
            used: false,
        };
        this.pendingCodes.set(code, entry);
        Logger_1.Logger.info(`🔑 配对码已生成: ${code} (平台: ${platform}, 管理员: ${adminUserId}, 过期: ${new Date(entry.expiresAt).toLocaleTimeString()})`, 'GatewayPairing');
        return code;
    }
    /**
     * 尝试验证并消费配对码
     * @param input - 用户输入的内容
     * @returns 验证成功时返回配对信息，否则 null
     */
    tryConsume(input) {
        const trimmed = input.trim().toUpperCase();
        const entry = this.pendingCodes.get(trimmed);
        if (!entry)
            return null;
        // 检查是否已使用
        if (entry.used) {
            this.pendingCodes.delete(trimmed);
            return null;
        }
        // 检查是否过期
        if (Date.now() > entry.expiresAt) {
            this.pendingCodes.delete(trimmed);
            Logger_1.Logger.info(`🔑 配对码已过期: ${trimmed}`, 'GatewayPairing');
            return null;
        }
        // 标记已使用
        entry.used = true;
        this.pendingCodes.delete(trimmed);
        Logger_1.Logger.info(`✅ 配对码已使用: ${trimmed} → 平台: ${entry.platform}, 管理员: ${entry.adminUserId}`, 'GatewayPairing');
        return {
            platform: entry.platform,
            adminUserId: entry.adminUserId,
            code: trimmed,
        };
    }
    /**
     * 检查输入是否为配对码格式
     */
    looksLikePairingCode(input) {
        const trimmed = input.trim().toUpperCase();
        return /^[A-F0-9]{8}$/.test(trimmed);
    }
    /** 清理过期配对码 */
    cleanExpired() {
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
    getPendingCount() {
        this.cleanExpired();
        return this.pendingCodes.size;
    }
}
exports.GatewayPairing = GatewayPairing;
