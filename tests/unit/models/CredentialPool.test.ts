import {
  CredentialPool,
  CredentialEntry,
} from '../../../src/models/ProviderManager';

describe('CredentialPool', () => {
  it('应在多个密钥间轮换', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
      { key: 'key-3', weight: 1 },
    ]);

    const used = new Set<string>();
    for (let i = 0; i < 30; i++) {
      used.add(pool.getNext().key);
    }

    expect(used.size).toBe(3);
  });

  it('应在速率限制时自动切换', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
    ]);

    pool.reportRateLimit('key-1');
    const next = pool.getNext();

    expect(next.key).toBe('key-2');
  });

  it('应在故障时标记不可用', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
    ]);

    pool.reportFailure('key-1');
    pool.reportFailure('key-1');
    pool.reportFailure('key-1'); // 3次失败

    const next = pool.getNext();
    expect(next.key).toBe('key-2');
  });

  it('成功后应重置失败计数', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
    ]);

    pool.reportFailure('key-1');
    pool.reportFailure('key-1');
    pool.reportSuccess('key-1');

    // key-1 应该仍然可用
    const available = pool.getAvailableCredentials();
    expect(available.some((c) => c.key === 'key-1')).toBe(true);
  });

  it('所有凭证不可用时应强制重置', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
    ]);

    pool.reportFailure('key-1');
    pool.reportFailure('key-1');
    pool.reportFailure('key-1');

    // 所有凭证不可用时，getNext 应强制重置
    const next = pool.getNext();
    expect(next).toBeDefined();
    expect(next.key).toBe('key-1');
  });

  it('应报告正确的凭证数量', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
      { key: 'key-3', weight: 1 },
    ]);

    expect(pool.size).toBe(3);
    expect(pool.availableSize).toBe(3);

    pool.reportRateLimit('key-1');
    expect(pool.availableSize).toBe(2);
  });

  it('速率限制到期后应自动恢复', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
    ]);

    // 设置已过期的速率限制
    pool.reportRateLimit('key-1', Date.now() - 1000); // 1秒前已过期

    const available = pool.getAvailableCredentials();
    expect(available.length).toBe(2);
  });
});
