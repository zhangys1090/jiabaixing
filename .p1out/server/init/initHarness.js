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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initHarness = initHarness;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const LLMCapabilityDetector_1 = require("../../evolution/LLMCapabilityDetector");
const harness_1 = require("../../harness");
const ContextReferenceResolver_1 = require("../../harness/context/ContextReferenceResolver");
const EvaluationPipeline_1 = require("../../harness/evaluation/EvaluationPipeline");
const IndependentEvaluationService_1 = require("../../harness/evaluation/IndependentEvaluationService");
const QualityScorer_1 = require("../../harness/evaluation/QualityScorer");
const StepEvaluator_1 = require("../../harness/evaluation/StepEvaluator");
const AutonomousTrigger_1 = require("../../harness/loop/AutonomousTrigger");
const bridgeRegistry_1 = require("../../ide/bridgeRegistry");
const TrajectoryFlywheel_1 = require("../../harness/persistence/TrajectoryFlywheel");
const BackendFactory_1 = require("../../harness/sandbox/backends/BackendFactory");
const memory_store_1 = require("../../harness/tools/memory/memory_store");
const MCPToolBridge_1 = require("../../harness/tools/registry/MCPToolBridge");
const OutputGuardrailEngine_1 = require("../../harness/verification/OutputGuardrailEngine");
const SpeechSynthesizer_1 = require("../../interaction/SpeechSynthesizer");
const UserProfile_1 = require("../../memory/UserProfile");
const SkillRegistry_1 = require("../../skills/SkillRegistry");
const Logger_1 = require("../../utils/Logger");
async function initHarness(core, memoryEngine, sceneRecognizer) {
    let harness = null;
    let speechSynthesizer = null;
    try {
        const llm = core.getLLM();
        const userProfile = new UserProfile_1.UserProfile();
        await userProfile.load();
        speechSynthesizer = new SpeechSynthesizer_1.SpeechSynthesizer();
        try {
            await speechSynthesizer.initialize();
            Logger_1.Logger.info('🔊 SpeechSynthesizer 初始化成功', 'Bootstrap');
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ SpeechSynthesizer 初始化失败: ${err.message}，TTS 工具将使用模拟模式`, 'Bootstrap');
        }
        // 多环境终端后端初始化（local/docker/ssh，配置驱动）
        let terminalBackend = null;
        try {
            const backendConfig = BackendFactory_1.BackendFactory.parseFromEnv();
            terminalBackend = await BackendFactory_1.BackendFactory.getBackend(backendConfig);
            const info = terminalBackend.getInfo();
            Logger_1.Logger.info(`🖥️ 终端后端已就绪: ${info.name} (隔离: ${info.isolation})`, 'Bootstrap');
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 终端后端初始化失败，降级为 local: ${err.message}`, 'Bootstrap');
        }
        const constitutionPromptBuilder = core.getConstitutionPromptBuilder();
        const conversationHistoryManager = core.getConversationHistoryManager();
        const harnessDeps = {
            llm: {
                chatWithTools: (messages, tools) => llm.chatWithTools(messages, tools),
                chat: (prompt, systemPrompt) => llm.chat(prompt, [], systemPrompt),
            },
            constitutionalBuilder: constitutionPromptBuilder,
            memoryInjector: {
                autoRetrieveMemories: async (input, _userId) => {
                    const results = await memoryEngine.preciseHybridRetrieval(input, undefined, undefined, 10);
                    return results.map((r) => typeof r.content === 'string'
                        ? r.content
                        : JSON.stringify(r.content));
                },
            },
            memoryStore: {
                storeConversation: async (input, response, metadata) => {
                    try {
                        const summary = `用户: ${input.substring(0, 200)}\n助手: ${response.substring(0, 500)}`;
                        await memoryEngine.storeShortTermMemory(summary, 'conversation', 'neutral');
                        if (metadata.quality && Number(metadata.quality) >= 0.8) {
                            await memoryEngine.storeLongTermMemory(summary, 'conversation', 'neutral');
                        }
                        Logger_1.Logger.debug(`💾 对话已持久化 (quality=${metadata.quality})`, 'MemoryStore');
                    }
                    catch (err) {
                        Logger_1.Logger.warn(`对话持久化失败: ${err.message}`, 'MemoryStore');
                    }
                },
            },
            dynamicContext: {
                getDynamicContext: () => {
                    const now = new Date();
                    const hour = now.getHours();
                    const timeOfDay = hour < 6
                        ? '深夜'
                        : hour < 9
                            ? '早晨'
                            : hour < 12
                                ? '上午'
                                : hour < 14
                                    ? '中午'
                                    : hour < 18
                                        ? '下午'
                                        : hour < 21
                                            ? '傍晚'
                                            : '晚上';
                    return `当前时间: ${now.toLocaleString('zh-CN')}，时段: ${timeOfDay}`;
                },
            },
            historyProvider: {
                getAllHistory: () => {
                    const history = conversationHistoryManager.getAll();
                    return history.map((h) => ({
                        role: h.role,
                        content: h.content,
                    }));
                },
                getRecentHistory: (limit) => {
                    const history = conversationHistoryManager.getAll();
                    return history
                        .slice(-limit)
                        .map((h) => ({
                        role: h.role,
                        content: h.content,
                    }));
                },
            },
            persistenceDeps: {
                memoryEngine: memoryEngine
                    ? {
                        storeShortTermMemory: async (content, scene, emotion) => memoryEngine.storeShortTermMemory(content, scene || '', emotion || 'neutral'),
                        storeLongTermMemory: async (content, scene, emotion) => memoryEngine.storeLongTermMemory(content, scene || '', emotion || 'neutral'),
                        storeInstantMemory: async (content, scene, emotion) => memoryEngine.storeInstantMemory(content, scene || '', emotion || 'neutral'),
                        preciseHybridRetrieval: async (query, scene, emotion, topK) => {
                            const results = await memoryEngine.preciseHybridRetrieval(query, scene, emotion, topK || 5);
                            return results.map((r) => ({
                                id: r.id,
                                content: typeof r.content === 'string'
                                    ? r.content
                                    : JSON.stringify(r.content),
                                type: r.type,
                                timestamp: r.timestamp instanceof Date
                                    ? r.timestamp.getTime()
                                    : Date.now(),
                                scene: r.scene,
                                emotion: r.emotion,
                                relevanceScore: r.relevanceScore,
                            }));
                        },
                        storeFeedbackSignal: async (data) => memoryEngine.storeFeedbackSignal({
                            feedbackType: data.feedbackType || 'success',
                            rating: data.rating || 0,
                            message: data.message || '',
                            traceId: data.traceId,
                            toolName: data.toolName,
                            userId: data.userId,
                            timestamp: data.timestamp,
                        }),
                    }
                    : null,
                conversationHistory: conversationHistoryManager
                    ? (() => {
                        const chm = conversationHistoryManager;
                        return {
                            addUserMessage: (content) => chm.addUserMessage?.(content),
                            addAssistantMessage: (content) => chm.addAssistantMessage?.(content),
                            getRecent: (count) => {
                                const all = chm.getAll?.() || [];
                                return all
                                    .slice(-(count || 20))
                                    .map((h) => ({
                                    role: h.role,
                                    content: h.content,
                                }));
                            },
                            formatForLLM: () => {
                                const all = chm.getAll?.() || [];
                                return all.map((h) => ({
                                    role: h.role,
                                    content: h.content,
                                }));
                            },
                            saveState: async () => { },
                            clear: async () => {
                                chm.clear?.();
                            },
                        };
                    })()
                    : null,
                userProfile: userProfile
                    ? {
                        load: () => userProfile.load(),
                        save: () => userProfile.save(),
                        getData: () => userProfile.toJSON(),
                        update: (data) => userProfile.update(data),
                    }
                    : null,
            },
            // 进化引擎已迁移到 Python 后端（A-Evolution-Engine 整改）。
            // collectFeedback 经 PythonAgentBridge 转发到 /v1/evolution/feedback；
            // 其余 TS 本地进化方法（assessQuality/generateSkill/nudgeKnowledgePersistence/
            // getStrategyOptimizer）现由 Python 进化引擎统一处理，TS 薄网关不再独立实现。
            evolutionEngine: {
                collectFeedback: (input, response, result, scene) => {
                    const bridge = core.getPythonBridgeResolver()?.();
                    if (!bridge)
                        return;
                    void bridge
                        .submitFeedback({
                        session_id: scene || 'harness',
                        quality_score: typeof result.success === 'boolean'
                            ? result.success
                                ? 0.8
                                : 0.2
                            : 0.5,
                        cause: result.error ||
                            (result.success ? 'task_completed' : 'task_failed'),
                        tool_name: Array.isArray(result.toolsUsed)
                            ? result.toolsUsed[0]
                            : undefined,
                        error: result.error,
                    })
                        .catch((err) => Logger_1.Logger.warn(`进化反馈提交失败: ${err.message}`, 'initHarness'));
                },
                assessQuality: () => {
                    // Python 侧在 collectFeedback 内统一评估质量
                },
                generateSkill: () => {
                    // 技能自生成已迁移 Python，TS 侧不再独立实现
                    return null;
                },
                nudgeKnowledgePersistence: () => {
                    // 知识持久化已由 Python 记忆系统接管
                    return null;
                },
            },
            personaCore: core.getPersonaCore(),
            skillRegistry: SkillRegistry_1.SkillRegistry.getInstance(),
            evolutionExamples: {
                getPromptExamples: () => {
                    // 进化提示样例现由 Python 后端提供（/v1/evolution/evolution-prompt）
                    return [];
                },
            },
            environmentSensor: {
                getEnvironmentContext: () => {
                    try {
                        // 从调度器缓存中获取最新环境快照
                        const scheduler = core.getScenarioScheduler();
                        if (scheduler) {
                            const snapshot = scheduler.getEnvironmentSnapshot?.();
                            if (snapshot?.foregroundWindow?.title) {
                                const fg = snapshot.foregroundWindow;
                                const proc = (fg.process || '').toLowerCase();
                                const title = fg.title.toLowerCase();
                                let env = 'other';
                                if (title.includes('code') ||
                                    title.includes('vscode') ||
                                    proc.includes('code') ||
                                    title.includes('terminal') ||
                                    proc.includes('terminal') ||
                                    proc.includes('cmd') ||
                                    proc.includes('powershell') ||
                                    proc.includes('bash') ||
                                    proc.includes('cursor')) {
                                    env = 'coding';
                                }
                                else if (proc.includes('chrome') ||
                                    proc.includes('edge') ||
                                    proc.includes('firefox') ||
                                    proc.includes('explorer')) {
                                    env = 'browsing';
                                }
                                return `当前环境: ${env === 'coding' ? '编程中' : env === 'browsing' ? '浏览网页' : '其他'}\n前台窗口: ${fg.title}`;
                            }
                        }
                    }
                    catch {
                        /* ignore */
                    }
                    return '';
                },
            },
            toolDeps: {
                core: {
                    refreshProjectContext: () => core.refreshProjectContext(),
                    getLoadedContextFiles: () => core.getLoadedContextFiles(),
                },
                retrieveRelevant: async (query) => {
                    const results = await memoryEngine.preciseHybridRetrieval(query.query, undefined, undefined, query.limit);
                    return results;
                },
                storeShortTermMemory: async (content, category) => {
                    await memoryEngine.storeShortTermMemory(content, category, 'neutral');
                    return true;
                },
                checkDuplicate: async (content, category) => {
                    const existing = await memoryEngine.preciseHybridRetrieval(content, category, undefined, 10);
                    const existingContents = existing.map((r) => typeof r.content === 'string'
                        ? r.content
                        : JSON.stringify(r.content));
                    return (0, memory_store_1.isDuplicateContent)(content, existingContents);
                },
                storeWithMetadata: async (content, category, metadata) => {
                    const emotionTag = metadata.importance >= 7 ? 'important' : 'neutral';
                    await memoryEngine.storeShortTermMemory(content, category, emotionTag);
                    return true;
                },
                updateAccessStats: async (query) => {
                    const results = await memoryEngine.preciseHybridRetrieval(query, undefined, undefined, 5);
                    for (const r of results) {
                        const currentCount = r.accessCount ?? 0;
                        r.accessCount =
                            currentCount + 1;
                        r.lastAccessTime =
                            Date.now();
                    }
                },
                searchMemories: async (params) => {
                    const results = await memoryEngine.preciseHybridRetrieval(params.keywords, undefined, undefined, params.limit);
                    return results.map((r) => ({
                        content: typeof r.content === 'string'
                            ? r.content
                            : JSON.stringify(r.content),
                        category: params.category || r.scene || 'other',
                        timestamp: r.timestamp
                            ? new Date(r.timestamp).getTime()
                            : Date.now(),
                    }));
                },
                detectEmotionFromInput: (text) => {
                    // 扩展情感词库 + 上下文强度分析
                    const negativeWords = [
                        '烦',
                        '累',
                        '难过',
                        '焦虑',
                        '生气',
                        '失望',
                        '沮丧',
                        '压力',
                        '崩溃',
                        '愤怒',
                        '烦躁',
                        '郁闷',
                        '无语',
                        '恶心',
                        '讨厌',
                        '恨',
                        '怕',
                        '担心',
                        '紧张',
                        '慌',
                        '痛苦',
                        '伤心',
                        '委屈',
                        '憋屈',
                        '无奈',
                        '绝望',
                        '烦躁',
                        '头疼',
                        '受不了',
                        '烦死了',
                        '气死',
                        '完蛋',
                    ];
                    const positiveWords = [
                        '开心',
                        '高兴',
                        '喜欢',
                        '棒',
                        '好',
                        '谢谢',
                        '感谢',
                        '幸福',
                        '赞',
                        '牛逼',
                        '厉害',
                        '完美',
                        '爽',
                        '舒服',
                        '期待',
                        '兴奋',
                        '感动',
                        '满足',
                        '轻松',
                        '放心',
                        '太好了',
                        '真棒',
                        '优秀',
                        '漂亮',
                        '绝了',
                        '有意思',
                    ];
                    const intensifiers = [
                        '太',
                        '非常',
                        '特别',
                        '超级',
                        '极其',
                        '很',
                        '真的',
                        '简直',
                        '实在是',
                        '无比',
                        '极其',
                    ];
                    const negations = ['不', '没', '别', '不要', '不是', '没有'];
                    let score = 0;
                    let matchedNeg = 0;
                    let matchedPos = 0;
                    let hasIntensifier = false;
                    let hasNegation = false;
                    for (const w of intensifiers) {
                        if (text.includes(w)) {
                            hasIntensifier = true;
                            break;
                        }
                    }
                    for (const w of negations) {
                        if (text.includes(w)) {
                            hasNegation = true;
                            break;
                        }
                    }
                    for (const w of negativeWords) {
                        const count = (text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                        if (count > 0) {
                            matchedNeg += count;
                            score -= count * (hasIntensifier ? 2 : 1);
                        }
                    }
                    for (const w of positiveWords) {
                        const count = (text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                        if (count > 0) {
                            matchedPos += count;
                            score += count * (hasIntensifier ? 2 : 1);
                        }
                    }
                    // 否定词翻转情绪极性（就近翻转：否定词仅翻转其前 3 字内的情绪词）
                    if (hasNegation) {
                        let negatedScore = 0;
                        let nonNegatedScore = 0;
                        const allEmotionWords = [
                            ...negativeWords.map((w) => ({ word: w, val: -1 })),
                            ...positiveWords.map((w) => ({ word: w, val: 1 })),
                        ];
                        const matchedRanges = [];
                        for (const { word, val } of allEmotionWords) {
                            const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                            let match;
                            while ((match = regex.exec(text)) !== null) {
                                const start = match.index;
                                const end = start + word.length;
                                const isSubsumed = matchedRanges.some((r) => start >= r.start && end <= r.end);
                                if (isSubsumed)
                                    continue;
                                matchedRanges.push({ start, end });
                                const window = text.substring(Math.max(0, start - 3), start);
                                const isNegated = negations.some((n) => window.includes(n));
                                const weight = hasIntensifier ? 2 : 1;
                                if (isNegated) {
                                    negatedScore += -val * weight;
                                }
                                else {
                                    nonNegatedScore += val * weight;
                                }
                            }
                        }
                        if (negatedScore !== 0 || nonNegatedScore !== 0) {
                            score = negatedScore + nonNegatedScore;
                        }
                    }
                    // 感叹号增强强度
                    const exclaimCount = (text.match(/！/g) || []).length + (text.match(/!/g) || []).length;
                    if (exclaimCount >= 2) {
                        score *= 1.5;
                    }
                    // 问号表示困惑/中性偏负
                    const questionCount = (text.match(/？/g) || []).length + (text.match(/\?/g) || []).length;
                    if (questionCount >= 3 && matchedNeg === 0 && matchedPos === 0) {
                        score -= 1;
                    }
                    if (score <= -2) {
                        const rawIntensity = Math.min(10, Math.abs(score) * 1.5);
                        return {
                            type: 'negative',
                            intensity: Math.round(rawIntensity * 10) / 10,
                            dominant: matchedNeg > matchedPos ? 'negative' : 'mixed',
                            confidence: Math.min(1, Math.abs(score) / 5),
                        };
                    }
                    if (score >= 2) {
                        const rawIntensity = Math.min(10, score * 1.5);
                        return {
                            type: 'positive',
                            intensity: Math.round(rawIntensity * 10) / 10,
                            dominant: matchedPos > matchedNeg ? 'positive' : 'mixed',
                            confidence: Math.min(1, score / 5),
                        };
                    }
                    return {
                        type: 'neutral',
                        intensity: 1,
                        dominant: 'neutral',
                        confidence: 0.5,
                    };
                },
                recognizeScene: async (text) => {
                    const { MultimodalInput } = await Promise.resolve().then(() => __importStar(require('../../multimodal/MultimodalInput')));
                    const input = new MultimodalInput(text);
                    const scene = await sceneRecognizer.recognize(input);
                    return { type: scene.type, context: scene.context };
                },
                agentSelfReflection: {
                    recordExecution: async (entry) => {
                        try {
                            const entryStr = typeof entry === 'string' ? entry : JSON.stringify(entry);
                            const refDir = path_1.default.join(process.cwd(), 'data', 'reflections');
                            fs_1.default.mkdirSync(refDir, { recursive: true });
                            const refFile = path_1.default.join(refDir, `reflection_${Date.now()}.json`);
                            fs_1.default.writeFileSync(refFile, JSON.stringify({
                                timestamp: new Date().toISOString(),
                                entry: entryStr,
                            }, null, 2), 'utf-8');
                            Logger_1.Logger.info(`📝 自我反思已持久化: ${refFile}`, 'SelfReflect');
                        }
                        catch (err) {
                            Logger_1.Logger.warn(`⚠️ 自我反思持久化失败: ${err.message}`, 'SelfReflect');
                        }
                    },
                },
                captureScreen: async (params) => {
                    const { ScreenCapture } = await Promise.resolve().then(() => __importStar(require('../../desktop/ScreenCapture')));
                    const capture = ScreenCapture.getInstance();
                    const result = await capture.captureScreen(params?.screenIndex ?? 0);
                    return {
                        buffer: result.buffer,
                        width: result.width,
                        height: result.height,
                    };
                },
                listDirectory: async (params) => {
                    const dir = params.directory || '.';
                    const entries = [];
                    try {
                        const items = fs_1.default.readdirSync(dir, { withFileTypes: true });
                        for (const item of items) {
                            if (item.name.startsWith('.') && params.pattern !== '.*')
                                continue;
                            const fullPath = path_1.default.join(dir, item.name);
                            entries.push({
                                name: item.name,
                                path: fullPath,
                                type: item.isDirectory() ? 'directory' : 'file',
                                size: item.isFile() ? fs_1.default.statSync(fullPath).size : undefined,
                            });
                        }
                    }
                    catch {
                        /* directory not accessible */
                    }
                    return entries;
                },
                searchInFiles: async (params) => {
                    const results = [];
                    try {
                        const dir = params.directory || '.';
                        const maxResults = params.maxResults || 20;
                        const files = fs_1.default.readdirSync(dir);
                        let count = 0;
                        for (const file of files) {
                            if (count >= maxResults)
                                break;
                            const fullPath = path_1.default.join(dir, file);
                            try {
                                if (!fs_1.default.statSync(fullPath).isFile())
                                    continue;
                                const content = fs_1.default.readFileSync(fullPath, 'utf-8');
                                const lines = content.split('\n');
                                for (let i = 0; i < lines.length && count < maxResults; i++) {
                                    if (lines[i].includes(params.query)) {
                                        results.push({
                                            filePath: fullPath,
                                            line: i + 1,
                                            content: lines[i],
                                            match: params.query,
                                        });
                                        count++;
                                    }
                                }
                            }
                            catch {
                                /* skip unreadable files */
                            }
                        }
                    }
                    catch {
                        /* directory not accessible */
                    }
                    return results;
                },
                addToHistory: async (filePath, _entry) => {
                    Logger_1.Logger.info(`📝 文件变更历史: ${filePath}`, 'FileHistory');
                },
                removeHistory: async (_filePath, _steps) => null,
                getHistory: async (_filePath) => [],
                validateCodeSyntax: (code, _ext) => {
                    const errors = [];
                    const openBraces = (code.match(/\{/g) || []).length;
                    const closeBraces = (code.match(/\}/g) || []).length;
                    if (openBraces !== closeBraces)
                        errors.push('大括号不匹配');
                    const openParens = (code.match(/\(/g) || []).length;
                    const closeParens = (code.match(/\)/g) || []).length;
                    if (openParens !== closeParens)
                        errors.push('圆括号不匹配');
                    return errors;
                },
                generateCode: async (params) => {
                    const prompt = `请用${params.language}实现: ${params.requirements}${params.framework ? `，使用${params.framework}框架` : ''}`;
                    const result = await llm.chat(prompt, [], `你是一个专业的${params.language}程序员。`);
                    return { code: result, language: params.language || 'typescript' };
                },
                analyzeCode: async (params) => {
                    const prompt = `请分析以下${params.language}代码的${params.analysisType === 'security' ? '安全性' : params.analysisType === 'performance' ? '性能' : '质量'}问题：\n\n\`\`\`${params.language}\n${params.code}\n\`\`\`\n\n请返回JSON格式的分析结果，包括问题列表(issues)、质量评分(score 0-100)和总结(summary)。`;
                    const llmResult = await llm.chat(prompt, [], `你是一个专业的代码质量分析师，擅长识别代码质量、安全和性能问题。请用JSON格式回答。`);
                    try {
                        const jsonMatch = llmResult.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            return {
                                issues: parsed.issues || [],
                                score: parsed.score || 70,
                                summary: parsed.summary || '代码分析完成',
                            };
                        }
                    }
                    catch {
                        /* ignore parse errors */
                    }
                    return {
                        issues: [],
                        score: 70,
                        summary: `代码分析完成(${params.analysisType})，分析结果: ${llmResult.substring(0, 200)}`,
                    };
                },
                fixCode: async (params) => {
                    const prompt = `修复以下${params.language}代码的问题: ${params.errorDescription}\n\n代码:\n${params.code}`;
                    const result = await llm.chat(prompt, [], `你是一个专业的${params.language}程序员，专注于修复代码问题。`);
                    return {
                        fixedCode: result,
                        changes: [
                            { type: 'fix', description: params.errorDescription },
                        ],
                    };
                },
                taskStore: {
                    getTasks: async () => {
                        const results = await memoryEngine.preciseHybridRetrieval('__tasks__', undefined, undefined, 100);
                        return results
                            .filter((r) => r.scene === 'task')
                            .map((r, i) => ({
                            id: `task_${i}`,
                            title: typeof r.content === 'string'
                                ? r.content.substring(0, 50)
                                : JSON.stringify(r.content).substring(0, 50),
                            description: typeof r.content === 'string'
                                ? r.content
                                : JSON.stringify(r.content),
                            priority: 'medium',
                            status: 'pending',
                            tags: [],
                            createdAt: r.timestamp
                                ? new Date(r.timestamp).getTime()
                                : Date.now(),
                        }));
                    },
                    saveTask: async (task) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify(task), 'task', 'neutral');
                    },
                    deleteTask: async (taskId) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify({
                            _deleted: true,
                            id: taskId,
                            deletedAt: Date.now(),
                        }), 'task', 'neutral');
                        Logger_1.Logger.info(`🗑️ 任务已标记删除: ${taskId}`, 'TaskStore');
                    },
                },
                calendarStore: {
                    getEvents: async () => [],
                    saveEvent: async (event) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify(event), 'calendar', 'neutral');
                    },
                    deleteEvent: async (eventId) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify({
                            _deleted: true,
                            id: eventId,
                            deletedAt: Date.now(),
                        }), 'calendar', 'neutral');
                        Logger_1.Logger.info(`🗑️ 日程已标记删除: ${eventId}`, 'CalendarStore');
                    },
                },
                reminderStore: {
                    getReminders: async () => [],
                    saveReminder: async (reminder) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify(reminder), 'reminder', 'neutral');
                    },
                    deleteReminder: async (reminderId) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify({
                            _deleted: true,
                            id: reminderId,
                            deletedAt: Date.now(),
                        }), 'reminder', 'neutral');
                        Logger_1.Logger.info(`🗑️ 提醒已标记删除: ${reminderId}`, 'ReminderStore');
                    },
                },
                scheduleTrigger: (reminder) => {
                    const triggerTime = new Date(reminder.triggerTime).getTime();
                    const delay = triggerTime - Date.now();
                    if (delay > 0) {
                        setTimeout(() => {
                            const { EventBus } = require('../../shared/EventBus');
                            void EventBus.emit('reminder_triggered', {
                                reminderId: reminder.id,
                                message: reminder.message,
                                timestamp: new Date().toISOString(),
                            });
                        }, delay);
                    }
                },
                noteStore: {
                    getNotes: async () => {
                        const results = await memoryEngine.preciseHybridRetrieval('__notes__', undefined, undefined, 100);
                        return results
                            .filter((r) => r.scene === 'note')
                            .map((r, i) => ({
                            id: `note_${i}`,
                            title: typeof r.content === 'string'
                                ? r.content.substring(0, 30)
                                : JSON.stringify(r.content).substring(0, 30),
                            content: typeof r.content === 'string'
                                ? r.content
                                : JSON.stringify(r.content),
                            tags: [],
                            createdAt: r.timestamp
                                ? new Date(r.timestamp).getTime()
                                : Date.now(),
                            updatedAt: r.timestamp
                                ? new Date(r.timestamp).getTime()
                                : Date.now(),
                        }));
                    },
                    saveNote: async (note) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify(note), 'note', 'neutral');
                    },
                    deleteNote: async (noteId) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify({
                            _deleted: true,
                            id: noteId,
                            deletedAt: Date.now(),
                        }), 'note', 'neutral');
                        Logger_1.Logger.info(`🗑️ 笔记已标记删除: ${noteId}`, 'NoteStore');
                    },
                },
                getMemoryStats: () => {
                    const memDir = path_1.default.join(process.cwd(), 'data');
                    let totalMemories = 0;
                    let shortTermSize = 0;
                    try {
                        const shortTermFile = path_1.default.join(memDir, 'short_term_memory.json');
                        if (fs_1.default.existsSync(shortTermFile)) {
                            const content = fs_1.default.readFileSync(shortTermFile, 'utf-8');
                            const lines = content
                                .trim()
                                .split('\n')
                                .filter((l) => !!l);
                            shortTermSize = content.length;
                            totalMemories += lines.length;
                        }
                        const profileFile = path_1.default.join(memDir, 'user_profile.json');
                        if (fs_1.default.existsSync(profileFile)) {
                            totalMemories +=
                                JSON.parse(fs_1.default.readFileSync(profileFile, 'utf-8')).interactions
                                    ?.length || 0;
                        }
                    }
                    catch {
                        /* 忽略读取错误 */
                    }
                    return {
                        status: 'active',
                        totalMemories,
                        shortTermSize,
                        dbPath: path_1.default.join(memDir, 'jiabaixing_memory.db'),
                    };
                },
                getToolStats: () => {
                    const tools = harness?.getToolRegistry();
                    const allTools = tools?.getAll() || [];
                    const byCategory = {};
                    for (const t of allTools) {
                        const cat = t.definition.category;
                        byCategory[cat] = (byCategory[cat] || 0) + 1;
                    }
                    return { registered: allTools.length, byCategory };
                },
                getHarnessStats: () => ({
                    initialized: true,
                    config: { useHarnessTools: true, useHarnessLoop: false },
                    loopRounds: 0,
                    toolCalls: 0,
                    uptime: process.uptime(),
                }),
                getEvolutionStats: async () => {
                    const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
                    if (bridge) {
                        try {
                            const metrics = (await bridge.getEvolutionMetrics());
                            return metrics ?? {};
                        }
                        catch (err) {
                            Logger_1.Logger.debug(`进化指标获取失败: ${err?.message}`, 'initHarness');
                            return {};
                        }
                    }
                    const orchestrator = (() => {
                        try {
                            return require('../../evolution/EvolutionOrchestrator').EvolutionOrchestrator.getInstance();
                        }
                        catch (err) {
                            Logger_1.Logger.debug(`EvolutionOrchestrator获取失败: ${err?.message}`, 'initHarness');
                            return null;
                        }
                    })();
                    if (!orchestrator)
                        return {};
                    const metrics = orchestrator.getUnifiedMetrics();
                    return {
                        totalInteractions: metrics.summary.totalInteractions,
                        totalOptimizations: metrics.summary.totalOptimizations,
                        averageQualityScore: metrics.summary.averageQualityScore,
                        qualityTrend: metrics.quality.trend,
                        failureRate: metrics.quality.failureRate,
                        cyclesToday: metrics.optimization.cyclesToday,
                        totalCycles: metrics.optimization.totalCycles,
                        lastCycleTime: metrics.optimization.lastCycleTime,
                        cycleSuccessRate: metrics.optimization.successRate,
                    };
                },
                getSchedulerStats: () => ({
                    active: true,
                    triggers: 0,
                }),
                skillStore: {
                    getSkills: async () => {
                        const results = await memoryEngine.preciseHybridRetrieval('__skills__', undefined, undefined, 100);
                        return results
                            .filter((r) => r.scene === 'skill')
                            .map((r) => {
                            try {
                                return JSON.parse(typeof r.content === 'string'
                                    ? r.content
                                    : JSON.stringify(r.content));
                            }
                            catch (err) {
                                Logger_1.Logger.debug(`进化结果解析失败: ${err?.message}`, 'initHarness');
                                return null;
                            }
                        })
                    },
                    saveSkill: async (skill) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify(skill), 'skill', 'neutral');
                    },
                    deleteSkill: async (skillName) => {
                        await memoryEngine.storeShortTermMemory(JSON.stringify({
                            _deleted: true,
                            name: skillName,
                            deletedAt: Date.now(),
                        }), 'skill', 'neutral');
                        Logger_1.Logger.info(`🗑️ 技能已标记删除: ${skillName}`, 'SkillStore');
                    },
                },
                llm: {
                    chat: async (prompt, _history, systemPrompt) => {
                        return llm.chat(prompt, [], systemPrompt);
                    },
                },
                httpClient: {
                    get: async (url) => {
                        const https = await Promise.resolve().then(() => __importStar(require('https')));
                        const http = await Promise.resolve().then(() => __importStar(require('http')));
                        return new Promise((resolve, reject) => {
                            const client = url.startsWith('https') ? https : http;
                            client
                                .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                                let data = '';
                                res.on('data', (chunk) => {
                                    data += chunk;
                                });
                                res.on('end', () => resolve(data));
                                res.on('error', reject);
                            })
                                .on('error', reject);
                        });
                    },
                },
                speechSynthesizer: speechSynthesizer || undefined,
                terminalBackend: terminalBackend || undefined,
                // Phase 2: LSP 工具依赖注入
                getDiagnosticsForFile: undefined,
                filterDiagnostics: undefined,
                formatDiagnostics: undefined,
                getCompletions: undefined,
                formatCompletions: undefined,
                getHover: undefined,
                formatHover: undefined,
                getDefinition: undefined,
                formatDefinition: undefined,
                getReferences: undefined,
                formatReferences: undefined,
                getDocumentSymbols: undefined,
                formatSymbols: undefined,
            },
        };
        harness = new harness_1.AgentHarness({
            useHarnessTools: true,
            useHarnessLoop: true,
            useHarnessContext: true,
            useHarnessVerification: true,
            useHarnessConstraints: true,
            useHarnessPersistence: true,
        });
        // 注入 FeedbackLoops 依赖
        harnessDeps.feedbackCollector = core.feedbackCollector;
        harnessDeps.memoryAssistant = {
            autoExtractKnowledge: async (input, response, userId) => {
                await core
                    .getMemoryAssistant()
                    .autoExtractKnowledge(input, response, userId);
            },
        };
        // ─── Hermes 集成: 注入6个关键组件到主循环链路 ───
        // P1: EvaluationPipeline — 多阶段评估流水线
        const evaluationPipeline = new EvaluationPipeline_1.EvaluationPipeline();
        evaluationPipeline.addStage('step_evaluation', new StepEvaluator_1.StepEvaluator(), 0.2);
        evaluationPipeline.addStage('independent_evaluation', new IndependentEvaluationService_1.IndependentEvaluationService({
            llm: harnessDeps.llm
                ? {
                    chat: async (prompt, systemPrompt) => harnessDeps.llm.chat(prompt, systemPrompt),
                }
                : undefined,
            enableLLMEvaluation: !!harnessDeps.llm,
        }), 0.35);
        evaluationPipeline.addStage('quality_scoring', new QualityScorer_1.QualityScorer(), 0.45);
        harnessDeps.evaluationPipeline =
            evaluationPipeline;
        Logger_1.Logger.info('  📊 EvaluationPipeline: 已注入 HarnessDeps', 'Bootstrap');
        // P2: ContextReferenceResolver — @引用解析器
        const contextReferenceResolver = new ContextReferenceResolver_1.ContextReferenceResolver({
            projectRoot: process.cwd(),
        });
        harnessDeps.contextReferenceResolver = contextReferenceResolver;
        Logger_1.Logger.info('  📎 ContextReferenceResolver: 已注入 ContextManager', 'Bootstrap');
        // P2: OutputGuardrailEngine — 输出安全护栏
        const outputGuardrails = new OutputGuardrailEngine_1.OutputGuardrailEngine();
        harnessDeps.outputGuardrails = outputGuardrails;
        Logger_1.Logger.info('  🛡️ OutputGuardrailEngine: 已注入 AgentHarness', 'Bootstrap');
        // P2: CausalModeler — 已迁移到 Python agent/loop/causal.py，TS端不再初始化
        Logger_1.Logger.info('  🔗 CausalModeler: 已迁移到 Python 后端', 'Bootstrap');
        // P3: TrajectoryFlywheel — 轨迹飞轮引擎（需要 TrajectoryDatabase，在 initialize 后注入）
        Logger_1.Logger.info('  🔄 TrajectoryFlywheel: 将在 initialize 后注入', 'Bootstrap');
        // P3: LLMCapabilityDetector — LLM能力探测器
        const capabilityDetector = new LLMCapabilityDetector_1.LLMCapabilityDetector();
        if (harnessDeps.llm) {
            capabilityDetector.setLLMProvider({
                chat: async (message, history, systemPromptOverride) => {
                    if (systemPromptOverride) {
                        return harnessDeps.llm.chat(message, systemPromptOverride);
                    }
                    return harnessDeps.llm.chat(message);
                },
            });
            Logger_1.Logger.info('  🔍 LLMCapabilityDetector: 已连接 LLMProvider', 'Bootstrap');
        }
        // P3: CronJobScheduler — 定时任务调度器（由 AgentHarness.initialize 统一管理）
        // 注意：不再在此处单独启动，由 Harness Phase 3 初始化统一管理生命周期
        harness.setDeps(harnessDeps);
        await harness.initialize();
        // Phase 2: LSP 提供器动态注入 — initialize 后 LSP 实例才可用
        const lspDiagnostics = harness.getLspDiagnosticsProvider();
        const lspCompletion = harness.getLspCompletionProvider();
        if (lspDiagnostics && harnessDeps.toolDeps) {
            harnessDeps.toolDeps.getDiagnosticsForFile =
                lspDiagnostics.getDiagnosticsForFile.bind(lspDiagnostics);
            harnessDeps.toolDeps.filterDiagnostics =
                lspDiagnostics.filterDiagnostics.bind(lspDiagnostics);
            harnessDeps.toolDeps.formatDiagnostics =
                lspDiagnostics.formatDiagnostics.bind(lspDiagnostics);
        }
        if (lspCompletion && harnessDeps.toolDeps) {
            harnessDeps.toolDeps.getCompletions =
                lspCompletion.getCompletions.bind(lspCompletion);
            harnessDeps.toolDeps.formatCompletions =
                lspCompletion.formatCompletions.bind(lspCompletion);
            harnessDeps.toolDeps.getHover =
                lspCompletion.getHover.bind(lspCompletion);
            harnessDeps.toolDeps.formatHover =
                lspCompletion.formatHover.bind(lspCompletion);
            harnessDeps.toolDeps.getDefinition =
                lspCompletion.getDefinition.bind(lspCompletion);
            harnessDeps.toolDeps.formatDefinition =
                lspCompletion.formatDefinition.bind(lspCompletion);
            harnessDeps.toolDeps.getReferences =
                lspCompletion.getReferences.bind(lspCompletion);
            harnessDeps.toolDeps.formatReferences =
                lspCompletion.formatReferences.bind(lspCompletion);
            harnessDeps.toolDeps.getDocumentSymbols =
                lspCompletion.getDocumentSymbols.bind(lspCompletion);
            harnessDeps.toolDeps.formatSymbols =
                lspCompletion.formatSymbols.bind(lspCompletion);
        }
        if (lspDiagnostics || lspCompletion) {
            Logger_1.Logger.info('  🌐 LSP 工具依赖: 已动态注入到 toolDeps', 'Bootstrap');
        }
        // Phase 2: 设置 LSP 工作区根 URI
        const projectRoot = path_1.default.resolve(process.cwd());
        harnessDeps.workspaceRootUri = `file:///${projectRoot.replace(/\\/g, '/')}`;
        // Phase 3: 会话存储 + Skill注册中心 动态注入
        const sessionStore = harness.getSessionStore();
        const skillRegistry = harness.getSkillRegistry();
        if (sessionStore && harnessDeps.toolDeps) {
            harnessDeps.toolDeps.sessionStore =
                sessionStore;
            Logger_1.Logger.info('  🗄️ 会话存储: 已注入到 toolDeps', 'Bootstrap');
        }
        if (skillRegistry && harnessDeps.toolDeps) {
            harnessDeps.toolDeps.skillRegistry =
                skillRegistry;
            Logger_1.Logger.info('  🔧 Skill注册中心: 已注入到 toolDeps', 'Bootstrap');
        }
        // Phase 4: ACP活动追踪器 + 消息处理层 + i18n 动态注入
        const acpTracker = harness.getACPTracker();
        const messageProcessor = harness.getMessageProcessor();
        const i18nManager = harness.getI18nManager();
        if (acpTracker && harnessDeps.toolDeps) {
            harnessDeps.toolDeps.acpTracker = acpTracker;
            Logger_1.Logger.info('  📡 ACP活动追踪器: 已注入到 toolDeps', 'Bootstrap');
        }
        if (messageProcessor && harnessDeps.toolDeps) {
            harnessDeps.toolDeps.messageProcessor =
                messageProcessor;
            Logger_1.Logger.info('  📨 消息处理层: 已注入到 toolDeps', 'Bootstrap');
        }
        if (i18nManager && harnessDeps.toolDeps) {
            harnessDeps.toolDeps.i18nManager =
                i18nManager;
            Logger_1.Logger.info('  🌐 i18n管理器: 已注入到 toolDeps', 'Bootstrap');
        }
        // P3: TrajectoryFlywheel — 在 initialize 后注入（需要 TrajectoryDatabase）
        const trajectoryDB = harness.getTrajectoryDatabase();
        if (trajectoryDB) {
            const trajectoryFlywheel = new TrajectoryFlywheel_1.TrajectoryFlywheel(trajectoryDB);
            harnessDeps.trajectoryFlywheel = trajectoryFlywheel;
            harness.injectTrajectoryFlywheel(trajectoryFlywheel);
            Logger_1.Logger.info('  🔄 TrajectoryFlywheel: 已注入 AgentHarness', 'Bootstrap');
        }
        else {
            Logger_1.Logger.warn('  ⚠️ TrajectoryFlywheel: TrajectoryDatabase 不可用，跳过注入', 'Bootstrap');
        }
        core.setHarness(harness);
        const mcpBridge = MCPToolBridge_1.MCPToolBridge.getInstance();
        if (harness.getToolRegistry) {
            const registry = harness.getToolRegistry();
            if (registry) {
                mcpBridge.startAutoSync(registry);
                Logger_1.Logger.info('🌉 MCP工具桥接已启动', 'Bootstrap');
            }
        }
        const autoTrigger = AutonomousTrigger_1.AutonomousTrigger.getInstance();
        if (harness) {
            autoTrigger.setHarness(harness);
            autoTrigger.start();
            Logger_1.Logger.info('🤖 自主触发器已启动', 'Bootstrap');
        }
        Logger_1.Logger.info('Harness 框架初始化完成', 'Bootstrap');
    }
    catch (err) {
        Logger_1.Logger.error(`Harness 初始化失败: ${err.message}`, err, 'Bootstrap');
        Logger_1.Logger.error(`Harness 初始化失败堆栈: ${err.stack}`, err, 'Bootstrap');
    }
    return { harness };
}
