/**
 * Cron Job Scheduler - 定时任务调度器
 *
 * 参考 Hermes cron/scheduler.py 的设计：
 *   - 基于文件的锁防止并发执行
 *   - 注入扫描保护自动执行的任务
 *   - 任务失败时的干净交付机制
 */

import * as fs from 'fs';
import * as path from 'path';
import EventBus from '../shared/EventBus';
import { Logger } from '../utils/Logger';

// Windows 兼容的文件锁
const LOCK_DIR = path.join(process.cwd(), '.jiabaixing', 'cron');
const LOCK_FILE = path.join(LOCK_DIR, '.tick.lock');

export interface CronJob {
  /** 唯一标识 */
  id: string;
  /** 任务名称 */
  name: string;
  /** Cron expression schedule (e.g. every:5m, every:1h, 5-min intervals) */
  schedule: string;
  /** 要执行的命令或函数 */
  command: string;
  /** 任务参数 */
  args?: string[];
  /** 超时时间（毫秒），默认 60s */
  timeout?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 是否启用 */
  enabled?: boolean;
  /** 最后执行时间 */
  lastRun?: Date;
  /** 下次执行时间 */
  nextRun?: Date;
  /** 执行状态 */
  status: 'idle' | 'running' | 'failed' | 'blocked';
}

export interface CronJobResult {
  jobId: string;
  jobName: string;
  startTime: Date;
  endTime: Date;
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

/** 注入扫描 - 防止恶意内容通过 cron 任务注入 */
class CronPromptInjectionScanner {
  private static readonly DANGEROUS_PATTERNS = [
    /(?:rm\s+-rf|format\s+C:)/i,
    /(?:eval\(|exec\(|Function\()/i,
    /(?:process\.exit|process\.kill)/i,
    /(?:delete\s+from\s+(?:users?|accounts?|sessions?))/i,
    /(?:DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE)/i,
    /(?:fetch\s*\(\s*["'\x27]\s*http)/i,
    /(?:postMessage\s*\()/i,
    /(?:document\.cookie|localStorage\.clear)/i,
    /(?:__proto__|constructor\.prototype)/i,
    /(?:curl\s|wget\s)/i,
    /(?:nc\s+-|ncat\s|netcat\s)/i,
    /(?:bash\s+-c|sh\s+-c|powershell\s+-enc)/i,
    /(?:chmod\s+[0-7]{3,4}|chown\s)/i,
    /(?:\/etc\/passwd|\/etc\/shadow|\/\.ssh\/)/i,
    /(?:base64\s+--decode|xxd\s+-r)/i,
  ];

  private static readonly ALLOWED_COMMAND_PREFIXES: string[] = [
    'node ',
    'npx ',
    'npm ',
    'python ',
    'python3 ',
    'pip ',
    'echo ',
    'git ',
    'ls ',
    'cat ',
    'mkdir ',
    'cp ',
    'mv ',
    'jq ',
    'sqlite3 ',
    'jiabaixing-',
  ];

  static scan(prompt: string): { blocked: boolean; reason?: string } {
    for (const pattern of this.DANGEROUS_PATTERNS) {
      if (pattern.test(prompt)) {
        return {
          blocked: true,
          reason: `Injection pattern detected: ${pattern.source}`,
        };
      }
    }
    return { blocked: false };
  }

  static validateWhitelist(command: string): {
    allowed: boolean;
    reason?: string;
  } {
    const trimmed = command.trim();

    const isAllowed = CronPromptInjectionScanner.ALLOWED_COMMAND_PREFIXES.some(
      (prefix) => trimmed.startsWith(prefix)
    );

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `命令不在白名单中: "${trimmed.split(' ')[0]}"`,
      };
    }

    return { allowed: true };
  }
}

/** 简易 cron 解析器 */
class SimpleCronParser {
  /** 解析简化格式 "every:5m" / "every:1h" / "every:1d" */
  static parseEvery(expr: string): number | null {
    const match = expr.match(/^every:(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const [, amount, unit] = match;
    const ms = parseInt(amount, 10);
    switch (unit) {
      case 's':
        return ms * 1000;
      case 'm':
        return ms * 60 * 1000;
      case 'h':
        return ms * 60 * 60 * 1000;
      case 'd':
        return ms * 24 * 60 * 60 * 1000;
    }
    return null;
  }

  /** 解析标准 cron 表达式（简化版，仅支持分钟级精度） */
  static parseStandard(expr: string): number | null {
    // 只支持 */N * * * * 格式
    const match = expr.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (!match) return null;
    return parseInt(match[1], 10) * 60 * 1000;
  }

  /** 获取下次执行间隔（毫秒） */
  static getNextInterval(schedule: string): number | null {
    return this.parseEvery(schedule) ?? this.parseStandard(schedule);
  }
}

/** 文件锁管理器 */
class FileLock {
  private fd: number | null = null;

  acquire(): boolean {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      this.fd = fs.openSync(LOCK_FILE, 'wx');
      return true;
    } catch {
      // 文件已被锁定或不存在 wx 模式
      try {
        this.fd = fs.openSync(LOCK_FILE, 'w+');
        return false;
      } catch {
        return false;
      }
    }
  }

  release(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }

  dispose(): void {
    this.release();
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
}

/** 任务持久化 */
class JobPersistence {
  private jobsFile: string;

  constructor(
    baseDir: string = path.join(process.cwd(), '.jiabaixing', 'cron')
  ) {
    this.jobsFile = path.join(baseDir, 'jobs.json');
  }

  save(jobs: CronJob[]): void {
    try {
      fs.mkdirSync(path.dirname(this.jobsFile), { recursive: true });
      fs.writeFileSync(this.jobsFile, JSON.stringify(jobs, null, 2), 'utf-8');
    } catch (err) {
      Logger.error(
        `[CronJobScheduler] Failed to save jobs: ${(err as Error).message}`
      );
    }
  }

  load(): CronJob[] {
    try {
      if (!fs.existsSync(this.jobsFile)) return [];
      const data = fs.readFileSync(this.jobsFile, 'utf-8');
      return JSON.parse(data) as CronJob[];
    } catch {
      return [];
    }
  }
}

export class CronJobScheduler {
  private static instance: CronJobScheduler | null = null;
  private jobs: CronJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private fileLock: FileLock = new FileLock();
  private persistence: JobPersistence;
  private running = false;
  private tickInterval = 60_000; // 默认每 60 秒 tick 一次

  private constructor() {
    this.persistence = new JobPersistence();
    this.loadJobs();
  }

  public static create(): CronJobScheduler {
    return new CronJobScheduler();
  }

  public static getInstance(): CronJobScheduler {
    if (!CronJobScheduler.instance) {
      CronJobScheduler.instance = new CronJobScheduler();
    }
    return CronJobScheduler.instance;
  }

  public static resetInstance(clearPersistence = false): void {
    if (CronJobScheduler.instance) {
      CronJobScheduler.instance.stop();
      if (clearPersistence) {
        try {
          const fs = require('fs');
          const jobsFile = path.join(
            process.cwd(),
            '.jiabaixing',
            'cron',
            'jobs.json'
          );
          if (fs.existsSync(jobsFile)) {
            fs.unlinkSync(jobsFile);
          }
        } catch {
          /* best-effort */
        }
      }
      CronJobScheduler.instance.fileLock.dispose();
      CronJobScheduler.instance = null;
    }
  }

  /** 注册新任务 */
  public register(job: Omit<CronJob, 'status'>): void {
    const injectionScan = CronPromptInjectionScanner.scan(job.command);
    if (injectionScan.blocked) {
      Logger.error(
        `[CronJobScheduler] 任务注册被拒绝 (注入检测): ${injectionScan.reason}`,
        undefined,
        'CronJobScheduler'
      );
      throw new Error(`Cron任务注入检测失败: ${injectionScan.reason}`);
    }

    const whitelistCheck = CronPromptInjectionScanner.validateWhitelist(
      job.command
    );
    if (!whitelistCheck.allowed) {
      Logger.warn(
        `[CronJobScheduler] 任务注册警告 (白名单): ${whitelistCheck.reason}`,
        'CronJobScheduler'
      );
      Logger.warn(
        `[CronJobScheduler] 任务 "${job.name}" 的命令不在白名单中，但仍允许注册。建议将命令前缀添加到 ALLOWED_COMMAND_PREFIXES`,
        'CronJobScheduler'
      );
    }

    const fullJob: CronJob = {
      ...job,
      status: 'idle',
    };
    // 计算下次执行时间
    const interval = SimpleCronParser.getNextInterval(fullJob.schedule);
    if (interval) {
      fullJob.nextRun = new Date(Date.now() + interval);
    }
    this.jobs.push(fullJob);
    this.persistence.save(this.jobs);
    Logger.info(
      `[CronJobScheduler] Registered job: ${fullJob.name} (${fullJob.schedule})`
    );
  }

  /** 移除任务 */
  public unregister(jobId: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== jobId);
    this.persistence.save(this.jobs);
    Logger.info(`[CronJobScheduler] Unregistered job: ${jobId}`);
  }

  /** 启动调度器 */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.tickInterval);
    Logger.info('[CronJobScheduler] Started');
    EventBus.emit('scheduler_started', { timestamp: new Date().toISOString() });
  }

  /** 停止调度器 */
  public stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    Logger.info('[CronJobScheduler] Stopped');
  }

  /** 获取所有任务 */
  public getJobs(): CronJob[] {
    return [...this.jobs];
  }

  /** 获取单个任务 */
  public getJob(id: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  // ---- 内部方法 ----

  private tick(): void {
    if (!this.fileLock.acquire()) {
      Logger.debug(
        '[CronJobScheduler] Lock held by another process, skipping tick'
      );
      return;
    }

    try {
      const now = new Date();
      let changed = false;

      for (const job of this.jobs) {
        if (!job.enabled) continue;
        if (job.status === 'running') continue;
        if (!job.nextRun || job.nextRun > now) continue;

        // 执行任务
        changed = true;
        this.runJob(job)
          .then((result) => {
            job.lastRun = result.startTime;
            job.nextRun = result.success
              ? new Date(
                  Date.now() +
                    (SimpleCronParser.getNextInterval(job.schedule) ?? 3600000)
                )
              : new Date(now.getTime() + 300_000); // 失败后 5 分钟重试
            job.status = result.success ? 'idle' : 'failed';
            this.persistence.save(this.jobs);

            if (result.success) {
              Logger.info(
                `[CronJobScheduler] Job "${job.name}" completed successfully`
              );
            } else {
              Logger.error(
                `任务 "${job.name}" 执行失败: ${result.stderr || result.stdout}`,
                undefined,
                'CronJobScheduler'
              );
            }

            EventBus.emit(result.success ? 'job_completed' : 'job_failed', {
              jobId: job.id,
              success: result.success,
              duration: result.endTime.getTime() - result.startTime.getTime(),
              error: result.success
                ? ''
                : result.stderr || result.stdout || '未知错误',
              timestamp: new Date().toISOString(),
            });
          })
          .catch((err: unknown) => {
            Logger.error(
              `任务 "${job.name}" 执行异常: ${(err as Error).message}`,
              undefined,
              'CronJobScheduler'
            );
          });
      }

      if (changed) {
        this.persistence.save(this.jobs);
      }
    } finally {
      this.fileLock.release();
    }
  }

  private async runJob(job: CronJob): Promise<CronJobResult> {
    job.status = 'running';
    this.persistence.save(this.jobs);

    const startTime = new Date();

    // 注入扫描
    const scanResult = CronPromptInjectionScanner.scan(job.command);
    if (scanResult.blocked) {
      Logger.warn(
        `[CronJobScheduler] Job "${job.name}" blocked by injection scanner: ${scanResult.reason}`
      );
      return {
        jobId: job.id,
        jobName: job.name,
        startTime,
        endTime: new Date(),
        exitCode: -1,
        stdout: '',
        stderr: `Injection blocked: ${scanResult.reason}`,
        success: false,
      };
    }

    try {
      const { exec } = await import('child_process');
      const timeout = job.timeout ?? 60_000;

      return new Promise<CronJobResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        const args = (job.args || []).map((a) => {
          const safe = String(a).replace(/[^a-zA-Z0-9_\-./:@]/g, '_');
          return safe;
        });
        const safeCommand = `${job.command} ${args.join(' ')}`;
        const child = exec(
          safeCommand,
          { timeout, cwd: process.cwd() },
          (error, stdOut, stdErr) => {
            stdout = stdOut?.toString() ?? '';
            stderr = stdErr?.toString() ?? '';
            resolve({
              jobId: job.id,
              jobName: job.name,
              startTime,
              endTime: new Date(),
              exitCode: error ? Number(error.code) || 1 : 0,
              stdout,
              stderr,
              success: !error,
            });
          }
        );

        child.on('error', () => {
          resolve({
            jobId: job.id,
            jobName: job.name,
            startTime,
            endTime: new Date(),
            exitCode: 1,
            stdout: '',
            stderr: 'Process execution error',
            success: false,
          });
        });
      });
    } catch (err) {
      return {
        jobId: job.id,
        jobName: job.name,
        startTime,
        endTime: new Date(),
        exitCode: 1,
        stdout: '',
        stderr: (err as Error).message,
        success: false,
      };
    }
  }

  private loadJobs(): void {
    this.jobs = this.persistence.load();
    Logger.info(`[CronJobScheduler] Loaded ${this.jobs.length} jobs`);
  }
}
