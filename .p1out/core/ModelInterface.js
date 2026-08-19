"use strict";
/**
 * 统一模型接口定义
 * 全系统唯一的模型接口标准定义
 * 整合了原有的 core 和 models 两套接口
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelFactory = exports.AbstractModel = void 0;
const OpenAICompatibleModel_1 = require("../models/OpenAICompatibleModel");
const PythonBackedModel_1 = require("../models/PythonBackedModel");
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const Logger_1 = require("../utils/Logger");
/**
 * 模型抽象基类（提供通用功能实现）
 */
class AbstractModel {
    constructor(modelName, authConfig = { type: 'none' }) {
        this.modelName = modelName;
        this.authConfig = authConfig;
        this.performanceMetrics = {
            responseTimes: [],
            requestCount: 0,
            errorCount: 0,
        };
    }
    async generate(input) {
        const startTime = Date.now();
        this.performanceMetrics.requestCount++;
        try {
            const output = await this._generate(input);
            const endTime = Date.now();
            const responseTime = (endTime - startTime) / 1000;
            this.performanceMetrics.responseTimes.push(responseTime);
            if (this.performanceMetrics.responseTimes.length > 100) {
                this.performanceMetrics.responseTimes.shift();
            }
            return output;
        }
        catch (error) {
            this.performanceMetrics.errorCount++;
            Logger_1.Logger.error(`模型生成失败: ${error}`);
            throw error;
        }
    }
    getName() {
        return this.modelName;
    }
    getPerformanceMetrics() {
        const avgResponseTime = this.performanceMetrics.responseTimes.length > 0
            ? this.performanceMetrics.responseTimes.reduce((sum, time) => sum + time, 0) / this.performanceMetrics.responseTimes.length
            : 0;
        const successRate = this.performanceMetrics.requestCount > 0
            ? (this.performanceMetrics.requestCount -
                this.performanceMetrics.errorCount) /
                this.performanceMetrics.requestCount
            : 0;
        return {
            averageResponseTime: avgResponseTime,
            requestCount: this.performanceMetrics.requestCount,
            errorCount: this.performanceMetrics.errorCount,
            successRate,
        };
    }
    getModelName() {
        return this.modelName;
    }
}
exports.AbstractModel = AbstractModel;
/**
 * 模型工厂类
 */
class ModelFactory {
    static createModel(modelType, config) {
        switch (modelType) {
            case 'openai':
            case 'openai_compatible': {
                // P2-3 C: AGENT_BACKEND=python 模式下桥壳化 — 经 PythonAgentBridge 委派，
                // 不再实例化 TS 本地 LLM 客户端（OpenAICompatibleModel）。
                if ((0, bridgeRegistry_1.getActivePythonBridge)()) {
                    return new PythonBackedModel_1.PythonBackedModel(config.modelName);
                }
                return new OpenAICompatibleModel_1.OpenAICompatibleModel(config);
            }
            default:
                throw new Error(`未知模型类型: ${modelType}`);
        }
    }
}
exports.ModelFactory = ModelFactory;
/**
 * 模型管理器实现已迁移至 src/models/ModelManager.ts
 * 此处仅保留接口和抽象类定义
 */
