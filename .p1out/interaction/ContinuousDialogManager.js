"use strict";
/**
 * 连续对话管理器
 * I4: 无唤醒词连续监听、对话结束自动判断
 * I3: 支持用户插话、追问、打断，全双工语音交互
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContinuousDialogManager = exports.ConversationState = void 0;
const events_1 = require("events");
const Logger_1 = require("../utils/Logger");
/**
 * I4: 对话状态
 */
var ConversationState;
(function (ConversationState) {
    ConversationState["IDLE"] = "idle";
    ConversationState["LISTENING"] = "listening";
    ConversationState["PROCESSING"] = "processing";
    ConversationState["SPEAKING"] = "speaking";
    ConversationState["SILENCE"] = "silence";
    ConversationState["ENDED"] = "ended";
})(ConversationState || (exports.ConversationState = ConversationState = {}));
class ContinuousDialogManager extends events_1.EventEmitter {
    constructor() {
        super();
        this.initialized = false;
        this.dialogContexts = new Map();
        this.MAX_DIALOG_CONTEXTS = 1000;
        this.contextTimeout = 300000;
        this.isListening = false;
        this.currentDialogId = null;
        this.conversationState = ConversationState.IDLE;
        this.continuousRoundCount = 0;
        this.lastUserMessageTime = 0;
        this.silenceTimer = null;
        this.contextCleanupTimer = null;
        this.speechRecognizer = null;
        this.speechSynthesizer = null;
        this.audioStream = null;
        this.memoryEngine = null;
        this.config = {
            maxSilenceMs: 5000,
            maxRoundsWithoutWake: 5,
            endPhrases: [
                '好的',
                '知道了',
                '就这样',
                '没问题',
                '谢谢',
                '拜拜',
                '再见',
                '不用了',
            ],
        };
    }
    /**
     * 注入语音识别器（由 main.ts 调用）
     */
    setSpeechRecognizer(recognizer) {
        this.speechRecognizer = recognizer;
    }
    /**
     * 注入语音合成器（由 main.ts 调用）
     */
    setSpeechSynthesizer(synthesizer) {
        this.speechSynthesizer = synthesizer;
    }
    /**
     * 注入记忆引擎（由 InteractionEngine.setMemoryEngine 传递）
     * 使连续对话管理器能跨会话保持上下文
     */
    setMemoryEngine(memoryEngine) {
        this.memoryEngine = memoryEngine;
        Logger_1.Logger.info('💾 MemoryEngine 已注入 ContinuousDialogManager', 'ContinuousDialogManager');
    }
    async initialize() {
        Logger_1.Logger.info('连续对话管理器：初始化中...', 'ContinuousDialogManager');
        this.startContextCleanup();
        this.initialized = true;
        Logger_1.Logger.info('连续对话管理器：初始化完成', 'ContinuousDialogManager');
    }
    /**
     * I4: 开始无唤醒词连续监听
     */
    async startListening() {
        this.ensureInitialized();
        if (!this.isListening) {
            Logger_1.Logger.info('🎧 连续对话管理器：开始无唤醒词监听（5轮连续对话）');
            this.isListening = true;
            this.conversationState = ConversationState.LISTENING;
            this.continuousRoundCount = 0;
            // 如果已注入语音识别器，启动实际音频采集
            if (this.speechRecognizer) {
                this.startAudioCapture();
            }
        }
    }
    /**
     * 启动麦克风音频采集并转发至语音识别引擎
     */
    startAudioCapture() {
        try {
            const recorder = require('node-record-lpcm16');
            const micStream = recorder
                .record({
                sampleRate: 16000,
                threshold: 0.5,
                silence: '1.0',
            })
                .stream();
            this.audioStream = micStream;
            micStream.on('data', async (audioBuffer) => {
                try {
                    const recognizer = this.speechRecognizer;
                    if (!recognizer || !recognizer.recognizeStreaming)
                        return;
                    const result = await recognizer.recognizeStreaming(audioBuffer);
                    if (result && result.text && result.text.length > 0) {
                        Logger_1.Logger.info(`🎤 语音识别结果: ${result.text}`);
                        this.emit('user_speech', result.text);
                        this.conversationState = ConversationState.PROCESSING;
                    }
                }
                catch (err) {
                    Logger_1.Logger.error('语音识别流错误', err);
                }
            });
            Logger_1.Logger.info('🎙️ 音频采集已启动');
        }
        catch (err) {
            Logger_1.Logger.warn('⚠️ 音频采集启动失败（可能缺少 node-record-lpcm16 依赖）', 'ContinuousDialogManager', { error: err.message });
        }
    }
    async stopListening() {
        this.ensureInitialized();
        if (this.isListening) {
            Logger_1.Logger.info('🎧 连续对话管理器：停止监听');
            this.isListening = false;
            this.conversationState = ConversationState.IDLE;
            // 清理音频采集
            if (this.audioStream) {
                try {
                    this.audioStream.destroy?.();
                }
                catch (err) {
                    Logger_1.Logger.debug(`音频流销毁失败: ${err?.message}`, 'ContinuousDialogManager');
                }
                this.audioStream = null;
            }
            if (this.silenceTimer) {
                clearTimeout(this.silenceTimer);
                this.silenceTimer = null;
            }
        }
    }
    /**
     * 停止说话状态（用于打断时恢复监听）
     */
    stopSpeaking() {
        if (this.conversationState === ConversationState.SPEAKING) {
            this.conversationState = ConversationState.LISTENING;
            Logger_1.Logger.info('🎧 连续对话管理器：打断说话，恢复监听');
        }
    }
    /**
     * I3+I4: 处理用户输入（支持打断+自动判断对话结束）
     */
    async processUserInput(userId, content, emotion, scene, isInterruption = false) {
        this.ensureInitialized();
        this.lastUserMessageTime = Date.now();
        this.continuousRoundCount++;
        this.conversationState = ConversationState.PROCESSING;
        if (isInterruption) {
            this.emit('interruption', { userId, content });
        }
        let context = await this.getOrCreateDialogContext(userId);
        const userMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            role: 'user',
            content,
            timestamp: new Date(),
            emotion,
            scene,
            isInterruption,
        };
        context.messages.push(userMessage);
        context.lastActive = new Date();
        context.silenceDuration = 0;
        if (context.messages.length === 1 ||
            this.isTopicChange(content, context.topic)) {
            context.topic = this.extractTopic(content);
        }
        this.dialogContexts.set(userId, context);
        if (this.dialogContexts.size > this.MAX_DIALOG_CONTEXTS) {
            const oldestKey = this.dialogContexts.keys().next().value;
            this.dialogContexts.delete(oldestKey);
        }
        this.resetSilenceTimer(userId);
        this.checkConversationEnd(userId, content);
        return context;
    }
    /**
     * I3: 添加助手回复（支持流式+打断）
     */
    async addAssistantResponse(userId, content, emotion, scene) {
        this.ensureInitialized();
        this.conversationState = ConversationState.SPEAKING;
        const context = this.dialogContexts.get(userId);
        if (!context) {
            Logger_1.Logger.error('连续对话管理器：对话上下文不存在', undefined, 'ContinuousDialogManager');
            return;
        }
        const assistantMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            role: 'assistant',
            content,
            timestamp: new Date(),
            emotion,
            scene,
        };
        context.messages.push(assistantMessage);
        context.lastActive = new Date();
        this.dialogContexts.set(userId, context);
        if (this.dialogContexts.size > this.MAX_DIALOG_CONTEXTS) {
            const oldestKey = this.dialogContexts.keys().next().value;
            this.dialogContexts.delete(oldestKey);
        }
        this.conversationState = ConversationState.LISTENING;
        this.resetSilenceTimer(userId);
    }
    /**
     * I4: 检查是否应该结束对话
     */
    checkConversationEnd(userId, content) {
        const lowerContent = content.toLowerCase();
        const isEndPhrase = this.config.endPhrases.some((phrase) => lowerContent.includes(phrase.toLowerCase()));
        const exceededRounds = this.continuousRoundCount > this.config.maxRoundsWithoutWake;
        if (isEndPhrase || exceededRounds) {
            this.emit('conversationEnd', {
                userId,
                reason: isEndPhrase ? 'end_phrase' : 'max_rounds',
            });
        }
        else {
            this.emit('continueListening', {
                userId,
                round: this.continuousRoundCount,
            });
        }
    }
    /**
     * I4: 重置沉默计时器
     */
    resetSilenceTimer(userId) {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        this.silenceTimer = setTimeout(() => {
            const silenceDuration = Date.now() - this.lastUserMessageTime;
            Logger_1.Logger.info(`连续对话管理器：沉默 ${silenceDuration}ms`, 'ContinuousDialogManager');
            if (silenceDuration >= this.config.maxSilenceMs) {
                this.emit('silenceTimeout', { userId, silenceDuration });
                this.conversationState = ConversationState.SILENCE;
            }
        }, this.config.maxSilenceMs);
        if (this.silenceTimer.unref)
            this.silenceTimer.unref();
    }
    getDialogContext(userId) {
        this.ensureInitialized();
        return this.dialogContexts.get(userId);
    }
    getCurrentState() {
        return this.conversationState;
    }
    getContinuousRoundCount() {
        return this.continuousRoundCount;
    }
    async endDialog(userId) {
        this.ensureInitialized();
        Logger_1.Logger.info(`连续对话管理器：结束对话 - ${userId}`, 'ContinuousDialogManager');
        this.dialogContexts.delete(userId);
        this.conversationState = ConversationState.ENDED;
        this.continuousRoundCount = 0;
    }
    async getOrCreateDialogContext(userId) {
        let context = this.dialogContexts.get(userId);
        if (!context) {
            context = {
                id: `dialog_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                userId,
                messages: [],
                lastActive: new Date(),
                topic: '',
                context: {},
                silenceDuration: 0,
                isWaitingForUser: false,
            };
            if (this.memoryEngine?.retrieveRelevant) {
                try {
                    const recentMemories = await this.memoryEngine.retrieveRelevant({
                        query: userId,
                        limit: 5,
                        includeBehaviorPatterns: true,
                    });
                    if (Array.isArray(recentMemories) && recentMemories.length > 0) {
                        context.context.crossSessionMemories = recentMemories;
                        Logger_1.Logger.info(`💾 跨会话记忆恢复: ${recentMemories.length}条`, 'ContinuousDialogManager');
                    }
                }
                catch (error) {
                    Logger_1.Logger.warn(`⚠️ 跨会话记忆恢复失败: ${error.message}`, 'ContinuousDialogManager');
                }
            }
            this.dialogContexts.set(userId, context);
            if (this.dialogContexts.size > this.MAX_DIALOG_CONTEXTS) {
                const oldestKey = this.dialogContexts.keys().next().value;
                this.dialogContexts.delete(oldestKey);
            }
        }
        return context;
    }
    startContextCleanup() {
        this.contextCleanupTimer = setInterval(() => {
            this.cleanupExpiredContexts();
        }, 5 * 60 * 1000);
        if (this.contextCleanupTimer.unref)
            this.contextCleanupTimer.unref();
    }
    cleanupExpiredContexts() {
        const now = Date.now();
        const expiredContexts = [];
        for (const [userId, context] of this.dialogContexts.entries()) {
            const lastActiveTime = context.lastActive.getTime();
            if (now - lastActiveTime > this.contextTimeout) {
                expiredContexts.push(userId);
            }
        }
        expiredContexts.forEach((userId) => {
            this.dialogContexts.delete(userId);
        });
    }
    isTopicChange(input, currentTopic) {
        const topicKeywords = currentTopic.split(/\s+/);
        const inputLower = input.toLowerCase();
        if (!currentTopic)
            return true;
        const matchCount = topicKeywords.filter((keyword) => inputLower.includes(keyword.toLowerCase())).length;
        return matchCount / topicKeywords.length < 0.3;
    }
    extractTopic(input) {
        return input.substring(0, 50);
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('连续对话管理器未初始化！请先调用initialize方法。');
        }
    }
    async shutdown() {
        await this.stopListening();
        if (this.contextCleanupTimer) {
            clearInterval(this.contextCleanupTimer);
            this.contextCleanupTimer = null;
        }
        this.dialogContexts.clear();
        this.initialized = false;
    }
}
exports.ContinuousDialogManager = ContinuousDialogManager;
