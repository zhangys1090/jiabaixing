"use strict";
/**
 * Harness Layer 4: Persistence - 统一持久化服务
 *
 * 统一包装分散在 MemoryEngine/ConversationHistoryManager/ChatService/EventBus/UserProfile 等模块的持久化逻辑
 * 新增跨会话任务状态管理
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistenceService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../utils/Logger");
class PersistenceService {
    constructor(deps, dataDir) {
        /** 跨会话任务状态 — 内存缓存 + 文件持久化 */
        this.taskStates = new Map();
        this.MAX_TASK_STATES = 10000;
        /** 进化指标 — 内存缓存 */
        this.evolutionMetrics = [];
        this.initialized = false;
        this.evolutionMetricsSinceLastFlush = 0;
        this.flushTimer = null;
        /** 已晋升记忆 ID 集合 — 防止重复晋升 */
        this.promotedMemoryIds = new Set();
        this.deps = deps;
        const baseDir = dataDir || path_1.default.resolve(process.cwd(), 'data', 'persistence');
        this.taskStatesPath = path_1.default.join(baseDir, 'task-states.json');
        this.evolutionMetricsPath = path_1.default.join(baseDir, 'evolution-metrics.json');
    }
    /**
     * 初始化
     */
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('💾 PersistenceService 初始化', 'PersistenceService');
        await this.loadTaskStatesFromDisk();
        await this.loadEvolutionMetricsFromDisk();
        this.flushTimer = setInterval(() => {
            void this.flushTaskStatesToDisk();
            void this.flushEvolutionMetricsToDisk();
            this.promoteMemories().catch((err) => {
                Logger_1.Logger.error('定时记忆晋升失败', err, 'PersistenceService');
            });
        }, 30000);
        if (this.flushTimer.unref)
            this.flushTimer.unref();
        this.initialized = true;
    }
    // ============ 记忆 CRUD ============
    /**
     * 存储记忆
     */
    async storeMemory(content, options = {}) {
        const { type = 'short_term', scene, emotion } = options;
        if (!this.deps.memoryEngine) {
            Logger_1.Logger.warn('记忆引擎不可用，跳过存储', 'PersistenceService');
            return '';
        }
        try {
            switch (type) {
                case 'instant':
                    await this.deps.memoryEngine.storeInstantMemory(content, scene, emotion);
                    break;
                case 'long_term':
                    await this.deps.memoryEngine.storeLongTermMemory(content, scene, emotion);
                    break;
                default:
                    await this.deps.memoryEngine.storeShortTermMemory(content, scene, emotion);
            }
            return 'stored';
        }
        catch (err) {
            Logger_1.Logger.error('记忆存储失败', err, 'PersistenceService');
            return '';
        }
    }
    /**
     * 检索记忆
     */
    async recallMemory(query, options = {}) {
        if (!this.deps.memoryEngine)
            return [];
        try {
            return (await this.deps.memoryEngine.preciseHybridRetrieval(query, options.scene, options.emotion, options.limit || 5));
        }
        catch (err) {
            Logger_1.Logger.error('记忆检索失败', err, 'PersistenceService');
            return [];
        }
    }
    /**
     * 存储反馈信号
     */
    async storeFeedback(data) {
        if (!this.deps.memoryEngine)
            return;
        try {
            await this.deps.memoryEngine.storeFeedbackSignal({
                ...data,
                timestamp: Date.now(),
            });
        }
        catch (err) {
            Logger_1.Logger.error('反馈存储失败', err, 'PersistenceService');
        }
    }
    // ============ 记忆生命周期管理 ============
    /**
     * 晋升短期记忆为长期记忆
     *
     * 扫描短期记忆，将满足以下条件之一的记忆晋升为长期记忆：
     * - importance >= 7（高重要性）
     * - accessCount >= 3（频繁访问）
     *
     * 晋升后从短期存储中移除已晋升的条目
     *
     * @returns 晋升的记忆数量
     */
    async promoteMemories() {
        if (!this.deps.memoryEngine) {
            Logger_1.Logger.warn('记忆引擎不可用，跳过晋升', 'PersistenceService');
            return 0;
        }
        try {
            // 修复: 使用有意义的查询替代空字符串，并用多个查询覆盖不同类型的记忆
            const queries = ['重要', '记住', '关键', '用户偏好', '学习'];
            const allMemories = [];
            for (const query of queries) {
                const results = (await this.deps.memoryEngine.preciseHybridRetrieval(query, undefined, undefined, 20));
                allMemories.push(...results);
            }
            // 去重（按 id）
            const seen = new Set();
            const uniqueMemories = allMemories.filter((m) => {
                const id = m.id || JSON.stringify(m.content);
                if (seen.has(id))
                    return false;
                seen.add(id);
                return true;
            });
            const candidates = uniqueMemories.filter((m) => {
                const id = m.id || '';
                // 排除已晋升的记忆
                if (this.promotedMemoryIds.has(id))
                    return false;
                // 排除已通过 feedback signal 标记的
                if (id && this.promotedMemoryIds.has(`promoted:${id}`))
                    return false;
                return ((m.type === 'short_term' ||
                    !m.type) &&
                    ((m.importance != null &&
                        m.importance >= 7) ||
                        (m.accessCount != null &&
                            m.accessCount >= 3)));
            });
            if (candidates.length === 0) {
                return 0;
            }
            let promoted = 0;
            for (const memory of candidates) {
                const memId = memory.id || '';
                const memContent = typeof memory.content === 'string'
                    ? memory.content
                    : JSON.stringify(memory.content);
                try {
                    await this.deps.memoryEngine.storeLongTermMemory(memContent, memory.scene, memory.emotion);
                    // 标记为已晋升，防止重复晋升
                    if (memId) {
                        this.promotedMemoryIds.add(memId);
                        this.promotedMemoryIds.add(`promoted:${memId}`);
                        if (this.promotedMemoryIds.size > 20000) {
                            const iter = this.promotedMemoryIds.values();
                            for (let i = 0; i < 5000; i++) {
                                iter.next();
                            }
                            const toDelete = [];
                            for (let i = 0; i < 5000; i++) {
                                const r = iter.next();
                                if (r.done) break;
                                toDelete.push(r.value);
                            }
                            toDelete.forEach(id => this.promotedMemoryIds.delete(id));
                        }
                    }
                    promoted++;
                    Logger_1.Logger.info(`💾 记忆晋升: id=${memId} importance=${memory.importance ?? '-'} accessCount=${memory.accessCount ?? '-'}`, 'PersistenceService');
                }
                catch (err) {
                    Logger_1.Logger.error(`记忆晋升失败: id=${memId}`, err, 'PersistenceService');
                }
            }
            if (promoted > 0) {
                Logger_1.Logger.info(`💾 记忆晋升完成: ${promoted}/${candidates.length} 条记忆已晋升为长期记忆`, 'PersistenceService');
            }
            return promoted;
        }
        catch (err) {
            Logger_1.Logger.error('记忆晋升扫描失败', err, 'PersistenceService');
            return 0;
        }
    }
    // ============ 对话历史 ============
    /**
     * 保存对话消息
     */
    saveConversationMessage(role, content) {
        if (!this.deps.conversationHistory)
            return;
        if (role === 'user') {
            this.deps.conversationHistory.addUserMessage(content);
        }
        else {
            this.deps.conversationHistory.addAssistantMessage(content);
        }
    }
    /**
     * 获取对话历史
     */
    getConversationHistory(limit) {
        if (!this.deps.conversationHistory)
            return [];
        const recent = this.deps.conversationHistory.getRecent(limit || 20);
        return recent.map((entry) => ({
            role: entry.role,
            content: entry.content,
        }));
    }
    /**
     * 持久化对话状态
     */
    async saveConversationState() {
        if (!this.deps.conversationHistory)
            return;
        try {
            await this.deps.conversationHistory.saveState();
        }
        catch (err) {
            Logger_1.Logger.error('对话状态保存失败', err, 'PersistenceService');
        }
    }
    /**
     * 清空对话历史
     */
    async clearConversation() {
        if (!this.deps.conversationHistory)
            return;
        try {
            await this.deps.conversationHistory.clear();
        }
        catch (err) {
            Logger_1.Logger.error('对话清空失败', err, 'PersistenceService');
        }
    }
    // ============ 跨会话任务状态（新增） ============
    /**
     * 保存任务状态
     */
    async saveTaskState(task) {
        task.updatedAt = Date.now();
        this.taskStates.set(task.taskId, task);
        if (this.taskStates.size > this.MAX_TASK_STATES) {
            const oldestKey = this.taskStates.keys().next().value;
            this.taskStates.delete(oldestKey);
        }
        Logger_1.Logger.info(`💾 任务状态保存: ${task.taskId} status=${task.status}`, 'PersistenceService');
        await this.flushTaskStatesToDisk();
    }
    /**
     * 加载任务状态
     */
    async loadTaskState(taskId) {
        return this.taskStates.get(taskId) || null;
    }
    /**
     * 列出活跃任务
     */
    async listActiveTasks() {
        return Array.from(this.taskStates.values()).filter((t) => t.status === 'pending' ||
            t.status === 'in_progress' ||
            t.status === 'paused');
    }
    /**
     * 更新任务状态
     */
    async updateTaskStatus(taskId, status, resumeContext) {
        const task = this.taskStates.get(taskId);
        if (!task)
            return false;
        task.status = status;
        task.updatedAt = Date.now();
        if (resumeContext)
            task.resumeContext = resumeContext;
        await this.flushTaskStatesToDisk();
        return true;
    }
    /**
     * 删除任务
     */
    async deleteTask(taskId) {
        const deleted = this.taskStates.delete(taskId);
        if (deleted) {
            await this.flushTaskStatesToDisk();
        }
        return deleted;
    }
    // ============ 用户画像 ============
    /**
     * 加载用户画像
     */
    async loadUserProfile() {
        if (!this.deps.userProfile)
            return null;
        try {
            await this.deps.userProfile.load();
            return this.deps.userProfile.getData();
        }
        catch (err) {
            Logger_1.Logger.error('用户画像加载失败', err, 'PersistenceService');
            return null;
        }
    }
    /**
     * 保存用户画像
     */
    async saveUserProfile(data) {
        if (!this.deps.userProfile)
            return;
        try {
            await this.deps.userProfile.update(data);
        }
        catch (err) {
            Logger_1.Logger.error('用户画像保存失败', err, 'PersistenceService');
        }
    }
    // ============ 进化指标 ============
    /**
     * 记录进化指标
     */
    recordEvolutionMetric(metric) {
        this.evolutionMetrics.push(metric);
        if (this.evolutionMetrics.length > 1000) {
            this.evolutionMetrics = this.evolutionMetrics.slice(-1000);
        }
        this.evolutionMetricsSinceLastFlush++;
        if (this.evolutionMetricsSinceLastFlush >= 10) {
            void this.flushEvolutionMetricsToDisk();
        }
    }
    /**
     * 获取进化指标
     */
    getEvolutionMetrics(metricType, limit) {
        let metrics = this.evolutionMetrics;
        if (metricType) {
            metrics = metrics.filter((m) => m.metricType === metricType);
        }
        if (limit) {
            metrics = metrics.slice(-limit);
        }
        return metrics;
    }
    // ============ 生命周期 ============
    /**
     * 关闭
     */
    async shutdown() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flushTaskStatesToDisk();
        await this.flushEvolutionMetricsToDisk();
        Logger_1.Logger.info('💾 PersistenceService 关闭', 'PersistenceService');
        this.initialized = false;
    }
    // ============ 文件持久化 ============
    /**
     * 将任务状态写入磁盘
     */
    async flushTaskStatesToDisk() {
        try {
            const dir = path_1.default.dirname(this.taskStatesPath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            const data = Array.from(this.taskStates.values());
            fs_1.default.writeFileSync(this.taskStatesPath, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch (err) {
            Logger_1.Logger.error('任务状态刷盘失败', err, 'PersistenceService');
        }
    }
    /**
     * 从磁盘加载任务状态
     */
    async loadTaskStatesFromDisk() {
        try {
            if (!fs_1.default.existsSync(this.taskStatesPath)) {
                Logger_1.Logger.info('💾 无持久化任务状态文件，跳过加载', 'PersistenceService');
                return;
            }
            const raw = fs_1.default.readFileSync(this.taskStatesPath, 'utf-8');
            const data = JSON.parse(raw);
            for (const task of data) {
                this.taskStates.set(task.taskId, task);
            }
            Logger_1.Logger.info(`💾 已从磁盘加载 ${data.length} 个任务状态`, 'PersistenceService');
        }
        catch (err) {
            Logger_1.Logger.error('任务状态加载失败', err, 'PersistenceService');
        }
    }
    async flushEvolutionMetricsToDisk() {
        try {
            const dir = path_1.default.dirname(this.evolutionMetricsPath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            fs_1.default.writeFileSync(this.evolutionMetricsPath, JSON.stringify(this.evolutionMetrics, null, 2), 'utf-8');
            this.evolutionMetricsSinceLastFlush = 0;
        }
        catch (err) {
            Logger_1.Logger.error('进化指标刷盘失败', err, 'PersistenceService');
        }
    }
    async loadEvolutionMetricsFromDisk() {
        try {
            if (!fs_1.default.existsSync(this.evolutionMetricsPath)) {
                Logger_1.Logger.info('💾 无持久化进化指标文件，跳过加载', 'PersistenceService');
                return;
            }
            const raw = fs_1.default.readFileSync(this.evolutionMetricsPath, 'utf-8');
            const data = JSON.parse(raw);
            this.evolutionMetrics = data.slice(-1000);
            Logger_1.Logger.info(`💾 已从磁盘加载 ${this.evolutionMetrics.length} 条进化指标`, 'PersistenceService');
        }
        catch (err) {
            Logger_1.Logger.error('进化指标加载失败', err, 'PersistenceService');
        }
    }
}
exports.PersistenceService = PersistenceService;
