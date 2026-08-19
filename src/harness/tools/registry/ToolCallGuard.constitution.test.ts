import {
  ToolCallGuard,
  ConstitutionGuardProvider,
} from './ToolCallGuard';

const blockedProvider: ConstitutionGuardProvider = async (action) => {
  const blocked = action.toolName === 'shutdown_device';
  return {
    allowed: !blocked,
    violations: blocked
      ? [{ ruleId: 'danger_blocks_destructive', reason: '感知到危险' }]
      : [],
    reason: blocked ? '感知到危险,禁止破坏性动作' : 'ok',
    dangerDetected: blocked,
  };
};

describe('ToolCallGuard 宪法守卫 (U4 第2项)', () => {
  it('未设置 provider 时 guard 等价于 check', async () => {
    const g = new ToolCallGuard();
    const r = await g.guard('web_search', { q: 'x' });
    expect(r.blocked).toBe(false);
  });

  it('provider 拦截破坏性动作', async () => {
    const g = new ToolCallGuard();
    g.setConstitutionGuardProvider(blockedProvider);
    const r = await g.guard('shutdown_device', {});
    expect(r.blocked).toBe(true);
    expect((r.result as any)?.metadata?.constitutionBlocked).toBe(true);
    expect((r.result as any)?.metadata?.violations).toContain(
      'danger_blocks_destructive'
    );
  });

  it('provider 放行时继续走 check（去重/缓存/限速）', async () => {
    const g = new ToolCallGuard();
    g.setConstitutionGuardProvider(blockedProvider);
    const r = await g.guard('web_search', { q: 'x' });
    expect(r.blocked).toBe(false);
  });

  it('provider 收到正确的 action 参数', async () => {
    const spy: ConstitutionGuardProvider = jest.fn(async () => ({
      allowed: true,
      violations: [],
      reason: '',
      dangerDetected: false,
    }));
    const g = new ToolCallGuard();
    g.setConstitutionGuardProvider(spy);
    await g.guard('foo', { a: 1 });
    expect(spy).toHaveBeenCalledWith({ toolName: 'foo', args: { a: 1 } });
  });

  it('provider 放行后,check 的去重逻辑仍然生效', async () => {
    const g = new ToolCallGuard();
    g.setConstitutionGuardProvider(blockedProvider);
    const first = await g.guard('web_search', { q: 'same' });
    expect(first.blocked).toBe(false);
    // 模拟工具执行后记录调用（success:false 不进缓存，确保走到去重分支）
    g.record('web_search', { q: 'same' }, { success: false, output: '', metadata: {} });
    // 相同参数再次调用 → 去重拦截（宪法未拦截，走 check 去重）
    const second = await g.guard('web_search', { q: 'same' });
    expect(second.blocked).toBe(true);
    expect((second.result as any)?.metadata?.deduplicated).toBe(true);
  });
});
