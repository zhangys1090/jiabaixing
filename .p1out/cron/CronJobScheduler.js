"use strict";
/**
 * Cron Job Scheduler - 定时任务调度器
 *
 * 参考 Hermes cron/scheduler.py 的设计：
 *   - 基于文件的锁防止并发执行
 *   - 注入扫描保护自动执行的任务
 *   - 任务失败时的干净交付机制
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CronJobScheduler = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const EventBus_1 = __importDefault(require("../shared/EventBus"));
const Logger_1 = require("../utils/Logger");
// Windows 兼容的文件锁
const LOCK_DIR = path.join(process.cwd(), '.jiabaixing', 'cron');
const LOCK_FILE = path.join(LOCK_DIR, '.tick.lock');
/** 注入扫描 - 防止恶意内容通过 cron 任务注入 */
class CronPromptInjectionScanner {
    static scan(prompt) {
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
    static validateWhitelist(command) {
        const trimmed = command.trim();
        const isAllowed = CronPromptInjectionScanner.ALLOWED_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
        if (!isAllowed) {
            return {
                allowed: false,
                reason: `命令不在白名单中: "${trimmed.split(' ')[0]}"`,
            };
        }
        return { allowed: true };
    }
}
CronPromptInjectionScanner.DANGEROUS_PATTERNS = [
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
CronPromptInjectionScanner.ALLOWED_COMMAND_PREFIXES = [
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
/** 简易 cron 解析器 */
class SimpleCronParser {
    /** 解析简化格式 "every:5m" / "every:1h" / "every:1d" */
    static parseEvery(expr) {
        const match = expr.match(/^every:(\d+)(s|m|h|d)$/);
        if (!match)
            return null;
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
    static parseStandard(expr) {
        // 只支持 */N * * * * 格式
        const match = expr.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
        if (!match)
            return null;
        return parseInt(match[1], 10) * 60 * 1000;
    }
    /** 获取下次执行间隔（毫秒） */
    static getNextInterval(schedule) {
        return this.parseEvery(schedule) ?? this.parseStandard(schedule);
    }
}
/** 文件锁管理器 */
class FileLock {
    constructor() {
        this.fd = null;
    }
    acquire() {
        try {
            fs.mkdirSync(LOCK_DIR, { recursive: true });
            this.fd = fs.openSync(LOCK_FILE, 'wx');
            return true;
        }
        catch {
            // 文件已被锁定或不存在 wx 模式
            try {
                this.fd = fs.openSync(LOCK_FILE, 'w+');
                return false;
            }
            catch {
                return false;
            }
        }
    }
    release() {
        if (this.fd !== null) {
            try {
                fs.closeSync(this.fd);
            }
            catch {
                /* ignore */
            }
            this.fd = null;
        }
    }
    dispose() {
        this.release();
        try {
            fs.unlinkSync(LOCK_FILE);
        }
        catch {
            /* ignore */
        }
    }
}
/** 任务持久化 */
class JobPersistence {
    constructor(baseDir = path.join(process.cwd(), '.jiabaixing', 'cron')) {
        this.jobsFile = path.join(baseDir, 'jobs.json');
    }
    save(jobs) {
        try {
            fs.mkdirSync(path.dirname(this.jobsFile), { recursive: true });
            fs.writeFileSync(this.jobsFile, JSON.stringify(jobs, null, 2), 'utf-8');
        }
        catch (err) {
            Logger_1.Logger.error(`[CronJobScheduler] Failed to save jobs: ${err.message}`);
        }
    }
    load() {
        try {
            if (!fs.existsSync(this.jobsFile))
                return [];
            const data = fs.readFileSync(this.jobsFile, 'utf-8');
            return JSON.parse(data);
        }
        catch {
            return [];
        }
    }
}
class CronJobScheduler {
    constructor() {
        this.jobs = [];
        this.timer = null;
        this.fileLock = new FileLock();
        this.running = false;
        this.tickInterval = 60000; // 默认每 60 秒 tick 一次
        this.persistence = new JobPersistence();
        this.loadJobs();
    }
    static getInstance() {
        if (!CronJobScheduler.instance) {
            CronJobScheduler.instance = new CronJobScheduler();
        }
        return CronJobScheduler.instance;
    }
    static resetInstance(clearPersistence = false) {
        if (CronJobScheduler.instance) {
            CronJobScheduler.instance.stop();
            if (clearPersistence) {
                try {
                    const fs = require('fs');
                    const jobsFile = path.join(process.cwd(), '.jiabaixing', 'cron', 'jobs.json');
                    if (fs.existsSync(jobsFile)) {
                        fs.unlinkSync(jobsFile);
                    }
                }
                catch {
                    /* best-effort */
                }
            }
            CronJobScheduler.instance.fileLock.dispose();
            CronJobScheduler.instance = null;
        }
    }
    /** 注册新任务 */
    register(job) {
        const injectionScan = CronPromptInjectionScanner.scan(job.command);
        if (injectionScan.blocked) {
            Logger_1.Logger.error(`[CronJobScheduler] 任务注册被拒绝 (注入检测): ${injectionScan.reason}`, undefined, 'CronJobScheduler');
            throw new Error(`Cron任务注入检测失败: ${injectionScan.reason}`);
        }
        const whitelistCheck = CronPromptInjectionScanner.validateWhitelist(job.command);
        if (!whitelistCheck.allowed) {
            Logger_1.Logger.warn(`[CronJobScheduler] 任务注册警告 (白名单): ${whitelistCheck.reason}`, 'CronJobScheduler');
            Logger_1.Logger.warn(`[CronJobScheduler] 任务 "${job.name}" 的命令不在白名单中，但仍允许注册。建议将命令前缀添加到 ALLOWED_COMMAND_PREFIXES`, 'CronJobScheduler');
        }
        const fullJob = {
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
        Logger_1.Logger.info(`[CronJobScheduler] Registered job: ${fullJob.name} (${fullJob.schedule})`);
    }
    /** 移除任务 */
    unregister(jobId) {
        this.jobs = this.jobs.filter((j) => j.id !== jobId);
        this.persistence.save(this.jobs);
        Logger_1.Logger.info(`[CronJobScheduler] Unregistered job: ${jobId}`);
    }
    /** 启动调度器 */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.timer = setInterval(() => this.tick(), this.tickInterval);
        if (this.timer.unref)
            this.timer.unref();
        Logger_1.Logger.info('[CronJobScheduler] Started');
        EventBus_1.default.emit('scheduler_started', { timestamp: new Date().toISOString() });
    }
    /** 停止调度器 */
    stop() {
        if (!this.running)
            return;
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        Logger_1.Logger.info('[CronJobScheduler] Stopped');
    }
    /** 获取所有任务 */
    getJobs() {
        return [...this.jobs];
    }
    /** 获取单个任务 */
    getJob(id) {
        return this.jobs.find((j) => j.id === id);
    }
    // ---- 内部方法 ----
    tick() {
        if (!this.fileLock.acquire()) {
            Logger_1.Logger.debug('[CronJobScheduler] Lock held by another process, skipping tick');
            return;
        }
        try {
            const now = new Date();
            let changed = false;
            for (const job of this.jobs) {
                if (!job.enabled)
                    continue;
                if (job.status === 'running')
                    continue;
                if (!job.nextRun || job.nextRun > now)
                    continue;
                // 执行任务
                changed = true;
                this.runJob(job)
                    .then((result) => {
                    job.lastRun = result.startTime;
                    job.nextRun = result.success
                        ? new Date(Date.now() +
                            (SimpleCronParser.getNextInterval(job.schedule) ?? 3600000))
                        : new Date(now.getTime() + 300000); // 失败后 5 分钟重试
                    job.status = result.success ? 'idle' : 'failed';
                    this.persistence.save(this.jobs);
                    if (result.success) {
                        Logger_1.Logger.info(`[CronJobScheduler] Job "${job.name}" completed successfully`);
                    }
                    else {
                        Logger_1.Logger.error(`任务 "${job.name}" 执行失败: ${result.stderr || result.stdout}`, undefined, 'CronJobScheduler');
                    }
                    EventBus_1.default.emit(result.success ? 'job_completed' : 'job_failed', {
                        jobId: job.id,
                        success: result.success,
                        duration: result.endTime.getTime() - result.startTime.getTime(),
                        error: result.success
                            ? ''
                            : result.stderr || result.stdout || '未知错误',
                        timestamp: new Date().toISOString(),
                    });
                })
                    .catch((err) => {
                    Logger_1.Logger.error(`任务 "${job.name}" 执行异常: ${err.message}`, undefined, 'CronJobScheduler');
                });
            }
            if (changed) {
                this.persistence.save(this.jobs);
            }
        }
        finally {
            this.fileLock.release();
        }
    }
    async runJob(job) {
        job.status = 'running';
        this.persistence.save(this.jobs);
        const startTime = new Date();
        // 注入扫描
        const scanResult = CronPromptInjectionScanner.scan(job.command);
        if (scanResult.blocked) {
            Logger_1.Logger.warn(`[CronJobScheduler] Job "${job.name}" blocked by injection scanner: ${scanResult.reason}`);
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
            const { exec } = await Promise.resolve().then(() => __importStar(require('child_process')));
            const timeout = job.timeout ?? 60000;
            return new Promise((resolve) => {
                let stdout = '';
                let stderr = '';
                const child = exec(`${job.command} ${(job.args || []).join(' ')}`, { timeout, cwd: process.cwd() }, (error, stdOut, stdErr) => {
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
                });
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
        }
        catch (err) {
            return {
                jobId: job.id,
                jobName: job.name,
                startTime,
                endTime: new Date(),
                exitCode: 1,
                stdout: '',
                stderr: err.message,
                success: false,
            };
        }
    }
    loadJobs() {
        this.jobs = this.persistence.load();
        Logger_1.Logger.info(`[CronJobScheduler] Loaded ${this.jobs.length} jobs`);
    }
}
exports.CronJobScheduler = CronJobScheduler;
CronJobScheduler.instance = null;
