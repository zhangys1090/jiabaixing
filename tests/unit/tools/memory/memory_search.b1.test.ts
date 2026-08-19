import { createMemorySearchExecutor } from '../../../../src/harness/tools/memory/memory_search';

describe('memory_search 诚实失败 (E6/A5)', () => {
  it('无后端 → success:false', async () => {
    const r = await createMemorySearchExecutor({})({ keywords: 'kw' });
    expect(r.success).toBe(false);
  });

  it('搜索异常 → success:false(诚实)', async () => {
    const r = await createMemorySearchExecutor({
      searchMemories: async () => {
        throw new Error('db');
      } as any,
    })({ keywords: 'kw' });
    expect(r.success).toBe(false);
  });

  it('命中 → success:true 且含内容', async () => {
    const r = await createMemorySearchExecutor({
      searchMemories: async () => [
        { content: 'foo', category: 'fact', timestamp: 1 },
        { content: 'bar', category: 'task', timestamp: 2 },
      ],
    } as any)({ keywords: 'kw' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('foo');
  });

  it('未命中 → success:true(合法空结果)', async () => {
    const r = await createMemorySearchExecutor({
      searchMemories: async () => [],
    } as any)({ keywords: 'kw' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('未找到');
  });
});
