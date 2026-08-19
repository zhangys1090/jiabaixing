jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(
    () =>
      [
        "const x = 1;",
        "console.log('debug');",
        "const y: any = {};",
        "try { doThing(); } catch {}",
        "const url = `query(${user})`;",
        "eval('bad');",
      ].join('\n')
  ),
}));

import { createCodeReviewExecutor, CODE_REVIEW_DEF } from '../../../../src/harness/tools/code/code_review';

describe('code_review 描述诚实 + LLM 失败如实 (D2)', () => {
  it('LLM 抛错 → success:true 且 llmFailed 如实', async () => {
    const r = await createCodeReviewExecutor({
      llm: {
        chat: async () => {
          throw new Error('llm 500');
        },
      } as any,
    })({ file_path: 'x.ts' });
    expect(r.success).toBe(true);
    expect((r.metadata as any).llmFailed).toBe(true);
    expect(r.output).toContain('[LLM审查失败');
  });

  it('无 LLM → success:true 且 llmFailed=false', async () => {
    const r = await createCodeReviewExecutor({})({ file_path: 'x.ts' });
    expect(r.success).toBe(true);
    expect((r.metadata as any).llmFailed).toBe(false);
  });

  it('描述去掉夸大维度（语法/性能）', () => {
    expect(CODE_REVIEW_DEF.description).not.toContain('语法、逻辑、安全、性能');
    expect(CODE_REVIEW_DEF.description).not.toContain('四个维度');
    expect(CODE_REVIEW_DEF.description).toContain('规则检查');
  });
});
