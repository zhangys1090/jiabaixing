"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelSelector = void 0;
const types_1 = require("./types");
class ModelSelector {
    static instance = null;
    roundRobinIndex = 0;
    constructor() { }
    static create() {
        return new ModelSelector();
    }
    static getInstance() {
        if (!ModelSelector.instance) {
            ModelSelector.instance = new ModelSelector();
        }
        return ModelSelector.instance;
    }
    static reset() {
        ModelSelector.instance = null;
    }
    route(availableModels, input, strategy) {
        if (availableModels.length === 0) {
            throw new Error('没有可用的模型');
        }
        let selectedModel;
        let reason;
        switch (strategy) {
            case types_1.RoutingStrategy.PRIORITY:
                selectedModel = this.routeByPriority(availableModels);
                reason = '优先级最高';
                break;
            case types_1.RoutingStrategy.CAPABILITY:
                selectedModel = this.routeByCapability(availableModels, input);
                reason = '能力最匹配';
                break;
            case types_1.RoutingStrategy.LATENCY:
                selectedModel = this.routeByLatency(availableModels);
                reason = '延迟最低';
                break;
            case types_1.RoutingStrategy.ROUND_ROBIN:
                selectedModel = this.routeByRoundRobin(availableModels);
                reason = '轮询';
                break;
            case types_1.RoutingStrategy.RANDOM:
                selectedModel = this.routeByRandom(availableModels);
                reason = '随机';
                break;
            default:
                selectedModel = this.routeByPriority(availableModels);
                reason = '默认优先级';
        }
        const fallbackChain = availableModels
            .filter((m) => m.id !== selectedModel.id)
            .sort((a, b) => a.priority - b.priority)
            .map((m) => m.id);
        return {
            modelId: selectedModel.id,
            modelName: selectedModel.name,
            reason,
            fallbackChain,
        };
    }
    routeByPriority(models) {
        return [...models].sort((a, b) => a.priority - b.priority)[0];
    }
    routeByCapability(models, input) {
        let bestModel = models[0];
        let bestScore = 0;
        for (const model of models) {
            let score = 0;
            if (input.images && input.images.length > 0) {
                score += model.capabilities.visionScore * 2;
            }
            if (input.prompt && this.isCodingPrompt(input.prompt)) {
                score += model.capabilities.codingScore * 2;
            }
            score += model.capabilities.reasoningScore;
            score += model.capabilities.speedScore;
            if (score > bestScore) {
                bestScore = score;
                bestModel = model;
            }
        }
        return bestModel;
    }
    routeByLatency(models) {
        return [...models].sort((a, b) => a.health.averageLatencyMs - b.health.averageLatencyMs)[0];
    }
    routeByRoundRobin(models) {
        const model = models[this.roundRobinIndex % models.length];
        this.roundRobinIndex++;
        return model;
    }
    routeByRandom(models) {
        return models[Math.floor(Math.random() * models.length)];
    }
    isCodingPrompt(prompt) {
        const codingKeywords = [
            'code',
            '编程',
            '程序',
            '函数',
            'class',
            'import',
            'def ',
            'const ',
            'let ',
            'var ',
            'function ',
            '代码',
            'bug',
            'debug',
            'error',
            'exception',
        ];
        return codingKeywords.some((keyword) => prompt.toLowerCase().includes(keyword.toLowerCase()));
    }
}
exports.ModelSelector = ModelSelector;
