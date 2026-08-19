"use strict";
/**
 * Hermes风格持久化记忆服务
 * 采用 MEMORY.md / USER.md 双文件模式，分别存储Agent笔记和用户画像
 * 支持添加、替换、删除操作，具备安全扫描和容量管理能力
 *
 * 设计参考: Hermes Agent 的 persistent memory 机制
 * 存储格式: 条目间以 § (章节号) 分隔的 Markdown 文件
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
exports.PersistentMemoryService = void 0;
const path = __importStar(require("path"));
const FileSystem_1 = require("../io/FileSystem");
const Logger_1 = require("../utils/Logger");
class PersistentMemoryService {
    /**
     * 获取 PersistentMemoryService 单例
     * @param storageDir - 存储目录路径，默认为 data/memories
     * @returns 单例实例
     */
    static getInstance(storageDir) {
        if (!PersistentMemoryService.instance) {
            PersistentMemoryService.instance = new PersistentMemoryService(storageDir);
        }
        return PersistentMemoryService.instance;
    }
    /**
     * 重置单例（用于测试或重新初始化）
     */
    static resetInstance() {
        if (PersistentMemoryService.instance) {
            PersistentMemoryService.instance = null;
        }
    }
    constructor(storageDir) {
        this.memoryEntries = [];
        this.userEntries = [];
        this.MEMORY_CHAR_LIMIT = 2200;
        this.USER_CHAR_LIMIT = 1375;
        this.ENTRY_SEPARATOR = '§';
        this.CAPACITY_WARNING_THRESHOLD = 0.8;
        this.initialized = false;
        /** 提示注入检测正则 */
        this.PROMPT_INJECTION_PATTERN = /(?:ignore|forget|override|disregard|skip)\s+(?:previous|all|above|prior|earlier)\s+(?:instructions?|rules?|prompts?|directives?|constraints?)/i;
        /** 凭证泄露检测正则 */
        this.CREDENTIAL_PATTERN = /(?:api[_\s-]?key|password|passwd|secret[_\s-]?key|access[_\s-]?token|private[_\s-]?key|ssh[_\s-]?key|auth[_\s-]?token|bearer)\s*[:=]\s*[\w\-+/=.]{8,}|-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----|sk-[a-zA-Z0-9]{12,}/i;
        /** 不可见Unicode字符范围: 零宽字符、控制字符等 */
        this.INVISIBLE_UNICODE_PATTERN = /[\u200B-\u200F\u2028-\u202F\uFEFF]/;
        this.storageDir =
            storageDir || path.join(process.cwd(), 'data', 'memories');
        this.fileSystem = FileSystem_1.FileSystem.getInstance();
    }
    /**
     * 初始化服务，从文件加载已有记忆条目
     * @throws {Error} 当文件读取失败时抛出错误
     */
    async initialize() {
        if (this.initialized) {
            Logger_1.Logger.warn('PersistentMemoryService 已初始化，跳过重复初始化', 'PersistentMemory');
            return;
        }
        try {
            // 确保存储目录存在
            await this.fileSystem.ensureDir(this.storageDir);
            // 加载 MEMORY.md
            const memoryPath = this.getFilePath('memory');
            if (await this.fileSystem.exists(memoryPath)) {
                try {
                    const content = await this.fileSystem.readFile(memoryPath);
                    this.memoryEntries = this.parseEntries(content);
                    Logger_1.Logger.info(`MEMORY.md 加载完成，共 ${this.memoryEntries.length} 条记录`, 'PersistentMemory');
                }
                catch (error) {
                    this.memoryEntries = [];
                    Logger_1.Logger.warn(`MEMORY.md 读取失败，初始化为空: ${error.message}`, 'PersistentMemory');
                }
            }
            else {
                this.memoryEntries = [];
                Logger_1.Logger.info('MEMORY.md 不存在，初始化为空', 'PersistentMemory');
            }
            // 加载 USER.md
            const userPath = this.getFilePath('user');
            if (await this.fileSystem.exists(userPath)) {
                try {
                    const content = await this.fileSystem.readFile(userPath);
                    this.userEntries = this.parseEntries(content);
                    Logger_1.Logger.info(`USER.md 加载完成，共 ${this.userEntries.length} 条记录`, 'PersistentMemory');
                }
                catch (error) {
                    this.userEntries = [];
                    Logger_1.Logger.warn(`USER.md 读取失败，初始化为空: ${error.message}`, 'PersistentMemory');
                }
            }
            else {
                this.userEntries = [];
                Logger_1.Logger.info('USER.md 不存在，初始化为空', 'PersistentMemory');
            }
            this.initialized = true;
            // 一次性迁移：从 UserProfile/PreferenceManager 导入数据到 USER.md
            await this.migrateFromLegacySystems();
            Logger_1.Logger.info('PersistentMemoryService 初始化完成', 'PersistentMemory');
        }
        catch (error) {
            Logger_1.Logger.error('PersistentMemoryService 初始化失败', error, 'PersistentMemory');
            throw new Error(`持久化记忆服务初始化失败: ${error.message}`);
        }
    }
    /**
     * 添加记忆条目
     * @param target - 存储目标: 'memory' 或 'user'
     * @param content - 要添加的内容
     * @returns 操作结果
     */
    async add(target, content) {
        this.ensureInitialized();
        // 0. 检查空内容
        if (!content || content.trim().length === 0) {
            return this.buildResult(target, false, '内容不能为空');
        }
        const entries = this.getEntriesRef(target);
        const limit = this.getCharLimit(target);
        // 1. 检查精确重复
        if (entries.some((entry) => entry === content)) {
            Logger_1.Logger.warn('添加记忆失败: 条目已存在（精确重复）', 'PersistentMemory');
            return this.buildResult(target, false, '条目已存在（精确重复）');
        }
        // 2. 检查容量
        const currentUsage = this.calculateUsage(target);
        const newUsage = currentUsage + content.length;
        if (newUsage > limit) {
            Logger_1.Logger.warn(`添加记忆失败: 超出容量限制 (${this.formatNumber(newUsage)}/${this.formatNumber(limit)})`, 'PersistentMemory');
            return this.buildResult(target, false, `超出容量限制 (${this.formatNumber(newUsage)}/${this.formatNumber(limit)})`);
        }
        // 3. 安全扫描
        const threat = this.scanSecurity(content);
        if (threat.detected) {
            Logger_1.Logger.warn(`添加记忆失败: 安全威胁 - ${threat.description}`, 'PersistentMemory');
            return this.buildResult(target, false, `安全威胁: ${threat.description}`);
        }
        // 4. 添加条目
        entries.push(content);
        await this.save();
        // 5. 容量警告
        const updatedUsage = this.calculateUsage(target);
        if (updatedUsage / limit > this.CAPACITY_WARNING_THRESHOLD) {
            Logger_1.Logger.warn(`${target} 容量已超过80% (${this.getUsage(target)})，建议整合条目`, 'PersistentMemory');
        }
        Logger_1.Logger.info(`添加${target === 'memory' ? 'Agent笔记' : '用户画像'}条目成功`, 'PersistentMemory');
        return this.buildResult(target, true);
    }
    /**
     * 替换记忆条目（通过子串匹配定位，替换整个条目）
     * @param target - 存储目标: 'memory' 或 'user'
     * @param oldText - 用于匹配的旧文本子串
     * @param newContent - 替换后的新内容
     * @returns 操作结果
     */
    async replace(target, oldText, newContent) {
        this.ensureInitialized();
        const entries = this.getEntriesRef(target);
        const limit = this.getCharLimit(target);
        // 1. 子串匹配定位
        const matchIndices = [];
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].includes(oldText)) {
                matchIndices.push(i);
            }
        }
        if (matchIndices.length === 0) {
            return this.buildResult(target, false, '未找到匹配的条目');
        }
        if (matchIndices.length > 1) {
            return this.buildResult(target, false, `匹配到 ${matchIndices.length} 个条目，请提供更精确的匹配文本`);
        }
        // 2. 安全扫描新内容
        const threat = this.scanSecurity(newContent);
        if (threat.detected) {
            Logger_1.Logger.warn(`替换记忆失败: 安全威胁 - ${threat.description}`, 'PersistentMemory');
            return this.buildResult(target, false, `安全威胁: ${threat.description}`);
        }
        // 3. 检查容量（替换后的净变化）
        const oldEntry = entries[matchIndices[0]];
        const currentUsage = this.calculateUsage(target);
        const newUsage = currentUsage - oldEntry.length + newContent.length;
        if (newUsage > limit) {
            return this.buildResult(target, false, `替换后超出容量限制 (${this.formatNumber(newUsage)}/${this.formatNumber(limit)})`);
        }
        // 4. 执行替换
        entries[matchIndices[0]] = newContent;
        await this.save();
        Logger_1.Logger.info(`替换${target === 'memory' ? 'Agent笔记' : '用户画像'}条目成功`, 'PersistentMemory');
        return this.buildResult(target, true);
    }
    /**
     * 删除记忆条目（通过子串匹配定位，删除整个条目）
     * @param target - 存储目标: 'memory' 或 'user'
     * @param oldText - 用于匹配的旧文本子串
     * @returns 操作结果
     */
    async remove(target, oldText) {
        this.ensureInitialized();
        const entries = this.getEntriesRef(target);
        // 1. 子串匹配定位
        const matchIndices = [];
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].includes(oldText)) {
                matchIndices.push(i);
            }
        }
        if (matchIndices.length === 0) {
            return this.buildResult(target, false, '未找到匹配的条目');
        }
        if (matchIndices.length > 1) {
            return this.buildResult(target, false, `匹配到 ${matchIndices.length} 个条目，请提供更精确的匹配文本`);
        }
        // 2. 执行删除（从后往前删，避免索引偏移）
        entries.splice(matchIndices[0], 1);
        await this.save();
        Logger_1.Logger.info(`删除${target === 'memory' ? 'Agent笔记' : '用户画像'}条目成功`, 'PersistentMemory');
        return this.buildResult(target, true);
    }
    /**
     * 获取记忆快照，用于注入系统提示词
     * @param target - 存储目标: 'memory' 或 'user'
     * @returns 格式化的记忆快照字符串
     */
    getSnapshot(target) {
        this.ensureInitialized();
        const entries = this.getEntriesRef(target);
        const usage = this.getUsage(target);
        const percentage = this.getUsagePercentage(target);
        const label = target === 'memory'
            ? 'MEMORY (your personal notes)'
            : 'USER (user profile)';
        const separator = '═'.repeat(47);
        const header = `${label} [${percentage}% — ${usage} chars]`;
        if (entries.length === 0) {
            return `${separator}\n${header}\n${separator}`;
        }
        return `${separator}\n${header}\n${separator}\n${entries.join(`\n${this.ENTRY_SEPARATOR}\n`)}`;
    }
    /**
     * 获取容量使用情况字符串
     * @param target - 存储目标: 'memory' 或 'user'
     * @returns 使用情况，如 "1,474/2,200"
     */
    getUsage(target) {
        const current = this.calculateUsage(target);
        const limit = this.getCharLimit(target);
        return `${this.formatNumber(current)}/${this.formatNumber(limit)}`;
    }
    /**
     * 获取指定目标的所有条目副本
     * @param target - 存储目标: 'memory' 或 'user'
     * @returns 条目数组的浅拷贝
     */
    getEntries(target) {
        return [...this.getEntriesRef(target)];
    }
    /**
     * 将当前记忆条目持久化到文件
     * @throws {Error} 当文件写入失败时抛出错误
     */
    async save() {
        this.ensureInitialized();
        try {
            const memoryContent = this.memoryEntries.join(this.ENTRY_SEPARATOR);
            const userContent = this.userEntries.join(this.ENTRY_SEPARATOR);
            await this.fileSystem.writeFile(this.getFilePath('memory'), memoryContent);
            await this.fileSystem.writeFile(this.getFilePath('user'), userContent);
            Logger_1.Logger.debug('记忆文件保存完成', 'PersistentMemory');
        }
        catch (error) {
            Logger_1.Logger.error('记忆文件保存失败', error, 'PersistentMemory');
            throw new Error(`记忆文件保存失败: ${error.message}`);
        }
    }
    /**
     * 关闭服务，保存数据并清理资源
     */
    async shutdown() {
        if (!this.initialized) {
            return;
        }
        try {
            await this.save();
            this.initialized = false;
            Logger_1.Logger.info('PersistentMemoryService 已关闭', 'PersistentMemory');
        }
        catch (error) {
            Logger_1.Logger.error('PersistentMemoryService 关闭失败', error, 'PersistentMemory');
        }
    }
    // ==================== 私有方法 ====================
    /**
     * 确保服务已初始化
     * @throws {Error} 当服务未初始化时抛出错误
     */
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('PersistentMemoryService 未初始化，请先调用 initialize()');
        }
    }
    /**
     * 获取目标文件路径
     * @param target - 存储目标
     * @returns 文件绝对路径
     */
    getFilePath(target) {
        const fileName = target === 'memory' ? 'MEMORY.md' : 'USER.md';
        return path.join(this.storageDir, fileName);
    }
    /**
     * 获取目标条目数组的引用
     * @param target - 存储目标
     * @returns 条目数组的直接引用
     */
    getEntriesRef(target) {
        return target === 'memory' ? this.memoryEntries : this.userEntries;
    }
    /**
     * 获取目标字符限制
     * @param target - 存储目标
     * @returns 字符限制值
     */
    getCharLimit(target) {
        return target === 'memory' ? this.MEMORY_CHAR_LIMIT : this.USER_CHAR_LIMIT;
    }
    /**
     * 计算当前使用字符数（不含分隔符）
     * @param target - 存储目标
     * @returns 当前字符数
     */
    calculateUsage(target) {
        const entries = this.getEntriesRef(target);
        return entries.reduce((sum, entry) => sum + entry.length, 0);
    }
    /**
     * 获取使用百分比
     * @param target - 存储目标
     * @returns 使用百分比整数
     */
    getUsagePercentage(target) {
        const current = this.calculateUsage(target);
        const limit = this.getCharLimit(target);
        return Math.round((current / limit) * 100);
    }
    /**
     * 解析文件内容为条目数组
     * @param content - 文件原始内容
     * @returns 解析后的条目数组
     */
    parseEntries(content) {
        if (!content || content.trim().length === 0) {
            return [];
        }
        return content
            .split(this.ENTRY_SEPARATOR)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }
    /**
     * 构建操作结果
     * @param target - 存储目标
     * @param success - 是否成功
     * @param error - 错误信息
     * @returns 操作结果对象
     */
    buildResult(target, success, error) {
        return {
            success,
            error,
            currentEntries: this.getEntries(target),
            usage: this.getUsage(target),
        };
    }
    /**
     * 格式化数字，添加千位分隔符
     * @param num - 要格式化的数字
     * @returns 格式化后的字符串，如 "1,474"
     */
    formatNumber(num) {
        return num.toLocaleString('en-US');
    }
    /**
     * 从旧系统（UserProfile + PreferenceManager）一次性迁移数据到 USER.md
     * 仅在 USER.md 为空时执行迁移，避免重复导入
     */
    async migrateFromLegacySystems() {
        // 仅当 USER.md 为空时才迁移
        if (this.userEntries.length > 0) {
            return;
        }
        const migrationEntries = [];
        try {
            // 从 UserProfile 迁移
            const { UserProfile } = await Promise.resolve().then(() => __importStar(require('./UserProfile')));
            const profile = new UserProfile();
            await profile.load();
            const basic = profile.getBasicInfo();
            const habits = profile.getDevelopmentHabits();
            const prefs = profile.getLifePreferences();
            const emotions = profile.getEmotionalPatterns();
            if (basic?.name) {
                migrationEntries.push(`用户名: ${basic.name}`);
            }
            if (habits?.preferredLanguages?.length) {
                migrationEntries.push(`常用语言: ${habits.preferredLanguages.join(', ')}`);
            }
            if (habits?.preferredFrameworks?.length) {
                migrationEntries.push(`常用框架: ${habits.preferredFrameworks.join(', ')}`);
            }
            if (habits?.commonTools?.length) {
                migrationEntries.push(`常用工具: ${habits.commonTools.join(', ')}`);
            }
            if (prefs?.dietaryPreferences?.length) {
                migrationEntries.push(`饮食偏好: ${prefs.dietaryPreferences.join(', ')}`);
            }
            if (prefs?.exerciseHabits?.length) {
                migrationEntries.push(`运动习惯: ${prefs.exerciseHabits.join(', ')}`);
            }
            if (prefs?.entertainmentPreferences?.length) {
                migrationEntries.push(`娱乐偏好: ${prefs.entertainmentPreferences.join(', ')}`);
            }
            if (emotions?.commonEmotions?.length) {
                const topEmotions = emotions.commonEmotions
                    .sort((a, b) => b.frequency - a.frequency)
                    .slice(0, 3)
                    .map((e) => e.type)
                    .join(', ');
                migrationEntries.push(`常见情绪: ${topEmotions}`);
            }
        }
        catch (error) {
            Logger_1.Logger.warn(`UserProfile 迁移跳过: ${error.message}`, 'PersistentMemory');
        }
        try {
            // 从 PreferenceManager 迁移
            const { PreferenceManager } = await Promise.resolve().then(() => __importStar(require('./PreferenceManager')));
            const prefManager = PreferenceManager.getInstance();
            const summary = prefManager.getSummary();
            if (summary.namingRules.length > 0) {
                migrationEntries.push(`命名规范: ${summary.namingRules.join('；')}`);
            }
            if (summary.codingStyle.length > 0) {
                migrationEntries.push(`代码风格: ${summary.codingStyle.join('；')}`);
            }
            if (summary.frameworkPreferences.length > 0) {
                migrationEntries.push(`框架偏好: ${summary.frameworkPreferences.join('；')}`);
            }
            if (summary.workflowPreferences.length > 0) {
                migrationEntries.push(`工作流程: ${summary.workflowPreferences.join('；')}`);
            }
            if (summary.recentCorrections.length > 0) {
                migrationEntries.push(`最近纠错: ${summary.recentCorrections.join('；')}`);
            }
        }
        catch (error) {
            Logger_1.Logger.warn(`PreferenceManager 迁移跳过: ${error.message}`, 'PersistentMemory');
        }
        // 写入迁移数据（受容量限制）
        if (migrationEntries.length > 0) {
            let totalChars = 0;
            for (const entry of migrationEntries) {
                if (totalChars + entry.length <= this.USER_CHAR_LIMIT) {
                    this.userEntries.push(entry);
                    totalChars += entry.length;
                }
                else {
                    Logger_1.Logger.warn(`USER.md 迁移截断: 超出容量限制，已导入 ${this.userEntries.length}/${migrationEntries.length} 条`, 'PersistentMemory');
                    break;
                }
            }
            await this.save();
            Logger_1.Logger.info(`从旧系统迁移 ${this.userEntries.length} 条用户画像到 USER.md`, 'PersistentMemory');
        }
    }
    /**
     * 安全扫描：检测提示注入、凭证泄露、不可见Unicode
     * @param content - 待扫描的内容
     * @returns 安全威胁检测结果
     */
    scanSecurity(content) {
        // 1. 提示注入检测
        if (this.PROMPT_INJECTION_PATTERN.test(content)) {
            return {
                detected: true,
                threatType: 'prompt_injection',
                description: '检测到提示注入模式（试图覆盖系统指令）',
            };
        }
        // 2. 凭证泄露检测
        if (this.CREDENTIAL_PATTERN.test(content)) {
            return {
                detected: true,
                threatType: 'credential_leakage',
                description: '检测到凭证泄露风险（API密钥/密码/私钥等）',
            };
        }
        // 3. 不可见Unicode字符检测
        if (this.INVISIBLE_UNICODE_PATTERN.test(content)) {
            return {
                detected: true,
                threatType: 'invisible_unicode',
                description: '检测到不可见Unicode字符（零宽字符/控制字符）',
            };
        }
        return { detected: false };
    }
}
exports.PersistentMemoryService = PersistentMemoryService;
PersistentMemoryService.instance = null;
