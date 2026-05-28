/**
 * ScenarioAwareScheduler 单元测试
 * 覆盖：构造函数与默认任务、启停控制、任务增删改查、依赖注入、行为模式与主动触发
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

import { ScenarioAwareScheduler, ScheduledTask } from '../../../src/core/ScenarioAwareScheduler';
import { Logger } from '../../../src/utils/Logger';
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

  /** 构造函数与默认任务 */
  describe('构造和初始化', () => {
    it('应该正确创建实例', () => {
      expect(scheduler).toBeDefined();
      expect(scheduler.isActive()).toBe(false);
    });

    it('应该初始化默认任务 morning_briefing', () => {
      const tasks = scheduler.getTasks();
      expect(tasks.length).toBe(1);

      const morningTask = scheduler.getTask('morning_briefing');
      expect(morningTask).toBeDefined();
      expect(morningTask!.name).toBe('早安问候');
      expect(morningTask!.schedule).toBe('0 9 * * *');
      expect(morningTask!.priority).toBe(1);
      expect(morningTask!.enabled).toBe(true);
      expect(morningTask!.executionCount).toBe(0);
      expect(morningTask!.successCount).toBe(0);
      expect(morningTask!.averageExecutionTime).toBe(0);
    });
  });

  /** 启停控制 */
  describe('start / stop / isActive', () => {
    it('start 应该激活调度器并发射 scheduler_started 事件', () => {
      scheduler.start();

      expect(scheduler.isActive()).toBe(true);
      expect(EventBus.emit).toHaveBeenCalledWith('scheduler_started', expect.objectContaining({
        timestamp: expect.any(String),
      }));
    });

    it('重复 start 应该发出警告且不重复启动', () => {
      scheduler.start();
      const callCountBefore = (Logger.warn as jest.Mock).mock.calls.length;

      scheduler.start();

      expect(scheduler.isActive()).toBe(true);
      expect(Logger.warn).toHaveBeenCalledWith('调度器已在运行中', 'ScenarioAwareScheduler');
      expect((Logger.warn as jest.Mock).mock.calls.length).toBe(callCountBefore + 1);
    });

    it('stop 应该停止调度器并发射 scheduler_stopped 事件', () => {
      scheduler.start();
      scheduler.stop();

      expect(scheduler.isActive()).toBe(false);
      expect(EventBus.emit).toHaveBeenCalledWith('scheduler_stopped', expect.objectContaining({
        timestamp: expect.any(String),
      }));
    });

    it('未启动时 stop 不应发射事件', () => {
      scheduler.stop();

      expect(scheduler.isActive()).toBe(false);
      expect(EventBus.emit).not.toHaveBeenCalledWith('scheduler_stopped', expect.anything());
    });
  });

  /** 任务增删改查 */
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
      expect(Logger.info).toHaveBeenCalledWith('➕ 任务已添加: 自定义任务', 'ScenarioAwareScheduler');
    });

    it('getTasks 应该返回所有任务数组', () => {
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
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id)).toContain('morning_briefing');
      expect(tasks.map((t) => t.id)).toContain('extra_task');
    });

    it('getTask 对不存在的 id 应返回 undefined', () => {
      expect(scheduler.getTask('nonexistent')).toBeUndefined();
    });
  });

  /** updateTask / toggleTask */
  describe('updateTask / toggleTask', () => {
    it('updateTask 应该更新指定任务的字段', () => {
      scheduler.updateTask('morning_briefing', { priority: 5, description: '更新后的描述' });

      const task = scheduler.getTask('morning_briefing');
      expect(task!.priority).toBe(5);
      expect(task!.description).toBe('更新后的描述');
    });

    it('updateTask 对不存在的 id 应静默忽略', () => {
      expect(() => {
        scheduler.updateTask('nonexistent', { priority: 10 });
      }).not.toThrow();
    });

    it('toggleTask 无参数应该切换任务启用状态', () => {
      const taskBefore = scheduler.getTask('morning_briefing');
      expect(taskBefore!.enabled).toBe(true);

      scheduler.toggleTask('morning_briefing');

      const taskAfter = scheduler.getTask('morning_briefing');
      expect(taskAfter!.enabled).toBe(false);
      expect(Logger.info).toHaveBeenCalledWith('禁用 任务: 早安问候', 'ScenarioAwareScheduler');
    });

    it('toggleTask 传入 true 应该启用任务', () => {
      scheduler.toggleTask('morning_briefing', false);
      scheduler.toggleTask('morning_briefing', true);

      expect(scheduler.getTask('morning_briefing')!.enabled).toBe(true);
      expect(Logger.info).toHaveBeenCalledWith('启用 任务: 早安问候', 'ScenarioAwareScheduler');
    });

    it('toggleTask 传入 false 应该禁用任务', () => {
      scheduler.toggleTask('morning_briefing', false);

      expect(scheduler.getTask('morning_briefing')!.enabled).toBe(false);
      expect(Logger.info).toHaveBeenCalledWith('禁用 任务: 早安问候', 'ScenarioAwareScheduler');
    });

    it('toggleTask 对不存在的 id 应静默忽略', () => {
      expect(() => {
        scheduler.toggleTask('nonexistent');
      }).not.toThrow();
    });
  });

  /** 依赖注入 */
  describe('setMemoryEngine / setLLMCore', () => {
    it('setMemoryEngine 应该注入记忆引擎', () => {
      const mockEngine = {} as any;
      scheduler.setMemoryEngine(mockEngine);

      expect(Logger.info).toHaveBeenCalledWith('✅ 记忆引擎已注入到调度器', 'ScenarioAwareScheduler');
    });

    it('setLLMCore 应该注入 LLM 核心', () => {
      const mockCore = {} as any;
      scheduler.setLLMCore(mockCore);

      expect(Logger.info).toHaveBeenCalledWith('✅ LLM核心已注入到调度器', 'ScenarioAwareScheduler');
    });
  });

  /** getUserBehaviorPattern */
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

  /** getProactiveTriggers */
  describe('getProactiveTriggers', () => {
    it('应该返回空数组', () => {
      const triggers = scheduler.getProactiveTriggers();
      expect(triggers).toEqual([]);
    });
  });
});
