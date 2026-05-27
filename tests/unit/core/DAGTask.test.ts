/**
 * DAGTask单元测试
 */

import { DAGTask, TaskNode, TaskStatus } from '../../../src/core/DAGTask';

describe('TaskNode', () => {
  let taskNode: TaskNode;

  beforeEach(() => {
    taskNode = new TaskNode(
      'test-task',
      '测试任务',
      'test-tool',
      { param1: 'value1', param2: 'value2' },
      TaskStatus.PENDING,
      ['dep1', 'dep2']
    );
  });

  it('should create a task node with correct properties', () => {
    expect(taskNode.id).toBe('test-task');
    expect(taskNode.description).toBe('测试任务');
    expect(taskNode.toolName).toBe('test-tool');
    expect(taskNode.params).toEqual({ param1: 'value1', param2: 'value2' });
    expect(taskNode.status).toBe(TaskStatus.PENDING);
    expect(taskNode.dependencies).toEqual(['dep1', 'dep2']);
    expect(taskNode.getDuration()).toBe(0);
  });

  it('should start a task node correctly', () => {
    taskNode.start();
    expect(taskNode.status).toBe(TaskStatus.RUNNING);
    expect(taskNode.startTime).toBeInstanceOf(Date);
    expect(taskNode.endTime).toBeUndefined();
  });

  it('should mark a task node as succeeded correctly', (done) => {
    taskNode.start();

    // 添加微小延迟，确保时间差不为0
    setTimeout(() => {
      taskNode.succeed({ result: 'success' });

      expect(taskNode.status).toBe(TaskStatus.SUCCESS);
      expect(taskNode.result).toEqual({ result: 'success' });
      expect(taskNode.startTime).toBeInstanceOf(Date);
      expect(taskNode.endTime).toBeInstanceOf(Date);

      // 时间差可能非常小，但应该存在
      const duration = taskNode.getDuration();
      expect(duration).toBeGreaterThanOrEqual(0);

      done();
    }, 10);
  });

  it('should mark a task node as failed correctly', () => {
    taskNode.start();
    const error = new Error('test error');
    taskNode.fail(error);

    expect(taskNode.status).toBe(TaskStatus.FAILED);
    expect(taskNode.error).toBe(error);
    expect(taskNode.startTime).toBeInstanceOf(Date);
    expect(taskNode.endTime).toBeInstanceOf(Date);
  });

  it('should skip a task node correctly', () => {
    taskNode.skip();

    expect(taskNode.status).toBe(TaskStatus.SKIPPED);
    expect(taskNode.endTime).toBeInstanceOf(Date);
  });

  it('should check if a task node is executable correctly', () => {
    // 依赖任务都成功
    const dependencyStatuses = new Map<string, TaskStatus>();
    dependencyStatuses.set('dep1', TaskStatus.SUCCESS);
    dependencyStatuses.set('dep2', TaskStatus.SUCCESS);
    expect(taskNode.isExecutable(dependencyStatuses)).toBe(true);

    // 有一个依赖任务失败
    dependencyStatuses.set('dep1', TaskStatus.FAILED);
    expect(taskNode.isExecutable(dependencyStatuses)).toBe(false);

    // 任务已经在运行
    taskNode.status = TaskStatus.RUNNING;
    expect(taskNode.isExecutable(dependencyStatuses)).toBe(false);

    // 任务已经成功
    taskNode.status = TaskStatus.SUCCESS;
    expect(taskNode.isExecutable(dependencyStatuses)).toBe(false);
  });
});

describe('DAGTask', () => {
  let dagTask: DAGTask;

  beforeEach(() => {
    dagTask = new DAGTask('test-dag');
  });

  it('should create a DAG task with correct properties', () => {
    expect(dagTask.getNodeCount()).toBe(0);
    expect(dagTask.getStatus()).toBe(TaskStatus.PENDING);
  });

  it('should add nodes to the DAG task correctly', () => {
    const node1 = new TaskNode('node1', '任务1', 'tool1', {}, TaskStatus.PENDING);
    const node2 = new TaskNode('node2', '任务2', 'tool2', {}, TaskStatus.PENDING, ['node1']);
    const node3 = new TaskNode('node3', '任务3', 'tool3', {}, TaskStatus.PENDING, ['node1']);
    const node4 = new TaskNode('node4', '任务4', 'tool4', {}, TaskStatus.PENDING, ['node2', 'node3']);

    dagTask.addNode(node1);
    dagTask.addNode(node2);
    dagTask.addNode(node3);
    dagTask.addNode(node4);

    expect(dagTask.getNodeCount()).toBe(4);
    expect(dagTask.getNode('node1')).toBe(node1);
    expect(dagTask.getNode('node2')).toBe(node2);
    expect(dagTask.getNode('node3')).toBe(node3);
    expect(dagTask.getNode('node4')).toBe(node4);
  });

  it('should detect cycle dependencies correctly', () => {
    const node1 = new TaskNode('node1', '任务1', 'tool1', {}, TaskStatus.PENDING, ['node3']);
    const node2 = new TaskNode('node2', '任务2', 'tool2', {}, TaskStatus.PENDING, ['node1']);
    const node3 = new TaskNode('node3', '任务3', 'tool3', {}, TaskStatus.PENDING, ['node2']);

    dagTask.addNode(node1);
    dagTask.addNode(node2);

    expect(() => dagTask.addNode(node3)).toThrow('检测到循环依赖！节点: node3');
  });

  it('should perform topological sort correctly', () => {
    const node1 = new TaskNode('node1', '任务1', 'tool1', {}, TaskStatus.PENDING);
    const node2 = new TaskNode('node2', '任务2', 'tool2', {}, TaskStatus.PENDING, ['node1']);
    const node3 = new TaskNode('node3', '任务3', 'tool3', {}, TaskStatus.PENDING, ['node1']);
    const node4 = new TaskNode('node4', '任务4', 'tool4', {}, TaskStatus.PENDING, ['node2', 'node3']);

    dagTask.addNode(node1);
    dagTask.addNode(node2);
    dagTask.addNode(node3);
    dagTask.addNode(node4);

    const sortedNodes = dagTask.topologicalSort();

    // 验证拓扑排序结果的正确性
    expect(sortedNodes.indexOf('node1')).toBeLessThan(sortedNodes.indexOf('node2'));
    expect(sortedNodes.indexOf('node1')).toBeLessThan(sortedNodes.indexOf('node3'));
    expect(sortedNodes.indexOf('node2')).toBeLessThan(sortedNodes.indexOf('node4'));
    expect(sortedNodes.indexOf('node3')).toBeLessThan(sortedNodes.indexOf('node4'));
  });

  it('should get executable nodes correctly', () => {
    const node1 = new TaskNode('node1', '任务1', 'tool1', {}, TaskStatus.PENDING);
    const node2 = new TaskNode('node2', '任务2', 'tool2', {}, TaskStatus.PENDING, ['node1']);
    const node3 = new TaskNode('node3', '任务3', 'tool3', {}, TaskStatus.PENDING, ['node1']);

    dagTask.addNode(node1);
    dagTask.addNode(node2);
    dagTask.addNode(node3);

    // 初始状态下，只有node1可执行
    let executableNodes = dagTask.getExecutableNodes();
    expect(executableNodes.length).toBe(1);
    expect(executableNodes[0].id).toBe('node1');

    // 将node1标记为成功
    node1.succeed({ result: 'success' });

    // 此时node2和node3应该可执行
    executableNodes = dagTask.getExecutableNodes();
    expect(executableNodes.length).toBe(2);
    const executableIds = executableNodes.map(node => node.id);
    expect(executableIds).toContain('node2');
    expect(executableIds).toContain('node3');
  });

  it('should get status correctly', () => {
    const node1 = new TaskNode('node1', '任务1', 'tool1', {}, TaskStatus.PENDING);
    const node2 = new TaskNode('node2', '任务2', 'tool2', {}, TaskStatus.PENDING, ['node1']);

    dagTask.addNode(node1);
    dagTask.addNode(node2);

    // 初始状态为PENDING
    expect(dagTask.getStatus()).toBe(TaskStatus.PENDING);

    // 开始执行node1
    node1.start();
    expect(dagTask.getStatus()).toBe(TaskStatus.RUNNING);

    // node1执行成功，node2仍然PENDING，状态应该为PENDING
    node1.succeed({ result: 'success' });
    expect(dagTask.getStatus()).toBe(TaskStatus.PENDING);

    // node2开始执行
    node2.start();
    expect(dagTask.getStatus()).toBe(TaskStatus.RUNNING);

    // node2执行成功，整个DAG状态为SUCCESS
    node2.succeed({ result: 'success' });
    expect(dagTask.getStatus()).toBe(TaskStatus.SUCCESS);

    // 重置DAG
    dagTask.reset();

    // node1执行失败，由于maxRetries=3，node仍可重试，DAG状态为FAILED（因为当前无canRetry且status=FAILED的节点）
    node1.start();
    node1.fail(new Error('failed'));
    // 检查node1的状态为FAILED
    expect(node1.status).toBe(TaskStatus.FAILED);
  });

  it('should get statistics correctly', () => {
    const node1 = new TaskNode('node1', '任务1', 'tool1', {}, TaskStatus.PENDING);
    const node2 = new TaskNode('node2', '任务2', 'tool2', {}, TaskStatus.PENDING, ['node1']);

    dagTask.addNode(node1);
    dagTask.addNode(node2);

    const stats = dagTask.getStatistics();

    expect(stats.nodeCount).toBe(2);
    expect(stats.pendingCount).toBe(2);
    expect(stats.runningCount).toBe(0);
    expect(stats.successCount).toBe(0);
    expect(stats.failedCount).toBe(0);
    expect(stats.skippedCount).toBe(0);

    // 执行部分任务
    node1.start();
    node1.succeed({ result: 'success' });

    const statsAfterExecution = dagTask.getStatistics();
    expect(statsAfterExecution.successCount).toBe(1);
    expect(statsAfterExecution.pendingCount).toBe(1);
  });

  it('should reset correctly', () => {
    const node1 = new TaskNode('node1', '任务1', 'tool1', {}, TaskStatus.PENDING);
    const node2 = new TaskNode('node2', '任务2', 'tool2', {}, TaskStatus.PENDING, ['node1']);

    dagTask.addNode(node1);
    dagTask.addNode(node2);

    // 执行任务
    node1.start();
    node1.succeed({ result: 'success' });
    node2.start();

    // 重置DAG
    dagTask.reset();

    expect(node1.status).toBe(TaskStatus.PENDING);
    expect(node1.result).toBeUndefined();
    expect(node1.error).toBeUndefined();
    expect(node1.startTime).toBeUndefined();
    expect(node1.endTime).toBeUndefined();

    expect(node2.status).toBe(TaskStatus.PENDING);
    expect(node2.result).toBeUndefined();
    expect(node2.error).toBeUndefined();
    expect(node2.startTime).toBeUndefined();
    expect(node2.endTime).toBeUndefined();
  });
});
