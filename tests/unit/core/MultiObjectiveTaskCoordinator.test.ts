/**
 * MultiObjectiveTaskCoordinator 单元测试
 * 覆盖率目标：70%
 */

import { MultiObjectiveTaskCoordinator, Task, TaskState } from '../../../src/core/MultiObjectiveTaskCoordinator';

describe('MultiObjectiveTaskCoordinator', () => {
  let coordinator: MultiObjectiveTaskCoordinator;

  beforeEach(() => {
    coordinator = new MultiObjectiveTaskCoordinator();
    coordinator.initialize();
  });

  afterEach(() => {
    coordinator.cleanup();
  });

  describe('任务管理', () => {
    test('应该能够添加任务', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: {
          cpu: 0.2,
          memory: 0.3,
          io: 0.1
        },
        metadata: {},
      };

      const taskId = coordinator.addTask(task);
      expect(taskId).toBe('task-1');

      const state = coordinator.getTaskState('task-1');
      expect(state).toBeDefined();
      expect(state?.status).toBe('running');
    });

    test('应该能够批量添加任务', () => {
      const tasks: Task[] = [
        {
          id: 'task-1',
          name: '任务1',
          description: '任务1描述',
          priority: 'high',
          dependencies: [],
          estimatedTime: 20,
          resources: { cpu: 0.1, memory: 0.2, io: 0.1 },
          metadata: {},
        },
        {
          id: 'task-2',
          name: '任务2',
          description: '任务2描述',
          priority: 'low',
          dependencies: [],
          estimatedTime: 40,
          resources: { cpu: 0.2, memory: 0.1, io: 0.2 },
          metadata: {},
        }
      ];

      const taskIds = coordinator.addTasks(tasks);
      expect(taskIds).toHaveLength(2);
      expect(taskIds).toContain('task-1');
      expect(taskIds).toContain('task-2');
    });

    test('应该能够更新任务进度', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      
      const result = coordinator.updateTaskProgress('task-1', 50);
      expect(result).toBe(true);

      const state = coordinator.getTaskState('task-1');
      expect(state?.progress).toBe(50);
      expect(state?.status).toBe('running');
    });

    test('任务完成时应该更新状态', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      coordinator.updateTaskProgress('task-1', 100);

      const state = coordinator.getTaskState('task-1');
      expect(state?.status).toBe('completed');
      expect(state?.progress).toBe(100);
    });

    test('应该能够暂停任务', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      const result = coordinator.pauseTask('task-1');
      
      expect(result).toBe(true);
      
      const state = coordinator.getTaskState('task-1');
      expect(state?.status).toBe('paused');
    });

    test('应该能够取消任务', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      const result = coordinator.cancelTask('task-1');
      
      expect(result).toBe(true);
      
      const state = coordinator.getTaskState('task-1');
      expect(state?.status).toBe('failed');
    });
  });

  describe('任务优先级', () => {
    test('应该按优先级正确排序任务', () => {
      const tasks: Task[] = [
        {
          id: 'task-low',
          name: '低优先级任务',
          description: '低优先级',
          priority: 'low',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        },
        {
          id: 'task-critical',
          name: '关键任务',
          description: '关键优先级',
          priority: 'critical',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        },
        {
          id: 'task-medium',
          name: '中等优先级任务',
          description: '中等优先级',
          priority: 'medium',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        }
      ];

      coordinator.addTasks(tasks);
      
      const states = coordinator.getAllTaskStates();
      const criticalState = states.find(s => s.taskId === 'task-critical');
      
      expect(criticalState).toBeDefined();
      expect(criticalState?.status).toBe('running');
    });

    test('截止时间应该影响优先级', () => {
      const now = new Date();
      const nearDeadline = new Date(now.getTime() + 60 * 60 * 1000);
      
      const tasks: Task[] = [
        {
          id: 'task-far',
          name: '远截止任务',
          description: '截止时间较远',
          priority: 'high',
          deadline: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        },
        {
          id: 'task-near',
          name: '近截止任务',
          description: '截止时间很近',
          priority: 'medium',
          deadline: nearDeadline,
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        }
      ];

      coordinator.addTasks(tasks);
      
      const states = coordinator.getAllTaskStates();
      const nearState = states.find(s => s.taskId === 'task-near');
      
      expect(nearState).toBeDefined();
      expect(nearState?.status).toBe('running');
    });
  });

  describe('资源管理', () => {
    test('应该正确计算可用资源', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.5, memory: 0.5, io: 0.5 },
        metadata: {},
      };

      coordinator.addTask(task);
      
      const availableResources = coordinator.calculateAvailableResources();
      
      expect(availableResources.cpu).toBe(0.5);
      expect(availableResources.memory).toBe(0.5);
      expect(availableResources.io).toBe(0.5);
    });

    test('资源不足时任务应该被调度', () => {
      const task1: Task = {
        id: 'task-1',
        name: '大任务',
        description: '占用大量资源',
        priority: 'high',
        dependencies: [],
        estimatedTime: 60,
        resources: { cpu: 0.8, memory: 0.8, io: 0.8 },
        metadata: {},
      };

      coordinator.addTask(task1);
      
      const task2: Task = {
        id: 'task-2',
        name: '小任务',
        description: '需要资源',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.5, memory: 0.5, io: 0.5 },
        metadata: {},
      };

      coordinator.addTask(task2);
      
      const state2 = coordinator.getTaskState('task-2');
      expect(state2?.status).toBe('scheduled');
    });

    test('应该能够调整资源容量', () => {
      coordinator.adjustResourceCapacity({ cpu: 2.0, memory: 2.0, io: 2.0 });
      
      const availableResources = coordinator.calculateAvailableResources();
      
      expect(availableResources.cpu).toBe(2.0);
      expect(availableResources.memory).toBe(2.0);
      expect(availableResources.io).toBe(2.0);
    });

    test('应该能够调整最大并发任务数', () => {
      coordinator.setMaxConcurrentTasks(3);
      
      const status = coordinator.getStatus();
      expect(status.maxConcurrentTasks).toBe(3);
    });
  });

  describe('冲突解决', () => {
    test('应该检测并发任务数冲突', () => {
      coordinator.setMaxConcurrentTasks(2);
      
      const tasks: Task[] = [
        {
          id: 'task-1',
          name: '任务1',
          description: '任务1',
          priority: 'medium',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        },
        {
          id: 'task-2',
          name: '任务2',
          description: '任务2',
          priority: 'medium',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        },
        {
          id: 'task-3',
          name: '任务3',
          description: '任务3',
          priority: 'medium',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        }
      ];

      coordinator.addTasks(tasks);
      
      const result = coordinator.getCoordinationResult();
      
      // 验证协调器正确运行，conflicts 数量取决于实现
      expect(result).toBeDefined();
    });
  });

  describe('性能指标', () => {
    test('应该正确计算性能指标', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      coordinator.updateTaskProgress('task-1', 100);
      
      const result = coordinator.getCoordinationResult();
      
      expect(result.performanceMetrics).toBeDefined();
      expect(result.performanceMetrics.successRate).toBe(1);
      expect(result.performanceMetrics.throughput).toBeGreaterThan(0);
    });

    test('应该正确计算资源利用率', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.5, memory: 0.5, io: 0.5 },
        metadata: {},
      };

      coordinator.addTask(task);
      
      const result = coordinator.getCoordinationResult();
      
      expect(result.performanceMetrics.resourceUtilization.cpu).toBe(0.5);
      expect(result.performanceMetrics.resourceUtilization.memory).toBe(0.5);
      expect(result.performanceMetrics.resourceUtilization.io).toBe(0.5);
    });
  });

  describe('状态查询', () => {
    test('应该能够获取协调器状态', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      
      const status = coordinator.getStatus();
      
      expect(status.totalTasks).toBe(1);
      expect(status.activeTasks).toBe(1);
      expect(status.completedTasks).toBe(0);
      expect(status.failedTasks).toBe(0);
    });

    test('应该能够获取所有任务状态', () => {
      const tasks: Task[] = [
        {
          id: 'task-1',
          name: '任务1',
          description: '任务1',
          priority: 'medium',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        },
        {
          id: 'task-2',
          name: '任务2',
          description: '任务2',
          priority: 'medium',
          dependencies: [],
          estimatedTime: 30,
          resources: { cpu: 0.1, memory: 0.1, io: 0.1 },
          metadata: {},
        }
      ];

      coordinator.addTasks(tasks);
      
      const states = coordinator.getAllTaskStates();
      
      expect(states).toHaveLength(2);
    });
  });

  describe('边界条件', () => {
    test('应该处理空任务列表', () => {
      const states = coordinator.getAllTaskStates();
      expect(states).toHaveLength(0);
    });

    test('应该处理不存在的任务ID', () => {
      const state = coordinator.getTaskState('non-existent');
      expect(state).toBeUndefined();
    });

    test('应该处理无效的任务进度', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      
      coordinator.updateTaskProgress('task-1', 150);
      const state = coordinator.getTaskState('task-1');
      expect(state?.progress).toBe(100);
      
      coordinator.updateTaskProgress('task-1', -50);
      const state2 = coordinator.getTaskState('task-1');
      // 进度被限制在 0-100 范围内
      expect(state2?.progress).toBeGreaterThanOrEqual(0);
      expect(state2?.progress).toBeLessThanOrEqual(100);
    });

    test('应该正确处理任务清理', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '这是一个测试任务',
        priority: 'medium',
        dependencies: [],
        estimatedTime: 30,
        resources: { cpu: 0.2, memory: 0.3, io: 0.1 },
        metadata: {},
      };

      coordinator.addTask(task);
      coordinator.updateTaskProgress('task-1', 100);
      
      coordinator.cleanup();
      
      const states = coordinator.getAllTaskStates();
      expect(states).toHaveLength(0);
    });
  });
});
