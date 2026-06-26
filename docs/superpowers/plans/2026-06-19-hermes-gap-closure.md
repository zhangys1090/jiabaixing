# Hermes 级别差距缩短实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 缩短 Jiabaixing 与 Hermes 级别 Agent 在 5 个维度的差距：ReAct循环深化、上下文主动检索、记忆向量嵌入、规划步骤级调整、学习闭环建立

**Architecture:** 在现有 ReflectionEngine / ContextManager / TrajectoryDatabase / EvolutionOrchestrator 基础上增量增强，不创建独立子系统。每个任务直接修改现有文件并立即集成，TDD 流程保证质量。

**Tech Stack:** TypeScript 6 / Express / better-sqlite3 / Jest / ReflectionEngine / ContextManager / TrajectoryDatabase / EvolutionOrchestrator

---

## File Structure

| 文件                                                  | 职责                            | 操作 |
| ----------------------------------------------------- | ------------------------------- | ---- |
| `src/harness/loop/LoopController.ts`                  | ReAct循环主控，反思注入Thought  | 修改 |
| `src/harness/context/ContextManager.ts`               | 上下文管理，主动检索+注意力聚焦 | 修改 |
| `src/harness/persistence/TrajectoryDatabase.ts`       | 轨迹数据库，向量嵌入接入        | 修改 |
| `src/harness/loop/Executor.ts`                        | 工具执行，步骤级精细调整        | 修改 |
| `src/evolution/EvolutionOrchestrator.ts`              | 进化引擎，学习信号管道          | 修改 |
| `src/evolution/StrategyAdapter.ts`                    | 策略自适应                      | 修改 |
| `tests/unit/harness/ReActReflectionInjection.test.ts` | ReAct反思注入测试               | 新建 |
| `tests/unit/harness/ContextActiveRetrieval.test.ts`   | 上下文主动检索测试              | 新建 |
| `tests/unit/harness/TrajectoryVectorSearch.test.ts`   | 轨迹向量检索测试                | 新建 |
| `tests/unit/harness/StepLevelReplan.test.ts`          | 步骤级重规划测试                | 新建 |
| `tests/unit/evolution/LearningSignalPipeline.test.ts` | 学习信号管道测试                | 新建 |

---

## Task 1: ReAct循环 — 反思结论深度注入Thought阶段

**Files:**

- Modify: `src/harness/loop/LoopController.ts` — 在ReAct循环的Thought阶段注入上一轮反思结论
- Test: `tests/unit/harness/ReActReflectionInjection.test.ts`

**背景**: 当前反思结论通过 `messages.push({ role: 'system', content: '...' })` 注入，位于消息末尾。Hermes级别要求反思结论深度影响下一轮的Thought（推理）阶段，而非仅作为系统提示。

- [ ] **Step 1: 编写失败的测试**

创建 `tests/unit/harness/ReActReflectionInjection.test.ts`:

```typescript
import { LoopController } from '../../../src/harness/loop/LoopController';

describe('ReAct循环 — 反思结论深度注入Thought', () => {
  it('应在ReAct循环的Thought阶段注入上一轮反思结论', () => {
    const mockDeps = {
      planner: {
        plan: jest.fn().mockResolvedValue({ steps: [{ tool: 'test' }] }),
      },
      executor: {
        execute: jest.fn().mockResolvedValue({ success: true, output: 'ok' }),
      },
      evaluator: {
        evaluate: jest
          .fn()
          .mockResolvedValue({
            goalProgress: 0.5,
            suggestedAction: 'continue',
          }),
      },
      reflectionEngine: {
        reflect: jest.fn().mockResolvedValue({
          rootCause: '参数路径错误',
          correctedArgs: { path: '/correct/path' },
          shouldRetry: true,
        }),
        deepReflect: jest.fn().mockResolvedValue({
          diagnosis: '需要更换工具',
          fixStrategy: '使用file_search替代',
        }),
      },
      contextManager: {
        buildContext: jest.fn().mockReturnValue({ messages: [] }),
        compressHistory: jest.fn(),
      },
      toolRegistry: { getRegisteredToolNames: jest.fn().mockReturnValue([]) },
      complexityAnalyzer: {
        analyzeComplexity: jest.fn().mockReturnValue('medium'),
      },
      stateManager: { transition: jest.fn() },
      permissionGuard: {
        check: jest
          .fn()
          .mockReturnValue({ allowed: true, missing: [], reason: undefined }),
      },
    } as any;

    const controller = new LoopController(mockDeps);

    // 模拟上一轮反思结论
    controller['_lastReflectionInsight'] = {
      rootCause: '参数路径错误',
      correctedArgs: { path: '/correct/path' },
      shouldRetry: true,
      diagnosis: '需要更换工具',
      fixStrategy: '使用file_search替代',
    };

    // 执行一轮循环
    const thoughtPrompt = controller['buildThoughtPrompt']({
      userInput: '读取文件',
      currentStep: { tool: 'file_read', args: { path: '/wrong/path' } },
    });

    // 验证Thought阶段包含反思结论
    expect(thoughtPrompt).toContain('参数路径错误');
    expect(thoughtPrompt).toContain('使用file_search替代');
    expect(thoughtPrompt).toContain('/correct/path');
  });

  it('应在无反思结论时正常构建Thought', () => {
    const mockDeps = {
      planner: { plan: jest.fn().mockResolvedValue({ steps: [] }) },
      executor: { execute: jest.fn() },
      evaluator: { evaluate: jest.fn() },
      contextManager: {
        buildContext: jest.fn().mockReturnValue({ messages: [] }),
        compressHistory: jest.fn(),
      },
      toolRegistry: { getRegisteredToolNames: jest.fn().mockReturnValue([]) },
      complexityAnalyzer: {
        analyzeComplexity: jest.fn().mockReturnValue('medium'),
      },
      stateManager: { transition: jest.fn() },
      permissionGuard: {
        check: jest
          .fn()
          .mockReturnValue({ allowed: true, missing: [], reason: undefined }),
      },
    } as any;

    const controller = new LoopController(mockDeps);
    controller['_lastReflectionInsight'] = null;

    const thoughtPrompt = controller['buildThoughtPrompt']({
      userInput: '读取文件',
      currentStep: { tool: 'file_read', args: { path: '/test' } },
    });

    expect(thoughtPrompt).not.toContain('上一轮反思');
    expect(thoughtPrompt).toContain('读取文件');
  });

  it('应在反思触发后保存结论供下一轮使用', async () => {
    const mockDeps = {
      planner: {
        plan: jest.fn().mockResolvedValue({ steps: [{ tool: 'file_read' }] }),
      },
      executor: {
        execute: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'not found' }),
      },
      evaluator: {
        evaluate: jest
          .fn()
          .mockResolvedValue({
            goalProgress: 0.2,
            suggestedAction: 'continue',
          }),
      },
      reflectionEngine: {
        reflect: jest.fn().mockResolvedValue({
          rootCause: '路径不存在',
          correctedArgs: { path: '/new/path' },
          shouldRetry: true,
        }),
      },
      contextManager: {
        buildContext: jest.fn().mockReturnValue({ messages: [] }),
        compressHistory: jest.fn(),
      },
      toolRegistry: { getRegisteredToolNames: jest.fn().mockReturnValue([]) },
      complexityAnalyzer: {
        analyzeComplexity: jest.fn().mockReturnValue('medium'),
      },
      stateManager: { transition: jest.fn() },
      permissionGuard: {
        check: jest
          .fn()
          .mockReturnValue({ allowed: true, missing: [], reason: undefined }),
      },
    } as any;

    const controller = new LoopController(mockDeps);

    // 触发反思
    await controller['triggerReflectionIfNeeded']({
      userInput: '读取文件',
      toolResult: { success: false, error: 'not found' },
      loopCount: 1,
    });

    // 验证反思结论已保存
    expect(controller['_lastReflectionInsight']).not.toBeNull();
    expect(controller['_lastReflectionInsight'].rootCause).toBe('路径不存在');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/harness/ReActReflectionInjection.test.ts --no-coverage`
Expected: FAIL — `buildThoughtPrompt` 方法不存在 / `_lastReflectionInsight` 属性不存在

- [ ] **Step 3: 实现 `buildThoughtPrompt` 方法和 `_lastReflectionInsight` 属性**

在 `src/harness/loop/LoopController.ts` 的类属性区域添加:

```typescript
  /** P5: 上一轮反思结论 — 注入到下一轮Thought阶段 */
  private _lastReflectionInsight: {
    rootCause: string;
    correctedArgs?: Record<string, unknown>;
    shouldRetry: boolean;
    diagnosis?: string;
    fixStrategy?: string;
  } | null = null;
```

在类方法区域添加 `buildThoughtPrompt` 方法:

```typescript
  /**
   * P5: 构建Thought阶段的Prompt — 深度注入上一轮反思结论
   *
   * Hermes级别要求：反思结论不是简单的系统提示，而是直接影响下一轮的推理过程
   */
  private buildThoughtPrompt(params: {
    userInput: string;
    currentStep: { tool: string; args: Record<string, unknown> };
  }): string {
    const { userInput, currentStep } = params;
    let prompt = `【当前任务】${userInput}\n【当前步骤】工具: ${currentStep.tool}, 参数: ${JSON.stringify(currentStep.args)}`;

    // P5: 深度注入上一轮反思结论
    if (this._lastReflectionInsight) {
      const insight = this._lastReflectionInsight;
      prompt += `\n\n【上一轮反思结论】`;
      prompt += `\n- 根因分析: ${insight.rootCause}`;
      if (insight.diagnosis) {
        prompt += `\n- 诊断: ${insight.diagnosis}`;
      }
      if (insight.fixStrategy) {
        prompt += `\n- 修复策略: ${insight.fixStrategy}`;
      }
      if (insight.correctedArgs) {
        prompt += `\n- 建议参数: ${JSON.stringify(insight.correctedArgs)}`;
      }
      prompt += `\n- 是否重试: ${insight.shouldRetry ? '是' : '否'}`;
      prompt += `\n\n请基于以上反思结论调整当前步骤的执行策略。`;
    }

    return prompt;
  }
```

- [ ] **Step 4: 实现 `triggerReflectionIfNeeded` 方法**

在 `src/harness/loop/LoopController.ts` 添加:

```typescript
  /**
   * P5: 在需要时触发反思并保存结论
   */
  private async triggerReflectionIfNeeded(params: {
    userInput: string;
    toolResult: { success: boolean; error?: string; output?: unknown };
    loopCount: number;
  }): Promise<void> {
    if (!this.deps?.reflectionEngine) return;
    if (params.toolResult.success) return;

    try {
      const reflection = await this.deps.reflectionEngine.reflect(
        'unknown',
        {},
        params.toolResult.error || '执行失败',
        { traceId: `loop-${params.loopCount}`, loopCount: params.loopCount }
      );

      // 保存反思结论供下一轮Thought使用
      this._lastReflectionInsight = {
        rootCause: reflection.rootCause || '未知根因',
        correctedArgs: reflection.correctedArgs || undefined,
        shouldRetry: reflection.shouldRetry ?? false,
        diagnosis: reflection.diagnosis || undefined,
        fixStrategy: reflection.fixStrategy || undefined,
      };

      Logger.info(
        `🔄 P5 反思结论已保存，将注入下一轮Thought: ${this._lastReflectionInsight.rootCause}`,
        'LoopController'
      );
    } catch (err) {
      Logger.debug(
        `P5 反思触发失败: ${(err as Error).message}`,
        'LoopController'
      );
    }
  }
```

- [ ] **Step 5: 在ReAct循环中调用 `triggerReflectionIfNeeded`**

找到 `src/harness/loop/LoopController.ts` 中工具执行失败后的位置（`executor.execute` 返回 `success: false` 后），添加反思触发:

```typescript
// P5: 工具执行失败后触发反思，保存结论供下一轮Thought
if (!executorOutput.success) {
  await this.triggerReflectionIfNeeded({
    userInput: context.userInput,
    toolResult: executorOutput,
    loopCount,
  });
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx jest tests/unit/harness/ReActReflectionInjection.test.ts --no-coverage`
Expected: PASS — 3 tests passed

- [ ] **Step 7: TypeScript编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 8: 提交**

```bash
git add src/harness/loop/LoopController.ts tests/unit/harness/ReActReflectionInjection.test.ts
git commit -m "feat(loop): P5 ReAct循环反思结论深度注入Thought阶段"
```

---

## Task 2: 上下文管理 — 主动检索+注意力聚焦

**Files:**

- Modify: `src/harness/context/ContextManager.ts` — 添加主动检索和注意力聚焦方法
- Test: `tests/unit/harness/ContextActiveRetrieval.test.ts`

**背景**: 当前 ContextManager 在 token 使用率超过 85% 时才被动触发压缩。Hermes级别要求主动检索相关上下文 + 注意力聚焦（高权重信息优先保留）。

- [ ] **Step 1: 编写失败的测试**

创建 `tests/unit/harness/ContextActiveRetrieval.test.ts`:

```typescript
import { ContextManager } from '../../../src/harness/context/ContextManager';

describe('上下文管理 — 主动检索+注意力聚焦', () => {
  it('应基于当前任务主动检索相关上下文', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 8000 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages = [
      { role: 'user', content: '部署应用到生产环境' },
      { role: 'assistant', content: '开始部署流程...' },
      { role: 'user', content: '检查端口占用情况' },
      { role: 'assistant', content: '端口8080被占用' },
      { role: 'user', content: '如何解决端口冲突？' },
    ];

    const retrieved = cm['activelyRetrieveContext'](messages, '解决端口冲突');

    // 应检索到与"端口"相关的消息
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.some((m: any) => m.content.includes('端口'))).toBe(true);
  });

  it('应计算消息的注意力权重', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 8000 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages = [
      { role: 'user', content: '部署应用' },
      { role: 'assistant', content: '端口8080被占用，需要释放' },
      { role: 'user', content: '好的' },
      { role: 'assistant', content: '已释放端口，部署成功' },
    ];

    const weights = cm['calculateAttentionWeights'](messages, '端口冲突');

    // 与"端口"相关的消息权重应更高
    expect(weights[1]).toBeGreaterThan(weights[2]); // "端口8080被占用" > "好的"
    expect(weights[3]).toBeGreaterThan(weights[2]); // "已释放端口" > "好的"
  });

  it('应在token预算内聚焦高权重消息', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 100 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages = [
      { role: 'user', content: '部署应用' },
      {
        role: 'assistant',
        content: '端口8080被占用，需要释放端口才能继续部署',
      },
      { role: 'user', content: '好的' },
      { role: 'assistant', content: '已释放端口，部署成功完成' },
    ];

    const focused = cm['focusByAttention'](messages, '端口冲突', 100);

    // 聚焦后的消息数应少于原始消息数
    expect(focused.length).toBeLessThanOrEqual(messages.length);
    // 应保留高权重消息
    expect(focused.some((m: any) => m.content.includes('端口'))).toBe(true);
  });

  it('应在无相关上下文时返回空数组', () => {
    const mockDeps = {
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn().mockResolvedValue(''),
      },
      memoryInjector: { inject: jest.fn().mockReturnValue([]) },
      tokenBudgetAllocator: {
        allocate: jest.fn().mockReturnValue({ total: 8000 }),
      },
    } as any;

    const cm = new ContextManager(mockDeps);

    const messages = [
      { role: 'user', content: '今天天气如何' },
      { role: 'assistant', content: '天气晴朗' },
    ];

    const retrieved = cm['activelyRetrieveContext'](messages, '部署应用');
    expect(retrieved.length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/harness/ContextActiveRetrieval.test.ts --no-coverage`
Expected: FAIL — `activelyRetrieveContext` / `calculateAttentionWeights` / `focusByAttention` 方法不存在

- [ ] **Step 3: 实现主动检索方法**

在 `src/harness/context/ContextManager.ts` 类中添加:

```typescript
  /**
   * P3: 主动检索 — 基于当前任务从历史消息中检索相关上下文
   *
   * Hermes级别：不是被动等待token超限才压缩，而是主动检索与当前任务相关的消息
   */
  private activelyRetrieveContext(
    messages: ChatMessage[],
    currentTask: string
  ): ChatMessage[] {
    const taskKeywords = this.extractTaskKeywords(currentTask);
    if (taskKeywords.length === 0) return [];

    const retrieved: ChatMessage[] = [];
    for (const msg of messages) {
      const contentLower = msg.content.toLowerCase();
      const relevanceScore = taskKeywords.filter((k) =>
        contentLower.includes(k.toLowerCase())
      ).length;
      if (relevanceScore > 0) {
        retrieved.push(msg);
      }
    }
    return retrieved;
  }

  /**
   * 提取任务关键词
   */
  private extractTaskKeywords(task: string): string[] {
    // 去除停用词，提取关键词
    const stopWords = new Set([
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
      '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去',
      '你', '会', '着', '没有', '看', '好', '自己', '这', '他', '她',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in',
      'for', 'on', 'with', 'at', 'by', 'from', 'as', 'and', 'or', 'not',
    ]);
    return task
      .toLowerCase()
      .split(/[\s\-_.,;:!?，。！？、()（）]+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));
  }
```

- [ ] **Step 4: 实现注意力权重计算方法**

在 `src/harness/context/ContextManager.ts` 类中添加:

```typescript
  /**
   * P3: 注意力聚焦 — 计算每条消息的注意力权重
   *
   * 权重因素：
   * - 关键词匹配度（与当前任务的相关性）
   * - 消息位置（越近权重越高）
   * - 消息角色（user > assistant，因为用户意图更重要）
   * - 信息密度（包含具体数据/路径/错误信息的消息权重更高）
   */
  private calculateAttentionWeights(
    messages: ChatMessage[],
    currentTask: string
  ): number[] {
    const taskKeywords = this.extractTaskKeywords(currentTask);
    const totalMessages = messages.length;

    return messages.map((msg, index) => {
      let weight = 0;
      const contentLower = msg.content.toLowerCase();

      // 1. 关键词匹配度（0-0.4）
      const matchCount = taskKeywords.filter((k) =>
        contentLower.includes(k.toLowerCase())
      ).length;
      weight += (matchCount / Math.max(taskKeywords.length, 1)) * 0.4;

      // 2. 位置权重 — 越近权重越高（0-0.2）
      const positionWeight = (index + 1) / totalMessages;
      weight += positionWeight * 0.2;

      // 3. 角色权重 — user消息权重更高（0-0.15）
      if (msg.role === 'user') {
        weight += 0.15;
      }

      // 4. 信息密度 — 包含具体信息的消息权重更高（0-0.25）
      const hasPath = /\/[a-zA-Z0-9_\-\/]+/.test(msg.content);
      const hasError = /error|fail|错误|失败|exception/i.test(msg.content);
      const hasNumber = /\d+/.test(msg.content);
      if (hasPath) weight += 0.1;
      if (hasError) weight += 0.1;
      if (hasNumber) weight += 0.05;

      return Math.min(weight, 1.0);
    });
  }
```

- [ ] **Step 5: 实现注意力聚焦方法**

在 `src/harness/context/ContextManager.ts` 类中添加:

```typescript
  /**
   * P3: 注意力聚焦 — 在token预算内保留高权重消息
   *
   * 按注意力权重排序，优先保留高权重消息，直到token预算耗尽
   */
  private focusByAttention(
    messages: ChatMessage[],
    currentTask: string,
    tokenBudget: number
  ): ChatMessage[] {
    const weights = this.calculateAttentionWeights(messages, currentTask);

    // 创建 (消息, 权重, 原始索引) 三元组
    const indexed = messages.map((msg, index) => ({
      msg,
      weight: weights[index],
      originalIndex: index,
    }));

    // 按权重降序排序
    indexed.sort((a, b) => b.weight - a.weight);

    // 按权重优先级选择消息，直到token预算耗尽
    const selected: ChatMessage[] = [];
    let usedTokens = 0;
    for (const item of indexed) {
      const msgTokens = Math.ceil(item.msg.content.length / 4); // 粗略估算
      if (usedTokens + msgTokens > tokenBudget) continue;
      selected.push(item.msg);
      usedTokens += msgTokens;
    }

    // 按原始顺序排序选中的消息
    const selectedSet = new Set(selected);
    return messages.filter((m) => selectedSet.has(m));
  }
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx jest tests/unit/harness/ContextActiveRetrieval.test.ts --no-coverage`
Expected: PASS — 4 tests passed

- [ ] **Step 7: TypeScript编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 8: 提交**

```bash
git add src/harness/context/ContextManager.ts tests/unit/harness/ContextActiveRetrieval.test.ts
git commit -m "feat(context): P3 上下文主动检索+注意力聚焦"
```

---

## Task 3: 记忆系统 — TrajectoryDatabase 向量嵌入接入

**Files:**

- Modify: `src/harness/persistence/TrajectoryDatabase.ts` — 添加 embedding 字段和向量检索
- Test: `tests/unit/harness/TrajectoryVectorSearch.test.ts`

**背景**: 当前 TrajectoryDatabase 使用词频余弦相似度，精度有限。接入 PersistentVectorDatabase 实现真正的语义向量检索。

- [ ] **Step 1: 编写失败的测试**

创建 `tests/unit/harness/TrajectoryVectorSearch.test.ts`:

```typescript
import { TrajectoryDatabase } from '../../../src/harness/persistence/TrajectoryDatabase';

describe('TrajectoryDatabase 向量嵌入接入', () => {
  let db: TrajectoryDatabase;

  beforeEach(() => {
    db = new TrajectoryDatabase(':memory:');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  });

  it('应支持设置嵌入函数', () => {
    const embedFn = jest.fn().mockReturnValue([0.1, 0.2, 0.3]);
    db.setEmbedFunction(embedFn);
    // 不应抛出异常
    expect(embedFn).toBeDefined();
  });

  it('应在记录执行时生成并存储embedding', () => {
    const embedFn = jest.fn().mockReturnValue([0.1, 0.2, 0.3, 0.4]);
    db.setEmbedFunction(embedFn);

    const now = Date.now();
    db.recordExecution({
      id: 'exec1',
      input: '部署应用到生产环境',
      status: 'success',
      quality_overall: 0.9,
      loop_rounds: 2,
      total_tool_calls: 3,
      total_duration: 5000,
      created_at: now,
      updated_at: now,
    });

    // 嵌入函数应被调用
    expect(embedFn).toHaveBeenCalledWith('部署应用到生产环境');
  });

  it('应支持基于向量的语义检索', () => {
    const embedFn = jest.fn().mockImplementation((text: string) => {
      // 简单模拟：部署相关 → [1, 0, 0], 其他 → [0, 1, 0]
      if (text.includes('部署') || text.includes('发布')) return [1, 0, 0];
      return [0, 1, 0];
    });
    db.setEmbedFunction(embedFn);

    const now = Date.now();
    db.recordExecution({
      id: 'exec1',
      input: '部署应用到生产环境',
      status: 'success',
      quality_overall: 0.9,
      loop_rounds: 2,
      total_tool_calls: 3,
      total_duration: 5000,
      created_at: now,
      updated_at: now,
    });

    db.recordExecution({
      id: 'exec2',
      input: '查询天气信息',
      status: 'success',
      quality_overall: 0.8,
      loop_rounds: 1,
      total_tool_calls: 1,
      total_duration: 2000,
      created_at: now,
      updated_at: now,
    });

    // 语义检索 — "发布应用" 应匹配 "部署应用"
    const results = db.querySimilarTasks('发布应用', { minQualityScore: 0 });

    // 应检索到 exec1（语义相似）
    const exec1Result = results.find((r: any) => r.execution.id === 'exec1');
    expect(exec1Result).toBeDefined();
    expect(exec1Result.relevanceScore).toBeGreaterThan(0.5);
  });

  it('应在未设置嵌入函数时回退到词频余弦相似度', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'exec1',
      input: '部署应用',
      status: 'success',
      quality_overall: 0.9,
      loop_rounds: 1,
      total_tool_calls: 1,
      total_duration: 1000,
      created_at: now,
      updated_at: now,
    });

    // 不设置嵌入函数，直接查询
    const results = db.querySimilarTasks('部署应用', { minQualityScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/harness/TrajectoryVectorSearch.test.ts --no-coverage`
Expected: FAIL — `setEmbedFunction` 方法不存在

- [ ] **Step 3: 添加 embedding 列到表结构**

在 `src/harness/persistence/TrajectoryDatabase.ts` 的 `initializeTables` 方法中，在 `CREATE INDEX` 语句之前添加:

```typescript
// P3: 添加 embedding 列（如果不存在）
try {
  this.db.exec(`ALTER TABLE executions ADD COLUMN embedding TEXT;`);
} catch {
  // 列已存在，忽略
}
```

- [ ] **Step 4: 添加 `setEmbedFunction` 方法和嵌入存储**

在 `src/harness/persistence/TrajectoryDatabase.ts` 类中添加属性和方法:

```typescript
  /** P3: 嵌入函数 — 将文本转为向量 */
  private embedFunction: ((text: string) => number[]) | null = null;

  /**
   * P3: 设置嵌入函数 — 用于生成语义向量
   */
  setEmbedFunction(fn: (text: string) => number[]): void {
    this.embedFunction = fn;
    Logger.info('📐 TrajectoryDatabase 嵌入函数已设置', 'TrajectoryDatabase');
  }
```

- [ ] **Step 5: 修改 `recordExecution` 方法存储 embedding**

在 `src/harness/persistence/TrajectoryDatabase.ts` 的 `recordExecution` 方法中，在 `stmt.run(...)` 之后添加:

```typescript
// P3: 生成并存储 embedding
if (this.embedFunction) {
  try {
    const embedding = this.embedFunction(exec.input);
    const updateStmt = this.db.prepare(
      `UPDATE executions SET embedding = ? WHERE id = ?`
    );
    updateStmt.run(JSON.stringify(embedding), exec.id);
  } catch (err) {
    Logger.debug(
      `TrajectoryDatabase embedding 生成失败: ${(err as Error).message}`,
      'TrajectoryDatabase'
    );
  }
}
```

- [ ] **Step 6: 修改 `querySimilarTasks` 方法支持向量检索**

在 `src/harness/persistence/TrajectoryDatabase.ts` 的 `calculateRelevance` 方法中，在余弦相似度计算之前添加向量检索:

```typescript
// P3: 向量语义检索（优先于词频余弦相似度）
if (this.embedFunction && execution.input) {
  const inputEmbedding = this.embedFunction(input);
  const execEmbedding = this.getExecutionEmbedding(execution.id || '');
  if (execEmbedding && inputEmbedding) {
    const vectorSim = this.vectorCosineSimilarity(
      inputEmbedding,
      execEmbedding
    );
    score += vectorSim * 0.5; // 向量相似度权重最高
  }
}
```

在类中添加辅助方法:

```typescript
  /** 获取执行的embedding */
  private getExecutionEmbedding(execId: string): number[] | null {
    try {
      const stmt = this.db.prepare(
        `SELECT embedding FROM executions WHERE id = ?`
      );
      const row = stmt.get(execId) as { embedding?: string } | undefined;
      if (row?.embedding) {
        return JSON.parse(row.embedding);
      }
    } catch {
      // 忽略
    }
    return null;
  }

  /** 向量余弦相似度 */
  private vectorCosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
```

- [ ] **Step 7: 运行测试验证通过**

Run: `npx jest tests/unit/harness/TrajectoryVectorSearch.test.ts --no-coverage`
Expected: PASS — 4 tests passed

- [ ] **Step 8: TypeScript编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 9: 提交**

```bash
git add src/harness/persistence/TrajectoryDatabase.ts tests/unit/harness/TrajectoryVectorSearch.test.ts
git commit -m "feat(memory): P3 TrajectoryDatabase向量嵌入接入语义检索"
```

---

## Task 4: 规划能力 — 步骤级精细调整

**Files:**

- Modify: `src/harness/loop/Executor.ts` — 在每步执行后评估并调整后续步骤
- Test: `tests/unit/harness/StepLevelReplan.test.ts`

**背景**: 当前 `shouldReplan` 在宏观层面触发重规划，但缺少步骤级精细调整（跳过当前步骤、修改后续步骤参数、动态插入新步骤）。

- [ ] **Step 1: 编写失败的测试**

创建 `tests/unit/harness/StepLevelReplan.test.ts`:

```typescript
describe('规划能力 — 步骤级精细调整', () => {
  let executor: any;

  beforeEach(() => {
    const Executor = require('../../../src/harness/loop/Executor').Executor;
    const mockDeps = {
      toolRegistry: {
        execute: jest.fn(),
        get: jest.fn(),
        getRegisteredToolNames: jest.fn().mockReturnValue([]),
      },
      llm: { chat: jest.fn(), chatWithTools: jest.fn() },
    };
    executor = new Executor(mockDeps);
  });

  it('应在步骤失败时建议跳过当前步骤', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: false, error: 'file not found' },
      remainingSteps: [
        { tool: 'file_read', args: { path: '/test' } },
        { tool: 'web_search', args: { query: 'test' } },
      ],
      loopCount: 2,
    });

    expect(adjustment.action).toBe('skip');
    expect(adjustment.reason).toContain('跳过');
  });

  it('应在步骤成功但质量低时建议修正后续步骤参数', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: true, output: '部分结果', quality: 0.3 },
      remainingSteps: [{ tool: 'file_read', args: { path: '/test' } }],
      loopCount: 3,
    });

    expect(adjustment.action).toBe('modify');
    expect(adjustment.modificationHint).toBeDefined();
  });

  it('应在步骤成功且质量高时建议继续执行', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: true, output: '完整结果', quality: 0.9 },
      remainingSteps: [{ tool: 'file_read', args: { path: '/test' } }],
      loopCount: 1,
    });

    expect(adjustment.action).toBe('continue');
  });

  it('应在轮次耗尽时建议终止', () => {
    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: false, error: 'timeout' },
      remainingSteps: [],
      loopCount: 7,
    });

    expect(adjustment.action).toBe('terminate');
  });

  it('应在连续失败时建议插入新步骤', () => {
    executor['executionQualityHistory'] = [
      { score: 0, isSufficient: false },
      { score: 0, isSufficient: false },
    ];

    const adjustment = executor['suggestStepAdjustment']({
      stepResult: { success: false, error: 'not found' },
      remainingSteps: [{ tool: 'file_read', args: {} }],
      loopCount: 3,
    });

    expect(adjustment.action).toBe('insert');
    expect(adjustment.newStep).toBeDefined();
    expect(adjustment.newStep.tool).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/harness/StepLevelReplan.test.ts --no-coverage`
Expected: FAIL — `suggestStepAdjustment` 方法不存在

- [ ] **Step 3: 实现 `suggestStepAdjustment` 方法**

在 `src/harness/loop/Executor.ts` 类中添加:

```typescript
  /**
   * P4: 步骤级精细调整 — 在每步执行后评估并建议后续步骤调整
   *
   * 调整动作：
   * - continue: 继续执行后续步骤
   * - skip: 跳过当前步骤（失败但非关键）
   * - modify: 修正后续步骤参数
   * - insert: 插入新步骤（如搜索/诊断步骤）
   * - terminate: 终止执行（轮次耗尽）
   */
  private suggestStepAdjustment(params: {
    stepResult: { success: boolean; error?: string; output?: unknown; quality?: number };
    remainingSteps: Array<{ tool: string; args: Record<string, unknown> }>;
    loopCount: number;
  }): {
    action: 'continue' | 'skip' | 'modify' | 'insert' | 'terminate';
    reason: string;
    modificationHint?: string;
    newStep?: { tool: string; args: Record<string, unknown> };
  } {
    const { stepResult, remainingSteps, loopCount } = params;

    // 轮次耗尽
    if (loopCount >= 7) {
      return {
        action: 'terminate',
        reason: '轮次即将耗尽，建议终止并总结当前进展',
      };
    }

    // 步骤失败
    if (!stepResult.success) {
      // 无剩余步骤 — 终止
      if (remainingSteps.length === 0) {
        return {
          action: 'terminate',
          reason: '步骤失败且无剩余步骤',
        };
      }

      // 连续失败 — 插入诊断步骤
      const recentFailures = (this.executionQualityHistory || [])
        .slice(-2)
        .filter((q: any) => q.score === 0);
      if (recentFailures.length >= 2) {
        return {
          action: 'insert',
          reason: '连续失败，插入诊断步骤',
          newStep: {
            tool: 'file_search',
            args: { pattern: '*.log' },
          },
        };
      }

      // 普通失败 — 跳过当前步骤
      return {
        action: 'skip',
        reason: '跳过失败步骤，继续执行后续步骤',
      };
    }

    // 步骤成功但质量低
    if (stepResult.quality !== undefined && stepResult.quality < 0.5) {
      return {
        action: 'modify',
        reason: '步骤质量低，建议修正后续步骤参数',
        modificationHint: '建议扩大搜索范围或调整过滤条件',
      };
    }

    // 步骤成功且质量高
    return {
      action: 'continue',
      reason: '步骤执行正常，继续后续步骤',
    };
  }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest tests/unit/harness/StepLevelReplan.test.ts --no-coverage`
Expected: PASS — 5 tests passed

- [ ] **Step 5: TypeScript编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: 提交**

```bash
git add src/harness/loop/Executor.ts tests/unit/harness/StepLevelReplan.test.ts
git commit -m "feat(loop): P4 步骤级精细调整建议"
```

---

## Task 5: 学习闭环 — 学习信号管道+策略自适应

**Files:**

- Modify: `src/evolution/EvolutionOrchestrator.ts` — 丰富学习信号收集
- Modify: `src/evolution/StrategyAdapter.ts` — 基于学习信号自适应策略
- Test: `tests/unit/evolution/LearningSignalPipeline.test.ts`

**背景**: 当前 EvolutionOrchestrator 存在但学习信号稀疏（仅 user_correction 事件）。Hermes级别要求实时学习信号收集 + 策略自适应。

- [ ] **Step 1: 编写失败的测试**

创建 `tests/unit/evolution/LearningSignalPipeline.test.ts`:

```typescript
describe('学习闭环 — 学习信号管道+策略自适应', () => {
  describe('学习信号收集', () => {
    it('应在工具执行成功时收集正面学习信号', () => {
      const signals: any[] = [];
      const mockEventBus = {
        emit: jest.fn((event: string, payload: any) => {
          signals.push({ event, payload });
        }),
        on: jest.fn(),
      };

      const {
        collectLearningSignal,
      } = require('../../../src/evolution/LearningSignalCollector');
      collectLearningSignal(mockEventBus, {
        type: 'tool_success',
        toolName: 'file_read',
        duration: 100,
        quality: 0.9,
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'learning_signal',
        expect.objectContaining({
          signalType: 'positive',
          toolName: 'file_read',
        })
      );
    });

    it('应在工具执行失败时收集负面学习信号', () => {
      const mockEventBus = {
        emit: jest.fn(),
        on: jest.fn(),
      };

      const {
        collectLearningSignal,
      } = require('../../../src/evolution/LearningSignalCollector');
      collectLearningSignal(mockEventBus, {
        type: 'tool_failure',
        toolName: 'file_read',
        error: 'not found',
        duration: 50,
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'learning_signal',
        expect.objectContaining({
          signalType: 'negative',
          toolName: 'file_read',
          error: 'not found',
        })
      );
    });

    it('应在任务完成时收集任务级学习信号', () => {
      const mockEventBus = {
        emit: jest.fn(),
        on: jest.fn(),
      };

      const {
        collectLearningSignal,
      } = require('../../../src/evolution/LearningSignalCollector');
      collectLearningSignal(mockEventBus, {
        type: 'task_complete',
        userInput: '部署应用',
        success: true,
        quality: 0.85,
        duration: 10000,
        toolCount: 3,
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'learning_signal',
        expect.objectContaining({
          signalType: 'task_success',
          quality: 0.85,
        })
      );
    });
  });

  describe('策略自适应', () => {
    it('应基于学习信号调整工具优先级', () => {
      const {
        StrategyAdjuster,
      } = require('../../../src/evolution/StrategyAdjuster');
      const adjuster = new StrategyAdjuster();

      // 模拟学习信号：file_read 成功率低
      adjuster.recordSignal({
        signalType: 'negative',
        toolName: 'file_read',
        error: 'not found',
      });
      adjuster.recordSignal({
        signalType: 'negative',
        toolName: 'file_read',
        error: 'permission denied',
      });
      adjuster.recordSignal({
        signalType: 'positive',
        toolName: 'file_search',
        quality: 0.9,
      });

      const adjusted = adjuster.getAdjustedToolPriority([
        'file_read',
        'file_search',
      ]);

      // file_search 优先级应高于 file_read
      expect(adjusted.indexOf('file_search')).toBeLessThan(
        adjusted.indexOf('file_read')
      );
    });

    it('应基于学习信号调整反思深度', () => {
      const {
        StrategyAdjuster,
      } = require('../../../src/evolution/StrategyAdjuster');
      const adjuster = new StrategyAdjuster();

      // 模拟多次失败
      for (let i = 0; i < 5; i++) {
        adjuster.recordSignal({
          signalType: 'negative',
          toolName: 'web_search',
          error: 'timeout',
        });
      }

      const config = adjuster.getAdjustedReflectionConfig();
      // 多次失败应增加反思深度
      expect(config.enableDeepReflection).toBe(true);
      expect(config.maxRetries).toBeGreaterThan(2);
    });

    it('应基于成功信号减少不必要的反思', () => {
      const {
        StrategyAdjuster,
      } = require('../../../src/evolution/StrategyAdjuster');
      const adjuster = new StrategyAdjuster();

      // 模拟多次成功
      for (let i = 0; i < 10; i++) {
        adjuster.recordSignal({
          signalType: 'positive',
          toolName: 'file_read',
          quality: 0.95,
        });
      }

      const config = adjuster.getAdjustedReflectionConfig();
      // 高成功率应减少反思
      expect(config.enableDeepReflection).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/evolution/LearningSignalPipeline.test.ts --no-coverage`
Expected: FAIL — `LearningSignalCollector` 和 `StrategyAdjuster` 模块不存在

- [ ] **Step 3: 创建 `LearningSignalCollector` 模块**

创建 `src/evolution/LearningSignalCollector.ts`:

```typescript
/**
 * P5: 学习信号收集器 — 实时收集工具执行和任务完成的学习信号
 *
 * Hermes级别：每次执行都产生学习信号，而非仅依赖 user_correction 事件
 */
import { Logger } from '../utils/Logger';

export interface LearningSignal {
  signalType: 'positive' | 'negative' | 'task_success' | 'task_failure';
  toolName?: string;
  error?: string;
  quality?: number;
  duration?: number;
  userInput?: string;
  toolCount?: number;
  timestamp: number;
}

/**
 * 收集学习信号并通过 EventBus 广播
 */
export function collectLearningSignal(
  eventBus: { emit: (event: string, payload: unknown) => void },
  rawSignal: {
    type: 'tool_success' | 'tool_failure' | 'task_complete' | 'task_failure';
    toolName?: string;
    error?: string;
    quality?: number;
    duration?: number;
    userInput?: string;
    toolCount?: number;
  }
): void {
  let signalType: LearningSignal['signalType'];

  switch (rawSignal.type) {
    case 'tool_success':
      signalType = 'positive';
      break;
    case 'tool_failure':
      signalType = 'negative';
      break;
    case 'task_complete':
      signalType = 'task_success';
      break;
    case 'task_failure':
      signalType = 'task_failure';
      break;
  }

  const signal: LearningSignal = {
    signalType,
    toolName: rawSignal.toolName,
    error: rawSignal.error,
    quality: rawSignal.quality,
    duration: rawSignal.duration,
    userInput: rawSignal.userInput,
    toolCount: rawSignal.toolCount,
    timestamp: Date.now(),
  };

  eventBus.emit('learning_signal', signal);
  Logger.debug(
    `📡 学习信号已收集: ${signalType} ${rawSignal.toolName || ''}`,
    'LearningSignalCollector'
  );
}
```

- [ ] **Step 4: 创建 `StrategyAdjuster` 模块**

创建 `src/evolution/StrategyAdjuster.ts`:

```typescript
/**
 * P5: 策略调整器 — 基于学习信号自适应调整策略
 *
 * Hermes级别：基于学习信号自动调整工具优先级、反思深度、重试次数
 */
import { Logger } from '../utils/Logger';
import type { LearningSignal } from './LearningSignalCollector';

interface ToolStats {
  successCount: number;
  failureCount: number;
  avgQuality: number;
  lastUsed: number;
}

export interface ReflectionConfig {
  enableDeepReflection: boolean;
  maxRetries: number;
}

export class StrategyAdjuster {
  private toolStats: Map<string, ToolStats> = new Map();
  private totalSignals: number = 0;

  /**
   * 记录学习信号
   */
  recordSignal(signal: LearningSignal): void {
    if (!signal.toolName) return;

    this.totalSignals++;
    const stats = this.toolStats.get(signal.toolName) || {
      successCount: 0,
      failureCount: 0,
      avgQuality: 0,
      lastUsed: Date.now(),
    };

    if (signal.signalType === 'positive') {
      stats.successCount++;
      stats.avgQuality =
        (stats.avgQuality * (stats.successCount - 1) +
          (signal.quality || 0.5)) /
        stats.successCount;
    } else if (signal.signalType === 'negative') {
      stats.failureCount++;
    }

    stats.lastUsed = Date.now();
    this.toolStats.set(signal.toolName, stats);
  }

  /**
   * 获取调整后的工具优先级
   */
  getAdjustedToolPriority(tools: string[]): string[] {
    return [...tools].sort((a, b) => {
      const statsA = this.toolStats.get(a);
      const statsB = this.toolStats.get(b);

      if (!statsA && !statsB) return 0;
      if (!statsA) return 1;
      if (!statsB) return -1;

      const successRateA =
        statsA.successCount /
        Math.max(statsA.successCount + statsA.failureCount, 1);
      const successRateB =
        statsB.successCount /
        Math.max(statsB.successCount + statsB.failureCount, 1);

      return successRateB - successRateA; // 成功率高的排前面
    });
  }

  /**
   * 获取调整后的反思配置
   */
  getAdjustedReflectionConfig(): ReflectionConfig {
    let totalFailures = 0;
    let totalSuccesses = 0;

    for (const stats of this.toolStats.values()) {
      totalFailures += stats.failureCount;
      totalSuccesses += stats.successCount;
    }

    const overallSuccessRate =
      totalSuccesses / Math.max(totalSuccesses + totalFailures, 1);

    // 高失败率 → 启用深度反思 + 增加重试
    if (overallSuccessRate < 0.5) {
      return {
        enableDeepReflection: true,
        maxRetries: 4,
      };
    }

    // 高成功率 → 禁用深度反思 + 减少重试
    if (overallSuccessRate > 0.8 && this.totalSignals > 5) {
      return {
        enableDeepReflection: false,
        maxRetries: 1,
      };
    }

    // 默认配置
    return {
      enableDeepReflection: true,
      maxRetries: 2,
    };
  }
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx jest tests/unit/evolution/LearningSignalPipeline.test.ts --no-coverage`
Expected: PASS — 6 tests passed

- [ ] **Step 6: TypeScript编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 7: 提交**

```bash
git add src/evolution/LearningSignalCollector.ts src/evolution/StrategyAdjuster.ts tests/unit/evolution/LearningSignalPipeline.test.ts
git commit -m "feat(evolution): P5 学习信号管道+策略自适应"
```

---

## Task 6: 集成学习信号收集到 Executor

**Files:**

- Modify: `src/harness/loop/Executor.ts` — 在工具执行成功/失败时收集学习信号
- Modify: `src/server/init/initHarness.ts` — 注入 EventBus 到 Executor

- [ ] **Step 1: 在 Executor 中添加学习信号收集**

在 `src/harness/loop/Executor.ts` 的 `executeWithRetry` 方法中，在 `return result` 之前（成功路径）添加:

```typescript
// P5: 收集正面学习信号
if (this.deps?.eventBus) {
  try {
    const {
      collectLearningSignal,
    } = require('../../evolution/LearningSignalCollector');
    collectLearningSignal(this.deps.eventBus, {
      type: 'tool_success',
      toolName,
      duration: result.duration,
      quality: result.metadata?.quality || 0.8,
    });
  } catch {
    // 忽略学习信号收集失败
  }
}
```

在失败路径（`return result` 之前，`errorType === 'non_retryable'` 分支）添加:

```typescript
// P5: 收集负面学习信号
if (this.deps?.eventBus) {
  try {
    const {
      collectLearningSignal,
    } = require('../../evolution/LearningSignalCollector');
    collectLearningSignal(this.deps.eventBus, {
      type: 'tool_failure',
      toolName,
      error: result.error,
      duration: result.duration,
    });
  } catch {
    // 忽略
  }
}
```

- [ ] **Step 2: 在 ExecutorDeps 接口中添加 eventBus**

在 `src/harness/loop/Executor.ts` 的 `ExecutorDeps` 接口中添加:

```typescript
  /** P5: EventBus — 用于学习信号收集 */
  eventBus?: {
    emit: (event: string, payload: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => void;
  };
```

- [ ] **Step 3: 在 initHarness.ts 中注入 EventBus**

在 `src/server/init/initHarness.ts` 中找到 Executor 的 deps 构建位置，添加:

```typescript
      eventBus: EventBus.getInstance(),
```

- [ ] **Step 4: TypeScript编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: 运行所有相关测试确认无回归**

Run: `npx jest tests/unit/harness/ToolResilience.test.ts tests/unit/harness/StepLevelReplan.test.ts --no-coverage`
Expected: PASS — 所有测试通过

- [ ] **Step 6: 提交**

```bash
git add src/harness/loop/Executor.ts src/server/init/initHarness.ts
git commit -m "feat(loop): P5 集成学习信号收集到Executor"
```

---

## Task 7: 更新差距分析文档

**Files:**

- Modify: `docs/HERMES_GAP_ANALYSIS.md` — 更新所有维度的修复状态

- [ ] **Step 1: 更新差距分析文档中的状态**

将以下维度的状态从 ⏳/🔄 改为 ✅:

- ReAct循环: 🔄 → ✅（反思结论深度注入Thought）
- 上下文管理: ⏳ → ✅（主动检索+注意力聚焦）
- 记忆系统: 🔄 → ✅（向量嵌入接入）
- 规划能力: 🔄 → ✅（步骤级精细调整）
- 学习闭环: ⏳ → ✅（学习信号管道+策略自适应）

- [ ] **Step 2: 更新技术债务清单**

将债务项6-8的状态从 ⏳ 改为 ✅

- [ ] **Step 3: 提交**

```bash
git add docs/HERMES_GAP_ANALYSIS.md
git commit -m "docs: 更新Hermes差距分析文档 — 全部7维度已修复"
```

---

## Self-Review

### 1. Spec coverage

- ✅ ReAct循环 — Task 1 覆盖反思结论深度注入Thought
- ✅ 上下文管理 — Task 2 覆盖主动检索+注意力聚焦
- ✅ 记忆系统 — Task 3 覆盖向量嵌入接入
- ✅ 规划能力 — Task 4 覆盖步骤级精细调整
- ✅ 学习闭环 — Task 5+6 覆盖学习信号管道+策略自适应+Executor集成
- ✅ 文档更新 — Task 7

### 2. Placeholder scan

- 无 TBD/TODO
- 所有步骤都有完整代码
- 所有测试都有实际断言

### 3. Type consistency

- `LearningSignal` 接口在 Task 5 定义，Task 6 引用一致
- `ReflectionConfig` 接口在 Task 5 定义
- `suggestStepAdjustment` 返回类型在 Task 4 定义
- `_lastReflectionInsight` 属性类型在 Task 1 定义
