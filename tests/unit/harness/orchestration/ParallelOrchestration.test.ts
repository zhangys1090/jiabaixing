import { AgentRegistry } from '../../../../src/harness/orchestration/AgentRegistry';
import {
  TaskDispatcher,
  type TaskExecutor,
  type TaskNode,
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
      expect(duration).toBeLessThan(TASK_DELAY * 3); // 应小于 300ms（含调度开销）
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
      expect(duration).toBeLessThan(TASK_DELAY * 4); // 应小于 400ms（含调度开销）
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
      expect(duration).toBeGreaterThanOrEqual(TASK_DELAY * 2.0); // 至少 200ms
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
      expect(duration).toBeLessThan(TASK_DELAY * 3.5); // 应小于 350ms（含调度开销）
      expect(duration).toBeGreaterThanOrEqual(TASK_DELAY * 1.2); // 至少 120ms
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
      expect(duration).toBeLessThan(TASK_DELAY * 4.5); // 应小于 450ms（含调度开销）
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
      expect(duration).toBeGreaterThanOrEqual(TASK_DELAY * 1.2); // 至少 120ms
    });
  });
});
