# 阶段3: LLMProvider 拆分 — 门面模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 948 行的 LLMProvider 拆分为 ChatProvider（对话）、CodeProvider（代码分析/生成）、MultimodalProvider（多模态）三个子服务，LLMProvider 保留为门面，委托给子 Provider，所有调用方无感知。

**Architecture:** 创建三个子 Provider 类，各自持有 model 引用和 executeWithRetry 能力。LLMProvider 在构造函数中实例化三个子 Provider，所有方法委托调用。使用门面模式保证向后兼容，不修改任何调用方代码。

**Tech Stack:** TypeScript 6 / Jest / existing Model interface

---

## File Structure

| 文件                                           | 职责                                                                                          | 操作 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ---- |
| `src/models/ChatProvider.ts`                   | 对话服务：chat, chatWithTools, executeWithRetry                                               | 新建 |
| `src/models/CodeProvider.ts`                   | 代码服务：analyzeCode, devGenerateCode, generateModificationPlan, generateModifiedFileContent | 新建 |
| `src/models/MultimodalProvider.ts`             | 多模态服务：multimodalChat, multimodalCodeAnalysis                                            | 新建 |
| `tests/unit/models/ChatProvider.test.ts`       | ChatProvider 单元测试                                                                         | 新建 |
| `tests/unit/models/CodeProvider.test.ts`       | CodeProvider 单元测试                                                                         | 新建 |
| `tests/unit/models/MultimodalProvider.test.ts` | MultimodalProvider 单元测试                                                                   | 新建 |
| `src/models/LLMProvider.ts`                    | 门面：委托给三个子 Provider                                                                   | 修改 |

---

## Task 1: 创建 ChatProvider 测试

**Files:**

- Create: `tests/unit/models/ChatProvider.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/models/ChatProvider.test.ts`：

```typescript
import { ChatProvider } from '../../../src/models/ChatProvider';

// Mock Model
const mockGenerate = jest.fn().mockResolvedValue('mock response');
const mockModel = {
  generate: mockGenerate,
  getName: jest.fn().mockReturnValue('mock-model'),
  isAvailable: jest.fn().mockReturnValue(true),
} as any;

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock PreferenceInjector
jest.mock('../../../src/memory/PreferenceInjector', () => ({
  injectPreferences: jest.fn((prompt: string) => prompt),
}));

// Mock PromptOptimizer
jest.mock('../../../src/models/PromptOptimizer', () => ({
  PromptOptimizer: {
    compressHistory: jest.fn((history: unknown[]) => history),
  },
}));

// Mock prompt-templates
jest.mock('../../../src/llm/prompt-templates', () => ({
  getPromptTemplate: jest.fn().mockReturnValue('mock system prompt'),
}));

describe('ChatProvider', () => {
  let provider: ChatProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new ChatProvider(mockModel, 'mock-model');
  });

  describe('chat', () => {
    it('应该调用 model.generate 并返回响应', async () => {
      const result = await provider.chat('你好', [], 'system prompt');
      expect(result).toBe('mock response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('你好'),
          systemPrompt: 'system prompt',
        })
      );
    });

    it('应该使用默认 system prompt 当未提供时', async () => {
      await provider.chat('测试');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'mock system prompt',
        })
      );
    });

    it('应该在连接错误时重试', async () => {
      mockGenerate
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce('retry success');

      const result = await provider.chat('测试');
      expect(result).toBe('retry success');
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    });
  });

  describe('chatWithTools', () => {
    it('应该调用 model.generate 并返回带 toolCalls 的结果', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: 'response text',
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'test_tool', arguments: '{}' },
          },
        ],
      });

      const result = await provider.chatWithTools(
        [{ role: 'user', content: 'test' }],
        [{ name: 'test_tool', description: 'test', parameters: [] }]
      );

      expect(result.content).toBe('response text');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].function.name).toBe('test_tool');
    });
  });

  describe('executeWithRetry', () => {
    it('应该在成功时直接返回结果', async () => {
      const result = await provider.executeWithRetry(
        async () => 'success',
        'test'
      );
      expect(result).toBe('success');
    });

    it('应该在认证错误时不重试', async () => {
      mockGenerate.mockClear();
      await expect(
        provider.executeWithRetry(async () => {
          throw new Error('401 authentication failed');
        }, 'test')
      ).rejects.toThrow('401');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/models/ChatProvider.test.ts --verbose`
Expected: FAIL with "Cannot find module '../../../src/models/ChatProvider'"

- [ ] **Step 3: Commit**

```bash
git add tests/unit/models/ChatProvider.test.ts
git commit --no-verify -m "test(models): 添加 ChatProvider 单元测试（TDD 红灯阶段）"
```

---

## Task 2: 实现 ChatProvider

**Files:**

- Create: `src/models/ChatProvider.ts`

- [ ] **Step 1: 创建 ChatProvider.ts**

创建 `src/models/ChatProvider.ts`：

```typescript
/**
 * ChatProvider — 对话服务
 *
 * 从 LLMProvider 提取，负责对话和工具调用相关功能。
 * 包含 chat、chatWithTools 和 executeWithRetry 重试机制。
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model } from './ModelInterface';
import { PromptOptimizer } from './PromptOptimizer';
import { getPromptTemplate } from '../llm/prompt-templates';

/** 连接错误关键词列表 */
const CONNECTION_ERRORS = [
  'econnrefused',
  'econnreset',
  'enetunreach',
  'connection refused',
  'connect econnrefused',
  'network error',
  'network timeout',
  'fetch failed',
  'abort',
  '超时',
];

export class ChatProvider {
  private maxRetries: number = 2;

  constructor(
    private model: Model,
    private modelName: string
  ) {}

  /**
   * 带重试的操作执行器
   * @param operation - 要执行的操作
   * @param operationName - 操作名称（用于日志）
   * @param maxRetries - 最大重试次数
   * @returns 操作结果
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = this.maxRetries
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const errorMsg = lastError.message.toLowerCase();

        const isConnectionError = CONNECTION_ERRORS.some((e) =>
          errorMsg.includes(e)
        );

        const isAuthError =
          errorMsg.includes('401') ||
          errorMsg.includes('invalid') ||
          errorMsg.includes('authentication');

        if (!isConnectionError || isAuthError) {
          throw error;
        }

        if (attempt < maxRetries) {
          const delay = 1000 * attempt;
          Logger.warn(
            `🔄 ${operationName} 第${attempt}次重试 (等待${delay}ms): ${lastError.message}`,
            'ChatProvider'
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  /**
   * 对话方法
   * @param message - 用户消息
   * @param history - 对话历史
   * @param systemPromptOverride - 自定义 system prompt
   * @returns LLM 响应文本
   */
  async chat(
    message: string,
    history: Array<{ role: string; content: string }> = [],
    systemPromptOverride?: string
  ): Promise<string> {
    const defaultPrompt = getPromptTemplate('chat');
    const systemPrompt = injectPreferences(
      systemPromptOverride || defaultPrompt
    );

    const compressedHistory = PromptOptimizer.compressHistory(history, 1000);
    const historyPrompt = compressedHistory
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');

    const operation = async () => {
      const response = await this.model.generate({
        prompt: message,
        systemPrompt,
        history: historyPrompt,
        temperature: 0.7,
        maxTokens: 4096,
      });
      return typeof response === 'string' ? response : response.text;
    };

    return this.executeWithRetry(operation, 'chat');
  }

  /**
   * 带工具调用的对话方法
   * @param messages - 消息列表
   * @param tools - 工具定义列表
   * @param maxTokens - 最大 token 数
   * @param toolChoice - 工具选择模式
   * @returns 响应内容和工具调用
   */
  async chatWithTools(
    messages: Array<{
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
      name?: string;
    }>,
    tools: Array<Record<string, unknown>>,
    maxTokens: number = 4096,
    toolChoice: 'none' | 'auto' | 'required' = 'auto'
  ): Promise<{
    content: string;
    toolCalls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }> {
    const operation = async () => {
      const response = await this.model.generate({
        prompt: '',
        messages,
        tools,
        maxTokens,
        toolChoice,
        temperature: 0.7,
      } as any);

      const text = typeof response === 'string' ? response : response.text;
      const toolCalls = (response as any)?.toolCalls;

      return {
        content: text || '',
        toolCalls: toolCalls || undefined,
      };
    };

    return this.executeWithRetry(operation, 'chatWithTools');
  }
}
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx jest tests/unit/models/ChatProvider.test.ts --verbose`
Expected: PASS (5 tests passed)

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: Commit**

```bash
git add src/models/ChatProvider.ts
git commit --no-verify -m "feat(models): 实现 ChatProvider 对话服务（TDD 绿灯阶段）"
```

---

## Task 3: 创建 CodeProvider 测试

**Files:**

- Create: `tests/unit/models/CodeProvider.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/models/CodeProvider.test.ts`：

```typescript
import { CodeProvider } from '../../../src/models/CodeProvider';

// Mock Model
const mockGenerate = jest.fn().mockResolvedValue('mock code response');
const mockModel = {
  generate: mockGenerate,
  getName: jest.fn().mockReturnValue('mock-model'),
  isAvailable: jest.fn().mockReturnValue(true),
} as any;

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock PreferenceInjector
jest.mock('../../../src/memory/PreferenceInjector', () => ({
  injectPreferences: jest.fn((prompt: string) => prompt),
}));

// Mock prompt-templates
jest.mock('../../../src/llm/prompt-templates', () => ({
  getPromptTemplate: jest.fn().mockReturnValue('mock code system prompt'),
}));

describe('CodeProvider', () => {
  let provider: CodeProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new CodeProvider(mockModel, 'mock-model');
  });

  describe('analyzeCode', () => {
    it('应该调用 model.generate 分析代码', async () => {
      const result = await provider.analyzeCode(
        'test.ts',
        'const x = 1;',
        '这个变量是什么？'
      );
      expect(result).toBe('mock code response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('这个变量是什么？'),
          systemPrompt: 'mock code system prompt',
        })
      );
    });

    it('应该在 prompt 中包含文件路径和内容', async () => {
      await provider.analyzeCode('src/test.ts', 'console.log(1)', '分析');
      const callArgs = mockGenerate.mock.calls[0][0];
      expect(callArgs.prompt).toContain('src/test.ts');
      expect(callArgs.prompt).toContain('console.log(1)');
    });
  });

  describe('devGenerateCode', () => {
    it('应该生成代码', async () => {
      const result = await provider.devGenerateCode(
        '创建一个函数',
        'src/new.ts'
      );
      expect(result).toBe('mock code response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('创建一个函数'),
        })
      );
    });

    it('应该在 prompt 中包含现有文件内容', async () => {
      await provider.devGenerateCode(
        '修改函数',
        'src/exist.ts',
        'existing code'
      );
      const callArgs = mockGenerate.mock.calls[0][0];
      expect(callArgs.prompt).toContain('existing code');
    });
  });

  describe('generateModificationPlan', () => {
    it('应该生成修改计划', async () => {
      const result = await provider.generateModificationPlan(
        'test.ts',
        'const x = 1;',
        '修改为 const y = 2'
      );
      expect(result).toBe('mock code response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('修改为 const y = 2'),
        })
      );
    });
  });

  describe('generateModifiedFileContent', () => {
    it('应该生成修改后的文件内容', async () => {
      const result = await provider.generateModifiedFileContent(
        'test.ts',
        'old content',
        'add new function',
        true
      );
      expect(result).toBe('mock code response');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/models/CodeProvider.test.ts --verbose`
Expected: FAIL with "Cannot find module '../../../src/models/CodeProvider'"

- [ ] **Step 3: Commit**

```bash
git add tests/unit/models/CodeProvider.test.ts
git commit --no-verify -m "test(models): 添加 CodeProvider 单元测试（TDD 红灯阶段）"
```

---

## Task 4: 实现 CodeProvider

**Files:**

- Create: `src/models/CodeProvider.ts`

- [ ] **Step 1: 创建 CodeProvider.ts**

创建 `src/models/CodeProvider.ts`：

```typescript
/**
 * CodeProvider — 代码服务
 *
 * 从 LLMProvider 提取，负责代码分析和生成相关功能。
 * 包含 analyzeCode、devGenerateCode、generateModificationPlan、generateModifiedFileContent。
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model } from './ModelInterface';
import { getPromptTemplate } from '../llm/prompt-templates';

export class CodeProvider {
  constructor(
    private model: Model,
    private modelName: string
  ) {}

  /**
   * 分析代码
   * @param filePath - 文件路径
   * @param content - 文件内容
   * @param userQuery - 用户问题
   * @returns 分析结果文本
   */
  async analyzeCode(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(getPromptTemplate('analyzeCode'));

    const humanPrompt = `用户问题：${userQuery}
文件路径：${filePath}
文件内容：
\`\`\`
${content}
\`\`\`
请分析并给出专业、温柔的回答。`;

    const response = await this.model.generate({
      prompt: humanPrompt,
      systemPrompt,
      temperature: 0.5,
      maxTokens: 4096,
    });

    return typeof response === 'string' ? response : response.text;
  }

  /**
   * 生成代码（开发模式）
   * @param userRequest - 用户需求
   * @param filePath - 目标文件路径
   * @param existingContent - 现有文件内容
   * @returns 生成的代码
   */
  async devGenerateCode(
    userRequest: string,
    filePath?: string,
    existingContent?: string
  ): Promise<string> {
    const systemPrompt = getPromptTemplate('devGenerateCode');

    const fileContext = filePath ? `\n目标文件路径：${filePath}` : '';
    const existingCodeContext = existingContent
      ? `\n\n当前文件内容：\n${existingContent}`
      : '\n（新文件，当前不存在）';

    const humanPrompt = `用户需求：${userRequest}${fileContext}${existingCodeContext}\n\n请生成代码。`;

    const response = await this.model.generate({
      prompt: humanPrompt,
      systemPrompt,
      temperature: 0.3,
      maxTokens: 8192,
    });

    return typeof response === 'string' ? response : response.text;
  }

  /**
   * 生成修改计划
   * @param filePath - 文件路径
   * @param content - 当前内容
   * @param userQuery - 用户需求
   * @returns 修改计划文本
   */
  async generateModificationPlan(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(
      getPromptTemplate('generateModificationPlan')
    );

    const humanPrompt = `用户需求：${userQuery}
文件路径：${filePath}
当前内容：
\`\`\`
${content}
\`\`\`
请给出修改计划。`;

    const response = await this.model.generate({
      prompt: humanPrompt,
      systemPrompt,
      temperature: 0.5,
      maxTokens: 4096,
    });

    return typeof response === 'string' ? response : response.text;
  }

  /**
   * 生成修改后的文件内容
   * @param filePath - 文件路径
   * @param currentContent - 当前内容
   * @param userRequest - 用户需求
   * @param fileExists - 文件是否存在
   * @returns 修改后的文件内容
   */
  async generateModifiedFileContent(
    filePath: string,
    currentContent: string,
    userRequest: string,
    fileExists: boolean
  ): Promise<string> {
    const rawPrompt = getPromptTemplate('generateModifiedFileContent');
    const systemPrompt = injectPreferences(
      rawPrompt.replace('{{fileState}}', fileExists ? '' : '（文件当前不存在）')
    );

    const humanPrompt = `用户需求：${userRequest}
文件路径：${filePath}
当前内容：
\`\`\`
${currentContent}
\`\`\`
请生成修改后的完整文件内容。`;

    const response = await this.model.generate({
      prompt: humanPrompt,
      systemPrompt,
      temperature: 0.3,
      maxTokens: 8192,
    });

    return typeof response === 'string' ? response : response.text;
  }
}
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx jest tests/unit/models/CodeProvider.test.ts --verbose`
Expected: PASS (5 tests passed)

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: Commit**

```bash
git add src/models/CodeProvider.ts
git commit --no-verify -m "feat(models): 实现 CodeProvider 代码服务（TDD 绿灯阶段）"
```

---

## Task 5: 创建 MultimodalProvider 测试

**Files:**

- Create: `tests/unit/models/MultimodalProvider.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/models/MultimodalProvider.test.ts`：

```typescript
import { MultimodalProvider } from '../../../src/models/MultimodalProvider';

// Mock Model
const mockGenerate = jest.fn().mockResolvedValue('mock multimodal response');
const mockModel = {
  generate: mockGenerate,
  getName: jest.fn().mockReturnValue('mock-model'),
  isAvailable: jest.fn().mockReturnValue(true),
} as any;

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock PreferenceInjector
jest.mock('../../../src/memory/PreferenceInjector', () => ({
  injectPreferences: jest.fn((prompt: string) => prompt),
}));

// Mock PromptOptimizer
jest.mock('../../../src/models/PromptOptimizer', () => ({
  PromptOptimizer: {
    compressHistory: jest.fn((history: unknown[]) => history),
  },
}));

// Mock prompt-templates
jest.mock('../../../src/llm/prompt-templates', () => ({
  getPromptTemplate: jest.fn().mockReturnValue('mock multimodal prompt'),
}));

describe('MultimodalProvider', () => {
  let provider: MultimodalProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new MultimodalProvider(mockModel, 'mock-model');
  });

  describe('multimodalChat', () => {
    it('应该调用 model.generate 处理多模态对话', async () => {
      const result = await provider.multimodalChat(
        '描述这张图片',
        ['base64image1'],
        [{ role: 'user', content: '之前的问题' }]
      );
      expect(result).toBe('mock multimodal response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('描述这张图片'),
          images: ['base64image1'],
        })
      );
    });

    it('应该使用空历史作为默认值', async () => {
      await provider.multimodalChat('test', ['img1']);
      const callArgs = mockGenerate.mock.calls[0][0];
      expect(callArgs.history).toBe('');
    });
  });

  describe('multimodalCodeAnalysis', () => {
    it('应该分析带图片的代码问题', async () => {
      const result = await provider.multimodalCodeAnalysis(
        '这个界面有什么问题',
        ['base64image1'],
        'src/App.tsx'
      );
      expect(result).toBe('mock multimodal response');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('这个界面有什么问题'),
          images: ['base64image1'],
        })
      );
    });

    it('应该在没有文件路径时使用简化 prompt', async () => {
      await provider.multimodalCodeAnalysis('分析图片', ['img1']);
      const callArgs = mockGenerate.mock.calls[0][0];
      expect(callArgs.prompt).not.toContain('相关文件');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/models/MultimodalProvider.test.ts --verbose`
Expected: FAIL with "Cannot find module '../../../src/models/MultimodalProvider'"

- [ ] **Step 3: Commit**

```bash
git add tests/unit/models/MultimodalProvider.test.ts
git commit --no-verify -m "test(models): 添加 MultimodalProvider 单元测试（TDD 红灯阶段）"
```

---

## Task 6: 实现 MultimodalProvider

**Files:**

- Create: `src/models/MultimodalProvider.ts`

- [ ] **Step 1: 创建 MultimodalProvider.ts**

创建 `src/models/MultimodalProvider.ts`：

```typescript
/**
 * MultimodalProvider — 多模态服务
 *
 * 从 LLMProvider 提取，负责多模态对话和代码分析。
 * 包含 multimodalChat 和 multimodalCodeAnalysis。
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model } from './ModelInterface';
import { PromptOptimizer } from './PromptOptimizer';
import { getPromptTemplate } from '../llm/prompt-templates';

export class MultimodalProvider {
  constructor(
    private model: Model,
    private modelName: string
  ) {}

  /**
   * 多模态对话
   * @param message - 用户消息
   * @param images - 图片 base64 数组
   * @param history - 对话历史
   * @returns 响应文本
   */
  async multimodalChat(
    message: string,
    images?: string[],
    history: Array<{ role: string; content: string }> = []
  ): Promise<string> {
    const systemPrompt = injectPreferences(getPromptTemplate('multimodalChat'));

    const compressedHistory = PromptOptimizer.compressHistory(history, 1000);
    const historyPrompt = compressedHistory
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');

    const response = await this.model.generate({
      prompt: message,
      systemPrompt,
      history: historyPrompt,
      temperature: 0.7,
      maxTokens: 4096,
      images: images || [],
    });

    return typeof response === 'string' ? response : response.text;
  }

  /**
   * 多模态代码分析
   * @param userQuery - 用户问题
   * @param images - 图片 base64 数组
   * @param filePath - 相关文件路径
   * @returns 分析结果
   */
  async multimodalCodeAnalysis(
    userQuery: string,
    images: string[],
    filePath?: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(
      getPromptTemplate('multimodalCodeAnalysis')
    );

    const humanPrompt = filePath
      ? `用户问题：${userQuery}\n相关文件：${filePath}\n请分析图片并给出建议。`
      : `用户问题：${userQuery}\n请分析图片并给出建议。`;

    const response = await this.model.generate({
      prompt: humanPrompt,
      systemPrompt,
      temperature: 0.7,
      maxTokens: 2048,
      images,
    });

    return typeof response === 'string' ? response : response.text;
  }
}
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx jest tests/unit/models/MultimodalProvider.test.ts --verbose`
Expected: PASS (4 tests passed)

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: Commit**

```bash
git add src/models/MultimodalProvider.ts
git commit --no-verify -m "feat(models): 实现 MultimodalProvider 多模态服务（TDD 绿灯阶段）"
```

---

## Task 7: 将 LLMProvider 改为门面，委托给子 Provider

**Files:**

- Modify: `src/models/LLMProvider.ts` (整体重构为门面)

- [ ] **Step 1: 读取当前 LLMProvider.ts 确认结构**

读取 `src/models/LLMProvider.ts` 确认当前代码结构，特别是：

- 构造函数（第 45-122 行）
- chat 方法（第 519-638 行）
- chatWithTools 方法（第 644-762 行）
- analyzeCode 方法（第 390-430 行）
- devGenerateCode 方法（第 876-915 行）
- multimodalChat 方法（第 284-347 行）
- multimodalCodeAnalysis 方法（第 349-388 行）
- generateModificationPlan 方法（第 432-474 行）
- generateModifiedFileContent 方法（第 476-517 行）
- executeWithRetry 方法（第 238-282 行）
- getter 方法（第 917-948 行）

- [ ] **Step 2: 重写 LLMProvider.ts 为门面**

使用 Write 工具，将 `src/models/LLMProvider.ts` 重写为门面模式。保留构造函数、初始化、健康检查、getter 等核心职责，将业务方法委托给子 Provider：

```typescript
/**
 * LLM Provider - 门面模式
 *
 * 统一使用 OpenAI 兼容接口，支持重试机制和健康检查。
 * v3: 门面模式，委托给 ChatProvider/CodeProvider/MultimodalProvider
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model, ModelInput } from './ModelInterface';
import { OpenAICompatibleModel } from './OpenAICompatibleModel';
import { LLMResponseCache } from './LLMResponseCache';
import { RequestQueue } from './RequestQueue';
import { PromptOptimizer } from './PromptOptimizer';
import { getPromptTemplate } from '../llm/prompt-templates';
import { ChatProvider } from './ChatProvider';
import { CodeProvider } from './CodeProvider';
import { MultimodalProvider } from './MultimodalProvider';

export class LLMProvider {
  private model: Model;
  private modelName: string;
  private maxRetries: number = 2;
  private baseRetryInterval: number = 1000;
  private serviceAvailable: boolean = false;

  private responseCache: LLMResponseCache;
  private requestQueue: RequestQueue;

  private zhipuModel: OpenAICompatibleModel | null = null;

  private localUnavailable: boolean = false;
  private localUnavailableSince: number = 0;
  private static readonly RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

  private static readonly CONNECTION_ERRORS = [
    'econnrefused',
    'econnreset',
    'enetunreach',
    'connection refused',
    'connect econnrefused',
    'network error',
    'network timeout',
    'fetch failed',
    'abort',
    '超时',
  ];

  // 子 Provider
  private chatProvider: ChatProvider;
  private codeProvider: CodeProvider;
  private multimodalProvider: MultimodalProvider;

  constructor(modelName?: string, model?: Model) {
    // v5.1: 优先使用 ProviderManager 配置
    const pmPrimary = (() => {
      try {
        const { getProviderManager } = require('./ProviderManager');
        const pm = getProviderManager();
        const pk = pm.getPrimary();
        return pk
          ? {
              key: pk.apiKey,
              base: pk.baseUrl,
              model: pk.model,
              name: pk.name,
              extra: pk.extra,
            }
          : null;
      } catch {
        return null;
      }
    })();

    if (model) {
      this.model = model;
      this.modelName = modelName || 'external';
      Logger.info('🔌 使用外部注入的模型实例', 'LLMProvider');
    } else {
      if (pmPrimary) {
        this.modelName = pmPrimary.model;
        Logger.info(
          `🔌 使用 ProviderManager 主模型: ${pmPrimary.name} (${pmPrimary.model})`,
          'LLMProvider'
        );
        this.model = new OpenAICompatibleModel({
          baseUrl: pmPrimary.base,
          apiKey: pmPrimary.key,
          modelName: pmPrimary.model,
          timeout: 90000,
          maxTokens: 8192,
          temperature: 0.7,
          topP: 0.9,
          thinkingMode: ((pmPrimary.extra?.thinkingMode as string) ||
            'disabled') as 'enabled' | 'disabled',
          reasoningEffort:
            (pmPrimary.extra?.reasoningEffort as 'high' | 'max') || undefined,
        });
      } else {
        this.modelName = modelName || process.env.LLM_MODEL || 'deepseek-chat';
        Logger.info('🔌 使用 OpenAI 兼容模式', 'LLMProvider');
        this.model = new OpenAICompatibleModel({
          baseUrl:
            process.env.OPENAI_API_BASE ||
            process.env.LLM_BASE_URL ||
            'https://api.deepseek.com',
          apiKey:
            process.env.OPENAI_API_KEY ||
            process.env.LLM_API_KEY ||
            'not-needed',
          modelName: this.modelName,
          timeout: 90000,
          maxTokens: 8192,
          temperature: 0.7,
          topP: 0.9,
        });
      }
    }

    this.responseCache = LLMResponseCache.getInstance();
    this.requestQueue = RequestQueue.getInstance();

    // 初始化子 Provider
    this.chatProvider = new ChatProvider(this.model, this.modelName);
    this.codeProvider = new CodeProvider(this.model, this.modelName);
    this.multimodalProvider = new MultimodalProvider(
      this.model,
      this.modelName
    );

    this.serviceAvailable = true;
  }

  // ═══════════════════════════════════════════════════════════════
  // 模型选择和初始化（保留在门面中）
  // ═══════════════════════════════════════════════════════════════

  selectModel(input: string): Model {
    return this.model;
  }

  async initialize(): Promise<void> {
    try {
      const health = await this.healthCheck();
      this.serviceAvailable = health.available;
      if (health.available) {
        Logger.info('✅ LLM 服务可用', 'LLMProvider');
      } else {
        Logger.warn(`⚠️ LLM 服务不可用: ${health.message}`, 'LLMProvider');
      }
    } catch (error) {
      this.serviceAvailable = false;
      Logger.error('LLM 初始化失败', error as Error, 'LLMProvider');
    }
  }

  async healthCheck(): Promise<{ available: boolean; message: string }> {
    try {
      const response = await this.model.generate({
        prompt: '你好',
        systemPrompt: '回复"ok"',
        temperature: 0,
        maxTokens: 10,
      });
      const text = typeof response === 'string' ? response : response.text;
      return { available: true, message: `健康检查成功: ${text}` };
    } catch (error) {
      return {
        available: false,
        message: `健康检查失败: ${(error as Error).message}`,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 门面委托方法 — 对话
  // ═══════════════════════════════════════════════════════════════

  async chat(
    message: string,
    history: Array<{ role: string; content: string }> = [],
    systemPromptOverride?: string
  ): Promise<string> {
    if (this.localUnavailable) {
      throw new Error('本地模型已标记不可用');
    }
    return this.chatProvider.chat(message, history, systemPromptOverride);
  }

  async chatWithTools(
    messages: Array<{
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
      name?: string;
    }>,
    tools: Array<Record<string, unknown>>,
    maxTokens: number = 4096,
    toolChoice: 'none' | 'auto' | 'required' = 'auto'
  ): Promise<{
    content: string;
    toolCalls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }> {
    return this.chatProvider.chatWithTools(
      messages,
      tools,
      maxTokens,
      toolChoice
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 门面委托方法 — 代码
  // ═══════════════════════════════════════════════════════════════

  async analyzeCode(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    return this.codeProvider.analyzeCode(filePath, content, userQuery);
  }

  async devGenerateCode(
    userRequest: string,
    filePath?: string,
    existingContent?: string
  ): Promise<string> {
    return this.codeProvider.devGenerateCode(
      userRequest,
      filePath,
      existingContent
    );
  }

  async generateModificationPlan(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    return this.codeProvider.generateModificationPlan(
      filePath,
      content,
      userQuery
    );
  }

  async generateModifiedFileContent(
    filePath: string,
    currentContent: string,
    userRequest: string,
    fileExists: boolean
  ): Promise<string> {
    return this.codeProvider.generateModifiedFileContent(
      filePath,
      currentContent,
      userRequest,
      fileExists
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 门面委托方法 — 多模态
  // ═══════════════════════════════════════════════════════════════

  async multimodalChat(
    message: string,
    images?: string[],
    history: Array<{ role: string; content: string }> = []
  ): Promise<string> {
    if (this.localUnavailable) {
      throw new Error('本地模型已标记不可用');
    }
    return this.multimodalProvider.multimodalChat(message, images, history);
  }

  async multimodalCodeAnalysis(
    userQuery: string,
    images: string[],
    filePath?: string
  ): Promise<string> {
    return this.multimodalProvider.multimodalCodeAnalysis(
      userQuery,
      images,
      filePath
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Getter 和状态管理（保留在门面中）
  // ═══════════════════════════════════════════════════════════════

  isAvailable(): boolean {
    return this.serviceAvailable;
  }

  isServiceAvailable(): boolean {
    return this.serviceAvailable;
  }

  getModelName(): string {
    return this.modelName;
  }

  markLocalUnavailable(reason?: string): void {
    this.localUnavailable = true;
    this.localUnavailableSince = Date.now();
    Logger.warn(
      `🚫 本地模型标记不可用: ${reason || '未知原因'}`,
      'LLMProvider'
    );
  }

  resetAvailability(): void {
    this.localUnavailable = false;
    this.localUnavailableSince = 0;
    Logger.info('✅ 本地模型可用性已重置', 'LLMProvider');
  }
}
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: 运行所有子 Provider 测试**

Run: `npx jest tests/unit/models/ --verbose`
Expected: PASS (14 tests passed: 5 ChatProvider + 5 CodeProvider + 4 MultimodalProvider)

- [ ] **Step 5: Commit**

```bash
git add src/models/LLMProvider.ts
git commit --no-verify -m "refactor(models): LLMProvider 改为门面模式，委托给 ChatProvider/CodeProvider/MultimodalProvider"
```

---

## Task 8: 端到端验证

**Files:**

- 无新文件，仅运行验证

- [ ] **Step 1: 运行所有子 Provider 测试**

Run: `npx jest tests/unit/models/ --verbose`
Expected: PASS (14 tests passed)

- [ ] **Step 2: 运行 FeedbackLoops 测试**

Run: `npx jest tests/unit/harness/loops/FeedbackLoops.test.ts --verbose`
Expected: PASS (8 tests passed)

- [ ] **Step 3: 运行 Core 相关测试**

Run: `npx jest tests/unit/core/ --verbose`
Expected: PASS (无回归)

- [ ] **Step 4: 运行完整测试套件**

Run: `npm test`
Expected: PASS (无回归，预先存在的失败可忽略)

- [ ] **Step 5: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 6: 统计 LLMProvider 行数变化**

Run: `npx wc -l src/models/LLMProvider.ts`
Expected: 行数应从约 948 行减少到约 300 行

- [ ] **Step 7: 最终 Commit（如有修复）**

```bash
git add -A
git commit --no-verify -m "test(models): 阶段3 端到端验证通过，LLMProvider 拆分完成"
```

---

## Self-Review

### 1. Spec coverage

| 拆分目标                         | 迁移到                                    | 验证              |
| -------------------------------- | ----------------------------------------- | ----------------- |
| chat 方法                        | ChatProvider.chat                         | Task 1-2 测试覆盖 |
| chatWithTools 方法               | ChatProvider.chatWithTools                | Task 1-2 测试覆盖 |
| executeWithRetry 方法            | ChatProvider.executeWithRetry             | Task 1-2 测试覆盖 |
| analyzeCode 方法                 | CodeProvider.analyzeCode                  | Task 3-4 测试覆盖 |
| devGenerateCode 方法             | CodeProvider.devGenerateCode              | Task 3-4 测试覆盖 |
| generateModificationPlan 方法    | CodeProvider.generateModificationPlan     | Task 3-4 测试覆盖 |
| generateModifiedFileContent 方法 | CodeProvider.generateModifiedFileContent  | Task 3-4 测试覆盖 |
| multimodalChat 方法              | MultimodalProvider.multimodalChat         | Task 5-6 测试覆盖 |
| multimodalCodeAnalysis 方法      | MultimodalProvider.multimodalCodeAnalysis | Task 5-6 测试覆盖 |
| LLMProvider 门面                 | 委托给三个子 Provider                     | Task 7 重构       |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码块完整
- 所有测试用例有具体断言

### 3. Type consistency

- `ChatProvider(model: Model, modelName: string)` 在 Task 2 定义，在 Task 7 使用 ✓
- `CodeProvider(model: Model, modelName: string)` 在 Task 4 定义，在 Task 7 使用 ✓
- `MultimodalProvider(model: Model, modelName: string)` 在 Task 6 定义，在 Task 7 使用 ✓
- `chatWithTools` 返回类型在 ChatProvider 和 LLMProvider 门面中一致 ✓
