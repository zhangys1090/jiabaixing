import { createCodeGenerateExecutor, CODE_GENERATE_DEF } from '../../../src/harness/tools/code/code_generate';
import type { CodeGenerateDeps } from '../../../src/harness/tools/code/code_generate';

describe('code_generate executor', () => {
  it('未注入 generateCode 时诚实失败', async () => {
    const exec = createCodeGenerateExecutor({});
    const r = await exec({ requirements: 'quick sort', language: 'python' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Python 真后端');
  });

  it('注入 generateCode 时返回代码', async () => {
    const exec = createCodeGenerateExecutor({
      generateCode: async (p) => ({
        code: 'def f(): pass',
        language: p.language,
        explanation: 'ok',
      }),
    });
    const r = await exec({ requirements: 'q', language: 'python' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('def f()');
  });

  it('generateCode 抛错时失败', async () => {
    const exec = createCodeGenerateExecutor({
      generateCode: async () => {
        throw new Error('llm down');
      },
    });
    const r = await exec({ requirements: 'q', language: 'python' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('llm down');
  });

  it('DEF 标注轻量规则模式', () => {
    expect(CODE_GENERATE_DEF.description).toContain('轻量规则模式');
  });
});
