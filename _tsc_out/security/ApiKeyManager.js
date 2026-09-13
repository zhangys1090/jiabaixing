"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiKeyManager = void 0;
const crypto_1 = __importDefault(require("crypto"));
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
const DEFAULT_ROTATION_CONFIG = {
    autoRotateDays: 90,
    gracePeriodMs: 24 * 60 * 60 * 1000,
    maxUsageBeforeRotation: 100_000,
    encryptKeys: true,
};
class ApiKeyManager {
    static instance = null;
    config;
    db = null;
    auditLogger;
    initialized = false;
    rotationTimer;
    encryptionKey = null;
    constructor(config) {
        this.config = { ...DEFAULT_ROTATION_CONFIG, ...config };
    }
    static create(config) {
        return new ApiKeyManager(config);
    }
    static getInstance(config) {
        if (!ApiKeyManager.instance) {
            ApiKeyManager.instance = ApiKeyManager.create(config);
        }
        return ApiKeyManager.instance;
    }
    setAuditLogger(auditLogger) {
        this.auditLogger = auditLogger;
    }
    async initialize() {
        if (this.initialized)
            return;
        try {
            this.initializeEncryption();
            this.initializeDatabase();
            this.startRotationCheck();
            this.initialized = true;
            Logger_1.Logger.info('✅ ApiKeyManager 初始化完成', 'ApiKeyManager');
        }
        catch (error) {
            Logger_1.Logger.error('❌ ApiKeyManager 初始化失败', error, 'ApiKeyManager');
            throw error;
        }
    }
    initializeEncryption() {
        const envKey = process.env.API_KEY_ENCRYPTION_KEY;
        if (envKey) {
            this.encryptionKey = Buffer.from(envKey, 'hex');
        }
        else {
            this.encryptionKey = crypto_1.default.randomBytes(32);
            Logger_1.Logger.warn('⚠️ API_KEY_ENCRYPTION_KEY 未设置，使用临时密钥（重启后密钥将失效）', 'ApiKeyManager');
        }
    }
    initializeDatabase() {
        this.db = (0, DatabaseShim_1.createDatabase)('./data/security/apikeys.db');
        if (!this.db) {
            Logger_1.Logger.warn('⚠️ ApiKeyManager 数据库降级为内存模式', 'ApiKeyManager');
            return;
        }
        try {
            this.db.pragma('journal_mode = WAL');
        }
        catch (pragmaErr) {
            Logger_1.Logger.debug(`ApiKeyManager WAL 模式设置跳过: ${pragmaErr.message}`, 'ApiKeyManager');
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
    startRotationCheck() {
        this.rotationTimer = setInterval(() => {
            this.checkAutoRotation().catch((err) => {
                Logger_1.Logger.warn(`⚠️ 自动轮换检查失败: ${err.message}`, 'ApiKeyManager');
            });
        }, 60 * 60 * 1000);
    }
    encrypt(plaintext) {
        if (!this.encryptionKey || !this.config.encryptKeys)
            return plaintext;
        const iv = crypto_1.default.randomBytes(16);
        const cipher = crypto_1.default.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
        ]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    }
    decrypt(ciphertext) {
        if (!this.encryptionKey || !this.config.encryptKeys)
            return ciphertext;
        const parts = ciphertext.split(':');
        if (parts.length !== 2)
            return ciphertext;
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = Buffer.from(parts[1], 'hex');
        const decipher = crypto_1.default.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
        return (decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8'));
    }
    hashKey(key) {
        return crypto_1.default.createHash('sha256').update(key).digest('hex');
    }
    registerKey(name, provider, rawKey, expiresAt) {
        const entry = {
            id: crypto_1.default.randomUUID(),
            name,
            provider,
            keyHash: this.hashKey(rawKey),
            encryptedKey: this.encrypt(rawKey),
            status: 'active',
            createdAt: Date.now(),
            expiresAt: expiresAt ??
                Date.now() + this.config.autoRotateDays * 24 * 60 * 60 * 1000,
            rotatedFrom: null,
            rotatedTo: null,
            lastUsedAt: null,
            usageCount: 0,
            metadata: {},
        };
        this.persistEntry(entry);
        this.auditLog('apikey.registered', `API Key 注册: ${name} (${provider})`, 'success');
        return entry;
    }
    validateKey(name, rawKey) {
        const entries = this.loadEntriesByName(name);
        const keyHash = this.hashKey(rawKey);
        for (const entry of entries) {
            if (entry.keyHash === keyHash) {
                if (entry.status === 'revoked') {
                    return { valid: false, error: 'Key 已撤销' };
                }
                if (entry.status === 'expired' ||
                    (entry.expiresAt && entry.expiresAt < Date.now())) {
                    this.updateStatus(entry.id, 'expired');
                    return { valid: false, error: 'Key 已过期' };
                }
                if (entry.status === 'active' || entry.status === 'rotating') {
                    this.incrementUsage(entry.id);
                    return { valid: true, entry };
                }
                if (entry.status === 'deprecated' &&
                    entry.expiresAt &&
                    Date.now() - entry.expiresAt < this.config.gracePeriodMs) {
                    this.incrementUsage(entry.id);
                    return { valid: true, entry };
                }
            }
        }
        return { valid: false, error: 'Key 不匹配或不存在' };
    }
    getActiveKey(name) {
        const entries = this.loadEntriesByName(name);
        const active = entries.find((e) => e.status === 'active');
        if (!active)
            return null;
        return this.decrypt(active.encryptedKey);
    }
    async rotateKey(name, newRawKey) {
        const entries = this.loadEntriesByName(name);
        const current = entries.find((e) => e.status === 'active');
        if (!current) {
            throw new Error(`未找到活跃的 API Key: ${name}`);
        }
        const newKey = newRawKey || this.generateKey();
        const newEntry = this.registerKey(name, current.provider, newKey, current.expiresAt ?? undefined);
        this.updateStatus(current.id, 'rotating');
        current.rotatedTo = newEntry.id;
        this.persistEntry(current);
        newEntry.rotatedFrom = current.id;
        this.persistEntry(newEntry);
        setTimeout(() => {
            this.updateStatus(current.id, 'deprecated');
            this.auditLog('apikey.rotated', `API Key 轮换完成: ${name}`, 'success');
        }, this.config.gracePeriodMs);
        this.auditLog('apikey.rotated', `API Key 开始轮换: ${name}，宽限期 ${this.config.gracePeriodMs}ms`, 'success');
        return newEntry;
    }
    revokeKey(name) {
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
    listKeys(provider) {
        if (!this.db)
            return [];
        try {
            let sql = 'SELECT * FROM api_keys';
            const params = {};
            if (provider) {
                sql += ' WHERE provider = @provider';
                params.provider = provider;
            }
            sql += ' ORDER BY created_at DESC';
            const rows = this.db.prepare(sql).all(params);
            return rows.map(this.rowToEntry);
        }
        catch {
            return [];
        }
    }
    async checkAutoRotation() {
        const entries = this.listKeys();
        const now = Date.now();
        for (const entry of entries) {
            if (entry.status !== 'active')
                continue;
            const ageDays = (now - entry.createdAt) / (24 * 60 * 60 * 1000);
            const shouldRotateByAge = entry.expiresAt && now >= entry.expiresAt;
            const shouldRotateByUsage = entry.usageCount >= this.config.maxUsageBeforeRotation;
            if (shouldRotateByAge || shouldRotateByUsage) {
                Logger_1.Logger.info(`🔄 自动轮换 API Key: ${entry.name} (年龄: ${ageDays.toFixed(0)}天, 使用: ${entry.usageCount}次)`, 'ApiKeyManager');
                await this.rotateKey(entry.name);
            }
        }
    }
    generateKey() {
        return 'sk-' + crypto_1.default.randomBytes(32).toString('base64url');
    }
    persistEntry(entry) {
        if (!this.db)
            return;
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
        }
        catch (error) {
            Logger_1.Logger.error('❌ 持久化 API Key 失败', error, 'ApiKeyManager');
        }
    }
    loadEntriesByName(name) {
        if (!this.db)
            return [];
        try {
            const stmt = this.db.prepare('SELECT * FROM api_keys WHERE name = @name ORDER BY created_at DESC');
            const rows = stmt.all({ name });
            return rows.map(this.rowToEntry);
        }
        catch {
            return [];
        }
    }
    updateStatus(id, status) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare('UPDATE api_keys SET status = @status WHERE id = @id')
                .run({ id, status });
        }
        catch (error) {
            Logger_1.Logger.error('❌ 更新 API Key 状态失败', error, 'ApiKeyManager');
        }
    }
    incrementUsage(id) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare('UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = @now WHERE id = @id')
                .run({ id, now: Date.now() });
        }
        catch (incErr) {
            Logger_1.Logger.warn(`API Key 使用计数更新失败: ${incErr.message}`, 'ApiKeyManager');
        }
    }
    rowToEntry(row) {
        return {
            id: row.id,
            name: row.name,
            provider: row.provider,
            keyHash: row.key_hash,
            encryptedKey: row.encrypted_key,
            status: row.status,
            createdAt: row.created_at,
            expiresAt: row.expires_at || undefined,
            rotatedFrom: row.rotated_from || undefined,
            rotatedTo: row.rotated_to || undefined,
            lastUsedAt: row.last_used_at || undefined,
            usageCount: row.usage_count || 0,
            metadata: JSON.parse(row.metadata || '{}'),
        };
    }
    auditLog(action, description, result) {
        if (this.auditLogger) {
            try {
                this.auditLogger.log({
                    action,
                    result,
                    category: 'apikey',
                    details: { description },
                });
            }
            catch (auditErr) {
                Logger_1.Logger.warn(`审计日志写入失败: ${auditErr.message}`, 'ApiKeyManager');
            }
        }
    }
    async shutdown() {
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
exports.ApiKeyManager = ApiKeyManager;
