import { createSelfReflectExecutor } from '../../../../src/harness/tools/cognition/self_reflect';

describe('self_reflect 持久化 try/catch (F2)', () => {
  const bp = { action: 'did x', result: 'ok', satisfaction: 8 };

  it('无后端 → success:false', async () => {
    const r = await createSelfReflectExecutor({})(bp);
    expect(r.success).toBe(false);
    expect((r.metadata as any).persisted).toBe(false);
  });

  it('recordExecution 抛错 → success:false(诚实)', async () => {
    const r = await createSelfReflectExecutor({
      agentSelfReflection: {
        recordExecution: async () => {
          throw new Error('db down');
        },
      } as any,
    })(bp);
    expect(r.success).toBe(false);
    expect((r.metadata as any).persistError).toBe(true);
  });

  it('reflectionStore.add 抛错 → success:false(诚实)', async () => {
    const r = await createSelfReflectExecutor({
      reflectionStore: {
        add() {
          throw new Error('x');
        },
        getAll: () => [],
        getRecent: () => [],
      } as any,
    })(bp);
    expect(r.success).toBe(false);
    expect((r.metadata as any).persistError).toBe(true);
  });

  it('agentSelfReflection 成功 → success:true', async () => {
    const r = await createSelfReflectExecutor({
      agentSelfReflection: { recordExecution: async () => {} } as any,
    })(bp);
    expect(r.success).toBe(true);
  });

  it('reflectionStore 成功 → success:true', async () => {
    const r = await createSelfReflectExecutor({
      reflectionStore: {
        add() {},
        getAll: () => [],
        getRecent: () => [],
      } as any,
    })(bp);
    expect(r.success).toBe(true);
  });
});
