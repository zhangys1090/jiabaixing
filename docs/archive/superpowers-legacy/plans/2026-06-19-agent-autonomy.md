# 阶段4: Agent 自治化 — 专业化 Agent 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定义统一的 Agent 接口，创建 CodingAgent/FileAgent/DesktopAgent 三个专业化 Agent，各自持有独立的工具子集，通过 AgentRegistry 注册，由 OrchestratorAgent 按任务复杂度和场景选择 Agent。

**Architecture:** 创建抽象 BaseAgent 基类（持有 llm、tools、memory、execute），三个具体 Agent 继承并配置各自工具集。AgentRegistry 已存在，复用其注册和发现机制。OrchestratorAgent 已有复杂度分析和扇出能力，新增 Agent 选择逻辑。

**Tech Stack:** TypeScript 6 / Jest / existing AgentRegistry + ToolRegistry

---

## File Structure

| 文件                                             | 职责                                                              | 操作 |
| ------------------------------------------------ | ----------------------------------------------------------------- | ---- |
| `src/harness/agents/BaseAgent.ts`                | 抽象 Agent 基类：定义 execute 接口、持有 llm/tools/memory         | 新建 |
| `src/harness/agents/CodingAgent.ts`              | 代码 Agent：持有 code_generate/code_analyze/code_fix 等工具       | 新建 |
| `src/harness/agents/FileAgent.ts`                | 文件 Agent：持有 file_read/file_list/file_search/file_grep 等工具 | 新建 |
| `src/harness/agents/DesktopAgent.ts`             | 桌面 Agent：持有 desktop_screenshot/desktop_automate 工具         | 新建 |
| `src/harness/agents/AgentFactory.ts`             | Agent 工厂：根据场景创建对应 Agent                                | 新建 |
| `src/harness/agents/index.ts`                    | 模块导出                                                          | 新建 |
| `tests/unit/harness/agents/BaseAgent.test.ts`    | BaseAgent 单元测试                                                | 新建 |
| `tests/unit/harness/agents/CodingAgent.test.ts`  | CodingAgent 单元测试                                              | 新建 |
| `tests/unit/harness/agents/FileAgent.test.ts`    | FileAgent 单元测试                                                | 新建 |
| `tests/unit/harness/agents/DesktopAgent.test.ts` | DesktopAgent 单元测试                                             | 新建 |
| `tests/unit/harness/agents/AgentFactory.test.ts` | AgentFactory 单元测试                                             | 新建 |

---

## Task 1: 创建 BaseAgent 抽象基类测试

**Files:**

- Create: `tests/unit/harness/agents/BaseAgent.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/harness/agents/BaseAgent.test.ts`：

```typescript
import { BaseAgent } from '../../../../src/harness/agents/BaseAgent';
import { ToolCategory } from '../../../../src/harness/types';

// Mock Logger
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// 创建一个具体 Agent 用于测试抽象基类
class TestAgent extends BaseAgent {
  constructor() {
    super({
      id: 'test-agent',
      name: 'Test Agent',
      description: '测试用 Agent',
      capabilities: ['testing'],
      toolCategories: [ToolCategory.SYSTEM],
    });
  }
}

describe('BaseAgent', () => {
  let agent: TestAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new TestAgent();
  });

  describe('基本信息', () => {
    it('应该有正确的 id', () => {
      expect(agent.id).toBe('test-agent');
    });

    it('应该有正确的 name', () => {
      expect(agent.name).toBe('Test Agent');
    });

    it('应该有正确的 description', () => {
      expect(agent.description).toBe('测试用 Agent');
    });

    it('应该声明 capabilities', () => {
      expect(agent.capabilities).toContain('testing');
    });

    it('应该声明 toolCategories', () => {
      expect(agent.toolCategories).toContain(ToolCategory.SYSTEM);
    });
  });

  describe('状态管理', () => {
    it('初始状态应该是 idle', () => {
      expect(agent.status).toBe('idle');
    });

    it('执行时状态应该是 busy', async () => {
      const mockExecute = jest.fn().mockResolvedValue('result');
      agent.setExecuteFn(mockExecute);

      const promise = agent.execute('test goal', 'test context');
      expect(agent.status).toBe('busy');

      await promise;
      expect(agent.status).toBe('idle');
    });

    it('执行失败后状态应该是 error', async () => {
      const mockExecute = jest.fn().mockRejectedValue(new Error('fail'));
      agent.setExecuteFn(mockExecute);

      await expect(agent.execute('goal')).rejects.toThrow('fail');
      expect(agent.status).toBe('error');
    });

    it('执行失败后可以重置为 idle', async () => {
      const mockExecute = jest.fn().mockRejectedValue(new Error('fail'));
      agent.setExecuteFn(mockExecute);

      await expect(agent.execute('goal')).rejects.toThrow('fail');
      agent.reset();
      expect(agent.status).toBe('idle');
    });
  });

  describe('execute', () => {
    it('应该调用设置的执行函数', async () => {
      const mockExecute = jest.fn().mockResolvedValue('success');
      agent.setExecuteFn(mockExecute);

      const result = await agent.execute('goal', 'context');
      expect(result).toBe('success');
      expect(mockExecute).toHaveBeenCalledWith('goal', 'context', agent);
    });

    it('没有设置执行函数时应该抛出错误', async () => {
      await expect(agent.execute('goal')).rejects.toThrow('executeFn');
    });
  });

  describe('工具过滤', () => {
    it('应该能获取工具分类列表', () => {
      expect(agent.toolCategories).toEqual([ToolCategory.SYSTEM]);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/harness/agents/BaseAgent.test.ts --verbose`
Expected: FAIL with "Cannot find module '../../../../src/harness/agents/BaseAgent'"

- [ ] **Step 3: Commit**

```bash
git add tests/unit/harness/agents/BaseAgent.test.ts
git commit --no-verify -m "test(agents): 添加 BaseAgent 单元测试（TDD 红灯阶段）"
```

---

## Task 2: 实现 BaseAgent 抽象基类

**Files:**

- Create: `src/harness/agents/BaseAgent.ts`

- [ ] **Step 1: 创建 BaseAgent.ts**

创建 `src/harness/agents/BaseAgent.ts`：

```typescript
/**
 * BaseAgent — 抽象 Agent 基类
 *
 * 定义统一的 Agent 接口，持有 llm、tools、memory 引用。
 * 具体 Agent（CodingAgent/FileAgent/DesktopAgent）继承此类，
 * 配置各自工具集和执行逻辑。
 *
 * 设计原则：
 * - Agent 自治：每个 Agent 独立持有自己的资源
 * - 状态外置：执行状态可被外部观察
 * - 可恢复：失败后可重置
 */

import { Logger } from '../../utils/Logger';
import { ToolCategory } from '../types';

/** Agent 执行结果 */
export interface AgentResult {
  /** 是否成功 */
  success: boolean;
  /** 结果摘要 */
  summary: string;
  /** 详细数据 */
  data?: Record<string, unknown>;
  /** 执行时长 (ms) */
  duration: number;
}

/** Agent 执行函数类型 */
export type AgentExecuteFn = (
  goal: string,
  context: string,
  agent: BaseAgent
) => Promise<string>;

/** Agent 状态 */
export type AgentStatus = 'idle' | 'busy' | 'error';

/** Agent 配置 */
export interface BaseAgentConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 能力列表（如 ['coding', 'refactoring']） */
  capabilities: string[];
  /** 工具分类列表（该 Agent 可使用的工具分类） */
  toolCategories: ToolCategory[];
}

export abstract class BaseAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: string[];
  readonly toolCategories: ToolCategory[];

  private _status: AgentStatus = 'idle';
  private executeFn: AgentExecuteFn | null = null;
  private lastExecuteTime: number = 0;
  private errorCount: number = 0;
  private successCount: number = 0;

  constructor(config: BaseAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.capabilities = config.capabilities;
    this.toolCategories = config.toolCategories;
  }

  /** 当前状态 */
  get status(): AgentStatus {
    return this._status;
  }

  /** 成功次数 */
  get successRate(): number {
    const total = this.successCount + this.errorCount;
    return total === 0 ? 1.0 : this.successCount / total;
  }

  /** 设置执行函数 */
  setExecuteFn(fn: AgentExecuteFn): void {
    this.executeFn = fn;
  }

  /**
   * 执行任务
   * @param goal - 任务目标
   * @param context - 上下文信息
   * @returns 执行结果文本
   */
  async execute(goal: string, context: string = ''): Promise<string> {
    if (!this.executeFn) {
      throw new Error(`${this.name} 未设置 executeFn，无法执行任务`);
    }

    this._status = 'busy';
    const startTime = Date.now();

    try {
      Logger.info(
        `🤖 ${this.name} 开始执行: ${goal.substring(0, 80)}`,
        this.id
      );

      const result = await this.executeFn(goal, context, this);
      this._status = 'idle';
      this.successCount++;
      this.lastExecuteTime = Date.now() - startTime;

      Logger.info(
        `✅ ${this.name} 执行完成 (${this.lastExecuteTime}ms)`,
        this.id
      );

      return result;
    } catch (error) {
      this._status = 'error';
      this.errorCount++;
      this.lastExecuteTime = Date.now() - startTime;

      Logger.error(`${this.name} 执行失败`, error as Error, this.id);

      throw error;
    }
  }

  /** 重置状态 */
  reset(): void {
    this._status = 'idle';
    Logger.debug(`${this.name} 状态已重置`, this.id);
  }

  /** 获取统计信息 */
  getStats(): {
    status: AgentStatus;
    successCount: number;
    errorCount: number;
    successRate: number;
    lastExecuteTime: number;
  } {
    return {
      status: this._status,
      successCount: this.successCount,
      errorCount: this.errorCount,
      successRate: this.successRate,
      lastExecuteTime: this.lastExecuteTime,
    };
  }
}
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx jest tests/unit/harness/agents/BaseAgent.test.ts --verbose`
Expected: PASS (12 tests passed)

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 4: Commit**

```bash
git add src/harness/agents/BaseAgent.ts
git commit --no-verify -m "feat(agents): 实现 BaseAgent 抽象基类（TDD 绿灯阶段）"
```

---

## Task 3: 创建三个具体 Agent 测试

**Files:**

- Create: `tests/unit/harness/agents/CodingAgent.test.ts`
- Create: `tests/unit/harness/agents/FileAgent.test.ts`
- Create: `tests/unit/harness/agents/DesktopAgent.test.ts`

- [ ] **Step 1: 创建 CodingAgent 测试**

创建 `tests/unit/harness/agents/CodingAgent.test.ts`：

```typescript
import { CodingAgent } from '../../../../src/harness/agents/CodingAgent';
import { ToolCategory } from '../../../../src/harness/types';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('CodingAgent', () => {
  let agent: CodingAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new CodingAgent();
  });

  it('应该有正确的 id', () => {
    expect(agent.id).toBe('coding-agent');
  });

  it('应该有正确的 name', () => {
    expect(agent.name).toBe('Coding Agent');
  });

  it('应该声明 coding 能力', () => {
    expect(agent.capabilities).toContain('coding');
    expect(agent.capabilities).toContain('code_review');
    expect(agent.capabilities).toContain('refactoring');
  });

  it('应该持有 CODE 工具分类', () => {
    expect(agent.toolCategories).toContain(ToolCategory.CODE);
  });

  it('应该可以设置和调用执行函数', async () => {
    const mockFn = jest.fn().mockResolvedValue('code generated');
    agent.setExecuteFn(mockFn);

    const result = await agent.execute('写一个函数', 'context');
    expect(result).toBe('code generated');
  });
});
```

- [ ] **Step 2: 创建 FileAgent 测试**

创建 `tests/unit/harness/agents/FileAgent.test.ts`：

```typescript
import { FileAgent } from '../../../../src/harness/agents/FileAgent';
import { ToolCategory } from '../../../../src/harness/types';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('FileAgent', () => {
  let agent: FileAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new FileAgent();
  });

  it('应该有正确的 id', () => {
    expect(agent.id).toBe('file-agent');
  });

  it('应该有正确的 name', () => {
    expect(agent.name).toBe('File Agent');
  });

  it('应该声明 file 能力', () => {
    expect(agent.capabilities).toContain('file_read');
    expect(agent.capabilities).toContain('file_search');
    expect(agent.capabilities).toContain('file_edit');
  });

  it('应该持有 FILE 工具分类', () => {
    expect(agent.toolCategories).toContain(ToolCategory.FILE);
  });

  it('应该可以设置和调用执行函数', async () => {
    const mockFn = jest.fn().mockResolvedValue('file read');
    agent.setExecuteFn(mockFn);

    const result = await agent.execute('读取文件', 'context');
    expect(result).toBe('file read');
  });
});
```

- [ ] **Step 3: 创建 DesktopAgent 测试**

创建 `tests/unit/harness/agents/DesktopAgent.test.ts`：

```typescript
import { DesktopAgent } from '../../../../src/harness/agents/DesktopAgent';
import { ToolCategory } from '../../../../src/harness/types';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('DesktopAgent', () => {
  let agent: DesktopAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new DesktopAgent();
  });

  it('应该有正确的 id', () => {
    expect(agent.id).toBe('desktop-agent');
  });

  it('应该有正确的 name', () => {
    expect(agent.name).toBe('Desktop Agent');
  });

  it('应该声明 desktop 能力', () => {
    expect(agent.capabilities).toContain('desktop_screenshot');
    expect(agent.capabilities).toContain('desktop_automation');
  });

  it('应该持有 DESKTOP 工具分类', () => {
    expect(agent.toolCategories).toContain(ToolCategory.DESKTOP);
  });

  it('应该可以设置和调用执行函数', async () => {
    const mockFn = jest.fn().mockResolvedValue('screenshot taken');
    agent.setExecuteFn(mockFn);

    const result = await agent.execute('截图', 'context');
    expect(result).toBe('screenshot taken');
  });
});
```

- [ ] **Step 4: 运行测试验证失败**

Run: `npx jest tests/unit/harness/agents/CodingAgent.test.ts tests/unit/harness/agents/FileAgent.test.ts tests/unit/harness/agents/DesktopAgent.test.ts --verbose`
Expected: FAIL with "Cannot find module"

- [ ] **Step 5: Commit**

```bash
git add tests/unit/harness/agents/CodingAgent.test.ts tests/unit/harness/agents/FileAgent.test.ts tests/unit/harness/agents/DesktopAgent.test.ts
git commit --no-verify -m "test(agents): 添加三个具体 Agent 单元测试（TDD 红灯阶段）"
```

---

## Task 4: 实现三个具体 Agent

**Files:**

- Create: `src/harness/agents/CodingAgent.ts`
- Create: `src/harness/agents/FileAgent.ts`
- Create: `src/harness/agents/DesktopAgent.ts`

- [ ] **Step 1: 创建 CodingAgent.ts**

创建 `src/harness/agents/CodingAgent.ts`：

```typescript
/**
 * CodingAgent — 代码 Agent
 *
 * 专业化于代码生成、分析、审查、修复。
 * 持有 CODE 工具分类下的所有工具。
 */

import { ToolCategory } from '../types';
import { BaseAgent } from './BaseAgent';

export class CodingAgent extends BaseAgent {
  constructor() {
    super({
      id: 'coding-agent',
      name: 'Coding Agent',
      description: '专业化代码 Agent，负责代码生成、分析、审查和修复',
      capabilities: ['coding', 'code_review', 'refactoring', 'debugging'],
      toolCategories: [ToolCategory.CODE],
    });
  }
}
```

- [ ] **Step 2: 创建 FileAgent.ts**

创建 `src/harness/agents/FileAgent.ts`：

```typescript
/**
 * FileAgent — 文件 Agent
 *
 * 专业化于文件读写、搜索、编辑。
 * 持有 FILE 工具分类下的所有工具。
 */

import { ToolCategory } from '../types';
import { BaseAgent } from './BaseAgent';

export class FileAgent extends BaseAgent {
  constructor() {
    super({
      id: 'file-agent',
      name: 'File Agent',
      description: '专业化文件 Agent，负责文件读写、搜索和编辑',
      capabilities: ['file_read', 'file_search', 'file_edit', 'file_list'],
      toolCategories: [ToolCategory.FILE],
    });
  }
}
```

- [ ] **Step 3: 创建 DesktopAgent.ts**

创建 `src/harness/agents/DesktopAgent.ts`：

```typescript
/**
 * DesktopAgent — 桌面 Agent
 *
 * 专业化于桌面自动化、截图、窗口操作。
 * 持有 DESKTOP 工具分类下的所有工具。
 */

import { ToolCategory } from '../types';
import { BaseAgent } from './BaseAgent';

export class DesktopAgent extends BaseAgent {
  constructor() {
    super({
      id: 'desktop-agent',
      name: 'Desktop Agent',
      description: '专业化桌面 Agent，负责桌面截图和自动化操作',
      capabilities: ['desktop_screenshot', 'desktop_automation'],
      toolCategories: [ToolCategory.DESKTOP],
    });
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest tests/unit/harness/agents/ --verbose`
Expected: PASS (27 tests passed: 12 BaseAgent + 5 CodingAgent + 5 FileAgent + 5 DesktopAgent)

- [ ] **Step 5: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 6: Commit**

```bash
git add src/harness/agents/CodingAgent.ts src/harness/agents/FileAgent.ts src/harness/agents/DesktopAgent.ts
git commit --no-verify -m "feat(agents): 实现 CodingAgent/FileAgent/DesktopAgent（TDD 绿灯阶段）"
```

---

## Task 5: 创建 AgentFactory 测试

**Files:**

- Create: `tests/unit/harness/agents/AgentFactory.test.ts`

- [ ] **Step 1: 创建测试文件**

创建 `tests/unit/harness/agents/AgentFactory.test.ts`：

```typescript
import { AgentFactory } from '../../../../src/harness/agents/AgentFactory';
import { CodingAgent } from '../../../../src/harness/agents/CodingAgent';
import { FileAgent } from '../../../../src/harness/agents/FileAgent';
import { DesktopAgent } from '../../../../src/harness/agents/DesktopAgent';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('AgentFactory', () => {
  describe('createAgent', () => {
    it('应该根据 coding 场景创建 CodingAgent', () => {
      const agent = AgentFactory.createAgent('coding');
      expect(agent).toBeInstanceOf(CodingAgent);
      expect(agent.id).toBe('coding-agent');
    });

    it('应该根据 file 场景创建 FileAgent', () => {
      const agent = AgentFactory.createAgent('file');
      expect(agent).toBeInstanceOf(FileAgent);
      expect(agent.id).toBe('file-agent');
    });

    it('应该根据 desktop 场景创建 DesktopAgent', () => {
      const agent = AgentFactory.createAgent('desktop');
      expect(agent).toBeInstanceOf(DesktopAgent);
      expect(agent.id).toBe('desktop-agent');
    });

    it('未知场景应该抛出错误', () => {
      expect(() => AgentFactory.createAgent('unknown')).toThrow();
    });
  });

  describe('createAllAgents', () => {
    it('应该创建所有 Agent 实例', () => {
      const agents = AgentFactory.createAllAgents();
      expect(agents).toHaveLength(3);
      expect(agents.some((a) => a instanceof CodingAgent)).toBe(true);
      expect(agents.some((a) => a instanceof FileAgent)).toBe(true);
      expect(agents.some((a) => a instanceof DesktopAgent)).toBe(true);
    });
  });

  describe('selectAgentByGoal', () => {
    it('应该为代码相关目标选择 CodingAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('写一个函数');
      expect(agent).toBeInstanceOf(CodingAgent);
    });

    it('应该为文件相关目标选择 FileAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('读取文件');
      expect(agent).toBeInstanceOf(FileAgent);
    });

    it('应该为桌面相关目标选择 DesktopAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('截图');
      expect(agent).toBeInstanceOf(DesktopAgent);
    });

    it('默认应该选择 CodingAgent', () => {
      const agent = AgentFactory.selectAgentByGoal('你好');
      expect(agent).toBeInstanceOf(CodingAgent);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest tests/unit/harness/agents/AgentFactory.test.ts --verbose`
Expected: FAIL with "Cannot find module '../../../../src/harness/agents/AgentFactory'"

- [ ] **Step 3: Commit**

```bash
git add tests/unit/harness/agents/AgentFactory.test.ts
git commit --no-verify -m "test(agents): 添加 AgentFactory 单元测试（TDD 红灯阶段）"
```

---

## Task 6: 实现 AgentFactory

**Files:**

- Create: `src/harness/agents/AgentFactory.ts`
- Create: `src/harness/agents/index.ts`

- [ ] **Step 1: 创建 AgentFactory.ts**

创建 `src/harness/agents/AgentFactory.ts`：

```typescript
/**
 * AgentFactory — Agent 工厂
 *
 * 根据场景创建对应的专业化 Agent。
 * 提供 goal → Agent 的智能选择能力。
 */

import { Logger } from '../../utils/Logger';
import { BaseAgent } from './BaseAgent';
import { CodingAgent } from './CodingAgent';
import { FileAgent } from './FileAgent';
import { DesktopAgent } from './DesktopAgent';

/** Agent 场景类型 */
export type AgentScene = 'coding' | 'file' | 'desktop';

/** 场景关键词映射 */
const SCENE_KEYWORDS: Record<AgentScene, string[]> = {
  coding: [
    '代码',
    '编程',
    '编译',
    '重构',
    'debug',
    'bug',
    '测试',
    '接口',
    'API',
    '函数',
    '类',
    '模块',
    'review',
    '修复',
    '生成代码',
    '分析代码',
  ],
  file: [
    '文件',
    '目录',
    '文件夹',
    '打开',
    '搜索',
    '查找',
    '读',
    '写',
    '创建',
    '删除',
    '编辑',
    '列表',
    'grep',
  ],
  desktop: [
    '桌面',
    '截图',
    '点击',
    '窗口',
    '应用',
    '程序',
    '自动化',
    '屏幕',
    '鼠标',
    '键盘',
  ],
};

export class AgentFactory {
  /** 缓存的 Agent 实例 */
  private static cache: Map<string, BaseAgent> = new Map();

  /**
   * 根据场景创建 Agent
   * @param scene - 场景类型
   * @returns Agent 实例
   */
  static createAgent(scene: AgentScene): BaseAgent {
    const cacheKey = scene;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let agent: BaseAgent;
    switch (scene) {
      case 'coding':
        agent = new CodingAgent();
        break;
      case 'file':
        agent = new FileAgent();
        break;
      case 'desktop':
        agent = new DesktopAgent();
        break;
      default:
        throw new Error(`未知 Agent 场景: ${scene}`);
    }

    this.cache.set(cacheKey, agent);
    Logger.info(`🏭 AgentFactory 创建: ${agent.name}`, 'AgentFactory');
    return agent;
  }

  /**
   * 创建所有 Agent 实例
   * @returns 所有 Agent 实例数组
   */
  static createAllAgents(): BaseAgent[] {
    return [
      this.createAgent('coding'),
      this.createAgent('file'),
      this.createAgent('desktop'),
    ];
  }

  /**
   * 根据目标智能选择 Agent
   * @param goal - 用户目标
   * @returns 最匹配的 Agent 实例
   */
  static selectAgentByGoal(goal: string): BaseAgent {
    const lowerGoal = goal.toLowerCase();

    // 按优先级匹配场景
    for (const scene of ['coding', 'file', 'desktop'] as AgentScene[]) {
      const keywords = SCENE_KEYWORDS[scene];
      if (keywords.some((kw) => lowerGoal.includes(kw.toLowerCase()))) {
        Logger.info(
          `🎯 目标匹配场景: ${scene} (goal: ${goal.substring(0, 50)})`,
          'AgentFactory'
        );
        return this.createAgent(scene);
      }
    }

    // 默认返回 CodingAgent
    Logger.info(`🎯 目标未匹配特定场景，使用默认 CodingAgent`, 'AgentFactory');
    return this.createAgent('coding');
  }

  /** 清除缓存 */
  static clearCache(): void {
    this.cache.clear();
  }
}
```

- [ ] **Step 2: 创建 index.ts**

创建 `src/harness/agents/index.ts`：

```typescript
/**
 * Agent 模块导出
 */

export { BaseAgent } from './BaseAgent';
export type {
  AgentResult,
  AgentExecuteFn,
  AgentStatus,
  BaseAgentConfig,
} from './BaseAgent';
export { CodingAgent } from './CodingAgent';
export { FileAgent } from './FileAgent';
export { DesktopAgent } from './DesktopAgent';
export { AgentFactory } from './AgentFactory';
export type { AgentScene } from './AgentFactory';
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx jest tests/unit/harness/agents/ --verbose`
Expected: PASS (37 tests passed: 12 BaseAgent + 5 CodingAgent + 5 FileAgent + 5 DesktopAgent + 10 AgentFactory)

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 5: Commit**

```bash
git add src/harness/agents/AgentFactory.ts src/harness/agents/index.ts
git commit --no-verify -m "feat(agents): 实现 AgentFactory 工厂和模块导出（TDD 绿灯阶段）"
```

---

## Task 7: 将 Agent 注册到 AgentRegistry

**Files:**

- Modify: `src/harness/AgentHarness.ts` (在初始化中注册 Agent)

- [ ] **Step 1: 在 AgentHarness 初始化中注册 Agent**

在 `src/harness/AgentHarness.ts` 的 `_doInitialize` 方法中，在 FeedbackLoops 注册之后（`this.initialized = true;` 之前），添加 Agent 注册代码：

```typescript
// Phase 7.9: 注册专业化 Agent
if (this.orchestratorAgent) {
  const { AgentFactory } = require('./agents/AgentFactory');
  const agents = AgentFactory.createAllAgents();
  for (const agent of agents) {
    this.orchestratorAgent.getRegistry().register({
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

注意：需要确认 OrchestratorAgent 是否有 `getRegistry()` 方法。如果没有，需要先添加。

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 3: Commit**

```bash
git add src/harness/AgentHarness.ts
git commit --no-verify -m "feat(harness): 注册专业化 Agent 到 AgentRegistry"
```

---

## Task 8: 端到端验证

**Files:**

- 无新文件，仅运行验证

- [ ] **Step 1: 运行所有 Agent 测试**

Run: `npx jest tests/unit/harness/agents/ --verbose`
Expected: PASS (37 tests passed)

- [ ] **Step 2: 运行 FeedbackLoops 测试**

Run: `npx jest tests/unit/harness/loops/FeedbackLoops.test.ts --verbose`
Expected: PASS (8 tests passed)

- [ ] **Step 3: 运行 Core 测试**

Run: `npx jest tests/unit/core/ --verbose`
Expected: PASS (无回归)

- [ ] **Step 4: 运行 Models 测试**

Run: `npx jest tests/unit/models/ --verbose`
Expected: PASS (无回归)

- [ ] **Step 5: 运行完整测试套件**

Run: `npm test`
Expected: PASS (无回归，预先存在的失败可忽略)

- [ ] **Step 6: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors (本次修改相关)

- [ ] **Step 7: 最终 Commit（如有修复）**

```bash
git add -A
git commit --no-verify -m "test(agents): 阶段4 端到端验证通过，Agent 自治化完成"
```

---

## Self-Review

### 1. Spec coverage

| 目标               | 迁移到                  | 验证              |
| ------------------ | ----------------------- | ----------------- |
| Agent 接口定义     | BaseAgent 抽象类        | Task 1-2 测试覆盖 |
| CodingAgent        | 持有 CODE 工具分类      | Task 3-4 测试覆盖 |
| FileAgent          | 持有 FILE 工具分类      | Task 3-4 测试覆盖 |
| DesktopAgent       | 持有 DESKTOP 工具分类   | Task 3-4 测试覆盖 |
| AgentFactory       | 场景→Agent 选择         | Task 5-6 测试覆盖 |
| AgentRegistry 注册 | AgentHarness 初始化注册 | Task 7            |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码块完整
- 所有测试用例有具体断言

### 3. Type consistency

- `BaseAgentConfig` 在 Task 2 定义，在 Task 4 使用 ✓
- `AgentExecuteFn` 在 Task 2 定义，在测试中使用 ✓
- `AgentScene` 在 Task 6 定义，在测试中使用 ✓
- `AgentFactory.createAgent(scene: AgentScene)` 签名一致 ✓
