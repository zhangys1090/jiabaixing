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
    description: '分析用户当前情绪状态。适用场景：用户语气激动、沮丧、焦虑、或你感觉用户情绪有变化时。不适用：正常平静的对话。支持内置关键词分析和外部AI模型。',
    category: types_1.ToolCategory.COGNITION,
    parameters: {
        text: {
            type: 'string',
            description: '要分析的用户原文',
        },
        context: {
            type: 'string',
            description: '对话上下文（可选），帮助更准确判断情绪',
        },
    },
    requiredParams: ['text'],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
};

const EMOTION_KEYWORDS = {
    angry: {
        keywords: ['生气', '愤怒', '烦死了', '受不了', '气死', '可恶', '混蛋', '该死', 'wtf', 'damn', 'angry', 'furious', 'pissed', '恨'],
        intensity: 0.8,
    },
    frustrated: {
        keywords: ['郁闷', '烦', '无语', '崩溃', '头疼', '抓狂', '受不了', 'frustrated', 'annoyed', 'irritated', 'ugh'],
        intensity: 0.6,
    },
    sad: {
        keywords: ['难过', '伤心', '失望', '沮丧', '哭', '泪', '遗憾', '可惜', 'sad', 'disappointed', 'upset', 'depressed', 'unhappy'],
        intensity: 0.7,
    },
    anxious: {
        keywords: ['焦虑', '担心', '害怕', '紧张', '不安', '慌', '急', 'anxious', 'worried', 'nervous', 'scared', 'panic'],
        intensity: 0.6,
    },
    happy: {
        keywords: ['开心', '高兴', '棒', '太好了', '喜欢', '爱', '谢谢', '感谢', 'happy', 'great', 'awesome', 'love', 'wonderful', 'excellent', '😊', '😄', '🎉'],
        intensity: 0.7,
    },
    excited: {
        keywords: ['激动', '兴奋', '期待', '太棒了', '哇', '厉害', 'excited', 'thrilled', 'amazing', 'can\'t wait', '🤩', '🔥'],
        intensity: 0.8,
    },
    confused: {
        keywords: ['不懂', '不明白', '什么意思', '困惑', '迷茫', 'confused', 'what', 'huh', '??', '🤔'],
        intensity: 0.4,
    },
};

function detectEmotionFromKeywords(text) {
    const lowerText = text.toLowerCase();
    const scores = {};
    const matchedMap = {};
    for (const [emotion, config] of Object.entries(EMOTION_KEYWORDS)) {
        let score = 0;
        const matched = [];
        for (const keyword of config.keywords) {
            if (lowerText.includes(keyword.toLowerCase())) {
                score += config.intensity;
                matched.push(keyword);
            }
        }
        scores[emotion] = score;
        if (matched.length > 0) matchedMap[emotion] = matched;
    }
    const hasExclamation = (text.match(/！|!/g) || []).length >= 2;
    const hasCaps = /[A-Z]{3,}/.test(text);
    const boost = (hasExclamation || hasCaps) ? 0.2 : 0;
    let bestEmotion = 'neutral';
    let bestScore = 0;
    for (const [emotion, score] of Object.entries(scores)) {
        const adjusted = Math.min(1.0, score + boost);
        if (adjusted > bestScore) {
            bestScore = adjusted;
            bestEmotion = emotion;
        }
    }
    const secondaryEmotions = Object.entries(scores)
        .filter(([e, s]) => e !== bestEmotion && s > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([e]) => e);
    return {
        type: bestEmotion,
        intensity: Math.min(1.0, bestScore),
        confidence: bestScore > 0 ? Math.min(1.0, bestScore * 0.8 + 0.2) : 0.3,
        dominant: bestEmotion !== 'neutral' ? bestEmotion : undefined,
        matchedKeywords: matchedMap[bestEmotion] || undefined,
        secondaryEmotions: secondaryEmotions.length > 0 ? secondaryEmotions : undefined,
    };
}

/** 创建 emotion_detect 执行器 */
function createEmotionDetectExecutor(deps) {
    return async (params, _context) => {
        const text = String(params.text || '');
        if (!text.trim()) {
            return {
                success: false,
                output: '文本不能为空',
                duration: 0,
                validated: false,
            };
        }
        let emotion;
        if (deps.detectEmotionFromInput) {
            try {
                emotion = deps.detectEmotionFromInput(text);
            }
            catch {
                emotion = detectEmotionFromKeywords(text);
            }
        }
        else {
            emotion = detectEmotionFromKeywords(text);
        }
        const output = {
            type: emotion.type,
            intensity: emotion.intensity,
            timestamp: new Date().toISOString(),
        };
        if (emotion.dominant) output.dominant = emotion.dominant;
        if (emotion.confidence != null) output.confidence = emotion.confidence;
        if (emotion.matchedKeywords) output.matchedKeywords = emotion.matchedKeywords;
        if (emotion.secondaryEmotions) output.secondaryEmotions = emotion.secondaryEmotions;
        return {
            success: true,
            output: JSON.stringify(output),
            duration: 0,
            validated: false,
            metadata: { emotionType: emotion.type, intensity: emotion.intensity },
        };
    };
}
