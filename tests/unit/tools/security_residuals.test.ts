/**
 * F1b 残留修复 jest 镜像 (CI 可跑; 本地 node_modules 损坏时由 .f1b_verify/verify.cjs 运行时验证)。
 *
 * 覆盖:
 *  - web_fetch isSafeUrl 混合进制点分 IPv4 SSRF 绕过修复 (0x7f.0.0.1 / 0177.0.0.1)
 *  - file_read/file_list resolveWithinRoot 二级 symlink 复检 (根内软链指向根外 → 拒绝; ENOENT 保守放行)
 *
 * 注: httpClient 超时竞速 + 16MB 缓冲截断经运行时 harness 验证(.f1b_verify/verify.cjs),
 * 其依赖注入 httpClient 的不透明性, 单位层以 isSafeUrl/resolveWithinRoot 纯逻辑为准。
 */
import { isSafeUrl } from '../../../src/harness/tools/network/web_fetch';
import { resolveWithinRoot } from '../../../src/harness/tools/file/file_read';

describe('isSafeUrl 混合编码 SSRF 绕过修复', () => {
  const cases: Array<[string, boolean]> = [
    ['http://0x7f.0.0.1', false],
    ['http://0177.0.0.1', false],
    ['http://127.0.0.1', false],
    ['http://10.0.0.5', false],
    ['http://169.254.169.254', false],
    ['http://[::1]', false],
    ['http://0x7f000001', false],
    ['http://example.com', true],
    ['https://example.com/x', true],
    ['ftp://example.com', false],
    ['not a url', false],
  ];
  it.each(cases)('isSafeUrl(%s) === %s', (url, expected) => {
    expect(isSafeUrl(url)).toBe(expected);
  });
});

jest.mock('fs', () => ({ realpathSync: jest.fn() }));
import * as fs from 'fs';
const realpathSync = (fs as unknown as { realpathSync: jest.Mock }).realpathSync;

describe('resolveWithinRoot symlink 二级复检', () => {
  beforeEach(() => realpathSync.mockReset());

  it('根内 symlink 指向根外 → 抛出越界(symlink)', () => {
    realpathSync.mockImplementation((p: string) => {
      if (p === 'C:\\root\\link_outside') return 'C:\\outside\\secret';
      return p;
    });
    expect(() => resolveWithinRoot('C:\\root\\link_outside', 'C:\\root')).toThrow(/symlink/);
  });

  it('根内正常路径 → 返回 realpath', () => {
    realpathSync.mockImplementation((p: string) => p);
    expect(resolveWithinRoot('C:\\root\\normal', 'C:\\root')).toBe('C:\\root\\normal');
  });

  it('不存在路径(ENOENT) → 词法放行不抛(交上层自然失败)', () => {
    const e: NodeJS.ErrnoException = new Error('enoent') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    realpathSync.mockImplementation(() => {
      throw e;
    });
    expect(resolveWithinRoot('C:\\root\\missing', 'C:\\root')).toBe('C:\\root\\missing');
  });

  it('symlink 越界断言必须传播(不得被 catch 静默降级为词法放行)', () => {
    realpathSync.mockImplementation((p: string) => {
      if (p === 'C:\\root\\evil') return 'C:\\outside\\x';
      return p;
    });
    let thrown = false;
    try {
      resolveWithinRoot('C:\\root\\evil', 'C:\\root');
    } catch (e) {
      thrown = true;
      expect((e as Error).message).toMatch(/symlink/);
    }
    expect(thrown).toBe(true);
  });
});
