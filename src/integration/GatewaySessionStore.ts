/**
 * GatewaySessionStore — 网关会话持久化
 *
 * 存储平台 OAuth token、会话状态、用户白名单到 SQLite。
 * 网关重启后自动恢复连接，无需重新扫码/授权。
 */

import { createDatabase } from '../shared/DatabaseShim';
import type { DatabaseAdapter } from '../shared/DatabaseShim';
import { Logger } from '../utils/Logger';
import path from 'path';

/** 已持久化的平台连接 */
export interface StoredPlatformSession {
  platform: string;
  configJson: string;
  connectedAt: number;
  expiresAt: number | null;
}

/** 聊天会话状态 */
export interface StoredChatSession {
  chatId: string;
  platform: string;
  sessionData: string;
  createdAt: number;
  lastActive: number;
}

/** 白名单用户 */
export interface StoredAllowedUser {
  platform: string;
  userId: string;
  role: 'admin' | 'user';
  pairedAt: number;
  pairedBy?: string;
}

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

export class GatewaySessionStore {
  private db: DatabaseAdapter;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath || path.join(process.cwd(), 'data', 'gateway_sessions.db');
    this.db = createDatabase(this.dbPath);
    this.db.exec(SCHEMA);
    Logger.info(`🗄️ 网关会话存储已就绪: ${this.dbPath}`, 'GatewaySessionStore');
  }

  // ==================== 平台会话 ====================

  /** 保存平台连接配置 */
  savePlatformSession(
    platform: string,
    configJson: string,
    expiresAt?: number
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO gateway_platform_sessions (platform, config_json, connected_at, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(platform, configJson, Date.now(), expiresAt ?? null);
    Logger.debug(`💾 平台会话已保存: ${platform}`, 'GatewaySessionStore');
  }

  /** 读取平台连接配置 */
  getPlatformSession(platform: string): StoredPlatformSession | undefined {
    const row = this.db
      .prepare(
        'SELECT platform, config_json, connected_at, expires_at FROM gateway_platform_sessions WHERE platform = ?'
      )
      .get(platform) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const session: StoredPlatformSession = {
      platform: row.platform as string,
      configJson: row.config_json as string,
      connectedAt: row.connected_at as number,
      expiresAt: row.expires_at as number | null,
    };

    // 检查是否过期
    if (session.expiresAt && Date.now() > session.expiresAt) {
      this.deletePlatformSession(platform);
      return undefined;
    }
    return session;
  }

  /** 获取所有已保存的平台会话 */
  getAllPlatformSessions(): StoredPlatformSession[] {
    const rows = this.db
      .prepare(
        'SELECT platform, config_json, connected_at, expires_at FROM gateway_platform_sessions'
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      platform: r.platform as string,
      configJson: r.config_json as string,
      connectedAt: r.connected_at as number,
      expiresAt: r.expires_at as number | null,
    }));
  }

  /** 删除平台会话 */
  deletePlatformSession(platform: string): void {
    this.db
      .prepare('DELETE FROM gateway_platform_sessions WHERE platform = ?')
      .run(platform);
  }

  // ==================== 聊天会话 ====================

  /** 保存聊天会话数据 */
  saveChatSession(chatId: string, platform: string, sessionData: string): void {
    // 先检查是否存在，存在则更新时间，否则插入新记录
    const existing = this.getChatSession(chatId, platform);
    if (existing) {
      this.db
        .prepare(
          'UPDATE gateway_chat_sessions SET session_data = ?, last_active = ? WHERE chat_id = ? AND platform = ?'
        )
        .run(sessionData, Date.now(), chatId, platform);
    } else {
      this.db
        .prepare(
          `INSERT INTO gateway_chat_sessions (chat_id, platform, session_data, created_at, last_active)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(chatId, platform, sessionData, Date.now(), Date.now());
    }
  }

  /** 读取聊天会话 */
  getChatSession(
    chatId: string,
    platform: string
  ): StoredChatSession | undefined {
    const row = this.db
      .prepare(
        'SELECT chat_id, platform, session_data, created_at, last_active FROM gateway_chat_sessions WHERE chat_id = ? AND platform = ?'
      )
      .get(chatId, platform) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      chatId: row.chat_id as string,
      platform: row.platform as string,
      sessionData: row.session_data as string,
      createdAt: row.created_at as number,
      lastActive: row.last_active as number,
    };
  }

  /** 更新会话活跃时间 */
  touchChatSession(chatId: string, platform: string): void {
    this.db
      .prepare(
        'UPDATE gateway_chat_sessions SET last_active = ? WHERE chat_id = ? AND platform = ?'
      )
      .run(Date.now(), chatId, platform);
  }

  /** 删除聊天会话 */
  deleteChatSession(chatId: string, platform: string): void {
    this.db
      .prepare(
        'DELETE FROM gateway_chat_sessions WHERE chat_id = ? AND platform = ?'
      )
      .run(chatId, platform);
  }

  // ==================== 用户白名单 ====================

  /** 添加白名单用户 */
  addAllowedUser(
    platform: string,
    userId: string,
    role: 'admin' | 'user' = 'user',
    pairedBy?: string
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO gateway_allowed_users (platform, user_id, role, paired_at, paired_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(platform, userId, role, Date.now(), pairedBy ?? null);
    Logger.info(
      `🔓 用户已加入白名单: ${platform}/${userId} (${role})`,
      'GatewaySessionStore'
    );
  }

  /** 移除白名单用户 */
  removeAllowedUser(platform: string, userId: string): boolean {
    const result = this.db
      .prepare(
        'DELETE FROM gateway_allowed_users WHERE platform = ? AND user_id = ?'
      )
      .run(platform, userId);
    return result.changes > 0;
  }

  /** 检查用户是否在白名单中 */
  isUserAllowed(
    platform: string,
    userId: string
  ): { allowed: boolean; role?: string } {
    const row = this.db
      .prepare(
        'SELECT role FROM gateway_allowed_users WHERE platform = ? AND user_id = ?'
      )
      .get(platform, userId) as Record<string, unknown> | undefined;
    if (!row) return { allowed: false };
    return { allowed: true, role: row.role as string };
  }

  /** 获取平台所有白名单用户 */
  getAllowedUsers(platform: string): StoredAllowedUser[] {
    const rows = this.db
      .prepare(
        'SELECT platform, user_id, role, paired_at, paired_by FROM gateway_allowed_users WHERE platform = ?'
      )
      .all(platform) as Record<string, unknown>[];
    return rows.map((r) => ({
      platform: r.platform as string,
      userId: r.user_id as string,
      role: r.role as 'admin' | 'user',
      pairedAt: r.paired_at as number,
      pairedBy: r.paired_by as string | undefined,
    }));
  }

  /** 获取所有平台的所有白名单用户 */
  getAllAllowedUsers(): StoredAllowedUser[] {
    const rows = this.db
      .prepare(
        'SELECT platform, user_id, role, paired_at, paired_by FROM gateway_allowed_users'
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      platform: r.platform as string,
      userId: r.user_id as string,
      role: r.role as 'admin' | 'user',
      pairedAt: r.paired_at as number,
      pairedBy: r.paired_by as string | undefined,
    }));
  }

  // ==================== Token 锁 ====================

  /**
   * 获取 Token 锁。防止多个实例使用同一 bot token。
   * @returns 是否成功获取锁
   */
  acquireTokenLock(
    tokenHash: string,
    platform: string,
    owner: string
  ): boolean {
    try {
      // 检查是否已被锁定
      const existing = this.db
        .prepare('SELECT owner FROM gateway_token_locks WHERE token_hash = ?')
        .get(tokenHash) as Record<string, unknown> | undefined;
      if (existing) {
        Logger.warn(
          `🔒 Token 已被锁定: ${platform}/${tokenHash.substring(0, 8)}... (所有者: ${existing.owner})`,
          'GatewaySessionStore'
        );
        return false;
      }
      this.db
        .prepare(
          'INSERT INTO gateway_token_locks (token_hash, platform, acquired_at, owner) VALUES (?, ?, ?, ?)'
        )
        .run(tokenHash, platform, Date.now(), owner);
      Logger.info(
        `🔒 Token 锁定: ${platform}/${tokenHash.substring(0, 8)}...`,
        'GatewaySessionStore'
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 释放 Token 锁 */
  releaseTokenLock(tokenHash: string, owner: string): boolean {
    const result = this.db
      .prepare(
        'DELETE FROM gateway_token_locks WHERE token_hash = ? AND owner = ?'
      )
      .run(tokenHash, owner);
    if (result.changes > 0) {
      Logger.info(
        `🔓 Token 解锁: ${tokenHash.substring(0, 8)}...`,
        'GatewaySessionStore'
      );
      return true;
    }
    return false;
  }

  /** 检查 Token 是否被锁定 */
  isTokenLocked(tokenHash: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM gateway_token_locks WHERE token_hash = ?')
      .get(tokenHash);
    return !!row;
  }

  /** 释放所有属于某个所有者的锁（进程退出时清理） */
  releaseAllLocksByOwner(owner: string): number {
    const result = this.db
      .prepare('DELETE FROM gateway_token_locks WHERE owner = ?')
      .run(owner);
    return result.changes;
  }

  // ==================== 统计 ====================

  getStats(): {
    platformSessions: number;
    chatSessions: number;
    allowedUsers: number;
    tokenLocks: number;
  } {
    const psRow = this.db
      .prepare('SELECT COUNT(*) as count FROM gateway_platform_sessions')
      .get() as Record<string, unknown> | undefined;
    const csRow = this.db
      .prepare('SELECT COUNT(*) as count FROM gateway_chat_sessions')
      .get() as Record<string, unknown> | undefined;
    const auRow = this.db
      .prepare('SELECT COUNT(*) as count FROM gateway_allowed_users')
      .get() as Record<string, unknown> | undefined;
    const tlRow = this.db
      .prepare('SELECT COUNT(*) as count FROM gateway_token_locks')
      .get() as Record<string, unknown> | undefined;
    return {
      platformSessions: (psRow?.count as number) ?? 0,
      chatSessions: (csRow?.count as number) ?? 0,
      allowedUsers: (auRow?.count as number) ?? 0,
      tokenLocks: (tlRow?.count as number) ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}
