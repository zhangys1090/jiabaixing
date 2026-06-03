import * as fs from 'fs';
import * as path from 'path';
import {
  createCodeReviewProjectExecutor,
  CODE_REVIEW_PROJECT_DEF,
} from '../../../src/harness/tools/code/code_review_project';

describe('code_review_project 工具', () => {
  const executor = createCodeReviewProjectExecutor({});
  const tmpDir = path.join(__dirname, '__tmp_review_test');

  beforeAll(() => {
    // 创建临时测试目录
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'good.ts'),
      'export function hello(): string {\n  return "world";\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'bad.ts'),
      'const key = "sk-abc123456789012345678901234567890";\nconsole.log(key);\ntry { eval("test"); } catch(e) {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ignore.txt'),
      'this is not a code file'
    );
  });

  afterAll(() => {
    // 清理临时目录
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('应该有正确的工具定义', () => {
    expect(CODE_REVIEW_PROJECT_DEF.name).toBe('code_review_project');
    expect(CODE_REVIEW_PROJECT_DEF.requiredParams).toContain('path');
    expect(CODE_REVIEW_PROJECT_DEF.timeout).toBe(120000);
    expect(CODE_REVIEW_PROJECT_DEF.riskLevel).toBe('low');
    expect(CODE_REVIEW_PROJECT_DEF.idempotent).toBe(true);
  });

  it('应该审查目录并返回汇总报告', async () => {
    const result = await executor({ path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('项目代码审查报告');
    expect(result.output).toContain('文件数:');
    expect(result.metadata?.filesReviewed).toBe(2); // 只有 .ts 文件
  });

  it('应该检测到安全问题', async () => {
    const result = await executor({ path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('硬编码密钥');
    expect(result.metadata?.criticalCount).toBeGreaterThan(0);
  });

  it('应该检测到 console.log', async () => {
    const result = await executor({ path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('console.log');
  });

  it('应该支持 file_pattern 过滤', async () => {
    const result = await executor({ path: tmpDir, file_pattern: 'bad.*' });
    expect(result.success).toBe(true);
    expect(result.metadata?.filesReviewed).toBe(1);
  });

  it('应该处理不存在的路径', async () => {
    const result = await executor({ path: '/nonexistent/path' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('路径不存在');
  });

  it('应该处理空目录', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = await executor({ path: emptyDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('未找到匹配的代码文件');
  });

  it('应该支持单文件审查', async () => {
    const result = await executor({ path: path.join(tmpDir, 'bad.ts') });
    expect(result.success).toBe(true);
    expect(result.output).toContain('项目代码审查报告');
    expect(result.metadata?.filesReviewed).toBe(1);
  });

  it('应该支持 max_files 限制', async () => {
    const result = await executor({ path: tmpDir, max_files: 1 });
    expect(result.success).toBe(true);
    expect(result.metadata?.filesReviewed).toBeLessThanOrEqual(1);
  });
});
