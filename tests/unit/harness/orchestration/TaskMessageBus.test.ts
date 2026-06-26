import {
  TaskDispatcher,
  TaskMessageBus,
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
 * 创建注册了多个 Agent 的 AgentRegistry
 * @param count - Agent 数量
 * @returns AgentRegistry 实例
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

describe('TaskMessageBus', () => {
  let bus: TaskMessageBus;

  beforeEach(() => {
    bus = new TaskMessageBus();
  });

  afterEach(() => {
    bus.clear();
  });

  describe('publish/subscribe 基本功能', () => {
    it('发布消息后订阅者能收到', () => {
      bus.publish('channel-a', { value: 1 });

      const messages = bus.subscribe('channel-a');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ value: 1 });
    });

    it('多次发布消息后订阅者能收到全部消息', () => {
      bus.publish('channel-a', 'msg1');
      bus.publish('channel-a', 'msg2');
      bus.publish('channel-a', 'msg3');

      const messages = bus.subscribe('channel-a');

      expect(messages).toHaveLength(3);
      expect(messages[0]).toBe('msg1');
      expect(messages[1]).toBe('msg2');
      expect(messages[2]).toBe('msg3');
    });

    it('订阅不存在的频道返回空数组', () => {
      const messages = bus.subscribe('nonexistent');

      expect(messages).toEqual([]);
    });
  });

  describe('多个订阅者同时接收消息', () => {
    it('多个订阅者调用 subscribe 都能获取到已发布的消息', () => {
      bus.publish('shared-channel', { data: 'hello' });

      const messages1 = bus.subscribe('shared-channel');
      const messages2 = bus.subscribe('shared-channel');

      expect(messages1).toHaveLength(1);
      expect(messages1[0]).toEqual({ data: 'hello' });
      expect(messages2).toHaveLength(1);
      expect(messages2[0]).toEqual({ data: 'hello' });
    });
  });

  describe('waitForMessage 等待消息', () => {
    it('任务 A 发布数据后任务 B 能通过 waitForMessage 接收', async () => {
      bus.publish('task-a-done', { result: 'computed-data' });

      const message = await bus.waitForMessage('task-a-done', 1000);

      expect(message).toEqual({ result: 'computed-data' });
    });

    it('无消息时 waitForMessage 等待超时返回 null', async () => {
      const start = Date.now();
      const message = await bus.waitForMessage('empty-channel', 200);
      const elapsed = Date.now() - start;

      expect(message).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(180);
    });

    it('waitForMessage 在超时前收到发布的数据', async () => {
      setTimeout(() => {
        bus.publish('delayed-channel', { value: 42 });
      }, 50);

      const message = await bus.waitForMessage('delayed-channel', 2000);

      expect(message).toEqual({ value: 42 });
    });
  });

  describe('clear 清理', () => {
    it('clear 后所有消息被清除', () => {
      bus.publish('channel-a', 'data1');
      bus.publish('channel-b', 'data2');

      bus.clear();

      expect(bus.subscribe('channel-a')).toEqual([]);
      expect(bus.subscribe('channel-b')).toEqual([]);
    });
  });
});

describe('TaskDispatcher 集成 TaskMessageBus', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = createRegistryWithAgents(3);
  });

  it('dispatch 开始时创建 messageBus，可通过 getMessageBus 获取', async () => {
    const executor: TaskExecutor = async (task: TaskNode) => {
      return { taskId: task.id, goal: task.goal };
    };
    const dispatcher = new TaskDispatcher(registry, executor, {
      taskTimeoutMs: 5000,
    });

    const tasks: TaskNode[] = [
      {
        id: 'task-1',
        goal: '任务1',
        context: '',
        dependencies: [],
        priority: 5,
        status: 'pending',
      },
    ];

    await dispatcher.dispatch(tasks);

    // dispatch 结束后 messageBus 仍可访问（已清理内容但实例存在）
    const bus = dispatcher.getMessageBus();
    expect(bus).toBeDefined();
    expect(bus.subscribe('any-channel')).toEqual([]);
  });

  it('任务 A 发布数据后任务 B 能通过 messageBus 接收', async () => {
    const sharedData = { computed: 'result-from-A' };
    let receivedByB: unknown = null;

    const executor: TaskExecutor = async (task: TaskNode) => {
      if (task.id === 'task-a') {
        // 任务 A 发布中间结果
        const bus = dispatcher.getMessageBus();
        bus.publish('task-a-output', sharedData);
        return { taskId: 'task-a' };
      }
      if (task.id === 'task-b') {
        // 任务 B 等待任务 A 的中间结果
        const bus = dispatcher.getMessageBus();
        // task-b 依赖 task-a，此时 task-a 已完成，消息已发布
        receivedByB = bus.subscribe('task-a-output')[0];
        return { taskId: 'task-b', received: receivedByB };
      }
      return { taskId: task.id };
    };
    const dispatcher = new TaskDispatcher(registry, executor, {
      taskTimeoutMs: 5000,
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
        dependencies: ['task-a'],
        priority: 5,
        status: 'pending',
      },
    ];

    await dispatcher.dispatch(tasks);

    expect(receivedByB).toEqual(sharedData);
  });

  it('messageBus 在 dispatch 结束后自动清理', async () => {
    const executor: TaskExecutor = async (task: TaskNode) => {
      const bus = dispatcher.getMessageBus();
      bus.publish(`output-${task.id}`, { data: 'some-data' });
      return { taskId: task.id };
    };
    const dispatcher = new TaskDispatcher(registry, executor, {
      taskTimeoutMs: 5000,
    });

    const tasks: TaskNode[] = [
      {
        id: 'task-1',
        goal: '任务1',
        context: '',
        dependencies: [],
        priority: 5,
        status: 'pending',
      },
    ];

    await dispatcher.dispatch(tasks);

    // dispatch 结束后 messageBus 内容应被清理
    const bus = dispatcher.getMessageBus();
    expect(bus.subscribe('output-task-1')).toEqual([]);
  });
});
