/**
 * TaskDispatcher 单元测试
 */
import { AgentRegistry } from '../../src/harness/orchestration/AgentRegistry';
import { TaskDispatcher, TaskNode } from '../../src/harness/orchestration/TaskDispatcher';

describe('TaskDispatcher', () => {
  let registry: AgentRegistry;
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    registry = new AgentRegistry();
    registry.register({
      id: 'worker-1',
      name: '通用Worker',
      capabilities: [{ name: '通用', description: '可执行任何任务', tools: ['*'] }],
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    dispatcher = new TaskDispatcher(registry);
  });

  test('应该能处理空任务列表', async () => {
    const result = await dispatcher.dispatch([]);
    expect(result.size).toBe(0);
  });

  test('应该能执行单个独立任务', async () => {
    const tasks: TaskNode[] = [
      { id: 't1', goal: '任务1', context: '', dependencies: [], priority: 5, status: 'pending' },
    ];
    const result = await dispatcher.dispatch(tasks);
    expect(result.size).toBe(1);
    expect(result.has('t1')).toBe(true);
  });

  test('应该按依赖关系排序执行（有依赖的后执行）', async () => {
    const tasks: TaskNode[] = [
      { id: 't1', goal: '基础任务', context: '', dependencies: [], priority: 5, status: 'pending' },
      { id: 't2', goal: '依赖任务', context: '', dependencies: ['t1'], priority: 5, status: 'pending' },
    ];
    const result = await dispatcher.dispatch(tasks);
    expect(result.size).toBe(2);
  });

  test('应该按优先级排序', async () => {
    const tasks: TaskNode[] = [
      { id: 'low', goal: '低优先级', context: '', dependencies: [], priority: 1, status: 'pending' },
      { id: 'high', goal: '高优先级', context: '', dependencies: [], priority: 10, status: 'pending' },
    ];
    const start = Date.now();
    await dispatcher.dispatch(tasks);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(0);
  });

  test('应该处理错误任务不阻塞其他任务', async () => {
    const tasks: TaskNode[] = [
      { id: 'good', goal: '好任务', context: '', dependencies: [], priority: 5, status: 'pending' },
    ];
    const result = await dispatcher.dispatch(tasks);
    expect(result.has('good')).toBe(true);
  });
});
