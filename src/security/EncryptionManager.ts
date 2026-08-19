/**
 * 加密管理器 - 处理数据加密和解密
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EnvironmentManager } from '../utils/EnvironmentManager';
import { Logger } from '../utils/Logger';
import { AuditLogger } from './AuditLogger';
import { EncryptedData, EncryptionConfig } from './types';

/**
 * 默认加密配置
 */
const DEFAULT_ENCRYPTION_CONFIG: EncryptionConfig = {
  aes: {
    keySize: 256,
    ivSize: 16,
    algorithm: 'aes-256-cbc',
  },
  hash: {
    algorithm: 'sha256',
    saltRounds: 10,
  },
  keyManagement: {
    keyStorePath: './data/keys',
    backupEnabled: true,
    backupInterval: 86400, // 24小时
  },
};

/**
 * 加密管理器类
 */
export class EncryptionManager {
  private config: EncryptionConfig;
  private encryptionKey: Buffer | null = null;
  private initialized: boolean = false;
  private auditLogger?: AuditLogger;
  private keyBackupTimer?: NodeJS.Timeout;

  constructor(config: Partial<EncryptionConfig> = {}) {
    this.config = { ...DEFAULT_ENCRYPTION_CONFIG, ...config };
  }

  /**
   * 设置审计日志器
   */
  public setAuditLogger(auditLogger: AuditLogger): void {
    this.auditLogger = auditLogger;
  }

  /**
   * 初始化加密管理器
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      this.ensureKeyStoreDirectory();
      await this.loadOrGenerateEncryptionKey();

      if (this.config.keyManagement.backupEnabled) {
        this.setupKeyBackup();
      }

      this.initialized = true;
    } catch (error) {
      Logger.error('❌ 加密管理器：初始化失败:', error as Error);
      throw error;
    }
  }

  /**
   * 确保密钥存储目录存在
   */
  private ensureKeyStoreDirectory(): void {
    const keyStorePath = this.config.keyManagement.keyStorePath;
    if (!fs.existsSync(keyStorePath)) {
      fs.mkdirSync(keyStorePath, { recursive: true });
      Logger.info(`📁 创建密钥存储目录：${keyStorePath}`);
    }
  }

  /**
   * 加载或生成加密密钥
   */
  private async loadOrGenerateEncryptionKey(): Promise<void> {
    const keyPath = path.join(
      this.config.keyManagement.keyStorePath,
      'encryption.key'
    );

    try {
      // 尝试加载现有密钥
      if (fs.existsSync(keyPath)) {
        const keyData = fs.readFileSync(keyPath, 'utf8');
        const { key } = JSON.parse(keyData);

        // 使用盐和密钥派生
        this.encryptionKey = Buffer.from(key, 'hex');
      } else {
        // 生成新密钥
        await this.generateEncryptionKey();
      }
    } catch (error) {
      Logger.error('❌ 加载密钥失败，生成新密钥:', error as Error);
      await this.generateEncryptionKey();
    }
  }

  /**
   * 生成加密密钥
   */
  private async generateEncryptionKey(): Promise<void> {
    // 从环境变量获取密钥
    const envKey = EnvironmentManager.getInstance().get('ENCRYPTION_KEY');
    let key: Buffer;
    let salt: Buffer;

    if (envKey && envKey !== 'default_encryption_key') {
      // 使用环境变量中的密钥
      salt = crypto.randomBytes(16);
      key = crypto.scryptSync(envKey, salt, this.config.aes.keySize / 8);
      Logger.info('🔑 使用环境变量中的加密密钥');
    } else {
      // 生成随机密钥（仅用于开发环境）
      salt = crypto.randomBytes(16);
      key = crypto.scryptSync(
        `jiabaixing_secure_key_${Date.now()}`,
        salt,
        this.config.aes.keySize / 8
      );
      Logger.warn(
        '⚠️ 使用自动生成的加密密钥，建议在生产环境中设置环境变量 ENCRYPTION_KEY'
      );
    }

    this.encryptionKey = key;

    // 保存密钥到文件（生产环境应使用更安全的存储方式）
    const keyPath = path.join(
      this.config.keyManagement.keyStorePath,
      'encryption.key'
    );
    const keyData = JSON.stringify({
      key: key.toString('hex'),
      salt: salt.toString('hex'),
      generatedAt: new Date().toISOString(),
      algorithm: this.config.aes.algorithm,
    });

    fs.writeFileSync(keyPath, keyData, { mode: 0o600 });
    this.logAudit('system', 'key.generated', { keyPath });
  }

  /**
   * 设置密钥备份
   */
  private setupKeyBackup(): void {
    this.keyBackupTimer = setInterval(async () => {
      await this.backupEncryptionKey();
    }, this.config.keyManagement.backupInterval * 1000);
  }

  /**
   * 备份加密密钥
   */
  private async backupEncryptionKey(): Promise<void> {
    try {
      if (!this.encryptionKey) {
        return;
      }

      const backupDir = path.join(
        this.config.keyManagement.keyStorePath,
        'backups'
      );
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const backupFilename = `encryption.key.backup.${Date.now()}`;
      const backupPath = path.join(backupDir, backupFilename);

      // 创建备份
      const keyPath = path.join(
        this.config.keyManagement.keyStorePath,
        'encryption.key'
      );
      if (fs.existsSync(keyPath)) {
        fs.copyFileSync(keyPath, backupPath);
        Logger.info(`💾 备份密钥到：${backupPath}`);

        // 记录审计日志
        this.logAudit('system', 'key.backup', { backupPath });

        // 清理旧备份（保留最近10个）
        this.cleanupOldBackups(backupDir);
      }
    } catch (error) {
      Logger.error('❌ 备份密钥失败:', error as Error);
      this.logAudit('system', 'key.backup.failure', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * 清理旧备份
   */
  private cleanupOldBackups(backupDir: string): void {
    try {
      const files = fs
        .readdirSync(backupDir)
        .filter((file) => file.startsWith('encryption.key.backup.'))
        .map((file) => ({
          name: file,
          path: path.join(backupDir, file),
          mtime: fs.statSync(path.join(backupDir, file)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // 保留最近10个备份
      const backupsToDelete = files.slice(10);
      backupsToDelete.forEach((backup) => {
        fs.unlinkSync(backup.path);
        Logger.info(`🗑️  删除旧备份：${backup.name}`);
      });
    } catch (error) {
      Logger.error('❌ 清理旧备份失败:', error as Error);
    }
  }

  /**
   * 加密数据
   */
  public encrypt(data: string | Buffer): EncryptedData {
    if (!this.initialized || !this.encryptionKey) {
      throw new Error('加密管理器未初始化');
    }

    try {
      // 生成随机IV
      const iv = crypto.randomBytes(this.config.aes.ivSize);

      // 创建加密器
      const cipher = crypto.createCipheriv(
        this.config.aes.algorithm,
        this.encryptionKey,
        iv
      );

      // 加密数据
      let encryptedData;
      if (typeof data === 'string') {
        encryptedData = Buffer.concat([
          cipher.update(data, 'utf8'),
          cipher.final(),
        ]);
      } else {
        encryptedData = Buffer.concat([cipher.update(data), cipher.final()]);
      }

      const result: EncryptedData = {
        iv: iv.toString('hex'),
        data: encryptedData.toString('hex'),
        timestamp: new Date(),
      };

      // 记录审计日志
      this.logAudit('system', 'data.encrypted', {
        dataSize: typeof data === 'string' ? data.length : data.length,
        algorithm: this.config.aes.algorithm,
      });

      return result;
    } catch (error) {
      Logger.error('❌ 加密数据失败:', error as Error);
      this.logAudit('system', 'data.encrypt.failure', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * 解密数据
   */
  public decrypt(encryptedData: EncryptedData): string {
    if (!this.initialized || !this.encryptionKey) {
      throw new Error('加密管理器未初始化');
    }

    try {
      // 解析IV和加密数据
      const iv = Buffer.from(encryptedData.iv, 'hex');
      const encrypted = Buffer.from(encryptedData.data, 'hex');

      // 创建解密器
      const decipher = crypto.createDecipheriv(
        this.config.aes.algorithm,
        this.encryptionKey,
        iv
      );

      // 解密数据
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      const result = decrypted.toString('utf8');

      // 记录审计日志
      this.logAudit('system', 'data.decrypted', {
        dataSize: encrypted.length,
        algorithm: this.config.aes.algorithm,
      });

      return result;
    } catch (error) {
      Logger.error('❌ 解密数据失败:', error as Error);
      this.logAudit('system', 'data.decrypt.failure', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * 生成哈希值
   */
  public hash(data: string): string {
    try {
      const hasher = crypto.createHash(this.config.hash.algorithm);
      hasher.update(data);
      const hash = hasher.digest('hex');

      // 记录审计日志
      this.logAudit('system', 'data.hashed', {
        dataSize: data.length,
        algorithm: this.config.hash.algorithm,
      });

      return hash;
    } catch (error) {
      Logger.error('❌ 生成哈希值失败:', error as Error);
      this.logAudit('system', 'data.hash.failure', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * 生成带盐的哈希值
   */
  public async hashWithSalt(
    data: string
  ): Promise<{ hash: string; salt: string }> {
    try {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = this.hash(data + salt);

      return { hash, salt };
    } catch (error) {
      Logger.error('❌ 生成带盐哈希值失败:', error as Error);
      throw error;
    }
  }

  /**
   * 同步生成带盐的哈希值（用于密码哈希）
   */
  public hashWithSaltSync(data: string, salt: string): string {
    return this.hash(data + salt);
  }

  /**
   * 验证带盐的哈希值
   */
  public verifyHashWithSalt(data: string, hash: string, salt: string): boolean {
    try {
      const computedHash = this.hash(data + salt);
      return computedHash === hash;
    } catch (error) {
      Logger.error('❌ 验证哈希值失败:', error as Error);
      return false;
    }
  }

  /**
   * 生成随机密钥
   */
  public generateRandomKey(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * 记录审计日志
   */
  private logAudit(
    userId: string | undefined,
    action: string,
    details: Record<string, unknown>
  ): void {
    if (this.auditLogger) {
      this.auditLogger.log({
        userId: userId || 'system',
        action,
        resource: 'encryption',
        result: action.includes('failure') ? 'failure' : 'success',
        details,
      });
    }
  }

  /**
   * 关闭加密管理器
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    Logger.info('🔏 加密管理器：关闭中...');

    try {
      // 停止密钥备份定时器
      if (this.keyBackupTimer) {
        clearInterval(this.keyBackupTimer);
        this.keyBackupTimer = undefined;
      }

      // 清理资源
      this.encryptionKey = null;
      this.initialized = false;

      Logger.info('✅ 加密管理器：关闭完成！');
    } catch (error) {
      Logger.error('❌ 加密管理器：关闭失败:', error as Error);
      throw error;
    }
  }
}
