"use strict";
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
exports.SelfModificationEngine = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../../utils/Logger");
/** 违规升级阈值 */
const ESCALATION_VIOLATION_THRESHOLD = 2;
/** 成功降级阈值 */
const DE_ESCALATION_SUCCESS_THRESHOLD = 5;
class SelfModificationEngine {
    constructor() {
        /** 安全边界记录 — key 为路径 */
        this.safetyBoundaries = new Map();
        this.MAX_SAFETY_BOUNDARIES = 10000;
        /** 禁止路径 */
        this.forbiddenPaths = new Set([
            'node_modules',
            '.git',
            'dist',
            'build',
        ]);
        /** 禁止删除的入口文件 */
        this.forbiddenDeletePaths = new Set([
            'src/main.ts',
            'src/index.ts',
            'package.json',
        ]);
        /** 需要确认的核心路径 */
        this.cautiousModifyPaths = new Set([
            'src/core/',
            'src/harness/',
        ]);
        /** 策略结果历史 */
        this.strategyOutcomes = [];
    }
    /**
     * 执行进化计划
     */
    async executePlan(plan, _checkpointId) {
        const startTime = Date.now();
        const result = {
            planId: plan.id,
            success: true,
            executedActions: 0,
            duration: 0,
        };
        Logger_1.Logger.info(`🔧 Executing evolution plan: ${plan.id} (${plan.type})`, 'SelfModificationEngine');
        try {
            for (let i = 0; i < plan.actions.length; i++) {
                const action = plan.actions[i];
                Logger_1.Logger.info(`  Executing action ${i + 1}/${plan.actions.length}: ${action.description}`, 'SelfModificationEngine');
                const success = await this.executeAction(action);
                if (!success) {
                    result.success = false;
                    result.failedAt = i;
                    result.error = `Action failed at ${i}: ${action.description}`;
                    Logger_1.Logger.error(`❌ Action failed: ${action.description}`, new Error('Action failed'), 'SelfModificationEngine');
                    break;
                }
                result.executedActions++;
            }
            result.duration = Date.now() - startTime;
            if (result.success) {
                Logger_1.Logger.info(`✅ Evolution plan executed successfully: ${plan.id}`, 'SelfModificationEngine');
            }
            else {
                Logger_1.Logger.info(`❌ Evolution plan failed: ${plan.id}`, 'SelfModificationEngine');
            }
        }
        catch (error) {
            result.success = false;
            result.error = error.message;
            result.duration = Date.now() - startTime;
            Logger_1.Logger.error('❌ Evolution plan execution error', error, 'SelfModificationEngine');
        }
        return result;
    }
    /**
     * 执行单个动作
     */
    async executeAction(action) {
        try {
            switch (action.type) {
                case 'MODIFY_FILE':
                    return this.modifyFile(action);
                case 'CREATE_FILE':
                    return this.createFile(action);
                case 'DELETE_FILE':
                    return this.deleteFile(action);
                case 'UPDATE_PROMPT':
                    return this.updatePrompt(action);
                case 'UPDATE_CONFIG':
                    return this.updateConfig(action);
                default:
                    Logger_1.Logger.warn(`Unknown action type: ${action.type}`, 'SelfModificationEngine');
                    return false;
            }
        }
        catch (error) {
            Logger_1.Logger.error(`Action execution failed`, error, 'SelfModificationEngine');
            return false;
        }
    }
    /**
     * 修改文件
     */
    modifyFile(action) {
        const target = action.target;
        const filePath = typeof target === 'string' ? target : target.filePath;
        if (!fs.existsSync(filePath)) {
            Logger_1.Logger.error(`File not found for modification: ${filePath}`, new Error('File not found'), 'SelfModificationEngine');
            return false;
        }
        // 保存原内容（如果没提供）
        if (!action.originalContent) {
            action.originalContent = fs.readFileSync(filePath, 'utf-8');
        }
        fs.writeFileSync(filePath, action.content, 'utf-8');
        Logger_1.Logger.debug(`File modified: ${filePath}`, 'SelfModificationEngine');
        return true;
    }
    /**
     * 创建文件
     */
    createFile(action) {
        const filePath = typeof action.target === 'string'
            ? action.target
            : action.target.filePath;
        // 确保目录存在
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, action.content, 'utf-8');
        Logger_1.Logger.debug(`File created: ${filePath}`, 'SelfModificationEngine');
        return true;
    }
    /**
     * 删除文件
     */
    deleteFile(action) {
        const filePath = typeof action.target === 'string'
            ? action.target
            : action.target.filePath;
        if (fs.existsSync(filePath)) {
            // 保存原内容（如果没提供）
            if (!action.originalContent) {
                action.originalContent = fs.readFileSync(filePath, 'utf-8');
            }
            fs.unlinkSync(filePath);
            Logger_1.Logger.debug(`File deleted: ${filePath}`, 'SelfModificationEngine');
        }
        return true;
    }
    /**
     * 更新 prompt
     */
    updatePrompt(action) {
        const promptPath = typeof action.target === 'string'
            ? action.target
            : action.target.filePath;
        if (!promptPath) {
            Logger_1.Logger.error('No prompt path specified', new Error('No prompt path'), 'SelfModificationEngine');
            return false;
        }
        const dir = path.dirname(promptPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(promptPath, action.content, 'utf-8');
        Logger_1.Logger.debug(`Prompt updated: ${promptPath}`, 'SelfModificationEngine');
        return true;
    }
    /**
     * 更新配置
     */
    updateConfig(action) {
        return this.modifyFile(action);
    }
    /**
     * 学习安全结果 — 记录动作的安全执行结果
     */
    learnSafetyOutcome(action, success) {
        const targetPath = typeof action.target === 'string'
            ? action.target
            : action.target?.filePath || '';
        if (!targetPath) {
            return;
        }
        let boundary = this.safetyBoundaries.get(targetPath);
        if (!boundary) {
            boundary = {
                path: targetPath,
                riskLevel: 'safe',
                violationCount: 0,
                successCount: 0,
            };
            this.safetyBoundaries.set(targetPath, boundary);
            if (this.safetyBoundaries.size > this.MAX_SAFETY_BOUNDARIES) {
                const oldestKey = this.safetyBoundaries.keys().next().value;
                this.safetyBoundaries.delete(oldestKey);
            }
        }
        if (success) {
            boundary.successCount++;
            // 成功次数达到阈值 → 降级到 safe 并重置违规计数
            if (boundary.successCount >= DE_ESCALATION_SUCCESS_THRESHOLD) {
                boundary.riskLevel = 'safe';
                boundary.violationCount = 0;
            }
        }
        else {
            boundary.violationCount++;
            // 违规次数达到阈值后升级风险等级
            if (boundary.violationCount >= ESCALATION_VIOLATION_THRESHOLD) {
                boundary.riskLevel = 'cautious';
            }
        }
    }
    /**
     * 记录策略结果 — 用于资源预加载预测
     */
    recordStrategyOutcome(outcome) {
        this.strategyOutcomes.push(outcome);
        // 保留最近 100 条记录
        if (this.strategyOutcomes.length > 100) {
            this.strategyOutcomes.shift();
        }
    }
    /**
     * 获取资源预加载提示 — 基于策略历史预测可能需要的资源
     */
    getResourcePreloadHints() {
        if (this.strategyOutcomes.length < 3) {
            return [];
        }
        // 统计策略类型频率
        const strategyFrequency = new Map();
        for (const outcome of this.strategyOutcomes) {
            strategyFrequency.set(outcome.strategyType, (strategyFrequency.get(outcome.strategyType) || 0) + 1);
        }
        const total = this.strategyOutcomes.length;
        const hints = [];
        for (const [strategyType, count] of strategyFrequency) {
            const probability = count / total;
            if (probability > 0.1) {
                hints.push({
                    resourceType: strategyType,
                    probability,
                    preloadAction: `preload_${strategyType.toLowerCase()}_resources`,
                });
            }
        }
        return hints.sort((a, b) => b.probability - a.probability);
    }
    /**
     * 评估动作安全性
     */
    assessActionSafety(action) {
        const targetPath = typeof action.target === 'string'
            ? action.target
            : action.target?.filePath || '';
        // 检查是否在禁止路径中
        for (const forbidden of this.forbiddenPaths) {
            if (targetPath.includes(forbidden)) {
                return {
                    riskLevel: 'forbidden',
                    allowed: false,
                    requiresConfirmation: false,
                    reason: `路径 "${targetPath}" 在禁止列表中`,
                };
            }
        }
        // 检查是否为禁止删除的入口文件
        if (action.type === 'DELETE_FILE') {
            for (const forbidden of this.forbiddenDeletePaths) {
                if (targetPath === forbidden || targetPath.endsWith(forbidden)) {
                    return {
                        riskLevel: 'forbidden',
                        allowed: false,
                        requiresConfirmation: false,
                        reason: `禁止删除入口文件: ${targetPath}`,
                    };
                }
            }
        }
        // 检查是否为需要确认的核心路径（修改操作）
        if (action.type === 'MODIFY_FILE') {
            for (const cautious of this.cautiousModifyPaths) {
                if (targetPath.includes(cautious)) {
                    return {
                        riskLevel: 'cautious',
                        allowed: true,
                        requiresConfirmation: true,
                        reason: `修改核心路径需要确认: ${targetPath}`,
                    };
                }
            }
        }
        // 检查安全边界记录
        const boundary = this.safetyBoundaries.get(targetPath);
        if (boundary) {
            return {
                riskLevel: boundary.riskLevel,
                allowed: boundary.riskLevel !== 'forbidden',
                requiresConfirmation: boundary.riskLevel === 'cautious' ||
                    boundary.riskLevel === 'restricted',
                boundary,
                reason: `历史记录: 成功 ${boundary.successCount} 次, 违规 ${boundary.violationCount} 次`,
            };
        }
        // 默认为 safe
        return {
            riskLevel: 'safe',
            allowed: true,
            requiresConfirmation: false,
            reason: '无历史记录，默认安全',
        };
    }
    /**
     * 获取安全报告
     */
    getSafetyReport() {
        const forbiddenPaths = [];
        const restrictedPaths = [];
        const cautiousPaths = [];
        const safePaths = [];
        // 添加禁止路径
        for (const p of this.forbiddenPaths) {
            forbiddenPaths.push(p);
        }
        // 添加禁止删除的入口文件
        for (const p of this.forbiddenDeletePaths) {
            forbiddenPaths.push(p);
        }
        // 按风险等级分类
        for (const [, boundary] of this.safetyBoundaries) {
            switch (boundary.riskLevel) {
                case 'forbidden':
                    forbiddenPaths.push(boundary.path);
                    break;
                case 'restricted':
                    restrictedPaths.push(boundary.path);
                    break;
                case 'cautious':
                    cautiousPaths.push(boundary.path);
                    break;
                case 'safe':
                    safePaths.push(boundary.path);
                    break;
            }
        }
        return {
            totalBoundaries: this.safetyBoundaries.size + this.forbiddenPaths.size,
            forbiddenPaths,
            restrictedPaths,
            cautiousPaths,
            safePaths,
        };
    }
}
exports.SelfModificationEngine = SelfModificationEngine;
exports.default = SelfModificationEngine;
