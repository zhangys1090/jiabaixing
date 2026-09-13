"use strict";
/**
 * DesktopDecisionEngine - 桌面操作强化学习决策引擎
 *
 * 功能：
 * - Q-Learning 决策优化
 * - 历史动作分析
 * - 成功率评估
 * - 策略自适应调整
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopDecisionEngine = void 0;
const Logger_1 = require("../utils/Logger");
const DEFAULT_POLICY = {
    explorationRate: 0.3,
    learningRate: 0.1,
    discountFactor: 0.9,
    decayRate: 0.05,
};
class DesktopDecisionEngine {
    policy;
    qTable; // Q表: stateKey -> action -> value
    experiences;
    actionStats;
    experienceBuffer;
    maxBufferSize = 1000;
    constructor(policy) {
        this.policy = { ...DEFAULT_POLICY, ...policy };
        this.qTable = new Map();
        this.experiences = [];
        this.actionStats = new Map();
        this.experienceBuffer = [];
        Logger_1.Logger.info('🧠 DesktopDecisionEngine 初始化', 'DesktopDecisionEngine');
    }
    /**
     * 生成决策状态
     */
    generateState(screenComplexity, elementCount, activeWindows, lastAction, consecutiveFailures, taskProgress) {
        return {
            screenComplexity,
            elementCount,
            activeWindows,
            lastAction,
            consecutiveFailures,
            taskProgress,
        };
    }
    /**
     * 状态编码为 Q表键
     */
    encodeState(state) {
        const complexityBucket = Math.floor(state.screenComplexity * 10);
        const elementBucket = Math.min(Math.floor(state.elementCount / 20), 5);
        const windowBucket = Math.min(state.activeWindows, 5);
        const failBucket = Math.min(state.consecutiveFailures, 3);
        const progressBucket = Math.floor(state.taskProgress * 5);
        return `c${complexityBucket}_e${elementBucket}_w${windowBucket}_f${failBucket}_p${progressBucket}`;
    }
    /**
     * 选择动作 (epsilon-greedy 策略)
     */
    selectAction(state, availableActions) {
        const stateKey = this.encodeState(state);
        // epsilon-greedy: 探索 vs 利用
        if (Math.random() < this.policy.explorationRate) {
            // 探索：随机选择动作
            const randomAction = availableActions[Math.floor(Math.random() * availableActions.length)];
            Logger_1.Logger.debug(`🎲 探索模式: 选择 ${randomAction}`, 'DesktopDecisionEngine');
            return {
                actionType: randomAction,
                confidence: this.policy.explorationRate,
                estimatedDuration: 500,
                riskLevel: 'medium',
                reasoning: '探索模式：随机尝试',
            };
        }
        // 利用：选择 Q值最大的动作
        const actionValues = this.getActionValues(stateKey, availableActions);
        if (actionValues.length === 0) {
            const fallbackAction = availableActions[0] || 'wait';
            return {
                actionType: fallbackAction,
                confidence: 0.5,
                estimatedDuration: 500,
                riskLevel: 'low',
                reasoning: '无历史数据：使用默认动作',
            };
        }
        const bestAction = actionValues.reduce((best, current) => current.value > best.value ? current : best);
        const confidence = Math.min(0.9, 0.5 + bestAction.value * 0.1);
        const riskLevel = this.assessRisk(bestAction.action);
        Logger_1.Logger.debug(`🎯 利用模式: 选择 ${bestAction.action} (Q值: ${bestAction.value.toFixed(3)})`, 'DesktopDecisionEngine');
        return {
            actionType: bestAction.action,
            confidence,
            estimatedDuration: this.estimateDuration(bestAction.action),
            riskLevel,
            reasoning: this.generateReasoning(state, bestAction.action, confidence),
        };
    }
    /**
     * 获取各动作的 Q值
     */
    getActionValues(stateKey, availableActions) {
        const stateQValues = this.qTable.get(stateKey) || new Map();
        const result = [];
        for (const action of availableActions) {
            const baseValue = stateQValues.get(action) || 0;
            const statBonus = this.getStatBonus(action);
            result.push({ action, value: baseValue + statBonus });
        }
        return result;
    }
    /**
     * 获取统计奖励加成
     */
    getStatBonus(action) {
        const stats = this.actionStats.get(action);
        if (!stats || stats.attempts === 0)
            return 0;
        const successRate = stats.successes / stats.attempts;
        return successRate * 0.5 + stats.avgReward * 0.3;
    }
    /**
     * 评估动作风险
     */
    assessRisk(action) {
        const highRiskActions = ['drag', 'rightClick', 'openApp'];
        const mediumRiskActions = ['type', 'keyCombo', 'closeWindow'];
        if (highRiskActions.includes(action))
            return 'high';
        if (mediumRiskActions.includes(action))
            return 'medium';
        return 'low';
    }
    /**
     * 预估动作耗时
     */
    estimateDuration(action) {
        const durations = {
            click: 300,
            rightClick: 400,
            type: 500,
            key: 200,
            keyCombo: 300,
            moveMouse: 200,
            scroll: 300,
            drag: 800,
            openApp: 2000,
            activateWindow: 500,
            closeWindow: 400,
            wait: 1000,
            observe: 500,
            screenshot: 300,
            clipboardRead: 200,
            clipboardWrite: 300,
        };
        return durations[action] || 500;
    }
    /**
     * 生成决策理由
     */
    generateReasoning(state, action, confidence) {
        const reasons = [];
        if (state.consecutiveFailures > 0) {
            reasons.push(`避免连续失败（${state.consecutiveFailures}次）`);
        }
        if (state.screenComplexity > 0.7) {
            reasons.push('屏幕复杂度高，需谨慎');
        }
        if (confidence > 0.8) {
            reasons.push('历史成功率高');
        }
        return reasons.length > 0 ? reasons.join('；') : '基于历史经验选择';
    }
    /**
     * 记录经验并更新 Q表
     */
    recordExperience(state, action, reward, nextState, success) {
        const experience = {
            state,
            action,
            reward,
            nextState,
            timestamp: Date.now(),
            success,
        };
        // 更新 Q表
        this.updateQTable(state, action, reward, nextState);
        // 更新统计
        this.updateStats(action, success, reward);
        // 保存经验
        this.experiences.push(experience);
        this.experienceBuffer.push(experience);
        if (this.experienceBuffer.length > this.maxBufferSize) {
            this.experienceBuffer.shift();
        }
        // 衰减探索率
        this.policy.explorationRate = Math.max(0.05, this.policy.explorationRate * (1 - this.policy.decayRate));
        Logger_1.Logger.debug(`📊 记录经验: ${action} - 奖励: ${reward.toFixed(2)} (成功率: ${success})`, 'DesktopDecisionEngine');
    }
    /**
     * 更新 Q表
     */
    updateQTable(state, action, reward, nextState) {
        const stateKey = this.encodeState(state);
        const nextStateKey = this.encodeState(nextState);
        if (!this.qTable.has(stateKey)) {
            this.qTable.set(stateKey, new Map());
        }
        const actionQValues = this.qTable.get(stateKey);
        const currentQ = actionQValues.get(action) || 0;
        // 获取下一状态的最大 Q值
        const nextActionValues = this.qTable.get(nextStateKey);
        const maxNextQ = nextActionValues
            ? Math.max(...nextActionValues.values(), 0)
            : 0;
        // Q-learning 更新公式
        const newQ = currentQ +
            this.policy.learningRate *
                (reward + this.policy.discountFactor * maxNextQ - currentQ);
        actionQValues.set(action, newQ);
    }
    /**
     * 更新动作统计
     */
    updateStats(action, success, reward) {
        if (!this.actionStats.has(action)) {
            this.actionStats.set(action, { attempts: 0, successes: 0, avgReward: 0 });
        }
        const stats = this.actionStats.get(action);
        const totalAttempts = stats.attempts + 1;
        const totalSuccesses = stats.successes + (success ? 1 : 0);
        const newAvg = (stats.avgReward * stats.attempts + reward) / totalAttempts;
        this.actionStats.set(action, {
            attempts: totalAttempts,
            successes: totalSuccesses,
            avgReward: newAvg,
        });
    }
    /**
     * 计算奖励
     */
    calculateReward(success, taskProgressDelta, timeElapsed, errors = []) {
        let reward = 0;
        // 成功/失败奖励
        if (success) {
            reward += 10;
            reward += taskProgressDelta * 5;
        }
        else {
            reward -= 5;
        }
        // 时间惩罚
        const timePenalty = Math.min(5, timeElapsed / 10000);
        reward -= timePenalty;
        // 错误惩罚
        reward -= errors.length * 2;
        return reward;
    }
    /**
     * 获取决策统计信息
     */
    getDecisionStats() {
        const formattedStats = {};
        for (const [action, stats] of this.actionStats.entries()) {
            formattedStats[action] = {
                successRate: stats.attempts > 0 ? stats.successes / stats.attempts : 0,
                avgReward: stats.avgReward,
                attempts: stats.attempts,
            };
        }
        return {
            totalExperiences: this.experiences.length,
            uniqueStates: this.qTable.size,
            actionStats: formattedStats,
            currentExplorationRate: this.policy.explorationRate,
        };
    }
    /**
     * 重置学习状态
     */
    resetLearning() {
        this.qTable.clear();
        this.experiences = [];
        this.actionStats.clear();
        this.policy.explorationRate = DEFAULT_POLICY.explorationRate;
        Logger_1.Logger.info('🧠 决策引擎学习状态已重置', 'DesktopDecisionEngine');
    }
    /**
     * 持久化 Q表
     */
    exportQTable() {
        const exportData = {};
        for (const [stateKey, actions] of this.qTable.entries()) {
            exportData[stateKey] = Object.fromEntries(actions);
        }
        return JSON.stringify(exportData);
    }
    /**
     * 加载 Q表
     */
    importQTable(jsonString) {
        try {
            const importData = JSON.parse(jsonString);
            for (const [stateKey, actions] of Object.entries(importData)) {
                this.qTable.set(stateKey, new Map(Object.entries(actions)));
            }
            Logger_1.Logger.info('🧠 Q表已加载', 'DesktopDecisionEngine');
        }
        catch (e) {
            Logger_1.Logger.error('Q表导入失败', e, 'DesktopDecisionEngine');
        }
    }
}
exports.DesktopDecisionEngine = DesktopDecisionEngine;
exports.default = DesktopDecisionEngine;
