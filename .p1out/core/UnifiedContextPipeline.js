"use strict";
/**
 * 统一上下文管道 v2 - 上下文系统主实现之一
 *
 * 【架构定位】
 * 上下文系统两大主实现之一：
 * 1. UnifiedContextPipeline（本文件）- 负责 AI 上下文构建（记忆、场景、情感、用户画像等）
 * 2. ConstitutionPromptBuilder - 负责系统 Prompt 构建（身份、人格、行为准则、工具清单等）
 *
 * 三重组合架构核心：数据主权 × 记忆深度 × 主动关怀的集成枢纽
 * 所有交互（主动/被动）都经过此管道构建上下文
 * 确保记忆深度被充分利用，同时数据访问经过主权审计
 *
 * 【核心职责】
 * - 场景检测与分类
 * - 情感分析与强度评估
 * - 时间上下文构建
 * - 记忆检索与智能筛选（通过 LLMContextBuilder）
 * - 用户画像构建
 * - 数据主权评分
 *
 * 【在整体架构中的位置】
 * 用户输入 → ContextReferenceResolver（@引用解析）→ UnifiedContextPipeline → ConstitutionPromptBuilder → 最终 Prompt
 *
 * v2 优化：
 * 1. 集成 LLMContextBuilder 进行智能记忆筛选
 * 2. 传递真实相关性分数（非固定 0.5）
 * 3. 场景感知记忆权重
 * 4. 记忆去重与压缩
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnifiedContextPipeline = void 0;
const LLMContextBuilder_1 = require("../memory/LLMContextBuilder");
const Logger_1 = require("../utils/Logger");
class UnifiedContextPipeline {
    constructor() {
        this.memoryEngine = null;
        this.sovereigntyPipeline = null;
        this.contextBuilder = new LLMContextBuilder_1.LLMContextBuilder({
            maxMemories: 8,
            minRelevance: 0.15,
            maxTotalLength: 2000,
            enableDeduplication: true,
            enableCompression: true,
        });
    }
    setMemoryEngine(engine) {
        this.memoryEngine = engine;
    }
    setSovereigntyPipeline(pipeline) {
        this.sovereigntyPipeline = pipeline;
    }
    async buildContext(input, userId) {
        const startTime = Date.now();
        const scene = this.detectScene(input);
        const emotion = this.detectEmotion(input);
        const timeContext = this.buildTimeContext();
        const memories = await this.retrieveMemories(input, scene, emotion.type);
        const userProfile = this.buildUserProfile(userId);
        const sovereigntyScore = this.getSovereigntyScore();
        const context = {
            scene,
            emotion,
            memories,
            userProfile,
            timeContext,
            sovereigntyScore,
        };
        this.auditContextAccess(input, context);
        const elapsed = Date.now() - startTime;
        Logger_1.Logger.info(`📊 统一上下文构建完成: 场景=${scene}, 情绪=${emotion.type}, 记忆=${memories.length}条, 耗时=${elapsed}ms`, 'UnifiedContextPipeline');
        return context;
    }
    async buildProactiveContext(triggerReason) {
        const startTime = Date.now();
        const timeContext = this.buildTimeContext();
        const scene = this.inferSceneFromTime(timeContext);
        const emotion = { type: '平静', intensity: 2 };
        const memories = await this.retrieveProactiveMemories(triggerReason, scene);
        const userProfile = this.buildUserProfile('default');
        const sovereigntyScore = this.getSovereigntyScore();
        const context = {
            scene,
            emotion,
            memories,
            userProfile,
            timeContext,
            sovereigntyScore,
        };
        this.auditContextAccess(`proactive:${triggerReason}`, context);
        const elapsed = Date.now() - startTime;
        Logger_1.Logger.info(`📊 主动上下文构建完成: 触发=${triggerReason}, 场景=${scene}, 记忆=${memories.length}条, 耗时=${elapsed}ms`, 'UnifiedContextPipeline');
        return context;
    }
    detectScene(input) {
        const patterns = [
            {
                type: 'development',
                keywords: ['代码', '编程', '开发', 'bug', '调试', '重构', '优化'],
            },
            {
                type: 'work',
                keywords: ['任务', '项目', '进度', '汇报', '会议', 'deadline'],
            },
            {
                type: 'comfort',
                keywords: ['难过', '累', '烦', '压力', '焦虑', '担心', '害怕'],
            },
            {
                type: 'greeting',
                keywords: ['你好', '早上好', '晚上好', '嗨', 'hello'],
            },
            {
                type: 'celebration',
                keywords: ['成功', '完成', '搞定', '太好了', '恭喜'],
            },
        ];
        const lower = input.toLowerCase();
        let bestScene = 'daily';
        let bestScore = 0;
        for (const pattern of patterns) {
            const matched = pattern.keywords.filter((k) => lower.includes(k)).length;
            const score = matched / pattern.keywords.length;
            if (score > bestScore) {
                bestScore = score;
                bestScene = pattern.type;
            }
        }
        return bestScene;
    }
    detectEmotion(input) {
        const emotionPatterns = [
            {
                type: '焦虑',
                keywords: ['焦虑', '担心', '害怕', '不安', '紧张'],
                intensity: 5,
            },
            {
                type: '悲伤',
                keywords: ['难过', '伤心', '悲伤', '哭', '失落'],
                intensity: 6,
            },
            {
                type: '烦躁',
                keywords: ['烦', '恼火', '生气', '愤怒', '受不了'],
                intensity: 5,
            },
            {
                type: '疲惫',
                keywords: ['累', '疲惫', '困', '没精神', '乏力'],
                intensity: 4,
            },
            {
                type: '兴奋',
                keywords: ['开心', '高兴', '兴奋', '太好了', '棒'],
                intensity: 5,
            },
        ];
        for (const pattern of emotionPatterns) {
            if (pattern.keywords.some((k) => input.includes(k))) {
                return { type: pattern.type, intensity: pattern.intensity };
            }
        }
        return { type: '平静', intensity: 2 };
    }
    buildTimeContext() {
        const now = new Date();
        const hour = now.getHours();
        const timeSlot = hour >= 6 && hour < 12
            ? '上午'
            : hour >= 12 && hour < 18
                ? '下午'
                : hour >= 18 && hour < 23
                    ? '晚上'
                    : '深夜';
        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return {
            hour,
            timeSlot,
            dayOfWeek: dayNames[now.getDay()],
        };
    }
    inferSceneFromTime(timeContext) {
        if (timeContext.timeSlot === '深夜')
            return 'comfort';
        if (timeContext.hour >= 7 && timeContext.hour < 10)
            return 'briefing';
        if (timeContext.hour >= 18 && timeContext.hour < 21)
            return 'daily';
        return 'daily';
    }
    /**
     * v2: 使用 LLMContextBuilder 进行智能记忆筛选
     */
    async retrieveMemories(input, scene, emotion) {
        if (!this.memoryEngine)
            return [];
        try {
            // 1. 检索原始记忆
            const items = await this.memoryEngine.preciseHybridRetrieval(input, scene, emotion, 20 // 检索更多，让 LLMContextBuilder 筛选
            );
            // 2. 使用 LLMContextBuilder 智能筛选
            const builtContext = this.contextBuilder.buildContext(input, items, scene, emotion);
            // 3. 转换为 UnifiedContext 格式
            return builtContext.memories.map((sm) => ({
                content: typeof sm.memory.content === 'string'
                    ? sm.memory.content
                    : JSON.stringify(sm.memory.content),
                relevance: Math.round(sm.compositeScore * 100) / 100,
                timestamp: sm.memory.timestamp?.toISOString() || new Date().toISOString(),
                type: sm.memory.type,
            }));
        }
        catch (error) {
            Logger_1.Logger.error('记忆检索失败', error, 'UnifiedContextPipeline');
            return [];
        }
    }
    /**
     * v2: 主动记忆检索也使用智能筛选
     */
    async retrieveProactiveMemories(triggerReason, scene) {
        if (!this.memoryEngine)
            return [];
        try {
            const queryMap = {
                morning_greeting: '今天 日程 待办',
                evening_checkin: '今天 完成 进展',
                late_night: '休息 睡眠 明天',
                long_silence: '最近 关注 话题',
                negative_emotion_trend: '情绪 最近 状态',
            };
            const query = queryMap[triggerReason] || '最近 关注';
            const items = await this.memoryEngine.preciseHybridRetrieval(query, scene, undefined, 15);
            // 使用 LLMContextBuilder 筛选
            const builtContext = this.contextBuilder.buildContext(query, items, scene, '平静');
            return builtContext.memories.map((sm) => ({
                content: typeof sm.memory.content === 'string'
                    ? sm.memory.content
                    : JSON.stringify(sm.memory.content),
                relevance: Math.round(sm.compositeScore * 100) / 100,
                timestamp: sm.memory.timestamp?.toISOString() || new Date().toISOString(),
                type: sm.memory.type,
            }));
        }
        catch (error) {
            Logger_1.Logger.error('主动记忆检索失败', error, 'UnifiedContextPipeline');
            return [];
        }
    }
    buildUserProfile(_userId) {
        if (!this.memoryEngine) {
            return {
                name: '',
                preferences: [],
                emotionalPatterns: [],
                recentTriggers: [],
            };
        }
        try {
            const profile = this.memoryEngine.getUserProfile();
            if (!profile) {
                return { name: '', preferences: [], emotionalPatterns: [], recentTriggers: [] };
            }
            const basicInfo = profile.getBasicInfo();
            const devHabits = profile.getDevelopmentHabits();
            const emotionalPatterns = profile.getEmotionalPatterns();
            const preferences = [
                ...(devHabits.preferredLanguages || []),
                ...(devHabits.preferredFrameworks || []),
            ];
            const patterns = (emotionalPatterns.commonEmotions || []).map((e) => ({
                type: e.type,
                frequency: e.frequency,
            }));
            const recentTriggers = (emotionalPatterns
                .triggerEvents || [])
                .slice(0, 5)
                .map((t) => `${t.emotionType}@${t.timeSlot}`);
            return {
                name: basicInfo.name || '',
                preferences,
                emotionalPatterns: patterns,
                recentTriggers,
            };
        }
        catch (error) {
            Logger_1.Logger.error('用户画像构建失败', error, 'UnifiedContextPipeline');
            return {
                name: '',
                preferences: [],
                emotionalPatterns: [],
                recentTriggers: [],
            };
        }
    }
    getSovereigntyScore() {
        if (!this.sovereigntyPipeline)
            return 100;
        try {
            const report = this.sovereigntyPipeline.generateReport();
            return report.sovereigntyScore;
        }
        catch {
            return 100;
        }
    }
    auditContextAccess(input, _context) {
        if (!this.sovereigntyPipeline)
            return;
        this.sovereigntyPipeline.recordAccess({
            timestamp: new Date().toISOString(),
            dataType: 'memory',
            operation: 'read',
            purpose: `构建交互上下文: ${input.substring(0, 50)}`,
            source: 'UnifiedContextPipeline',
            target: 'MemoryEngine+UserProfile',
            dataSize: input.length,
            isLocal: true,
        });
    }
}
exports.UnifiedContextPipeline = UnifiedContextPipeline;
