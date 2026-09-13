"use strict";
/**
 * GatewaySessionStore — 网关会话持久化
 *
 * 存储平台 OAuth token、会话状态、用户白名单到 SQLite。
 * 网关重启后自动恢复连接，无需重新扫码/授权。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewaySessionStore = void 0;
const path_1 = __importDefault(require("path"));
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_platform_sessions (
  platform TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS gateway_chat_sessions (
  chat_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  session_data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  PRIMARY KEY (chat_id, platform)
);

CREATE TABLE IF NOT EXISTS gateway_allowed_users (
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
  paired_at INTEGER NOT NULL,
  paired_by TEXT,
  PRIMARY KEY (platform, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_active ON gateway_chat_sessions(last_active);
CREATE INDEX IF NOT EXISTS idx_allowed_users_role ON gateway_allowed_users(role);

CREATE TABLE IF NOT EXISTS gateway_token_locks (
  token_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  owner TEXT NOT NULL
);
`;
class GatewaySessionStore {
    db;
    dbPath;
    constructor(dbPath) {
        this.dbPath =
            dbPath || path_1.default.join(process.cwd(), 'data', 'gateway_sessions.db');
        this.db = (0, DatabaseShim_1.createDatabase)(this.dbPath);
        this.db.exec(SCHEMA);
        Logger_1.Logger.info(`🗄️ 网关会话存储已就绪: ${this.dbPath}`, 'GatewaySessionStore');
    }
    // ==================== 平台会话 ====================
    /** 保存平台连接配置 */
    savePlatformSession(platform, configJson, expiresAt) {
        this.db
            .prepare(`INSERT OR REPLACE INTO gateway_platform_sessions (platform, config_json, connected_at, expires_at)
         VALUES (?, ?, ?, ?)`)
            .run(platform, configJson, Date.now(), expiresAt ?? null);
        Logger_1.Logger.debug(`💾 平台会话已保存: ${platform}`, 'GatewaySessionStore');
    }
    /** 读取平台连接配置 */
    getPlatformSession(platform) {
        const row = this.db
            .prepare('SELECT platform, config_json, connected_at, expires_at FROM gateway_platform_sessions WHERE platform = ?')
            .get(platform);
        if (!row)
            return undefined;
        const session = {
            platform: row.platform,
            configJson: row.config_json,
            connectedAt: row.connected_at,
            expiresAt: row.expires_at,
        };
        // 检查是否过期
        if (session.expiresAt && Date.now() > session.expiresAt) {
            this.deletePlatformSession(platform);
            return undefined;
        }
        return session;
    }
    /** 获取所有已保存的平台会话 */
    getAllPlatformSessions() {
        const rows = this.db
            .prepare('SELECT platform, config_json, connected_at, expires_at FROM gateway_platform_sessions')
            .all();
        return rows.map((r) => ({
            platform: r.platform,
            configJson: r.config_json,
            connectedAt: r.connected_at,
            expiresAt: r.expires_at,
        }));
    }
    /** 删除平台会话 */
    deletePlatformSession(platform) {
        this.db
            .prepare('DELETE FROM gateway_platform_sessions WHERE platform = ?')
            .run(platform);
    }
    // ==================== 聊天会话 ====================
    /** 保存聊天会话数据 */
    saveChatSession(chatId, platform, sessionData) {
        // 先检查是否存在，存在则更新时间，否则插入新记录
        const existing = this.getChatSession(chatId, platform);
        if (existing) {
            this.db
                .prepare('UPDATE gateway_chat_sessions SET session_data = ?, last_active = ? WHERE chat_id = ? AND platform = ?')
                .run(sessionData, Date.now(), chatId, platform);
        }
        else {
            this.db
                .prepare(`INSERT INTO gateway_chat_sessions (chat_id, platform, session_data, created_at, last_active)
           VALUES (?, ?, ?, ?, ?)`)
                .run(chatId, platform, sessionData, Date.now(), Date.now());
        }
    }
    /** 读取聊天会话 */
    getChatSession(chatId, platform) {
        const row = this.db
            .prepare('SELECT chat_id, platform, session_data, created_at, last_active FROM gateway_chat_sessions WHERE chat_id = ? AND platform = ?')
            .get(chatId, platform);
        if (!row)
            return undefined;
        return {
            chatId: row.chat_id,
            platform: row.platform,
            sessionData: row.session_data,
            createdAt: row.created_at,
            lastActive: row.last_active,
        };
    }
    /** 更新会话活跃时间 */
    touchChatSession(chatId, platform) {
        this.db
            .prepare('UPDATE gateway_chat_sessions SET last_active = ? WHERE chat_id = ? AND platform = ?')
            .run(Date.now(), chatId, platform);
    }
    /** 删除聊天会话 */
    deleteChatSession(chatId, platform) {
        this.db
            .prepare('DELETE FROM gateway_chat_sessions WHERE chat_id = ? AND platform = ?')
            .run(chatId, platform);
    }
    // ==================== 用户白名单 ====================
    /** 添加白名单用户 */
    addAllowedUser(platform, userId, role = 'user', pairedBy) {
        this.db
            .prepare(`INSERT OR REPLACE INTO gateway_allowed_users (platform, user_id, role, paired_at, paired_by)
         VALUES (?, ?, ?, ?, ?)`)
            .run(platform, userId, role, Date.now(), pairedBy ?? null);
        Logger_1.Logger.info(`🔓 用户已加入白名单: ${platform}/${userId} (${role})`, 'GatewaySessionStore');
    }
    /** 移除白名单用户 */
    removeAllowedUser(platform, userId) {
        const result = this.db
            .prepare('DELETE FROM gateway_allowed_users WHERE platform = ? AND user_id = ?')
            .run(platform, userId);
        return result.changes > 0;
    }
    /** 检查用户是否在白名单中 */
    isUserAllowed(platform, userId) {
        const row = this.db
            .prepare('SELECT role FROM gateway_allowed_users WHERE platform = ? AND user_id = ?')
            .get(platform, userId);
        if (!row)
            return { allowed: false };
        return { allowed: true, role: row.role };
    }
    /** 获取平台所有白名单用户 */
    getAllowedUsers(platform) {
        const rows = this.db
            .prepare('SELECT platform, user_id, role, paired_at, paired_by FROM gateway_allowed_users WHERE platform = ?')
            .all(platform);
        return rows.map((r) => ({
            platform: r.platform,
            userId: r.user_id,
            role: r.role,
            pairedAt: r.paired_at,
            pairedBy: r.paired_by,
        }));
    }
    /** 获取所有平台的所有白名单用户 */
    getAllAllowedUsers() {
        const rows = this.db
            .prepare('SELECT platform, user_id, role, paired_at, paired_by FROM gateway_allowed_users')
            .all();
        return rows.map((r) => ({
            platform: r.platform,
            userId: r.user_id,
            role: r.role,
            pairedAt: r.paired_at,
            pairedBy: r.paired_by,
        }));
    }
    // ==================== Token 锁 ====================
    /**
     * 获取 Token 锁。防止多个实例使用同一 bot token。
     * @returns 是否成功获取锁
     */
    acquireTokenLock(tokenHash, platform, owner) {
        try {
            const existing = this.db
                .prepare('SELECT owner, acquired_at FROM gateway_token_locks WHERE token_hash = ?')
                .get(tokenHash);
            if (existing) {
                const lockAge = Date.now() - (existing.acquired_at || 0);
                if (lockAge > 24 * 60 * 60 * 1000) {
                    Logger_1.Logger.warn(`🔒 Token 锁已过期 (>24h)，强制释放: ${platform}/${tokenHash.substring(0, 8)}...`, 'GatewaySessionStore');
                    this.db
                        .prepare('DELETE FROM gateway_token_locks WHERE token_hash = ?')
                        .run(tokenHash);
                }
                else {
                    Logger_1.Logger.warn(`🔒 Token 已被锁定: ${platform}/${tokenHash.substring(0, 8)}... (所有者: ${existing.owner})`, 'GatewaySessionStore');
                    return false;
                }
            }
            this.db
                .prepare('INSERT INTO gateway_token_locks (token_hash, platform, acquired_at, owner) VALUES (?, ?, ?, ?)')
                .run(tokenHash, platform, Date.now(), owner);
            Logger_1.Logger.info(`🔒 Token 锁定: ${platform}/${tokenHash.substring(0, 8)}...`, 'GatewaySessionStore');
            return true;
        }
        catch {
            return false;
        }
    }
    /** 释放 Token 锁 */
    releaseTokenLock(tokenHash, owner) {
        const result = this.db
            .prepare('DELETE FROM gateway_token_locks WHERE token_hash = ? AND owner = ?')
            .run(tokenHash, owner);
        if (result.changes > 0) {
            Logger_1.Logger.info(`🔓 Token 解锁: ${tokenHash.substring(0, 8)}...`, 'GatewaySessionStore');
            return true;
        }
        return false;
    }
    /** 检查 Token 是否被锁定 */
    isTokenLocked(tokenHash) {
        const row = this.db
            .prepare('SELECT 1 FROM gateway_token_locks WHERE token_hash = ?')
            .get(tokenHash);
        return !!row;
    }
    /** 释放所有属于某个所有者的锁（进程退出时清理） */
    releaseAllLocksByOwner(owner) {
        const result = this.db
            .prepare('DELETE FROM gateway_token_locks WHERE owner = ?')
            .run(owner);
        return result.changes;
    }
    // ==================== 统计 ====================
    getStats() {
        const psRow = this.db
            .prepare('SELECT COUNT(*) as count FROM gateway_platform_sessions')
            .get();
        const csRow = this.db
            .prepare('SELECT COUNT(*) as count FROM gateway_chat_sessions')
            .get();
        const auRow = this.db
            .prepare('SELECT COUNT(*) as count FROM gateway_allowed_users')
            .get();
        const tlRow = this.db
            .prepare('SELECT COUNT(*) as count FROM gateway_token_locks')
            .get();
        return {
            platformSessions: psRow?.count ?? 0,
            chatSessions: csRow?.count ?? 0,
            allowedUsers: auRow?.count ?? 0,
            tokenLocks: tlRow?.count ?? 0,
        };
    }
    close() {
        this.db.close();
    }
}
exports.GatewaySessionStore = GatewaySessionStore;
