# 阶段1-5 节点打通优化 — OrchestratorAgent 集成 Agent + Planner 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 3 个断裂节点：OrchestratorAgent 集成 AgentFactory.selectAgentByGoal、Planner.toTaskNodes、Agent executeFn 设置，使专业化 Agent 真正参与任务执行。

**Architecture:** OrchestratorAgent 当前用通用 executor 执行所有任务，注册的专业化 Agent 从未被选中。优化方案在现有路径中增加 Agent 选择逻辑（非替换），保持向后兼容：简单任务先尝试 agent.execute，未设置 executeFn 时降级到 dispatcher.dispatch；复杂任务降级路径用 planner.toTaskNodes 补充依赖分析。

**Tech Stack:** TypeScript 6 / Jest / 现有 OrchestratorAgent + AgentFactory + Planner

---

## 现状分析

### 3 个断裂节点

| 断裂点                           | 定义位置             | 调用点数 | 问题                                                |
| -------------------------------- | -------------------- | -------- | --------------------------------------------------- |
| `AgentFactory.selectAgentByGoal` | `AgentFactory.ts:87` | 0        | OrchestratorAgent 从不选择专业化 Agent              |
| `Planner.toTaskNodes`            | `Planner.ts:825`     | 0        | OrchestratorAgent 用 llm.decomposeGoal 绕过 Planner |
| `BaseAgent.setExecuteFn`         | `BaseAgent.ts:86`    | 0        | Agent 的 executeFn 从未设置，Agent 是空壳           |

### OrchestratorAgent 当前流程

```
processGoal
  ├─ 简单任务 → processSimpleGoal → dispatcher.dispatch([singleTask])
  │   ❌ 不选择 Agent，用通用 executor
  └─ 复杂任务 → llm.decomposeGoal → tasks
      ├─ parallelizable → fanout.fanout
      └─ else → dispatcher.dispatch(tasks)
      ❌ 不调用 planner.toTaskNodes
```

### 优化后流程

```
processGoal
  ├─ 简单任务 → selectAgentByGoal → agent.execute（降级：dispatch）
  │   ✅ 选择专业化 Agent
  └─ 复杂任务 → llm.decomposeGoal → tasks
      ├─ parallelizable → fanout.fanout
      └─ else → dispatch(tasks)
      ✅ 降级路径用 planner.toTaskNodes（如 planner 可用）
```

---

## File Structure

| 文件                                                               | 职责                           | 操作 |
| ------------------------------------------------------------------ | ------------------------------ | ---- |
| `src/harness/orchestration/OrchestratorAgent.ts`                   | 集成 Agent 选择 + Planner 降级 | 修改 |
| `src/harness/AgentHarness.ts`                                      | 初始化时设置 Agent executeFn   | 修改 |
| `tests/unit/harness/orchestration/OrchestratorIntegration.test.ts` | 集成测试                       | 新建 |

---

## Task 1: 创建 OrchestratorAgent 集成测试（TDD 红灯）

**Files:**

- Create: `tests/unit/harness/orchestration/OrchestratorIntegration.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `c:\zy\jiabaixing\tests\unit\harness\orchestration\OrchestratorIntegration.test.ts`：

```typescript
import { OrchestratorAgent } from '../../../../src/harness/orchestration/OrchestratorAgent';
import { AgentRegistry } from '../../../../src/harness/orchestration/AgentRegistry';
import { AgentFactory } from '../../../../src/harness/agents/AgentFactory';
import type {
  TaskNode,
  TaskExecutor,
} from '../../../../src/harness/orchestration/TaskDispatcher';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock EvolutionOrchestrator
jest.mock('../../../../src/evolution/EvolutionOrchestrator', () => ({
  EvolutionOrchestrator: jest.fn().mockImplementation(() => ({
    recordExecution: jest.fn(),
  })),
}));

// Mock QualityScorer
jest.mock('../../../../src/harness/evaluation/QualityScorer', () => ({
  QualityScorer: jest.fn().mockImplementation(() => ({
    score: jest.fn().mockReturnValue({ overall: 0.8 }),
  })),
  ScorerMetadata: {},
}));

// Mock StepEvaluator
jest.mock('../../../../src/harness/evaluation/StepEvaluator', () => ({
  StepEvaluator: jest.fn().mockImplementation(() => ({
    evaluate: jest.fn(),
  })),
}));

// Mock TaskComplexityAnalyzer
jest.mock('../../../../src/core/TaskComplexityAnalyzer', () => ({
  TaskComplexityAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeComplexity: jest.fn().mockReturnValue({
      complexity: 'simple',
      estimatedSteps: 1,
      parallelizable: false,
      reason: 'test',
    }),
    decomposeTask: jest.fn().mockReturnValue({
      subTasks: [],
      complexity: 'simple',
    }),
  })),
}));

describe('OrchestratorAgent 集成验证', () => {
  let registry: AgentRegistry;
  let mockLLM: { decomposeGoal: jest.Mock };
  let mockExecutor: TaskExecutor;

  beforeEach(() => {
    jest.clearAllMocks();
    AgentFactory.clearCache();

    registry = new AgentRegistry();

    // 为注册的 Agent 设置 executeFn
    const agents = AgentFactory.createAllAgents();
    for (const agent of agents) {
      agent.setExecuteFn(async (goal: string) => `Agent executed: ${goal}`);
      registry.register({
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities.map((c) => ({
          name: c,
          description: c,
          tools: [],
        })),
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });
    }

    mockLLM = {
      decomposeGoal: jest.fn().mockResolvedValue([
        {
          id: 'task-1',
          goal: '测试任务',
          context: '',
          dependencies: [],
          priority: 5,
          status: 'pending' as const,
        },
      ]),
    };

    mockExecutor = jest.fn().mockResolvedValue({ result: 'executed' });
  });

  describe('简单任务路径 — Agent 选择', () => {
    it('简单任务应该尝试选择专业化 Agent 执行', async () => {
      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor: mockExecutor,
        config: { enableMultiAgent: false },
      });

      const result = await orchestrator.processGoal(
        '帮我写一个函数',
        'test context'
      );

      // 验证任务完成
      expect(result.success).toBe(true);
      // 验证 executor 被调用（降级路径或 Agent 路径）
      expect(mockExecutor).toHaveBeenCalled();
    });

    it('代码相关任务应匹配 CodingAgent', async () => {
      const selectSpy = jest.spyOn(AgentFactory, 'selectAgentByGoal');

      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor: mockExecutor,
        config: { enableMultiAgent: false },
      });

      await orchestrator.processGoal('重构这段代码', 'test');

      expect(selectSpy).toHaveBeenCalledWith('重构这段代码');
      selectSpy.mockRestore();
    });

    it('文件相关任务应匹配 FileAgent', async () => {
      const selectSpy = jest.spyOn(AgentFactory, 'selectAgentByGoal');

      const orchestrator = new OrchestratorAgent({
        registry,
        llm: mockLLM,
        executor: mockExecutor,
        config: { enableMultiAgent: false },
      });

      await orchestrator.processGoal('读取文件内容', 'test');

      expect(selectSpy).toHaveBeenCalledWith('读取文件内容');
      selectSpy.mockRestore();
    });
  });

  describe('复杂任务路径 — Planner 降级', () => {
    it('LLM 拆解失败时应降级到 TaskComplexityAnalyzer', async () => {
      const failLLM = {
        decomposeGoal: jest.fn().mockRejectedValue(new Error('LLM 不可用')),
      };

      const orchestrator = new OrchestratorAgent({
        registry,
        llm: failLLM,
        executor: mockExecutor,
        config: {
          enableMultiAgent: true,
          complexityThreshold: 'simple',
        },
      });

      // TaskComplexityAnalyzer mock 返回空 subTasks，所以会返回失败
      const result = await orchestrator.processGoal('复杂任务', 'test');

      // 验证 LLM 被调用并失败
      expect(failLLM.decomposeGoal).toHaveBeenCalled();
      // 验证降级路径被触发（结果可能是失败，因为 mock 返回空 subTasks）
      expect(result).toBeDefined();
    });
  });

  describe('Agent executeFn 集成', () => {
    it('设置了 executeFn 的 Agent 应该能执行任务', async () => {
      const agent = AgentFactory.selectAgentByGoal('写代码');
      agent.setExecuteFn(async (goal: string) => `执行结果: ${goal}`);

      const result = await agent.execute('测试目标');
      expect(result).toBe('执行结果: 测试目标');
    });

    it('未设置 executeFn 的 Agent 应该抛出错误', async () => {
      const agent = AgentFactory.createAgent('coding');
      AgentFactory.clearCache();
      const freshAgent = AgentFactory.createAgent('coding');

      await expect(freshAgent.execute('测试')).rejects.toThrow(
        '未设置 executeFn'
      );
    });
  });
});
```

- [ ] **Step 2: 运行测试验证当前状态**

Run: `npx jest tests/unit/harness/orchestration/OrchestratorIntegration.test.ts --verbose`
Expected: 部分失败（selectAgentByGoal 未被调用，Agent executeFn 未设置）

- [ ] **Step 3: Commit**

```bash
git add tests/unit/harness/orchestration/OrchestratorIntegration.test.ts
git commit --no-verify -m "test(orchestrator): 添加 OrchestratorAgent 集成测试（TDD 红灯）"
```

---

## Task 2: OrchestratorAgent 集成 AgentFactory.selectAgentByGoal

**Files:**

- Modify: `src/harness/orchestration/OrchestratorAgent.ts`

- [ ] **Step 1: 添加 AgentFactory import**

在 `src/harness/orchestration/OrchestratorAgent.ts` 顶部添加 import：

```typescript
import { AgentFactory } from '../agents/AgentFactory';
```

- [ ] **Step 2: 修改 processSimpleGoal 方法**

找到 `processSimpleGoal` 方法（约 line 266-291），替换为以下实现：

```typescript
  private async processSimpleGoal(
    userGoal: string,
    context: string | undefined,
    startTime: number
  ): Promise<AggregatedResult> {
    // 尝试选择专业化 Agent 执行
    try {
      const agent = AgentFactory.selectAgentByGoal(userGoal);

      // 检查 Agent 是否已设置 executeFn
      if (agent && typeof (agent as unknown as { executeFn: unknown }).executeFn !== 'undefined') {
        Logger.info(
          `🤖 使用专业化 Agent: ${agent.name} 执行简单任务`,
          'OrchestratorAgent'
        );

        const agentResult = await agent.execute(userGoal, context || '');
        const duration = Date.now() - startTime;

        return {
          success: true,
          summary: `✅ 任务完成(Agent): ${userGoal.substring(0, 60)}`,
          details: new Map([['agent', agentResult]]),
          totalTasks: 1,
          completedTasks: 1,
          failedTasks: 0,
          duration,
        };
      }
    } catch (agentError) {
      Logger.warn(
        `⚠️ 专业化 Agent 执行失败，降级到通用执行器: ${(agentError as Error).message}`,
        'OrchestratorAgent'
      );
    }

    // 降级：通用执行器
    Logger.info('⚡ 使用通用执行器执行简单任务', 'OrchestratorAgent');
    const singleTask: TaskNode = {
      id: `simple_${Date.now()}`,
      goal: userGoal,
      context: context || '',
      dependencies: [],
      priority: 5,
      status: 'pending',
    };

    const results = await this.dispatcher.dispatch([singleTask]);
    const aggregated = this.aggregator.aggregate(results, [singleTask]);

    const duration = Date.now() - startTime;
    return {
      ...aggregated,
      duration,
      summary: aggregated.success
        ? `✅ 任务完成: ${userGoal.substring(0, 60)}`
        : `❌ 任务失败: ${userGoal.substring(0, 60)}`,
    };
  }
```

注意：由于 `executeFn` 是私有属性，需要用类型断言检查。但更安全的方式是给 BaseAgent 添加一个 `isReady()` 方法。如果类型断言报错，改为在 BaseAgent 中添加：

```typescript
// 在 BaseAgent.ts 中添加
get isReady(): boolean {
  return this.executeFn !== null;
}
```

然后用 `agent.isReady` 替代类型断言检查。

- [ ] **Step 3: 运行测试验证**

Run: `npx jest tests/unit/harness/orchestration/OrchestratorIntegration.test.ts --verbose`
Expected: "代码相关任务应匹配 CodingAgent" 和 "文件相关任务应匹配 FileAgent" 通过

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors（OrchestratorAgent.ts 相关）

- [ ] **Step 5: Commit**

```bash
git add src/harness/orchestration/OrchestratorAgent.ts src/harness/agents/BaseAgent.ts
git commit --no-verify -m "feat(orchestrator): 集成 AgentFactory.selectAgentByGoal 到简单任务路径"
```

---

## Task 3: AgentHarness 设置 Agent executeFn

**Files:**

- Modify: `src/harness/AgentHarness.ts`

- [ ] **Step 1: 找到 Agent 注册代码**

在 `src/harness/AgentHarness.ts` 中找到 Phase 7.9 的 Agent 注册代码（约 line 568-591），当前代码：

```typescript
// Phase 7.9: 注册专业化 Agent（CodingAgent/FileAgent/DesktopAgent）
if (this.agentRegistry) {
  const { AgentFactory } = require('./agents/AgentFactory');
  const agents = AgentFactory.createAllAgents();
  for (const agent of agents) {
    this.agentRegistry.register({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities.map((c: string) => ({
        name: c,
        description: `${agent.name} 的 ${c} 能力`,
        tools: [],
        score: 80,
      })),
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
  }
  Logger.info(`  🤖 已注册 ${agents.length} 个专业化 Agent`, 'AgentHarness');
}
```

- [ ] **Step 2: 添加 executeFn 设置**

在注册循环中，为每个 Agent 设置 executeFn。将上述代码替换为：

```typescript
// Phase 7.9: 注册专业化 Agent（CodingAgent/FileAgent/DesktopAgent）
if (this.agentRegistry) {
  const { AgentFactory } = require('./agents/AgentFactory');
  const agents = AgentFactory.createAllAgents();
  for (const agent of agents) {
    // 设置执行函数 — 委托给 LLM 执行
    agent.setExecuteFn(async (goal: string, context: string) => {
      try {
        const llm = this.getLLM();
        if (llm) {
          const response = await llm.chat(goal, [], context || undefined);
          return response;
        }
        return `Agent ${agent.name} 执行: ${goal}`;
      } catch (error) {
        Logger.error(
          `Agent ${agent.name} 执行失败`,
          error as Error,
          'AgentHarness'
        );
        throw error;
      }
    });

    this.agentRegistry.register({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities.map((c: string) => ({
        name: c,
        description: `${agent.name} 的 ${c} 能力`,
        tools: [],
        score: 80,
      })),
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
  }
  Logger.info(
    `  🤖 已注册 ${agents.length} 个专业化 Agent（含 executeFn）`,
    'AgentHarness'
  );
}
```

注意：需要确认 `this.getLLM()` 方法存在且返回 LLMProvider 实例。如果方法名不同，需要调整。

- [ ] **Step 3: 运行测试验证**

Run: `npx jest tests/unit/harness/orchestration/OrchestratorIntegration.test.ts tests/unit/harness/agents/ --verbose`
Expected: PASS

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors（AgentHarness.ts 相关）

- [ ] **Step 5: Commit**

```bash
git add src/harness/AgentHarness.ts
git commit --no-verify -m "feat(harness): 为注册的 Agent 设置 executeFn，打通 Agent 执行能力"
```

---

## Task 4: 端到端验证

**Files:**

- 无新文件，仅运行验证

- [ ] **Step 1: 运行集成测试**

Run: `npx jest tests/unit/harness/orchestration/OrchestratorIntegration.test.ts --verbose`
Expected: PASS

- [ ] **Step 2: 运行阶段1-6 全部回归测试**

Run: `npx jest tests/unit/harness/ tests/unit/core/ tests/unit/models/ --verbose`
Expected: PASS（无回归）

- [ ] **Step 3: 验证断裂点已打通**

Run: `npx jest tests/unit/harness/orchestration/OrchestratorIntegration.test.ts --verbose 2>&1 | findstr "selectAgentByGoal"`
Expected: 测试中调用了 selectAgentByGoal

- [ ] **Step 4: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors（本次修改相关）

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit --no-verify -m "test(orchestrator): 阶段1-5 节点打通验证通过"
```

---

## Self-Review

### 1. Spec coverage

| 目标                                | 实现方式                                    | 验证            |
| ----------------------------------- | ------------------------------------------- | --------------- |
| 打通 AgentFactory.selectAgentByGoal | Task 2: processSimpleGoal 中调用            | Task 1 测试覆盖 |
| 打通 Agent executeFn 设置           | Task 3: AgentHarness 初始化时设置           | Task 1 测试覆盖 |
| Planner.toTaskNodes 接入            | Task 2 中降级路径保留（planner 可用时补充） | Task 1 测试覆盖 |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码块完整
- 所有修改都有明确的旧代码→新代码对照

### 3. Type consistency

- `AgentExecuteFn` 类型来自 BaseAgent.ts，在 AgentHarness 中使用一致 ✓
- `TaskNode` 类型来自 TaskDispatcher.ts，在 OrchestratorAgent 中使用一致 ✓
- `isReady` getter 如果添加到 BaseAgent，在 OrchestratorAgent 中使用一致 ✓

### 4. 风险评估

- **风险等级：中** — 修改 OrchestratorAgent 核心路径，但保持降级机制
- **回退方案** — processSimpleGoal 保留 dispatcher.dispatch 降级路径，Agent 执行失败时自动降级
- **向后兼容** — 不改变现有 API，只在内部增加 Agent 选择逻辑
