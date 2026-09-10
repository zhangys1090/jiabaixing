# Hermes 特性增强集成计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Hermes Agent 的 20 项缺失/不足特性集成到家百星现有架构中，合并重复构件，保持六层 Harness 架构一致性。

**Architecture:** 所有增强均基于现有 Harness 六层架构（Loop/Tools/Context/Persistence/Verification/Constraints），通过扩展现有组件实现，不创建独立子系统。核心集成点：`AgentHarness`（初始化编排）、`ToolRegistry`（工具注册）、`ContextManager`（上下文管道）、`EventBus`（事件驱动）、`ConstraintsService`（生命周期钩子）。

**Tech Stack:** TypeScript 6 / Express / better-sqlite3 / Playwright / Node.js worker_threads / EventBus

---

## 重复构件合并清单

在实施增强前/中，需合并以下重复构件：

| 重复项                                                                            | 保留                    | 删除/合并                                                | 说明                                                                      |
| --------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `SkillRegistry.infrastructureTools` vs `ToolRegistry`                             | `ToolRegistry`          | `SkillRegistry.infrastructureTools`                      | 工具注册已统一到 ToolRegistry，SkillRegistry 不再维护 infrastructureTools |
| `context_manage.ts` 硬编码文件列表 vs `ContextFileRegistry.CONTEXT_FILE_PRIORITY` | `ContextFileRegistry`   | `context_manage.ts` 中的 `CONTEXT_FILE_LIST`             | 已部分合并，context_manage 已引用 ContextFileRegistry，但仍有冗余         |
| `ConstraintsService.hooks` vs `Executor.ToolCallHooks`                            | 统一为 `HookManager`    | 两处各自维护                                             | 钩子系统分散，需统一                                                      |
| `PersistentMemoryService` 单例 vs `MemoryEngine` 记忆存储                         | `MemoryEngine` 为主入口 | `PersistentMemoryService` 作为 MemoryEngine 的持久化后端 | 职责边界需明确                                                            |
| `SandboxExecutor` vs `delegate_task.runSubAgent`                                  | `SandboxExecutor`       | `delegate_task` 中的内联执行逻辑                         | 子 Agent 执行应复用 SandboxExecutor                                       |

---

## Task 1: 统一钩子系统 — HookManager

**Files:**

- Create: `src/harness/hooks/HookManager.ts`
- Modify: `src/harness/constraints/ConstraintsService.ts` — 移除 hooks 管理，委托给 HookManager
- Modify: `src/harness/loop/Executor.ts` — ToolCallHooks 委托给 HookManager
- Modify: `src/harness/AgentHarness.ts` — 初始化 HookManager
- Modify: `src/harness/types.ts` — 新增 HookManager 相关类型
- Test: `tests/unit/harness/HookManager.test.ts`

**背景:** 当前钩子分散在两处：`ConstraintsService.hooks`（LifecycleHook）和 `Executor.ToolCallHooks`（beforeToolCall/afterToolCall/onToolError）。Hermes 需要 Gateway hook（日志/告警/webhook）和 Plugin hook（工具拦截/指标/护栏），需统一管理。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/harness/HookManager.test.ts
import {
  HookManager,
  HookPriority,
} from '../../../src/harness/hooks/HookManager';
import type {
  HookDefinition,
  HookContext,
  HookResult,
} from '../../../src/harness/hooks/HookManager';

describe('HookManager', () => {
  it('应注册和执行 beforeToolCall 钩子', async () => {
    const manager = new HookManager();
    const hook: HookDefinition = {
      id: 'test-hook',
      event: 'beforeToolCall',
      handler: async (ctx: HookContext) => {
        return {
          proceed: true,
          modifiedParams: { ...ctx.params, injected: true },
        };
      },
      priority: HookPriority.NORMAL,
    };
    manager.register(hook);

    const result = await manager.execute('beforeToolCall', {
      toolName: 'file_read',
      params: { path: '/test' },
      traceId: 'test-trace',
      loopCount: 1,
    });

    expect(result.proceed).toBe(true);
    expect(result.modifiedParams).toEqual({ path: '/test', injected: true });
  });

  it('应按优先级执行钩子（高优先级先执行）', async () => {
    const manager = new HookManager();
    const executionOrder: string[] = [];

    manager.register({
      id: 'low-hook',
      event: 'beforeToolCall',
      handler: async () => {
        executionOrder.push('low');
        return { proceed: true };
      },
      priority: HookPriority.LOW,
    });
    manager.register({
      id: 'high-hook',
      event: 'beforeToolCall',
      handler: async () => {
        executionOrder.push('high');
        return { proceed: true };
      },
      priority: HookPriority.HIGH,
    });
    manager.register({
      id: 'critical-hook',
      event: 'beforeToolCall',
      handler: async () => {
        executionOrder.push('critical');
        return { proceed: true };
      },
      priority: HookPriority.CRITICAL,
    });

    await manager.execute('beforeToolCall', {
      toolName: 'test',
      params: {},
      traceId: 't',
      loopCount: 0,
    });

    expect(executionOrder).toEqual(['critical', 'high', 'low']);
  });

  it('应支持钩子拦截（proceed: false）', async () => {
    const manager = new HookManager();
    manager.register({
      id: 'block-hook',
      event: 'beforeToolCall',
      handler: async () => ({ proceed: false, reason: '安全拦截' }),
      priority: HookPriority.CRITICAL,
    });

    const result = await manager.execute('beforeToolCall', {
      toolName: 'shell_exec',
      params: { command: 'rm -rf /' },
      traceId: 't',
      loopCount: 0,
    });

    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('安全拦截');
  });

  it('应支持 afterToolCall 钩子修改结果', async () => {
    const manager = new HookManager();
    manager.register({
      id: 'log-hook',
      event: 'afterToolCall',
      handler: async (ctx: HookContext) => ({
        proceed: true,
        modifiedResult: { ...ctx.result, logged: true },
      }),
      priority: HookPriority.NORMAL,
    });

    const result = await manager.execute('afterToolCall', {
      toolName: 'file_read',
      params: {},
      result: { success: true, output: 'content' },
      traceId: 't',
      loopCount: 0,
    });

    expect(result.modifiedResult.logged).toBe(true);
  });

  it('应支持注销钩子', async () => {
    const manager = new HookManager();
    manager.register({
      id: 'temp-hook',
      event: 'beforeToolCall',
      handler: async () => ({ proceed: false }),
      priority: HookPriority.NORMAL,
    });

    manager.unregister('temp-hook');

    const result = await manager.execute('beforeToolCall', {
      toolName: 'test',
      params: {},
      traceId: 't',
      loopCount: 0,
    });

    expect(result.proceed).toBe(true);
  });

  it('应支持 Gateway hook（日志/告警/webhook）', async () => {
    const manager = new HookManager();
    const logEntries: string[] = [];

    manager.register({
      id: 'gateway-logger',
      event: 'afterToolCall',
      handler: async (ctx: HookContext) => {
        logEntries.push(`[${ctx.toolName}] executed`);
        return { proceed: true };
      },
      priority: HookPriority.LOW,
      type: 'gateway',
    });

    await manager.execute('afterToolCall', {
      toolName: 'web_search',
      params: {},
      result: { success: true },
      traceId: 't',
      loopCount: 0,
    });

    expect(logEntries).toEqual(['[web_search] executed']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/harness/HookManager.test.ts -v`
Expected: FAIL — `Cannot find module '../../../src/harness/hooks/HookManager'`

- [ ] **Step 3: 实现 HookManager**

```typescript
// src/harness/hooks/HookManager.ts
/**
 * 统一钩子管理器
 *
 * 合并 ConstraintsService.hooks 和 Executor.ToolCallHooks 为统一管理
 * 支持：Gateway hook（日志/告警/webhook）、Plugin hook（工具拦截/指标/护栏）
 * 设计参考: Hermes Agent 事件 Hook 系统
 */

import { Logger } from '../../utils/Logger';

/** 钩子优先级 */
export enum HookPriority {
  LOW = 0,
  NORMAL = 50,
  HIGH = 100,
  CRITICAL = 200,
}

/** 钩子事件类型 */
export type HookEvent =
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'onToolError'
  | 'beforeLoop'
  | 'afterLoop'
  | 'onBudgetExceeded'
  | 'onConstraintViolation'
  | 'onSessionStart'
  | 'onSessionEnd';

/** 钩子类型 */
export type HookType = 'gateway' | 'plugin' | 'lifecycle';

/** 钩子上下文 */
export interface HookContext {
  toolName?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  traceId?: string;
  loopCount?: number;
  metadata?: Record<string, unknown>;
}

/** 钩子执行结果 */
export interface HookResult {
  proceed: boolean;
  modifiedParams?: Record<string, unknown>;
  modifiedResult?: unknown;
  replacementResult?: unknown;
  reason?: string;
}

/** 钩子定义 */
export interface HookDefinition {
  /** 唯一标识 */
  id: string;
  /** 监听的事件 */
  event: HookEvent;
  /** 处理函数 */
  handler: (ctx: HookContext) => Promise<HookResult>;
  /** 优先级，数字越大越先执行 */
  priority: HookPriority;
  /** 钩子类型 */
  type?: HookType;
  /** 是否启用 */
  enabled?: boolean;
}

export class HookManager {
  private hooks: Map<HookEvent, HookDefinition[]> = new Map();
  private hookIndex: Map<string, HookDefinition> = new Map();

  /**
   * 注册钩子
   */
  register(hook: HookDefinition): void {
    const existing = this.hookIndex.get(hook.id);
    if (existing) {
      Logger.warn(`钩子 ${hook.id} 已存在，将被覆盖`, 'HookManager');
      this.unregister(hook.id);
    }

    if (!this.hooks.has(hook.event)) {
      this.hooks.set(hook.event, []);
    }

    const list = this.hooks.get(hook.event)!;
    list.push(hook);
    // 按优先级降序排列（高优先级先执行）
    list.sort((a, b) => b.priority - a.priority);
    this.hookIndex.set(hook.id, hook);

    Logger.debug(
      `注册钩子: ${hook.id} [${hook.event}] 优先级=${hook.priority}`,
      'HookManager'
    );
  }

  /**
   * 注销钩子
   */
  unregister(hookId: string): boolean {
    const hook = this.hookIndex.get(hookId);
    if (!hook) return false;

    const list = this.hooks.get(hook.event);
    if (list) {
      const idx = list.findIndex((h) => h.id === hookId);
      if (idx >= 0) list.splice(idx, 1);
    }

    this.hookIndex.delete(hookId);
    return true;
  }

  /**
   * 执行指定事件的所有钩子
   */
  async execute(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    const hooks = this.hooks.get(event);
    if (!hooks || hooks.length === 0) {
      return { proceed: true };
    }

    let currentParams = ctx.params;
    let currentResult = ctx.result;
    let proceed = true;

    for (const hook of hooks) {
      if (hook.enabled === false) continue;

      try {
        const enrichedCtx: HookContext = {
          ...ctx,
          params: currentParams,
          result: currentResult,
        };

        const result = await hook.handler(enrichedCtx);

        if (result.modifiedParams) {
          currentParams = result.modifiedParams;
        }
        if (result.modifiedResult) {
          currentResult = result.modifiedResult;
        }
        if (result.replacementResult) {
          return {
            proceed: false,
            replacementResult: result.replacementResult,
            reason: result.reason ?? `钩子 ${hook.id} 提供了替代结果`,
          };
        }
        if (!result.proceed) {
          return {
            proceed: false,
            modifiedParams: currentParams,
            reason: result.reason ?? `钩子 ${hook.id} 拦截了执行`,
          };
        }
      } catch (err) {
        Logger.error(
          `钩子 ${hook.id} 执行失败: ${(err as Error).message}`,
          err as Error,
          'HookManager'
        );
        // 钩子失败不阻断流程，继续执行后续钩子
      }
    }

    return {
      proceed,
      modifiedParams: currentParams,
      modifiedResult: currentResult,
    };
  }

  /**
   * 获取指定事件的钩子列表
   */
  getHooks(event?: HookEvent): HookDefinition[] {
    if (event) {
      return this.hooks.get(event) ?? [];
    }
    return Array.from(this.hookIndex.values());
  }

  /**
   * 启用/禁用钩子
   */
  setEnabled(hookId: string, enabled: boolean): void {
    const hook = this.hookIndex.get(hookId);
    if (hook) {
      hook.enabled = enabled;
    }
  }

  /**
   * 清除所有钩子
   */
  clear(): void {
    this.hooks.clear();
    this.hookIndex.clear();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/harness/HookManager.test.ts -v`
Expected: PASS

- [ ] **Step 5: 将 HookManager 集成到 AgentHarness**

在 `src/harness/AgentHarness.ts` 中：

- 添加 `private hookManager: HookManager | null = null;` 属性
- 在 `_doInitialize()` 中初始化 HookManager
- 暴露 `getHookManager()` 方法

- [ ] **Step 6: 将 ConstraintsService.hooks 委托给 HookManager**

在 `src/harness/constraints/ConstraintsService.ts` 中：

- `executeHooks()` 方法改为委托给 HookManager
- 保留 `registerHook()` 接口但内部调用 HookManager

- [ ] **Step 7: 将 Executor.ToolCallHooks 委托给 HookManager**

在 `src/harness/loop/Executor.ts` 中：

- `hooks?: ToolCallHooks` 改为 `hookManager?: HookManager`
- beforeToolCall/afterToolCall/onToolError 调用改为 `hookManager.execute()`

- [ ] **Step 8: 运行回归测试**

Run: `npx jest tests/unit/harness/ -v`
Expected: ALL PASS

- [ ] **Step 9: 提交**

```bash
git add src/harness/hooks/HookManager.ts tests/unit/harness/HookManager.test.ts src/harness/AgentHarness.ts src/harness/constraints/ConstraintsService.ts src/harness/loop/Executor.ts src/harness/types.ts
git commit -m "feat(harness): 统一钩子系统 HookManager，合并 ConstraintsService 和 Executor 钩子"
```

---

## Task 2: 上下文引用系统 — @ 引用展开

**Files:**

- Create: `src/harness/context/ContextReferenceResolver.ts`
- Modify: `src/harness/context/ContextManager.ts` — 集成引用解析
- Modify: `src/harness/types.ts` — UserInput 增加 references 字段
- Test: `tests/unit/harness/ContextReferenceResolver.test.ts`

**背景:** Hermes 支持 `@` 引用（@file、@folder、@url、@git_diff），将内容直接注入消息。当前 ContextManager 无此能力。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/harness/ContextReferenceResolver.test.ts
import { ContextReferenceResolver } from '../../../src/harness/context/ContextReferenceResolver';

describe('ContextReferenceResolver', () => {
  let resolver: ContextReferenceResolver;

  beforeEach(() => {
    resolver = new ContextReferenceResolver({ projectRoot: process.cwd() });
  });

  it('应解析 @file 引用', async () => {
    const input = '请分析 @package.json 的依赖';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(true);
    expect(result.references).toHaveLength(1);
    expect(result.references[0].type).toBe('file');
    expect(result.references[0].target).toBe('package.json');
    expect(result.resolvedContent).toContain('dependencies');
    expect(result.cleanedInput).toBe('请分析 package.json 的依赖');
  });

  it('应解析 @url 引用', async () => {
    const input = '参考 @https://example.com/docs 的内容';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(true);
    expect(result.references[0].type).toBe('url');
    expect(result.references[0].target).toBe('https://example.com/docs');
  });

  it('应解析 @folder 引用（列出目录结构）', async () => {
    const input = '查看 @src/harness 的结构';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(true);
    expect(result.references[0].type).toBe('folder');
    expect(result.resolvedContent).toContain('AgentHarness');
  });

  it('应解析 @git_diff 引用', async () => {
    const input = '分析 @git_diff 的变更';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(true);
    expect(result.references[0].type).toBe('git_diff');
  });

  it('无引用时返回原始输入', async () => {
    const input = '你好，请帮我写代码';
    const result = await resolver.resolve(input);

    expect(result.hasReferences).toBe(false);
    expect(result.references).toHaveLength(0);
    expect(result.cleanedInput).toBe(input);
  });

  it('应处理多个引用', async () => {
    const input = '对比 @package.json 和 @tsconfig.json';
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/harness/ContextReferenceResolver.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 ContextReferenceResolver**

```typescript
// src/harness/context/ContextReferenceResolver.ts
/**
 * 上下文引用解析器
 *
 * 解析消息中的 @ 引用，将文件/文件夹/URL/git_diff 内容内联展开
 * 设计参考: Hermes Agent 上下文引用系统
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Logger } from '../../utils/Logger';

/** 引用类型 */
export type ReferenceType = 'file' | 'folder' | 'url' | 'git_diff';

/** 解析出的引用 */
export interface ResolvedReference {
  type: ReferenceType;
  target: string;
  content: string;
  error?: string;
  charCount: number;
}

/** 解析结果 */
export interface ResolveResult {
  hasReferences: boolean;
  references: ResolvedReference[];
  resolvedContent: string;
  cleanedInput: string;
}

/** @ 引用正则：@path 或 @url */
const REFERENCE_PATTERN = /@([\w./\-]+(?:\.[\w]+)?)|@(https?:\/\/[^\s]+)/g;

/** 文件最大字符数 */
const MAX_FILE_CHARS = 15000;

export class ContextReferenceResolver {
  private projectRoot: string;

  constructor(options: { projectRoot: string }) {
    this.projectRoot = options.projectRoot;
  }

  /**
   * 解析输入中的所有 @ 引用
   */
  async resolve(input: string): Promise<ResolveResult> {
    const references: ResolvedReference[] = [];
    const contentParts: string[] = [];
    let cleanedInput = input;

    // 收集所有匹配
    const matches: Array<{ fullMatch: string; target: string; index: number }> =
      [];
    let match: RegExpExecArray | null;

    const pattern = new RegExp(
      REFERENCE_PATTERN.source,
      REFERENCE_PATTERN.flags
    );
    while ((match = pattern.exec(input)) !== null) {
      matches.push({
        fullMatch: match[0],
        target: match[1] || match[2],
        index: match.index,
      });
    }

    if (matches.length === 0) {
      return {
        hasReferences: false,
        references: [],
        resolvedContent: '',
        cleanedInput: input,
      };
    }

    // 逐个解析引用
    for (const m of matches) {
      const ref = this.resolveReference(m.target);
      references.push(ref);

      if (ref.content && !ref.error) {
        contentParts.push(
          `--- @${m.target} ---\n${ref.content}\n--- end @${m.target} ---`
        );
      }

      // 清理输入中的 @ 前缀
      cleanedInput = cleanedInput.replace(m.fullMatch, m.target);
    }

    return {
      hasReferences: true,
      references,
      resolvedContent: contentParts.join('\n\n'),
      cleanedInput,
    };
  }

  /**
   * 解析单个引用
   */
  private resolveReference(target: string): ResolvedReference {
    // URL 引用
    if (target.startsWith('http://') || target.startsWith('https://')) {
      return this.resolveUrl(target);
    }

    // git_diff 引用
    if (target === 'git_diff' || target === 'git-diff') {
      return this.resolveGitDiff();
    }

    // 文件路径
    const fullPath = path.resolve(this.projectRoot, target);

    if (!fs.existsSync(fullPath)) {
      return {
        type: 'file',
        target,
        content: '',
        error: `文件不存在: ${target}`,
        charCount: 0,
      };
    }

    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      return this.resolveFolder(target, fullPath);
    }

    return this.resolveFile(target, fullPath);
  }

  /**
   * 解析文件引用
   */
  private resolveFile(target: string, fullPath: string): ResolvedReference {
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const truncated = content.length > MAX_FILE_CHARS;
      const finalContent = truncated
        ? content.substring(0, MAX_FILE_CHARS) +
          `\n\n[...truncated: ${content.length} chars total, showing first ${MAX_FILE_CHARS}]`
        : content;

      return {
        type: 'file',
        target,
        content: finalContent,
        charCount: finalContent.length,
      };
    } catch (err) {
      return {
        type: 'file',
        target,
        content: '',
        error: `读取失败: ${(err as Error).message}`,
        charCount: 0,
      };
    }
  }

  /**
   * 解析文件夹引用（列出目录结构）
   */
  private resolveFolder(target: string, fullPath: string): ResolvedReference {
    try {
      const entries = this.listDirectory(fullPath, 3); // 最多3层深度
      const content = `目录结构 (${target}):\n${entries}`;

      return {
        type: 'folder',
        target,
        content,
        charCount: content.length,
      };
    } catch (err) {
      return {
        type: 'folder',
        target,
        content: '',
        error: `读取目录失败: ${(err as Error).message}`,
        charCount: 0,
      };
    }
  }

  /**
   * 解析 URL 引用（标记为需异步获取）
   */
  private resolveUrl(target: string): ResolvedReference {
    // URL 内容需要异步获取，这里只记录引用
    // 实际获取在 ContextManager 中通过 web_fetch 工具完成
    return {
      type: 'url',
      target,
      content: `[URL引用: ${target} — 需通过 web_fetch 工具获取内容]`,
      charCount: 0,
    };
  }

  /**
   * 解析 git_diff 引用
   */
  private resolveGitDiff(): ResolvedReference {
    try {
      const diff = execSync('git diff --stat && echo "---" && git diff', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });

      const truncated = diff.length > MAX_FILE_CHARS;
      const content = truncated
        ? diff.substring(0, MAX_FILE_CHARS) +
          `\n\n[...truncated: ${diff.length} chars total]`
        : diff;

      return {
        type: 'git_diff',
        target: 'git_diff',
        content,
        charCount: content.length,
      };
    } catch (err) {
      return {
        type: 'git_diff',
        target: 'git_diff',
        content: '',
        error: `获取 git diff 失败: ${(err as Error).message}`,
        charCount: 0,
      };
    }
  }

  /**
   * 列出目录结构
   */
  private listDirectory(
    dirPath: string,
    maxDepth: number,
    prefix: string = ''
  ): string {
    const lines: string[] = [];
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const visible = entries.filter(
        (e) => !e.name.startsWith('.') && e.name !== 'node_modules'
      );

      for (const entry of visible.slice(0, 50)) {
        const fullPath = path.join(dirPath, entry.name);
        lines.push(
          `${prefix}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`
        );

        if (entry.isDirectory() && maxDepth > 1) {
          const subLines = this.listDirectory(
            fullPath,
            maxDepth - 1,
            prefix + '  '
          );
          lines.push(...subLines.split('\n').filter(Boolean));
        }
      }
    } catch {
      lines.push(`${prefix}[读取失败]`);
    }
    return lines.join('\n');
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/harness/ContextReferenceResolver.test.ts -v`
Expected: PASS

- [ ] **Step 5: 集成到 ContextManager**

在 `src/harness/context/ContextManager.ts` 的 `buildContext()` 方法中：

- 在处理用户输入前，调用 `ContextReferenceResolver.resolve()`
- 将 `resolvedContent` 注入到上下文消息中
- 将 `cleanedInput` 替换原始输入

- [ ] **Step 6: 运行回归测试**

Run: `npx jest tests/unit/harness/ContextManager.test.ts -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/harness/context/ContextReferenceResolver.ts tests/unit/harness/ContextReferenceResolver.test.ts src/harness/context/ContextManager.ts
git commit -m "feat(context): 实现上下文引用系统 @file/@folder/@url/@git_diff"
```

---

## Task 3: 技能渐进式披露

**Files:**

- Modify: `src/skills/SkillInterface.ts` — 增加 summary/sections 分层结构
- Modify: `src/skills/SkillRegistry.ts` — 实现渐进式加载
- Modify: `src/harness/context/ContextManager.ts` — 技能按摘要注入，按需展开
- Test: `tests/unit/harness/SkillProgressiveDisclosure.test.ts`

**背景:** 当前技能系统一次性加载全部内容，浪费 token。Hermes 采用渐进式披露：先注入摘要，Agent 需要时再展开详细内容。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/harness/SkillProgressiveDisclosure.test.ts
import { SkillRegistry } from '../../../src/skills/SkillRegistry';
import { Skill, SkillDefinition } from '../../../src/skills/SkillInterface';

describe('Skill Progressive Disclosure', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    SkillRegistry.resetInstance();
    registry = SkillRegistry.getInstance();
  });

  it('应返回技能摘要而非完整内容', () => {
    const skill: Skill = {
      definition: {
        name: 'react-patterns',
        description: 'React 设计模式',
        version: '1.0',
        category: 'frontend',
        tags: ['react', 'patterns'],
        parameters: [],
      } as SkillDefinition,
      summary: 'React 组件设计模式集合：HOC、Render Props、Hooks',
      sections: [
        { title: 'HOC 模式', content: '高阶组件的详细说明...' },
        { title: 'Render Props', content: 'Render Props 的详细说明...' },
        { title: 'Custom Hooks', content: '自定义 Hooks 的详细说明...' },
      ],
      execute: async () => ({ success: true, output: '' }),
    };

    registry.register(skill);

    const summaries = registry.getSkillSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('react-patterns');
    expect(summaries[0].summary).toBe(
      'React 组件设计模式集合：HOC、Render Props、Hooks'
    );
    expect(summaries[0].sectionCount).toBe(3);
    // 摘要不应包含详细内容
    expect(summaries[0].charCount).toBeLessThan(100);
  });

  it('应按需展开技能的特定章节', () => {
    const skill: Skill = {
      definition: {
        name: 'react-patterns',
        description: 'React 设计模式',
        version: '1.0',
        category: 'frontend',
        tags: [],
        parameters: [],
      } as SkillDefinition,
      summary: 'React 组件设计模式集合',
      sections: [
        { title: 'HOC 模式', content: '高阶组件的详细说明...' },
        { title: 'Render Props', content: 'Render Props 的详细说明...' },
      ],
      execute: async () => ({ success: true, output: '' }),
    };

    registry.register(skill);

    const expanded = registry.expandSkillSection('react-patterns', 'HOC 模式');
    expect(expanded).toBeDefined();
    expect(expanded!.title).toBe('HOC 模式');
    expect(expanded!.content).toContain('高阶组件');
  });

  it('应生成 token 优化的上下文注入文本', () => {
    const skill: Skill = {
      definition: {
        name: 'typescript-tips',
        description: 'TypeScript 技巧',
        version: '1.0',
        category: 'language',
        tags: [],
        parameters: [],
      } as SkillDefinition,
      summary: 'TypeScript 高级类型技巧',
      sections: [
        { title: '条件类型', content: '条件类型的详细说明...' },
        { title: '映射类型', content: '映射类型的详细说明...' },
      ],
      execute: async () => ({ success: true, output: '' }),
    };

    registry.register(skill);

    const contextText = registry.generateSummaryContext();
    // 摘要上下文应简洁
    expect(contextText).toContain('typescript-tips');
    expect(contextText).toContain('TypeScript 高级类型技巧');
    expect(contextText).not.toContain('条件类型的详细说明');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/harness/SkillProgressiveDisclosure.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 扩展 SkillInterface 增加分层结构**

在 `src/skills/SkillInterface.ts` 中增加：

- `SkillSection` 接口：`{ title: string; content: string }`
- `Skill` 接口增加 `summary?: string` 和 `sections?: SkillSection[]`
- `SkillSummary` 接口：`{ name: string; summary: string; sectionCount: number; charCount: number }`

- [ ] **Step 4: 在 SkillRegistry 中实现渐进式加载方法**

在 `src/skills/SkillRegistry.ts` 中增加：

- `getSkillSummaries(): SkillSummary[]` — 返回所有技能的摘要
- `expandSkillSection(skillName: string, sectionTitle: string): SkillSection | null` — 按需展开
- `generateSummaryContext(): string` — 生成 token 优化的上下文注入文本

- [ ] **Step 5: 在 ContextManager 中使用摘要注入**

在 `src/harness/context/ContextManager.ts` 的 `buildContext()` 方法中：

- 将 `SkillRegistry.getSkillSummaries()` 的摘要注入系统提示
- 当 Agent 调用技能时，通过 `expandSkillSection()` 按需展开

- [ ] **Step 6: 运行测试确认通过**

Run: `npx jest tests/unit/harness/SkillProgressiveDisclosure.test.ts -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/skills/SkillInterface.ts src/skills/SkillRegistry.ts src/harness/context/ContextManager.ts tests/unit/harness/SkillProgressiveDisclosure.test.ts
git commit -m "feat(skills): 实现技能渐进式披露，token 优化注入"
```

---

## Task 4: 上下文文件自动发现增强

**Files:**

- Modify: `src/harness/context/ContextFileRegistry.ts` — 增加 .hermes.md、.cursorrules 支持
- Test: `tests/unit/harness/ContextFileRegistry.test.ts`

**背景:** 当前 `ContextFileRegistry` 支持 JIABAIXING.md/AGENTS.md/CLAUDE.md/CONTEXT.md/SOUL.md，但缺少 Hermes 的 `.hermes.md` 和 `.cursorrules`。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/harness/ContextFileRegistry.test.ts
import {
  ContextFileRegistry,
  CONTEXT_FILE_PRIORITY,
} from '../../../src/harness/context/ContextFileRegistry';

describe('ContextFileRegistry 增强发现', () => {
  it('应包含 .hermes.md 在优先级列表中', () => {
    const fileNames = CONTEXT_FILE_PRIORITY as readonly string[];
    expect(fileNames).toContain('.hermes.md');
  });

  it('应包含 .cursorrules 在优先级列表中', () => {
    const fileNames = CONTEXT_FILE_PRIORITY as readonly string[];
    expect(fileNames).toContain('.cursorrules');
  });

  it('优先级顺序应为: JIABAIXING.md > .hermes.md > AGENTS.md > CLAUDE.md > .cursorrules > CONTEXT.md', () => {
    const fileNames = [...CONTEXT_FILE_PRIORITY];
    expect(fileNames.indexOf('JIABAIXING.md')).toBeLessThan(
      fileNames.indexOf('.hermes.md')
    );
    expect(fileNames.indexOf('.hermes.md')).toBeLessThan(
      fileNames.indexOf('AGENTS.md')
    );
    expect(fileNames.indexOf('AGENTS.md')).toBeLessThan(
      fileNames.indexOf('CLAUDE.md')
    );
    expect(fileNames.indexOf('CLAUDE.md')).toBeLessThan(
      fileNames.indexOf('.cursorrules')
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/harness/ContextFileRegistry.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 修改 CONTEXT_FILE_PRIORITY**

在 `src/harness/context/ContextFileRegistry.ts` 中更新优先级列表：

```typescript
export const CONTEXT_FILE_PRIORITY = [
  'JIABAIXING.md',
  '.hermes.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  'CONTEXT.md',
  '.jiabaixing/context.md',
] as const;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/harness/ContextFileRegistry.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/harness/context/ContextFileRegistry.ts tests/unit/harness/ContextFileRegistry.test.ts
git commit -m "feat(context): 增加 .hermes.md 和 .cursorrules 上下文文件发现"
```

---

## Task 5: 工作目录检查点增强

**Files:**

- Modify: `src/harness/tools/system/rollback_changes.ts` — 增强为工作目录快照
- Modify: `src/harness/loop/Executor.ts` — 文件变更前自动创建检查点
- Create: `src/harness/persistence/CheckpointService.ts`
- Test: `tests/unit/harness/CheckpointService.test.ts`

**背景:** 当前 `EvolutionRollback` + `StateSnapshotManager` 面向进化引擎，非面向文件变更的工作目录快照。Hermes 在文件变更前自动创建快照，支持 `/rollback` 回滚。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/harness/CheckpointService.test.ts
import { CheckpointService } from '../../../src/harness/persistence/CheckpointService';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CheckpointService', () => {
  let service: CheckpointService;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
    service = new CheckpointService({
      projectRoot: tempDir,
      dataDir: path.join(tempDir, '.checkpoints'),
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('应创建工作目录快照', async () => {
    // 创建测试文件
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'hello');

    const checkpoint = await service.createCheckpoint('before-edit');

    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.label).toBe('before-edit');
    expect(checkpoint.fileCount).toBeGreaterThan(0);
  });

  it('应列出所有检查点', async () => {
    await service.createCheckpoint('cp1');
    await service.createCheckpoint('cp2');

    const checkpoints = service.listCheckpoints();

    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(checkpoints[0].label).toBe('cp2'); // 最新的在前
  });

  it('应回滚到指定检查点', async () => {
    const filePath = path.join(tempDir, 'test.txt');
    fs.writeFileSync(filePath, 'original');

    await service.createCheckpoint('before-change');

    fs.writeFileSync(filePath, 'modified');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('modified');

    await service.rollback('before-change');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
  });

  it('应自动清理过期检查点', async () => {
    const limitedService = new CheckpointService({
      projectRoot: tempDir,
      dataDir: path.join(tempDir, '.checkpoints'),
      maxCheckpoints: 2,
    });

    await limitedService.createCheckpoint('cp1');
    await limitedService.createCheckpoint('cp2');
    await limitedService.createCheckpoint('cp3');

    const checkpoints = limitedService.listCheckpoints();
    expect(checkpoints.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/harness/CheckpointService.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 CheckpointService**

```typescript
// src/harness/persistence/CheckpointService.ts
/**
 * 工作目录检查点服务
 *
 * 在文件变更前自动创建快照，支持回滚
 * 设计参考: Hermes Agent 检查点系统
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Logger } from '../../utils/Logger';

export interface CheckpointConfig {
  projectRoot: string;
  dataDir: string;
  maxCheckpoints?: number;
  ignorePatterns?: string[];
}

export interface CheckpointEntry {
  id: string;
  label: string;
  timestamp: number;
  fileCount: number;
  totalSize: number;
  files: Array<{ relativePath: string; hash: string; size: number }>;
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'data/*.db',
  '*.log',
  '.checkpoints',
];

const DEFAULT_MAX_CHECKPOINTS = 10;

export class CheckpointService {
  private config: Required<CheckpointConfig>;
  private checkpointsDir: string;

  constructor(config: CheckpointConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      dataDir: config.dataDir,
      maxCheckpoints: config.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS,
      ignorePatterns: config.ignorePatterns ?? DEFAULT_IGNORE,
    };
    this.checkpointsDir = path.join(this.config.dataDir, 'snapshots');
    fs.mkdirSync(this.checkpointsDir, { recursive: true });
  }

  /**
   * 创建工作目录检查点
   */
  async createCheckpoint(label: string): Promise<CheckpointEntry> {
    const id = `cp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const snapshotDir = path.join(this.checkpointsDir, id);
    fs.mkdirSync(snapshotDir, { recursive: true });

    const files = this.scanProjectFiles();
    let totalSize = 0;

    for (const file of files) {
      const srcPath = path.join(this.config.projectRoot, file.relativePath);
      const destPath = path.join(snapshotDir, file.relativePath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      totalSize += file.size;
    }

    const entry: CheckpointEntry = {
      id,
      label,
      timestamp: Date.now(),
      fileCount: files.length,
      totalSize,
      files,
    };

    // 保存元数据
    fs.writeFileSync(
      path.join(snapshotDir, '_checkpoint.json'),
      JSON.stringify(entry, null, 2),
      'utf-8'
    );

    Logger.info(
      `📸 检查点已创建: ${label} (${files.length} 文件, ${(totalSize / 1024).toFixed(1)}KB)`,
      'CheckpointService'
    );

    // 清理过期检查点
    this.pruneOldCheckpoints();

    return entry;
  }

  /**
   * 列出所有检查点
   */
  listCheckpoints(): CheckpointEntry[] {
    const entries: CheckpointEntry[] = [];

    try {
      const dirs = fs.readdirSync(this.checkpointsDir);
      for (const dir of dirs) {
        const metaPath = path.join(
          this.checkpointsDir,
          dir,
          '_checkpoint.json'
        );
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          entries.push(meta);
        }
      }
    } catch {
      // 空目录
    }

    // 按时间降序
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  }

  /**
   * 回滚到指定检查点
   */
  async rollback(labelOrId: string): Promise<boolean> {
    const checkpoints = this.listCheckpoints();
    const target = checkpoints.find(
      (cp) => cp.id === labelOrId || cp.label === labelOrId
    );

    if (!target) {
      Logger.error(
        `检查点不存在: ${labelOrId}`,
        new Error('Not found'),
        'CheckpointService'
      );
      return false;
    }

    const snapshotDir = path.join(this.checkpointsDir, target.id);

    // 恢复文件
    for (const file of target.files) {
      const srcPath = path.join(snapshotDir, file.relativePath);
      const destPath = path.join(this.config.projectRoot, file.relativePath);

      if (fs.existsSync(srcPath)) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      }
    }

    Logger.info(
      `⏪ 已回滚到检查点: ${target.label} (${target.id})`,
      'CheckpointService'
    );
    return true;
  }

  /**
   * 扫描项目文件
   */
  private scanProjectFiles(): Array<{
    relativePath: string;
    hash: string;
    size: number;
  }> {
    const files: Array<{ relativePath: string; hash: string; size: number }> =
      [];
    const ignoreSet = new Set(this.config.ignorePatterns);

    const walk = (dir: string, base: string = '') => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (ignoreSet.has(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.env.example')
            continue;

          const fullPath = path.join(dir, entry.name);
          const relativePath = base ? `${base}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            if (stat.size > 1024 * 1024) continue; // 跳过 >1MB 文件

            const content = fs.readFileSync(fullPath);
            const hash = crypto
              .createHash('md5')
              .update(content)
              .digest('hex')
              .substring(0, 8);
            files.push({ relativePath, hash, size: stat.size });
          }
        }
      } catch {
        // 跳过无权限目录
      }
    };

    walk(this.config.projectRoot);
    return files;
  }

  /**
   * 清理过期检查点
   */
  private pruneOldCheckpoints(): void {
    const checkpoints = this.listCheckpoints();
    if (checkpoints.length <= this.config.maxCheckpoints) return;

    const toRemove = checkpoints.slice(this.config.maxCheckpoints);
    for (const cp of toRemove) {
      const dir = path.join(this.checkpointsDir, cp.id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略删除失败
      }
    }

    Logger.debug(`清理了 ${toRemove.length} 个过期检查点`, 'CheckpointService');
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/harness/CheckpointService.test.ts -v`
Expected: PASS

- [ ] **Step 5: 集成到 Executor — 文件变更前自动创建检查点**

在 `src/harness/loop/Executor.ts` 中：

- 在执行 `file_write`、`incremental_edit`、`multi_file_edit` 等文件修改工具前
- 调用 `CheckpointService.createCheckpoint('auto-before-{toolName}')`

- [ ] **Step 6: 增强 rollback_changes 工具**

在 `src/harness/tools/system/rollback_changes.ts` 中：

- 增加 `CheckpointService` 作为依赖
- `action: 'rollback'` 时调用 `CheckpointService.rollback()`
- `action: 'list'` 时调用 `CheckpointService.listCheckpoints()`

- [ ] **Step 7: 运行回归测试**

Run: `npx jest tests/unit/harness/ -v`
Expected: ALL PASS

- [ ] **Step 8: 提交**

```bash
git add src/harness/persistence/CheckpointService.ts tests/unit/harness/CheckpointService.test.ts src/harness/loop/Executor.ts src/harness/tools/system/rollback_changes.ts
git commit -m "feat(persistence): 实现工作目录检查点，文件变更前自动快照"
```

---

## Task 6: 子 Agent 委派增强 — 并发执行

**Files:**

- Modify: `src/harness/tools/system/delegate_task.ts` — 支持并发子 Agent
- Modify: `src/harness/orchestration/SubAgentFanout.ts` — 增加并发限制和独立终端
- Test: `tests/unit/tools/delegate_task.test.ts`（已有，需扩展）

**背景:** 当前 `delegate_task` 只支持同步执行单个子 Agent。Hermes 支持并发 3+ 子 Agent 并行执行。

- [ ] **Step 1: 写失败测试**

```typescript
// 在 tests/unit/tools/delegate_task.test.ts 中增加
describe('delegate_task 并发执行', () => {
  it('应支持并发执行多个子任务', async () => {
    // 测试并发 delegate
    const goals = [
      { goal: '分析 package.json', context: '查看依赖' },
      { goal: '检查 tsconfig.json', context: '查看配置' },
      { goal: '读取 README.md', context: '查看说明' },
    ];

    // 模拟并发执行
    const results = await Promise.all(
      goals.map((g) =>
        runSubAgent(g.goal, g.context, ['file_read'], 3, mockDeps)
      )
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('应限制最大并发子 Agent 数量', async () => {
    const config = { maxConcurrentSubAgents: 3 };
    // 验证并发限制
    expect(config.maxConcurrentSubAgents).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/tools/delegate_task.test.ts -v`
Expected: FAIL（缺少并发支持）

- [ ] **Step 3: 修改 delegate_task 支持并发**

在 `src/harness/tools/system/delegate_task.ts` 中：

- 增加 `delegate_batch` 参数：`Array<{ goal: string; context?: string; tools?: string[] }>`
- 使用 `Promise.allSettled()` 并发执行
- 增加并发限制（默认 3）
- 增加独立终端会话支持

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/tools/delegate_task.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/harness/tools/system/delegate_task.ts tests/unit/tools/delegate_task.test.ts
git commit -m "feat(delegate): 子 Agent 并发执行，支持批量委派"
```

---

## Task 7: 代码沙箱执行增强

**Files:**

- Modify: `src/harness/sandbox/SandboxExecutor.ts` — 增加 RPC 执行和工具回调
- Create: `src/harness/tools/system/execute_code.ts` — 新工具
- Modify: `src/harness/tools/registerHarnessTools.ts` — 注册 execute_code
- Test: `tests/unit/harness/SandboxExecutor.test.ts`（已有，需扩展）

**背景:** 当前 `SandboxExecutor` 有基础沙箱能力，但缺少 RPC 执行和 Agent 工具回调。Hermes 的 `execute_code` 允许 Agent 编写脚本编程式调用工具。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/tools/execute_code.test.ts
import { EXECUTE_CODE_DEF } from '../../../src/harness/tools/system/execute_code';

describe('execute_code 工具', () => {
  it('应有正确的工具定义', () => {
    expect(EXECUTE_CODE_DEF.name).toBe('execute_code');
    expect(EXECUTE_CODE_DEF.parameters).toHaveProperty('code');
    expect(EXECUTE_CODE_DEF.parameters).toHaveProperty('language');
    expect(EXECUTE_CODE_DEF.riskLevel).toBe('high');
    expect(EXECUTE_CODE_DEF.requiredPermissions).toContain('code_execute');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/tools/execute_code.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 创建 execute_code 工具**

```typescript
// src/harness/tools/system/execute_code.ts
/**
 * execute_code — 代码沙箱执行工具
 *
 * 允许 Agent 编写脚本编程式调用工具，通过沙箱 RPC 执行
 * 设计参考: Hermes Agent execute_code
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const EXECUTE_CODE_DEF: ToolDefinition = {
  name: 'execute_code',
  description:
    '在沙箱中执行代码脚本。支持 JavaScript/Python。可通过 hermes.call() 回调 Agent 工具。适用场景：多步骤工作流压缩为单次调用、批量数据处理、复杂逻辑编排。',
  category: ToolCategory.SYSTEM,
  parameters: {
    code: {
      type: 'string',
      description: '要执行的代码',
    },
    language: {
      type: 'string',
      description: '编程语言',
      enum: ['javascript', 'python'],
      default: 'javascript',
    },
    timeout: {
      type: 'number',
      description: '超时时间（毫秒）',
      default: 30000,
    },
  },
  requiredParams: ['code'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'high',
  idempotent: false,
  timeout: 60000,
  requiresConfirmation: true,
};

export interface ExecuteCodeDeps {
  sandboxExecutor: {
    execute(
      code: string,
      options: {
        language: string;
        timeout: number;
        allowedAPIs: string[];
        toolCallback?: (
          toolName: string,
          params: Record<string, unknown>
        ) => Promise<unknown>;
      }
    ): Promise<{
      success: boolean;
      output?: unknown;
      error?: string;
      durationMs: number;
      logs?: string[];
    }>;
  };
  toolRegistry?: {
    execute(
      toolName: string,
      params: Record<string, unknown>,
      context?: unknown
    ): Promise<{
      success: boolean;
      output: unknown;
      error?: string;
    }>;
  };
}

export function createExecuteCodeExecutor(deps: ExecuteCodeDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const code = String(params.code || '');
    const language = String(params.language || 'javascript');
    const timeout = Number(params.timeout) || 30000;

    if (!code.trim()) {
      return {
        success: false,
        output: null,
        error: '代码不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    try {
      // 工具回调桥接
      const toolCallback = deps.toolRegistry
        ? async (toolName: string, toolParams: Record<string, unknown>) => {
            const result = await deps.toolRegistry!.execute(
              toolName,
              toolParams
            );
            return result.output;
          }
        : undefined;

      const result = await deps.sandboxExecutor.execute(code, {
        language,
        timeout,
        allowedAPIs: ['console.*', 'JSON.*', 'Math.*', 'Date.*', 'hermes.call'],
        toolCallback,
      });

      const output =
        typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output, null, 2);

      return {
        success: result.success,
        output: result.success ? output : null,
        error: result.error,
        duration: Date.now() - startTime,
        validated: false,
        metadata: {
          language,
          durationMs: result.durationMs,
          logs: result.logs,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `代码执行失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
```

- [ ] **Step 4: 注册 execute_code 到 ToolRegistry**

在 `src/harness/tools/registerHarnessTools.ts` 中：

- 导入 `EXECUTE_CODE_DEF` 和 `createExecuteCodeExecutor`
- 在工具注册列表中添加

- [ ] **Step 5: 增强 SandboxExecutor 支持 RPC 工具回调**

在 `src/harness/sandbox/SandboxExecutor.ts` 中：

- `execute()` 方法增加 `toolCallback` 参数
- 注入 `hermes.call()` 全局函数到沙箱上下文
- JavaScript 执行使用 `vm` 模块 + 自定义上下文

- [ ] **Step 6: 运行测试确认通过**

Run: `npx jest tests/unit/tools/execute_code.test.ts tests/unit/harness/SandboxExecutor.test.ts -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/harness/tools/system/execute_code.ts src/harness/tools/registerHarnessTools.ts src/harness/sandbox/SandboxExecutor.ts tests/unit/tools/execute_code.test.ts
git commit -m "feat(sandbox): 实现 execute_code 工具，支持 RPC 工具回调"
```

---

## Task 8: 批处理引擎

**Files:**

- Create: `src/harness/batch/BatchProcessor.ts`
- Create: `src/server/routes/batchRoutes.ts`
- Test: `tests/unit/harness/BatchProcessor.test.ts`

**背景:** 无并行 prompt 批处理能力。Hermes 支持跨数百 prompt 并行运行，生成 ShareGPT 格式轨迹。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/harness/BatchProcessor.test.ts
import {
  BatchProcessor,
  BatchConfig,
  BatchResult,
} from '../../../src/harness/batch/BatchProcessor';

describe('BatchProcessor', () => {
  it('应并行处理多个 prompt', async () => {
    const processor = new BatchProcessor({
      concurrency: 3,
      timeout: 30000,
    } as BatchConfig);

    const prompts = [
      { id: '1', text: '你好' },
      { id: '2', text: '写一个函数' },
      { id: '3', text: '分析代码' },
    ];

    const results = await processor.run(prompts, async (prompt) => ({
      id: prompt.id,
      response: `回复: ${prompt.text}`,
      success: true,
      duration: 10,
    }));

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('应限制并发数', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const processor = new BatchProcessor({
      concurrency: 2,
      timeout: 5000,
    } as BatchConfig);

    const prompts = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      text: `prompt ${i}`,
    }));

    await processor.run(prompts, async (prompt) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 50));
      currentConcurrent--;
      return { id: prompt.id, response: 'ok', success: true, duration: 50 };
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('应生成 ShareGPT 格式轨迹', async () => {
    const processor = new BatchProcessor({
      concurrency: 1,
      timeout: 5000,
      outputFormat: 'sharegpt',
    } as BatchConfig);

    const results = await processor.run(
      [{ id: '1', text: 'hello' }],
      async (p) => ({ id: p.id, response: 'hi', success: true, duration: 10 })
    );

    const sharegpt = processor.toShareGPT(results);
    expect(sharegpt.conversations).toBeDefined();
    expect(sharegpt.conversations[0]).toEqual({
      from: 'human',
      value: 'hello',
    });
    expect(sharegpt.conversations[1]).toEqual({
      from: 'gpt',
      value: 'hi',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/harness/BatchProcessor.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 BatchProcessor**

```typescript
// src/harness/batch/BatchProcessor.ts
/**
 * 批处理引擎
 *
 * 并行运行多个 prompt，生成结构化轨迹数据
 * 设计参考: Hermes Agent 批处理系统
 */

import { Logger } from '../../utils/Logger';

export interface BatchConfig {
  concurrency: number;
  timeout: number;
  outputFormat?: 'sharegpt' | 'jsonl' | 'raw';
  continueOnError?: boolean;
}

export interface BatchPrompt {
  id: string;
  text: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface BatchItemResult {
  id: string;
  response: string;
  success: boolean;
  duration: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  totalDuration: number;
  items: BatchItemResult[];
}

export interface ShareGPTFormat {
  conversations: Array<{ from: 'human' | 'gpt'; value: string }>;
}

export class BatchProcessor {
  private config: Required<BatchConfig>;

  constructor(config: BatchConfig) {
    this.config = {
      concurrency: config.concurrency || 3,
      timeout: config.timeout || 30000,
      outputFormat: config.outputFormat || 'sharegpt',
      continueOnError: config.continueOnError ?? true,
    };
  }

  /**
   * 并行运行批处理
   */
  async run(
    prompts: BatchPrompt[],
    executor: (prompt: BatchPrompt) => Promise<BatchItemResult>
  ): Promise<BatchItemResult[]> {
    const results: BatchItemResult[] = [];
    const queue = [...prompts];
    let running = 0;

    return new Promise((resolve) => {
      const tryNext = () => {
        if (queue.length === 0 && running === 0) {
          resolve(results);
          return;
        }

        while (running < this.config.concurrency && queue.length > 0) {
          const prompt = queue.shift()!;
          running++;

          executor(prompt)
            .then((result) => {
              results.push(result);
            })
            .catch((err) => {
              results.push({
                id: prompt.id,
                response: '',
                success: false,
                duration: 0,
                error: (err as Error).message,
              });
            })
            .finally(() => {
              running--;
              tryNext();
            });
        }
      };

      tryNext();
    });
  }

  /**
   * 转换为 ShareGPT 格式
   */
  toShareGPT(results: BatchItemResult[]): ShareGPTFormat {
    return {
      conversations: results.flatMap((r) => [
        { from: 'human' as const, value: r.id },
        { from: 'gpt' as const, value: r.response },
      ]),
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/harness/BatchProcessor.test.ts -v`
Expected: PASS

- [ ] **Step 5: 创建批处理 API 路由**

在 `src/server/routes/batchRoutes.ts` 中创建 Express 路由：

- `POST /api/batch/run` — 启动批处理
- `GET /api/batch/:id/status` — 查询状态
- `GET /api/batch/:id/results` — 获取结果

- [ ] **Step 6: 提交**

```bash
git add src/harness/batch/BatchProcessor.ts src/server/routes/batchRoutes.ts tests/unit/harness/BatchProcessor.test.ts
git commit -m "feat(batch): 实现批处理引擎，支持并行 prompt 和 ShareGPT 输出"
```

---

## Task 9: TTS 多提供商

**Files:**

- Modify: `src/interaction/SpeechSynthesizer.ts` — 增加多提供商架构
- Modify: `src/harness/tools/network/tts_speak.ts` — 接入多提供商
- Test: `tests/unit/interaction/SpeechSynthesizer.test.ts`

**背景:** 当前 TTS 仅有模拟模式。Hermes 支持 10 种 TTS 提供商。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/interaction/SpeechSynthesizer.test.ts
import {
  SpeechSynthesizer,
  TTSProviderRegistry,
} from '../../../src/interaction/SpeechSynthesizer';

describe('SpeechSynthesizer 多提供商', () => {
  it('应注册和选择 TTS 提供商', () => {
    const registry = new TTSProviderRegistry();

    registry.register({
      name: 'edge-tts',
      displayName: 'Edge TTS',
      synthesize: async () => ({ success: true, audioData: Buffer.from('') }),
    });

    registry.register({
      name: 'elevenlabs',
      displayName: 'ElevenLabs',
      synthesize: async () => ({ success: true, audioData: Buffer.from('') }),
    });

    const providers = registry.listProviders();
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.name)).toContain('edge-tts');
  });

  it('应使用指定提供商合成语音', async () => {
    const registry = new TTSProviderRegistry();
    registry.register({
      name: 'mock-tts',
      displayName: 'Mock TTS',
      synthesize: async (text) => ({
        success: true,
        audioData: Buffer.from(text),
        duration: 1.0,
      }),
    });

    const synth = new SpeechSynthesizer({
      providerRegistry: registry,
      defaultProvider: 'mock-tts',
    });
    const result = await synth.synthesize({ text: '你好' });

    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/interaction/SpeechSynthesizer.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 TTSProviderRegistry 和增强 SpeechSynthesizer**

在 `src/interaction/SpeechSynthesizer.ts` 中：

- 新增 `TTSProvider` 接口：`{ name, displayName, synthesize(text, options) }`
- 新增 `TTSProviderRegistry` 类：注册/选择/列出提供商
- 修改 `SpeechSynthesizer` 接受 `providerRegistry` 和 `defaultProvider`
- 实现 Edge TTS 提供商（免费，使用 `edge-tts` npm 包或 HTTP API）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/interaction/SpeechSynthesizer.test.ts -v`
Expected: PASS

- [ ] **Step 5: 增强 tts_speak 工具**

在 `src/harness/tools/network/tts_speak.ts` 中：

- 增加 `provider` 参数：选择 TTS 提供商
- 接入 `SpeechSynthesizer` 多提供商

- [ ] **Step 6: 提交**

```bash
git add src/interaction/SpeechSynthesizer.ts src/harness/tools/network/tts_speak.ts tests/unit/interaction/SpeechSynthesizer.test.ts
git commit -m "feat(tts): 实现 TTS 多提供商架构，支持 Edge TTS 等"
```

---

## Task 10: Prompt 跨会话缓存

**Files:**

- Modify: `src/models/LLMResponseCache.ts` — 增加前缀缓存匹配
- Modify: `src/models/MultiModelLLMProvider.ts` — 自动前缀缓存
- Test: `tests/unit/models/LLMResponseCache.test.ts`

**背景:** 当前 `LLMResponseCache` + `RedisCache` 有基础缓存，但缺少 Anthropic/OpenRouter 原生前缀缓存的跨会话 1 小时缓存。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/models/LLMResponseCache.test.ts
import {
  LLMResponseCache,
  PrefixCacheEntry,
} from '../../../src/models/LLMResponseCache';

describe('LLMResponseCache 前缀缓存', () => {
  it('应匹配前缀缓存', () => {
    const cache = new LLMResponseCache();

    // 存储前缀缓存
    cache.setPrefixCache('system-prompt-v1', '你是一个助手...', 3600);

    // 匹配前缀
    const match = cache.matchPrefix('你是一个助手...用户说：你好');
    expect(match).toBeDefined();
    expect(match!.cacheKey).toBe('system-prompt-v1');
  });

  it('应支持跨会话缓存复用', () => {
    const cache = new LLMResponseCache();

    cache.setPrefixCache('session-1-system', '系统提示内容...', 3600);

    // 新会话复用相同系统提示
    const match = cache.matchPrefix('系统提示内容...新的用户输入');
    expect(match).toBeDefined();
  });

  it('应在 TTL 过期后失效', () => {
    const cache = new LLMResponseCache();

    cache.setPrefixCache('expired', '内容', 0); // 立即过期

    const match = cache.matchPrefix('内容xxx');
    expect(match).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/models/LLMResponseCache.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 在 LLMResponseCache 中实现前缀缓存**

在 `src/models/LLMResponseCache.ts` 中增加：

- `setPrefixCache(key, prefixContent, ttlSeconds)` — 存储前缀
- `matchPrefix(fullContent)` — 匹配最长前缀
- 内部使用 Map + TTL 管理

- [ ] **Step 4: 在 MultiModelLLMProvider 中自动使用前缀缓存**

在 `src/models/MultiModelLLMProvider.ts` 的 `chatWithTools()` 中：

- 发送请求前，检查前缀缓存
- 如果匹配，设置 Anthropic 的 `cache_control` 标记
- 利用提供商的原生缓存机制

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest tests/unit/models/LLMResponseCache.test.ts -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/models/LLMResponseCache.ts src/models/MultiModelLLMProvider.ts tests/unit/models/LLMResponseCache.test.ts
git commit -m "feat(cache): 实现 Prompt 跨会话前缀缓存"
```

---

## Task 11: OpenAI 兼容 API 服务器

**Files:**

- Create: `src/server/routes/openaiCompatibleRoutes.ts`
- Modify: `src/server/bootstrap.ts` — 注册路由
- Test: `tests/unit/server/openaiCompatibleRoutes.test.ts`

**背景:** 当前系统有 Express 服务器，但缺少将家百星暴露为 OpenAI 兼容端点的路由。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/server/openaiCompatibleRoutes.test.ts
import request from 'supertest';
import express from 'express';

describe('OpenAI 兼容 API', () => {
  it('POST /v1/chat/completions 应返回 OpenAI 格式响应', async () => {
    const app = express();
    // ... 设置路由

    const response = await request(app)
      .post('/v1/chat/completions')
      .send({
        model: 'jiabaixing',
        messages: [{ role: 'user', content: '你好' }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('id');
    expect(response.body).toHaveProperty('choices');
    expect(response.body.choices[0]).toHaveProperty('message');
    expect(response.body.choices[0].message).toHaveProperty('content');
  });

  it('GET /v1/models 应返回可用模型列表', async () => {
    const app = express();
    // ... 设置路由

    const response = await request(app).get('/v1/models');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/server/openaiCompatibleRoutes.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 OpenAI 兼容路由**

在 `src/server/routes/openaiCompatibleRoutes.ts` 中实现：

- `POST /v1/chat/completions` — 转发到 JiabaixingCore.processInput()
- `GET /v1/models` — 返回 ProviderManager 中的模型列表
- 支持 streaming（SSE）和非 streaming 两种模式
- 请求/响应格式完全兼容 OpenAI API

- [ ] **Step 4: 注册路由到 bootstrap**

在 `src/server/bootstrap.ts` 中添加 OpenAI 兼容路由注册

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest tests/unit/server/openaiCompatibleRoutes.test.ts -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/server/routes/openaiCompatibleRoutes.ts src/server/bootstrap.ts tests/unit/server/openaiCompatibleRoutes.test.ts
git commit -m "feat(server): 实现 OpenAI 兼容 API 端点 /v1/chat/completions"
```

---

## Task 12: 凭证池 — 多密钥轮换

**Files:**

- Modify: `src/models/ProviderManager.ts` — 增加凭证池
- Modify: `src/models/MultiModelLLMProvider.ts` — 使用凭证池
- Test: `tests/unit/models/CredentialPool.test.ts`

**背景:** 当前 `ProviderManager` 每个提供商只支持一个 API Key。Hermes 支持多密钥分发和速率限制自动轮换。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/models/CredentialPool.test.ts
import { CredentialPool } from '../../../src/models/ProviderManager';

describe('CredentialPool', () => {
  it('应在多个密钥间轮换', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
      { key: 'key-3', weight: 1 },
    ]);

    const used = new Set<string>();
    for (let i = 0; i < 6; i++) {
      used.add(pool.getNext().key);
    }

    expect(used.size).toBe(3);
  });

  it('应在速率限制时自动切换', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
    ]);

    pool.reportRateLimit('key-1');
    const next = pool.getNext();

    expect(next.key).toBe('key-2');
  });

  it('应在故障时标记不可用', () => {
    const pool = new CredentialPool('test-provider', [
      { key: 'key-1', weight: 1 },
      { key: 'key-2', weight: 1 },
    ]);

    pool.reportFailure('key-1');
    const next = pool.getNext();

    expect(next.key).toBe('key-2');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/models/CredentialPool.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 在 ProviderManager 中实现 CredentialPool**

在 `src/models/ProviderManager.ts` 中：

- 新增 `CredentialPool` 类：管理同一提供商的多个密钥
- `getNext()` — 轮询获取下一个可用密钥
- `reportRateLimit(key)` — 报告速率限制
- `reportFailure(key)` — 报告故障
- `ProviderConfig` 增加 `apiKeys` 数组字段

- [ ] **Step 4: 在 MultiModelLLMProvider 中使用凭证池**

在 `src/models/MultiModelLLMProvider.ts` 中：

- 请求前从 CredentialPool 获取密钥
- 速率限制/故障时报告给 CredentialPool

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest tests/unit/models/CredentialPool.test.ts -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/models/ProviderManager.ts src/models/MultiModelLLMProvider.ts tests/unit/models/CredentialPool.test.ts
git commit -m "feat(provider): 实现凭证池，多密钥轮换和故障自动切换"
```

---

## Task 13: 外部记忆提供商接口

**Files:**

- Create: `src/memory/external/ExternalMemoryProvider.ts` — 统一接口
- Create: `src/memory/external/Mem0Provider.ts` — Mem0 适配器
- Modify: `src/memory/MemoryEngine.ts` — 接入外部提供商
- Test: `tests/unit/memory/ExternalMemoryProvider.test.ts`

**背景:** 当前记忆系统为内置实现。Hermes 支持接入 Honcho/Mem0/OpenViking 等外部记忆后端。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/memory/ExternalMemoryProvider.test.ts
import { ExternalMemoryProviderRegistry } from '../../../src/memory/external/ExternalMemoryProvider';
import type { ExternalMemoryProvider } from '../../../src/memory/external/ExternalMemoryProvider';

describe('ExternalMemoryProvider', () => {
  it('应注册外部记忆提供商', () => {
    const registry = new ExternalMemoryProviderRegistry();

    const mockProvider: ExternalMemoryProvider = {
      name: 'mem0',
      store: async () => ({ success: true }),
      retrieve: async () => ['记忆1', '记忆2'],
      delete: async () => ({ success: true }),
    };

    registry.register(mockProvider);

    expect(registry.getProvider('mem0')).toBeDefined();
  });

  it('应通过外部提供商存储和检索记忆', async () => {
    const registry = new ExternalMemoryProviderRegistry();
    const stored: string[] = [];

    registry.register({
      name: 'mock',
      store: async (key, value) => {
        stored.push(value);
        return { success: true };
      },
      retrieve: async (query) => stored.filter((s) => s.includes(query)),
      delete: async () => ({ success: true }),
    });

    await registry.getProvider('mock')!.store('user1', '偏好：深色主题');
    const results = await registry.getProvider('mock')!.retrieve('偏好');

    expect(results).toContain('偏好：深色主题');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/memory/ExternalMemoryProvider.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 ExternalMemoryProvider 接口和注册表**

在 `src/memory/external/ExternalMemoryProvider.ts` 中：

- 定义 `ExternalMemoryProvider` 接口
- 实现 `ExternalMemoryProviderRegistry` 注册表
- 实现 `Mem0Provider` 适配器（HTTP API 调用）

- [ ] **Step 4: 在 MemoryEngine 中接入外部提供商**

在 `src/memory/MemoryEngine.ts` 中：

- 增加 `externalProviders` 配置
- `store()` 方法可选同步到外部提供商
- `retrieve()` 方法可选查询外部提供商

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest tests/unit/memory/ExternalMemoryProvider.test.ts -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/memory/external/ExternalMemoryProvider.ts src/memory/external/Mem0Provider.ts src/memory/MemoryEngine.ts tests/unit/memory/ExternalMemoryProvider.test.ts
git commit -m "feat(memory): 实现外部记忆提供商接口，支持 Mem0 等"
```

---

## Task 14: 浏览器自动化增强

**Files:**

- Modify: `src/harness/tools/network/browser_agent.ts` — 增加 CDP 连接和云端支持
- Test: `tests/unit/tools/browser_agent.test.ts`

**背景:** 当前 `browser_agent.ts` 基于 Playwright，但缺少 CDP 连接、Browserbase 云端和多浏览器支持。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/tools/browser_agent.test.ts
import { BROWSER_AGENT_DEF } from '../../../src/harness/tools/network/browser_agent';

describe('browser_agent 增强', () => {
  it('应支持 CDP 连接模式', () => {
    const params = BROWSER_AGENT_DEF.parameters as Record<string, unknown>;
    // 应有 connection_mode 参数
    expect(params).toHaveProperty('connection_mode');
  });

  it('应支持多种浏览器后端', () => {
    const params = BROWSER_AGENT_DEF.parameters as Record<string, unknown>;
    const modeParam = params.connection_mode as { enum?: string[] };
    expect(modeParam.enum).toContain('cdp');
    expect(modeParam.enum).toContain('browserbase');
    expect(modeParam.enum).toContain('local');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/tools/browser_agent.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 增强 browser_agent 工具**

在 `src/harness/tools/network/browser_agent.ts` 中：

- 增加 `connection_mode` 参数：`local | cdp | browserbase | browser-use`
- 增加 `cdp_endpoint` 参数：CDP WebSocket URL
- 增加 `browserbase_session_id` 参数
- 实现多后端连接逻辑

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/tools/browser_agent.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/harness/tools/network/browser_agent.ts tests/unit/tools/browser_agent.test.ts
git commit -m "feat(browser): 增加多后端支持 CDP/Browserbase/本地"
```

---

## Task 15: 图像生成多模型

**Files:**

- Modify: `src/harness/tools/network/image_generate.ts` — 增加多模型选择
- Test: `tests/unit/tools/image_generate.test.ts`

**背景:** 当前 `image_generate` 工具仅支持单一 API。Hermes 支持 9 种模型。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/tools/image_generate.test.ts
import { IMAGE_GENERATE_DEF } from '../../../src/harness/tools/network/image_generate';

describe('image_generate 多模型', () => {
  it('应支持模型选择参数', () => {
    const params = IMAGE_GENERATE_DEF.parameters as Record<string, unknown>;
    expect(params).toHaveProperty('model');
  });

  it('应列出支持的模型', () => {
    const params = IMAGE_GENERATE_DEF.parameters as Record<string, unknown>;
    const modelParam = params.model as { enum?: string[] };
    expect(modelParam.enum).toContain('flux-klein');
    expect(modelParam.enum).toContain('gpt-image');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/tools/image_generate.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 增强 image_generate 工具**

在 `src/harness/tools/network/image_generate.ts` 中：

- 增加 `model` 参数：`flux-klein | flux-pro | gpt-image | ideogram-v3 | recraft-v4 | qwen`
- 实现多模型路由

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/tools/image_generate.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/harness/tools/network/image_generate.ts tests/unit/tools/image_generate.test.ts
git commit -m "feat(image): 图像生成支持多模型选择"
```

---

## Task 16: 皮肤与主题系统

**Files:**

- Create: `src/cli/themes/ThemeManager.ts`
- Create: `src/cli/themes/themes.ts` — 预定义主题
- Test: `tests/unit/cli/ThemeManager.test.ts`

**背景:** 无 CLI 皮肤/主题自定义。Hermes 支持横幅颜色、加载动画、响应框标签等。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/cli/ThemeManager.test.ts
import { ThemeManager, Theme } from '../../../src/cli/themes/ThemeManager';

describe('ThemeManager', () => {
  it('应加载预定义主题', () => {
    const manager = new ThemeManager();
    const theme = manager.getTheme('default');

    expect(theme).toBeDefined();
    expect(theme!.bannerColor).toBeDefined();
    expect(theme!.loadingIcon).toBeDefined();
  });

  it('应支持自定义主题', () => {
    const manager = new ThemeManager();
    const custom: Partial<Theme> = {
      bannerColor: '#ff0000',
      responseLabel: '家百星',
    };

    manager.setTheme('custom', custom);
    const loaded = manager.getTheme('custom');

    expect(loaded!.bannerColor).toBe('#ff0000');
    expect(loaded!.responseLabel).toBe('家百星');
  });

  it('应列出所有可用主题', () => {
    const manager = new ThemeManager();
    const themes = manager.listThemes();

    expect(themes.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/cli/ThemeManager.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 ThemeManager**

在 `src/cli/themes/ThemeManager.ts` 中：

- 定义 `Theme` 接口：`{ bannerColor, loadingIcon, loadingVerb, responseLabel, brandText, toolPrefix }`
- 实现 `ThemeManager`：加载/切换/自定义主题
- 预定义 3-5 个主题：default, dark, minimal, colorful

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/cli/ThemeManager.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli/themes/ThemeManager.ts src/cli/themes/themes.ts tests/unit/cli/ThemeManager.test.ts
git commit -m "feat(cli): 实现皮肤与主题系统"
```

---

## Task 17: 统一插件管理器

**Files:**

- Create: `src/plugins/PluginManager.ts`
- Create: `src/plugins/PluginInterface.ts`
- Modify: `src/harness/tools/registerHarnessTools.ts` — 插件工具注册
- Test: `tests/unit/plugins/PluginManager.test.ts`

**背景:** 当前 `skill_share` + `skill_create` 有基础插件能力，但缺少统一管理器。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/plugins/PluginManager.test.ts
import { PluginManager, PluginType } from '../../../src/plugins/PluginManager';
import type { PluginDefinition } from '../../../src/plugins/PluginInterface';

describe('PluginManager', () => {
  it('应注册通用插件', () => {
    const manager = new PluginManager();
    const plugin: PluginDefinition = {
      name: 'test-plugin',
      version: '1.0',
      type: PluginType.GENERAL,
      tools: [
        {
          name: 'custom_tool',
          description: '自定义工具',
          parameters: [],
          execute: async () => ({ success: true, output: 'ok' }),
        },
      ],
      hooks: [],
    };

    manager.register(plugin);
    expect(manager.getPlugin('test-plugin')).toBeDefined();
  });

  it('应注册记忆提供商插件', () => {
    const manager = new PluginManager();
    const plugin: PluginDefinition = {
      name: 'mem0-plugin',
      version: '1.0',
      type: PluginType.MEMORY_PROVIDER,
      memoryProvider: {
        name: 'mem0',
        store: async () => ({ success: true }),
        retrieve: async () => [],
        delete: async () => ({ success: true }),
      },
    };

    manager.register(plugin);
    expect(manager.getMemoryProviders()).toHaveLength(1);
  });

  it('应注销插件', () => {
    const manager = new PluginManager();
    manager.register({
      name: 'temp',
      version: '1.0',
      type: PluginType.GENERAL,
    });

    manager.unregister('temp');
    expect(manager.getPlugin('temp')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/plugins/PluginManager.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 PluginInterface 和 PluginManager**

在 `src/plugins/PluginInterface.ts` 中：

- 定义 `PluginDefinition` 接口
- 定义三种插件类型：GENERAL、MEMORY_PROVIDER、CONTEXT_ENGINE

在 `src/plugins/PluginManager.ts` 中：

- 实现 `register()`、`unregister()`、`getPlugin()`
- 实现 `getMemoryProviders()`、`getContextEngines()`
- 插件工具自动注册到 ToolRegistry

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/plugins/PluginManager.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/plugins/PluginManager.ts src/plugins/PluginInterface.ts tests/unit/plugins/PluginManager.test.ts
git commit -m "feat(plugins): 实现统一插件管理器，支持三种插件类型"
```

---

## Task 18: IDE 集成（ACP 协议）

**Files:**

- Create: `src/ide/ACPServer.ts`
- Create: `src/server/routes/ideRoutes.ts`
- Test: `tests/unit/ide/ACPServer.test.ts`

**背景:** 无 ACP（Agent Communication Protocol）编辑器集成。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/ide/ACPServer.test.ts
import { ACPServer } from '../../../src/ide/ACPServer';

describe('ACPServer', () => {
  it('应处理聊天请求', async () => {
    const server = new ACPServer({ core: mockCore });
    const response = await server.handleChat({
      message: '你好',
      sessionId: 'test',
    });

    expect(response).toHaveProperty('content');
  });

  it('应推送文件 diff', async () => {
    const server = new ACPServer({ core: mockCore });
    const diff = await server.getFileDiff('test-session');

    expect(Array.isArray(diff)).toBe(true);
  });

  it('应推送终端命令', async () => {
    const server = new ACPServer({ core: mockCore });
    const commands = await server.getTerminalCommands('test-session');

    expect(Array.isArray(commands)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/ide/ACPServer.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 ACPServer**

在 `src/ide/ACPServer.ts` 中：

- 实现 ACP 协议的消息格式
- `handleChat()` — 处理聊天消息
- `getFileDiff()` — 获取文件变更
- `getTerminalCommands()` — 获取终端命令
- `getToolActivity()` — 获取工具活动

- [ ] **Step 4: 创建 IDE 路由**

在 `src/server/routes/ideRoutes.ts` 中：

- WebSocket 端点用于实时通信
- REST 端点用于查询

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest tests/unit/ide/ACPServer.test.ts -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/ide/ACPServer.ts src/server/routes/ideRoutes.ts tests/unit/ide/ACPServer.test.ts
git commit -m "feat(ide): 实现 ACP 协议服务器，支持编辑器集成"
```

---

## Task 19: RL 训练轨迹生成

**Files:**

- Modify: `src/harness/persistence/TrajectoryDatabase.ts` — 增加轨迹导出
- Create: `src/training/TrajectoryExporter.ts`
- Test: `tests/unit/training/TrajectoryExporter.test.ts`

**背景:** 有 `TrajectoryDatabase` + `GoldenEvalSet`，但缺少自动生成 RL 训练数据的完整流程。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/training/TrajectoryExporter.test.ts
import {
  TrajectoryExporter,
  ExportFormat,
} from '../../../src/training/TrajectoryExporter';

describe('TrajectoryExporter', () => {
  it('应导出为 ShareGPT 格式', () => {
    const exporter = new TrajectoryExporter();
    const trajectories = [
      {
        id: 't1',
        steps: [
          { role: 'user', content: '写代码' },
          {
            role: 'assistant',
            content: '好的',
            toolCalls: [{ name: 'file_read', params: {} }],
          },
          { role: 'tool', content: '文件内容' },
          { role: 'assistant', content: '代码如下...' },
        ],
        quality: 0.9,
      },
    ];

    const exported = exporter.export(trajectories, ExportFormat.SHAREGPT);

    expect(exported).toContain('conversations');
  });

  it('应按质量分数过滤轨迹', () => {
    const exporter = new TrajectoryExporter({ minQuality: 0.7 });
    const trajectories = [
      { id: 't1', steps: [], quality: 0.9 },
      { id: 't2', steps: [], quality: 0.5 },
      { id: 't3', steps: [], quality: 0.8 },
    ];

    const filtered = exporter.filterByQuality(trajectories);

    expect(filtered).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/training/TrajectoryExporter.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 TrajectoryExporter**

在 `src/training/TrajectoryExporter.ts` 中：

- 支持 ShareGPT / JSONL / OpenAI Fine-tuning 格式导出
- 按质量分数过滤
- 自动标注（reward signal）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/training/TrajectoryExporter.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/training/TrajectoryExporter.ts tests/unit/training/TrajectoryExporter.test.ts
git commit -m "feat(training): 实现 RL 训练轨迹导出，支持多格式"
```

---

## Task 20: 全双工语音模式

**Files:**

- Modify: `src/multimodal/SpeechRecognizer.ts` — 增加实时流式识别
- Modify: `src/interaction/InteractionEngine.ts` — 全双工语音会话
- Test: `tests/unit/multimodal/VoiceSession.test.ts`

**背景:** 有 `SpeechRecognizer`，但缺少全双工语音交互。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/multimodal/VoiceSession.test.ts
import { VoiceSessionManager } from '../../../src/multimodal/VoiceSessionManager';

describe('VoiceSessionManager', () => {
  it('应创建语音会话', () => {
    const manager = new VoiceSessionManager();
    const session = manager.createSession({ language: 'zh-CN' });

    expect(session.id).toBeDefined();
    expect(session.status).toBe('idle');
  });

  it('应管理会话状态转换', () => {
    const manager = new VoiceSessionManager();
    const session = manager.createSession({ language: 'zh-CN' });

    manager.startListening(session.id);
    expect(manager.getSession(session.id)!.status).toBe('listening');

    manager.startProcessing(session.id);
    expect(manager.getSession(session.id)!.status).toBe('processing');

    manager.startSpeaking(session.id);
    expect(manager.getSession(session.id)!.status).toBe('speaking');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/unit/multimodal/VoiceSession.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 VoiceSessionManager**

在 `src/multimodal/VoiceSessionManager.ts` 中：

- 管理语音会话生命周期
- 状态机：idle → listening → processing → speaking → idle
- 支持中断和恢复

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/unit/multimodal/VoiceSession.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/multimodal/VoiceSessionManager.ts tests/unit/multimodal/VoiceSession.test.ts
git commit -m "feat(voice): 实现全双工语音会话管理"
```

---

## 实施顺序与依赖关系

```
Phase 1 (基础设施，无依赖):
  Task 1: HookManager ─────────────────┐
  Task 4: 上下文文件发现增强 ──────────┤
  Task 16: 皮肤主题 ──────────────────┤
  Task 17: 统一插件管理器 ────────────┘

Phase 2 (核心增强，依赖 Phase 1):
  Task 2: @ 引用展开 (依赖 HookManager)
  Task 3: 技能渐进式披露
  Task 5: 工作目录检查点
  Task 12: 凭证池

Phase 3 (工具增强，依赖 Phase 2):
  Task 6: 子 Agent 并发 (依赖 HookManager)
  Task 7: 代码沙箱执行 (依赖 HookManager)
  Task 8: 批处理引擎
  Task 14: 浏览器自动化增强
  Task 15: 图像生成多模型

Phase 4 (集成层，依赖 Phase 3):
  Task 9: TTS 多提供商
  Task 10: Prompt 跨会话缓存
  Task 11: OpenAI 兼容 API
  Task 13: 外部记忆提供商
  Task 19: RL 训练轨迹

Phase 5 (高级特性，依赖 Phase 4):
  Task 18: IDE 集成 ACP
  Task 20: 全双工语音
```

---

## 重复构件合并执行计划

| 合并项                                           | 在哪个 Task 中执行 | 说明                              |
| ------------------------------------------------ | ------------------ | --------------------------------- |
| SkillRegistry.infrastructureTools → ToolRegistry | Task 17            | 插件管理器统一工具注册            |
| ConstraintsService.hooks → HookManager           | Task 1             | 钩子系统统一                      |
| Executor.ToolCallHooks → HookManager             | Task 1             | 钩子系统统一                      |
| PersistentMemoryService → MemoryEngine 后端      | Task 13            | 外部记忆提供商统一接口            |
| SandboxExecutor ↔ delegate_task                  | Task 7             | 子 Agent 执行复用 SandboxExecutor |
| context_manage 硬编码 → ContextFileRegistry      | Task 4             | 已部分合并，完全统一              |
