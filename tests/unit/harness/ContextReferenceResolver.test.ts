/**
 * ContextReferenceResolver 测试用例
 *
 * 测试 @ 引用解析功能：文件、文件夹、URL、git_diff
 */

import { ContextReferenceResolver } from '../../../src/harness/context/ContextReferenceResolver';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ContextReferenceResolver', () => {
  let resolver: ContextReferenceResolver;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ref-test-'));
    // 创建测试文件
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'hello world');
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      '{"dependencies": {"express": "^4.0.0"}}'
    );
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export {}');
    resolver = new ContextReferenceResolver({ projectRoot: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('应解析 @file 引用', async () => {
    const input = '请分析 @test.txt 的内容';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(true);
    expect(result.references).toHaveLength(1);
    expect(result.references[0].type).toBe('file');
    expect(result.references[0].target).toBe('test.txt');
    expect(result.references[0].content).toContain('hello world');
    expect(result.cleanedInput).toBe('请分析 test.txt 的内容');
  });

  it('应解析 @folder 引用（列出目录结构）', async () => {
    const input = '查看 @src 的结构';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(true);
    expect(result.references[0].type).toBe('folder');
    expect(result.references[0].content).toContain('index.ts');
  });

  it('应解析 @url 引用', async () => {
    const input = '参考 @https://example.com/docs 的内容';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(true);
    expect(result.references[0].type).toBe('url');
    expect(result.references[0].target).toBe('https://example.com/docs');
  });

  it('无引用时返回原始输入', async () => {
    const input = '你好，请帮我写代码';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(false);
    expect(result.references).toHaveLength(0);
    expect(result.cleanedInput).toBe(input);
  });

  it('应处理多个引用', async () => {
    const input = '对比 @test.txt 和 @package.json';
    const result = await resolver.resolve(input);

    expect(result.references).toHaveLength(2);
    expect(result.references[0].type).toBe('file');
    expect(result.references[1].type).toBe('file');
  });

  it('应处理不存在的文件引用', async () => {
    const input = '查看 @nonexistent_file.xyz';
    const result = await resolver.resolve(input);

    expect(result.references[0].error).toContain('不存在');
  });

  it('解析内容应包含分隔标记', async () => {
    const input = '查看 @test.txt';
    const result = await resolver.resolve(input);

    expect(result.resolvedContent).toContain('--- @test.txt ---');
    expect(result.resolvedContent).toContain('--- end @test.txt ---');
  });
});
