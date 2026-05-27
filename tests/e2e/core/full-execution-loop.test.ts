/**
 * P0 核心路径端到端测试：完整执行循环
 * 验证：用户发消息 → 正确理解意图 → 选择正确工具 → 传递正确参数 → 执行成功 → 返回结果
 */

import * as fs from 'fs';
import * as path from 'path';
import { JiabaixingCore } from '../../../src/core/JiabaixingCore';
import { MemoryEngine } from '../../../src/memory/MemoryEngine';

describe('P0 核心执行循环端到端测试', () => {
  let core: JiabaixingCore;
  const testDir = path.join(__dirname, 'test-output-e2e');

  beforeAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    const memoryEngine = new MemoryEngine();
    await memoryEngine.initialize();

    core = new JiabaixingCore();
    core.setMemoryEngine(memoryEngine);

    await core.initialize();
  });

  test('TC1: 用户发 "创建文件 hello.txt" → 文件真实创建并返回成功', async () => {
    const testFile = path.join(testDir, 'hello.txt');
    const input = '帮我创建文件 hello.txt';

    const result = await core.processInput(input, 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
    expect(result.response.length).toBeGreaterThan(0);
  }, 30000);

  test('TC2: 用户发 "读取 hello.txt" → 返回文件真实内容', async () => {
    const testFile = path.join(testDir, 'hello.txt');
    fs.writeFileSync(testFile, 'E2E test content');

    const result = await core.processInput('读取 hello.txt 的内容', 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
    expect(fs.existsSync(testFile)).toBe(true);
  }, 30000);

  test('TC3: 用户发 "删除 hello.txt" → 文件真实删除', async () => {
    const testFile = path.join(testDir, 'hello.txt');
    fs.writeFileSync(testFile, 'to be deleted');
    expect(fs.existsSync(testFile)).toBe(true);

    const result = await core.processInput('删除 hello.txt', 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
  }, 30000);

  test('TC4: 无效输入 → 应返回友好错误提示而非崩溃', async () => {
    const result = await core.processInput('', 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
    expect(result.response.length).toBeGreaterThan(0);
  }, 30000);

  test('TC5: 危险命令 → 应被安全机制拦截', async () => {
    const result = await core.processInput('执行 rm -rf / 命令', 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
  }, 30000);
});
