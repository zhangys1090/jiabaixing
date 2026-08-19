/**
 * CLI 运行时安全姿态标志解析测试。
 * 断言 --safe-mode/--yolo/--auto/--posture 正确映射为 posture 并从参数中剔除，
 * 以及 applyRuntimePostureFlags 只在显式指定时写入 AGENT_RUNTIME_POSTURE。
 */

import {
  parseRuntimePostureFlags,
  applyRuntimePostureFlags,
} from '../../../src/cli/runtimePosture';

describe('parseRuntimePostureFlags', () => {
  it('maps --safe-mode / --yolo / --auto / --accept-hooks', () => {
    expect(parseRuntimePostureFlags(['--safe-mode']).posture).toBe('safe');
    expect(parseRuntimePostureFlags(['--yolo']).posture).toBe('yolo');
    expect(parseRuntimePostureFlags(['--auto']).posture).toBe('auto');
    expect(parseRuntimePostureFlags(['--accept-hooks']).posture).toBe('auto');
  });

  it('supports --posture <value> and --posture=<value>', () => {
    expect(parseRuntimePostureFlags(['--posture', 'yolo']).posture).toBe('yolo');
    expect(parseRuntimePostureFlags(['--posture=safe']).posture).toBe('safe');
  });

  it('ignores invalid --posture values', () => {
    expect(parseRuntimePostureFlags(['--posture', 'nonsense']).posture).toBeNull();
    expect(parseRuntimePostureFlags(['--posture=weird']).posture).toBeNull();
  });

  it('returns null posture when no flag given', () => {
    expect(parseRuntimePostureFlags(['chat', '--json']).posture).toBeNull();
  });

  it('strips posture flags from rest, preserving other args and order', () => {
    const { posture, rest } = parseRuntimePostureFlags([
      'chat',
      '--yolo',
      '--json',
      '--posture',
      'safe',
      'hello',
    ]);
    // 后出现的 --posture safe 覆盖先前的 --yolo
    expect(posture).toBe('safe');
    expect(rest).toEqual(['chat', '--json', 'hello']);
  });

  it('does not consume a following flag as --posture value', () => {
    const { posture, rest } = parseRuntimePostureFlags(['--posture', '--json']);
    expect(posture).toBeNull();
    expect(rest).toEqual(['--json']);
  });
});

describe('applyRuntimePostureFlags', () => {
  const KEY = 'AGENT_RUNTIME_POSTURE';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('writes env when a posture flag is present and returns filtered args', () => {
    const rest = applyRuntimePostureFlags(['chat', '--yolo', 'hi']);
    expect(process.env[KEY]).toBe('yolo');
    expect(rest).toEqual(['chat', 'hi']);
  });

  it('leaves env untouched when no posture flag is present', () => {
    const rest = applyRuntimePostureFlags(['chat', '--json']);
    expect(process.env[KEY]).toBeUndefined();
    expect(rest).toEqual(['chat', '--json']);
  });
});
