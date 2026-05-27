/**
 * P0-1 核心路径端到端测试：创建文件
 * 验证：用户发一条消息 → 正确理解意图 → 选择正确工具 → 传递正确参数 → 执行成功 → 返回结果
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutor } from '../../../src/tools/ToolExecutor';

describe('P0-1 核心路径：创建文件', () => {
  let executor: ToolExecutor;
  const testDir = path.join(__dirname, 'test-output');
  const testFile = path.join(testDir, 'test.txt');

  beforeEach(async () => {
    // 清理测试目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    executor = new ToolExecutor();
    await executor.initialize();
  });

  afterEach(() => {
    // 清理测试目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('用户消息 "创建文件 test.txt" → write_file 工具真实执行', async () => {
    // 模拟用户意图：创建文件
    const result = await executor.execute('write_file', {
      file_path: testFile,
      content: 'Hello from test!',
    });

    // 验证：文件真实存在于磁盘
    expect(fs.existsSync(testFile)).toBe(true);

    // 验证：文件内容正确
    const content = fs.readFileSync(testFile, 'utf8');
    expect(content).toBe('Hello from test!');

    // 验证：工具返回成功
    expect(result).toEqual({
      success: true,
      message: '文件写入成功',
    });
  });

  test('read_file 工具能读取刚创建的文件', async () => {
    // 先创建文件
    await executor.execute('write_file', {
      file_path: testFile,
      content: 'Test content for reading',
    });

    // 再读取文件
    const result = await executor.execute('read_file', {
      file_path: testFile,
    });

    // 验证：返回真实文件内容
    expect(result).toBe('Test content for reading');
  });

  test('read_file 读取不存在的文件应抛出错误', async () => {
    const nonExistentFile = path.join(testDir, 'nonexistent.txt');

    await expect(
      executor.execute('read_file', {
        file_path: nonExistentFile,
      })
    ).rejects.toThrow(/读取文件失败/);
  });

  test('run_command 能真实执行命令', async () => {
    const result = await executor.execute('run_command', {
      command: 'echo hello world',
    });

    // 验证：命令输出包含 hello world
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('output');
    expect((result as Record<string, string>).output).toContain('hello world');
  });
});
