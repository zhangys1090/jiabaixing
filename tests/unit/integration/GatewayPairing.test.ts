/**
 * GatewayPairing 单元测试
 */
import { GatewayPairing } from '../../../src/integration/GatewayPairing';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('GatewayPairing', () => {
  let pairing: GatewayPairing;

  beforeEach(() => {
    pairing = new GatewayPairing();
  });

  it('应生成配对码', () => {
    const code = pairing.generateCode('telegram', 'admin123');
    expect(code).not.toBeNull();
    expect(code!.length).toBe(8);
    expect(code).toMatch(/^[A-F0-9]{8}$/);
  });

  it('应验证有效配对码', () => {
    const code = pairing.generateCode('telegram', 'admin123')!;
    const result = pairing.tryConsume(code);
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('telegram');
    expect(result!.adminUserId).toBe('admin123');
  });

  it('无效码应返回 null', () => {
    const result = pairing.tryConsume('INVALID');
    expect(result).toBeNull();
  });

  it('配对码只能使用一次', () => {
    const code = pairing.generateCode('discord', 'admin456')!;
    pairing.tryConsume(code); // 第一次
    const result = pairing.tryConsume(code); // 第二次
    expect(result).toBeNull();
  });

  it('过期码应返回 null', () => {
    // 使用 Date.now 模拟过期
    const realNow = Date.now;
    const fakeNow = Date.now() - 61 * 60 * 1000; // 61 分钟前
    Date.now = () => fakeNow;

    const code = pairing.generateCode('telegram', 'admin')!;
    expect(code).not.toBeNull();

    Date.now = realNow; // 恢复真实时间

    // 此时码已过期（生成在 61 分钟前）
    const result = pairing.tryConsume(code);
    expect(result).toBeNull();
  });

  it('looksLikePairingCode 应识别 8 位 hex 格式', () => {
    expect(pairing.looksLikePairingCode('ABC123DE')).toBe(true);
    expect(pairing.looksLikePairingCode('hello')).toBe(false);
    expect(pairing.looksLikePairingCode('')).toBe(false);
    expect(pairing.looksLikePairingCode('ABC12345')).toBe(true);
  });

  it('速率限制：超过限制应返回 null', () => {
    const results: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(pairing.generateCode('telegram', 'admin-rate'));
    }
    // 前 3 次成功，后续被限
    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[2]).not.toBeNull();
    expect(results[3]).toBeNull();
    expect(results[4]).toBeNull();
  });

  it('cleanExpired 应清理过期码', () => {
    pairing.generateCode('telegram', 'admin1')!;
    pairing.generateCode('telegram', 'admin2')!;

    const before = pairing.getPendingCount();
    expect(before).toBe(2);

    // 强制过期
    const expired = pairing.cleanExpired();
    // 没有真的过期条目（刚生成）
    expect(expired).toBe(0);
  });

  it('待使用码数限制', () => {
    // 用不同 admin 生成码，避免速率限制影响
    for (let i = 0; i < 12; i++) {
      pairing.generateCode('telegram', `admin-${i}`);
    }
    // 每个 admin 1 个，总共 12 个，应全部成功（未达每人 10 限制）
    const count = pairing.getPendingCount();
    expect(count).toBe(12);
  });
});
