"use strict";
/**
 * jiabaixing 拟人化交互引擎 v2
 * 彻底消除模板化回复，完全由 LLM + 记忆上下文 + 人格规则驱动
 *
 * 核心变化：
 * - 删除所有 responseTemplates 硬编码模板
 * - 删除 getRandomTemplate / generateResponseBasedOnUserInput 等模板方法
 * - 所有回复通过 DialogueGenerator 生成，PersonaRules 只做语气微调
 * - 深度集成记忆：自动提取用户画像、情绪模式、行为偏好注入上下文
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InteractionEngine = void 0;
const LLMContextBuilder_1 = require("../memory/LLMContextBuilder");
const UserProfile_1 = require("../memory/UserProfile");
const SpeechRecognizer_1 = require("../multimodal/SpeechRecognizer");
const PersonaRules_1 = require("../persona/PersonaRules");
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
const ContinuousDialogManager_1 = require("./ContinuousDialogManager");
const EmojiManager_1 = require("./EmojiManager");
const SpeechSynthesizer_1 = require("./SpeechSynthesizer");
/**
 * 交互引擎类 v2
 * 模板已死，LLM + 记忆永生
 */
class InteractionEngine {
    constructor(userProfile, dialogueGenerator) {
        this.personaEngine = null;
        this.voiceprintRecognizer = null;
        this.interactionHistory = [];
        this.MAX_INTERACTION_HISTORY = 200;
        this.isSpeaking = false;
        this.core = null;
        this.dialogueGenerator = null;
        this.memoryEngine = null;
        // v2: 语音会话管理
        this.voiceSession = null;
        this.personaRules = new PersonaRules_1.PersonaRules();
        this.personaEngine = null;
        this.speechSynthesizer = new SpeechSynthesizer_1.SpeechSynthesizer();
        this.emojiManager = new EmojiManager_1.EmojiManager();
        // VoiceprintRecognizer removed in v4.0
        this.continuousDialogManager = new ContinuousDialogManager_1.ContinuousDialogManager();
        this.userProfile = userProfile || new UserProfile_1.UserProfile();
        this.dialogueGenerator = dialogueGenerator || null;
        this.contextBuilder = new LLMContextBuilder_1.LLMContextBuilder();
        // v2: 初始化多模态处理器（复用现有类）
        this.speechRecognizer = new SpeechRecognizer_1.SpeechRecognizer();
        this.setupEventBusListeners();
    }
    /**
     * 设置对话生成器（由 JiabaixingCore 注入）
     */
    setDialogueGenerator(generator) {
        this.dialogueGenerator = generator;
    }
    /**
     * 安全获取表情管理器实例（优雅降级）
     */
    async safeGenerateEmoji(options) {
        if (!this.emojiManager || !this.emojiManager.isInitialized()) {
            return '';
        }
        try {
            return await this.emojiManager.generateEmoji(options);
        }
        catch (error) {
            Logger_1.Logger.warn('⚠️ EmojiManager generateEmoji 降级处理:', error.message, 'InteractionEngine');
            return '';
        }
    }
    /**
     * 设置核心引擎引用
     */
    setCore(core) {
        this.core = core;
    }
    /**
     * 注入记忆引擎（由 bootstrap initInteraction 调用）
     * 使交互引擎能检索用户历史记忆，实现个性化话术
     */
    setMemoryEngine(memoryEngine) {
        this.memoryEngine = memoryEngine;
        this.continuousDialogManager.setMemoryEngine(memoryEngine);
        Logger_1.Logger.info('💾 MemoryEngine 已注入 InteractionEngine + ContinuousDialogManager', 'InteractionEngine');
    }
    /**
     * 初始化交互引擎
     */
    async initialize() {
        // PersonaEngine removed in v4.0
        await this.speechSynthesizer.initialize();
        await this.emojiManager.initialize();
        // VoiceprintRecognizer removed in v4.0
        await this.continuousDialogManager.initialize();
        await this.userProfile.load();
    }
    /**
     * 生成任务执行前的回复
     * 不再使用模板，而是通过 DialogueGenerator 生成自然回复
     */
    async generatePreExecutionResponse(taskGraph, plan, emotion, scene) {
        let response = '';
        if (this.dialogueGenerator) {
            // 使用 LLM 生成自然的确认回复
            const sceneTag = scene || 'daily';
            const memoryContext = await this.retrieveMemoryEnrichedContext(taskGraph.getName() || '', sceneTag);
            const userProfileSummary = this.buildUserProfileSummary();
            const preExecPrompt = `用户刚刚要求我执行一个任务，预计需要 ${Math.ceil(plan.estimatedTime / 60)} 分钟。
任务名称：${taskGraph.getName() || '未指定'}

请生成一句简短，自然的确认回复。像一位专业的秘书确认收到任务一样。不要啰嗦。`;
            try {
                response = await this.dialogueGenerator.generate(preExecPrompt, sceneTag, memoryContext, userProfileSummary);
            }
            catch (err) {
                Logger_1.Logger.debug(`预执行确认生成失败，降级到极简确认: ${err?.message}`, 'InteractionEngine');
                response =
                    plan.estimatedTime < 10
                        ? '好的，马上处理。'
                        : `收到，预计需要 ${Math.ceil(plan.estimatedTime / 60)} 分钟。`;
            }
        }
        else {
            // 无 DialogueGenerator 时的极简降级
            response =
                plan.estimatedTime < 10
                    ? '好的，马上处理。'
                    : `收到，预计需要 ${Math.ceil(plan.estimatedTime / 60)} 分钟。`;
        }
        // 如果需要情绪支持，添加情绪安抚内容
        if (plan.needEmotionSupport && plan.emotionSupportContent) {
            response = `${plan.emotionSupportContent}\n${response}`;
        }
        // 应用人设规则（语气微调，非硬拦截）
        const finalResponse = this.personaRules.adjustTone(response, scene || 'daily').adjustedContent;
        // 输出回复
        await this.outputResponseInternal(finalResponse, emotion, scene);
        // 保存到交互历史
        this.interactionHistory.push({
            type: 'pre_execution',
            content: finalResponse,
            emotion,
            scene,
            timestamp: new Date(),
        });
    }
    /**
     * 生成任务执行结果的回复
     * 完全基于 LLM + 记忆上下文，消除模板
     */
    async generateResultResponse(result, emotion, scene, memoryContext) {
        // 获取用户画像信息
        const userBasicInfo = this.userProfile.getBasicInfo();
        const userDevHabits = this.userProfile.getDevelopmentHabits();
        const userEmotionPatterns = this.userProfile.getEmotionalPatterns();
        // 获取最近的用户输入
        let userInput = '';
        if (this.interactionHistory.length > 0) {
            const lastInteraction = this.interactionHistory[this.interactionHistory.length - 1];
            if (lastInteraction.type === 'user_input') {
                userInput = lastInteraction.content;
            }
        }
        let response = '';
        // 优先使用 DialogueGenerator 生成回复
        if (this.dialogueGenerator) {
            try {
                const enrichedMemory = await this.retrieveMemoryEnrichedContext(userInput || '任务结果', scene.type);
                const memoryCtx = [
                    ...memoryContext.map((m) => {
                        const contentStr = typeof m.content === 'string'
                            ? m.content
                            : JSON.stringify(m.content);
                        return {
                            content: contentStr,
                            type: m.type || 'memory',
                            relevance: m.relevanceScore,
                        };
                    }),
                    ...enrichedMemory.filter((em) => !memoryContext.some((mc) => (typeof mc.content === 'string'
                        ? mc.content
                        : JSON.stringify(mc.content)) === em.content)),
                ];
                const userProfileSummary = {
                    name: userBasicInfo.name,
                    preferredLanguage: userDevHabits.preferredLanguages[0],
                    preferredFrameworks: userDevHabits.preferredFrameworks,
                    recentTopics: [],
                    behaviorHints: [
                        ...userEmotionPatterns.commonEmotions.map((e) => `常表达${e.type}情绪`),
                        userDevHabits.codingStyle
                            ? `编码风格: ${JSON.stringify(userDevHabits.codingStyle)}`
                            : '',
                    ].filter(Boolean),
                };
                // 构建结果摘要作为用户输入
                const resultSummary = this.summarizeResult(result);
                const prompt = userInput
                    ? `用户之前说："${userInput}"\n\n任务执行结果：${resultSummary}\n\n请根据结果生成回复。`
                    : `任务执行结果：${resultSummary}\n\n请生成回复。`;
                response = await this.dialogueGenerator.generate(prompt, scene.type, memoryCtx, userProfileSummary);
            }
            catch (error) {
                Logger_1.Logger.warn(`DialogueGenerator 失败，使用降级回复: ${error.message}`, 'InteractionEngine');
                response = this.summarizeResult(result);
            }
        }
        else {
            // 无 DialogueGenerator 时的降级
            response = this.summarizeResult(result);
        }
        // 应用人设规则
        const finalResponse = this.personaRules.adjustTone(response, scene.type).adjustedContent;
        // 输出回复
        await this.outputResponseInternal(finalResponse, emotion.type, scene.type);
        // 保存到交互历史
        this.interactionHistory.push({
            type: 'result',
            content: finalResponse,
            emotion: emotion.type,
            scene: scene.type,
            timestamp: new Date(),
        });
        return finalResponse;
    }
    /**
     * 格式化结果为自然语言摘要
     */
    summarizeResult(result) {
        if (!result)
            return '任务已完成。';
        const r = result;
        // 提取关键信息
        const parts = [];
        if (r.success === true) {
            parts.push('执行成功');
        }
        else if (r.success === false) {
            parts.push('执行未成功');
        }
        if (r.summary && typeof r.summary === 'string') {
            parts.push(r.summary);
        }
        if (r.message && typeof r.message === 'string') {
            parts.push(r.message);
        }
        if (r.output) {
            const outputStr = typeof r.output === 'string'
                ? r.output
                : JSON.stringify(r.output).substring(0, 200);
            if (outputStr && outputStr !== '{}') {
                parts.push(`输出: ${outputStr}`);
            }
        }
        if (parts.length > 1) {
            return parts.join('。') + '。';
        }
        return parts[0] || '任务已完成。';
    }
    /**
     * 为前端格式化结果（御姐秘书口吻）
     */
    async formatResultForOwner(result, taskDescription, _scene, emotion) {
        if (!this.dialogueGenerator) {
            return this.summarizeResult(result);
        }
        const memoryContext = this.buildMemoryContextFromHistory();
        const userProfileSummary = this.buildUserProfileSummary();
        const prompt = `我刚刚完成了一个任务：${taskDescription}
执行结果：${JSON.stringify(result, null, 2).substring(0, 800)}

请用自然、专业的语气向用户汇报结果。像一位可靠的秘书汇报工作一样。
要具体、有信息量，但不要说教。如果结果中有错误，客观说明，不要过度道歉。`;
        try {
            const response = await this.dialogueGenerator.generate(prompt, 'work', memoryContext, userProfileSummary);
            // 应用人设规则
            return this.personaRules.adjustTone(response, emotion || 'daily')
                .adjustedContent;
        }
        catch (err) {
            Logger_1.Logger.debug(`结果解释生成失败，降级到摘要: ${err?.message}`, 'InteractionEngine');
            return this.summarizeResult(result);
        }
    }
    /**
     * 生成对话式回复（供 JiabaixingCore 直接调用）
     * 这是主要的对外接口，完全基于 LLM + 记忆
     *
     * v2 优化：使用 LLMContextBuilder 智能筛选记忆
     */
    async generateChatResponse(input, scene, memoryContext, userProfileSummary) {
        if (!this.dialogueGenerator) {
            Logger_1.Logger.warn('DialogueGenerator 未注入，使用降级回复', 'InteractionEngine');
            return '我在。有什么可以帮你的？';
        }
        try {
            const enrichedContext = await this.retrieveMemoryEnrichedContext(input, scene);
            const mergedContext = [
                ...memoryContext,
                ...enrichedContext.filter((ec) => !memoryContext.some((mc) => mc.content === ec.content)),
            ];
            const memoryItems = mergedContext.map((mc) => ({
                id: `ctx_${Math.random().toString(36).substring(2, 11)}`,
                type: mc.type,
                content: mc.content,
                timestamp: mc.timestamp || new Date(),
                relevanceScore: mc.relevance,
            }));
            const builtContext = this.contextBuilder.buildContext(input, memoryItems, scene, userProfileSummary?.behaviorHints?.[0] || '平静');
            const optimizedContext = LLMContextBuilder_1.LLMContextBuilder.toMemoryContextItems(builtContext.memories);
            Logger_1.Logger.info(`🧠 记忆优化: ${memoryContext.length}→${optimizedContext.length}条 | ` +
                `去重${builtContext.deduplicatedCount} | 压缩${builtContext.compressedCount}`, 'InteractionEngine');
            const response = await this.dialogueGenerator.generate(input, scene, optimizedContext, userProfileSummary);
            // 应用人设规则（语气微调）
            const toneResult = this.personaRules.adjustTone(response, scene);
            // 保存到交互历史
            this.interactionHistory.push({
                type: 'chat_response',
                content: toneResult.adjustedContent,
                scene,
                timestamp: new Date(),
            });
            return toneResult.adjustedContent;
        }
        catch (error) {
            Logger_1.Logger.error('生成对话回复失败', error, 'InteractionEngine');
            return '抱歉，我暂时无法回应。请稍后再试。';
        }
    }
    /**
     * 生成主动关怀消息
     */
    async generateProactiveMessage(reason, scene, context, _memoryContext) {
        if (!this.dialogueGenerator) {
            return '有什么我可以帮你的吗？';
        }
        const memoryContext = await this.retrieveMemoryEnrichedContext(context, scene);
        const userProfileSummary = this.buildUserProfileSummary();
        const prompt = `作为用户的私人秘书，我需要主动发起一次交互。
原因：${reason}
上下文：${context}

请生成一条自然、不突兀的主动消息。像一位细心的秘书在合适的时机开口一样。
不要问"有什么可以帮你的"这种套话，而是基于上下文给出具体的关切或提醒。`;
        try {
            const response = await this.dialogueGenerator.generate(prompt, scene, memoryContext, userProfileSummary);
            return this.personaRules.adjustTone(response, scene).adjustedContent;
        }
        catch (err) {
            Logger_1.Logger.debug(`后续跟进生成失败: ${err?.message}`, 'InteractionEngine');
            return context || '有什么新情况需要我关注吗？';
        }
    }
    /**
     * 处理用户输入（供外部调用）
     */
    async processUserInput(input, emotion = '平静', scene = 'daily') {
        // 保存用户输入到历史
        this.interactionHistory.push({
            type: 'user_input',
            content: input,
            emotion,
            scene,
            timestamp: new Date(),
        });
        if (this.interactionHistory.length > this.MAX_INTERACTION_HISTORY) {
            this.interactionHistory = this.interactionHistory.slice(-this.MAX_INTERACTION_HISTORY);
        }
        // 如果有核心引擎，交给核心引擎处理
        if (this.core) {
            const result = await this.core.processInput(input, 'default');
            return result.response || '';
        }
        return '';
    }
    // ═══════════════════════════ v2: 多模态输入处理 ═══════════════════════════
    /**
     * 处理音频输入（语音转文字）
     */
    async processAudioInput(audioBuffer, _mimeType = 'audio/wav') {
        try {
            Logger_1.Logger.info('🎤 处理音频输入', 'InteractionEngine');
            // 使用现有的 SpeechRecognizer（已集成 Whisper）
            const result = await this.speechRecognizer.recognize(audioBuffer);
            Logger_1.Logger.info(`🎤 语音识别结果: ${result.text} (置信度: ${result.confidence?.toFixed(2)})`, 'InteractionEngine');
            return {
                text: result.text,
                confidence: result.confidence || 0,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 音频处理失败', error, 'InteractionEngine');
            return { text: '', confidence: 0 };
        }
    }
    /**
     * 处理图像输入
     */
    async processImageInput(imageBuffer, mimeType) {
        try {
            Logger_1.Logger.info('🖼️ 处理图像输入', 'InteractionEngine');
            const base64 = imageBuffer.toString('base64');
            Logger_1.Logger.info(`🖼️ 图像处理完成: ${mimeType}`, 'InteractionEngine');
            return {
                description: `图像 (${mimeType})`,
                base64,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 图像处理失败', error, 'InteractionEngine');
            return { description: '', base64: '' };
        }
    }
    /**
     * 处理文件输入
     */
    async processFileInput(fileBuffer, fileName, mimeType) {
        try {
            Logger_1.Logger.info(`📄 处理文件输入: ${fileName}`, 'InteractionEngine');
            const content = fileBuffer.toString('utf-8');
            const summary = `${fileName} (${mimeType})`;
            Logger_1.Logger.info(`📄 文件分析完成: ${fileName}`, 'InteractionEngine');
            return {
                content,
                summary,
            };
        }
        catch (error) {
            Logger_1.Logger.error(`❌ 文件处理失败: ${fileName}`, error, 'InteractionEngine');
            return { content: '', summary: `无法解析文件: ${fileName}` };
        }
    }
    // ═══════════════════════════ v2: 语音会话管理 ═══════════════════════════
    /**
     * 开始语音会话
     * @param language - 语音识别语言，默认 zh-CN
     * @returns 新创建的语音会话
     */
    startVoiceSession(language = 'zh-CN') {
        if (this.voiceSession) {
            Logger_1.Logger.warn(`语音会话已存在 (id=${this.voiceSession.id})，将先关闭旧会话`, 'InteractionEngine');
            this.stopVoiceSession();
        }
        const session = {
            id: `voice_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            status: 'idle',
            language,
            startedAt: new Date(),
            lastActivityAt: new Date(),
            turnCount: 0,
        };
        this.voiceSession = session;
        Logger_1.Logger.info(`🎤 语音会话已启动: id=${session.id}, language=${language}`, 'InteractionEngine');
        return { ...session };
    }
    /**
     * 停止语音会话
     */
    stopVoiceSession() {
        if (!this.voiceSession) {
            Logger_1.Logger.warn('没有活跃的语音会话可以停止', 'InteractionEngine');
            return;
        }
        Logger_1.Logger.info(`🎤 语音会话已停止: id=${this.voiceSession.id}, 轮次=${this.voiceSession.turnCount}`, 'InteractionEngine');
        this.voiceSession = null;
    }
    /**
     * 处理语音输入（STT → LLM → TTS 完整流程）
     * @param audioData - 音频数据 Buffer
     * @returns 语音交互处理结果，包含文本和可选的音频数据
     */
    async processVoiceInput(audioData) {
        const startTime = Date.now();
        if (!this.voiceSession) {
            Logger_1.Logger.error('没有活跃的语音会话，请先调用 startVoiceSession', new Error('NoVoiceSession'), 'InteractionEngine');
            throw new Error('没有活跃的语音会话，请先调用 startVoiceSession');
        }
        // 更新会话状态为 listening
        this.updateVoiceSessionStatus('listening');
        try {
            // Step 1: STT — 语音识别
            this.updateVoiceSessionStatus('processing');
            Logger_1.Logger.info('🎤 语音交互: 开始 STT 识别...', 'InteractionEngine');
            const sttResult = await this.speechRecognizer.recognize(audioData);
            if (!sttResult.text || sttResult.text.trim().length === 0) {
                Logger_1.Logger.warn('语音识别结果为空', 'InteractionEngine');
                this.updateVoiceSessionStatus('idle');
                return {
                    text: '',
                    duration: Date.now() - startTime,
                    turnCount: this.voiceSession.turnCount,
                };
            }
            Logger_1.Logger.info(`🎤 语音识别完成: "${sttResult.text}" (置信度: ${sttResult.confidence?.toFixed(2)})`, 'InteractionEngine');
            // Step 2: 构建完整 prompt 并调用 LLM
            const userText = sttResult.text;
            const memoryContext = this.buildMemoryContextFromHistory();
            const userProfileSummary = this.buildUserProfileSummary();
            let llmResponse = '';
            if (this.dialogueGenerator) {
                try {
                    llmResponse = await this.dialogueGenerator.generate(userText, 'daily', memoryContext, userProfileSummary);
                    // 应用人设规则
                    const toneResult = this.personaRules.adjustTone(llmResponse, 'daily');
                    llmResponse = toneResult.adjustedContent;
                }
                catch (error) {
                    Logger_1.Logger.error('语音交互 LLM 生成失败', error, 'InteractionEngine');
                    llmResponse = '抱歉，我暂时无法回应。请稍后再试。';
                }
            }
            else {
                llmResponse = '我在。有什么可以帮你的？';
            }
            Logger_1.Logger.info(`🧠 LLM 响应: "${llmResponse.substring(0, 50)}${llmResponse.length > 50 ? '...' : ''}"`, 'InteractionEngine');
            // Step 3: TTS — 语音合成
            this.updateVoiceSessionStatus('speaking');
            let audioOutput;
            try {
                const ttsResult = await this.speechSynthesizer.speak(llmResponse);
                if (ttsResult.success && ttsResult.audioData) {
                    audioOutput = ttsResult.audioData;
                }
            }
            catch (error) {
                Logger_1.Logger.warn(`语音合成失败: ${error.message}，仅返回文本`, 'InteractionEngine');
            }
            // 更新轮次计数
            this.voiceSession.turnCount++;
            this.voiceSession.lastActivityAt = new Date();
            // 保存到交互历史
            this.interactionHistory.push({
                type: 'voice_input',
                content: userText,
                timestamp: new Date(),
            });
            this.interactionHistory.push({
                type: 'voice_response',
                content: llmResponse,
                timestamp: new Date(),
            });
            // 恢复会话状态
            this.updateVoiceSessionStatus('idle');
            return {
                text: llmResponse,
                audioData: audioOutput,
                duration: Date.now() - startTime,
                turnCount: this.voiceSession.turnCount,
            };
        }
        catch (error) {
            Logger_1.Logger.error('语音交互处理失败', error, 'InteractionEngine');
            this.updateVoiceSessionStatus('idle');
            throw new Error(`语音交互处理失败: ${error.message}`);
        }
    }
    /**
     * 获取当前语音会话状态
     * @returns 当前语音会话，如果没有活跃会话则返回 null
     */
    getVoiceSession() {
        if (!this.voiceSession) {
            return null;
        }
        return { ...this.voiceSession };
    }
    /**
     * 更新语音会话状态
     * @param status - 新的会话状态
     */
    updateVoiceSessionStatus(status) {
        if (this.voiceSession) {
            this.voiceSession.status = status;
            this.voiceSession.lastActivityAt = new Date();
        }
    }
    // ═══════════════════════════ 内部方法 ═══════════════════════════
    setupEventBusListeners() {
        EventBus_1.EventBus.on('ws_send', (data) => {
            const message = data;
            this.interactionHistory.push({
                type: 'ws_send',
                content: message,
                timestamp: new Date(),
            });
        });
        EventBus_1.EventBus.on('user_input', (data) => {
            const input = data;
            this.interactionHistory.push({
                type: 'user_input',
                content: input.text,
                timestamp: new Date(),
            });
        });
    }
    async outputResponseInternal(response, _emotion, _scene) {
        void EventBus_1.EventBus.emit('response_ready', {
            response,
            traceId: Logger_1.Logger.getTraceId() || `ie_${Date.now()}`,
            success: true,
        });
    }
    buildMemoryContextFromHistory() {
        return this.interactionHistory.slice(-10).map((h) => ({
            content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content),
            type: h.type,
            timestamp: h.timestamp,
        }));
    }
    /**
     * 从 MemoryEngine 检索相关记忆，与交互历史合并
     * 修复记忆链路断点：使交互引擎能获取用户历史记忆
     */
    async retrieveMemoryEnrichedContext(input, scene, emotion) {
        const historyContext = this.buildMemoryContextFromHistory();
        if (!this.memoryEngine?.preciseHybridRetrieval) {
            return historyContext;
        }
        try {
            const memories = await this.memoryEngine.preciseHybridRetrieval(input, scene, emotion, 5);
            const memoryItems = memories.map((m) => ({
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                type: m.type || 'long_term',
                timestamp: m.timestamp || new Date(),
                relevance: m.relevanceScore,
            }));
            const existingContents = new Set(historyContext.map((h) => h.content));
            const uniqueMemoryItems = memoryItems.filter((m) => !existingContents.has(m.content));
            return [...uniqueMemoryItems, ...historyContext];
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ MemoryEngine 检索失败，降级到交互历史: ${error.message}`, 'InteractionEngine');
            return historyContext;
        }
    }
    buildUserProfileSummary() {
        const basicInfo = this.userProfile.getBasicInfo();
        const devHabits = this.userProfile.getDevelopmentHabits();
        const emotionPatterns = this.userProfile.getEmotionalPatterns();
        return {
            name: basicInfo.name,
            preferredLanguage: devHabits.preferredLanguages[0],
            preferredFrameworks: devHabits.preferredFrameworks,
            recentTopics: [],
            behaviorHints: [
                ...emotionPatterns.commonEmotions.map((e) => `常表达${e.type}情绪`),
                devHabits.codingStyle
                    ? `编码风格: ${JSON.stringify(devHabits.codingStyle)}`
                    : '',
            ].filter(Boolean),
        };
    }
    /**
     * 生成最大重试次数响应
     */
    async generateMaxRetryResponse() {
        if (this.dialogueGenerator) {
            try {
                return await this.dialogueGenerator.generate('我已经尝试了很多次，但似乎遇到了困难。请告诉我更多细节，或者换个方式描述您的需求。', 'work', [], this.buildUserProfileSummary());
            }
            catch (err) {
                Logger_1.Logger.debug(`最大重试响应生成失败: ${err?.message}`, 'InteractionEngine');
                return '抱歉，经过多次尝试仍无法完成。请提供更多细节，或换个方式描述需求。';
            }
        }
        return '抱歉，经过多次尝试仍无法完成。请提供更多细节，或换个方式描述需求。';
    }
    /**
     * 生成错误响应
     */
    async generateErrorResponse(error) {
        const errorMsg = error?.message || '未知错误';
        if (this.dialogueGenerator) {
            try {
                return await this.dialogueGenerator.generate(`执行过程中遇到问题：${errorMsg}。请确认相关服务是否正常运行。`, 'work', [], this.buildUserProfileSummary());
            }
            catch (err) {
                Logger_1.Logger.debug(`错误响应生成失败: ${err?.message}`, 'InteractionEngine');
                return `执行遇到问题：${errorMsg}。`;
            }
        }
        return `执行遇到问题：${errorMsg}。`;
    }
    /**
     * 关闭交互引擎（兼容 JiaBaiXing 主类）
     */
    async shutdown() {
        Logger_1.Logger.info('正在关闭 InteractionEngine...', 'InteractionEngine');
        this.interactionHistory = [];
        this.isSpeaking = false;
        this.voiceSession = null;
    }
    async generateResponseWithPersona(input, emotion, scene, context, traceId) {
        const finalTraceId = traceId ||
            `ie_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const startTime = Date.now();
        EventBus_1.EventBus.startTrace(finalTraceId, 'interaction_generate_response', {
            input: input.substring(0, 50),
            emotion,
            scene,
            contextCount: context.length,
        });
        try {
            const memoryContextItems = context.map((item) => ({
                content: typeof item.content === 'string'
                    ? item.content
                    : JSON.stringify(item.content),
                type: item.type,
                timestamp: item.timestamp,
            }));
            const baseResponse = await this.generateChatResponse(input, scene, memoryContextItems);
            const personaAdjusted = this.personaRules.adjustTone(baseResponse, scene);
            const emotionAdjusted = this.adjustByEmotion(personaAdjusted.adjustedContent, emotion);
            const currentPersona = this.getCurrentPersona();
            const confidence = this.calculateConfidence(emotion, scene);
            EventBus_1.EventBus.completeTrace(finalTraceId, true);
            void EventBus_1.EventBus.emit('response_ready', {
                response: emotionAdjusted,
                traceId: finalTraceId,
                success: true,
                duration: Date.now() - startTime,
            });
            return {
                success: true,
                response: emotionAdjusted,
                personaAwareResponse: {
                    content: emotionAdjusted,
                    emotion,
                    scene,
                    persona: currentPersona,
                    confidence,
                },
                duration: Date.now() - startTime,
                traceId: finalTraceId,
            };
        }
        catch (error) {
            EventBus_1.EventBus.failTrace(finalTraceId, error.message);
            return {
                success: false,
                error: error.message,
                duration: Date.now() - startTime,
                traceId: finalTraceId,
            };
        }
    }
    adjustByEmotion(response, emotion) {
        const emotionAdjustments = {
            开心: (r) => `😊 ${r}`,
            难过: (r) => `抱抱你，${r}`,
            生气: (r) => `我理解你的感受，${r}`,
            焦虑: (r) => `别担心，${r}`,
            平静: (r) => r,
        };
        const adjust = emotionAdjustments[emotion] || emotionAdjustments['平静'];
        return adjust(response);
    }
    getCurrentPersona() {
        return '御姐秘书';
    }
    calculateConfidence(emotion, scene) {
        let confidence = 0.8;
        if (emotion === '平静') {
            confidence += 0.1;
        }
        if (scene === 'development' || scene === 'work') {
            confidence += 0.1;
        }
        return Math.min(1, confidence);
    }
}
exports.InteractionEngine = InteractionEngine;
