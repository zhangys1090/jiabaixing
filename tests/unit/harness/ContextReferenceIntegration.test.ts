/**
 * ContextReferenceResolver ↔ ContextManager 集成测试
 *
 * 验证 ContextManager 在注入 referenceResolver 后，
 * buildContext 正确解析 @ 引用并内联展开到用户消息中。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ContextManager } from '../../../src/harness/context/ContextManager';
import { ContextReferenceResolver } from '../../../src/harness/context/ContextReferenceResolver';
import type { UserInput } from '../../../src/harness/types';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function createTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ref-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return dir;
}

function makeContextManager(projectRoot: string): ContextManager {
  const resolver = new ContextReferenceResolver({ projectRoot });
  return new ContextManager(
    {
      constitutionalBuilder: {
        buildConstitutionPrompt: async () => 'You are an assistant.',
      },
      memoryInjector: {
        autoRetrieveMemories: async () => [],
      },
      dynamicContext: {
        getDynamicContext: () => '',
      },
      historyProvider: {
        getRecentHistory: () => [],
        getAllHistory: () => [],
      },
      referenceResolver: resolver,
    },
    8000
  );
}

describe('ContextReferenceResolver ↔ ContextManager 集成', () => {
  it('buildContext 解析 @file 引用并内联到用户消息', async () => {
    const dir = createTempFile('test.txt', 'Hello World from file');
    const cm = makeContextManager(dir);

    const input: UserInput = {
      text: '请分析 @test.txt 的内容',
      userId: 'test-user',
    };

    const messages = await cm.buildContext(input);
    const userMsg = messages.find((m) => m.role === 'user');

    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain('Hello World from file');
    expect(userMsg!.content).toContain('[引用内容]');
  });

  it('无 @ 引用时正常构建上下文（不注入引用内容）', async () => {
    const dir = createTempFile('dummy.txt', 'dummy');
    const cm = makeContextManager(dir);

    const input: UserInput = {
      text: '你好，请帮我写代码',
    };

    const messages = await cm.buildContext(input);
    const userMsg = messages.find((m) => m.role === 'user');

    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('你好，请帮我写代码');
    expect(userMsg!.content).not.toContain('[引用内容]');
  });

  it('多个 @file 引用全部内联', async () => {
    const dir = createTempFile('a.txt', 'ContentA');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'ContentB', 'utf-8');
    const cm = makeContextManager(dir);

    const input: UserInput = {
      text: '对比 @a.txt 和 @b.txt',
    };

    const messages = await cm.buildContext(input);
    const userMsg = messages.find((m) => m.role === 'user');

    expect(userMsg!.content).toContain('ContentA');
    expect(userMsg!.content).toContain('ContentB');
  });

  it('不存在的文件引用不中断构建', async () => {
    const dir = createTempFile('exists.txt', 'exists');
    const cm = makeContextManager(dir);

    const input: UserInput = {
      text: '查看 @nonexistent_file.xyz',
    };

    const messages = await cm.buildContext(input);
    const userMsg = messages.find((m) => m.role === 'user');

    expect(userMsg).toBeDefined();
  });

  it('未注入 referenceResolver 时 buildContext 正常工作（向后兼容）', async () => {
    const cm = new ContextManager(
      {
        constitutionalBuilder: {
          buildConstitutionPrompt: async () => 'system',
        },
        memoryInjector: {
          autoRetrieveMemories: async () => [],
        },
        dynamicContext: {
          getDynamicContext: () => '',
        },
        historyProvider: {
          getRecentHistory: () => [],
          getAllHistory: () => [],
        },
      },
      8000
    );

    const input: UserInput = { text: '你好 @test' };
    const messages = await cm.buildContext(input);
    const userMsg = messages.find((m) => m.role === 'user');

    expect(userMsg!.content).toBe('你好 @test');
  });
});
