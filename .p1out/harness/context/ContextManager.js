"use strict";
/**
 * Harness Layer 3: Context - 上下文管理器
 *
 * 可组合的上下文管道，替代 JiabaixingCore 中的硬编码 prompt 拼接
 *
 * Phase 2 增强:
 *   - compressHistory(): 自动上下文压缩，当 Token 预算超阈值时合并早期对话
 *   - summarizeHistory(): LLM 驱动的对话摘要，回退到规则引擎
 *   - offloadHistory(): LRU 策略 + 文件系统卸荷索引
 *
 * @deprecated 已废弃，请使用 UnifiedContextPipeline + ConstitutionPromptBuilder 替代。
 *
 * 废弃状态说明：
 * - 废弃版本：V5.0
 * - 迁移日期：2026-06-22
 * - 预计移除版本：V6.0（约 2026-09）
 * - 替代方案：
 *   - AI 上下文构建（记忆、场景、情感、用户画像）→ UnifiedContextPipeline
 *   - 系统 Prompt 构建（身份、人格、规则、工具清单）→ ConstitutionPromptBuilder
 *   - 记忆智能筛选 → LLMContextBuilder
 *   - Token 预算分配 → TokenBudgetAllocator
 *   - 上下文窗口管理 → ContextWindowManager
 *   - @引用解析 → ContextReferenceResolver
 *   - 项目文件上下文 → ContextFileRegistry
 * - 回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现（不推荐）
 * - 维护状态：仅安全修复，不再新增功能
 *
 * 注意：当 AGENT_BACKEND=python（默认）时，此文件不会被使用。
 *       仅当显式设置 AGENT_BACKEND=local 时才会使用此 TS 实现。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const PreferenceInjector_1 = require("../../memory/PreferenceInjector");
const Logger_1 = require("../../utils/Logger");
const TokenBudgetAllocator_1 = require("./TokenBudgetAllocator");
const DEFAULT_COMPRESSION_THRESHOLD = {
    tokenUsageThreshold: 0.85,
    historyCountThreshold: 30,
    minRetainedHistory: 6,
};
class ContextManager {
    constructor(deps, totalBudget = 8000) {
        this.entries = [];
        this.offloadedHistory = [];
        this.offloadIndex = [];
        this.lruAccessMap = new Map();
        this.deps = deps;
        this.allocator = new TokenBudgetAllocator_1.TokenBudgetAllocator(totalBudget);
        this.compressionConfig = DEFAULT_COMPRESSION_THRESHOLD;
        if (this.deps.offloadDir) {
            this.loadOffloadIndex();
        }
    }
    /**
     * 构建完整的上下文消息
     */
    async buildContext(input) {
        this.entries = [];
        const allocation = this.allocator.allocate();
        const messages = [];
        // 1. Constitutional Prompt (priority: 10)
        try {
            const constitutional = await this.deps.constitutionalBuilder.buildConstitutionPrompt(input.userId);
            const enrichedConstitutional = (0, PreferenceInjector_1.injectPreferences)(constitutional);
            const truncated = this.allocator.truncateToBudget(enrichedConstitutional, allocation.systemPrompt);
            messages.push({ role: 'system', content: truncated });
            this.entries.push({
                id: 'constitutional',
                type: 'system',
                content: truncated,
                priority: 10,
                tokenEstimate: this.allocator.estimateTokens(truncated),
                source: 'ConstitutionalBuilder',
            });
        }
        catch (err) {
            Logger_1.Logger.warn(`宪法 Prompt 构建失败: ${err.message}`, 'ContextManager');
        }
        // 2. Persona Tone Instruction (priority: 9) — 进化闭环：语气参数真实注入
        if (this.deps.personaCore) {
            try {
                const scene = this.deps.sceneRecognizer
                    ? this.deps.sceneRecognizer.recognizeSceneFromInput(input.text)
                    : this.inferSceneFromInput(input.text);
                const toneInstruction = this.deps.personaCore.buildSceneToneInstruction(scene);
                if (toneInstruction) {
                    const personaSummary = this.deps.personaCore.buildPersonaSummary();
                    const personaContent = `${personaSummary}\n\n${toneInstruction}`;
                    const truncated = this.allocator.truncateToBudget(personaContent, allocation.dynamicContext);
                    messages.push({ role: 'system', content: truncated });
                    this.entries.push({
                        id: 'persona_tone',
                        type: 'dynamic',
                        content: truncated,
                        priority: 9,
                        tokenEstimate: this.allocator.estimateTokens(truncated),
                        source: 'PersonaCore',
                    });
                    Logger_1.Logger.info(`🎭 进化闭环: 语气指令已注入 [scene=${scene}]`, 'ContextManager');
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`人格语气注入失败: ${err.message}`, 'ContextManager');
            }
        }
        // 3. Dynamic Context (priority: 9) — 时间/场景
        try {
            const dynamic = this.deps.dynamicContext.getDynamicContext();
            if (dynamic) {
                const truncated = this.allocator.truncateToBudget(dynamic, allocation.dynamicContext);
                messages.push({ role: 'system', content: truncated });
                this.entries.push({
                    id: 'dynamic',
                    type: 'dynamic',
                    content: truncated,
                    priority: 9,
                    tokenEstimate: this.allocator.estimateTokens(truncated),
                    source: 'DynamicContext',
                });
            }
        }
        catch {
            // 动态上下文失败不影响主流程
        }
        // 4. Auto Memories (priority: 7)
        try {
            const memories = await this.deps.memoryInjector.autoRetrieveMemories(input.text, input.userId);
            if (memories.length > 0) {
                const memoryText = memories.join('\n');
                const truncated = this.allocator.truncateToBudget(memoryText, allocation.memory);
                messages.push({
                    role: 'system',
                    content: `【相关记忆】\n${truncated}`,
                });
                this.entries.push({
                    id: 'memories',
                    type: 'memory',
                    content: truncated,
                    priority: 7,
                    tokenEstimate: this.allocator.estimateTokens(truncated),
                    source: 'MemoryInjector',
                });
            }
        }
        catch {
            // 记忆注入失败不影响主流程
        }
        // 4.5 桌面环境感知 (priority: 6)
        try {
            const envContext = this.deps.environmentSensor?.getEnvironmentContext?.();
            if (envContext) {
                const truncated = this.allocator.truncateToBudget(envContext, allocation.dynamicContext);
                messages.push({
                    role: 'system',
                    content: `【当前环境】\n${truncated}`,
                });
                this.entries.push({
                    id: 'environment',
                    type: 'dynamic',
                    content: truncated,
                    priority: 6,
                    tokenEstimate: this.allocator.estimateTokens(truncated),
                    source: 'EnvironmentSensor',
                });
            }
        }
        catch {
            // 环境感知失败不影响主流程
        }
        // 4.6 进化纠错提示 (priority: 6)
        try {
            const examples = this.deps.evolutionExamples?.getPromptExamples?.();
            if (examples && examples.length > 0) {
                const top = examples
                    .sort((a, b) => b.frequency - a.frequency)
                    .slice(0, 2);
                const hintText = top
                    .map((e, i) => `${i + 1}. 当用户说"${e.trigger}" → 正确做法: ${e.correction}`)
                    .join('\n');
                messages.push({
                    role: 'system',
                    content: `【进化经验】\n以下是从历史交互中学习的经验：\n${hintText}`,
                });
            }
        }
        catch {
            // 进化提示注入失败不影响主流程
        }
        // 5. Conversation History (priority: 5)
        try {
            const history = this.deps.historyProvider.getRecentHistory(10);
            const budgetChars = allocation.history * 2;
            let usedChars = 0;
            const truncatedHistory = [];
            for (const msg of history) {
                const msgChars = (msg.content || '').length + 10;
                if (usedChars + msgChars > budgetChars)
                    break;
                truncatedHistory.push(msg);
                usedChars += msgChars;
            }
            // P3: 主动检索 — 从卸荷历史中检索与当前任务相关的上下文
            // 当近期历史不足以覆盖任务关键词时，从已卸荷的旧消息中主动检索
            if (this.offloadedHistory.length > 0) {
                try {
                    const proactiveContext = this.activelyRetrieveContext(this.offloadedHistory, input.text);
                    if (proactiveContext.length > 0) {
                        const proactiveBudget = Math.floor(allocation.history * 0.3);
                        const focused = this.focusByAttention(proactiveContext, input.text, proactiveBudget);
                        truncatedHistory.push(...focused);
                        Logger_1.Logger.info(`🔍 P3 主动检索: 从卸荷历史中检索到 ${focused.length} 条相关消息`, 'ContextManager');
                    }
                }
                catch {
                    // 主动检索失败不影响主流程
                }
            }
            messages.push(...truncatedHistory);
            this.entries.push({
                id: 'history',
                type: 'history',
                content: `${truncatedHistory.length} 条历史消息`,
                priority: 5,
                tokenEstimate: this.allocator.estimateTokens(truncatedHistory.map((m) => m.content || '').join('')),
                source: 'HistoryProvider',
            });
            const historyTokens = this.estimateMessageTokens(truncatedHistory);
            const historyBudget = allocation.history;
            if (historyTokens >
                historyBudget * this.compressionConfig.tokenUsageThreshold) {
                Logger_1.Logger.info(`🗜️ Token 使用率超阈值 (${((historyTokens / historyBudget) * 100).toFixed(0)}%)，触发自动压缩`, 'ContextManager');
                const compressionResult = this.compressHistory(messages, historyBudget);
                const historyIdx = messages.findIndex((m) => m.role !== 'system' && m.role !== 'user');
                if (historyIdx !== -1) {
                    const systemMsgs = messages.filter((m) => m.role === 'system');
                    const userInputMsg = messages.find((m) => m.role === 'user' && m.content === input.text);
                    messages.length = 0;
                    messages.push(...systemMsgs);
                    messages.push(...compressionResult.compressed.filter((m) => m.role !== 'system'));
                    if (userInputMsg) {
                        const existingUser = messages.find((m) => m.role === 'user' && m.content === input.text);
                        if (!existingUser) {
                            messages.push(userInputMsg);
                        }
                    }
                }
            }
        }
        catch {
            // 历史加载失败不影响主流程
        }
        // 6. User Input — 解析 @ 引用并内联展开到用户消息
        let finalUserContent = input.text;
        if (this.deps.referenceResolver) {
            try {
                const resolved = await this.deps.referenceResolver.resolve(input.text);
                if (resolved.hasReferences) {
                    if (resolved.resolvedContent) {
                        finalUserContent = `${resolved.cleanedInput}\n\n[引用内容]\n${resolved.resolvedContent}`;
                    }
                    else {
                        finalUserContent = resolved.cleanedInput;
                    }
                    Logger_1.Logger.info(`📎 引用解析: ${resolved.references.length} 个引用已内联`, 'ContextManager');
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`引用解析失败: ${err.message}`, 'ContextManager');
            }
        }
        const userInputAlreadyAdded = messages.some((m) => m.role === 'user' && m.content === input.text);
        if (!userInputAlreadyAdded) {
            messages.push({ role: 'user', content: finalUserContent });
        }
        Logger_1.Logger.info(`📋 上下文构建完成: ${messages.length} 条消息, ${this.entries.length} 个上下文条目`, 'ContextManager');
        return messages;
    }
    /**
     * H2: 按阶段构建优化上下文——每个阶段只注入所需信息，避免token浪费
     *
     * - planning: 宪法 + 最近对话 + 输入（不含环境、语气、记忆）
     * - execution: 宪法 + 语气 + 环境 + 记忆 + 完整对话（含进化经验）
     */
    async buildPhaseContext(input, phase) {
        const messages = [];
        this.entries.length = 0;
        // Constitution prompt (both phases)
        if (this.deps.constitutionalBuilder) {
            try {
                const constitution = await this.deps.constitutionalBuilder.buildConstitutionPrompt();
                messages.push({ role: 'system', content: constitution });
            }
            catch {
                messages.push({ role: 'system', content: '你是一个智能助手。' });
            }
        }
        else {
            messages.push({ role: 'system', content: '你是一个智能助手。' });
        }
        if (phase === 'execution') {
            // Persona summary (only for execution, not planning)
            if (this.deps.personaCore) {
                try {
                    const persona = this.deps.personaCore.buildPersonaSummary();
                    if (persona) {
                        messages.push({
                            role: 'system',
                            content: `[语气基调]\n${persona}`,
                        });
                    }
                }
                catch {
                    // non-critical
                }
            }
            // Environment context (only for execution)
            if (this.deps.dynamicContext) {
                try {
                    const env = this.deps.dynamicContext.getDynamicContext();
                    if (env) {
                        messages.push({ role: 'system', content: `[当前环境]\n${env}` });
                    }
                }
                catch {
                    // non-critical
                }
            }
            // Evolution examples (only for execution)
            if (this.deps.evolutionExamples) {
                try {
                    const examples = this.deps.evolutionExamples.getPromptExamples();
                    if (examples?.length) {
                        const text = examples
                            .slice(0, 2)
                            .map((e) => `- 触发: ${e.trigger} → 修正: ${e.correction}`)
                            .join('\n');
                        if (text) {
                            messages.push({ role: 'system', content: `[进化经验]\n${text}` });
                        }
                    }
                }
                catch {
                    // non-critical
                }
            }
            // Memory injection (only for execution)
            if (this.deps.memoryInjector) {
                try {
                    const memories = await this.deps.memoryInjector.autoRetrieveMemories(input.text);
                    if (memories?.length) {
                        const memoryContext = memories.slice(0, 5).join('\n');
                        if (memoryContext) {
                            messages.push({
                                role: 'system',
                                content: `[相关记忆]\n${memoryContext}`,
                            });
                        }
                    }
                }
                catch {
                    // non-critical
                }
            }
        }
        // Conversation history (planning=less, execution=more)
        if (this.deps.historyProvider) {
            try {
                const history = phase === 'planning'
                    ? this.deps.historyProvider.getRecentHistory(3)
                    : this.deps.historyProvider.getRecentHistory(10);
                if (history?.length) {
                    messages.push(...history);
                }
                // P3: 主动检索 — 从卸荷历史中检索与当前任务相关的上下文（仅执行阶段）
                if (phase === 'execution' && this.offloadedHistory.length > 0) {
                    try {
                        const proactiveContext = this.activelyRetrieveContext(this.offloadedHistory, input.text);
                        if (proactiveContext.length > 0) {
                            const proactiveBudget = 600;
                            const focused = this.focusByAttention(proactiveContext, input.text, proactiveBudget);
                            messages.push(...focused);
                            Logger_1.Logger.info(`🔍 P3 主动检索(buildPhaseContext): 检索到 ${focused.length} 条相关消息`, 'ContextManager');
                        }
                    }
                    catch {
                        // 主动检索失败不影响主流程
                    }
                }
            }
            catch {
                // non-critical
            }
        }
        // User input
        messages.push({ role: 'user', content: input.text });
        // 自动缩减：当消息超过阈值时触发压缩
        const totalTokens = this.estimateMessageTokens(messages);
        const budget = this.allocator.allocate();
        const totalBudget = budget.systemPrompt +
            budget.dynamicContext +
            budget.memory +
            budget.history +
            budget.reserve;
        if (totalTokens >
            totalBudget * this.compressionConfig.tokenUsageThreshold) {
            Logger_1.Logger.info(`🗜️ buildPhaseContext Token 超阈值 (${totalTokens} > ${Math.round(totalBudget * this.compressionConfig.tokenUsageThreshold)})，触发自动缩减`, 'ContextManager');
            const compressionResult = this.compressHistory(messages, totalBudget);
            if (compressionResult.compressed.length < messages.length ||
                compressionResult.compressedTokenCount < totalTokens) {
                messages.length = 0;
                messages.push(...compressionResult.compressed);
                // 确保用户输入仍在
                const hasUserInput = messages.some((m) => m.role === 'user' && m.content === input.text);
                if (!hasUserInput) {
                    messages.push({ role: 'user', content: input.text });
                }
            }
        }
        return messages;
    }
    /**
     * 获取上下文条目
     */
    getEntries() {
        return [...this.entries];
    }
    /**
     * 获取 Token 预算分配
     */
    getAllocation() {
        return this.allocator.allocate();
    }
    /**
     * 从用户输入推断场景（当 sceneRecognizer 不可用时使用）
     * 进化闭环：场景推断 → 匹配语气参数 → 注入 system prompt
     */
    inferSceneFromInput(input) {
        const text = input.toLowerCase();
        if (/代码|编程|开发|调试|bug|函数|接口|api|重构|部署/.test(text))
            return 'development';
        if (/工作|项目|排期|会议|汇报|方案|需求|上线/.test(text))
            return 'work';
        if (/难过|烦|累|焦虑|压力|不开心|心情|崩溃/.test(text))
            return 'comfort';
        if (/你好|早上好|晚安|嗨|hello|hi/.test(text))
            return 'greeting';
        if (/简报|总结|日报|周报|进度/.test(text))
            return 'briefing';
        return 'daily';
    }
    // ==================== Phase 2: 上下文压缩、摘要、卸荷 ====================
    /**
     * 上下文压缩: 当 Token 预算超阈值时自动合并早期对话为摘要
     *
     * @param messages - 当前消息列表
     * @param targetTokenCount - 目标 Token 数
     * @returns 压缩结果
     */
    compressHistory(messages, targetTokenCount) {
        const originalTokens = this.estimateMessageTokens(messages);
        if (originalTokens <= targetTokenCount) {
            return {
                compressed: [...messages],
                originalTokenCount: originalTokens,
                compressedTokenCount: originalTokens,
                compressionRatio: 1.0,
                strategy: 'none_needed',
            };
        }
        const systemMessages = messages.filter((m) => m.role === 'system');
        const nonSystemMessages = messages.filter((m) => m.role !== 'system');
        const systemTokens = this.estimateMessageTokens(systemMessages);
        const availableForHistory = targetTokenCount - systemTokens;
        if (availableForHistory <= 0) {
            const truncatedSystem = systemMessages.map((m) => this.truncateMessage(m, Math.floor(targetTokenCount / systemMessages.length)));
            const finalTokens = this.estimateMessageTokens(truncatedSystem);
            return {
                compressed: truncatedSystem,
                originalTokenCount: originalTokens,
                compressedTokenCount: finalTokens,
                compressionRatio: finalTokens / originalTokens,
                strategy: 'system_only_truncated',
            };
        }
        const retainedCount = Math.max(this.compressionConfig.minRetainedHistory, Math.floor(nonSystemMessages.length * 0.3));
        const recentMessages = nonSystemMessages.slice(-retainedCount);
        const oldMessages = nonSystemMessages.slice(0, nonSystemMessages.length - retainedCount);
        let summaryMessage = null;
        if (oldMessages.length > 0) {
            const summaryResult = this.summarizeContext(oldMessages, availableForHistory * 2);
            summaryMessage = summaryResult.summary;
        }
        const compressed = [...systemMessages];
        if (summaryMessage) {
            compressed.push(summaryMessage);
        }
        compressed.push(...recentMessages);
        const finalTokens = this.estimateMessageTokens(compressed);
        return {
            compressed,
            originalTokenCount: originalTokens,
            compressedTokenCount: finalTokens,
            compressionRatio: finalTokens / originalTokens,
            strategy: 'compress_early_keep_recent',
        };
    }
    /**
     * 上下文摘要: LLM 驱动的对话摘要，回退到规则引擎
     *
     * @param messages - 需要摘要的消息列表
     * @param maxSummaryLength - 摘要最大长度
     * @returns 摘要结果
     */
    async summarizeHistory(messages, maxSummaryLength = 1000) {
        if (this.deps.llm) {
            try {
                const conversationText = messages
                    .map((m) => `${m.role}: ${m.content || ''}`)
                    .join('\n');
                const prompt = `请对以下对话历史生成简洁的摘要，保留关键信息和决策点。摘要应包含：
1. 用户的主要需求
2. 已完成的关键操作
3. 重要的中间结果
4. 待解决的问题

对话历史:
${conversationText.substring(0, 4000)}

请直接输出摘要内容，不要包含其他格式。`;
                const llmSummary = await this.deps.llm.chat(prompt);
                const truncatedSummary = llmSummary.substring(0, maxSummaryLength);
                const keyPoints = this.extractKeyPoints(messages);
                if (this.deps.longTermMemory) {
                    try {
                        await this.deps.longTermMemory.store(truncatedSummary, {
                            type: 'conversation_summary',
                            messageCount: messages.length,
                            timestamp: Date.now(),
                        });
                        Logger_1.Logger.info('📝 对话摘要已存储到长期记忆', 'ContextManager');
                    }
                    catch (err) {
                        Logger_1.Logger.warn(`摘要存储失败: ${err.message}`, 'ContextManager');
                    }
                }
                return {
                    summary: {
                        role: 'system',
                        content: `【对话摘要(LLM)】\n${truncatedSummary}`,
                    },
                    originalCount: messages.length,
                    summaryLength: truncatedSummary.length,
                    keyPoints,
                };
            }
            catch (err) {
                Logger_1.Logger.warn(`LLM 摘要生成失败，回退到规则引擎: ${err.message}`, 'ContextManager');
            }
        }
        return this.summarizeContext(messages, maxSummaryLength);
    }
    /**
     * 上下文卸荷: LRU 策略 + 文件系统卸荷索引
     *
     * @param messages - 需要卸荷的消息列表
     * @param keepCount - 保留的消息条数
     * @param strategy - 卸荷策略
     * @returns 活跃消息和卸荷消息
     */
    offloadHistory(messages, keepCount = 10, strategy = 'oldest_first') {
        const nonSystemMessages = messages.filter((m) => m.role !== 'system');
        const systemMessages = messages.filter((m) => m.role === 'system');
        let activeNonSystem;
        let offloaded;
        switch (strategy) {
            case 'oldest_first':
                activeNonSystem = nonSystemMessages.slice(-keepCount);
                offloaded = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
                break;
            case 'least_relevant':
                activeNonSystem = this.selectByLruRelevance(nonSystemMessages, keepCount);
                offloaded = nonSystemMessages.filter((m) => !activeNonSystem.includes(m));
                break;
            case 'compress_and_summarize': {
                const toOffload = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
                activeNonSystem = nonSystemMessages.slice(-keepCount);
                if (toOffload.length > 0) {
                    const summaryResult = this.summarizeContext(toOffload);
                    if (summaryResult.summary) {
                        activeNonSystem.unshift(summaryResult.summary);
                    }
                }
                offloaded = toOffload;
                break;
            }
            default:
                activeNonSystem = nonSystemMessages.slice(-keepCount);
                offloaded = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
        }
        this.offloadedHistory.push(...offloaded);
        if (this.deps.offloadDir) {
            this.persistOffloadedMessages(offloaded);
        }
        Logger_1.Logger.info(`📦 上下文卸荷完成: 保留 ${activeNonSystem.length} 条, 卸荷 ${offloaded.length} 条`, 'ContextManager');
        return {
            active: [...systemMessages, ...activeNonSystem],
            offloaded,
        };
    }
    // ==================== 原有功能: 上下文压缩、摘要、卸荷 ====================
    /**
     * 上下文压缩: 减少消息长度但保留核心语义
     */
    compressContext(messages, targetTokenCount) {
        const originalTokens = this.estimateMessageTokens(messages);
        if (originalTokens <= targetTokenCount) {
            return {
                compressed: [...messages],
                originalTokenCount: originalTokens,
                compressedTokenCount: originalTokens,
                compressionRatio: 1.0,
                strategy: 'none_needed',
            };
        }
        const compressed = [];
        let currentTokens = 0;
        const systemMessages = messages.filter((m) => m.role === 'system');
        for (const msg of systemMessages) {
            const msgTokens = this.estimateMessageTokens([msg]);
            if (currentTokens + msgTokens <= targetTokenCount) {
                compressed.push(msg);
                currentTokens += msgTokens;
            }
            else {
                const truncated = this.truncateMessage(msg, targetTokenCount - currentTokens);
                compressed.push(truncated);
                currentTokens = targetTokenCount;
                break;
            }
        }
        const historyMessages = messages
            .filter((m) => m.role !== 'system')
            .reverse();
        const selectedHistory = [];
        for (const msg of historyMessages) {
            const msgTokens = this.estimateMessageTokens([msg]);
            if (currentTokens + msgTokens <= targetTokenCount) {
                selectedHistory.push(msg);
                currentTokens += msgTokens;
            }
            else {
                const compressedMsg = this.compressSingleMessage(msg);
                const compressedTokens = this.estimateMessageTokens([compressedMsg]);
                if (currentTokens + compressedTokens <= targetTokenCount) {
                    selectedHistory.push(compressedMsg);
                    currentTokens += compressedTokens;
                }
            }
        }
        selectedHistory.reverse();
        compressed.push(...selectedHistory);
        const finalTokens = this.estimateMessageTokens(compressed);
        return {
            compressed,
            originalTokenCount: originalTokens,
            compressedTokenCount: finalTokens,
            compressionRatio: finalTokens / originalTokens,
            strategy: 'truncate_and_compress',
        };
    }
    /**
     * 上下文摘要: 生成对话历史的摘要（规则引擎版本）
     */
    summarizeContext(messages, maxSummaryLength = 1000) {
        const keyPoints = this.extractKeyPoints(messages);
        const userMessages = messages.filter((m) => m.role === 'user');
        const assistantMessages = messages.filter((m) => m.role === 'assistant');
        const summaryContent = `【对话摘要】
本次会话共 ${messages.length} 条消息
- 用户消息: ${userMessages.length} 条
- 助手回复: ${assistantMessages.length} 条
- 对话时间跨度: ${this.estimateTimeSpan(messages)}

关键主题:
${keyPoints.slice(-5).join('\n')}`;
        const truncatedSummary = summaryContent.substring(0, maxSummaryLength);
        return {
            summary: {
                role: 'system',
                content: truncatedSummary,
            },
            originalCount: messages.length,
            summaryLength: truncatedSummary.length,
            keyPoints,
        };
    }
    /**
     * 上下文卸荷: 将旧消息移动到 "卸荷" 存储（兼容旧接口）
     */
    offloadOldMessages(messages, keepCount = 10, strategy = 'oldest_first') {
        return this.offloadHistory(messages, keepCount, strategy);
    }
    /**
     * 从卸荷存储中检索消息（支持 LRU 访问更新）
     */
    retrieveOffloadedMessages(keywords, limit = 20) {
        let result = [...this.offloadedHistory].reverse();
        if (keywords && keywords.length > 0) {
            result = result.filter((msg) => keywords.some((kw) => msg.content?.toLowerCase().includes(kw.toLowerCase())));
            for (const kw of keywords) {
                for (const entry of this.offloadIndex) {
                    if (entry.keywords.some((k) => k.toLowerCase().includes(kw.toLowerCase()))) {
                        entry.accessCount++;
                        entry.lastAccessed = Date.now();
                        this.lruAccessMap.set(entry.messageId, entry.lastAccessed);
                    }
                }
            }
        }
        if (this.deps.offloadDir && this.offloadIndex.length > 0) {
            const fromDisk = this.retrieveFromDisk(keywords, limit);
            if (fromDisk.length > 0) {
                result = [...result, ...fromDisk];
            }
        }
        return result.slice(0, limit);
    }
    /**
     * 设置压缩阈值配置
     */
    setCompressionConfig(config) {
        this.compressionConfig = { ...this.compressionConfig, ...config };
    }
    /**
     * 获取卸荷索引
     */
    getOffloadIndex() {
        return [...this.offloadIndex];
    }
    // ==================== 辅助方法 ====================
    /**
     * 估算消息的 token 数
     */
    estimateMessageTokens(messages) {
        return messages.reduce((total, msg) => {
            return total + this.allocator.estimateTokens(msg.content || '');
        }, 0);
    }
    /**
     * 截断单条消息
     */
    truncateMessage(msg, maxTokens) {
        const charLimit = maxTokens * 2;
        const content = msg.content || '';
        if (content.length <= charLimit)
            return msg;
        return {
            ...msg,
            content: content.substring(0, charLimit) + '...(内容已截断)',
        };
    }
    /**
     * 压缩单条消息
     */
    compressSingleMessage(msg) {
        const content = msg.content || '';
        const compressed = content
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, Math.max(100, content.length / 2));
        return {
            ...msg,
            content: compressed.length < content.length
                ? `${compressed}...(已压缩)`
                : compressed,
        };
    }
    /**
     * 估算对话的时间跨度
     */
    estimateTimeSpan(_messages) {
        return '未知';
    }
    /**
     * 从消息中提取关键点
     */
    extractKeyPoints(messages) {
        const keyPoints = [];
        const userMessages = messages.filter((m) => m.role === 'user');
        for (const msg of userMessages.slice(-10)) {
            if (msg.content && msg.content.length > 0) {
                keyPoints.push(`用户: ${msg.content.substring(0, 100)}`);
            }
        }
        return keyPoints;
    }
    /**
     * LRU 相关性选择：根据访问频率和最近访问时间选择保留消息
     */
    selectByLruRelevance(messages, keepCount) {
        if (messages.length <= keepCount)
            return [...messages];
        const scored = messages.map((msg, idx) => {
            const content = msg.content || '';
            const recencyScore = idx / messages.length;
            const lengthScore = Math.min(content.length / 500, 1);
            const totalScore = recencyScore * 0.6 + lengthScore * 0.4;
            return { msg, score: totalScore, idx };
        });
        scored.sort((a, b) => b.score - a.score);
        const selectedIndices = new Set(scored.slice(0, keepCount).map((s) => s.idx));
        return messages.filter((_, idx) => selectedIndices.has(idx));
    }
    /**
     * 将卸荷消息持久化到文件系统
     */
    persistOffloadedMessages(messages) {
        const offloadDir = this.deps.offloadDir;
        if (!offloadDir)
            return;
        try {
            if (!fs_1.default.existsSync(offloadDir)) {
                fs_1.default.mkdirSync(offloadDir, { recursive: true });
            }
            for (const msg of messages) {
                const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                const filePath = path_1.default.join(offloadDir, `${messageId}.json`);
                const keywords = this.extractKeywords(msg.content || '');
                fs_1.default.writeFileSync(filePath, JSON.stringify(msg, null, 2), 'utf-8');
                this.offloadIndex.push({
                    messageId,
                    timestamp: Date.now(),
                    accessCount: 0,
                    lastAccessed: Date.now(),
                    filePath,
                    keywords,
                });
                this.lruAccessMap.set(messageId, Date.now());
            }
            this.saveOffloadIndex();
        }
        catch (err) {
            Logger_1.Logger.error(`卸荷消息持久化失败: ${err.message}`, err, 'ContextManager');
        }
    }
    /**
     * 从磁盘检索卸荷消息
     */
    retrieveFromDisk(keywords, limit = 20) {
        const results = [];
        let indexEntries = [...this.offloadIndex];
        if (keywords && keywords.length > 0) {
            indexEntries = indexEntries.filter((entry) => keywords.some((kw) => entry.keywords.some((k) => k.toLowerCase().includes(kw.toLowerCase()))));
        }
        indexEntries.sort((a, b) => b.lastAccessed - a.lastAccessed);
        for (const entry of indexEntries.slice(0, limit)) {
            try {
                if (fs_1.default.existsSync(entry.filePath)) {
                    const raw = fs_1.default.readFileSync(entry.filePath, 'utf-8');
                    const msg = JSON.parse(raw);
                    results.push(msg);
                    entry.accessCount++;
                    entry.lastAccessed = Date.now();
                    this.lruAccessMap.set(entry.messageId, entry.lastAccessed);
                }
            }
            catch {
                // 单个文件读取失败不影响整体
            }
        }
        return results;
    }
    /**
     * 从消息内容提取关键词
     */
    extractKeywords(content) {
        const keywords = [];
        const stopWords = new Set([
            '的',
            '了',
            '是',
            '在',
            '我',
            '你',
            '他',
            '她',
            '它',
            '们',
            '这',
            '那',
            '有',
            '不',
            '就',
            '也',
            '都',
            '而',
            '及',
            '与',
            '或',
            'the',
            'a',
            'an',
            'is',
            'are',
            'was',
            'were',
            'be',
            'been',
            'being',
            'have',
            'has',
            'had',
            'do',
            'does',
            'did',
            'will',
            'would',
            'could',
            'should',
            'may',
            'might',
            'can',
            'shall',
            'to',
            'of',
            'in',
            'for',
            'on',
            'with',
            'at',
            'by',
            'from',
            'as',
            'into',
            'through',
            'during',
            'before',
            'after',
            'above',
            'below',
            'between',
            'out',
            'off',
            'over',
            'under',
            'again',
            'further',
            'then',
            'once',
            'and',
            'but',
            'or',
            'nor',
            'not',
            'so',
            'if',
            'it',
            'its',
        ]);
        const words = content.split(/[\s,，。.!！?？;；:：、\n]+/);
        for (const word of words) {
            const trimmed = word.trim().toLowerCase();
            if (trimmed.length >= 2 && !stopWords.has(trimmed)) {
                keywords.push(trimmed);
            }
        }
        return [...new Set(keywords)].slice(0, 20);
    }
    /**
     * 保存卸荷索引到磁盘
     */
    saveOffloadIndex() {
        const offloadDir = this.deps.offloadDir;
        if (!offloadDir)
            return;
        try {
            if (!fs_1.default.existsSync(offloadDir)) {
                fs_1.default.mkdirSync(offloadDir, { recursive: true });
            }
            const indexPath = path_1.default.join(offloadDir, 'offload-index.json');
            fs_1.default.writeFileSync(indexPath, JSON.stringify(this.offloadIndex, null, 2), 'utf-8');
        }
        catch (err) {
            Logger_1.Logger.error(`卸荷索引保存失败: ${err.message}`, err, 'ContextManager');
        }
    }
    /**
     * 从磁盘加载卸荷索引
     */
    loadOffloadIndex() {
        const offloadDir = this.deps.offloadDir;
        if (!offloadDir)
            return;
        try {
            const indexPath = path_1.default.join(offloadDir, 'offload-index.json');
            if (fs_1.default.existsSync(indexPath)) {
                const raw = fs_1.default.readFileSync(indexPath, 'utf-8');
                this.offloadIndex = JSON.parse(raw);
                for (const entry of this.offloadIndex) {
                    this.lruAccessMap.set(entry.messageId, entry.lastAccessed);
                }
                Logger_1.Logger.info(`📦 已加载 ${this.offloadIndex.length} 条卸荷索引`, 'ContextManager');
            }
        }
        catch {
            // 索引加载失败不影响主流程
        }
    }
    /**
     * P3: 主动检索 — 基于当前任务从历史消息中检索相关上下文
     */
    activelyRetrieveContext(messages, currentTask) {
        const taskKeywords = this.extractTaskKeywords(currentTask);
        if (taskKeywords.length === 0)
            return [];
        const retrieved = [];
        for (const msg of messages) {
            const content = msg.content || '';
            const contentLower = content.toLowerCase();
            const relevanceScore = taskKeywords.filter((k) => contentLower.includes(k.toLowerCase())).length;
            if (relevanceScore > 0) {
                retrieved.push(msg);
            }
        }
        return retrieved;
    }
    /**
     * 提取任务关键词（用于主动检索）
     */
    extractTaskKeywords(task) {
        const stopWords = new Set([
            '的',
            '了',
            '在',
            '是',
            '我',
            '有',
            '和',
            '就',
            '不',
            '人',
            '都',
            '一',
            '一个',
            '上',
            '也',
            '很',
            '到',
            '说',
            '要',
            '去',
            '你',
            '会',
            '着',
            '没有',
            '看',
            '好',
            '自己',
            '这',
            '他',
            '她',
            'the',
            'a',
            'an',
            'is',
            'are',
            'was',
            'were',
            'to',
            'of',
            'in',
            'for',
            'on',
            'with',
            'at',
            'by',
            'from',
            'as',
            'and',
            'or',
            'not',
        ]);
        const keywords = task
            .toLowerCase()
            .split(/[\s\-_.,;:!?，。！？、()（）]+/)
            .filter((w) => w.length > 1 && !stopWords.has(w));
        // 中文2字切分：将长度>2的中文token切分为2字片段
        const result = [];
        for (const kw of keywords) {
            if (/[\u4e00-\u9fa5]/.test(kw) && kw.length > 2) {
                for (let i = 0; i < kw.length - 1; i++) {
                    result.push(kw.substring(i, i + 2));
                }
            }
            else {
                result.push(kw);
            }
        }
        return result;
    }
    /**
     * P3: 注意力聚焦 — 计算每条消息的注意力权重
     */
    calculateAttentionWeights(messages, currentTask) {
        const taskKeywords = this.extractTaskKeywords(currentTask);
        const totalMessages = messages.length;
        return messages.map((msg, index) => {
            let weight = 0;
            const content = msg.content || '';
            const contentLower = content.toLowerCase();
            // 1. 关键词匹配度（0-0.6，主导因素 — 相关性是注意力聚焦的核心）
            const matchCount = taskKeywords.filter((k) => contentLower.includes(k.toLowerCase())).length;
            weight += (matchCount / Math.max(taskKeywords.length, 1)) * 0.6;
            // 2. 位置权重（0-0.1）
            const positionWeight = (index + 1) / totalMessages;
            weight += positionWeight * 0.1;
            // 3. 角色权重（0-0.1）
            if (msg.role === 'user') {
                weight += 0.1;
            }
            // 4. 信息密度（0-0.2）
            const hasPath = /\/[a-zA-Z0-9_\-\/]+/.test(content);
            const hasError = /error|fail|错误|失败|exception/i.test(content);
            const hasNumber = /\d+/.test(content);
            if (hasPath)
                weight += 0.08;
            if (hasError)
                weight += 0.07;
            if (hasNumber)
                weight += 0.05;
            return Math.min(weight, 1.0);
        });
    }
    /**
     * P3: 注意力聚焦 — 在token预算内保留高权重消息
     */
    focusByAttention(messages, currentTask, tokenBudget) {
        const weights = this.calculateAttentionWeights(messages, currentTask);
        const indexed = messages.map((msg, index) => ({
            msg,
            weight: weights[index],
            originalIndex: index,
        }));
        indexed.sort((a, b) => b.weight - a.weight);
        const selected = [];
        let usedTokens = 0;
        for (const item of indexed) {
            const content = item.msg.content || '';
            const msgTokens = Math.ceil(content.length / 4);
            if (usedTokens + msgTokens > tokenBudget)
                continue;
            selected.push(item.msg);
            usedTokens += msgTokens;
        }
        const selectedSet = new Set(selected);
        return messages.filter((m) => selectedSet.has(m));
    }
    /**
     * 上下文围栏 — 限制消息窗口范围
     *
     * 仿 Hermes fence_context 设计：在长对话中划定"可见窗口"，
     * 避免 LLM 被过多历史干扰，同时保留 system 消息。
     *
     * @param messages - 完整消息列表
     * @param options - 围栏选项
     * @returns 围栏内的消息子集
     */
    fenceContext(messages, options = {}) {
        if (messages.length === 0)
            return [];
        const systemMsgs = messages.filter((m) => m.role === 'system');
        const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
        let fenced;
        if (options.fromEnd !== undefined && options.fromEnd > 0) {
            const start = Math.max(0, nonSystemMsgs.length - options.fromEnd);
            fenced = nonSystemMsgs.slice(start);
        }
        else {
            const from = Math.max(0, options.from ?? 0);
            const to = Math.min(nonSystemMsgs.length, options.to ?? nonSystemMsgs.length);
            fenced = nonSystemMsgs.slice(from, to);
        }
        // maxTokens 裁剪：从尾部移除直到满足 token 限制
        if (options.maxTokens && options.maxTokens > 0) {
            let totalTokens = 0;
            const trimmed = [];
            for (const msg of fenced) {
                const msgTokens = this.allocator.estimateTokens(msg.content || '');
                if (totalTokens + msgTokens > options.maxTokens)
                    break;
                trimmed.push(msg);
                totalTokens += msgTokens;
            }
            fenced = trimmed;
        }
        // system 消息始终保留在开头
        return [...systemMsgs, ...fenced];
    }
}
exports.ContextManager = ContextManager;
