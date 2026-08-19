import { createCodeFixExecutor, CODE_FIX_DEF } from '../../../src/harness/tools/code/code_fix';
import type { CodeFixDeps } from '../../../src/harness/tools/code/code_fix';

describe('code_fix executor', () => {
  it('缺 fixCode 时规则兜底: var->const/let + 分号', async () => {
    const exec = createCodeFixExecutor({});
    const r = await exec({ code: 'var x = 1', errorDescription: 'lint', language: 'typescript' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('const x = 1;');
  });

  it('缺 fixCode 时 == -> ===', async () => {
    const exec = createCodeFixExecutor({});
    const r = await exec({ code: 'if (a == b) {}', errorDescription: 'eq', language: 'typescript' });
    expect(r.output).toContain('===');
  });

  it('注入 fixCode 时返回修复结果', async () => {
    const exec = createCodeFixExecutor({
      fixCode: async () => ({ fixedCode: 'patched', changes: [{ type: 'fix', description: 'x' }] }),
    });
    const r = await exec({ code: 'bad', errorDescription: 'e', language: 'ts' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('patched');
  });

  it('fixCode 抛错时失败', async () => {
    const exec = createCodeFixExecutor({
      fixCode: async () => {
        throw new Error('boom');
      },
    });
    const r = await exec({ code: 'bad', errorDescription: 'e', language: 'ts' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('boom');
  });

  it('DEF 不再声明 FILE_WRITE(仅预览, 不自动写盘)', () => {
    expect(CODE_FIX_DEF.requiredPermissions).toHaveLength(1);
    expect(CODE_FIX_DEF.description).toContain('不自动写盘');
  });
});
