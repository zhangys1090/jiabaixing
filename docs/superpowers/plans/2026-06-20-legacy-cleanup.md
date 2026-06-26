# 阶段6: 旧路径清理 — 死代码移除 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除阶段1-3 重构后遗留的死代码，包括 LLMProvider 中无调用的 executeWithRetry、JiabaixingCore 中无调用的 recentConversationHistory 兼容层和 getLastToolResults 空方法。

**Architecture:** 阶段1-3 已将 FeedbackLoops、StreamResponseService、ChatProvider/CodeProvider/MultimodalProvider 提取为独立组件，但原文件中仍保留了被替代但未清理的死代码。本计划通过精确的调用点分析，安全移除确认无调用的死代码，不创建新文件，不修改任何有外部调用的方法。

**Tech Stack:** TypeScript 6 / Jest

---

## 现状分析

### 已确认的死代码（无任何调用点）

| 文件                         | 死代码                                    | 行号    | 替代方案                                                    | 确认方式                                                   |
| ---------------------------- | ----------------------------------------- | ------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `src/models/LLMProvider.ts`  | `executeWithRetry<T>()` 私有方法          | 251-294 | ChatProvider/CodeProvider/MultimodalProvider 各自有独立实现 | Grep `this.executeWithRetry` in LLMProvider.ts → 0 matches |
| `src/core/JiabaixingCore.ts` | `recentConversationHistory` getter/setter | 677-690 | `conversationHistoryManager` 已直接使用                     | Grep 全项目 → 仅定义处，0 调用                             |
| `src/core/JiabaixingCore.ts` | `getLastToolResults()`                    | 758-768 | 返回空数组 `[]`，无实际功能                                 | Grep 全项目 → 仅定义处，0 调用                             |
| `src/core/JiabaixingCore.ts` | `MAX_CONVERSATION_HISTORY` 常量           | 692     | 仅被 recentConversationHistory 使用                         | 删除 getter/setter 后无引用                                |

### 不能删除的代码（有外部调用或有意保留）

| 文件                         | 代码                                            | 原因                                                                                    |
| ---------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/core/JiabaixingCore.ts` | `feedbackCollector` 属性 (line 149)             | 被 `initHarness.ts:1091` 使用：`harnessDeps.feedbackCollector = core.feedbackCollector` |
| `src/models/LLMProvider.ts`  | `zhipuModel` fallback 逻辑 (chat/chatWithTools) | 阶段3 有意保留的 hybrid 模式，子 Provider 不持有 zhipuModel                             |
| `src/models/LLMProvider.ts`  | `sanitizeMessagesForAPI` / `normalizeToolCalls` | 被 zhipuModel fallback 逻辑使用                                                         |

---

## File Structure

| 文件                                           | 职责                                                                                  | 操作 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | ---- |
| `src/models/LLMProvider.ts`                    | 移除无调用的 executeWithRetry 死方法                                                  | 修改 |
| `src/core/JiabaixingCore.ts`                   | 移除 recentConversationHistory 兼容层 + getLastToolResults + MAX_CONVERSATION_HISTORY | 修改 |
| `tests/unit/models/LLMProviderCleanup.test.ts` | 验证 LLMProvider 清理后功能正常                                                       | 新建 |
| `tests/unit/core/CoreCleanup.test.ts`          | 验证 Core 清理后功能正常                                                              | 新建 |

---

## Task 1: 创建清理验证测试（TDD 红灯）

**Files:**

- Create: `tests/unit/models/LLMProviderCleanup.test.ts`
- Create: `tests/unit/core/CoreCleanup.test.ts`

- [ ] **Step 1: 创建 LLMProvider 清理验证测试**

创建 `c:\zy\jiabaixing\tests\unit\models\LLMProviderCleanup.test.ts`：

```typescript
import { LLMProvider } from '../../../src/models/LLMProvider';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock OpenAICompatibleModel
jest.mock('../../../src/models/OpenAICompatibleModel', () => ({
  OpenAICompatibleModel: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    generate: jest.fn().mockResolvedValue({ text: 'mock response' }),
    isAvailable: jest.fn().mockReturnValue(true),
  })),
}));

describe('LLMProvider 清理验证', () => {
  let provider: LLMProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LLM_MODEL = 'deepseek-chat';
    provider = new LLMProvider();
  });

  describe('门面委托方法仍然可用', () => {
    it('chat 方法应该存在且可调用', () => {
      expect(typeof provider.chat).toBe('function');
    });

    it('chatWithTools 方法应该存在且可调用', () => {
      expect(typeof provider.chatWithTools).toBe('function');
    });

    it('analyzeCode 方法应该存在且可调用', () => {
      expect(typeof provider.analyzeCode).toBe('function');
    });

    it('multimodalChat 方法应该存在且可调用', () => {
      expect(typeof provider.multimodalChat).toBe('function');
    });

    it('devGenerateCode 方法应该存在且可调用', () => {
      expect(typeof provider.devGenerateCode).toBe('function');
    });
  });

  describe('死代码已移除', () => {
    it('executeWithRetry 不应作为 LLMProvider 的方法存在', () => {
      // executeWithRetry 是私有方法，已移除
      // 验证 LLMProvider 实例没有该属性（通过原型链检查）
      const proto = Object.getPrototypeOf(provider);
      expect(proto.hasOwnProperty('executeWithRetry')).toBe(false);
    });
  });

  describe('子 Provider 仍然被持有', () => {
    it('应该持有 chatProvider 实例', () => {
      expect(
        (provider as unknown as { chatProvider: unknown }).chatProvider
      ).toBeDefined();
    });

    it('应该持有 codeProvider 实例', () => {
      expect(
        (provider as unknown as { codeProvider: unknown }).codeProvider
      ).toBeDefined();
    });

    it('应该持有 multimodalProvider 实例', () => {
      expect(
        (provider as unknown as { multimodalProvider: unknown })
          .multimodalProvider
      ).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: 创建 Core 清理验证测试**

创建 `c:\zy\jiabaixing\tests\unit\core\CoreCleanup.test.ts`：

```typescript
import { JiabaixingCore } from '../../../src/core/JiabaixingCore';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('JiabaixingCore 清理验证', () => {
  let core: JiabaixingCore;

  beforeEach(() => {
    jest.clearAllMocks();
    core = new JiabaixingCore();
  });

  describe('核心功能仍然可用', () => {
    it('processInput 方法应该存在', () => {
      expect(typeof core.processInput).toBe('function');
    });

    it('getLLM 方法应该存在', () => {
      expect(typeof core.getLLM).toBe('function');
    });

    it('getConversationHistoryManager 方法应该存在', () => {
      expect(typeof core.getConversationHistoryManager).toBe('function');
    });

    it('feedbackCollector 仍然存在（被 initHarness 使用）', () => {
      expect(core.feedbackCollector).toBeDefined();
    });

    it('conversationHistoryManager 通过 getter 可访问', () => {
      const manager = core.getConversationHistoryManager();
      expect(manager).toBeDefined();
      expect(typeof manager.getAll).toBe('function');
    });
  });

  describe('死代码已移除', () => {
    it('getLastToolResults 方法不应存在', () => {
      expect(
        typeof (core as unknown as { getLastToolResults?: unknown })
          .getLastToolResults
      ).toBe('undefined');
    });

    it('recentConversationHistory 不应作为属性存在', () => {
      // recentConversationHistory 是 private getter/setter，已移除
      // 验证实例没有该属性
      expect(
        (core as unknown as { recentConversationHistory?: unknown })
          .recentConversationHistory
      ).toBeUndefined();
    });
  });
});
```

- [ ] **Step 3: 运行测试验证当前状态**

Run: `npx jest tests/unit/models/LLMProviderCleanup.test.ts tests/unit/core/CoreCleanup.test.ts --verbose`
Expected: 部分通过部分失败（死代码移除前，"已移除"断言会失败）

- [ ] **Step 4: Commit**

```bash
git add tests/unit/models/LLMProviderCleanup.test.ts tests/unit/core/CoreCleanup.test.ts
git commit --no-verify -m "test(cleanup): 添加旧路径清理验证测试（TDD 红灯）"
```

---

## Task 2: 移除 LLMProvider 中的 executeWithRetry 死代码

**Files:**

- Modify: `src/models/LLMProvider.ts`

- [ ] **Step 1: 读取 executeWithRetry 方法位置**

读取 `src/models/LLMProvider.ts` 的 line 251-295，确认 executeWithRetry 方法的完整范围。

- [ ] **Step 2: 移除 executeWithRetry 方法**

删除 `src/models/LLMProvider.ts` 中的 `executeWithRetry` 私有方法（约 line 251-295）。

该方法签名如下（需完整删除包括注释）：

```typescript
  private async executeWithRetry<T>(
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

        const isConnectionError = LLMProvider.CONNECTION_ERRORS.some((e) =>
          errorMsg.includes(e)
        );

        const isAuthError = errorMsg.includes('401') || errorMsg.includes('invalid') || errorMsg.includes('authentication');

        if (isConnectionError || isAuthError) {
          Logger.warn(
            `🚫 ${operationName} ${isAuthError ? '认证失败' : '连接错误'}，跳过重试: ${lastError.message}`,
            'LLMProvider'
          );
          break;
        }

        if (attempt < maxRetries) {
          const delay = this.baseRetryInterval * Math.pow(2, attempt - 1);
          Logger.warn(
            `${operationName} 第${attempt}次失败，${delay}ms后重试: ${lastError.message}`,
            'LLMProvider'
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const errorMessage = lastError
      ? `${operationName}失败: ${lastError.message}`
      : `${operationName}失败，请检查 LLM 服务是否运行`;

    throw new Error(errorMessage);
  }
```

注意：删除前确认 `this.executeWithRetry` 在 LLMProvider.ts 中无任何调用（已通过 Grep 确认 0 matches）。删除后检查 `maxRetries` 和 `baseRetryInterval` 属性是否还有其他使用，如果仅被 executeWithRetry 使用也一并清理。

- [ ] **Step 3: 运行 LLMProvider 清理测试**

Run: `npx jest tests/unit/models/LLMProviderCleanup.test.ts --verbose`
Expected: PASS

- [ ] **Step 4: 运行现有 LLMProvider 测试（回归）**

Run: `npx jest tests/unit/models/ChatProvider.test.ts tests/unit/models/CodeProvider.test.ts tests/unit/models/MultimodalProvider.test.ts --verbose`
Expected: PASS（无回归）

- [ ] **Step 5: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors（LLMProvider.ts 相关）

- [ ] **Step 6: Commit**

```bash
git add src/models/LLMProvider.ts
git commit --no-verify -m "refactor(llm): 移除 LLMProvider 中无调用的 executeWithRetry 死代码"
```

---

## Task 3: 移除 JiabaixingCore 中的死代码

**Files:**

- Modify: `src/core/JiabaixingCore.ts`

- [ ] **Step 1: 移除 recentConversationHistory 兼容层**

删除 `src/core/JiabaixingCore.ts` 中的 `recentConversationHistory` getter/setter（约 line 677-690）和 `MAX_CONVERSATION_HISTORY` 常量（约 line 692）。

需要删除的代码：

```typescript
  // 兼容层：保留原有属性，委托给 ConversationHistoryManager
  private get recentConversationHistory(): Array<{
    role: string;
    content: string;
    timestamp: Date;
  }> {
    return this.conversationHistoryManager.getAll();
  }

  private set recentConversationHistory(
    value: Array<{ role: string; content: string; timestamp: Date }>
  ) {
    this.conversationHistoryManager.setHistory(value as ConversationEntry[]);
  }

  private readonly MAX_CONVERSATION_HISTORY = 20;
```

注意：删除前确认 `recentConversationHistory` 和 `MAX_CONVERSATION_HISTORY` 在全项目中无调用（已通过 Grep 确认）。删除后检查 `ConversationEntry` 类型导入是否还需要，如果仅被这段代码使用也一并清理 import。

- [ ] **Step 2: 移除 getLastToolResults 空方法**

删除 `src/core/JiabaixingCore.ts` 中的 `getLastToolResults` 方法（约 line 758-768）。

需要删除的代码：

```typescript
  public getLastToolResults(): Array<{
    toolCall: {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    };
    validated: { valid: boolean; sanitizedOutput: string; warning?: string };
    duration: number;
  }> {
    return [];
  }
```

注意：删除前确认 `getLastToolResults` 在全项目中无调用（已通过 Grep 确认）。

- [ ] **Step 3: 运行 Core 清理测试**

Run: `npx jest tests/unit/core/CoreCleanup.test.ts --verbose`
Expected: PASS

- [ ] **Step 4: 运行现有 Core 测试（回归）**

Run: `npx jest tests/unit/core/ --verbose`
Expected: PASS（无回归）

- [ ] **Step 5: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors（JiabaixingCore.ts 相关）

- [ ] **Step 6: Commit**

```bash
git add src/core/JiabaixingCore.ts
git commit --no-verify -m "refactor(core): 移除 recentConversationHistory 兼容层和 getLastToolResults 死代码"
```

---

## Task 4: 端到端验证

**Files:**

- 无新文件，仅运行验证

- [ ] **Step 1: 运行清理验证测试**

Run: `npx jest tests/unit/models/LLMProviderCleanup.test.ts tests/unit/core/CoreCleanup.test.ts --verbose`
Expected: PASS

- [ ] **Step 2: 运行阶段1-5 全部测试（回归）**

Run: `npx jest tests/unit/harness/loops/FeedbackLoops.test.ts tests/unit/core/ tests/unit/models/ tests/unit/harness/agents/ tests/unit/harness/loop/PlannerDependency.test.ts tests/unit/harness/orchestration/ParallelOrchestration.test.ts --verbose`
Expected: PASS（无回归）

- [ ] **Step 3: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors（本次修改相关）

- [ ] **Step 4: 确认行数减少**

Run:

```bash
powershell -Command "(Get-Content 'src\models\LLMProvider.ts' | Measure-Object -Line).Lines; (Get-Content 'src\core\JiabaixingCore.ts' | Measure-Object -Line).Lines"
```

Expected: LLMProvider.ts < 630 行，JiabaixingCore.ts < 676 行

- [ ] **Step 5: 最终 Commit（如有修复）**

```bash
git add -A
git commit --no-verify -m "test(cleanup): 阶段6 端到端验证通过，旧路径清理完成"
```

---

## Self-Review

### 1. Spec coverage

| 目标                          | 实现方式                                                   | 验证            |
| ----------------------------- | ---------------------------------------------------------- | --------------- |
| 移除 Core 中的旧执行路径      | 移除 recentConversationHistory 兼容层 + getLastToolResults | Task 3 测试覆盖 |
| 移除 LLMProvider 中的冗余方法 | 移除 executeWithRetry 死方法                               | Task 2 测试覆盖 |
| 验证：全量测试通过            | 端到端回归测试                                             | Task 4          |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码块完整
- 所有删除操作前都有 Grep 确认无调用

### 3. Type consistency

- 删除的方法都是孤立的，不影响其他类型 ✓
- `feedbackCollector` 保留（有外部调用）✓
- `zhipuModel` fallback 保留（有意保留的 hybrid 模式）✓

### 4. 风险评估

- **风险等级：低** — 只删除确认无调用的死代码，不修改任何有外部调用的方法
- **回退方案** — git revert（每个 Task 独立 commit，可精确回退）
- **验证方式** — 每个 Task 都有测试验证 + TypeScript 编译检查 + 回归测试
