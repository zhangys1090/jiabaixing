"use strict";
/**
 * BaseAgent — 抽象 Agent 基类
 *
 * 定义统一的 Agent 接口，持有 llm、tools、memory 引用。
 * 具体 Agent（CodingAgent/FileAgent/DesktopAgent/OrchestratorAgent）继承此类，
 * 配置各自工具集和执行逻辑。
 *
 * V5.6 增强：
 * - bid() 竞标接口：供 OrchestratorAgent 选择最佳执行者
 * - healthCheck() 健康检查：供 AgentRegistry 监控
 * - canHandle() 能力匹配：供任务分配
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
    id;
    name;
    description;
    capabilities;
    toolCategories;
    _status = 'idle';
    executeFn = null;
    lastExecuteTime = 0;
    errorCount = 0;
    successCount = 0;
    totalResponseTime = 0;
    constructor(config) {
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
        try {
            Logger_1.Logger.info(`🤖 ${this.name} 开始执行: ${goal.substring(0, 80)}`, this.id);
            const result = await this.executeFn(goal, context, this);
            this._status = 'idle';
            this.successCount++;
            this.lastExecuteTime = Date.now() - startTime;
            this.totalResponseTime += this.lastExecuteTime;
            Logger_1.Logger.info(`✅ ${this.name} 执行完成 (${this.lastExecuteTime}ms)`, this.id);
            return result;
        }
        catch (error) {
            this._status = 'error';
            this.errorCount++;
            this.lastExecuteTime = Date.now() - startTime;
            this.totalResponseTime += this.lastExecuteTime;
            Logger_1.Logger.error(`${this.name} 执行失败`, error, this.id);
            throw error;
        }
    }
    /**
     * 竞标接口 — 供 OrchestratorAgent 选择最佳执行者
     * 子类可覆盖以实现更精细的竞标逻辑
     * @param taskGoal - 任务目标
     * @param requiredTools - 所需工具列表
     * @returns 竞标结果，null 表示不参与竞标
     */
    async bid(taskGoal, requiredTools) {
        if (this._status !== 'idle')
            return null;
        if (!this.canHandle(taskGoal, requiredTools))
            return null;
        const confidence = this.estimateConfidence(taskGoal);
        return {
            agentId: this.id,
            confidence,
            estimatedDuration: this.lastExecuteTime > 0 ? this.lastExecuteTime * 1.2 : undefined,
            reason: `${this.name} 匹配能力: ${this.capabilities.join(', ')}`,
        };
    }
    /**
     * 能力匹配 — 检查本 Agent 是否能处理给定任务
     * @param taskGoal - 任务目标
     * @param requiredTools - 所需工具列表
     */
    canHandle(taskGoal, requiredTools) {
        if (requiredTools && requiredTools.length > 0) {
            return requiredTools.some((tool) => this.toolCategories.some((cat) => String(cat) === tool || String(cat) === '*'));
        }
        return true;
    }
    /**
     * 估算置信度 — 基于历史成功率
     * 子类可覆盖以实现更精细的估算
     */
    estimateConfidence(_taskGoal) {
        return this.successRate;
    }
    /**
     * 健康检查 — 供 AgentRegistry 监控
     */
    async healthCheck() {
        const total = this.successCount + this.errorCount;
        return {
            healthy: this._status !== 'error',
            successRate: this.successRate,
            avgResponseTime: total > 0 ? this.totalResponseTime / total : 0,
            lastActiveAt: Date.now() - this.lastExecuteTime,
            errorCount: this.errorCount,
            totalExecutions: total,
        };
    }
    /** 重置状态 */
    reset() {
        this._status = 'idle';
        Logger_1.Logger.debug(`${this.name} 状态已重置`, this.id);
    }
    /** 获取统计信息 */
    getStats() {
        const total = this.successCount + this.errorCount;
        return {
            status: this._status,
            successCount: this.successCount,
            errorCount: this.errorCount,
            successRate: this.successRate,
            lastExecuteTime: this.lastExecuteTime,
            avgResponseTime: total > 0 ? this.totalResponseTime / total : 0,
        };
    }
}
exports.BaseAgent = BaseAgent;
