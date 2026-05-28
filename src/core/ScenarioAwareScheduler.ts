/**
 * 场景感知调度器 v3 — 主动环境感知版
 * 核心功能：
 * 1. 基于时间的任务调度
 * 2. 桌面环境主动感知（前台窗口、进程、状态）
 * 3. 主动推送给前端
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

/** 环境感知快照 */
export interface EnvironmentSnapshot {
  timestamp: string;
  foregroundWindow: { title: string; process: string } | null;
  activeEnv: 'coding' | 'browsing' | 'idle' | 'unknown';
  recentProjects: string[];
}

// ── 调度器主类 ──
export class ScenarioAwareScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private isRunning: boolean = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CHECK_INTERVAL_MS = 30000; // 30秒检查一次
  private memoryEngine: MemoryEngine | null = null;
  private llmCore: JiabaixingCore | null = null;

  // 环境感知缓存
  private lastSnapshot: EnvironmentSnapshot | null = null;
  private lastForegroundCheck: number = 0;
  private readonly FOREGROUND_CHECK_INTERVAL = 15000; // 15秒最小间隔

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
    // 由 processInput 调用，标记用户活跃
  }

  /** 获取最新环境快照 */
  public getEnvironmentSnapshot(): EnvironmentSnapshot | null {
    return this.lastSnapshot;
  }

  // ── 初始化 ──
  private initializeDefaultTasks(): void {
    const defaultTasks: ScheduledTask[] = [
      {
        id: 'morning_briefing',
        name: '早安问候',
        description: '每天早晨提供问候',
        schedule: '0 9 * * *',
        priority: 1,
        enabled: true,
        executionCount: 0,
        successCount: 0,
        averageExecutionTime: 0,
      },
      {
        id: 'env_awareness',
        name: '环境感知',
        description: '每30秒感知桌面环境并推送状态',
        schedule: '*/1 * * * *',
        priority: 2,
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
    Logger.info('🚀 场景感知调度器已启动（含环境感知）', 'ScenarioAwareScheduler');
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

  // ── 环境感知 ──
  private async senseEnvironment(): Promise<EnvironmentSnapshot> {
    const now = Date.now();
    // 限频：15秒内不重复检查
    if (this.lastSnapshot && now - this.lastForegroundCheck < this.FOREGROUND_CHECK_INTERVAL) {
      return this.lastSnapshot;
    }
    this.lastForegroundCheck = now;

    let foregroundWindow: { title: string; process: string } | null = null;
    let activeEnv: 'coding' | 'browsing' | 'idle' | 'unknown' = 'unknown';

    try {
      const { WindowManager } = await import('../desktop/WindowManager');
      const wm = WindowManager.getInstance();
      const fg = wm.getForegroundWindow();
      if (fg) {
        foregroundWindow = { title: fg.title || '', process: fg.processName || '' };
        // 判断环境类型
        const title = (fg.title || '').toLowerCase();
        const proc = (fg.processName || '').toLowerCase();
        if (title.includes('.ts') || title.includes('.js') || title.includes('.py') ||
            title.includes('code') || title.includes('vscode') || title.includes('idea') ||
            proc.includes('code') || proc.includes('terminal') || proc.includes('cmd') ||
            proc.includes('powershell') || proc.includes('bash') || proc.includes('idea') ||
            proc.includes('cursor') || proc.includes('windsurf')) {
          activeEnv = 'coding';
        } else if (proc.includes('chrome') || proc.includes('edge') || proc.includes('firefox') ||
                   proc.includes('explorer') || title.includes('http')) {
          activeEnv = 'browsing';
        } else {
          activeEnv = 'idle';
        }
      }
    } catch (err) {
      Logger.warn(`⚠️ 环境感知失败: ${(err as Error).message}`, 'ScenarioAwareScheduler');
    }

    const snapshot: EnvironmentSnapshot = {
      timestamp: new Date().toISOString(),
      foregroundWindow,
      activeEnv,
      recentProjects: [],
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  // ── 任务检查与执行 ──
  private async checkAndExecuteTasks(): Promise<void> {
    const now = new Date();
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (this.shouldExecuteTask(task, now)) {
        await this.executeTask(task);
      }
    }

    // 环境感知任务 — 非定时模式，每次检查都跑
    const envTask = this.tasks.get('env_awareness');
    if (envTask && envTask.enabled) {
      const snapshot = await this.senseEnvironment();
      if (snapshot.foregroundWindow) {
        Logger.info(
          `👀 环境: ${snapshot.activeEnv} | ${snapshot.foregroundWindow.process} - ${snapshot.foregroundWindow.title.substring(0, 40)}`,
          'ScenarioAwareScheduler'
        );
        // 推送给前端
        EventBus.emit('environment_update', {
          timestamp: snapshot.timestamp,
          activeEnv: snapshot.activeEnv,
          foregroundWindow: snapshot.foregroundWindow,
        });
      }
    }
  }

  private shouldExecuteTask(task: ScheduledTask, now: Date): boolean {
    if (!task.nextRun) {
      task.nextRun = new Date(now.getTime() + 60 * 1000);
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
        case 'env_awareness':
          // 环境感知由checkAndExecuteTasks直接执行，这里只是占位
          break;
      }

      task.lastRun = new Date();
      task.nextRun = new Date(Date.now() + 60 * 60 * 1000);
      task.executionCount++;
      task.successCount++;
      task.averageExecutionTime =
        (task.averageExecutionTime * (task.executionCount - 1) +
          (Date.now() - startTime)) /
        task.executionCount;

      Logger.info(`✅ 任务完成: ${task.name} (${Date.now() - startTime}ms)`, 'ScenarioAwareScheduler');
    } catch (error) {
      Logger.warn(`❌ 任务执行失败: ${task.name} - ${(error as Error).message}`, 'ScenarioAwareScheduler');
    }
  }

  private async executeMorningBriefing(): Promise<void> {
    Logger.info('☀️ 早安问候', 'ScenarioAwareScheduler');
    const snapshot = await this.senseEnvironment();
    EventBus.emit('proactive_interaction', {
      reason: '早安问候',
      context: snapshot.foregroundWindow
        ? `当前你在${snapshot.activeEnv === 'coding' ? '写代码' : snapshot.activeEnv === 'browsing' ? '浏览' : '其他'}, 前台窗口: ${snapshot.foregroundWindow.title}`
        : '新的一天开始了',
      scene: '日常',
    });
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
