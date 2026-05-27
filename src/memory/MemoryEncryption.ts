/**
 * MemoryEncryption - 记忆加密
 * 从MemoryEngine拆分出的加密逻辑：
 * 1. 密钥生成与加载
 * 2. 数据加密/解密
 * 3. 长期记忆加密存储/解密读取
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { FileSystem } from '../io/FileSystem';
import Logger from '../utils/Logger';

export class MemoryEncryption {
  private encryptionKey: Buffer;

  constructor(encryptionKey?: Buffer) {
    this.encryptionKey = encryptionKey || Buffer.alloc(0);
  }

  /** 初始化加密密钥（在MemoryEngine.initialize()中调用） */
  async initialize(): Promise<void> {
    if (this.encryptionKey.length === 0) {
      this.encryptionKey = await this.generateOrLoadEncryptionKey();
    }
  }

  /** 生成或加载加密密钥 */
  private async generateOrLoadEncryptionKey(): Promise<Buffer> {
    const keyDir = path.join(process.cwd(), 'data', 'security');
    const keyPath = path.join(keyDir, 'memory.encryption.key');
    const fs = FileSystem.getInstance();
    try {
      const exists = await fs.exists(keyPath);
      if (exists) {
        const key = await fs.readFileBuffer(keyPath);
        return key;
      }
      const key = crypto.randomBytes(32);
      await fs.writeFile(keyPath, key, { atomic: true });
      return key;
    } catch {
      Logger.warn('生成或加载加密密钥失败，使用随机密钥', 'MemoryEncryption');
      return crypto.randomBytes(32);
    }
  }

  /** 加密数据 */
  encryptData(data: string): { encrypted: string; iv: string } {
    if (this.encryptionKey.length === 0) {
      throw new Error('加密密钥未初始化，请先调用 initialize()');
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { encrypted, iv: iv.toString('hex') };
  }

  /** 解密数据 */
  decryptData(encrypted: string, iv: string): string {
    if (this.encryptionKey.length === 0) {
      throw new Error('加密密钥未初始化，请先调用 initialize()');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      this.encryptionKey,
      Buffer.from(iv, 'hex')
    );
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /** 加密存储长期记忆 */
  async storeEncryptedLongTermMemory(
    content: Record<string, unknown>
  ): Promise<string> {
    const dataStr = JSON.stringify(content);
    const { encrypted, iv } = this.encryptData(dataStr);
    return JSON.stringify({ encrypted, iv, timestamp: Date.now() });
  }

  /** 解密长期记忆 */
  async decryptLongTermMemory(encryptedData: string): Promise<unknown> {
    try {
      const parsed = JSON.parse(encryptedData) as Record<string, string>;
      if (parsed.encrypted && parsed.iv) {
        return JSON.parse(this.decryptData(parsed.encrypted, parsed.iv));
      }
    } catch {
      Logger.warn('解密数据失败，返回原始数据', 'MemoryEncryption');
    }
    return encryptedData;
  }
}
