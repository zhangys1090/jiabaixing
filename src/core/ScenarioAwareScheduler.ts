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
import { skillUsageTracker } from '../evolution/SkillUsageTracker';

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
  /** 自然语言任务描述，存在时由 JiabaixingCore 执行 */
  naturalDescription?: string;
  /** 目标推送平台，如 Slack / Telegram / 微信 */
  targetPlatform?: string;
}

/** 文件变更规则，定义文件变更时的自动响应行为 */
export interface FileChangeRule {
  id: string;
  name: string;
  /** glob 模式，如 *.test.ts 或 src 目录下递归匹配 *.ts */
  pattern: string;
  /** 响应动作类型 */
  action: 'notify' | 'auto_fix' | 'run_tests' | 'custom';
  /** 当 action 为 custom 时，传给 LLM 的提示 */
  customPrompt?: string;
  enabled: boolean;
}

/** 文件变更事件载荷 */
export interface FileChangePayload {
  filePath: string;
  changeType: 'created' | 'modified' | 'deleted' | 'renamed';
  timestamp: string;
  matchedRules: Array<{ id: string; name: string; action: string }>;
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
  private enableFeedbackCollection: boolean = true;

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

  // 文件变更监听
  private fileWatchers: Array<fs.FSWatcher> = [];
  private watchedDirectories: string[] = [];
  private fileChangeRules: Map<string, FileChangeRule> = new Map();
  private fileDebounceMap: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      changeType: 'created' | 'modified' | 'deleted' | 'renamed';
    }
  > = new Map();
  private readonly FILE_DEBOUNCE_MS = 2000;
  private readonly WATCHED_EXTENSIONS = new Set([
    '.ts',
    '.js',
    '.json',
    '.md',
    '.py',
    '.tsx',
    '.jsx',
  ]);
  private readonly IGNORED_DIR_NAMES = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '__pycache__',
  ]);
  private fileChangeLog: Array<{
    filePath: string;
    changeType: string;
    timestamp: string;
  }> = [];
  private readonly MAX_CHANGE_LOG = 200;

  constructor() {
    this.initializeDefaultTasks();
    this.initializeDefaultFileChangeRules();
    this.watchedDirectories = [...this.WATCHED_DIRS];
  }

  public setMemoryEngine(engine: MemoryEngine): void {
    this.memoryEngine = engine;
  }

  public setLLMCore(core: JiabaixingCore): void {
    this.llmCore = core;
  }

  /**
   * 设置是否启用反馈收集（默认开启）
   * @param enabled - 是否启用反馈收集
   */
  public setFeedbackCollectionEnabled(enabled: boolean): void {
    this.enableFeedbackCollection = enabled;
    Logger.info(
      `反馈收集已${enabled ? '开启' : '关闭'}`,
      'ScenarioAwareScheduler'
    );
  }

  /**
   * 获取反馈收集配置状态
   * @returns 是否启用反馈收集
   */
  public isFeedbackCollectionEnabled(): boolean {
    return this.enableFeedbackCollection;
  }

  private lastUserActivity: number = Date.now();
  private lastProactiveTrigger: number = 0;
  private proactiveCheckCount: number = 0;
  private readonly PROACTIVE_COOLDOWN_MS = 10 * 60 * 1000; // 10分钟冷却

  public updateUserActivity(): void {
    this.lastUserActivity = Date.now();
  }

  public getEnvironmentSnapshot(): EnvironmentSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * 生成主动触发器 — 基于环境状态和用户行为
   */
  public getProactiveTriggers(): Array<{
    type: string;
    reason: string;
    priority: number;
  }> {
    const triggers: Array<{ type: string; reason: string; priority: number }> =
      [];
    const now = Date.now();

    // 冷却期内不触发
    if (now - this.lastProactiveTrigger < this.PROACTIVE_COOLDOWN_MS) {
      return triggers;
    }

    const silenceMinutes = (now - this.lastUserActivity) / 60000;

    // 1. 长时间无互动（30分钟+）
    if (silenceMinutes > 30) {
      triggers.push({
        type: 'proactive_interaction',
        reason: 'long_silence',
        priority: 2,
      });
    }

    // 2. 环境变化：从工作切换到空闲
    if (this.lastSnapshot?.activeEnv === 'idle' && silenceMinutes > 10) {
      triggers.push({
        type: 'proactive_interaction',
        reason: 'idle_reminder',
        priority: 3,
      });
    }

    // 3. Git 有未提交的变更（超过30分钟）
    for (const [, state] of this.lastGitState) {
      if (state.hasUncommitted && silenceMinutes > 5) {
        triggers.push({
          type: 'proactive_interaction',
          reason: 'git_changes',
          priority: 4,
          // 附加仓库信息到 reason
        });
      }
    }

    // 4. 深夜提醒（23:00 - 06:00）
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 6) {
      triggers.push({
        type: 'proactive_interaction',
        reason: 'late_night',
        priority: 5,
      });
    }

    // 5. 早晨问候（07:00 - 09:00）
    if (hour >= 7 && hour < 9) {
      triggers.push({
        type: 'proactive_interaction',
        reason: 'morning_greeting',
        priority: 1,
      });
    }

    if (triggers.length > 0) {
      this.lastProactiveTrigger = now;
    }

    return triggers;
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
      {
        id: 'skill_discovery',
        name: '进化Skill发现',
        description:
          '扫描 data/evolution/skills/ 目录发现新生成的 SKILL.md，广播到 EventBus',
        schedule: '*/10 * * * *',
        priority: 1,
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
      '🚀 调度器启动（含环境感知+Git感知+文件监听）',
      'ScenarioAwareScheduler'
    );
    this.checkAndExecuteTasks().catch((err) =>
      Logger.warn(
        `调度任务执行异常: ${(err as Error)?.message ?? String(err)}`,
        'ScenarioAwareScheduler'
      )
    );
    this.checkInterval = setInterval(() => {
      this.checkAndExecuteTasks().catch((err) =>
        Logger.warn(
          `调度任务执行异常: ${(err as Error)?.message ?? String(err)}`,
          'ScenarioAwareScheduler'
        )
      );
    }, this.CHECK_INTERVAL_MS);
    this.startFileWatching();
    EventBus.emit('scheduler_started', { timestamp: new Date().toISOString() });
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.checkInterval = null;
    this.stopFileWatching();
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
      const scriptPath = path.resolve(
        __dirname,
        '../../scripts/get-foreground-window.ps1'
      );
      const result = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
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
          lastCommitMsg = execSync('git log -1 --format=%s', {
            cwd: dir,
            timeout: 3000,
            encoding: 'utf-8',
          })
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
          currentCommit = execSync('git rev-parse HEAD', {
            cwd: dir,
            timeout: 3000,
            encoding: 'utf-8',
          })
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

    // ── 主动通知触发 ──
    // 每 3 次检查（约 90 秒）扫描一次触发器
    this.proactiveCheckCount++;
    if (this.proactiveCheckCount >= 3) {
      this.proactiveCheckCount = 0;
      const triggers = this.getProactiveTriggers();
      for (const trigger of triggers) {
        Logger.info(
          `📬 主动通知触发: ${trigger.reason} (优先级=${trigger.priority})`,
          'ScenarioAwareScheduler'
        );
        EventBus.emit('proactive_interaction', {
          reason: trigger.reason,
          context: `环境: ${snapshot.activeEnv}, 前台: ${snapshot.foregroundWindow?.process || '未知'}`,
          scene: snapshot.activeEnv === 'coding' ? 'development' : 'daily',
          isEmotionBased: false,
        });
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
    let taskSuccess = false;
    let taskError: string | undefined;
    try {
      // skill_discovery 定时扫描
      if (task.id === 'skill_discovery') {
        const skillsDir = path.resolve(
          process.cwd(),
          'data',
          'evolution',
          'skills'
        );
        if (fs.existsSync(skillsDir)) {
          const files = fs
            .readdirSync(skillsDir)
            .filter((f) => f.endsWith('.md'));
          EventBus.emit('skill_discovery', {
            timestamp: new Date().toISOString(),
            skillsDir,
            skillCount: files.length,
            skills: files.map((f) => ({
              name: f.replace(/\.md$/, ''),
              path: path.join(skillsDir, f),
            })),
          });
          Logger.debug(
            `🔍 发现 ${files.length} 个进化 Skill 文件`,
            'ScenarioAwareScheduler'
          );
        }
      }

      // 自然语言任务：通过 JiabaixingCore 执行
      if (task.naturalDescription && this.llmCore) {
        Logger.info(
          `🤖 执行自然语言任务: "${task.naturalDescription}"${task.targetPlatform ? ' → ' + task.targetPlatform : ''}`,
          'ScenarioAwareScheduler'
        );
        const nlInput = task.targetPlatform
          ? `${task.naturalDescription}，结果发送到${task.targetPlatform}`
          : task.naturalDescription;
        await this.llmCore.processInput(nlInput);
      }

      task.lastRun = new Date();
      task.nextRun = new Date(Date.now() + 60 * 60 * 1000);
      task.executionCount++;
      task.successCount++;
      task.averageExecutionTime =
        (task.averageExecutionTime * (task.executionCount - 1) +
          (Date.now() - startTime)) /
        task.executionCount;
      taskSuccess = true;

      // 任务执行成功：调用 SkillUsageTracker.trackUse()
      if (this.enableFeedbackCollection) {
        skillUsageTracker.trackUse(task.id);
      }
    } catch (error) {
      taskSuccess = false;
      taskError = (error as Error).message;
      Logger.warn(`❌ 任务执行失败: ${task.name}`, 'ScenarioAwareScheduler');
    }

    // 发射任务完成事件
    if (this.enableFeedbackCollection) {
      EventBus.emit('scheduled_task_completed', {
        taskId: task.id,
        taskName: task.name,
        success: taskSuccess,
        executionTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        error: taskError,
      });
    }
  }

  // ── 自然语言定时任务解析 ──

  /**
   * 解析自然语言定时任务描述，生成 cron 表达式、任务描述和目标平台
   * @param input - 自然语言描述，如"每天早上9点总结收件箱并发到Slack"
   * @returns 解析结果，包含 cronExpression、taskDescription、platform
   * @throws {Error} 当无法识别时间表达时抛出错误
   */
  public parseNaturalLanguageSchedule(input: string): {
    cronExpression: string;
    taskDescription: string;
    platform?: string;
  } {
    const text = input.trim();
    if (!text) {
      throw new Error('自然语言描述不能为空');
    }

    let cronExpression = '';
    let remaining = text;

    // ── 提取目标平台 ──
    let platform: string | undefined;
    const platformPatterns: Array<{ regex: RegExp; name: string }> = [
      {
        regex: /发到\s*Slack|发送到\s*Slack|推送到\s*Slack|Slack/i,
        name: 'Slack',
      },
      {
        regex: /发到\s*Telegram|发送到\s*Telegram|推送到\s*Telegram|Telegram/i,
        name: 'Telegram',
      },
      { regex: /发到\s*微信|发送到\s*微信|推送到\s*微信|微信/i, name: '微信' },
      { regex: /发到\s*钉钉|发送到\s*钉钉|推送到\s*钉钉|钉钉/i, name: '钉钉' },
      { regex: /发到\s*飞书|发送到\s*飞书|推送到\s*飞书|飞书/i, name: '飞书' },
      {
        regex: /发到\s*Email|发送到\s*Email|推送到\s*Email|邮件|email/i,
        name: 'Email',
      },
    ];
    for (const { regex, name } of platformPatterns) {
      if (regex.test(remaining)) {
        platform = name;
        remaining = remaining.replace(regex, '');
        break;
      }
    }

    // ── 解析时间表达 ──
    // 1. 每N分钟
    const everyNMinutesMatch = remaining.match(/每(\d+)分钟/);
    if (everyNMinutesMatch) {
      const n = parseInt(everyNMinutesMatch[1], 10);
      cronExpression = `*/${n} * * * *`;
      remaining = remaining.replace(everyNMinutesMatch[0], '');
    }

    // 2. 每小时
    if (!cronExpression && /每小时/.test(remaining)) {
      cronExpression = '0 * * * *';
      remaining = remaining.replace(/每小时/, '');
    }

    // 3. 每天早上/上午/下午/晚上N点
    if (!cronExpression) {
      const dailyMatch = remaining.match(/每天|每日/);
      if (dailyMatch) {
        const hourMatch = remaining.match(/(早上|上午|凌晨)(\d{1,2})点?/);
        const afternoonMatch = remaining.match(/(下午|晚上|晚间)(\d{1,2})点?/);
        if (hourMatch) {
          const hour = parseInt(hourMatch[2], 10);
          cronExpression = `0 ${hour} * * *`;
          remaining = remaining.replace(hourMatch[0], '');
        } else if (afternoonMatch) {
          const hour = parseInt(afternoonMatch[2], 10) + 12;
          cronExpression = `0 ${hour} * * *`;
          remaining = remaining.replace(afternoonMatch[0], '');
        } else {
          // "每天" 无具体时间 → 默认 9 点
          cronExpression = '0 9 * * *';
        }
        remaining = remaining.replace(dailyMatch[0], '');
      }
    }

    // 4. 工作日早上/上午/下午/晚上N点
    if (!cronExpression) {
      const weekdayMatch = remaining.match(/(?:每个)?工作日/);
      if (weekdayMatch) {
        const hourMatch = remaining.match(/(早上|上午|凌晨)(\d{1,2})点?/);
        const afternoonMatch = remaining.match(/(下午|晚上|晚间)(\d{1,2})点?/);
        if (hourMatch) {
          const hour = parseInt(hourMatch[2], 10);
          cronExpression = `0 ${hour} * * 1-5`;
          remaining = remaining.replace(hourMatch[0], '');
        } else if (afternoonMatch) {
          const hour = parseInt(afternoonMatch[2], 10) + 12;
          cronExpression = `0 ${hour} * * 1-5`;
          remaining = remaining.replace(afternoonMatch[0], '');
        } else {
          // "工作日" 无具体时间 → 默认 9 点
          cronExpression = '0 9 * * 1-5';
        }
        remaining = remaining.replace(weekdayMatch[0], '');
      }
    }

    // 5. 每周X / 周X
    if (!cronExpression) {
      const weekDayMap: Record<string, string> = {
        一: '1',
        二: '2',
        三: '3',
        四: '4',
        五: '5',
        六: '6',
        日: '0',
        天: '0',
      };
      const weekMatch = remaining.match(/(?:每个)?周([一二三四五六日天])/);
      if (weekMatch) {
        const dayOfWeek = weekDayMap[weekMatch[1]];
        const hourMatch = remaining.match(/(早上|上午|凌晨)(\d{1,2})点?/);
        const afternoonMatch = remaining.match(/(下午|晚上|晚间)(\d{1,2})点?/);
        if (hourMatch) {
          const hour = parseInt(hourMatch[2], 10);
          cronExpression = `0 ${hour} * * ${dayOfWeek}`;
          remaining = remaining.replace(hourMatch[0], '');
        } else if (afternoonMatch) {
          const hour = parseInt(afternoonMatch[2], 10) + 12;
          cronExpression = `0 ${hour} * * ${dayOfWeek}`;
          remaining = remaining.replace(afternoonMatch[0], '');
        } else {
          // "周一" 无具体时间 → 默认 9 点
          cronExpression = `0 9 * * ${dayOfWeek}`;
        }
        remaining = remaining.replace(weekMatch[0], '');
      }
    }

    // 6. 独立时间表达（无频率前缀，如"早上9点"）
    if (!cronExpression) {
      const hourMatch = remaining.match(/(早上|上午|凌晨)(\d{1,2})点?/);
      const afternoonMatch = remaining.match(/(下午|晚上|晚间)(\d{1,2})点?/);
      if (hourMatch) {
        const hour = parseInt(hourMatch[2], 10);
        cronExpression = `0 ${hour} * * *`;
        remaining = remaining.replace(hourMatch[0], '');
      } else if (afternoonMatch) {
        const hour = parseInt(afternoonMatch[2], 10) + 12;
        cronExpression = `0 ${hour} * * *`;
        remaining = remaining.replace(afternoonMatch[0], '');
      }
    }

    if (!cronExpression) {
      throw new Error(`无法识别时间表达: "${text}"`);
    }

    // ── 提取任务描述 ──
    const taskDescription = remaining
      .replace(/[，。、并的和]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      cronExpression,
      taskDescription: taskDescription || text,
      platform,
    };
  }

  /**
   * 通过自然语言描述创建定时任务
   * @param input - 自然语言描述，如"每个工作日早上9点总结我的收件箱并发到Slack"
   * @param taskId - 可选的任务ID，不传则自动生成
   * @returns 创建的 ScheduledTask 对象
   * @throws {Error} 当自然语言解析失败时抛出错误
   */
  public addTaskFromNaturalLanguage(
    input: string,
    taskId?: string
  ): ScheduledTask {
    const parsed = this.parseNaturalLanguageSchedule(input);

    const id = taskId || `nl_${Date.now()}`;
    const task: ScheduledTask = {
      id,
      name: parsed.taskDescription.substring(0, 30),
      description: parsed.taskDescription,
      schedule: parsed.cronExpression,
      priority: 3,
      enabled: true,
      executionCount: 0,
      successCount: 0,
      averageExecutionTime: 0,
      naturalDescription: parsed.taskDescription,
      targetPlatform: parsed.platform,
    };

    this.tasks.set(id, task);

    Logger.info(
      `📝 自然语言创建定时任务: id=${id}, cron="${parsed.cronExpression}", 描述="${parsed.taskDescription}"${parsed.platform ? ', 平台=' + parsed.platform : ''}`,
      'ScenarioAwareScheduler'
    );

    EventBus.emit('task_created_from_natural_language', {
      taskId: id,
      cronExpression: parsed.cronExpression,
      taskDescription: parsed.taskDescription,
      platform: parsed.platform,
      timestamp: new Date().toISOString(),
    });

    return task;
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

  // ── 文件变更监听 ──

  /**
   * 启动文件变更监听，对 watchedDirectories 中的目录递归监听文件变更
   * 使用 fs.watch() API，带防抖和文件过滤机制
   */
  public startFileWatching(): void {
    if (this.fileWatchers.length > 0) {
      Logger.warn('文件监听已在运行中', 'ScenarioAwareScheduler');
      return;
    }

    // WSL 下跳过文件监听（fs.watch 在 /mnt/ 挂载点上会阻塞）
    if (process.platform === 'linux') {
      Logger.info(
        'WSL环境检测，跳过文件监听（/mnt/ 挂载点不兼容 fs.watch）',
        'ScenarioAwareScheduler'
      );
      return;
    }

    for (const dir of this.watchedDirectories) {
      this.watchDirectory(dir);
    }

    Logger.info(
      `📁 文件监听已启动，监听 ${this.watchedDirectories.length} 个目录`,
      'ScenarioAwareScheduler'
    );
    EventBus.emit('file_watch_started', {
      directories: this.watchedDirectories,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 停止文件变更监听，关闭所有 fs.FSWatcher 并清理防抖定时器
   */
  public stopFileWatching(): void {
    for (const watcher of this.fileWatchers) {
      try {
        watcher.close();
      } catch {
        // Windows 上关闭 watcher 可能抛出异常，安全忽略
      }
    }
    this.fileWatchers = [];

    // 清理所有防抖定时器
    for (const [, entry] of this.fileDebounceMap) {
      clearTimeout(entry.timer);
    }
    this.fileDebounceMap.clear();

    Logger.info('📁 文件监听已停止', 'ScenarioAwareScheduler');
    EventBus.emit('file_watch_stopped', {
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 动态添加监听目录
   * @param dirPath - 要监听的目录绝对路径
   * @throws {Error} 当目录不存在时抛出错误
   */
  public addWatchDirectory(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    if (this.watchedDirectories.includes(resolved)) {
      Logger.warn(`目录已在监听列表中: ${resolved}`, 'ScenarioAwareScheduler');
      return;
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`目录不存在: ${resolved}`);
    }

    this.watchedDirectories.push(resolved);

    // 如果监听已在运行，立即开始监听新目录
    if (this.fileWatchers.length > 0) {
      this.watchDirectory(resolved);
    }

    Logger.info(`📁 添加监听目录: ${resolved}`, 'ScenarioAwareScheduler');
  }

  /**
   * 添加文件变更规则
   * @param rule - 文件变更规则对象
   */
  public addFileChangeRule(rule: FileChangeRule): void {
    this.fileChangeRules.set(rule.id, rule);
    Logger.info(
      `📜 添加文件变更规则: ${rule.name} (pattern=${rule.pattern}, action=${rule.action})`,
      'ScenarioAwareScheduler'
    );
  }

  /**
   * 移除文件变更规则
   * @param ruleId - 规则ID
   * @returns 是否成功移除
   */
  public removeFileChangeRule(ruleId: string): boolean {
    const removed = this.fileChangeRules.delete(ruleId);
    if (removed) {
      Logger.info(`📜 移除文件变更规则: ${ruleId}`, 'ScenarioAwareScheduler');
    }
    return removed;
  }

  /**
   * 获取所有文件变更规则
   * @returns 文件变更规则数组
   */
  public getFileChangeRules(): FileChangeRule[] {
    return Array.from(this.fileChangeRules.values());
  }

  /**
   * 获取文件变更日志
   * @returns 最近的文件变更记录
   */
  public getFileChangeLog(): Array<{
    filePath: string;
    changeType: string;
    timestamp: string;
  }> {
    return [...this.fileChangeLog];
  }

  /**
   * 处理文件变更事件：匹配规则并执行自动响应
   * @param filePath - 变更文件的绝对路径
   * @param changeType - 变更类型
   */
  public async handleFileChange(
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted' | 'renamed'
  ): Promise<void> {
    const timestamp = new Date().toISOString();

    // 记录到变更日志
    this.fileChangeLog.push({ filePath, changeType, timestamp });
    if (this.fileChangeLog.length > this.MAX_CHANGE_LOG) {
      this.fileChangeLog.shift();
    }

    // 匹配规则
    const matchedRules = this.matchRules(filePath);

    // 广播 file_changed 事件
    const payload: FileChangePayload = {
      filePath,
      changeType,
      timestamp,
      matchedRules: matchedRules.map((r) => ({
        id: r.id,
        name: r.name,
        action: r.action,
      })),
    };
    EventBus.emit('file_changed', payload);

    // 执行匹配到的规则动作
    for (const rule of matchedRules) {
      await this.executeRuleAction(rule, filePath, changeType, timestamp);
    }
  }

  // ── 文件监听私有方法 ──

  /**
   * 递归监听目录及其子目录
   * @param dirPath - 目录路径
   */
  private watchDirectory(dirPath: string): void {
    try {
      if (!fs.existsSync(dirPath)) return;

      // 检查是否为忽略的目录
      const dirName = path.basename(dirPath);
      if (this.IGNORED_DIR_NAMES.has(dirName)) return;

      // 监听当前目录
      try {
        const watcher = fs.watch(
          dirPath,
          { recursive: false },
          (eventType, filename) => {
            if (!filename) return;
            this.onFileEvent(dirPath, eventType, filename);
          }
        );
        this.fileWatchers.push(watcher);
      } catch {
        // Windows 上 fs.watch 可能对某些目录抛出异常，安全忽略
      }

      // 递归监听子目录
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !this.IGNORED_DIR_NAMES.has(entry.name)) {
            const subDir = path.join(dirPath, entry.name);
            this.watchDirectory(subDir);
          }
        }
      } catch {
        // 读取目录失败，跳过
      }
    } catch {
      Logger.warn(`监听目录失败: ${dirPath}`, 'ScenarioAwareScheduler');
    }
  }

  /**
   * 处理 fs.watch 回调事件，带防抖和文件过滤
   * @param dirPath - 事件所在目录
   * @param eventType - fs.watch 事件类型 (rename / change)
   * @param filename - 变更的文件名
   */
  private onFileEvent(
    dirPath: string,
    eventType: string,
    filename: string
  ): void {
    const ext = path.extname(filename).toLowerCase();
    if (!this.WATCHED_EXTENSIONS.has(ext)) return;

    const filePath = path.join(dirPath, filename);

    // 确定变更类型
    let changeType: 'created' | 'modified' | 'deleted' | 'renamed';
    if (eventType === 'rename') {
      // rename 事件可能是创建或删除，通过检查文件是否存在来判断
      try {
        fs.accessSync(filePath, fs.constants.F_OK);
        changeType = 'created';
      } catch {
        changeType = 'deleted';
      }
    } else {
      changeType = 'modified';
    }

    // 防抖：同一文件在 FILE_DEBOUNCE_MS 内的多次变更只触发一次
    const existing = this.fileDebounceMap.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.fileDebounceMap.delete(filePath);
      this.handleFileChange(filePath, changeType).catch((err) =>
        Logger.warn(
          `文件变更处理异常: ${filePath} -> ${
            (err as Error)?.message ?? String(err)
          }`,
          'ScenarioAwareScheduler'
        )
      );
    }, this.FILE_DEBOUNCE_MS);

    this.fileDebounceMap.set(filePath, { timer, changeType });
  }

  /**
   * 匹配文件路径与规则
   * @param filePath - 文件绝对路径
   * @returns 匹配到的启用规则列表
   */
  private matchRules(filePath: string): FileChangeRule[] {
    const matched: FileChangeRule[] = [];
    const fileName = path.basename(filePath);

    for (const rule of this.fileChangeRules.values()) {
      if (!rule.enabled) continue;
      if (this.matchGlob(filePath, fileName, rule.pattern)) {
        matched.push(rule);
      }
    }
    return matched;
  }

  /**
   * 简易 glob 模式匹配
   * 支持 * 通配符和 ** 递归目录匹配
   * @param filePath - 文件绝对路径
   * @param fileName - 文件名
   * @param pattern - glob 模式
   * @returns 是否匹配
   */
  private matchGlob(
    filePath: string,
    fileName: string,
    pattern: string
  ): boolean {
    // 精确文件名匹配
    if (pattern === fileName) return true;

    // 简单通配符匹配，如 "*.test.ts"
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".test.ts"
      return fileName.endsWith(suffix);
    }

    // 目录递归匹配，如 "src/**/*.ts"
    if (pattern.includes('**/')) {
      const parts = pattern.split('**/');
      const prefix = parts[0]; // "src/"
      const filePattern = parts[1]; // "*.ts"

      // 检查路径前缀
      const normalizedPath = filePath.replace(/\\/g, '/');
      if (prefix && !normalizedPath.includes(prefix.replace(/\\/g, '/'))) {
        return false;
      }

      // 检查文件后缀
      if (filePattern.startsWith('*.')) {
        const suffix = filePattern.slice(1);
        return fileName.endsWith(suffix);
      }
      return fileName === filePattern;
    }

    // 路径前缀匹配，如 "src/*.ts"
    if (pattern.includes('/')) {
      const normalizedPattern = pattern.replace(/\\/g, '/');
      const normalizedPath = filePath.replace(/\\/g, '/');
      const regexStr = normalizedPattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '[^/]*');
      try {
        const regex = new RegExp(regexStr);
        return regex.test(normalizedPath);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * 执行规则动作
   * @param rule - 匹配到的规则
   * @param filePath - 变更文件路径
   * @param changeType - 变更类型
   * @param timestamp - 变更时间戳
   */
  private async executeRuleAction(
    rule: FileChangeRule,
    filePath: string,
    changeType: string,
    timestamp: string
  ): Promise<void> {
    Logger.info(
      `⚡ 规则触发: ${rule.name} → ${rule.action} (${path.basename(filePath)} ${changeType})`,
      'ScenarioAwareScheduler'
    );

    EventBus.emit('file_change_rule_triggered', {
      ruleId: rule.id,
      ruleName: rule.name,
      action: rule.action,
      filePath,
      timestamp,
    });

    switch (rule.action) {
      case 'notify':
        // notify 动作仅通过事件广播，前端自行处理
        Logger.info(
          `📢 通知: 文件 ${path.basename(filePath)} 已${changeType}（规则: ${rule.name}）`,
          'ScenarioAwareScheduler'
        );
        break;

      case 'auto_fix':
        if (this.llmCore) {
          try {
            Logger.info(
              `🔧 自动修复: ${path.basename(filePath)}`,
              'ScenarioAwareScheduler'
            );
            await this.llmCore.processInput(
              `文件 ${filePath} 发生了 ${changeType} 变更，请检查并自动修复可能的问题。`
            );
          } catch (error) {
            Logger.error(
              `自动修复失败: ${path.basename(filePath)}`,
              error as Error,
              'ScenarioAwareScheduler'
            );
          }
        }
        break;

      case 'run_tests':
        if (this.llmCore) {
          try {
            Logger.info(
              `🧪 运行测试: ${path.basename(filePath)}`,
              'ScenarioAwareScheduler'
            );
            await this.llmCore.processInput(
              `文件 ${filePath} 发生了 ${changeType} 变更，请运行相关测试验证功能正常。`
            );
          } catch (error) {
            Logger.error(
              `运行测试失败: ${path.basename(filePath)}`,
              error as Error,
              'ScenarioAwareScheduler'
            );
          }
        }
        break;

      case 'custom':
        if (this.llmCore && rule.customPrompt) {
          try {
            Logger.info(
              `🎯 自定义动作: ${path.basename(filePath)}`,
              'ScenarioAwareScheduler'
            );
            const prompt = rule.customPrompt
              .replace('{filePath}', filePath)
              .replace('{changeType}', changeType)
              .replace('{fileName}', path.basename(filePath));
            await this.llmCore.processInput(prompt);
          } catch (error) {
            Logger.error(
              `自定义动作执行失败: ${path.basename(filePath)}`,
              error as Error,
              'ScenarioAwareScheduler'
            );
          }
        }
        break;
    }
  }

  /**
   * 初始化默认文件变更规则
   */
  private initializeDefaultFileChangeRules(): void {
    const defaultRules: FileChangeRule[] = [
      {
        id: 'rule_test_files',
        name: '测试文件变更通知',
        pattern: '*.test.ts',
        action: 'notify',
        enabled: true,
      },
      {
        id: 'rule_test_jsx_files',
        name: 'React测试文件变更通知',
        pattern: '*.test.tsx',
        action: 'notify',
        enabled: true,
      },
      {
        id: 'rule_config_files',
        name: '配置文件变更通知',
        pattern: '*.json',
        action: 'notify',
        enabled: true,
      },
      {
        id: 'rule_source_ts',
        name: 'TypeScript源码变更记录',
        pattern: 'src/**/*.ts',
        action: 'notify',
        enabled: true,
      },
    ];

    for (const rule of defaultRules) {
      this.fileChangeRules.set(rule.id, rule);
    }
  }
}
