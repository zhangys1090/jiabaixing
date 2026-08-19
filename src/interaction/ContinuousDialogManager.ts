/**
 * 连续对话管理器
 * I4: 无唤醒词连续监听、对话结束自动判断
 * I3: 支持用户插话、追问、打断，全双工语音交互
 */

import { EventEmitter } from 'events';
import type { IMemoryEngine } from '../core/IMemoryEngine';
import { Logger } from '../utils/Logger';

export interface DialogContext {
  id: string;
  userId: string;
  messages: DialogMessage[];
  lastActive: Date;
  topic: string;
  context: Record<string, unknown>;
  silenceDuration: number;
  isWaitingForUser: boolean;
}

export interface DialogMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  emotion?: string;
  scene?: string;
  isInterruption?: boolean;
}

/**
 * I4: 对话状态
 */
export enum ConversationState {
  IDLE = 'idle',
  LISTENING = 'listening',
  PROCESSING = 'processing',
  SPEAKING = 'speaking',
  SILENCE = 'silence',
  ENDED = 'ended',
}

/**
 * I4: 对话结束判断配置
 */
export interface ConversationEndConfig {
  maxSilenceMs: number;
  maxRoundsWithoutWake: number;
  endPhrases: string[];
}

export class ContinuousDialogManager extends EventEmitter {
  private initialized: boolean = false;
  private dialogContexts: Map<string, DialogContext> = new Map();
  private contextTimeout: number = 300000;
  private isListening: boolean = false;
  private currentDialogId: string | null = null;
  private conversationState: ConversationState = ConversationState.IDLE;
  private continuousRoundCount: number = 0;
  private lastUserMessageTime: number = 0;
  private silenceTimer: NodeJS.Timeout | null = null;
  private contextCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private speechRecognizer: unknown = null;
  private speechSynthesizer: unknown = null;
  private audioStream: unknown = null;
  private memoryEngine: IMemoryEngine | null = null;

  private config: ConversationEndConfig = {
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

  constructor() {
    super();
  }

  /**
   * 注入语音识别器（由 main.ts 调用）
   */
  setSpeechRecognizer(recognizer: unknown): void {
    this.speechRecognizer = recognizer;
  }

  /**
   * 注入语音合成器（由 main.ts 调用）
   */
  setSpeechSynthesizer(synthesizer: unknown): void {
    this.speechSynthesizer = synthesizer;
  }

  /**
   * 注入记忆引擎（由 InteractionEngine.setMemoryEngine 传递）
   * 使连续对话管理器能跨会话保持上下文
   */
  setMemoryEngine(memoryEngine: IMemoryEngine): void {
    this.memoryEngine = memoryEngine;
    Logger.info(
      '💾 MemoryEngine 已注入 ContinuousDialogManager',
      'ContinuousDialogManager'
    );
  }

  public async initialize(): Promise<void> {
    Logger.info('连续对话管理器：初始化中...', 'ContinuousDialogManager');
    this.startContextCleanup();
    this.initialized = true;
    Logger.info('连续对话管理器：初始化完成', 'ContinuousDialogManager');
  }

  /**
   * I4: 开始无唤醒词连续监听
   */
  public async startListening(): Promise<void> {
    this.ensureInitialized();

    if (!this.isListening) {
      Logger.info('🎧 连续对话管理器：开始无唤醒词监听（5轮连续对话）');
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
  private startAudioCapture(): void {
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

      micStream.on('data', async (audioBuffer: Buffer) => {
        try {
          const recognizer = this.speechRecognizer as {
            recognizeStreaming?: (buffer: Buffer) => Promise<{ text: string }>;
          };
          if (!recognizer || !recognizer.recognizeStreaming) return;

          const result = await recognizer.recognizeStreaming(audioBuffer);
          if (result && result.text && result.text.length > 0) {
            Logger.info(`🎤 语音识别结果: ${result.text}`);
            this.emit('user_speech', result.text);
            this.conversationState = ConversationState.PROCESSING;
          }
        } catch (err) {
          Logger.error('语音识别流错误', err as Error);
        }
      });

      Logger.info('🎙️ 音频采集已启动');
    } catch (err) {
      Logger.warn(
        '⚠️ 音频采集启动失败（可能缺少 node-record-lpcm16 依赖）',
        'ContinuousDialogManager',
        { error: (err as Error).message }
      );
    }
  }

  public async stopListening(): Promise<void> {
    this.ensureInitialized();

    if (this.isListening) {
      Logger.info('🎧 连续对话管理器：停止监听');
      this.isListening = false;
      this.conversationState = ConversationState.IDLE;

      // 清理音频采集
      if (this.audioStream) {
        try {
          (this.audioStream as { destroy?: () => void }).destroy?.();
        } catch {
          // ignore
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
  public stopSpeaking(): void {
    if (this.conversationState === ConversationState.SPEAKING) {
      this.conversationState = ConversationState.LISTENING;
      Logger.info('🎧 连续对话管理器：打断说话，恢复监听');
    }
  }

  /**
   * I3+I4: 处理用户输入（支持打断+自动判断对话结束）
   */
  public async processUserInput(
    userId: string,
    content: string,
    emotion?: string,
    scene?: string,
    isInterruption: boolean = false
  ): Promise<DialogContext> {
    this.ensureInitialized();

    this.lastUserMessageTime = Date.now();
    this.continuousRoundCount++;
    this.conversationState = ConversationState.PROCESSING;

    if (isInterruption) {
      this.emit('interruption', { userId, content });
    }

    let context = await this.getOrCreateDialogContext(userId);

    const userMessage: DialogMessage = {
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

    if (
      context.messages.length === 1 ||
      this.isTopicChange(content, context.topic)
    ) {
      context.topic = this.extractTopic(content);
    }

    this.dialogContexts.set(userId, context);

    this.resetSilenceTimer(userId);
    this.checkConversationEnd(userId, content);

    return context;
  }

  /**
   * I3: 添加助手回复（支持流式+打断）
   */
  public async addAssistantResponse(
    userId: string,
    content: string,
    emotion?: string,
    scene?: string
  ): Promise<void> {
    this.ensureInitialized();

    this.conversationState = ConversationState.SPEAKING;

    const context = this.dialogContexts.get(userId);
    if (!context) {
      Logger.error(
        '连续对话管理器：对话上下文不存在',
        undefined,
        'ContinuousDialogManager'
      );
      return;
    }

    const assistantMessage: DialogMessage = {
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

    this.conversationState = ConversationState.LISTENING;
    this.resetSilenceTimer(userId);
  }

  /**
   * I4: 检查是否应该结束对话
   */
  private checkConversationEnd(userId: string, content: string): void {
    const lowerContent = content.toLowerCase();

    const isEndPhrase = this.config.endPhrases.some((phrase) =>
      lowerContent.includes(phrase.toLowerCase())
    );

    const exceededRounds =
      this.continuousRoundCount > this.config.maxRoundsWithoutWake;

    if (isEndPhrase || exceededRounds) {
      this.emit('conversationEnd', {
        userId,
        reason: isEndPhrase ? 'end_phrase' : 'max_rounds',
      });
    } else {
      this.emit('continueListening', {
        userId,
        round: this.continuousRoundCount,
      });
    }
  }

  /**
   * I4: 重置沉默计时器
   */
  private resetSilenceTimer(userId: string): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }

    this.silenceTimer = setTimeout(() => {
      const silenceDuration = Date.now() - this.lastUserMessageTime;
      Logger.info(
        `连续对话管理器：沉默 ${silenceDuration}ms`,
        'ContinuousDialogManager'
      );

      if (silenceDuration >= this.config.maxSilenceMs) {
        this.emit('silenceTimeout', { userId, silenceDuration });
        this.conversationState = ConversationState.SILENCE;
      }
    }, this.config.maxSilenceMs);
  }

  public getDialogContext(userId: string): DialogContext | undefined {
    this.ensureInitialized();
    return this.dialogContexts.get(userId);
  }

  public getCurrentState(): ConversationState {
    return this.conversationState;
  }

  public getContinuousRoundCount(): number {
    return this.continuousRoundCount;
  }

  public async endDialog(userId: string): Promise<void> {
    this.ensureInitialized();
    Logger.info(
      `连续对话管理器：结束对话 - ${userId}`,
      'ContinuousDialogManager'
    );
    this.dialogContexts.delete(userId);
    this.conversationState = ConversationState.ENDED;
    this.continuousRoundCount = 0;
  }

  private async getOrCreateDialogContext(
    userId: string
  ): Promise<DialogContext> {
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
          const recentMemories = await this.memoryEngine.retrieveRelevant!({
            query: userId,
            limit: 5,
            includeBehaviorPatterns: true,
          });
          if (Array.isArray(recentMemories) && recentMemories.length > 0) {
            context.context.crossSessionMemories = recentMemories;
            Logger.info(
              `💾 跨会话记忆恢复: ${recentMemories.length}条`,
              'ContinuousDialogManager'
            );
          }
        } catch (error) {
          Logger.warn(
            `⚠️ 跨会话记忆恢复失败: ${(error as Error).message}`,
            'ContinuousDialogManager'
          );
        }
      }

      this.dialogContexts.set(userId, context);
    }
    return context;
  }

  private startContextCleanup(): void {
    this.contextCleanupTimer = setInterval(
      () => {
        this.cleanupExpiredContexts();
      },
      5 * 60 * 1000
    );
  }

  private cleanupExpiredContexts(): void {
    const now = Date.now();
    const expiredContexts: string[] = [];

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

  private isTopicChange(input: string, currentTopic: string): boolean {
    const topicKeywords = currentTopic.split(/\s+/);
    const inputLower = input.toLowerCase();

    if (!currentTopic) return true;

    const matchCount = topicKeywords.filter((keyword) =>
      inputLower.includes(keyword.toLowerCase())
    ).length;

    return matchCount / topicKeywords.length < 0.3;
  }

  private extractTopic(input: string): string {
    return input.substring(0, 50);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('连续对话管理器未初始化！请先调用initialize方法。');
    }
  }

  public async shutdown(): Promise<void> {
    await this.stopListening();
    if (this.contextCleanupTimer) {
      clearInterval(this.contextCleanupTimer);
      this.contextCleanupTimer = null;
    }
    this.dialogContexts.clear();
    this.initialized = false;
  }
}
