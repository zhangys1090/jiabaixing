/**
 * B-2 (A1) jest 镜像 (CI 可跑; 本地运行时验证见 .b1_verify/verify.cjs)。
 *
 * 覆盖: memory_store 缺依赖(storeWithMetadata / storeShortTermMemory 均缺失)时
 * 不再静默返回 success:true "已存储", 而是诚实 success:false 指明未注入存储后端。
 */
import { createMemoryStoreExecutor } from '../../../src/harness/tools/memory/memory_store';

describe('B-2 memory_store 诚实失败', () => {
  it('缺依赖 → success:false 而非假成功', async () => {
    const exec = createMemoryStoreExecutor({});
    const r = await exec({ action: 'store', content: 'hello', category: 'c' }, {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/未注入/);
  });

  it('注入 storeShortTermMemory → 正常存储返回 success:true', async () => {
    const exec = createMemoryStoreExecutor({
      storeShortTermMemory: async () => true,
    });
    const r = await exec({ action: 'store', content: 'hello', category: 'c' }, {});
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/已存储/);
  });
});
