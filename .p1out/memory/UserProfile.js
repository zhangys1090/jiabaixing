"use strict";
/**
 * 用户画像系统 v2 - 精简版
 * 构建用户的基础信息、开发习惯、生活偏好、情绪模式、任务偏好五大维度画像
 * 优化：批量异步处理 + 防抖保存 + 关键词索引缓存
 */
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
exports.UserProfile = void 0;
const path = __importStar(require("path"));
const interfaces_1 = require("../interfaces");
const FileSystem_1 = require("../io/FileSystem");
const Logger_1 = require("../utils/Logger");
const fileSystem = FileSystem_1.FileSystem.getInstance();
// 预编译的关键词索引 - 已精简
const _FOOD_KEYWORDS = new Set([
    '火锅',
    '烧烤',
    '日料',
    '西餐',
    '中餐',
    '咖啡',
    '奶茶',
    '甜品',
    '素食',
    '辣',
    '清淡',
    '外卖',
    '做饭',
    '烹饪',
]);
const _EXERCISE_KEYWORDS = new Set([
    '跑步',
    '游泳',
    '健身',
    '瑜伽',
    '篮球',
    '足球',
    '骑行',
    '散步',
    '爬山',
    '网球',
    '羽毛球',
    '运动',
]);
const _ENTERTAINMENT_KEYWORDS = new Set([
    '电影',
    '音乐',
    '游戏',
    '看书',
    '阅读',
    '追剧',
    '综艺',
    '动漫',
    '摄影',
    '画画',
    '旅行',
    '冥想',
]);
const _LANGUAGE_KEYWORDS = new Set([
    'javascript',
    'typescript',
    'python',
    'java',
    'go',
    'c++',
    'c#',
    'rust',
    'php',
    'ruby',
    'swift',
    'kotlin',
]);
const _FRAMEWORK_KEYWORDS = new Set([
    'react',
    'angular',
    'vue',
    'node.js',
    'express',
    'django',
    'spring',
    'flask',
    'laravel',
    'symfony',
    'asp.net',
    'next.js',
    'nuxt.js',
    'svelte',
]);
const _PROJECT_STRUCTURE_KEYWORDS = new Set([
    'src',
    'components',
    'utils',
    'api',
    'views',
    'pages',
    'services',
    'models',
    'controllers',
    'routes',
    'middlewares',
    'config',
    'assets',
]);
const _TOOL_KEYWORDS = new Set([
    'vscode',
    'intellij',
    'sublime',
    'vim',
    'emacs',
    'git',
    'docker',
    'npm',
    'yarn',
    'pip',
    'maven',
    'gradle',
]);
const CODE_ORGANIZATION_MAP = {
    modular: 'modular',
    functional: 'functional',
    'object-oriented': 'object-oriented',
    'component-based': 'component-based',
    'service-oriented': 'service-oriented',
};
const TESTING_APPROACH_MAP = {
    'unit-testing': 'unit-testing',
    'integration-testing': 'integration-testing',
    'end-to-end-testing': 'end-to-end-testing',
    tdd: 'tdd',
    bdd: 'bdd',
};
const DOCUMENTATION_STYLE_MAP = {
    jsdoc: 'jsdoc',
    tsdoc: 'tsdoc',
    docstring: 'docstring',
    markdown: 'markdown',
    swagger: 'swagger',
};
const VERSION_CONTROL_MAP = {
    git: 'git',
    svn: 'svn',
    mercurial: 'mercurial',
};
const DEPLOYMENT_MAP = {
    continuous: 'continuous',
    manual: 'manual',
    'ci/cd': 'ci/cd',
    docker: 'docker',
    kubernetes: 'kubernetes',
};
const PERFORMANCE_MAP = {
    profiling: 'profiling',
    caching: 'caching',
    optimization: 'optimization',
    benchmarking: 'benchmarking',
};
const SECURITY_MAP = {
    owasp: 'owasp',
    security: 'security',
    encryption: 'encryption',
    authentication: 'authentication',
};
const CODE_REVIEW_MAP = {
    'pull-request': 'pull-request',
    'code-review': 'code-review',
    'peer-review': 'peer-review',
};
/**
 * 用户画像类 v2
 * 优化：防抖保存 + 批量处理 + 关键词索引缓存
 */
class UserProfile {
    constructor() {
        this.saveTimer = null;
        this.SAVE_DEBOUNCE_MS = 5000; // 5秒防抖
        this.pendingUpdates = 0;
        // 初始化默认值
        this.basicInfo = {
            userId: `user_${Date.now()}`,
            name: '',
            language: 'zh-CN',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.developmentHabits = {
            preferredLanguages: [],
            preferredFrameworks: [],
            codingStyle: {},
            commonTools: [],
            workingHours: { start: 9, end: 18 },
            debuggingApproach: 'systematic',
            projectStructure: ['src', 'components', 'utils', 'api', 'views'],
            codeOrganization: 'modular',
            testingApproach: 'unit-testing',
            documentationStyle: 'jsdoc',
            versionControl: 'git',
            deploymentProcess: 'continuous',
            codeReviewProcess: 'pull-request',
            performanceOptimization: 'profiling',
            securityPractices: 'owasp',
        };
        this.lifePreferences = {
            dietaryPreferences: [],
            exerciseHabits: [],
            sleepSchedule: { bedtime: 23, wakeup: 7 },
            entertainmentPreferences: [],
            travelPreferences: {},
            shoppingPreferences: {},
        };
        this.emotionalPatterns = {
            commonEmotions: [],
            triggerEvents: [],
            comfortStrategies: [],
            stressThreshold: 7,
            emotionalResilience: 6,
        };
        this.taskPreferences = {
            priorityOrder: [
                'urgent-important',
                'important-not-urgent',
                'urgent-not-important',
                'not-urgent-not-important',
            ],
            preferredWorkStyle: 'focused',
            deadlineApproach: 'early',
            collaborationPreference: 'independent',
            taskComplexityPreference: 'balanced',
        };
    }
    getProfilePath() {
        return path.join(process.cwd(), 'data', 'user_profile.json');
    }
    /**
     * 加载用户画像
     */
    async load() {
        try {
            const profilePath = this.getProfilePath();
            const exists = await fileSystem.exists(profilePath);
            if (exists) {
                const data = await fileSystem.readJson(profilePath);
                if (data.basicInfo)
                    this.basicInfo = { ...this.basicInfo, ...data.basicInfo };
                if (data.developmentHabits)
                    this.developmentHabits = {
                        ...this.developmentHabits,
                        ...data.developmentHabits,
                    };
                if (data.lifePreferences)
                    this.lifePreferences = {
                        ...this.lifePreferences,
                        ...data.lifePreferences,
                    };
                if (data.emotionalPatterns)
                    this.emotionalPatterns = {
                        ...this.emotionalPatterns,
                        ...data.emotionalPatterns,
                    };
                if (data.taskPreferences)
                    this.taskPreferences = {
                        ...this.taskPreferences,
                        ...data.taskPreferences,
                    };
                Logger_1.Logger.info(`👤 用户画像已加载: 名字=${this.basicInfo.name || '未设置'}`, 'UserProfile');
            }
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 加载用户画像失败: ${err?.message}，使用默认值`, 'UserProfile');
        }
    }
    /**
     * 立即保存用户画像（内部使用）
     */
    async doSave() {
        try {
            const profilePath = this.getProfilePath();
            const data = {
                basicInfo: this.basicInfo,
                developmentHabits: this.developmentHabits,
                lifePreferences: this.lifePreferences,
                emotionalPatterns: this.emotionalPatterns,
                taskPreferences: this.taskPreferences,
            };
            await fileSystem.writeJson(profilePath, data);
            this.pendingUpdates = 0;
            Logger_1.Logger.debug(`💾 用户画像已保存: 名字=${this.basicInfo.name || '未设置'}`, 'UserProfile');
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 保存用户画像失败: ${err?.message}`, 'UserProfile');
        }
    }
    /**
     * 防抖保存用户画像
     */
    async save() {
        this.pendingUpdates++;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            void this.doSave();
            this.saveTimer = null;
        }, this.SAVE_DEBOUNCE_MS);
        if (this.saveTimer.unref)
            this.saveTimer.unref();
    }
    /**
     * 更新用户画像
     */
    async update(data) {
        this.basicInfo.updatedAt = new Date();
        let needsSave = false;
        if (data.input) {
            const previousName = this.basicInfo.name;
            this.extractUserName(data.input);
            if (this.basicInfo.name && this.basicInfo.name !== previousName) {
                Logger_1.Logger.info(`👤 提取到用户名字: ${this.basicInfo.name}`, 'UserProfile');
                needsSave = true;
            }
        }
        if (data.emotion) {
            this.updateEmotionalPatterns(data.emotion, data.timestamp);
            needsSave = true;
        }
        if (data.input) {
            this.updateTaskPreferences(data.input);
            this.updateLifePreferences(data.input);
            needsSave = true;
        }
        if (data.scene) {
            this.updateScenePreferences(data.scene);
            needsSave = true;
        }
        if (needsSave) {
            await this.save();
        }
    }
    /**
     * 从输入中提取用户名字
     */
    extractUserName(input) {
        // 匹配"我叫XXX"、"我的名字是XXX"、"我是XXX"等模式
        // 排除疑问句（如"我叫什么名字"）
        const namePatterns = [
            /我叫([\u4e00-\u9fa5a-zA-Z]{1,10})(?=[，。！\s]|$)/,
            /我的名字是([\u4e00-\u9fa5a-zA-Z]{1,10})(?=[，。！\s]|$)/,
            /我是([\u4e00-\u9fa5a-zA-Z]{1,10})(?=[，。！\s]|$)/,
        ];
        // 常见疑问词和过滤词
        const questionWords = [
            '什么',
            '谁',
            '哪',
            '怎么',
            '多少',
            '几',
            '吗',
            '呢',
            '吧',
        ];
        const nonNames = ['家百星', 'jiabaixing', 'AI', '人工智能', '助手', '我'];
        for (const pattern of namePatterns) {
            const match = input.match(pattern);
            if (match && match[1]) {
                const extractedName = match[1].trim();
                // 过滤疑问词和非名字词汇
                if (extractedName.length >= 1 &&
                    extractedName.length <= 10 &&
                    !nonNames.includes(extractedName) &&
                    !questionWords.some((q) => extractedName.includes(q))) {
                    this.basicInfo.name = extractedName;
                    break;
                }
            }
        }
    }
    /**
     * 更新情绪模式
     */
    updateEmotionalPatterns(emotion, timestamp) {
        const existingEmotion = this.emotionalPatterns.commonEmotions.find((e) => e.type === emotion.type);
        if (existingEmotion) {
            existingEmotion.frequency += 1;
        }
        else {
            this.emotionalPatterns.commonEmotions.push({
                type: emotion.type,
                frequency: 1,
            });
        }
        const hour = timestamp.getHours();
        const timeSlot = hour >= 6 && hour < 12
            ? '上午'
            : hour >= 12 && hour < 18
                ? '下午'
                : hour >= 18 && hour < 23
                    ? '晚上'
                    : '深夜';
        const existingTrigger = this.emotionalPatterns.triggerEvents.find((t) => t.emotionType === emotion.type && t.timeSlot === timeSlot);
        if (existingTrigger) {
            existingTrigger.frequency += 1;
        }
        else if (this.emotionalPatterns.triggerEvents.length < 20) {
            this.emotionalPatterns.triggerEvents.push({
                emotionType: emotion.type,
                timeSlot,
                frequency: 1,
            });
        }
        if (emotion.intensity >= 5) {
            const comfortStrategy = this.inferComfortStrategy(emotion.type);
            const existingStrategy = this.emotionalPatterns.comfortStrategies.find((s) => s.emotionType === emotion.type && s.strategy === comfortStrategy);
            if (existingStrategy) {
                existingStrategy.effectiveness = Math.min(1.0, existingStrategy.effectiveness + 0.05);
            }
            else if (this.emotionalPatterns.comfortStrategies.length < 15) {
                this.emotionalPatterns.comfortStrategies.push({
                    emotionType: emotion.type,
                    strategy: comfortStrategy,
                    effectiveness: 0.5,
                });
            }
        }
        if (emotion.intensity > this.emotionalPatterns.stressThreshold) {
            this.emotionalPatterns.stressThreshold = Math.max(1, this.emotionalPatterns.stressThreshold - 0.5);
            this.emotionalPatterns.emotionalResilience = Math.max(1, this.emotionalPatterns.emotionalResilience - 0.3);
        }
        else if (emotion.intensity <
            this.emotionalPatterns.stressThreshold * 0.5) {
            this.emotionalPatterns.stressThreshold = Math.min(10, this.emotionalPatterns.stressThreshold + 0.2);
            this.emotionalPatterns.emotionalResilience = Math.min(10, this.emotionalPatterns.emotionalResilience + 0.1);
        }
    }
    inferComfortStrategy(emotionType) {
        const strategyMap = {
            焦虑: '理性分析+行动建议',
            悲伤: '情感陪伴+温暖安慰',
            烦躁: '倾听理解+情绪疏导',
            疲惫: '体贴关怀+休息建议',
            兴奋: '积极回应+分享喜悦',
            困惑: '耐心解释+逐步引导',
        };
        return strategyMap[emotionType] || '温和陪伴+倾听理解';
    }
    updateLifePreferences(input) {
        const lowerInput = input.toLowerCase();
        // 使用预编译的 Set 进行 O(1) 查找
        for (const food of _FOOD_KEYWORDS) {
            if (lowerInput.includes(food) &&
                !this.lifePreferences.dietaryPreferences.includes(food)) {
                this.lifePreferences.dietaryPreferences.push(food);
            }
        }
        for (const exercise of _EXERCISE_KEYWORDS) {
            if (lowerInput.includes(exercise) &&
                !this.lifePreferences.exerciseHabits.includes(exercise)) {
                this.lifePreferences.exerciseHabits.push(exercise);
            }
        }
        for (const ent of _ENTERTAINMENT_KEYWORDS) {
            if (lowerInput.includes(ent) &&
                !this.lifePreferences.entertainmentPreferences.includes(ent)) {
                this.lifePreferences.entertainmentPreferences.push(ent);
            }
        }
        const hour = new Date().getHours();
        if (hour >= 23 || hour < 5) {
            this.lifePreferences.sleepSchedule.bedtime = Math.min(this.lifePreferences.sleepSchedule.bedtime, hour >= 23 ? hour : hour + 24);
        }
        if (hour >= 5 && hour < 9) {
            this.lifePreferences.sleepSchedule.wakeup = Math.max(this.lifePreferences.sleepSchedule.wakeup, hour);
        }
    }
    /**
     * 更新任务偏好
     */
    updateTaskPreferences(input) {
        const lowerInput = input.toLowerCase();
        // 使用预编译的 Set 进行 O(1) 查找
        for (const lang of _LANGUAGE_KEYWORDS) {
            if (lowerInput.includes(lang) &&
                !this.developmentHabits.preferredLanguages.includes(lang)) {
                this.developmentHabits.preferredLanguages.push(lang);
            }
        }
        for (const framework of _FRAMEWORK_KEYWORDS) {
            if (lowerInput.includes(framework) &&
                !this.developmentHabits.preferredFrameworks.includes(framework)) {
                this.developmentHabits.preferredFrameworks.push(framework);
            }
        }
        for (const structure of _PROJECT_STRUCTURE_KEYWORDS) {
            if (lowerInput.includes(structure) &&
                !this.developmentHabits.projectStructure.includes(structure)) {
                this.developmentHabits.projectStructure.push(structure);
            }
        }
        for (const tool of _TOOL_KEYWORDS) {
            if (lowerInput.includes(tool) &&
                !this.developmentHabits.commonTools.includes(tool)) {
                this.developmentHabits.commonTools.push(tool);
            }
        }
        // 使用预编译的 Map 进行单值设置
        for (const [key, value] of Object.entries(CODE_ORGANIZATION_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.codeOrganization = value;
                break;
            }
        }
        for (const [key, value] of Object.entries(TESTING_APPROACH_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.testingApproach = value;
                break;
            }
        }
        for (const [key, value] of Object.entries(DOCUMENTATION_STYLE_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.documentationStyle = value;
                break;
            }
        }
        for (const [key, value] of Object.entries(VERSION_CONTROL_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.versionControl = value;
                break;
            }
        }
        for (const [key, value] of Object.entries(DEPLOYMENT_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.deploymentProcess = value;
                break;
            }
        }
        for (const [key, value] of Object.entries(CODE_REVIEW_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.codeReviewProcess = value;
                break;
            }
        }
        for (const [key, value] of Object.entries(PERFORMANCE_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.performanceOptimization = value;
                break;
            }
        }
        for (const [key, value] of Object.entries(SECURITY_MAP)) {
            if (lowerInput.includes(key)) {
                this.developmentHabits.securityPractices = value;
                break;
            }
        }
    }
    /**
     * 更新场景偏好
     */
    updateScenePreferences(scene) {
        // 简化实现：基于场景信息更新偏好
        // 实际实现应该进行更复杂的分析
        if (scene.type === 'development') {
            // 开发场景下，增加开发习惯的权重
            this.developmentHabits.workingHours = {
                start: Math.min(this.developmentHabits.workingHours.start, new Date().getHours()),
                end: Math.max(this.developmentHabits.workingHours.end, new Date().getHours()),
            };
        }
        else if (scene.type === interfaces_1.PersonaScene.LEISURE ||
            scene.type === interfaces_1.PersonaScene.IDLE) {
            // 休息场景下，记录休息时间
            const currentHour = new Date().getHours();
            this.lifePreferences.sleepSchedule = {
                bedtime: Math.min(this.lifePreferences.sleepSchedule.bedtime, currentHour),
                wakeup: Math.max(this.lifePreferences.sleepSchedule.wakeup, currentHour),
            };
        }
    }
    /**
     * 获取用户基础信息
     */
    getBasicInfo() {
        return { ...this.basicInfo };
    }
    /**
     * 获取开发习惯
     */
    getDevelopmentHabits() {
        return { ...this.developmentHabits };
    }
    /**
     * 获取生活偏好
     */
    getLifePreferences() {
        return { ...this.lifePreferences };
    }
    /**
     * 获取情绪模式
     */
    getEmotionalPatterns() {
        return { ...this.emotionalPatterns };
    }
    /**
     * 获取任务偏好
     */
    getTaskPreferences() {
        return { ...this.taskPreferences };
    }
    /**
     * 设置用户基础信息
     */
    setBasicInfo(info) {
        this.basicInfo = { ...this.basicInfo, ...info, updatedAt: new Date() };
    }
    /**
     * 设置开发习惯
     */
    setDevelopmentHabits(habits) {
        this.developmentHabits = { ...this.developmentHabits, ...habits };
        this.basicInfo.updatedAt = new Date();
    }
    /**
     * 设置生活偏好
     */
    setLifePreferences(preferences) {
        this.lifePreferences = { ...this.lifePreferences, ...preferences };
        this.basicInfo.updatedAt = new Date();
    }
    /**
     * 设置情绪模式
     */
    setEmotionalPatterns(patterns) {
        this.emotionalPatterns = { ...this.emotionalPatterns, ...patterns };
        this.basicInfo.updatedAt = new Date();
    }
    /**
     * 设置任务偏好
     */
    setTaskPreferences(preferences) {
        this.taskPreferences = { ...this.taskPreferences, ...preferences };
        this.basicInfo.updatedAt = new Date();
    }
    /**
     * P2增强：从进化数据同步到用户画像
     * 将 ProfileEvolutionManager 学到的偏好写回到 UserProfile
     */
    syncProfileFromEvolution(evolutionData) {
        let changed = false;
        if (evolutionData.communicationStyle &&
            evolutionData.communicationStyle.confidence > 0.5) {
            const styleToWorkStyle = {
                direct: 'focused',
                detailed: 'focused',
                casual: 'multi-tasking',
                formal: 'focused',
            };
            const workStyle = styleToWorkStyle[evolutionData.communicationStyle.style];
            if (workStyle && this.taskPreferences.preferredWorkStyle !== workStyle) {
                this.taskPreferences.preferredWorkStyle = workStyle;
                changed = true;
            }
        }
        if (evolutionData.toolPreferences &&
            evolutionData.toolPreferences.length > 0) {
            const topTools = evolutionData.toolPreferences
                .filter((t) => t.successRate > 0.7)
                .slice(0, 5)
                .map((t) => t.toolName);
            if (topTools.length > 0) {
                const newTools = topTools.filter((t) => !this.developmentHabits.commonTools.includes(t));
                if (newTools.length > 0) {
                    this.developmentHabits.commonTools = [
                        ...this.developmentHabits.commonTools,
                        ...newTools,
                    ];
                    changed = true;
                }
            }
        }
        if (changed) {
            this.basicInfo.updatedAt = new Date();
        }
        return changed;
    }
    /**
     * 获取用户画像的完整表示
     */
    toJSON() {
        return {
            basicInfo: this.basicInfo,
            developmentHabits: this.developmentHabits,
            lifePreferences: this.lifePreferences,
            emotionalPatterns: this.emotionalPatterns,
            taskPreferences: this.taskPreferences,
        };
    }
    /**
     * 打印用户画像信息（用于调试）
     */
    print() {
        Logger_1.Logger.info('\n👤 用户画像信息', 'UserProfile');
        Logger_1.Logger.info('=====================================', 'UserProfile');
        Logger_1.Logger.info(`基础信息: ${JSON.stringify(this.basicInfo, null, 2)}`, 'UserProfile');
        Logger_1.Logger.info(`开发习惯: ${JSON.stringify(this.developmentHabits, null, 2)}`, 'UserProfile');
        Logger_1.Logger.info(`生活偏好: ${JSON.stringify(this.lifePreferences, null, 2)}`, 'UserProfile');
        Logger_1.Logger.info(`情绪模式: ${JSON.stringify(this.emotionalPatterns, null, 2)}`, 'UserProfile');
        Logger_1.Logger.info(`任务偏好: ${JSON.stringify(this.taskPreferences, null, 2)}`, 'UserProfile');
        Logger_1.Logger.info('=====================================', 'UserProfile');
    }
    /**
     * 从情绪反馈中学习 — 调整安慰策略的有效性
     */
    learnFromEmotionFeedback(emotion, strategy, effective) {
        const existing = this.emotionalPatterns.comfortStrategies.find((s) => s.emotionType === emotion.type && s.strategy === strategy);
        if (existing) {
            // 调整有效性：有效则提升，无效则降低
            const delta = effective ? 0.1 : -0.1;
            existing.effectiveness = Math.max(0, Math.min(1, existing.effectiveness + delta));
        }
        this.basicInfo.updatedAt = new Date();
    }
    /**
     * 获取指定情绪的最佳安慰策略
     */
    getBestComfortStrategy(emotionType) {
        const strategies = this.emotionalPatterns.comfortStrategies
            .filter((s) => s.emotionType === emotionType)
            .sort((a, b) => b.effectiveness - a.effectiveness);
        if (strategies.length === 0) {
            // 无匹配策略时返回默认值
            return '通用安慰策略';
        }
        return strategies[0].strategy;
    }
}
exports.UserProfile = UserProfile;
