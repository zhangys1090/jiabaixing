import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCodeReviewExecutor } from '../../../src/harness/tools/code/code_review';

describe('code_review executor', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在时失败', async () => {
    const exec = createCodeReviewExecutor({});
    const r = await exec({ file_path: path.join(dir, 'nope.ts') });
    expect(r.success).toBe(false);
    expect(r.error).toContain('文件不存在');
  });

  it('检测到硬编码密钥返回 critical', async () => {
    const f = path.join(dir, 'secret.ts');
    fs.writeFileSync(f, 'const apiKey = "abcdefgh12345678";\n');
    const exec = createCodeReviewExecutor({});
    const r = await exec({ file_path: f });
    expect(r.success).toBe(true);
    expect(r.output).toContain('硬编码密钥');
    expect(r.metadata && (r.metadata as Record<string, unknown>).criticalCount).toBeGreaterThanOrEqual(1);
  });

  it('空文件返回无问题', async () => {
    const f = path.join(dir, 'empty.ts');
    fs.writeFileSync(f, '// nothing\n');
    const exec = createCodeReviewExecutor({});
    const r = await exec({ file_path: f });
    expect(r.success).toBe(true);
    expect(r.output).toContain('未发现问题');
  });

  it('LLM 不可用时退化为规则+安全扫描且不崩溃', async () => {
    const f = path.join(dir, 'x.ts');
    fs.writeFileSync(f, 'const a = 1;\n');
    const exec = createCodeReviewExecutor({}); // 无 llm
    const r = await exec({ file_path: f });
    expect(r.success).toBe(true);
  });
});
