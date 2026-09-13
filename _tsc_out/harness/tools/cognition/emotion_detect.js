"use strict";
/**
 * Harness Tool: emotion_detect - 分析用户情绪
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMOTION_DETECT_DEF = void 0;
exports.createEmotionDetectExecutor = createEmotionDetectExecutor;
const types_1 = require("../../types");
exports.EMOTION_DETECT_DEF = {
    name: 'emotion_detect',
    description: '分析用户当前情绪状态。适用场景：用户语气激动、沮丧、焦虑、或你感觉用户情绪有变化时。不适用：正常平静的对话。（轻量规则模式：基于注入规则的本地情绪识别，非真实 LLM 情感分析）',
    category: types_1.ToolCategory.COGNITION,
    parameters: {
        text: {
            type: 'string',
            description: '要分析的用户原文',
        },
    },
    requiredParams: ['text'],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
};
/** 创建 emotion_detect 执行器 */
function createEmotionDetectExecutor(deps) {
    return async (params, _context) => {
        const text = String(params.text || '');
        // F2 诚实降级：缺依赖不再崩溃/假成功，显式失败并标注轻量规则模式
        if (!deps || typeof deps.detectEmotionFromInput !== 'function') {
            return {
                success: false,
                output: '',
                error: 'emotion_detect 不可用：未注入 detectEmotionFromInput 实现（轻量规则模式需依赖注入）。',
                duration: 0,
                validated: false,
                metadata: { mode: 'lightweight-rule', missingDep: true },
            };
        }
        try {
            const emotion = deps.detectEmotionFromInput(text);
            const output = {
                type: emotion.type,
                intensity: emotion.intensity,
                timestamp: new Date().toISOString(),
            };
            if (emotion.dominant)
                output.dominant = emotion.dominant;
            if (emotion.confidence != null)
                output.confidence = emotion.confidence;
            return {
                success: true,
                output: JSON.stringify(output),
                duration: 0,
                validated: false,
                metadata: { mode: 'lightweight-rule' },
            };
        }
        catch (err) {
            return {
                success: false,
                output: '',
                error: `emotion_detect 规则执行失败: ${err.message}`,
                duration: 0,
                validated: false,
                metadata: { mode: 'lightweight-rule' },
            };
        }
    };
}
