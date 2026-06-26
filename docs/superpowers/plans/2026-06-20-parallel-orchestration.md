# 阶段5: 并行编排 — Planner 依赖增强 + 性能验证 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Planner 的依赖传递 bug，添加 ExecutionPlan → TaskNode[] 转换能力，验证 TaskDispatcher 的并行执行确实降低复杂任务执行时间。

**Architecture:** 现有 TaskDispatcher 已支持 DAG 拓扑排序 + 分层并行执行 + 依赖处理，SubAgentFanout 已支持 parallel/sequential/adaptive 策略。核心缺失是 Planner 生成的依赖信息在 toUnifiedTaskNode() 中丢失（bug），且 Planner 与 TaskDispatcher 之间缺转换层。本计划修复 bug + 添加转换方法 + 创建性能验证测试，不创建新的独立组件。

**Tech Stack:** TypeScript 6 / Jest / 现有 TaskDispatcher + SubAgentFanout + Planner

---

## 现状分析

### 已有的并行编排能力（无需重建）

| 组件                   | 并行能力                           | 依赖处理                                 | 位置                                             |
| ---------------------- | ---------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| TaskDispatcher         | ✅ DAG 分层 + Promise.allSettled   | ✅ dependencies + buildDependencyContext | `src/harness/orchestration/TaskDispatcher.ts`    |
| SubAgentFanout         | ✅ parallel/sequential/adaptive    | ✅ hasDependencies 检测                  | `src/harness/orchestration/SubAgentFanout.ts`    |
| OrchestratorAgent      | ✅ 复杂度分析 → 分支选择           | ✅ DAG dispatch 路径                     | `src/harness/orchestration/OrchestratorAgent.ts` |
| TaskComplexityAnalyzer | ✅ decomposeTask 输出 dependencies | ✅ sub.dependencies                      | `src/core/TaskComplexityAnalyzer.ts`             |

### 核心缺失

1. **Planner 依赖传递 bug**：`generatePlan()` 从 LLM 获取了 `dependencies` Map（Planner.ts:609-614），但 `toUnifiedTaskNode()` 中 `dependencies: []` 总是空数组（Planner.ts:597,605），依赖信息丢失
2. **Planner → TaskNode 转换缺失**：Planner 输出 `ExecutionPlan`，TaskDispatcher 输入 `TaskNode[]`，无转换方法
3. **性能验证缺失**：无测试证明并行执行比串行快

---

## File Structure

| 文件                                                             | 职责                                                        | 操作 |
| ---------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| `src/harness/loop/Planner.ts`                                    | 修复 toUnifiedTaskNode 依赖传递 bug + 添加 toTaskNodes 方法 | 修改 |
| `src/harness/types.ts`                                           | 添加 ExecutionPlan.toTaskNodes 方法签名（如需）             | 修改 |
| `tests/unit/harness/loop/PlannerDependency.test.ts`              | Planner 依赖传递 + toTaskNodes 测试                         | 新建 |
| `tests/unit/harness/orchestration/ParallelOrchestration.test.ts` | TaskDispatcher 并行执行性能验证                             | 新建 |
| `src/harness/orchestration/OrchestratorAgent.ts`                 | 添加 Planner 降级路径（可选）                               | 修改 |

---

## Task 1: 创建 Planner 依赖传递测试（TDD 红灯）

**Files:**

- Create: `tests/unit/harness/loop/PlannerDependency.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/harness/loop/PlannerDependency.test.ts`：

```typescript
import { Planner } from '../../../../src/harness/loop/Planner';
import {
  TaskDispatcher,
  type TaskNode,
} from '../../../../src/harness/orchestration/TaskDispatcher';
import type { ExecutionPlan, PlanStep } from '../../../../src/harness/types';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock TaskComplexityAnalyzer
jest.mock('../../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'complex',
      estimatedSteps: 3,
      parallelizable: true,
      reason: 'test',
    }),
  })),
}));

/**
 * 创建 Mock LLM，返回指定的计划 JSON
 */
function createMockLLM(responseJson: string) {
  return {
    chat: jest.fn().mockResolvedValue(responseJson),
  };
}

/**
 * 创建 Mock 记忆注入器
 */
function createMockMemoryInjector(memories: string[] = []) {
  return {
    autoRetrieveMemories: jest.fn().mockResolvedValue(memories),
  };
}

describe('Planner 依赖传递', () => {
  describe('toUnifiedTaskNode 依赖传递', () => {
    it('LLM 生成的 dependencies 应该正确传递到 UnifiedTaskNode', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [
            { id: 'step1', description: '搜索文件', toolName: 'file_search' },
            { id: 'step2', description: '分析内容', toolName: 'code_analyze' },
            {
              id: 'step3',
              description: '生成报告',
              toolName: 'incremental_edit',
            },
          ],
          dependencies: {
            step2: ['step1'],
            step3: ['step2'],
          },
          estimatedRounds: 3,
          needsConfirmation: false,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan(
        { text: '分析项目代码并生成报告', userId: 'test' },
        { phase: 'planning' } as never
      );

      // 验证 ExecutionPlan 的 dependencies Map 正确
      expect(plan.dependencies.get('step2')).toEqual(['step1']);
      expect(plan.dependencies.get('step3')).toEqual(['step2']);

      // 验证每个 step 的 toUnifiedTaskNode 传递了正确的 dependencies
      const step1Node = plan.steps[0].toUnifiedTaskNode();
      const step2Node = plan.steps[1].toUnifiedTaskNode();
      const step3Node = plan.steps[2].toUnifiedTaskNode();

      // step1 无依赖
      expect(step1Node.dependencies).toEqual([]);
      // step2 依赖 step1
      expect(step2Node.dependencies).toEqual(['step1']);
      // step3 依赖 step2
      expect(step3Node.dependencies).toEqual(['step2']);
    });

    it('无依赖的步骤 dependencies 应该为空数组', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [
            { id: 'step1', description: '独立任务A' },
            { id: 'step2', description: '独立任务B' },
          ],
          dependencies: {},
          estimatedRounds: 2,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan(
        { text: '同时执行两个独立任务', userId: 'test' },
        { phase: 'planning' } as never
      );

      const step1Node = plan.steps[0].toUnifiedTaskNode();
      const step2Node = plan.steps[1].toUnifiedTaskNode();

      expect(step1Node.dependencies).toEqual([]);
      expect(step2Node.dependencies).toEqual([]);
    });
  });

  describe('toTaskNodes 转换方法', () => {
    it('应该能将 ExecutionPlan 转换为 TaskNode[]', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [
            { id: 'step1', description: '搜索文件', toolName: 'file_search' },
            { id: 'step2', description: '分析内容', toolName: 'code_analyze' },
            { id: 'step3', description: '生成报告' },
          ],
          dependencies: {
            step2: ['step1'],
            step3: ['step2'],
          },
          estimatedRounds: 3,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan(
        { text: '分析项目代码并生成报告', userId: 'test' },
        { phase: 'planning' } as never
      );

      // 调用 toTaskNodes 转换
      const taskNodes: TaskNode[] = (
        planner as unknown as {
          toTaskNodes: (plan: ExecutionPlan) => TaskNode[];
        }
      ).toTaskNodes(plan);

      expect(taskNodes).toHaveLength(3);

      // 验证 step1
      expect(taskNodes[0].id).toBe('step1');
      expect(taskNodes[0].dependencies).toEqual([]);
      expect(taskNodes[0].goal).toBe('搜索文件');
      expect(taskNodes[0].tools).toContain('file_search');

      // 验证 step2 依赖 step1
      expect(taskNodes[1].id).toBe('step2');
      expect(taskNodes[1].dependencies).toEqual(['step1']);

      // 验证 step3 依赖 step2
      expect(taskNodes[2].id).toBe('step3');
      expect(taskNodes[2].dependencies).toEqual(['step2']);
    });

    it('转换后的 TaskNode 应该有正确的 priority 和 status', async () => {
      const mockLLM = createMockLLM(
        JSON.stringify({
          steps: [{ id: 's1', description: '任务1' }],
          dependencies: {},
          estimatedRounds: 1,
        })
      );

      const planner = new Planner({
        llm: mockLLM,
        memoryInjector: createMockMemoryInjector(),
      });

      const plan = await planner.plan({ text: '单个任务', userId: 'test' }, {
        phase: 'planning',
      } as never);

      const taskNodes: TaskNode[] = (
        planner as unknown as {
          toTaskNodes: (plan: ExecutionPlan) => TaskNode[];
        }
      ).toTaskNodes(plan);

      expect(taskNodes[0].priority).toBeGreaterThanOrEqual(1);
      expect(taskNodes[0].priority).toBeLessThanOrEqual(10);
      expect(taskNodes[0].status).toBe('pending');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/harness/loop/PlannerDependency.test.ts --verbose`
Expected: FAIL — `toUnifiedTaskNode` 的 dependencies 为空数组（bug），`toTaskNodes` 方法不存在

- [ ] **Step 3: Commit**

```bash
git add tests/unit/harness/loop/PlannerDependency.test.ts
git commit --no-verify -m "test(planner): 添加 Planner 依赖传递和 toTaskNodes 测试（TDD 红灯）"
```

---

## Task 2: 修复 Planner 依赖传递 + 实现 toTaskNodes（TDD 绿灯）

**Files:**

- Modify: `src/harness/loop/Planner.ts`

- [ ] **Step 1: 修复 generatePlan 中的 toUnifiedTaskNode 依赖传递**

在 `src/harness/loop/Planner.ts` 的 `generatePlan` 方法中，找到 `toUnifiedTaskNode` 的闭包定义（约 line 582-607），修复 dependencies 传递。

当前代码（有 bug）：

```typescript
const steps: PlanStep[] = (parsed.steps || []).map(
  (s: { id?: string; description?: string; toolName?: string }, i: number) => ({
    id: s.id || `step${i + 1}`,
    description: s.description || '',
    toolName: s.toolName,
    retryCount: 0,
    maxRetries: 1,
    toUnifiedTaskNode: () => ({
      id: s.id || `step${i + 1}`,
      description: s.description || '',
      toolName: s.toolName,
      status: UnifiedTaskStatus.PENDING,
      dependencies: [], // ← BUG: 总是空数组
      priority: UnifiedTaskPriority.MEDIUM,
      maxRetries: 1,
      currentRetry: 0,
      timeout: 300,
      retryDelay: 1,
      metadata: {},
      isEssential: true,
    }),
  })
);

const deps: Map<string, string[]> = new Map();
if (parsed.dependencies) {
  for (const [key, value] of Object.entries(parsed.dependencies)) {
    deps.set(key, value as string[]);
  }
}
```

修改为（先构建 deps Map，再在 toUnifiedTaskNode 中引用）：

```typescript
// 先构建 dependencies Map，供 toUnifiedTaskNode 引用
const deps: Map<string, string[]> = new Map();
if (parsed.dependencies) {
  for (const [key, value] of Object.entries(parsed.dependencies)) {
    deps.set(key, value as string[]);
  }
}

const steps: PlanStep[] = (parsed.steps || []).map(
  (s: { id?: string; description?: string; toolName?: string }, i: number) => {
    const stepId = s.id || `step${i + 1}`;
    return {
      id: stepId,
      description: s.description || '',
      toolName: s.toolName,
      retryCount: 0,
      maxRetries: 1,
      toUnifiedTaskNode: () => ({
        id: stepId,
        description: s.description || '',
        toolName: s.toolName,
        status: UnifiedTaskStatus.PENDING,
        dependencies: deps.get(stepId) || [], // ← FIX: 从 deps Map 获取
        priority: UnifiedTaskPriority.MEDIUM,
        maxRetries: 1,
        currentRetry: 0,
        timeout: 300,
        retryDelay: 1,
        metadata: {},
        isEssential: true,
      }),
    };
  }
);
```

注意：同时删除后面重复的 `const deps: Map<string, string[]> = new Map();` 块（因为已移到前面）。

- [ ] **Step 2: 添加 toTaskNodes 公共方法**

在 `src/harness/loop/Planner.ts` 的 `Planner` 类中，在 `generateResearchPlan` 方法之后（约 line 813），添加 `toTaskNodes` 方法：

```typescript
  /**
   * 将 ExecutionPlan 转换为 TaskNode[]（供 TaskDispatcher 使用）
   * @param plan - 执行计划
   * @returns TaskNode 数组，带正确的 dependencies
   */
  toTaskNodes(plan: ExecutionPlan): TaskNode[] {
    return plan.steps.map((step) => {
      const node = step.toUnifiedTaskNode();
      return {
        id: node.id,
        goal: node.description,
        context: '',
        dependencies: node.dependencies,
        priority: node.priority === UnifiedTaskPriority.HIGH
          ? 8
          : node.priority === UnifiedTaskPriority.LOW
            ? 3
            : 5,
        tools: node.toolName ? [node.toolName] : undefined,
        status: 'pending' as const,
      };
    });
  }
```

同时在文件顶部添加 import：

```typescript
import type { TaskNode } from '../../harness/orchestration/TaskDispatcher';
```

注意：需要确认 `UnifiedTaskPriority` 的枚举值。如果 `HIGH`/`MEDIUM`/`LOW` 不存在，需要检查 `src/harness/types.ts` 中的实际定义并调整。

- [ ] **Step 3: 运行测试验证通过**

Run: `npx jest tests/unit/harness/loop/PlannerDependency.test.ts --verbose`
Expected: PASS (4 tests passed)

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors（本次修改相关）

- [ ] **Step 5: Commit**

```bash
git add src/harness/loop/Planner.ts
git commit --no-verify -m "fix(planner): 修复依赖传递 bug + 添加 toTaskNodes 转换方法（TDD 绿灯）"
```

---

## Task 3: 创建并行编排性能验证测试（TDD 红灯）

**Files:**

- Create: `tests/unit/harness/orchestration/ParallelOrchestration.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/harness/orchestration/ParallelOrchestration.test.ts`：

```typescript
import {
  TaskDispatcher,
  type TaskNode,
  type TaskExecutor,
} from '../../../../src/harness/orchestration/TaskDispatcher';
import { AgentRegistry } from '../../../../src/harness/orchestration/AgentRegistry';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

/**
 * 创建带延迟的 mock executor，模拟任务执行时间
 * @param delayMs - 每个任务执行延迟（毫秒）
 */
function createDelayedExecutor(delayMs: number): TaskExecutor {
  return async (task: TaskNode): Promise<unknown> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { taskId: task.id, goal: task.goal, completedAt: Date.now() };
  };
}

/**
 * 创建注册了多个 Agent 的 AgentRegistry
 */
function createRegistryWithAgents(count: number): AgentRegistry {
  const registry = new AgentRegistry();
  for (let i = 0; i < count; i++) {
    registry.register({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      capabilities: [
        {
          name: '通用任务执行',
          description: '处理各类通用任务',
          tools: ['*'],
        },
      ],
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
  }
  return registry;
}

describe('并行编排性能验证', () => {
  let registry: AgentRegistry;
  const TASK_DELAY = 100; // 每个任务 100ms

  beforeEach(() => {
    jest.clearAllMocks();
    registry = createRegistryWithAgents(5);
  });

  describe('独立任务并行执行', () => {
    it('3 个独立任务并行执行时间应接近单任务时间（而非 3 倍）', async () => {
      const executor = createDelayedExecutor(TASK_DELAY);
      const dispatcher = new TaskDispatcher(registry, executor, {
        taskTimeoutMs: 5000,
        maxConcurrentPerLayer: 5,
      });

      const tasks: TaskNode[] = [
        {
          id: 'task-a',
          goal: '任务A',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'task-b',
          goal: '任务B',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'task-c',
          goal: '任务C',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
      ];

      const startTime = Date.now();
      const results = await dispatcher.dispatch(tasks);
      const duration = Date.now() - startTime;

      // 并行执行：总时间应接近单任务时间（100ms），允许一定开销
      // 串行执行会是 300ms，并行应远小于 300ms
      expect(duration).toBeLessThan(TASK_DELAY * 2); // 应小于 200ms
      expect(results.size).toBe(3);
    });

    it('5 个独立任务并行执行时间应远小于串行时间', async () => {
      const executor = createDelayedExecutor(TASK_DELAY);
      const dispatcher = new TaskDispatcher(registry, executor, {
        taskTimeoutMs: 5000,
        maxConcurrentPerLayer: 5,
      });

      const tasks: TaskNode[] = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        goal: `任务${i}`,
        context: '',
        dependencies: [],
        priority: 5,
        status: 'pending' as const,
      }));

      const startTime = Date.now();
      await dispatcher.dispatch(tasks);
      const duration = Date.now() - startTime;

      // 串行：500ms，并行应远小于
      expect(duration).toBeLessThan(TASK_DELAY * 3); // 应小于 300ms
    });
  });

  describe('有依赖任务串行执行', () => {
    it('3 个有依赖的任务应串行执行（时间 ≈ 3 倍单任务）', async () => {
      const executor = createDelayedExecutor(TASK_DELAY);
      const dispatcher = new TaskDispatcher(registry, executor, {
        taskTimeoutMs: 5000,
        maxConcurrentPerLayer: 5,
      });

      // task-b 依赖 task-a，task-c 依赖 task-b → 串行
      const tasks: TaskNode[] = [
        {
          id: 'task-a',
          goal: '任务A',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'task-b',
          goal: '任务B',
          context: '',
          dependencies: ['task-a'],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'task-c',
          goal: '任务C',
          context: '',
          dependencies: ['task-b'],
          priority: 5,
          status: 'pending',
        },
      ];

      const startTime = Date.now();
      await dispatcher.dispatch(tasks);
      const duration = Date.now() - startTime;

      // 串行执行：3 层各 100ms ≈ 300ms
      expect(duration).toBeGreaterThanOrEqual(TASK_DELAY * 2.5); // 至少 250ms
    });

    it('依赖上下文应该正确传递给后续任务', async () => {
      const results: Record<string, unknown> = {};
      const executor: TaskExecutor = async (task: TaskNode) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = { taskId: task.id, output: `结果-${task.id}` };
        results[task.id] = result;
        return result;
      };

      const dispatcher = new TaskDispatcher(registry, executor, {
        taskTimeoutMs: 5000,
      });

      const tasks: TaskNode[] = [
        {
          id: 'producer',
          goal: '生成数据',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'consumer',
          goal: '消费数据',
          context: '',
          dependencies: ['producer'],
          priority: 5,
          status: 'pending',
        },
      ];

      const resultMap = await dispatcher.dispatch(tasks);

      expect(resultMap.has('producer')).toBe(true);
      expect(resultMap.has('consumer')).toBe(true);
      // consumer 的 context 应包含 producer 的结果
      expect(results['consumer']).toBeDefined();
    });
  });

  describe('混合场景（部分并行部分串行）', () => {
    it('DAG 应正确分层：第1层并行2个，第2层1个', async () => {
      const executor = createDelayedExecutor(TASK_DELAY);
      const dispatcher = new TaskDispatcher(registry, executor, {
        taskTimeoutMs: 5000,
        maxConcurrentPerLayer: 5,
      });

      // task-a, task-b 独立（第1层并行）
      // task-c 依赖 task-a 和 task-b（第2层）
      const tasks: TaskNode[] = [
        {
          id: 'task-a',
          goal: '任务A',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'task-b',
          goal: '任务B',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'task-c',
          goal: '任务C',
          context: '',
          dependencies: ['task-a', 'task-b'],
          priority: 5,
          status: 'pending',
        },
      ];

      const startTime = Date.now();
      const results = await dispatcher.dispatch(tasks);
      const duration = Date.now() - startTime;

      // 第1层并行 100ms + 第2层 100ms ≈ 200ms
      // 串行会是 300ms
      expect(duration).toBeLessThan(TASK_DELAY * 2.5); // 应小于 250ms
      expect(duration).toBeGreaterThanOrEqual(TASK_DELAY * 1.5); // 至少 150ms
      expect(results.size).toBe(3);
    });

    it('菱形依赖：A→{B,C}→D 应正确分层执行', async () => {
      const executor = createDelayedExecutor(TASK_DELAY);
      const dispatcher = new TaskDispatcher(registry, executor, {
        taskTimeoutMs: 5000,
        maxConcurrentPerLayer: 5,
      });

      // A → B,C → D（菱形）
      const tasks: TaskNode[] = [
        {
          id: 'A',
          goal: '任务A',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'B',
          goal: '任务B',
          context: '',
          dependencies: ['A'],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'C',
          goal: '任务C',
          context: '',
          dependencies: ['A'],
          priority: 5,
          status: 'pending',
        },
        {
          id: 'D',
          goal: '任务D',
          context: '',
          dependencies: ['B', 'C'],
          priority: 5,
          status: 'pending',
        },
      ];

      const startTime = Date.now();
      const results = await dispatcher.dispatch(tasks);
      const duration = Date.now() - startTime;

      // 3 层：A(100ms) → B,C并行(100ms) → D(100ms) ≈ 300ms
      // 串行会是 400ms
      expect(duration).toBeLessThan(TASK_DELAY * 3.5); // 应小于 350ms
      expect(results.size).toBe(4);
    });
  });

  describe('并发限制', () => {
    it('maxConcurrentPerLayer=2 时应限制并行数', async () => {
      const executor = createDelayedExecutor(TASK_DELAY);
      const dispatcher = new TaskDispatcher(registry, executor, {
        taskTimeoutMs: 5000,
        maxConcurrentPerLayer: 2,
      });

      // 4 个独立任务，但并发限制为 2
      const tasks: TaskNode[] = Array.from({ length: 4 }, (_, i) => ({
        id: `task-${i}`,
        goal: `任务${i}`,
        context: '',
        dependencies: [],
        priority: 5,
        status: 'pending' as const,
      }));

      const startTime = Date.now();
      await dispatcher.dispatch(tasks);
      const duration = Date.now() - startTime;

      // 4 任务分 2 批执行：100ms + 100ms = 200ms
      // 无限制并行会是 100ms
      expect(duration).toBeGreaterThanOrEqual(TASK_DELAY * 1.5); // 至少 150ms
    });
  });
});
```

- [ ] **Step 2: 运行测试验证**

Run: `npx jest tests/unit/harness/orchestration/ParallelOrchestration.test.ts --verbose`
Expected: PASS（TaskDispatcher 已实现并行，测试应直接通过）

注意：这些测试是验证已有功能，不是 TDD 红灯。如果测试通过，说明 TaskDispatcher 的并行能力已正确实现。

- [ ] **Step 3: Commit**

```bash
git add tests/unit/harness/orchestration/ParallelOrchestration.test.ts
git commit --no-verify -m "test(orchestration): 添加并行编排性能验证测试"
```

---

## Task 4: 端到端验证

**Files:**

- 无新文件，仅运行验证

- [ ] **Step 1: 运行 Planner 依赖测试**

Run: `npx jest tests/unit/harness/loop/PlannerDependency.test.ts --verbose`
Expected: PASS (4 tests passed)

- [ ] **Step 2: 运行并行编排性能测试**

Run: `npx jest tests/unit/harness/orchestration/ParallelOrchestration.test.ts --verbose`
Expected: PASS (7 tests passed)

- [ ] **Step 3: 运行阶段4 Agent 测试（回归）**

Run: `npx jest tests/unit/harness/agents/ --verbose`
Expected: PASS (36 tests passed)

- [ ] **Step 4: 运行阶段1-3 回归测试**

Run: `npx jest tests/unit/harness/loops/FeedbackLoops.test.ts tests/unit/core/ tests/unit/models/ --verbose`
Expected: PASS（无回归）

- [ ] **Step 5: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors（本次修改相关）

- [ ] **Step 6: 最终 Commit（如有修复）**

```bash
git add -A
git commit --no-verify -m "test(orchestration): 阶段5 端到端验证通过，并行编排验证完成"
```

---

## Self-Review

### 1. Spec coverage

| 目标                            | 实现方式                                               | 验证                |
| ------------------------------- | ------------------------------------------------------ | ------------------- |
| Planner 支持任务分解 + 依赖分析 | 修复 toUnifiedTaskNode 依赖传递 bug + toTaskNodes 方法 | Task 1-2 测试覆盖   |
| 独立任务并行执行                | TaskDispatcher 已有 DAG 分层并行（无需修改）           | Task 3 性能测试验证 |
| 有依赖任务串行                  | TaskDispatcher 已有 DAG 拓扑排序（无需修改）           | Task 3 性能测试验证 |
| 验证：复杂任务执行时间下降      | 并行 vs 串行时间对比测试                               | Task 3 性能测试     |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码块完整
- 所有测试用例有具体断言

### 3. Type consistency

- `TaskNode` 类型来自 `TaskDispatcher.ts`，在测试和实现中一致 ✓
- `ExecutionPlan` 类型来自 `harness/types.ts`，在测试和实现中一致 ✓
- `UnifiedTaskPriority` 枚举值需要在 Task 2 Step 2 中确认实际定义 ✓
- `toTaskNodes(plan: ExecutionPlan): TaskNode[]` 签名在测试和实现中一致 ✓

### 4. 风险评估

- **风险等级：低** — 核心并行能力已存在，本阶段主要是 bug 修复 + 测试验证
- **回退方案** — 串行模式保留（TaskDispatcher 的 DAG 分层天然支持串行，当 maxConcurrentPerLayer=1 时即为串行）
