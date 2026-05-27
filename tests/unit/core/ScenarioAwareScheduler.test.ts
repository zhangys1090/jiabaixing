/**
 * ScenarioAwareScheduler 单元测试
 * 覆盖：构造函数、场景管理、任务调度
 */

jest.mock('utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    on: jest.fn(),
  },
}));

import { ScenarioAwareScheduler, ScheduledTask } from '../../../src/core/ScenarioAwareScheduler';

describe('ScenarioAwareScheduler', () => {
  let scheduler: ScenarioAwareScheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduler = new ScenarioAwareScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('构造和初始化', () => {
    it('应该正确创建实例', () => {
      expect(scheduler).toBeDefined();
    });

    it('应该初始化默认场景', () => {
      const scenes = scheduler.getScenes();
      expect(scenes.length).toBeGreaterThan(0);
    });
  });

  describe('场景管理', () => {
    it('应该返回场景列表', () => {
      const scenes = scheduler.getScenes();
      expect(Array.isArray(scenes)).toBe(true);
      expect(scenes.length).toBeGreaterThan(0);
    });

    it('应该能获取当前活跃场景', () => {
      const currentScene = scheduler.getActiveScene();
      expect(typeof currentScene).toBe('string');
    });
  });

  describe('任务调度', () => {
    it('应该能启动和停止调度', () => {
      scheduler.start();
      scheduler.stop();
    });

    it('应该能设置MemoryEngine', () => {
      const mockMemoryEngine = {
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        retrieveTaskMemory: jest.fn().mockResolvedValue([]),
        getUserProfile: jest.fn().mockReturnValue(null),
      };
      scheduler.setMemoryEngine(mockMemoryEngine as any);
    });
  });

  describe('任务管理', () => {
    it('应该能添加和移除任务', () => {
      const task: ScheduledTask = {
        id: 'test-task',
        name: '测试任务',
        description: '测试用',
        schedule: '*/5 * * * *',
        priority: 1,
        enabled: true,
        executionCount: 0,
        successCount: 0,
        averageExecutionTime: 0,
      };

      scheduler.addTask(task);
      const tasks = scheduler.getTasks();
      expect(tasks.some((t) => t.id === 'test-task')).toBe(true);

      scheduler.removeTask('test-task');
    });

    it('应该能获取任务执行历史', () => {
      const history = scheduler.getTaskExecutionHistory('nonexistent');
      expect(Array.isArray(history)).toBe(true);
    });

    it('应该能获取用户行为模式', () => {
      const pattern = scheduler.getUserBehaviorPattern();
      expect(pattern).toBeDefined();
      expect(pattern.lastActiveTime).toBeDefined();
    });
  });
});
