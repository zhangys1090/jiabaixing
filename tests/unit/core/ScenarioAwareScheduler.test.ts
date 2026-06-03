/**
 * ScenarioAwareScheduler 单元测试
 * 覆盖：构造函数与默认任务、启停控制、任务增删改查、依赖注入
 */

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    on: jest.fn(),
  },
}));

import {
  ScenarioAwareScheduler,
  ScheduledTask,
} from '../../../src/core/ScenarioAwareScheduler';
import { EventBus } from '../../../src/shared/EventBus';

describe('ScenarioAwareScheduler', () => {
  let scheduler: ScenarioAwareScheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    scheduler = new ScenarioAwareScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    jest.useRealTimers();
  });

  describe('构造和初始化', () => {
    it('应该正确创建实例', () => {
      expect(scheduler).toBeDefined();
      expect(scheduler.isActive()).toBe(false);
    });

    it('应该初始化默认任务 env_awareness、git_awareness 和 skill_discovery', () => {
      const tasks = scheduler.getTasks();
      expect(tasks.length).toBe(3);

      const envTask = scheduler.getTask('env_awareness');
      expect(envTask).toBeDefined();
      expect(envTask!.name).toBe('环境感知');
      expect(envTask!.priority).toBe(2);
      expect(envTask!.enabled).toBe(true);

      const gitTask = scheduler.getTask('git_awareness');
      expect(gitTask).toBeDefined();
      expect(gitTask!.name).toBe('Git感知');
      expect(gitTask!.priority).toBe(3);
      expect(gitTask!.enabled).toBe(true);
    });
  });

  describe('start / stop / isActive', () => {
    it('start 应该激活调度器', () => {
      scheduler.start();
      expect(scheduler.isActive()).toBe(true);
      expect(EventBus.emit).toHaveBeenCalledWith(
        'scheduler_started',
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });

    it('重复 start 应该不重复启动', () => {
      scheduler.start();
      scheduler.start();
      expect(scheduler.isActive()).toBe(true);
    });

    it('stop 应该停止调度器', () => {
      scheduler.start();
      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
      expect(EventBus.emit).toHaveBeenCalledWith(
        'scheduler_stopped',
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });

    it('未启动时 stop 不应发射事件', () => {
      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
      expect(EventBus.emit).not.toHaveBeenCalledWith(
        'scheduler_stopped',
        expect.anything()
      );
    });
  });

  describe('addTask / getTasks / getTask', () => {
    it('addTask 应该添加任务并返回任务 id', () => {
      const task: ScheduledTask = {
        id: 'custom_task',
        name: '自定义任务',
        description: '测试用自定义任务',
        schedule: '*/10 * * * *',
        priority: 2,
        enabled: true,
        executionCount: 0,
        successCount: 0,
        averageExecutionTime: 0,
      };

      const returnedId = scheduler.addTask(task);
      expect(returnedId).toBe('custom_task');
      expect(scheduler.getTask('custom_task')).toEqual(task);
    });

    it('getTasks 应该返回所有任务（含默认任务）', () => {
      const task: ScheduledTask = {
        id: 'extra_task',
        name: '额外任务',
        description: '额外测试任务',
        schedule: '0 12 * * *',
        priority: 3,
        enabled: false,
        executionCount: 0,
        successCount: 0,
        averageExecutionTime: 0,
      };
      scheduler.addTask(task);

      const tasks = scheduler.getTasks();
      expect(tasks).toHaveLength(4);
      expect(tasks.map((t) => t.id)).toContain('env_awareness');
      expect(tasks.map((t) => t.id)).toContain('extra_task');
    });

    it('getTask 对不存在的 id 应返回 undefined', () => {
      expect(scheduler.getTask('nonexistent')).toBeUndefined();
    });
  });

  describe('updateTask / toggleTask', () => {
    it('updateTask 应该更新指定任务的字段', () => {
      scheduler.updateTask('env_awareness', {
        priority: 5,
        description: '更新后的描述',
      });

      const task = scheduler.getTask('env_awareness');
      expect(task!.priority).toBe(5);
      expect(task!.description).toBe('更新后的描述');
    });

    it('updateTask 对不存在的 id 应静默忽略', () => {
      expect(() => {
        scheduler.updateTask('nonexistent', { priority: 10 });
      }).not.toThrow();
    });

    it('toggleTask 无参数应该切换任务启用状态', () => {
      const taskBefore = scheduler.getTask('env_awareness');
      expect(taskBefore!.enabled).toBe(true);

      scheduler.toggleTask('env_awareness');

      const taskAfter = scheduler.getTask('env_awareness');
      expect(taskAfter!.enabled).toBe(false);
    });

    it('toggleTask 传入 true 应该启用任务', () => {
      scheduler.toggleTask('env_awareness', false);
      scheduler.toggleTask('env_awareness', true);

      expect(scheduler.getTask('env_awareness')!.enabled).toBe(true);
    });

    it('toggleTask 传入 false 应该禁用任务', () => {
      scheduler.toggleTask('env_awareness', false);

      expect(scheduler.getTask('env_awareness')!.enabled).toBe(false);
    });

    it('toggleTask 对不存在的 id 应静默忽略', () => {
      expect(() => {
        scheduler.toggleTask('nonexistent');
      }).not.toThrow();
    });
  });

  describe('setMemoryEngine / setLLMCore', () => {
    it('setMemoryEngine 应该注入记忆引擎', () => {
      const mockEngine =
        {} as unknown as import('../../../src/memory/MemoryEngine').MemoryEngine;
      expect(() => scheduler.setMemoryEngine(mockEngine)).not.toThrow();
    });

    it('setLLMCore 应该注入 LLM 核心', () => {
      const mockCore =
        {} as unknown as import('../../../src/core/JiabaixingCore').JiabaixingCore;
      expect(() => scheduler.setLLMCore(mockCore)).not.toThrow();
    });
  });

  describe('getUserBehaviorPattern', () => {
    it('应该返回默认行为模式', () => {
      const pattern = scheduler.getUserBehaviorPattern();
      expect(pattern).toEqual({
        activeHours: [],
        frequentTopics: [],
        taskCompletionRate: 0,
        averageSessionDuration: 0,
      });
    });
  });

  describe('getProactiveTriggers', () => {
    it('应该返回触发器数组', () => {
      const triggers = scheduler.getProactiveTriggers();
      // 冷却期内可能返回空数组，但不应该是永远空的
      expect(Array.isArray(triggers)).toBe(true);
    });

    it('应该在深夜时段返回late_night触发器', () => {
      // 模拟深夜时间
      const originalDate = Date;
      const mockDate = new Date('2024-01-01T23:30:00');
      jest.spyOn(global, 'Date').mockImplementation(() => mockDate as unknown as Date);
      Date.now = jest.fn(() => mockDate.getTime());

      // 重置冷却期
      (scheduler as unknown as { lastProactiveTrigger: number }).lastProactiveTrigger = 0;

      const triggers = scheduler.getProactiveTriggers();
      const hasLateNight = triggers.some((t) => t.reason === 'late_night');
      expect(hasLateNight).toBe(true);

      // 恢复
      global.Date = originalDate;
      jest.restoreAllMocks();
    });
  });
});
