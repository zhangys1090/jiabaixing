/**
 * P0-3 DAG 超时保护测试
 * 验证：全局超时、死锁检测、重试机制
 */

import { DAGExecutor } from '../../../src/core/DAGExecutor';
import { DAGTask, TaskNode, TaskStatus } from '../../../src/core/DAGTask';
import { ToolExecutor } from '../../../src/tools/ToolExecutor';

describe('P0-3 DAG 超时保护', () => {
  let executor: ToolExecutor;

  beforeEach(async () => {
    executor = new ToolExecutor();
    await executor.initialize();
  });

  test('死锁检测：循环依赖的 DAG 应被拒绝', async () => {
    const dag = new DAGTask('deadlock-test');

    // 创建循环依赖：A → B → C → A
    const nodeA = new TaskNode('A', 'Task A', 'read_file', {}, TaskStatus.PENDING, ['C']);
    const nodeB = new TaskNode('B', 'Task B', 'write_file', { file_path: 'b.txt', content: 'B' }, TaskStatus.PENDING, ['A']);
    const nodeC = new TaskNode('C', 'Task C', 'write_file', { file_path: 'c.txt', content: 'C' }, TaskStatus.PENDING, ['B']);

    dag.addNode(nodeA);
    dag.addNode(nodeB);

    // 添加 C 时应抛出循环依赖错误
    expect(() => dag.addNode(nodeC)).toThrow(/检测到循环依赖/);
  });

  test('全局超时：执行时间超过全局超时应被中断', async () => {
    const dag = new DAGTask('timeout-test');

    // 创建一个超时较长的任务
    const slowNode = new TaskNode(
      'slow_task',
      'Slow task',
      'run_command',
      {
        command: 'ping 127.0.0.1 -n 10',
      },
      TaskStatus.PENDING,
      []
    );
    slowNode.timeout = 30000;
    dag.addNode(slowNode);

    const dagExecutor = new DAGExecutor(executor, {
      globalTimeoutMs: 2000, // 2秒全局超时
      maxRetries: 0,
    });

    const result = await dagExecutor.execute(dag);

    // 验证：执行结果应标记为失败，且有超时错误
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.duration).toBeLessThan(10000); // 应在 10 秒内被中断
  });

  test('正常 DAG 应成功执行', async () => {
    const dag = new DAGTask('normal-test');

    // 创建正常依赖链：root → write
    const writeNode = new TaskNode('write', 'Write', 'write_file', { file_path: 'test-dag.txt', content: 'DAG test' }, TaskStatus.PENDING, []);

    dag.addNode(writeNode);

    const dagExecutor = new DAGExecutor(executor, {
      globalTimeoutMs: 10000,
      maxRetries: 2,
    });

    const result = await dagExecutor.execute(dag);

    expect(result.success).toBe(true);
    expect(result.statistics.succeeded).toBeGreaterThanOrEqual(1);
  }, 15000);
});
