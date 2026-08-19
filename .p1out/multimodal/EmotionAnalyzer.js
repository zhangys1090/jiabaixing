"use strict";
/**
 * 情绪分析器（向后兼容包装类）
 * 原模块 EmotionAnalysisService 已删除，本地实现
 * 保留原有接口以避免破坏现有代码
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmotionAnalyzer = void 0;
/** EmotionAnalysisService 存根（原模块已删除） */
class EmotionAnalysisService {
    constructor() {
        this.history = [];
    }
    async initialize() { }
    async analyze(_input) {
        return { type: 'neutral', intensity: 0.5, potentialNeeds: [] };
    }
    getEmotionHistory() {
        return this.history;
    }
    analyzeEmotionTrend() {
        return {
            dominantEmotion: 'neutral',
            trend: 'stable',
            averageIntensity: 0.5,
        };
    }
    cleanup() {
        this.history = [];
    }
}
class EmotionAnalyzer {
    constructor() {
        this.initialized = false;
        this.service = new EmotionAnalysisService();
    }
    async initialize() {
        await this.service.initialize();
        this.initialized = true;
    }
    async analyze(input) {
        this.ensureInitialized();
        return this.service.analyze(input);
    }
    getEmotionHistory() {
        return this.service.getEmotionHistory().map((h) => h.emotion);
    }
    clearEmotionHistory() {
        this.service.cleanup();
    }
    analyzeEmotionTrend() {
        return this.service.analyzeEmotionTrend();
    }
    async shutdown() {
        this.service.cleanup();
        this.initialized = false;
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('情绪分析器未初始化！请先调用initialize方法。');
        }
    }
}
exports.EmotionAnalyzer = EmotionAnalyzer;
