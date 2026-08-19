import { createSelfReflectExecutor, SELF_REFLECT_DEF } from '../../../src/harness/tools/cognition/self_reflect';
import type { SelfReflectDeps, ReflectionEntry } from '../../../src/harness/tools/cognition/self_reflect';

describe('self_reflect executor', () => {
  it('无持久化后端时诚实失败而非假成功', async () => {
    const exec = createSelfReflectExecutor({} as unknown as SelfReflectDeps);
    const r = await exec({ action: 'a', result: 'r', satisfaction: 8 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未实际记录');
    expect(r.metadata && (r.metadata as Record<string, unknown>).persisted).toBe(false);
  });

  it('有 reflectionStore 时持久化并返回成功', async () => {
    const stored: ReflectionEntry[] = [];
    const exec = createSelfReflectExecutor({
      reflectionStore: {
        add: (e: ReflectionEntry) => stored.push(e),
        getAll: () => stored,
        getRecent: () => stored,
      },
    });
    const r = await exec({ action: 'a', result: 'r', satisfaction: 9 });
    expect(r.success).toBe(true);
    expect(r.output).toContain('已记录反思');
    expect(stored.length).toBe(1);
  });

  it('低满意度给出改进建议', async () => {
    const stored: ReflectionEntry[] = [];
    const exec = createSelfReflectExecutor({
      reflectionStore: {
        add: (e: ReflectionEntry) => stored.push(e),
        getAll: () => stored,
        getRecent: () => stored,
      },
    });
    const r = await exec({ action: 'a', result: '很慢', satisfaction: 2 });
    expect(r.success).toBe(true);
    expect(r.output).toContain('💡');
  });

  it('DEF 标注轻量规则模式', () => {
    expect(SELF_REFLECT_DEF.description).toContain('轻量规则模式');
  });
});
