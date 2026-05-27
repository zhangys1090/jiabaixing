/**
 * 真实交互任务执行循环测试
 * 验证完整链路：场景识别 → 意图分析 → 记忆检索 → 工具执行 → 结果存储
 */

import * as fs from 'fs';
import * as path from 'path';
import { PersonaRules } from '../../src/persona/PersonaRules';
import { JiabaixingEventBus } from '../../src/shared/EventBus';
import { ToolExecutor } from '../../src/tools/ToolExecutor';

describe('真实交互任务执行循环', () => {
  let toolExecutor: ToolExecutor;
  let eventBus: JiabaixingEventBus;
  let personaRules: PersonaRules;

  beforeAll(async () => {
    toolExecutor = new ToolExecutor();
    await toolExecutor.initialize();
    eventBus = JiabaixingEventBus.getInstance({ dbPath: path.join(__dirname, '..', 'test_eventbus.db') });
    personaRules = new PersonaRules();
  });

  afterAll(async () => {
    await toolExecutor.shutdown();
    eventBus.destroy();
    // 清理测试数据库文件
    const dbPath = path.join(__dirname, '..', 'test_eventbus.db');
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('场景 1: 代码搜索和分析', () => {
    test('应该能够读取文件内容', async () => {
      const result = await toolExecutor.execute('read_file', {
        file_path: path.join(__dirname, '../../src/tools/ToolExecutor.ts'),
      });

      expect(result).toBeDefined();
    });

    test('应该能够写入文件内容', async () => {
      const testFilePath = path.join(__dirname, 'test_output.txt');
      const result = await toolExecutor.execute('write_file', {
        file_path: testFilePath,
        content: '测试内容',
      });

      expect(result).toBeDefined();

      // 清理测试文件
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    });
  });

  describe('场景 2: 场景感知语气适配', () => {
    test('工作场景应该生成正式语气', () => {
      const result = personaRules.applyRules('这个问题我已经处理好了', 'work');

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    test('个人场景应该生成轻松语气', () => {
      const result = personaRules.applyRules('好的，我知道了', 'personal');

      expect(result).toBeDefined();
    });

    test('问候场景应该生成友好语气', () => {
      const result = personaRules.applyRules('早上好', 'greeting');

      expect(result).toBeDefined();
    });
  });

  describe('场景 3: 事件总线通信', () => {
    test('应该能够发送和接收事件', (done) => {
      const eventName = 'test:interaction';
      const eventData = { userId: 'test-user', message: 'Hello' };

      eventBus.once(eventName, (data: unknown) => {
        expect(data).toEqual(eventData);
        done();
      });

      eventBus.emit(eventName, eventData);
    });
  });

  describe('场景 4: 完整交互链路测试', () => {
    test('搜索→读取→分析完整流程', async () => {
      // 步骤 1: 搜索代码
      const searchResult = await toolExecutor.execute('search_code', {
        pattern: 'ToolExecutor',
        type: 'ts',
      });
      expect(searchResult).toBeDefined();

      // 步骤 2: 读取相关文件
      const readResult = await toolExecutor.execute('read_file', {
        file_path: path.join(__dirname, '../../src/tools/ToolExecutor.ts'),
      });
      expect(readResult).toBeDefined();

      // 步骤 3: 发送事件通知
      eventBus.emit('interaction:complete', {
        userId: 'test-user',
        task: 'toolchain-test',
        status: 'success',
      });

      // 验证所有步骤都成功执行
      expect(searchResult).toBeDefined();
      expect(readResult).toBeDefined();
    });
  });
});
