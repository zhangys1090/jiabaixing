/**
 * 场景感知调度器 v2 - 简化版
 * 核心功能：
 * 1. 基于时间的任务调度
 * 2. 与记忆引擎集成
 * 3. 简化的主动关怀
 */

import { MemoryEngine } from '../memory/MemoryEngine';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';

type JiabaixingCore = import('./JiabaixingCore').JiabaixingCore;

// ── 类型定义 ──
export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  schedule: string;
  priority: number;
  lastRun?: Date;
  nextRun?: Date;
  enabled: boolean;
  executionCount: number;
  successCount: number;
  averageExecutionTime: number;
}

// ── 调度器主类 ──
export class ScenarioAwareScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private isRunning: boolean = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CHECK_INTERVAL_MS = 30000;
  private memoryEngine: MemoryEngine | null = null;
  private llmCore: JiabaixingCore | null = null;

  constructor() {
    this.initializeDefaultTasks();
  }

  /** 注入记忆引擎 */
  public setMemoryEngine(engine: MemoryEngine): void {
    this.memoryEngine = engine;
    Logger.info('✅ 记忆引擎已注入到调度器', 'ScenarioAwareScheduler');
  }

  /** 注入LLM核心 */
  public setLLMCore(core: JiabaixingCore): void {
    this.llmCore = core;
    Logger.info('✅ LLM核心已注入到调度器', 'ScenarioAwareScheduler');
  }

  /** 更新用户活跃状态 */
  public updateUserActivity(): void {
    // 简单实现：记录最后活跃时间
  }

  // ── 初始化 ──
  private initializeDefaultTasks(): void {
    const defaultTasks: ScheduledTask[] = [
      {
        id: 'morning_briefing',
        name: '早安问候',
        description: '每天早晨提供问候和天气提醒',
        schedule: '0 9 * * *',
        priority: 1,
        enabled: true,
        executionCount: 0,
        successCount: 0,
        averageExecutionTime: 0,
      },
    ];
    defaultTasks.forEach((task) => {
      this.tasks.set(task.id, task);
    });
  }

  // ── 核心调度循环 ──
  public start(): void {
    if (this.isRunning) {
      Logger.warn('调度器已在运行中', 'ScenarioAwareScheduler');
      return;
    }
    this.isRunning = true;
    Logger.info('🚀 场景感知调度器已启动', 'ScenarioAwareScheduler');
    void this.checkAndExecuteTasks();
    this.checkInterval = setInterval(() => {
      void this.checkAndExecuteTasks();
    }, this.CHECK_INTERVAL_MS);
    void EventBus.emit('scheduler_started', {
      timestamp: new Date().toISOString(),
    });
  }

  public stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    Logger.info('⏹ 场景感知调度器已停止', 'ScenarioAwareScheduler');
    void EventBus.emit('scheduler_stopped', {
      timestamp: new Date().toISOString(),
    });
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  // ── 任务检查与执行 ──
  private async checkAndExecuteTasks(): Promise<void> {
    const now = new Date();
    // 1. 检查基于时间的任务
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (this.shouldExecuteTask(task, now)) {
        await this.executeTask(task);
      }
    }
  }

  private shouldExecuteTask(task: ScheduledTask, now: Date): boolean {
    // 简化的调度检查：每小时检查一次
    if (!task.nextRun) {
      task.nextRun = new Date(now.getTime() + 60 * 60 * 1000); // 1小时后
      return false;
    }

    if (now >= task.nextRun) {
      return true;
    }

    return false;
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    const startTime = Date.now();

    Logger.info(`📋 执行任务: ${task.name}`, 'ScenarioAwareScheduler');

    try {
      switch (task.id) {
        case 'morning_briefing':
          await this.executeMorningBriefing();
          break;
      }

      task.lastRun = new Date();
      task.nextRun = new Date(Date.now() + 60 * 60 * 1000); // 1小时后
      task.executionCount++;
      task.successCount++;
      task.averageExecutionTime =
        (task.averageExecutionTime * (task.executionCount - 1) +
          (Date.now() - startTime)) /
        task.executionCount;

      Logger.info(
        `✅ 任务完成: ${task.name} (${Date.now() - startTime}ms)`,
        'ScenarioAwareScheduler'
      );
    } catch (error) {
      Logger.warn(
        `❌ 任务执行失败: ${task.name} - ${(error as Error).message}`,
        'ScenarioAwareScheduler'
      );
    }
  }

  private async executeMorningBriefing(): Promise<void> {
    Logger.info('☀️ 执行早安问候任务', 'ScenarioAwareScheduler');
    // 简化实现：不执行实际操作
  }

  // ── 公开 API ──
  public getTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  public getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  public updateTask(taskId: string, updates: Partial<ScheduledTask>): void {
    const task = this.tasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
    }
  }

  public addTask(task: ScheduledTask): string {
    this.tasks.set(task.id, task);
    Logger.info(`➕ 任务已添加: ${task.name}`, 'ScenarioAwareScheduler');
    return task.id;
  }

  public toggleTask(taskId: string, enabled?: boolean): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.enabled = enabled ?? !task.enabled;
      Logger.info(`${task.enabled ? '启用' : '禁用'} 任务: ${task.name}`, 'ScenarioAwareScheduler');
    }
  }

  public async executeTaskById(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      await this.executeTask(task);
    } else {
      throw new Error(`任务不存在: ${taskId}`);
    }
  }

  public getProactiveTriggers(): Array<{ type: string; reason: string; priority: number }> {
    return [];
  }

  public getUserBehaviorPattern(): {
    activeHours: string[];
    frequentTopics: string[];
    taskCompletionRate: number;
    averageSessionDuration: number;
  } {
    return {
      activeHours: [],
      frequentTopics: [],
      taskCompletionRate: 0,
      averageSessionDuration: 0,
    };
  }
}
