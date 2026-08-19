"use strict";
/**
 * BaseAgent — 抽象 Agent 基类
 *
 * 定义统一的 Agent 接口，持有 llm、tools、memory 引用。
 * 具体 Agent（CodingAgent/FileAgent/DesktopAgent）继承此类，
 * 配置各自工具集和执行逻辑。
 *
 * 设计原则：
 * - Agent 自治：每个 Agent 独立持有自己的资源
 * - 状态外置：执行状态可被外部观察
 * - 可恢复：失败后可重置
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseAgent = void 0;
const Logger_1 = require("../../utils/Logger");
class BaseAgent {
    constructor(config) {
        this._status = 'idle';
        this.executeFn = null;
        this.lastExecuteTime = 0;
        this.errorCount = 0;
        this.successCount = 0;
        this.consecutiveErrors = 0;
        this.executionTimeoutMs = config.executionTimeoutMs ?? 120000;
        this.id = config.id;
        this.name = config.name;
        this.description = config.description;
        this.capabilities = config.capabilities;
        this.toolCategories = config.toolCategories;
    }
    /** 当前状态 */
    get status() {
        return this._status;
    }
    /** 成功次数 */
    get successRate() {
        const total = this.successCount + this.errorCount;
        return total === 0 ? 1.0 : this.successCount / total;
    }
    /** 设置执行函数 */
    setExecuteFn(fn) {
        this.executeFn = fn;
    }
    /** 检查 Agent 是否已设置执行函数 */
    get isReady() {
        return this.executeFn !== null;
    }
    /**
     * 执行任务
     * @param goal - 任务目标
     * @param context - 上下文信息
     * @returns 执行结果文本
     */
    async execute(goal, context = '') {
        if (!this.executeFn) {
            throw new Error(`${this.name} 未设置 executeFn，无法执行任务`);
        }
        this._status = 'busy';
        const startTime = Date.now();
        let timeoutId;
        try {
            Logger_1.Logger.info(`🤖 ${this.name} 开始执行: ${goal.substring(0, 80)}`, this.id);
            const result = await Promise.race([
                this.executeFn(goal, context, this),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error(`${this.name} 执行超时 (${this.executionTimeoutMs}ms)`)), this.executionTimeoutMs);
                    if (timeoutId.unref)
                        timeoutId.unref();
                }),
            ]);
            clearTimeout(timeoutId);
            this._status = 'idle';
            this.successCount++;
            this.consecutiveErrors = 0;
            this.lastExecuteTime = Date.now() - startTime;
            Logger_1.Logger.info(`✅ ${this.name} 执行完成 (${this.lastExecuteTime}ms)`, this.id);
            return result;
        }
        catch (error) {
            clearTimeout(timeoutId);
            this._status = 'error';
            this.errorCount++;
            this.consecutiveErrors++;
            this.lastExecuteTime = Date.now() - startTime;
            Logger_1.Logger.error(`${this.name} 执行失败 (连续${this.consecutiveErrors}次)`, error, this.id);
            if (this.consecutiveErrors >= 3) {
                const backoffMs = Math.min(30000, 1000 * Math.pow(2, this.consecutiveErrors - 1));
                Logger_1.Logger.warn(`${this.name} 连续失败 ${this.consecutiveErrors} 次，${backoffMs}ms后重置`, this.id);
                await new Promise((r) => setTimeout(r, backoffMs));
                this._status = 'idle';
                this.consecutiveErrors = 0;
            }
            throw error;
        }
    }
    /** 重置状态 */
    reset() {
        this._status = 'idle';
        Logger_1.Logger.debug(`${this.name} 状态已重置`, this.id);
    }
    /** 获取统计信息 */
    getStats() {
        return {
            status: this._status,
            successCount: this.successCount,
            errorCount: this.errorCount,
            successRate: this.successRate,
            lastExecuteTime: this.lastExecuteTime,
        };
    }
}
exports.BaseAgent = BaseAgent;
