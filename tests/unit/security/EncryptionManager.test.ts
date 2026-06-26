/**
 * EncryptionManager 单元测试
 * 测试加密管理器的数据加密/解密功能
 */

// Mock 必须放在 import 之前
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(true),
    readFileSync: jest.fn().mockReturnValue(
      JSON.stringify({
        key: 'a'.repeat(64), // 固定32字节的hex
        salt: 'b'.repeat(32), // 固定16字节的hex
        generatedAt: new Date().toISOString(),
        algorithm: 'aes-256-cbc',
      })
    ),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    copyFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    statSync: jest.fn().mockReturnValue({ mtime: new Date() }),
    appendFileSync: jest.fn(),
  };
});

jest.mock('../../../src/utils/EnvironmentManager', () => ({
  EnvironmentManager: {
    getInstance: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(''),
    }),
  },
}));

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { EncryptionManager } from '../../../src/security/EncryptionManager';

describe('EncryptionManager', () => {
  let manager: EncryptionManager;

  beforeEach(async () => {
    manager = new EncryptionManager({
      keyManagement: {
        keyStorePath: './test-keys',
        backupEnabled: false,
        backupInterval: 86400,
      },
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe('初始化', () => {
    it('应该正确初始化', () => {
      expect(manager).toBeInstanceOf(EncryptionManager);
    });
  });

  describe('encrypt / decrypt', () => {
    it('应该加密和解密字符串', () => {
      const original = 'sensitive data 123!@#';
      const encrypted = manager.encrypt(original);
      expect(encrypted).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.data).toBeDefined();
      expect(encrypted.timestamp).toBeDefined();
      expect(encrypted.data).not.toBe(original);

      const decrypted = manager.decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('应该加密和解密 Buffer', () => {
      const original = Buffer.from('binary data buffer');
      const encrypted = manager.encrypt(original);
      const decrypted = manager.decrypt(encrypted);
      expect(decrypted).toBe('binary data buffer');
    });

    it('每次加密应产生不同的 IV', () => {
      const original = 'same data';
      const enc1 = manager.encrypt(original);
      const enc2 = manager.encrypt(original);
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.data).not.toBe(enc2.data);
    });

    it('加密空字符串应正常工作', () => {
      const encrypted = manager.encrypt('');
      const decrypted = manager.decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('加密特殊字符应正常工作', () => {
      const original = '你好，世界！🎉✨';
      const encrypted = manager.encrypt(original);
      const decrypted = manager.decrypt(encrypted);
      expect(decrypted).toBe(original);
    });
  });

  describe('hash', () => {
    it('应该生成一致的哈希值', () => {
      const data = 'password123';
      const hash1 = manager.hash(data);
      const hash2 = manager.hash(data);
      expect(hash1).toBe(hash2);
    });

    it('不同数据应产生不同哈希值', () => {
      const hash1 = manager.hash('data1');
      const hash2 = manager.hash('data2');
      expect(hash1).not.toBe(hash2);
    });

    it('哈希值应为固定长度', () => {
      const hash = manager.hash('any data');
      expect(hash.length).toBe(64); // sha256 hex
    });
  });

  describe('hashWithSalt / verifyHashWithSalt', () => {
    it('应该生成带盐的哈希并验证', async () => {
      const password = 'my_secure_password';
      const result = await manager.hashWithSalt(password);
      expect(result.hash).toBeDefined();
      expect(result.salt).toBeDefined();

      const verified = manager.verifyHashWithSalt(
        password,
        result.hash,
        result.salt
      );
      expect(verified).toBe(true);
    });

    it('错误密码应验证失败', async () => {
      const password = 'correct_password';
      const result = await manager.hashWithSalt(password);

      const verified = manager.verifyHashWithSalt(
        'wrong_password',
        result.hash,
        result.salt
      );
      expect(verified).toBe(false);
    });

    it('每次应生成不同的盐', async () => {
      const result1 = await manager.hashWithSalt('same');
      const result2 = await manager.hashWithSalt('same');
      expect(result1.salt).not.toBe(result2.salt);
    });
  });

  describe('generateRandomKey', () => {
    it('应生成指定长度的密钥', () => {
      const key = manager.generateRandomKey(16);
      expect(key.length).toBe(32); // hex encoding = 2x length
    });

    it('默认应生成长度为32的密钥（64 hex字符）', () => {
      const key = manager.generateRandomKey();
      expect(key.length).toBe(64);
    });

    it('每次生成应不同', () => {
      const key1 = manager.generateRandomKey(16);
      const key2 = manager.generateRandomKey(16);
      expect(key1).not.toBe(key2);
    });
  });

  describe('shutdown', () => {
    it('多次 shutdown 应安全', async () => {
      await manager.shutdown();
      await manager.shutdown(); // should not throw
    });
  });
});
