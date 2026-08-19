"use strict";
/**
 * 场景感知调度器 v4 — 主动工作流版
 * 核心功能：
 * 1. 基于时间的任务调度
 * 2. 桌面环境主动感知（前台窗口、进程、状态）
 * 3. Git项目变化感知（新分支、未提交、新commit）
 * 4. 主动推送给前端/EventBus
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScenarioAwareScheduler = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
const SkillUsageTracker_1 = require("../evolution/SkillUsageTracker");
// ── 调度器主类 ──
class ScenarioAwareScheduler {
    constructor() {
        this.tasks = new Map();
        this.isRunning = false;
        this.checkInterval = null;
        this.CHECK_INTERVAL_MS = 30000;
        this.memoryEngine = null;
        this.llmCore = null;
        this.enableFeedbackCollection = true;
        // 环境感知缓存
        this.lastSnapshot = null;
        this.lastForegroundCheck = 0;
        this.FOREGROUND_CHECK_INTERVAL = 15000;
        this.lastEnv = '';
        // Git 感知
        this.WATCHED_DIRS = [
            process.cwd(), // jiabaixing 自身
            path.resolve(process.cwd(), '..', 'hermes-agent-main'), // hermes
            path.resolve(process.cwd(), '..'), // /c/zy 根目录
        ];
        this.lastGitState = new Map();
        this.gitCheckCount = 0;
        this.GIT_CHECK_INTERVAL = 10; // 每10次检查（约5分钟）做一次git感知
        this.projectChangeHistory = [];
        this.MAX_CHANGE_HISTORY = 50;
        // 文件变更监听
        this.fileWatchers = [];
        this.watchedDirectories = [];
        this.fileChangeRules = new Map();
        this.fileDebounceMap = new Map();
        this.FILE_DEBOUNCE_MS = 2000;
        this.WATCHED_EXTENSIONS = new Set([
            '.ts',
            '.js',
            '.json',
            '.md',
            '.py',
            '.tsx',
            '.jsx',
        ]);
        this.IGNORED_DIR_NAMES = new Set([
            'node_modules',
            '.git',
            'dist',
            'build',
            '.next',
            '.nuxt',
            'coverage',
            '__pycache__',
        ]);
        this.fileChangeLog = [];
        this.MAX_CHANGE_LOG = 200;
        this.lastUserActivity = Date.now();
        this.lastProactiveTrigger = 0;
        this.proactiveCheckCount = 0;
        this.PROACTIVE_COOLDOWN_MS = 10 * 60 * 1000; // 10分钟冷却
        this.initializeDefaultTasks();
        this.initializeDefaultFileChangeRules();
        this.watchedDirectories = [...this.WATCHED_DIRS];
    }
    setMemoryEngine(engine) {
        this.memoryEngine = engine;
    }
    setLLMCore(core) {
        this.llmCore = core;
    }
    /**
     * 设置是否启用反馈收集（默认开启）
     * @param enabled - 是否启用反馈收集
     */
    setFeedbackCollectionEnabled(enabled) {
        this.enableFeedbackCollection = enabled;
        Logger_1.Logger.info(`反馈收集已${enabled ? '开启' : '关闭'}`, 'ScenarioAwareScheduler');
    }
    /**
     * 获取反馈收集配置状态
     * @returns 是否启用反馈收集
     */
    isFeedbackCollectionEnabled() {
        return this.enableFeedbackCollection;
    }
    updateUserActivity() {
        this.lastUserActivity = Date.now();
    }
    getEnvironmentSnapshot() {
        return this.lastSnapshot;
    }
    /**
     * 生成主动触发器 — 基于环境状态和用户行为
     */
    getProactiveTriggers() {
        const triggers = [];
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
    getUserBehaviorPattern() {
        return {
            activeHours: [],
            frequentTopics: [],
            taskCompletionRate: 0,
            averageSessionDuration: 0,
        };
    }
    getProjectChanges() {
        return [...this.projectChangeHistory];
    }
    // ── 初始化 ──
    initializeDefaultTasks() {
        const defaultTasks = [
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
                description: '扫描 data/evolution/skills/ 目录发现新生成的 SKILL.md，广播到 EventBus',
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
    start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        Logger_1.Logger.info('🚀 调度器启动（含环境感知+Git感知+文件监听）', 'ScenarioAwareScheduler');
        void this.checkAndExecuteTasks();
        this.checkInterval = setInterval(() => {
            void this.checkAndExecuteTasks();
        }, this.CHECK_INTERVAL_MS);
        if (this.checkInterval.unref)
            this.checkInterval.unref();
        this.startFileWatching();
        EventBus_1.EventBus.emit('scheduler_started', { timestamp: new Date().toISOString() });
    }
    stop() {
        if (!this.isRunning)
            return;
        this.isRunning = false;
        if (this.checkInterval)
            clearInterval(this.checkInterval);
        this.checkInterval = null;
        this.stopFileWatching();
        Logger_1.Logger.info('⏹ 调度器已停止', 'ScenarioAwareScheduler');
        EventBus_1.EventBus.emit('scheduler_stopped', { timestamp: new Date().toISOString() });
    }
    isActive() {
        return this.isRunning;
    }
    // ── 环境感知 ──
    async senseEnvironment() {
        const now = Date.now();
        if (this.lastSnapshot &&
            now - this.lastForegroundCheck < this.FOREGROUND_CHECK_INTERVAL) {
            return this.lastSnapshot;
        }
        this.lastForegroundCheck = now;
        let foregroundWindow = null;
        let activeEnv = 'unknown';
        try {
            const scriptPath = path.resolve(__dirname, '../../scripts/get-foreground-window.ps1');
            const result = (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 5000, encoding: 'utf-8' })
                .toString()
                .trim();
            const parts = result.split('|');
            if (parts.length >= 2 && parts[0]) {
                const proc = parts[0];
                const title = parts.slice(1).join('|');
                foregroundWindow = { title, process: proc };
                const tl = title.toLowerCase();
                const pl = proc.toLowerCase();
                if (tl.includes('code') ||
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
                    tl.includes('.jsx')) {
                    activeEnv = 'coding';
                }
                else if (pl.includes('chrome') ||
                    pl.includes('edge') ||
                    pl.includes('firefox') ||
                    pl.includes('explorer') ||
                    tl.includes('http')) {
                    activeEnv = 'browsing';
                }
                else {
                    activeEnv = 'idle';
                }
            }
        }
        catch {
            // 环境检测失败不影响
        }
        const snapshot = {
            timestamp: new Date().toISOString(),
            foregroundWindow,
            activeEnv,
            recentProjects: [],
        };
        this.lastSnapshot = snapshot;
        return snapshot;
    }
    // ── Git感知 ──
    scanGitRepos() {
        const results = [];
        for (const dir of this.WATCHED_DIRS) {
            try {
                const gitDir = path.join(dir, '.git');
                if (!fs.existsSync(gitDir))
                    continue;
                const branch = (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', {
                    cwd: dir,
                    timeout: 3000,
                    encoding: 'utf-8',
                })
                    .toString()
                    .trim();
                const status = (0, child_process_1.execSync)('git status --porcelain', {
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
                    aheadBehind = (0, child_process_1.execSync)('git rev-list --count --left-right HEAD...@{upstream}', { cwd: dir, timeout: 3000, encoding: 'utf-8' })
                        .toString()
                        .trim();
                }
                catch {
                    aheadBehind = '0 0';
                }
                const [ahead, behind] = aheadBehind.split(/\s+/).map(Number);
                let lastCommitMsg = '(无commit)';
                try {
                    lastCommitMsg = (0, child_process_1.execSync)('git log -1 --format=%s', {
                        cwd: dir,
                        timeout: 3000,
                        encoding: 'utf-8',
                    })
                        .toString()
                        .trim();
                }
                catch {
                    lastCommitMsg = '(无commit)';
                }
                let lastCommitTs = 0;
                try {
                    lastCommitTs = parseInt((0, child_process_1.execSync)('git log -1 --format=%ct', {
                        cwd: dir,
                        timeout: 3000,
                        encoding: 'utf-8',
                    })
                        .toString()
                        .trim());
                }
                catch {
                    lastCommitTs = 0;
                }
                const lastCommitAgo = lastCommitTs > 0
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
                    currentCommit = (0, child_process_1.execSync)('git rev-parse HEAD', {
                        cwd: dir,
                        timeout: 3000,
                        encoding: 'utf-8',
                    })
                        .toString()
                        .trim();
                }
                catch {
                    currentCommit = '';
                }
                if (lastState) {
                    const changes = [];
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
                        Logger_1.Logger.info(`📂 项目变化: ${c.type} | ${c.repo}: ${c.detail}`, 'ScenarioAwareScheduler');
                        EventBus_1.EventBus.emit('project_change', c);
                    }
                }
                this.lastGitState.set(dir, {
                    branch,
                    commit: currentCommit,
                    hasUncommitted,
                });
            }
            catch {
                // 非git目录或git不可用，跳过
            }
        }
        return results;
    }
    // ── 任务检查与执行 ──
    async checkAndExecuteTasks() {
        const now = new Date();
        // 环境感知（每次）
        const snapshot = await this.senseEnvironment();
        const envStr = snapshot.activeEnv;
        if (envStr !== 'idle' || this.lastEnv !== envStr) {
            Logger_1.Logger.info(`👀 环境: ${envStr}${snapshot.foregroundWindow ? ' | ' + snapshot.foregroundWindow.process : ''}`, 'ScenarioAwareScheduler');
            this.lastEnv = envStr;
            EventBus_1.EventBus.emit('environment_update', {
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
                Logger_1.Logger.info(`📊 Git状态: ${repos.map((r) => `${r.repo}[${r.branch}]${r.hasUncommitted ? '*' : ''}${r.aheadCount > 0 ? '↑' + r.aheadCount : ''}${r.behindCount > 0 ? '↓' + r.behindCount : ''}`).join(', ')}`, 'ScenarioAwareScheduler');
                EventBus_1.EventBus.emit('git_status', {
                    timestamp: new Date().toISOString(),
                    repos,
                });
            }
        }
        // 定时任务
        for (const task of this.tasks.values()) {
            if (!task.enabled)
                continue;
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
                Logger_1.Logger.info(`📬 主动通知触发: ${trigger.reason} (优先级=${trigger.priority})`, 'ScenarioAwareScheduler');
                EventBus_1.EventBus.emit('proactive_interaction', {
                    reason: trigger.reason,
                    context: `环境: ${snapshot.activeEnv}, 前台: ${snapshot.foregroundWindow?.process || '未知'}`,
                    scene: snapshot.activeEnv === 'coding' ? 'development' : 'daily',
                    isEmotionBased: false,
                });
            }
        }
    }
    shouldExecuteTask(task, now) {
        if (!task.nextRun) {
            task.nextRun = new Date(now.getTime() + 60 * 1000);
            return false;
        }
        return now >= task.nextRun;
    }
    async executeTask(task) {
        const startTime = Date.now();
        Logger_1.Logger.info(`📋 执行任务: ${task.name}`, 'ScenarioAwareScheduler');
        let taskSuccess = false;
        let taskError;
        try {
            // skill_discovery 定时扫描
            if (task.id === 'skill_discovery') {
                const skillsDir = path.resolve(process.cwd(), 'data', 'evolution', 'skills');
                if (fs.existsSync(skillsDir)) {
                    const files = fs
                        .readdirSync(skillsDir)
                        .filter((f) => f.endsWith('.md'));
                    EventBus_1.EventBus.emit('skill_discovery', {
                        timestamp: new Date().toISOString(),
                        skillsDir,
                        skillCount: files.length,
                        skills: files.map((f) => ({
                            name: f.replace(/\.md$/, ''),
                            path: path.join(skillsDir, f),
                        })),
                    });
                    Logger_1.Logger.debug(`🔍 发现 ${files.length} 个进化 Skill 文件`, 'ScenarioAwareScheduler');
                }
            }
            // 自然语言任务：通过 JiabaixingCore 执行
            if (task.naturalDescription && this.llmCore) {
                Logger_1.Logger.info(`🤖 执行自然语言任务: "${task.naturalDescription}"${task.targetPlatform ? ' → ' + task.targetPlatform : ''}`, 'ScenarioAwareScheduler');
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
                SkillUsageTracker_1.skillUsageTracker.trackUse(task.id);
            }
        }
        catch (error) {
            taskSuccess = false;
            taskError = error.message;
            Logger_1.Logger.warn(`❌ 任务执行失败: ${task.name}`, 'ScenarioAwareScheduler');
        }
        // 发射任务完成事件
        if (this.enableFeedbackCollection) {
            EventBus_1.EventBus.emit('scheduled_task_completed', {
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
    parseNaturalLanguageSchedule(input) {
        const text = input.trim();
        if (!text) {
            throw new Error('自然语言描述不能为空');
        }
        let cronExpression = '';
        let remaining = text;
        // ── 提取目标平台 ──
        let platform;
        const platformPatterns = [
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
                }
                else if (afternoonMatch) {
                    const hour = parseInt(afternoonMatch[2], 10) + 12;
                    cronExpression = `0 ${hour} * * *`;
                    remaining = remaining.replace(afternoonMatch[0], '');
                }
                else {
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
                }
                else if (afternoonMatch) {
                    const hour = parseInt(afternoonMatch[2], 10) + 12;
                    cronExpression = `0 ${hour} * * 1-5`;
                    remaining = remaining.replace(afternoonMatch[0], '');
                }
                else {
                    // "工作日" 无具体时间 → 默认 9 点
                    cronExpression = '0 9 * * 1-5';
                }
                remaining = remaining.replace(weekdayMatch[0], '');
            }
        }
        // 5. 每周X / 周X
        if (!cronExpression) {
            const weekDayMap = {
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
                }
                else if (afternoonMatch) {
                    const hour = parseInt(afternoonMatch[2], 10) + 12;
                    cronExpression = `0 ${hour} * * ${dayOfWeek}`;
                    remaining = remaining.replace(afternoonMatch[0], '');
                }
                else {
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
            }
            else if (afternoonMatch) {
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
    addTaskFromNaturalLanguage(input, taskId) {
        const parsed = this.parseNaturalLanguageSchedule(input);
        const id = taskId || `nl_${Date.now()}`;
        const task = {
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
        Logger_1.Logger.info(`📝 自然语言创建定时任务: id=${id}, cron="${parsed.cronExpression}", 描述="${parsed.taskDescription}"${parsed.platform ? ', 平台=' + parsed.platform : ''}`, 'ScenarioAwareScheduler');
        EventBus_1.EventBus.emit('task_created_from_natural_language', {
            taskId: id,
            cronExpression: parsed.cronExpression,
            taskDescription: parsed.taskDescription,
            platform: parsed.platform,
            timestamp: new Date().toISOString(),
        });
        return task;
    }
    // ── 公开 API ──
    getTasks() {
        return Array.from(this.tasks.values());
    }
    getTask(taskId) {
        return this.tasks.get(taskId);
    }
    updateTask(taskId, updates) {
        const task = this.tasks.get(taskId);
        if (task)
            Object.assign(task, updates);
    }
    addTask(task) {
        this.tasks.set(task.id, task);
        return task.id;
    }
    toggleTask(taskId, enabled) {
        const task = this.tasks.get(taskId);
        if (task)
            task.enabled = enabled ?? !task.enabled;
    }
    async executeTaskById(taskId) {
        const task = this.tasks.get(taskId);
        if (!task)
            throw new Error(`任务不存在: ${taskId}`);
        await this.executeTask(task);
    }
    // ── 文件变更监听 ──
    /**
     * 启动文件变更监听，对 watchedDirectories 中的目录递归监听文件变更
     * 使用 fs.watch() API，带防抖和文件过滤机制
     */
    startFileWatching() {
        if (this.fileWatchers.length > 0) {
            Logger_1.Logger.warn('文件监听已在运行中', 'ScenarioAwareScheduler');
            return;
        }
        // WSL 下跳过文件监听（fs.watch 在 /mnt/ 挂载点上会阻塞）
        if (process.platform === 'linux') {
            Logger_1.Logger.info('WSL环境检测，跳过文件监听（/mnt/ 挂载点不兼容 fs.watch）', 'ScenarioAwareScheduler');
            return;
        }
        for (const dir of this.watchedDirectories) {
            this.watchDirectory(dir);
        }
        Logger_1.Logger.info(`📁 文件监听已启动，监听 ${this.watchedDirectories.length} 个目录`, 'ScenarioAwareScheduler');
        EventBus_1.EventBus.emit('file_watch_started', {
            directories: this.watchedDirectories,
            timestamp: new Date().toISOString(),
        });
    }
    /**
     * 停止文件变更监听，关闭所有 fs.FSWatcher 并清理防抖定时器
     */
    stopFileWatching() {
        for (const watcher of this.fileWatchers) {
            try {
                watcher.close();
            }
            catch {
                // Windows 上关闭 watcher 可能抛出异常，安全忽略
            }
        }
        this.fileWatchers = [];
        // 清理所有防抖定时器
        for (const [, entry] of this.fileDebounceMap) {
            clearTimeout(entry.timer);
        }
        this.fileDebounceMap.clear();
        Logger_1.Logger.info('📁 文件监听已停止', 'ScenarioAwareScheduler');
        EventBus_1.EventBus.emit('file_watch_stopped', {
            timestamp: new Date().toISOString(),
        });
    }
    /**
     * 动态添加监听目录
     * @param dirPath - 要监听的目录绝对路径
     * @throws {Error} 当目录不存在时抛出错误
     */
    addWatchDirectory(dirPath) {
        const resolved = path.resolve(dirPath);
        if (this.watchedDirectories.includes(resolved)) {
            Logger_1.Logger.warn(`目录已在监听列表中: ${resolved}`, 'ScenarioAwareScheduler');
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
        Logger_1.Logger.info(`📁 添加监听目录: ${resolved}`, 'ScenarioAwareScheduler');
    }
    /**
     * 添加文件变更规则
     * @param rule - 文件变更规则对象
     */
    addFileChangeRule(rule) {
        this.fileChangeRules.set(rule.id, rule);
        Logger_1.Logger.info(`📜 添加文件变更规则: ${rule.name} (pattern=${rule.pattern}, action=${rule.action})`, 'ScenarioAwareScheduler');
    }
    /**
     * 移除文件变更规则
     * @param ruleId - 规则ID
     * @returns 是否成功移除
     */
    removeFileChangeRule(ruleId) {
        const removed = this.fileChangeRules.delete(ruleId);
        if (removed) {
            Logger_1.Logger.info(`📜 移除文件变更规则: ${ruleId}`, 'ScenarioAwareScheduler');
        }
        return removed;
    }
    /**
     * 获取所有文件变更规则
     * @returns 文件变更规则数组
     */
    getFileChangeRules() {
        return Array.from(this.fileChangeRules.values());
    }
    /**
     * 获取文件变更日志
     * @returns 最近的文件变更记录
     */
    getFileChangeLog() {
        return [...this.fileChangeLog];
    }
    /**
     * 处理文件变更事件：匹配规则并执行自动响应
     * @param filePath - 变更文件的绝对路径
     * @param changeType - 变更类型
     */
    async handleFileChange(filePath, changeType) {
        const timestamp = new Date().toISOString();
        // 记录到变更日志
        this.fileChangeLog.push({ filePath, changeType, timestamp });
        if (this.fileChangeLog.length > this.MAX_CHANGE_LOG) {
            this.fileChangeLog.shift();
        }
        // 匹配规则
        const matchedRules = this.matchRules(filePath);
        // 广播 file_changed 事件
        const payload = {
            filePath,
            changeType,
            timestamp,
            matchedRules: matchedRules.map((r) => ({
                id: r.id,
                name: r.name,
                action: r.action,
            })),
        };
        EventBus_1.EventBus.emit('file_changed', payload);
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
    watchDirectory(dirPath) {
        try {
            if (!fs.existsSync(dirPath))
                return;
            // 检查是否为忽略的目录
            const dirName = path.basename(dirPath);
            if (this.IGNORED_DIR_NAMES.has(dirName))
                return;
            // 监听当前目录
            try {
                const watcher = fs.watch(dirPath, { recursive: false }, (eventType, filename) => {
                    if (!filename)
                        return;
                    this.onFileEvent(dirPath, eventType, filename);
                });
                this.fileWatchers.push(watcher);
            }
            catch {
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
            }
            catch {
                // 读取目录失败，跳过
            }
        }
        catch {
            Logger_1.Logger.warn(`监听目录失败: ${dirPath}`, 'ScenarioAwareScheduler');
        }
    }
    /**
     * 处理 fs.watch 回调事件，带防抖和文件过滤
     * @param dirPath - 事件所在目录
     * @param eventType - fs.watch 事件类型 (rename / change)
     * @param filename - 变更的文件名
     */
    onFileEvent(dirPath, eventType, filename) {
        const ext = path.extname(filename).toLowerCase();
        if (!this.WATCHED_EXTENSIONS.has(ext))
            return;
        const filePath = path.join(dirPath, filename);
        // 确定变更类型
        let changeType;
        if (eventType === 'rename') {
            // rename 事件可能是创建或删除，通过检查文件是否存在来判断
            try {
                fs.accessSync(filePath, fs.constants.F_OK);
                changeType = 'created';
            }
            catch {
                changeType = 'deleted';
            }
        }
        else {
            changeType = 'modified';
        }
        // 防抖：同一文件在 FILE_DEBOUNCE_MS 内的多次变更只触发一次
        const existing = this.fileDebounceMap.get(filePath);
        if (existing) {
            clearTimeout(existing.timer);
        }
        const timer = setTimeout(() => {
            this.fileDebounceMap.delete(filePath);
            void this.handleFileChange(filePath, changeType);
        }, this.FILE_DEBOUNCE_MS);
        this.fileDebounceMap.set(filePath, { timer, changeType });
    }
    /**
     * 匹配文件路径与规则
     * @param filePath - 文件绝对路径
     * @returns 匹配到的启用规则列表
     */
    matchRules(filePath) {
        const matched = [];
        const fileName = path.basename(filePath);
        for (const rule of this.fileChangeRules.values()) {
            if (!rule.enabled)
                continue;
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
    matchGlob(filePath, fileName, pattern) {
        // 精确文件名匹配
        if (pattern === fileName)
            return true;
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
            }
            catch {
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
    async executeRuleAction(rule, filePath, changeType, timestamp) {
        Logger_1.Logger.info(`⚡ 规则触发: ${rule.name} → ${rule.action} (${path.basename(filePath)} ${changeType})`, 'ScenarioAwareScheduler');
        EventBus_1.EventBus.emit('file_change_rule_triggered', {
            ruleId: rule.id,
            ruleName: rule.name,
            action: rule.action,
            filePath,
            timestamp,
        });
        switch (rule.action) {
            case 'notify':
                // notify 动作仅通过事件广播，前端自行处理
                Logger_1.Logger.info(`📢 通知: 文件 ${path.basename(filePath)} 已${changeType}（规则: ${rule.name}）`, 'ScenarioAwareScheduler');
                break;
            case 'auto_fix':
                if (this.llmCore) {
                    try {
                        Logger_1.Logger.info(`🔧 自动修复: ${path.basename(filePath)}`, 'ScenarioAwareScheduler');
                        await this.llmCore.processInput(`文件 ${filePath} 发生了 ${changeType} 变更，请检查并自动修复可能的问题。`);
                    }
                    catch (error) {
                        Logger_1.Logger.error(`自动修复失败: ${path.basename(filePath)}`, error, 'ScenarioAwareScheduler');
                    }
                }
                break;
            case 'run_tests':
                if (this.llmCore) {
                    try {
                        Logger_1.Logger.info(`🧪 运行测试: ${path.basename(filePath)}`, 'ScenarioAwareScheduler');
                        await this.llmCore.processInput(`文件 ${filePath} 发生了 ${changeType} 变更，请运行相关测试验证功能正常。`);
                    }
                    catch (error) {
                        Logger_1.Logger.error(`运行测试失败: ${path.basename(filePath)}`, error, 'ScenarioAwareScheduler');
                    }
                }
                break;
            case 'custom':
                if (this.llmCore && rule.customPrompt) {
                    try {
                        Logger_1.Logger.info(`🎯 自定义动作: ${path.basename(filePath)}`, 'ScenarioAwareScheduler');
                        const prompt = rule.customPrompt
                            .replace('{filePath}', filePath)
                            .replace('{changeType}', changeType)
                            .replace('{fileName}', path.basename(filePath));
                        await this.llmCore.processInput(prompt);
                    }
                    catch (error) {
                        Logger_1.Logger.error(`自定义动作执行失败: ${path.basename(filePath)}`, error, 'ScenarioAwareScheduler');
                    }
                }
                break;
        }
    }
    /**
     * 初始化默认文件变更规则
     */
    initializeDefaultFileChangeRules() {
        const defaultRules = [
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
exports.ScenarioAwareScheduler = ScenarioAwareScheduler;
