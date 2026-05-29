/**
 * 场景感知调度器 v4 — 主动工作流版
 * 核心功能：
 * 1. 基于时间的任务调度
 * 2. 桌面环境主动感知（前台窗口、进程、状态）
 * 3. Git项目变化感知（新分支、未提交、新commit）
 * 4. 主动推送给前端/EventBus
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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

export interface EnvironmentSnapshot {
  timestamp: string;
  foregroundWindow: { title: string; process: string } | null;
  activeEnv: 'coding' | 'browsing' | 'idle' | 'unknown';
  recentProjects: string[];
}

export interface GitSnapshot {
  repo: string;
  branch: string;
  hasUncommitted: boolean;
  uncommittedFiles: number;
  aheadCount: number;
  behindCount: number;
  lastCommitMsg: string;
  lastCommitAgo: string;
}

export interface ProjectChange {
  type:
    | 'git_uncommitted'
    | 'git_new_branch'
    | 'git_new_commits'
    | 'project_switch';
  repo: string;
  detail: string;
  timestamp: string;
}

// ── 调度器主类 ──
export class ScenarioAwareScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private isRunning: boolean = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CHECK_INTERVAL_MS = 30000;
  private memoryEngine: MemoryEngine | null = null;
  private llmCore: JiabaixingCore | null = null;

  // 环境感知缓存
  private lastSnapshot: EnvironmentSnapshot | null = null;
  private lastForegroundCheck: number = 0;
  private readonly FOREGROUND_CHECK_INTERVAL = 15000;
  private lastEnv: string = '';

  // Git 感知
  private readonly WATCHED_DIRS = [
    process.cwd(), // jiabaixing 自身
    path.resolve(process.cwd(), '..', 'hermes-agent-main'), // hermes
    path.resolve(process.cwd(), '..'), // /c/zy 根目录
  ];
  private lastGitState: Map<
    string,
    { branch: string; commit: string; hasUncommitted: boolean }
  > = new Map();
  private gitCheckCount: number = 0;
  private readonly GIT_CHECK_INTERVAL = 10; // 每10次检查（约5分钟）做一次git感知
  private projectChangeHistory: ProjectChange[] = [];
  private readonly MAX_CHANGE_HISTORY = 50;

  constructor() {
    this.initializeDefaultTasks();
  }

  public setMemoryEngine(engine: MemoryEngine): void {
    this.memoryEngine = engine;
  }

  public setLLMCore(core: JiabaixingCore): void {
    this.llmCore = core;
  }

  public updateUserActivity(): void {}

  public getEnvironmentSnapshot(): EnvironmentSnapshot | null {
    return this.lastSnapshot;
  }

  public getProactiveTriggers(): Array<{
    type: string;
    reason: string;
    priority: number;
  }> {
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

  public getProjectChanges(): ProjectChange[] {
    return [...this.projectChangeHistory];
  }

  // ── 初始化 ──
  private initializeDefaultTasks(): void {
    const defaultTasks: ScheduledTask[] = [
      {
        id: 'env_awareness',
        name: '环境感知',
        description: '每30秒感知桌面环境',
        schedule: '*/1 * * * *',
        priority: 2,
        enabled: true,
        executionCount: 0,
        successCount: 0,
        averageExecutionTime: 0,
      },
      {
        id: 'git_awareness',
        name: 'Git感知',
        description: '定期扫描项目git变化',
        schedule: '*/5 * * * *',
        priority: 3,
        enabled: true,
        executionCount: 0,
        successCount: 0,
        averageExecutionTime: 0,
      },
    ];
    defaultTasks.forEach((task) => this.tasks.set(task.id, task));
  }

  // ── 核心调度循环 ──
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    Logger.info(
      '🚀 调度器启动（含环境感知+Git感知）',
      'ScenarioAwareScheduler'
    );
    void this.checkAndExecuteTasks();
    this.checkInterval = setInterval(() => {
      void this.checkAndExecuteTasks();
    }, this.CHECK_INTERVAL_MS);
    EventBus.emit('scheduler_started', { timestamp: new Date().toISOString() });
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.checkInterval = null;
    Logger.info('⏹ 调度器已停止', 'ScenarioAwareScheduler');
    EventBus.emit('scheduler_stopped', { timestamp: new Date().toISOString() });
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  // ── 环境感知 ──
  private async senseEnvironment(): Promise<EnvironmentSnapshot> {
    const now = Date.now();
    if (
      this.lastSnapshot &&
      now - this.lastForegroundCheck < this.FOREGROUND_CHECK_INTERVAL
    ) {
      return this.lastSnapshot;
    }
    this.lastForegroundCheck = now;

    let foregroundWindow: { title: string; process: string } | null = null;
    let activeEnv: 'coding' | 'browsing' | 'idle' | 'unknown' = 'unknown';

    try {
      const result = execSync(
        `powershell -NoProfile -Command "Add-Type @\\\"using System;using System.Runtime.InteropServices;using System.Text;public class WAPIS{[DllImport(\\\"user32.dll\\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\\"user32.dll\\\")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport(\\\"user32.dll\\\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}\\\";$h=[WAPIS]::GetForegroundWindow();$s=New-Object Text.StringBuilder 256;[WAPIS]::GetWindowText($h,$s,256)|Out-Null;$p=0;[WAPIS]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;Write-Output \\\"$n|$($s.ToString())\\\""`,
        { timeout: 5000, encoding: 'utf-8' }
      )
        .toString()
        .trim();

      const parts = result.split('|');
      if (parts.length >= 2 && parts[0]) {
        const proc = parts[0];
        const title = parts.slice(1).join('|');
        foregroundWindow = { title, process: proc };

        const tl = title.toLowerCase();
        const pl = proc.toLowerCase();
        if (
          tl.includes('code') ||
          tl.includes('vscode') ||
          pl.includes('code') ||
          tl.includes('terminal') ||
          pl.includes('terminal') ||
          pl.includes('cmd') ||
          pl.includes('powershell') ||
          pl.includes('bash') ||
          tl.includes('cursor') ||
          tl.includes('windsurf') ||
          tl.includes('.ts') ||
          tl.includes('.jsx')
        ) {
          activeEnv = 'coding';
        } else if (
          pl.includes('chrome') ||
          pl.includes('edge') ||
          pl.includes('firefox') ||
          pl.includes('explorer') ||
          tl.includes('http')
        ) {
          activeEnv = 'browsing';
        } else {
          activeEnv = 'idle';
        }
      }
    } catch {
      // 环境检测失败不影响
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

  // ── Git感知 ──
  private scanGitRepos(): GitSnapshot[] {
    const results: GitSnapshot[] = [];
    for (const dir of this.WATCHED_DIRS) {
      try {
        const gitDir = path.join(dir, '.git');
        if (!fs.existsSync(gitDir)) continue;

        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: dir,
          timeout: 3000,
          encoding: 'utf-8',
        })
          .toString()
          .trim();
        const status = execSync('git status --porcelain', {
          cwd: dir,
          timeout: 3000,
          encoding: 'utf-8',
        })
          .toString()
          .trim();
        const hasUncommitted = status.length > 0;
        const uncommittedFiles = status
          ? status.split('\n').filter((l) => l).length
          : 0;
        let aheadBehind = '0 0';
        try {
          aheadBehind = execSync(
            'git rev-list --count --left-right HEAD...@{upstream}',
            { cwd: dir, timeout: 3000, encoding: 'utf-8' }
          )
            .toString()
            .trim();
        } catch {
          aheadBehind = '0 0';
        }
        const [ahead, behind] = aheadBehind.split(/\s+/).map(Number);
        let lastCommitMsg = '(无commit)';
        try {
          lastCommitMsg = execSync(
            'git log -1 --format=%s',
            { cwd: dir, timeout: 3000, encoding: 'utf-8' }
          )
            .toString()
            .trim();
        } catch {
          lastCommitMsg = '(无commit)';
        }
        let lastCommitTs = 0;
        try {
          lastCommitTs = parseInt(
            execSync('git log -1 --format=%ct', {
              cwd: dir,
              timeout: 3000,
              encoding: 'utf-8',
            })
              .toString()
              .trim()
          );
        } catch {
          lastCommitTs = 0;
        }
        const lastCommitAgo =
          lastCommitTs > 0
            ? `${Math.round((Date.now() / 1000 - lastCommitTs) / 60)}分钟前`
            : '未知';

        results.push({
          repo: path.basename(dir),
          branch,
          hasUncommitted,
          uncommittedFiles,
          aheadCount: ahead || 0,
          behindCount: behind || 0,
          lastCommitMsg,
          lastCommitAgo,
        });

        // 检测变化
        const lastState = this.lastGitState.get(dir);
        let currentCommit = '';
        try {
          currentCommit = execSync(
            'git rev-parse HEAD',
            { cwd: dir, timeout: 3000, encoding: 'utf-8' }
          )
            .toString()
            .trim();
        } catch {
          currentCommit = '';
        }
        if (lastState) {
          const changes: ProjectChange[] = [];
          if (hasUncommitted && !lastState.hasUncommitted) {
            changes.push({
              type: 'git_uncommitted',
              repo: path.basename(dir),
              detail: `${uncommittedFiles}个文件未提交`,
              timestamp: new Date().toISOString(),
            });
          }
          if (currentCommit && currentCommit !== lastState.commit) {
            changes.push({
              type: 'git_new_commits',
              repo: path.basename(dir),
              detail: `新commit: ${lastCommitMsg.substring(0, 50)}`,
              timestamp: new Date().toISOString(),
            });
          }
          if (branch !== lastState.branch) {
            changes.push({
              type: 'git_new_branch',
              repo: path.basename(dir),
              detail: `切换到分支: ${branch}`,
              timestamp: new Date().toISOString(),
            });
          }
          for (const c of changes) {
            this.projectChangeHistory.push(c);
            if (this.projectChangeHistory.length > this.MAX_CHANGE_HISTORY) {
              this.projectChangeHistory.shift();
            }
            Logger.info(
              `📂 项目变化: ${c.type} | ${c.repo}: ${c.detail}`,
              'ScenarioAwareScheduler'
            );
            EventBus.emit('project_change', c);
          }
        }
        this.lastGitState.set(dir, {
          branch,
          commit: currentCommit,
          hasUncommitted,
        });
      } catch {
        // 非git目录或git不可用，跳过
      }
    }
    return results;
  }

  // ── 任务检查与执行 ──
  private async checkAndExecuteTasks(): Promise<void> {
    const now = new Date();

    // 环境感知（每次）
    const snapshot = await this.senseEnvironment();
    const envStr = snapshot.activeEnv;
    if (envStr !== 'idle' || this.lastEnv !== envStr) {
      Logger.info(
        `👀 环境: ${envStr}${snapshot.foregroundWindow ? ' | ' + snapshot.foregroundWindow.process : ''}`,
        'ScenarioAwareScheduler'
      );
      this.lastEnv = envStr;
      EventBus.emit('environment_update', {
        timestamp: snapshot.timestamp,
        activeEnv: snapshot.activeEnv,
        foregroundWindow: snapshot.foregroundWindow,
      });
    }

    // Git感知（每60次 ≈ 30分钟）
    this.gitCheckCount++;
    if (this.gitCheckCount >= 60) {
      this.gitCheckCount = 0;
      const repos = this.scanGitRepos();
      if (repos.length > 0) {
        Logger.info(
          `📊 Git状态: ${repos.map((r) => `${r.repo}[${r.branch}]${r.hasUncommitted ? '*' : ''}${r.aheadCount > 0 ? '↑' + r.aheadCount : ''}${r.behindCount > 0 ? '↓' + r.behindCount : ''}`).join(', ')}`,
          'ScenarioAwareScheduler'
        );
        EventBus.emit('git_status', {
          timestamp: new Date().toISOString(),
          repos,
        });
      }
    }

    // 定时任务
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (this.shouldExecuteTask(task, now)) {
        await this.executeTask(task);
      }
    }
  }

  private shouldExecuteTask(task: ScheduledTask, now: Date): boolean {
    if (!task.nextRun) {
      task.nextRun = new Date(now.getTime() + 60 * 1000);
      return false;
    }
    return now >= task.nextRun;
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    const startTime = Date.now();
    Logger.info(`📋 执行任务: ${task.name}`, 'ScenarioAwareScheduler');
    try {
      task.lastRun = new Date();
      task.nextRun = new Date(Date.now() + 60 * 60 * 1000);
      task.executionCount++;
      task.successCount++;
      task.averageExecutionTime =
        (task.averageExecutionTime * (task.executionCount - 1) +
          (Date.now() - startTime)) /
        task.executionCount;
    } catch (error) {
      Logger.warn(`❌ 任务执行失败: ${task.name}`, 'ScenarioAwareScheduler');
    }
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
    if (task) Object.assign(task, updates);
  }

  public addTask(task: ScheduledTask): string {
    this.tasks.set(task.id, task);
    return task.id;
  }

  public toggleTask(taskId: string, enabled?: boolean): void {
    const task = this.tasks.get(taskId);
    if (task) task.enabled = enabled ?? !task.enabled;
  }

  public async executeTaskById(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    await this.executeTask(task);
  }
}
