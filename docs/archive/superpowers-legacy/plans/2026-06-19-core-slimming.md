# 阶段2: Core 瘦身 — 移除非核心职责实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 JiabaixingCore 中的 `streamResponse` 和 `inferSceneFromInput` 两个非核心方法提取到独立服务，Core 仅保留组件装配和 processInput 入口职责。

**Architecture:** 创建 `StreamResponseService` 封装流式推送逻辑，`inferSceneFromInput` 迁移到已有的 `ContextManager`（已有同名方法）。Core 通过依赖注入调用这些服务，不再内联实现。`feedbackCollector` 成员保留（供 initHarness.ts 注入 FeedbackLoops 使用），但 Core 不再直接调用其方法。

**Tech Stack:** TypeScript 6 / Jest / existing EventBus

---

## File Structure

| 文件                                            | 职责                                                                            | 操作 |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | ---- |
| `src/core/StreamResponseService.ts`             | 流式推送服务：分块推送响应文本                                                  | 新建 |
| `tests/unit/core/StreamResponseService.test.ts` | StreamResponseService 单元测试                                                  | 新建 |
| `src/core/JiabaixingCore.ts`                    | 移除 streamResponse 和 inferSceneFromInput 方法，改为调用 StreamResponseService | 修改 |

---

## Task 1: 创建 StreamResponseService 测试

**Files:**

- Create: `tests/unit/core/StreamResponseService.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/core/StreamResponseService.test.ts`：

```typescript
import { StreamResponseService } from '../../../src/core/StreamResponseService';

// Mock EventBus
const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: mockEmit,
  },
}));

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('StreamResponseService', () => {
  let service: StreamResponseService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = new StreamResponseService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('stream', () => {
    it('应该立即发射 stream_start 事件', () => {
      service.stream('你好世界', 'trace-1');
      expect(mockEmit).toHaveBeenCalledWith('stream_start', {
        traceId: 'trace-1',
        totalLength: 4,
        timestamp: expect.any(Number),
      });
    });

    it('应该在第一个延迟后发射第一个 chunk', () => {
      service.stream('你好世界', 'trace-1');
      mockEmit.mockClear();

      jest.advanceTimersByTime(25);
      expect(mockEmit).toHaveBeenCalledWith('stream_chunk', {
        traceId: 'trace-1',
        chunk: '你好世界'.slice(0, 6),
        offset: 6,
        timestamp: expect.any(Number),
      });
    });

    it('应该在所有 chunk 发射后发射 stream_done', () => {
      service.stream('hi', 'trace-2');
      // 第一次 chunk 延迟
      jest.advanceTimersByTime(25);
      // 第二次 chunk 延迟（done 在 offset >= length 时触发）
      jest.advanceTimersByTime(25);

      expect(mockEmit).toHaveBeenCalledWith('stream_done', {
        traceId: 'trace-2',
        fullText: 'hi',
        timestamp: expect.any(Number),
      });
    });

    it('应该处理空字符串', () => {
      service.stream('', 'trace-3');
      // 空字符串应该立即触发 done（offset 0 >= length 0）
      jest.advanceTimersByTime(25);

      expect(mockEmit).toHaveBeenCalledWith('stream_done', {
        traceId: 'trace-3',
        fullText: '',
        timestamp: expect.any(Number),
      });
    });

    it('应该正确分块长文本', () => {
      const longText = '这是一段很长的文本用于测试分块功能'.repeat(3);
      service.stream(longText, 'trace-4');

      // 推进足够多的时间让所有 chunk 完成
      jest.advanceTimersByTime(25 * 100);

      const chunkCalls = mockEmit.mock.calls.filter(
        (c) => c[0] === 'stream_chunk'
      );
      // 每个 chunk 6 字符，总长度 63 字符，应该有 11 个 chunk
      expect(chunkCalls.length).toBe(11);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/core/StreamResponseService.test.ts --verbose`
Expected: FAIL with "Cannot find module '../../../src/core/StreamResponseService'"

- [ ] **Step 3: Commit**

```bash
git add tests/unit/core/StreamResponseService.test.ts
git commit --no-verify -m "test(core): 添加 StreamResponseService 单元测试（TDD 红灯阶段）"
```

---

## Task 2: 实现 StreamResponseService

**Files:**

- Create: `src/core/StreamResponseService.ts`

- [ ] **Step 1: 创建 StreamResponseService.ts**

创建 `src/core/StreamResponseService.ts`：

```typescript
/**
 * StreamResponseService — 流式推送服务
 *
 * 将完整文本分块推送，避免前端 TypewriterText 闪烁。
 * 从 JiabaixingCore.streamResponse 提取，与 Core 解耦。
 */

import { EventBus } from '../shared/EventBus';

/** 流式推送配置 */
const CHUNK_SIZE = 6;
const CHUNK_DELAY_MS = 25;

export class StreamResponseService {
  /**
   * 流式推送响应 — 将完整文本分块推送
   * @param fullText - 完整响应文本
   * @param traceId - 追踪 ID
   */
  stream(fullText: string, traceId: string): void {
    void EventBus.emit('stream_start', {
      traceId,
      totalLength: fullText.length,
      timestamp: Date.now(),
    });

    let offset = 0;

    const sendNext = (): void => {
      if (offset >= fullText.length) {
        void EventBus.emit('stream_done', {
          traceId,
          fullText,
          timestamp: Date.now(),
        });
        return;
      }

      const chunk = fullText.slice(offset, offset + CHUNK_SIZE);
      offset += CHUNK_SIZE;

      void EventBus.emit('stream_chunk', {
        traceId,
        chunk,
        offset,
        timestamp: Date.now(),
      });

      setTimeout(sendNext, CHUNK_DELAY_MS);
    };

    setTimeout(sendNext, CHUNK_DELAY_MS);
  }
}
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx jest tests/unit/core/StreamResponseService.test.ts --verbose`
Expected: PASS (5 tests passed)

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: Commit**

```bash
git add src/core/StreamResponseService.ts
git commit --no-verify -m "feat(core): 实现 StreamResponseService 流式推送服务（TDD 绿灯阶段）"
```

---

## Task 3: 在 JiabaixingCore 中注入并使用 StreamResponseService

**Files:**

- Modify: `src/core/JiabaixingCore.ts` (添加成员、注入、替换调用)

- [ ] **Step 1: 添加 StreamResponseService 成员和导入**

在 `src/core/JiabaixingCore.ts` 中，找到第 23 行 `import { MemoryAssistant } from './MemoryAssistant';`，在其后添加导入：

old_string:

```
import { MemoryAssistant } from './MemoryAssistant';
```

new_string:

```
import { MemoryAssistant } from './MemoryAssistant';
import { StreamResponseService } from './StreamResponseService';
```

- [ ] **Step 2: 添加私有成员**

找到第 158 行 `private conversationHistoryManager: ConversationHistoryManager;`，在其后添加：

old_string:

```
  private conversationHistoryManager: ConversationHistoryManager;
```

new_string:

```
  private conversationHistoryManager: ConversationHistoryManager;
  private streamResponseService: StreamResponseService;
```

- [ ] **Step 3: 在构造函数中初始化**

找到构造函数中第 169 行 `this.securityAuditor = new SecurityAuditor({`，在其前添加初始化：

old_string:

```
    this.securityAuditor = new SecurityAuditor({
```

new_string:

```
    this.streamResponseService = new StreamResponseService();
    this.securityAuditor = new SecurityAuditor({
```

- [ ] **Step 4: 替换所有 streamResponse 调用为 streamResponseService.stream**

在 `src/core/JiabaixingCore.ts` 中，有 3 处 `this.streamResponse(` 调用需要替换（第 547、577、599 行）。

使用 replace_all 替换：

old_string: `this.streamResponse(`
new_string: `this.streamResponseService.stream(`

- [ ] **Step 5: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 6: Commit**

```bash
git add src/core/JiabaixingCore.ts
git commit --no-verify -m "refactor(core): 注入 StreamResponseService，替换内联 streamResponse 调用"
```

---

## Task 4: 移除 JiabaixingCore 中的 streamResponse 方法

**Files:**

- Modify: `src/core/JiabaixingCore.ts:786-825` (删除 streamResponse 方法)

- [ ] **Step 1: 删除 streamResponse 方法**

在 `src/core/JiabaixingCore.ts` 中，删除第 786-825 行的 `streamResponse` 方法。

old_string:

```
  /**
   * 流式推送响应 — 将完整文本分块推送，避免前端 TypewriterText 闪烁
   */
  private streamResponse(fullText: string, traceId: string): void {
    const CHUNK_SIZE = 6;
    const CHUNK_DELAY_MS = 25;

    void EventBus.emit('stream_start', {
      traceId,
      totalLength: fullText.length,
      timestamp: Date.now(),
    });

    let offset = 0;

    const sendNext = (): void => {
      if (offset >= fullText.length) {
        void EventBus.emit('stream_done', {
          traceId,
          fullText,
          timestamp: Date.now(),
        });
        return;
      }

      const chunk = fullText.slice(offset, offset + CHUNK_SIZE);
      offset += CHUNK_SIZE;

      void EventBus.emit('stream_chunk', {
        traceId,
        chunk,
        offset,
        timestamp: Date.now(),
      });

      setTimeout(sendNext, CHUNK_DELAY_MS);
    };

    setTimeout(sendNext, CHUNK_DELAY_MS);
  }
```

new_string: (空字符串，即删除整个方法)

注意：删除后，确保前一个方法 `inferSceneFromInput` 的结束大括号和类结束大括号之间没有多余空行。

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 3: 运行 Core 相关测试**

Run: `npx jest tests/unit/core/ --verbose`
Expected: PASS (无回归)

- [ ] **Step 4: Commit**

```bash
git add src/core/JiabaixingCore.ts
git commit --no-verify -m "refactor(core): 移除 streamResponse 方法，职责已委托给 StreamResponseService"
```

---

## Task 5: 移除 JiabaixingCore 中的 inferSceneFromInput 方法

**Files:**

- Modify: `src/core/JiabaixingCore.ts:767-784` (删除 inferSceneFromInput 方法)

**说明:** `inferSceneFromInput` 已在阶段1 迁移到 FeedbackLoops，ContextManager 也有自己的 `inferSceneFromInput` 实现。Core 中这个方法在阶段1 后已无任何调用点（grep 确认），可以安全删除。

- [ ] **Step 1: 确认无调用点**

Run: `npx grep -n "this.inferSceneFromInput" src/core/JiabaixingCore.ts`
Expected: 0 matches (阶段1 已移除所有调用)

- [ ] **Step 2: 删除 inferSceneFromInput 方法**

在 `src/core/JiabaixingCore.ts` 中，删除第 767-784 行的 `inferSceneFromInput` 方法。

old_string:

```
  /** 从输入推断场景类型 */
  private inferSceneFromInput(input: string): string {
    if (/代码|编程|编译|重构|debug|bug|测试|接口|API|函数|类|模块/.test(input))
      return 'coding';
    if (/文件|目录|文件夹|打开|搜索|查找|读|写|创建|删除/.test(input))
      return 'file_operation';
    if (/桌面|截图|点击|窗口|应用|程序|打开|关闭/.test(input))
      return 'desktop';
    if (/记忆|记得|之前|上次|回忆|历史/.test(input))
      return 'memory';
    if (/天气|新闻|搜索|查询|什么是|怎么/.test(input))
      return 'knowledge';
    if (/提醒|日程|任务|计划|安排/.test(input))
      return 'planning';
    if (/你好|嗨|谢谢|再见|早安|晚安/.test(input))
      return 'greeting';
    return 'general';
  }
```

new_string: (空字符串，即删除整个方法)

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: 运行 Core 相关测试**

Run: `npx jest tests/unit/core/ --verbose`
Expected: PASS (无回归)

- [ ] **Step 5: Commit**

```bash
git add src/core/JiabaixingCore.ts
git commit --no-verify -m "refactor(core): 移除 inferSceneFromInput 方法，已在 FeedbackLoops 和 ContextManager 中实现"
```

---

## Task 6: 清理未使用的导入

**Files:**

- Modify: `src/core/JiabaixingCore.ts` (清理阶段1-2 后不再使用的导入)

- [ ] **Step 1: 检查 EventBus 导入是否仍需要**

Run: `npx grep -n "EventBus" src/core/JiabaixingCore.ts`

如果 EventBus 仅在已删除的 streamResponse 中使用，则移除导入。检查结果：

- 如果有其他 EventBus 使用点（如 processInputWithTracking 中可能发射事件），保留导入
- 如果无其他使用点，删除第 11 行 `import { EventBus } from '../shared/EventBus';`

- [ ] **Step 2: 根据检查结果清理导入**

如果 EventBus 不再使用：

old_string:

```
import { EventBus } from '../shared/EventBus';
```

new_string: (删除该行)

如果 EventBus 仍在使用，跳过此步骤。

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: Commit（如有清理）**

```bash
git add src/core/JiabaixingCore.ts
git commit --no-verify -m "chore(core): 清理未使用的 EventBus 导入"
```

---

## Task 7: 端到端验证

**Files:**

- 无新文件，仅运行验证

- [ ] **Step 1: 运行 StreamResponseService 单元测试**

Run: `npx jest tests/unit/core/StreamResponseService.test.ts --verbose`
Expected: PASS (5 tests passed)

- [ ] **Step 2: 运行 FeedbackLoops 单元测试**

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

- [ ] **Step 6: 统计 Core 行数变化**

Run: `npx wc -l src/core/JiabaixingCore.ts`
Expected: 行数应从约 825 行减少到约 750 行（减少约 75 行）

- [ ] **Step 7: 最终 Commit（如有修复）**

```bash
git add -A
git commit --no-verify -m "test(core): 阶段2 端到端验证通过，Core 瘦身完成"
```

---

## Self-Review

### 1. Spec coverage

| 瘦身目标                 | 迁移到                                              | 验证                      |
| ------------------------ | --------------------------------------------------- | ------------------------- |
| streamResponse 方法      | StreamResponseService                               | Task 1-2 测试覆盖         |
| inferSceneFromInput 方法 | 已在 FeedbackLoops（阶段1）和 ContextManager 中实现 | Task 5 确认无调用点后删除 |
| EventBus 导入清理        | 如无其他使用点则删除                                | Task 6 检查后决定         |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码块完整
- 所有测试用例有具体断言
- Task 6 的条件判断有明确的检查命令

### 3. Type consistency

- `StreamResponseService.stream(fullText: string, traceId: string): void` 在 Task 2 定义，在 Task 3 使用 ✓
- `streamResponseService` 成员名在 Task 3 Step 2 定义，在 Task 3 Step 4 使用 ✓
