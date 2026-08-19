"use strict";
/**
 * 优化结果分发器
 * 将 StrategyOptimizer 产生的优化结果分发到各个消费端，完成进化闭环
 * 解决进化闭环断裂问题：优化结果 → 实际影响系统行为
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizationResultDispatcher = void 0;
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
/**
 * 优化结果分发器（单例）
 * 负责将 StrategyOptimizer 的优化结果路由到所有注册的消费者
 */
class OptimizationResultDispatcher {
    constructor() {
        this.consumers = [];
        this.lastSnapshot = null;
        this.dispatchHistory = [];
        this.maxHistorySize = 50;
    }
    static getInstance() {
        if (!OptimizationResultDispatcher.instance) {
            OptimizationResultDispatcher.instance =
                new OptimizationResultDispatcher();
        }
        return OptimizationResultDispatcher.instance;
    }
    static reset() {
        OptimizationResultDispatcher.instance = null;
    }
    /**
     * 注册优化结果消费者
     */
    registerConsumer(consumer) {
        const exists = this.consumers.some((c) => c.name === consumer.name);
        if (exists) {
            Logger_1.Logger.warn(`⚠️ 优化消费者已存在，跳过重复注册: ${consumer.name}`, 'OptimizationResultDispatcher');
            return;
        }
        this.consumers.push(consumer);
        Logger_1.Logger.info(`✅ 优化消费者已注册: ${consumer.name}`, 'OptimizationResultDispatcher');
    }
    /**
     * 注销优化结果消费者
     */
    unregisterConsumer(name) {
        const before = this.consumers.length;
        this.consumers = this.consumers.filter((c) => c.name !== name);
        if (this.consumers.length < before) {
            Logger_1.Logger.info(`🗑️ 优化消费者已注销: ${name}`, 'OptimizationResultDispatcher');
        }
    }
    /**
     * 分发优化结果到所有消费者
     * 这是完成进化闭环的关键方法
     */
    async dispatch(log) {
        const snapshot = {
            id: log.id,
            timestamp: log.timestamp.getTime(),
            toneAdjustments: log.toneAdjustments,
            skillWeights: this.mapSkillAdjustmentsToWeights(log.skillAdjustments),
            promptExamples: log.promptExamples,
        };
        this.lastSnapshot = snapshot;
        this.dispatchHistory.push(snapshot);
        if (this.dispatchHistory.length > this.maxHistorySize) {
            this.dispatchHistory.shift();
        }
        Logger_1.Logger.info(`📢 分发优化结果: tone=${snapshot.toneAdjustments.length}, skills=${Object.keys(snapshot.skillWeights).length}, prompts=${snapshot.promptExamples.length}`, 'OptimizationResultDispatcher');
        // 广播优化更新事件（供异步监听者使用）
        void EventBus_1.EventBus.emit('optimization_update', snapshot);
        // 同步分发到所有注册的消费者
        const results = await Promise.allSettled(this.consumers.map(async (consumer) => {
            try {
                await consumer.onOptimizationUpdate(snapshot);
                Logger_1.Logger.debug(`✅ 优化结果已分发到 ${consumer.name}`, 'OptimizationResultDispatcher');
            }
            catch (error) {
                Logger_1.Logger.error(`❌ 优化结果分发到 ${consumer.name} 失败`, error, 'OptimizationResultDispatcher');
            }
        }));
        const succeeded = results.filter((r) => r.status === 'fulfilled').length;
        Logger_1.Logger.info(`✅ 优化分发完成: ${succeeded}/${this.consumers.length} 成功`, 'OptimizationResultDispatcher');
    }
    /**
     * 获取最近一次优化快照
     */
    getLastSnapshot() {
        return this.lastSnapshot;
    }
    /**
     * 获取分发历史
     */
    getDispatchHistory() {
        return [...this.dispatchHistory];
    }
    /**
     * 获取已注册消费者列表
     */
    getConsumerNames() {
        return this.consumers.map((c) => c.name);
    }
    /**
     * 将技能权重调整转换为权重映射
     */
    mapSkillAdjustmentsToWeights(adjustments) {
        const weights = {};
        for (const adj of adjustments) {
            weights[adj.skillName] = adj.weightDelta;
        }
        return weights;
    }
}
exports.OptimizationResultDispatcher = OptimizationResultDispatcher;
OptimizationResultDispatcher.instance = null;
