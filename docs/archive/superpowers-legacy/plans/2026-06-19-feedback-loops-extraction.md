# 阶段1: 闭环保护 — FeedbackLoops 提取实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 JiabaixingCore 中内联的 3 个高风险闭环（进化/工具失败反馈/偏好学习）提取为独立的 FeedbackLoops 服务，通过 AFTER_RESPONSE 钩子触发，与 Core 解耦。

**Architecture:** 创建 FeedbackLoops 类封装所有闭环逻辑，通过 HarnessDeps 注入依赖，在 AgentHarness 初始化时注册为 AFTER_RESPONSE 钩子。Core 不再内联执行闭环，仅传递 previousResponse 供纠正检测。

**Tech Stack:** TypeScript 6 / Jest / existing Harness ConstraintsService 钩子机制

---

## File Structure

| 文件                                             | 职责                                                                  | 操作 |
| ------------------------------------------------ | --------------------------------------------------------------------- | ---- |
| `src/harness/loops/FeedbackLoops.ts`             | 闭环服务：封装进化/工具失败/偏好学习/知识提取 4 个闭环                | 新建 |
| `tests/unit/harness/loops/FeedbackLoops.test.ts` | FeedbackLoops 单元测试                                                | 新建 |
| `src/harness/deps.ts`                            | 添加 FeedbackCollectorDeps 和 MemoryAssistantDeps 接口                | 修改 |
| `src/harness/AgentHarness.ts`                    | 传递更多数据到 AFTER_RESPONSE 钩子 + 注册 FeedbackLoops               | 修改 |
| `src/core/JiabaixingCore.ts`                     | 添加 getMemoryAssistant getter + 移除内联闭环 + 传递 previousResponse | 修改 |
| `src/server/init/initHarness.ts`                 | 在 harnessDeps 中注入 feedbackCollector 和 memoryAssistant            | 修改 |

---

## Task 1: 在 deps.ts 中添加 FeedbackLoops 依赖接口

**Files:**

- Modify: `src/harness/deps.ts:160-208` (HarnessDeps 接口)

- [ ] **Step 1: 在 deps.ts 末尾（ReflectionEngineDeps 之前）添加两个新接口**

在 `src/harness/deps.ts` 的 `HarnessDeps` 接口之前（约第 159 行 `export interface HarnessDeps` 之前）插入：

```typescript
/** FeedbackLoops 依赖 — 反馈收集器接口 */
export interface FeedbackCollectorDeps {
  analyzeUserInput(
    currentInput: string,
    previousResponse: string,
    userId?: string,
    scene?: string
  ): {
    type: string;
    input?: string;
    response?: string;
    [key: string]: unknown;
  } | null;
  recordToolFailure(
    toolName: string,
    errorMessage: string,
    input: string,
    userId?: string
  ): void;
  recordLowQuality(
    input: string,
    response: string,
    qualityScore: number,
    userId?: string,
    scene?: string
  ): void;
}

/** FeedbackLoops 依赖 — 记忆助手接口 */
export interface MemoryAssistantDeps {
  autoExtractKnowledge(
    input: string,
    response: string,
    userId?: string
  ): Promise<void>;
}
```

- [ ] **Step 2: 在 HarnessDeps 接口中添加两个可选字段**

在 `src/harness/deps.ts` 的 `HarnessDeps` 接口中，在 `reflectionEngine?: ReflectionEngineDeps;` 之后（约第 207 行）添加：

```typescript
  /** FeedbackLoops 闭环服务依赖 — 反馈收集器 */
  feedbackCollector?: FeedbackCollectorDeps;
  /** FeedbackLoops 闭环服务依赖 — 记忆助手（自动知识提取） */
  memoryAssistant?: MemoryAssistantDeps;
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/harness/deps.ts
git commit -m "feat(deps): 添加 FeedbackCollectorDeps 和 MemoryAssistantDeps 接口"
```

---

## Task 2: 创建 FeedbackLoops 服务测试

**Files:**

- Create: `tests/unit/harness/loops/FeedbackLoops.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/harness/loops/FeedbackLoops.test.ts`：

```typescript
import { FeedbackLoops } from '../../../../src/harness/loops/FeedbackLoops';
import { LifecycleEvent } from '../../../../src/harness/types';

// Mock EvolutionOrchestrator 单例
const mockRecordInteraction = jest.fn();
jest.mock('../../../../src/evolution/EvolutionOrchestrator', () => ({
  EvolutionOrchestrator: {
    getInstance: () => ({
      recordInteraction: mockRecordInteraction,
    }),
  },
}));

// Mock PreferenceManager 单例
const mockApplyCorrection = jest.fn().mockReturnValue(null);
jest.mock('../../../../src/memory/PreferenceManager', () => ({
  PreferenceManager: {
    getInstance: () => ({
      applyCorrection: mockApplyCorrection,
    }),
  },
}));

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('FeedbackLoops', () => {
  let feedbackLoops: FeedbackLoops;
  let mockFeedbackCollector: any;
  let mockEvolutionEngine: any;
  let mockMemoryAssistant: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFeedbackCollector = {
      analyzeUserInput: jest.fn().mockReturnValue(null),
      recordToolFailure: jest.fn(),
      recordLowQuality: jest.fn(),
    };

    mockEvolutionEngine = {
      collectFeedback: jest.fn(),
    };

    mockMemoryAssistant = {
      autoExtractKnowledge: jest.fn().mockResolvedValue(undefined),
    };

    feedbackLoops = new FeedbackLoops({
      feedbackCollector: mockFeedbackCollector,
      evolutionEngine: mockEvolutionEngine,
      memoryAssistant: mockMemoryAssistant,
    });
  });

  /** 辅助：构造 AFTER_RESPONSE 钩子上下文 */
  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      event: LifecycleEvent.AFTER_RESPONSE,
      metadata: {
        input: '测试输入',
        response: '测试响应',
        quality: { overall: 0.8 },
        traceId: 'test-trace',
        toolsUsed: [],
        userId: 'test-user',
        trace: { trajectory: [], totalDuration: 100 },
        ...overrides,
      },
    };
  }

  /** 辅助：等待 setImmediate 完成 */
  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  describe('createAFTER_RESPONSEHook', () => {
    it('应该返回 proceed=true', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      const result = await hook(makeCtx() as any);
      expect(result.proceed).toBe(true);
    });

    it('应该在高质量交互后记录进化指标', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(
        makeCtx({
          input: '帮我写代码',
          response: '这是代码...',
          quality: { overall: 0.9 },
          traceId: 'trace-2',
          userId: 'user-2',
          trace: {
            trajectory: [
              { type: 'tool_call', toolName: 'code_generate', duration: 500 },
              {
                type: 'tool_result',
                toolName: 'code_generate',
                toolResult: { success: true },
              },
            ],
            totalDuration: 600,
          },
        }) as any
      );
      await flushMicrotasks();

      expect(mockRecordInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-2',
          input: '帮我写代码',
          response: '这是代码...',
          success: true,
          qualityScore: 0.9,
        })
      );
    });

    it('应该在低质量交互时记录低质量反馈', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(
        makeCtx({
          input: '测试',
          response: '不好',
          quality: { overall: 0.3 },
          traceId: 'trace-3',
          userId: 'user-3',
        }) as any
      );
      await flushMicrotasks();

      expect(mockFeedbackCollector.recordLowQuality).toHaveBeenCalledWith(
        '测试',
        '不好',
        0.3,
        'user-3',
        expect.any(String)
      );
    });

    it('应该在工具失败时记录工具失败反馈', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(
        makeCtx({
          input: '读取文件',
          response: '文件读取失败',
          quality: { overall: 0.6 },
          traceId: 'trace-4',
          userId: 'user-4',
          trace: {
            trajectory: [
              { type: 'tool_call', toolName: 'file_read', duration: 100 },
              {
                type: 'tool_result',
                toolName: 'file_read',
                toolResult: { success: false },
              },
            ],
            totalDuration: 200,
          },
        }) as any
      );
      await flushMicrotasks();

      expect(mockFeedbackCollector.recordToolFailure).toHaveBeenCalledWith(
        'file_read',
        '工具执行失败',
        '读取文件',
        'user-4'
      );
    });

    it('应该在用户纠正时触发偏好学习', async () => {
      mockFeedbackCollector.analyzeUserInput.mockReturnValue({
        type: 'correction',
        input: '不对',
        response: '之前的回答',
      });

      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(
        makeCtx({
          input: '不对，应该是另一个',
          response: '之前的回答',
          previousResponse: '之前的回答',
        }) as any
      );

      expect(mockFeedbackCollector.analyzeUserInput).toHaveBeenCalled();
      expect(mockEvolutionEngine.collectFeedback).toHaveBeenCalled();
      expect(mockApplyCorrection).toHaveBeenCalledWith(
        '不对，应该是另一个',
        'general'
      );
    });

    it('应该触发自动知识提取', async () => {
      const hook = feedbackLoops.createAFTER_RESPONSEHook();
      await hook(
        makeCtx({
          input: '学习一下这个',
          response: '好的',
          userId: 'user-6',
        }) as any
      );
      await flushMicrotasks();

      expect(mockMemoryAssistant.autoExtractKnowledge).toHaveBeenCalledWith(
        '学习一下这个',
        '好的',
        'user-6'
      );
    });

    it('应该在没有 memoryAssistant 时不报错', async () => {
      const loops = new FeedbackLoops({
        feedbackCollector: mockFeedbackCollector,
      });
      const hook = loops.createAFTER_RESPONSEHook();
      const result = await hook(makeCtx() as any);
      expect(result.proceed).toBe(true);
    });

    it('应该在没有 evolutionEngine 时不报错', async () => {
      mockFeedbackCollector.analyzeUserInput.mockReturnValue({
        type: 'correction',
      });
      const loops = new FeedbackLoops({
        feedbackCollector: mockFeedbackCollector,
      });
      const hook = loops.createAFTER_RESPONSEHook();
      const result = await hook(makeCtx() as any);
      expect(result.proceed).toBe(true);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败（FeedbackLoops 尚未实现）**

Run: `npx jest tests/unit/harness/loops/FeedbackLoops.test.ts --verbose`
Expected: FAIL with "Cannot find module '../../../../src/harness/loops/FeedbackLoops'"

- [ ] **Step 3: Commit**

```bash
git add tests/unit/harness/loops/FeedbackLoops.test.ts
git commit -m "test(loops): 添加 FeedbackLoops 单元测试（TDD 红灯阶段）"
```

---

## Task 3: 实现 FeedbackLoops 服务

**Files:**

- Create: `src/harness/loops/FeedbackLoops.ts`

- [ ] **Step 1: 创建 FeedbackLoops.ts**

创建 `src/harness/loops/FeedbackLoops.ts`：

```typescript
/**
 * FeedbackLoops — 闭环服务
 *
 * 将 JiabaixingCore 中的内联闭环逻辑提取为独立服务，
 * 通过 AFTER_RESPONSE 钩子触发，与 Core 解耦。
 *
 * 包含 4 个闭环：
 * 1. 进化闭环：质量评分 → EvolutionOrchestrator.recordInteraction
 * 2. 工具失败反馈闭环：工具失败 → FeedbackCollector.recordToolFailure
 * 3. 偏好学习闭环：用户纠正 → PreferenceManager.applyCorrection
 * 4. 自动知识提取：对话 → MemoryAssistant.autoExtractKnowledge
 */

import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { Logger } from '../../utils/Logger';
import type {
  FeedbackCollectorDeps,
  EvolutionEngineDeps,
  MemoryAssistantDeps,
} from '../deps';
import type { HookContext, LifecycleHook } from '../types';
import { LifecycleEvent } from '../types';

/** FeedbackLoops 依赖 */
export interface FeedbackLoopsDeps {
  /** 反馈收集器（必需） */
  feedbackCollector: FeedbackCollectorDeps;
  /** 进化引擎（可选） */
  evolutionEngine?: EvolutionEngineDeps;
  /** 记忆助手（可选，用于自动知识提取） */
  memoryAssistant?: MemoryAssistantDeps;
}

/** AFTER_RESPONSE 钩子 metadata 中期望的数据结构 */
interface AfterResponseMetadata {
  input: string;
  response: string;
  quality: { overall: number };
  traceId: string;
  toolsUsed: string[];
  userId?: string;
  trace?: {
    trajectory: Array<{
      type: string;
      toolName?: string;
      duration?: number;
      toolResult?: { success: boolean };
    }>;
    totalDuration: number;
  };
  previousResponse?: string;
}

export class FeedbackLoops {
  constructor(private deps: FeedbackLoopsDeps) {}

  /**
   * 创建 AFTER_RESPONSE 钩子函数
   * 注册到 ConstraintsService 后，每次响应后自动触发所有闭环
   * @returns LifecycleHook 钩子函数
   */
  createAFTER_RESPONSEHook(): LifecycleHook {
    return async (ctx: HookContext): Promise<{ proceed: true }> => {
      await this.executeLoops(ctx);
      return { proceed: true };
    };
  }

  /**
   * 执行所有闭环
   * 非关键闭环异步执行，不阻塞主流程
   */
  private async executeLoops(ctx: HookContext): Promise<void> {
    const meta = ctx.metadata as unknown as AfterResponseMetadata;

    // 偏好学习闭环 — 同步执行（快速，仅正则匹配）
    try {
      this.runPreferenceLoop(meta);
    } catch (err) {
      Logger.debug(
        `偏好学习闭环失败（非关键）: ${(err as Error).message}`,
        'FeedbackLoops'
      );
    }

    // 进化闭环 + 工具失败反馈 — 异步执行
    setImmediate(() => {
      this.runEvolutionLoop(meta).catch((err) => {
        Logger.debug(
          `进化闭环失败（非关键）: ${(err as Error).message}`,
          'FeedbackLoops'
        );
      });
    });

    // 自动知识提取 — 异步执行
    if (this.deps.memoryAssistant) {
      setImmediate(() => {
        this.deps
          .memoryAssistant!.autoExtractKnowledge(
            meta.input,
            meta.response,
            meta.userId
          )
          .catch(() => {});
      });
    }
  }

  /**
   * 进化闭环：质量评分 → EvolutionOrchestrator + 工具失败反馈
   */
  private async runEvolutionLoop(meta: AfterResponseMetadata): Promise<void> {
    const qualityScore = meta.quality?.overall ?? 0.7;
    const input = meta.input;
    const response = meta.response;
    const userId = meta.userId;
    const scene = this.inferSceneFromInput(input);

    // 从轨迹中提取工具调用详情
    const trajectory = meta.trace?.trajectory || [];
    const toolResults = new Map<string, boolean>();
    for (const s of trajectory) {
      if (s.type === 'tool_result' && s.toolName) {
        toolResults.set(s.toolName, s.toolResult?.success ?? false);
      }
    }
    const toolCalls = trajectory
      .filter((s) => s.type === 'tool_call')
      .map((s) => ({
        toolName: s.toolName || 'unknown',
        success: toolResults.get(s.toolName || '') ?? false,
        executionTime: s.duration || 0,
      }));

    // 记录交互到进化编排器
    try {
      const orchestrator = EvolutionOrchestrator.getInstance();
      orchestrator.recordInteraction({
        traceId: meta.traceId,
        input,
        response,
        success: qualityScore >= 0.5,
        qualityScore,
        executionDuration: meta.trace?.totalDuration ?? 0,
        toolCalls,
        scene,
        userId: userId || 'default',
      });
    } catch (err) {
      Logger.debug(
        `进化编排器记录失败（非关键）: ${(err as Error).message}`,
        'FeedbackLoops'
      );
    }

    // 低质量交互触发反馈收集
    if (qualityScore < 0.5) {
      this.deps.feedbackCollector.recordLowQuality(
        input,
        response,
        qualityScore,
        userId,
        scene
      );
    }

    // 工具失败触发反馈收集
    for (const tc of toolCalls) {
      if (!tc.success) {
        this.deps.feedbackCollector.recordToolFailure(
          tc.toolName,
          '工具执行失败',
          input,
          userId
        );
      }
    }
  }

  /**
   * 偏好学习闭环：用户纠正 → PreferenceManager
   */
  private runPreferenceLoop(meta: AfterResponseMetadata): void {
    const input = meta.input;
    const response = meta.response;
    const userId = meta.userId;
    const previousResponse = meta.previousResponse || '';
    const scene = this.inferSceneFromInput(input);

    // 分析用户输入是否为纠正/重试
    const feedbackRecord = this.deps.feedbackCollector.analyzeUserInput(
      input,
      previousResponse,
      userId,
      scene
    );

    if (feedbackRecord) {
      // 将反馈信号传递给进化引擎
      if (this.deps.evolutionEngine) {
        this.deps.evolutionEngine.collectFeedback(
          input,
          response,
          {
            success: false,
            toolsUsed: [],
            error: `用户反馈: ${feedbackRecord.type}`,
          },
          scene
        );
      }

      // 从纠正中自动学习用户偏好
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PreferenceManager } = require('../../memory/PreferenceManager');
        const pm = PreferenceManager.getInstance();
        const entry = pm.applyCorrection(input, 'general');
        if (entry) {
          Logger.info(
            `⚡ 从用户纠正中提取偏好: ${entry.key}=${entry.value}`,
            'FeedbackLoops'
          );
        }
      } catch {
        // 偏好提取失败不影响主流程
      }
    }
  }

  /**
   * 从输入推断场景类型
   * 迁移自 JiabaixingCore.inferSceneFromInput
   */
  private inferSceneFromInput(input: string): string {
    if (/代码|编程|编译|重构|debug|bug|测试|接口|API|函数|类|模块/.test(input))
      return 'coding';
    if (/文件|目录|文件夹|打开|搜索|查找|读|写|创建|删除/.test(input))
      return 'file_operation';
    if (/桌面|截图|点击|窗口|应用|程序|打开|关闭/.test(input)) return 'desktop';
    if (/记忆|记得|之前|上次|回忆|历史/.test(input)) return 'memory';
    if (/天气|新闻|搜索|查询|什么是|怎么/.test(input)) return 'knowledge';
    if (/提醒|日程|任务|计划|安排/.test(input)) return 'planning';
    if (/你好|嗨|谢谢|再见|早安|晚安/.test(input)) return 'greeting';
    return 'general';
  }
}
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx jest tests/unit/harness/loops/FeedbackLoops.test.ts --verbose`
Expected: PASS (8 tests passed)

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/harness/loops/FeedbackLoops.ts
git commit -m "feat(loops): 实现 FeedbackLoops 闭环服务（TDD 绿灯阶段）"
```

---

## Task 4: 修改 AgentHarness — 传递更多数据 + 注册 FeedbackLoops

**Files:**

- Modify: `src/harness/AgentHarness.ts` (AFTER_RESPONSE 钩子调用 + 初始化注册)

- [ ] **Step 1: 在 AFTER_RESPONSE 钩子调用中增加 userId、trace、previousResponse**

找到 AgentHarness.ts 中 AFTER_RESPONSE 钩子调用处（约第 898 行），修改为：

```typescript
// Step 2: 触发 AFTER_RESPONSE 钩子
await this.executeHook(LifecycleEvent.AFTER_RESPONSE, {
  input: input.text,
  response: result.response,
  quality: result.quality,
  traceId: result.trace.traceId,
  toolsUsed: result.metadata.toolCalls,
  userId: input.userId,
  trace: result.trace,
  previousResponse: input.metadata?.previousResponse,
  metadata: result.metadata,
});
```

- [ ] **Step 2: 在 AgentHarness 初始化末尾注册 FeedbackLoops 钩子**

找到 AgentHarness.ts 的 `_doInitialize` 方法末尾（`this.initialized = true;` 之前），添加：

```typescript
// Phase 7.8: 注册 FeedbackLoops 闭环钩子
if (this.deps?.feedbackCollector && this.constraintsService) {
  const { FeedbackLoops } = require('./loops/FeedbackLoops');
  const feedbackLoops = new FeedbackLoops({
    feedbackCollector: this.deps.feedbackCollector,
    evolutionEngine: this.deps.evolutionEngine,
    memoryAssistant: this.deps.memoryAssistant,
  });
  this.constraintsService.registerHook(
    LifecycleEvent.AFTER_RESPONSE,
    feedbackLoops.createAFTER_RESPONSEHook()
  );
  Logger.info('  🔄 FeedbackLoops 闭环钩子: 已注册', 'AgentHarness');
}

this.initialized = true;
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/harness/AgentHarness.ts
git commit -m "feat(harness): AFTER_RESPONSE 钩子传递 userId/trace/previousResponse + 注册 FeedbackLoops"
```

---

## Task 5: 在 JiabaixingCore 添加 getter + 在 initHarness.ts 注入依赖

**Files:**

- Modify: `src/core/JiabaixingCore.ts` (添加 getMemoryAssistant getter)
- Modify: `src/server/init/initHarness.ts` (在 harnessDeps 中添加 feedbackCollector 和 memoryAssistant)

- [ ] **Step 1: 在 JiabaixingCore 中添加 getMemoryAssistant getter**

在 `src/core/JiabaixingCore.ts` 中找到 `getMemoryEngine` 方法（约第 382 行），在其后添加：

```typescript
  /**
   * 获取记忆助手实例（供 FeedbackLoops 使用）
   */
  public getMemoryAssistant(): MemoryAssistant {
    return this.memoryAssistant;
  }
```

- [ ] **Step 2: 在 initHarness.ts 的 harnessDeps 中添加 feedbackCollector 和 memoryAssistant**

在 `src/server/init/initHarness.ts` 中找到 `harness.setDeps(harnessDeps);`（约第 1053 行），在其**之前**添加：

```typescript
// 注入 FeedbackLoops 依赖
harnessDeps.feedbackCollector = core.feedbackCollector;
harnessDeps.memoryAssistant = {
  autoExtractKnowledge: async (
    input: string,
    response: string,
    userId?: string
  ) => {
    await core
      .getMemoryAssistant()
      .autoExtractKnowledge(input, response, userId);
  },
};
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/core/JiabaixingCore.ts src/server/init/initHarness.ts
git commit -m "feat(core): 添加 getMemoryAssistant getter + 注入 FeedbackLoops 依赖到 harnessDeps"
```

---

## Task 6: 从 JiabaixingCore 移除内联闭环逻辑

**Files:**

- Modify: `src/core/JiabaixingCore.ts:611-733` (processInput 方法中的内联闭环)

- [ ] **Step 1: 在调用 harness 前获取 previousResponse 并传递**

找到 JiabaixingCore.ts 中调用 `this.harness.processInput` 的位置（约第 611 行），修改为：

```typescript
      if (this.harness && this.harness.getConfig().useHarnessLoop) {
        Logger.info('🏗️ V5.0 Harness 统一处理', 'JiabaixingCore');

        // 获取上一个助手消息，供 FeedbackLoops 进行纠正检测
        const previousResponse =
          this.conversationHistoryManager.getPreviousAssistantMessage?.() || '';

        const harnessResult = await this.harness.processInput({
          text: input,
          userId,
          traceId: finalTraceId,
          images,
          metadata: { previousResponse },
        });
```

- [ ] **Step 2: 移除内联闭环逻辑（反馈收集 + 自动知识提取 + 进化记录）**

找到 JiabaixingCore.ts 中从 `// 反馈收集: 分析用户输入是否为纠正/重试` 到 `this.streamResponse(safeResponse, finalTraceId, input);` 之间的所有代码（约第 631-731 行），替换为：

```typescript
// 闭环逻辑已迁移到 FeedbackLoops，通过 AFTER_RESPONSE 钩子自动触发
this.streamResponse(safeResponse, finalTraceId, input);
```

具体要移除的代码块（从 old_string 替换为 new_string）：

old_string:

```
        // 反馈收集: 分析用户输入是否为纠正/重试
        const lastResponse =
          this.conversationHistoryManager.getPreviousAssistantMessage?.() || '';
        const feedbackRecord = this.feedbackCollector.analyzeUserInput(
          input,
          lastResponse,
          userId,
          this.inferSceneFromInput(input)
        );
        if (feedbackRecord) {
          // 将反馈信号传递给进化引擎
          this.evolutionEngine.collectFeedback(input, safeResponse, {
            success: false,
            toolsUsed: [],
            error: `用户反馈: ${feedbackRecord.type}`,
          });

          // Phase 1-2: 偏好提取 — 从纠正中自动学习用户偏好
          try {
            const { PreferenceManager } =
              await import('../memory/PreferenceManager');
            const pm = PreferenceManager.getInstance();
            const entry = pm.applyCorrection(input, 'general');
            if (entry) {
              Logger.info(
                `⚡ 从用户纠正中提取偏好: ${entry.key}=${entry.value}`,
                'JiabaixingCore'
              );
            }
          } catch {
            // 偏好提取失败不影响主流程
          }
        }

        // 自动知识提取
        setImmediate(() => {
          this.memoryAssistant
            .autoExtractKnowledge(input, safeResponse, userId)
            .catch(() => {});
        });

        // 进化记录
        setImmediate(() => {
          try {
            const orchestrator = EvolutionOrchestrator.getInstance();
            // 从轨迹中提取工具调用详情（含真实success状态）
            const trajectory = harnessResult.trace.trajectory || [];
            const toolResults = new Map<string, boolean>();
            for (const s of trajectory) {
              if (s.type === 'tool_result' && s.toolName) {
                toolResults.set(s.toolName, s.toolResult?.success ?? false);
              }
            }
            const toolCalls = trajectory
              .filter((s: { type: string }) => s.type === 'tool_call')
              .map((s: { toolName?: string; duration?: number }) => ({
                toolName: s.toolName || 'unknown',
                success: toolResults.get(s.toolName || '') ?? false,
                executionTime: s.duration || 0,
              }));
            orchestrator.recordInteraction({
              traceId: finalTraceId,
              input,
              response: safeResponse,
              success: qualityScore >= 0.5,
              qualityScore,
              executionDuration: harnessResult.trace.totalDuration,
              toolCalls,
              scene: this.inferSceneFromInput(input),
              userId: userId || 'default',
            });

            // 闭合 Loop B: 低质量交互触发反馈收集
            if (qualityScore < 0.5) {
              this.feedbackCollector.recordLowQuality(
                input,
                safeResponse,
                qualityScore,
                userId,
                this.inferSceneFromInput(input)
              );
            }

            // 闭合 Loop B: 工具失败触发反馈收集
            for (const tc of toolCalls) {
              if (!tc.success) {
                this.feedbackCollector.recordToolFailure(
                  tc.toolName,
                  '工具执行失败',
                  input,
                  userId
                );
              }
            }
          } catch (error) {
            Logger.debug(
              `进化编排器记录失败（非关键）: ${(error as Error).message}`,
              'JiabaixingCore'
            );
          }
        });

        this.streamResponse(safeResponse, finalTraceId, input);
```

new_string:

```
        // 闭环逻辑已迁移到 FeedbackLoops，通过 AFTER_RESPONSE 钩子自动触发
        this.streamResponse(safeResponse, finalTraceId, input);
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/core/JiabaixingCore.ts
git commit -m "refactor(core): 移除内联闭环逻辑，迁移到 FeedbackLoops 钩子触发"
```

---

## Task 7: 端到端验证

**Files:**

- 无新文件，仅运行验证

- [ ] **Step 1: 运行 FeedbackLoops 单元测试**

Run: `npx jest tests/unit/harness/loops/FeedbackLoops.test.ts --verbose`
Expected: PASS (8 tests passed)

- [ ] **Step 2: 运行 AgentHarness 相关测试**

Run: `npx jest tests/unit/harness/ --verbose`
Expected: PASS (无回归)

- [ ] **Step 3: 运行 JiabaixingCore 相关测试**

Run: `npx jest tests/unit/core/ --verbose`
Expected: PASS (无回归)

- [ ] **Step 4: 运行完整测试套件**

Run: `npm test`
Expected: PASS (无回归)

- [ ] **Step 5: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: ESLint 检查**

Run: `npm run lint`
Expected: 0 errors

- [ ] **Step 7: 启动系统验证闭环仍正常工作**

Run: `npm run start`

在 CLI 中输入测试消息，验证：

1. 正常对话能收到响应
2. 输入"不对，应该是..."触发纠正检测
3. 日志中出现 `FeedbackLoops 闭环钩子: 已注册`

- [ ] **Step 8: 最终 Commit（如有修复）**

```bash
git add -A
git commit -m "test(loops): 端到端验证通过，闭环迁移完成"
```

---

## Self-Review

### 1. Spec coverage

| 闭环                                 | 迁移到                          | 验证            |
| ------------------------------------ | ------------------------------- | --------------- |
| 进化闭环（recordInteraction）        | FeedbackLoops.runEvolutionLoop  | Task 2 测试覆盖 |
| 低质量反馈（recordLowQuality）       | FeedbackLoops.runEvolutionLoop  | Task 2 测试覆盖 |
| 工具失败反馈（recordToolFailure）    | FeedbackLoops.runEvolutionLoop  | Task 2 测试覆盖 |
| 偏好学习（applyCorrection）          | FeedbackLoops.runPreferenceLoop | Task 2 测试覆盖 |
| 自动知识提取（autoExtractKnowledge） | FeedbackLoops.executeLoops      | Task 2 测试覆盖 |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码块完整
- 所有测试用例有具体断言

### 3. Type consistency

- `FeedbackLoopsDeps` 在 Task 3 定义，在 Task 4 使用 ✓
- `AfterResponseMetadata` 在 Task 3 定义，与 Task 4 传递的数据字段一致 ✓
- `FeedbackCollectorDeps` 在 Task 1 定义，在 Task 3 使用 ✓
- `MemoryAssistantDeps` 在 Task 1 定义，在 Task 3 和 Task 5 使用 ✓
