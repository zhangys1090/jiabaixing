import crypto from 'crypto';
import { createDatabase } from '../shared/DatabaseShim';
import { Logger } from '../utils/Logger';
import { AuditLogger } from './AuditLogger';
import { ApiKeyEntry, ApiKeyRotationConfig, ApiKeyStatus } from './types';

const DEFAULT_ROTATION_CONFIG: ApiKeyRotationConfig = {
  autoRotateDays: 90,
  gracePeriodMs: 24 * 60 * 60 * 1000,
  maxUsageBeforeRotation: 100_000,
  encryptKeys: true,
};

export class ApiKeyManager {
  private static instance: ApiKeyManager | null = null;
  private config: ApiKeyRotationConfig;
  private db: import('../shared/DatabaseShim').DatabaseAdapter | null = null;
  private auditLogger?: AuditLogger;
  private initialized = false;
  private rotationTimer?: NodeJS.Timeout;
  private encryptionKey: Buffer | null = null;

  private constructor(config?: Partial<ApiKeyRotationConfig>) {
    this.config = { ...DEFAULT_ROTATION_CONFIG, ...config };
  }

  public static create(config?: Partial<ApiKeyRotationConfig>): ApiKeyManager {
    return new ApiKeyManager(config);
  }

  public static getInstance(
    config?: Partial<ApiKeyRotationConfig>
  ): ApiKeyManager {
    if (!ApiKeyManager.instance) {
      ApiKeyManager.instance = ApiKeyManager.create(config);
    }
    return ApiKeyManager.instance;
  }

  public setAuditLogger(auditLogger: AuditLogger): void {
    this.auditLogger = auditLogger;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.initializeEncryption();
      this.initializeDatabase();
      this.startRotationCheck();
      this.initialized = true;
      Logger.info('✅ ApiKeyManager 初始化完成', 'ApiKeyManager');
    } catch (error) {
      Logger.error(
        '❌ ApiKeyManager 初始化失败',
        error as Error,
        'ApiKeyManager'
      );
      throw error;
    }
  }

  private initializeEncryption(): void {
    const envKey = process.env.API_KEY_ENCRYPTION_KEY;
    if (envKey) {
      this.encryptionKey = Buffer.from(envKey, 'hex');
    } else {
      this.encryptionKey = crypto.randomBytes(32);
      Logger.warn(
        '⚠️ API_KEY_ENCRYPTION_KEY 未设置，使用临时密钥（重启后密钥将失效）',
        'ApiKeyManager'
      );
    }
  }

  private initializeDatabase(): void {
    this.db = createDatabase('./data/security/apikeys.db');
    if (!this.db) {
      Logger.warn('⚠️ ApiKeyManager 数据库降级为内存模式', 'ApiKeyManager');
      return;
    }

    try {
      this.db.pragma('journal_mode = WAL');
    } catch (pragmaErr) {
      Logger.debug(
        `ApiKeyManager WAL 模式设置跳过: ${(pragmaErr as Error).message}`,
        'ApiKeyManager'
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        rotated_from TEXT,
        rotated_to TEXT,
        last_used_at INTEGER,
        usage_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_apikeys_status ON api_keys(status);
      CREATE INDEX IF NOT EXISTS idx_apikeys_provider ON api_keys(provider);
      CREATE INDEX IF NOT EXISTS idx_apikeys_name ON api_keys(name);
    `);
  }

  private startRotationCheck(): void {
    this.rotationTimer = setInterval(
      () => {
        this.checkAutoRotation().catch((err) => {
          Logger.warn(
            `⚠️ 自动轮换检查失败: ${(err as Error).message}`,
            'ApiKeyManager'
          );
        });
      },
      60 * 60 * 1000
    );
  }

  private encrypt(plaintext: string): string {
    if (!this.encryptionKey || !this.config.encryptKeys) return plaintext;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }

  private decrypt(ciphertext: string): string {
    if (!this.encryptionKey || !this.config.encryptKeys) return ciphertext;
    const parts = ciphertext.split(':');
    if (parts.length !== 2) return ciphertext;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      this.encryptionKey,
      iv
    );
    return (
      decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8')
    );
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  public registerKey(
    name: string,
    provider: string,
    rawKey: string,
    expiresAt?: number
  ): ApiKeyEntry {
    const entry: ApiKeyEntry = {
      id: crypto.randomUUID(),
      name,
      provider,
      keyHash: this.hashKey(rawKey),
      encryptedKey: this.encrypt(rawKey),
      status: 'active',
      createdAt: Date.now(),
      expiresAt:
        expiresAt ??
        Date.now() + this.config.autoRotateDays * 24 * 60 * 60 * 1000,
      rotatedFrom: null,
      rotatedTo: null,
      lastUsedAt: null,
      usageCount: 0,
      metadata: {},
    };

    this.persistEntry(entry);
    this.auditLog(
      'apikey.registered',
      `API Key 注册: ${name} (${provider})`,
      'success'
    );
    return entry;
  }

  public validateKey(
    name: string,
    rawKey: string
  ): { valid: boolean; entry?: ApiKeyEntry; error?: string } {
    const entries = this.loadEntriesByName(name);
    const keyHash = this.hashKey(rawKey);

    for (const entry of entries) {
      if (entry.keyHash === keyHash) {
        if (entry.status === 'revoked') {
          return { valid: false, error: 'Key 已撤销' };
        }
        if (
          entry.status === 'expired' ||
          (entry.expiresAt && entry.expiresAt < Date.now())
        ) {
          this.updateStatus(entry.id, 'expired');
          return { valid: false, error: 'Key 已过期' };
        }
        if (entry.status === 'active' || entry.status === 'rotating') {
          this.incrementUsage(entry.id);
          return { valid: true, entry };
        }
        if (
          entry.status === 'deprecated' &&
          entry.expiresAt &&
          Date.now() - entry.expiresAt < this.config.gracePeriodMs
        ) {
          this.incrementUsage(entry.id);
          return { valid: true, entry };
        }
      }
    }

    return { valid: false, error: 'Key 不匹配或不存在' };
  }

  public getActiveKey(name: string): string | null {
    const entries = this.loadEntriesByName(name);
    const active = entries.find((e) => e.status === 'active');
    if (!active) return null;
    return this.decrypt(active.encryptedKey);
  }

  public async rotateKey(
    name: string,
    newRawKey?: string
  ): Promise<ApiKeyEntry> {
    const entries = this.loadEntriesByName(name);
    const current = entries.find((e) => e.status === 'active');

    if (!current) {
      throw new Error(`未找到活跃的 API Key: ${name}`);
    }

    const newKey = newRawKey || this.generateKey();
    const newEntry = this.registerKey(
      name,
      current.provider,
      newKey,
      current.expiresAt ?? undefined
    );

    this.updateStatus(current.id, 'rotating');
    current.rotatedTo = newEntry.id;
    this.persistEntry(current);

    newEntry.rotatedFrom = current.id;
    this.persistEntry(newEntry);

    setTimeout(() => {
      this.updateStatus(current.id, 'deprecated');
      this.auditLog('apikey.rotated', `API Key 轮换完成: ${name}`, 'success');
    }, this.config.gracePeriodMs);

    this.auditLog(
      'apikey.rotated',
      `API Key 开始轮换: ${name}，宽限期 ${this.config.gracePeriodMs}ms`,
      'success'
    );
    return newEntry;
  }

  public revokeKey(name: string): boolean {
    const entries = this.loadEntriesByName(name);
    let revoked = false;
    for (const entry of entries) {
      if (entry.status !== 'revoked') {
        this.updateStatus(entry.id, 'revoked');
        revoked = true;
      }
    }
    if (revoked) {
      this.auditLog('apikey.revoked', `API Key 撤销: ${name}`, 'success');
    }
    return revoked;
  }

  public listKeys(provider?: string): ApiKeyEntry[] {
    if (!this.db) return [];
    try {
      let sql = 'SELECT * FROM api_keys';
      const params: Record<string, unknown> = {};
      if (provider) {
        sql += ' WHERE provider = @provider';
        params.provider = provider;
      }
      sql += ' ORDER BY created_at DESC';
      const rows = this.db.prepare(sql).all(params) as Record<
        string,
        unknown
      >[];
      return rows.map(this.rowToEntry);
    } catch {
      return [];
    }
  }

  private async checkAutoRotation(): Promise<void> {
    const entries = this.listKeys();
    const now = Date.now();

    for (const entry of entries) {
      if (entry.status !== 'active') continue;

      const ageDays = (now - entry.createdAt) / (24 * 60 * 60 * 1000);
      const shouldRotateByAge = entry.expiresAt && now >= entry.expiresAt;
      const shouldRotateByUsage =
        entry.usageCount >= this.config.maxUsageBeforeRotation;

      if (shouldRotateByAge || shouldRotateByUsage) {
        Logger.info(
          `🔄 自动轮换 API Key: ${entry.name} (年龄: ${ageDays.toFixed(0)}天, 使用: ${entry.usageCount}次)`,
          'ApiKeyManager'
        );
        await this.rotateKey(entry.name);
      }
    }
  }

  private generateKey(): string {
    return 'sk-' + crypto.randomBytes(32).toString('base64url');
  }

  private persistEntry(entry: ApiKeyEntry): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO api_keys (
          id, name, provider, key_hash, encrypted_key, status,
          created_at, expires_at, rotated_from, rotated_to,
          last_used_at, usage_count, metadata
        ) VALUES (
          @id, @name, @provider, @key_hash, @encrypted_key, @status,
          @created_at, @expires_at, @rotated_from, @rotated_to,
          @last_used_at, @usage_count, @metadata
        )
      `);
      stmt.run({
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        key_hash: entry.keyHash,
        encrypted_key: entry.encryptedKey,
        status: entry.status,
        created_at: entry.createdAt,
        expires_at: entry.expiresAt,
        rotated_from: entry.rotatedFrom,
        rotated_to: entry.rotatedTo,
        last_used_at: entry.lastUsedAt,
        usage_count: entry.usageCount,
        metadata: JSON.stringify(entry.metadata),
      });
    } catch (error) {
      Logger.error('❌ 持久化 API Key 失败', error as Error, 'ApiKeyManager');
    }
  }

  private loadEntriesByName(name: string): ApiKeyEntry[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM api_keys WHERE name = @name ORDER BY created_at DESC'
      );
      const rows = stmt.all({ name }) as Record<string, unknown>[];
      return rows.map(this.rowToEntry);
    } catch {
      return [];
    }
  }

  private updateStatus(id: string, status: ApiKeyStatus): void {
    if (!this.db) return;
    try {
      this.db
        .prepare('UPDATE api_keys SET status = @status WHERE id = @id')
        .run({ id, status });
    } catch (error) {
      Logger.error('❌ 更新 API Key 状态失败', error as Error, 'ApiKeyManager');
    }
  }

  private incrementUsage(id: string): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          'UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = @now WHERE id = @id'
        )
        .run({ id, now: Date.now() });
    } catch (incErr) {
      Logger.warn(
        `API Key 使用计数更新失败: ${(incErr as Error).message}`,
        'ApiKeyManager'
      );
    }
  }

  private rowToEntry(row: Record<string, unknown>): ApiKeyEntry {
    return {
      id: row.id as string,
      name: row.name as string,
      provider: row.provider as string,
      keyHash: row.key_hash as string,
      encryptedKey: row.encrypted_key as string,
      status: row.status as ApiKeyStatus,
      createdAt: row.created_at as number,
      expiresAt: (row.expires_at as number) || undefined,
      rotatedFrom: (row.rotated_from as string) || undefined,
      rotatedTo: (row.rotated_to as string) || undefined,
      lastUsedAt: (row.last_used_at as number) || undefined,
      usageCount: (row.usage_count as number) || 0,
      metadata: JSON.parse((row.metadata as string) || '{}'),
    };
  }

  private auditLog(
    action: string,
    description: string,
    result: 'success' | 'failure'
  ): void {
    if (this.auditLogger) {
      try {
        this.auditLogger.log({
          action,
          result,
          category: 'apikey',
          details: { description },
        });
      } catch (auditErr) {
        Logger.warn(
          `审计日志写入失败: ${(auditErr as Error).message}`,
          'ApiKeyManager'
        );
      }
    }
  }

  public async shutdown(): Promise<void> {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }
}
