"use strict";
/**
 * MemoryEngineBridge — 记忆引擎 TS↔Python 桥接实现
 *
 * 依据 AGENTS.md §0.1：记忆系统（短期/长期）核心逻辑必须以 Python 端为主实现。
 * 本类不实现任何记忆核心逻辑，仅作为 TS 侧桥接契约（实现 IMemoryEngine），
 * 将每个方法经 bridgeRegistry 代理到 Python FastAPI(:3112) 的 /v1/memory/* 端点。
 *
 * AGENT_BACKEND=python（默认）时全部走 Python；Python 不可用时按最小可用降级。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryEngineBridge = exports.MemoryTier = exports.MemoryType = void 0;
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const Logger_1 = __importDefault(require("../utils/Logger"));
const UserProfile_1 = require("./UserProfile");
// 复用既有类型/枚举，保持下游 import 不变
var MemoryType;
(function (MemoryType) {
    MemoryType["INSTANT"] = "instant";
    MemoryType["SHORT_TERM"] = "short_term";
    MemoryType["LONG_TERM"] = "long_term";
})(MemoryType || (exports.MemoryType = MemoryType = {}));
var MemoryTier;
(function (MemoryTier) {
    MemoryTier["HOT"] = "hot";
    MemoryTier["WARM"] = "warm";
    MemoryTier["COLD"] = "cold";
})(MemoryTier || (exports.MemoryTier = MemoryTier = {}));
/**
 * 记忆引擎桥接实现。所有方法委托 Python；本地仅做最小降级（返回空结果 / no-op），不实现核心逻辑。
 */
class MemoryEngineBridge {
    constructor() {
        /** 本地用户画像存根（Python 持有真实数据；生产仅经 getUserProfile 暴露本地视图，与旧 MemoryEngine 行为一致） */
        this.userProfile = new UserProfile_1.UserProfile();
    }
    // ==================== 存储 ====================
    async storeShortTermMemory(content, scene, emotion) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
        if (bridge) {
            const id = await bridge.memoryStoreShortTerm(contentStr, scene, emotion);
            return {
                id,
                type: MemoryType.SHORT_TERM,
                content,
                timestamp: new Date(),
                scene,
                emotion,
            };
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，storeShortTermMemory 降级为空', 'MemoryEngineBridge');
        return {
            id: '',
            type: MemoryType.SHORT_TERM,
            content,
            timestamp: new Date(),
            scene,
            emotion,
        };
    }
    async storeLongTermMemory(content, scene, emotion) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
        if (bridge) {
            const id = await bridge.memoryStoreLongTerm(contentStr, scene, emotion);
            return {
                id,
                type: MemoryType.LONG_TERM,
                content,
                timestamp: new Date(),
                scene,
                emotion,
            };
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，storeLongTermMemory 降级为空', 'MemoryEngineBridge');
        return {
            id: '',
            type: MemoryType.LONG_TERM,
            content,
            timestamp: new Date(),
            scene,
            emotion,
        };
    }
    async storeInstantMemory(content, scene, emotion) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
        if (bridge) {
            const id = await bridge.memoryStoreInstant(contentStr, scene, emotion);
            return {
                id,
                type: MemoryType.INSTANT,
                content,
                timestamp: new Date(),
                scene,
                emotion,
            };
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，storeInstantMemory 降级为空', 'MemoryEngineBridge');
        return {
            id: '',
            type: MemoryType.INSTANT,
            content,
            timestamp: new Date(),
            scene,
            emotion,
        };
    }
    async storeFeedbackSignal(data) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            // bridge.memoryStoreFeedback 要求 feedbackType 为字面量联合类型，调用处放宽后在此收窄
            await bridge.memoryStoreFeedback(data);
            return;
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，storeFeedbackSignal 降级丢弃', 'MemoryEngineBridge');
    }
    // ==================== 检索 ====================
    async preciseHybridRetrieval(query, scene, emotion, topK = 10) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            const results = await bridge.memoryHybridRetrieval(query, scene, emotion, topK);
            return results.map((r) => ({
                id: r.id,
                type: r.type || MemoryType.SHORT_TERM,
                content: r.content,
                timestamp: new Date(r.timestamp || Date.now()),
                scene: r.scene,
                emotion: r.emotion,
                relevanceScore: r.relevanceScore,
            }));
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，preciseHybridRetrieval 降级为空', 'MemoryEngineBridge');
        return [];
    }
    async retrieveRelevant(params) {
        // retrieveRelevant 是 preciseHybridRetrieval 的薄包装
        return this.preciseHybridRetrieval(params.query, undefined, undefined, params.limit || 10);
    }
    async retrieveContext(input, userId) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            try {
                const results = await bridge.memoryRetrieveContext(input, userId);
                return {
                    memories: results.map((r) => ({
                        type: r.type || '记忆',
                        relevance: r.relevanceScore || 0.5,
                        content: typeof r.content === 'string'
                            ? r.content
                            : JSON.stringify(r.content),
                    })),
                    preferences: { codingStyle: [], namingRules: [] },
                };
            }
            catch (err) {
                Logger_1.default.debug(`[MemoryEngineBridge] 加载记忆失败: ${err?.message}`, 'MemoryEngineBridge');
                return {
                    memories: [],
                    preferences: { codingStyle: [], namingRules: [] },
                };
            }
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，retrieveContext 降级为空', 'MemoryEngineBridge');
        return {
            memories: [],
            preferences: { codingStyle: [], namingRules: [] },
        };
    }
    // ==================== 用户配置 ====================
    /**
     * 返回本地 UserProfile 存根（与旧 MemoryEngine.getUserProfile 行为一致：
     * 本地视图，真实数据由 Python 端持有）。供 UnifiedContextPipeline /
     * ConstitutionPromptBuilder 等同步调用 getBasicInfo()/getDevelopmentHabits() 等。
     */
    getUserProfile() {
        // 本地 UserProfile 实例在运行时具备 MemoryEngineUserProfile 要求的全部方法
        // (getBasicInfo/getDevelopmentHabits/getLifePreferences/.../syncProfileFromEvolution)，
        // 但 syncProfileFromEvolution 形参类型（具体对象 vs unknown）与目标接口不严格等价，故此处收窄转换。
        return this.userProfile;
    }
    async getUserProfileSummary(userId) {
        const basic = this.userProfile.getBasicInfo();
        const dev = this.userProfile.getDevelopmentHabits();
        return {
            name: basic.name || undefined,
            preferredLanguage: undefined,
            preferredFrameworks: dev.preferredFrameworks,
            recentTopics: [],
        };
    }
    // ==================== 反馈 / 更新 ====================
    async queryRecentFeedback(hours = 24) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            return await bridge.memoryQueryRecentFeedback(hours);
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，queryRecentFeedback 降级为空', 'MemoryEngineBridge');
        return [];
    }
    async updateMemory(memoryId, updates) {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            await bridge.memoryUpdate(memoryId, updates);
            return;
        }
        Logger_1.default.warn('[MemoryEngineBridge] Python 不可用，updateMemory 降级丢弃', 'MemoryEngineBridge');
    }
    // ==================== 内部 / 可选方法 ====================
    /** 标记用户活跃（用于记忆"做梦"机制判断空闲状态）。Python 端自行管理活跃追踪，此处为 no-op。 */
    markUserActive() {
        // Python 端 manage activity tracking; 本地无需实现核心逻辑
    }
    /** Python 记忆引擎在 FastAPI 启动时已初始化，此处无需本地初始化。 */
    async initialize() {
        return;
    }
    isInitialized() {
        return (0, bridgeRegistry_1.getActivePythonBridge)() !== null;
    }
    // IMemoryEngine 可选成员 — 最小可用降级（Python 侧经 store/search 已覆盖语义）
    getEpisodicMemoryStats() {
        return {};
    }
    detectBehaviorPatterns() {
        return [];
    }
}
exports.MemoryEngineBridge = MemoryEngineBridge;
