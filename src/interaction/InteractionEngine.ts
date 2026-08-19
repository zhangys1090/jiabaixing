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

import { DAGTask } from '../core/DAGTask';
import type { IMemoryEngine } from '../core/IMemoryEngine';
import { EmotionTag, SceneTag } from '../interfaces';
import { LLMContextBuilder } from '../memory/LLMContextBuilder';
import { MemoryItem } from '../memory/MemoryEngine';
import { UserProfile } from '../memory/UserProfile';
import { SpeechRecognizer } from '../multimodal/SpeechRecognizer';
import {
  DialogueGenerator,
  MemoryContextItem,
  UserProfileSummary,
} from '../persona/DialogueGenerator';
import { PersonaRules } from '../persona/PersonaRules';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { ContinuousDialogManager } from './ContinuousDialogManager';
import { EmojiManager } from './EmojiManager';
import { SpeechSynthesizer } from './SpeechSynthesizer';

interface CoreEngineLike {
  processInput(
    input: string,
    userId: string,
    traceId?: string
  ): Promise<unknown>;
}

/**
 * 交互计划接口
 */
export interface InteractionPlan {
  estimatedTime: number;
  needEmotionSupport: boolean;
  progressUpdateFrequency: number;
  emotionSupportContent: string;
}

export interface PersonaAwareResponse {
  content: string;
  emotion: string;
  scene: string;
  persona: string;
  confidence: number;
}

export interface TrackedResponseResult {
  success: boolean;
  response?: string;
  personaAwareResponse?: PersonaAwareResponse;
  duration: number;
  traceId: string;
  error?: string;
}

/**
 * 语音会话状态
 */
export type VoiceSessionStatus =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking';

/**
 * 语音会话接口
 */
export interface VoiceSession {
  id: string;
  status: VoiceSessionStatus;
  language: string;
  startedAt: Date;
  lastActivityAt: Date;
  turnCount: number;
}

/**
 * 语音交互处理结果
 */
export interface VoiceProcessResult {
  text: string;
  audioData?: Buffer;
  duration: number;
  turnCount: number;
}

/**
 * 交互引擎类 v2
 * 模板已死，LLM + 记忆永生
 */
export class InteractionEngine {
  private personaRules: PersonaRules;
  private personaEngine: unknown = null;
  private speechSynthesizer: SpeechSynthesizer;
  private emojiManager: EmojiManager;
  private voiceprintRecognizer: unknown = null;
  private continuousDialogManager: ContinuousDialogManager;
  private userProfile: UserProfile;
  private interactionHistory: Array<{
    type: string;
    content: unknown;
    timestamp: Date;
    emotion?: string;
    scene?: string;
  }> = [];
  private isSpeaking: boolean = false;
  private core: CoreEngineLike | null = null;
  private dialogueGenerator: DialogueGenerator | null = null;
  private contextBuilder: LLMContextBuilder;
  private memoryEngine: IMemoryEngine | null = null;

  // v2: 多模态处理器（复用现有架构）
  private speechRecognizer: SpeechRecognizer;

  // v2: 语音会话管理
  private voiceSession: VoiceSession | null = null;

  constructor(
    userProfile?: UserProfile,
    dialogueGenerator?: DialogueGenerator
  ) {
    this.personaRules = new PersonaRules();
    this.personaEngine = null;
    this.speechSynthesizer = new SpeechSynthesizer();
    this.emojiManager = new EmojiManager();
    // VoiceprintRecognizer removed in v4.0
    this.continuousDialogManager = new ContinuousDialogManager();
    this.userProfile = userProfile || new UserProfile();
    this.dialogueGenerator = dialogueGenerator || null;
    this.contextBuilder = new LLMContextBuilder();

    // v2: 初始化多模态处理器（复用现有类）
    this.speechRecognizer = new SpeechRecognizer();

    this.setupEventBusListeners();
  }

  /**
   * 设置对话生成器（由 JiabaixingCore 注入）
   */
  public setDialogueGenerator(generator: DialogueGenerator): void {
    this.dialogueGenerator = generator;
  }

  /**
   * 安全获取表情管理器实例（优雅降级）
   */
  private async safeGenerateEmoji(options: {
    emotion?: string;
    scene?: string;
    context?: string;
    style?: 'static' | 'animated';
    service?: 'local' | 'api';
  }): Promise<string> {
    if (!this.emojiManager || !this.emojiManager.isInitialized()) {
      return '';
    }
    try {
      return await this.emojiManager.generateEmoji(options);
    } catch (error) {
      Logger.warn(
        '⚠️ EmojiManager generateEmoji 降级处理:',
        (error as Error).message,
        'InteractionEngine'
      );
      return '';
    }
  }

  /**
   * 设置核心引擎引用
   */
  public setCore(core: CoreEngineLike): void {
    this.core = core;
  }

  /**
   * 注入记忆引擎（由 bootstrap initInteraction 调用）
   * 使交互引擎能检索用户历史记忆，实现个性化话术
   */
  public setMemoryEngine(memoryEngine: IMemoryEngine): void {
    this.memoryEngine = memoryEngine;
    this.continuousDialogManager.setMemoryEngine(memoryEngine);
    Logger.info(
      '💾 MemoryEngine 已注入 InteractionEngine + ContinuousDialogManager',
      'InteractionEngine'
    );
  }

  /**
   * 初始化交互引擎
   */
  public async initialize(): Promise<void> {
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
  public async generatePreExecutionResponse(
    taskGraph: DAGTask,
    plan: InteractionPlan,
    emotion?: string,
    scene?: string
  ): Promise<void> {
    let response = '';

    if (this.dialogueGenerator) {
      // 使用 LLM 生成自然的确认回复
      const sceneTag = scene || 'daily';
      const memoryContext = await this.retrieveMemoryEnrichedContext(
        taskGraph.getName() || '',
        sceneTag
      );
      const userProfileSummary = this.buildUserProfileSummary();

      const preExecPrompt = `用户刚刚要求我执行一个任务，预计需要 ${Math.ceil(plan.estimatedTime / 60)} 分钟。
任务名称：${taskGraph.getName() || '未指定'}

请生成一句简短，自然的确认回复。像一位专业的秘书确认收到任务一样。不要啰嗦。`;

      try {
        response = await this.dialogueGenerator.generate(
          preExecPrompt,
          sceneTag,
          memoryContext,
          userProfileSummary
        );
      } catch {
        // LLM 失败时降级到极简确认
        response =
          plan.estimatedTime < 10
            ? '好的，马上处理。'
            : `收到，预计需要 ${Math.ceil(plan.estimatedTime / 60)} 分钟。`;
      }
    } else {
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
    const finalResponse = this.personaRules.adjustTone(
      response,
      scene || 'daily'
    ).adjustedContent;

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
  public async generateResultResponse(
    result: unknown,
    emotion: EmotionTag,
    scene: SceneTag,
    memoryContext: MemoryItem[]
  ): Promise<string> {
    // 获取用户画像信息
    const userBasicInfo = this.userProfile.getBasicInfo();
    const userDevHabits = this.userProfile.getDevelopmentHabits();
    const userEmotionPatterns = this.userProfile.getEmotionalPatterns();

    // 获取最近的用户输入
    let userInput = '';
    if (this.interactionHistory.length > 0) {
      const lastInteraction =
        this.interactionHistory[this.interactionHistory.length - 1];
      if (lastInteraction.type === 'user_input') {
        userInput = lastInteraction.content as string;
      }
    }

    let response = '';

    // 优先使用 DialogueGenerator 生成回复
    if (this.dialogueGenerator) {
      try {
        const enrichedMemory = await this.retrieveMemoryEnrichedContext(
          userInput || '任务结果',
          scene.type
        );
        const memoryCtx = [
          ...memoryContext.map((m) => {
            const contentStr =
              typeof m.content === 'string'
                ? m.content
                : JSON.stringify(m.content);
            return {
              content: contentStr,
              type: m.type || 'memory',
              relevance: m.relevanceScore,
            };
          }),
          ...enrichedMemory.filter(
            (em) =>
              !memoryContext.some(
                (mc) =>
                  (typeof mc.content === 'string'
                    ? mc.content
                    : JSON.stringify(mc.content)) === em.content
              )
          ),
        ];

        const userProfileSummary: UserProfileSummary = {
          name: userBasicInfo.name,
          preferredLanguage: userDevHabits.preferredLanguages[0],
          preferredFrameworks: userDevHabits.preferredFrameworks,
          recentTopics: [],
          behaviorHints: [
            ...userEmotionPatterns.commonEmotions.map(
              (e) => `常表达${e.type}情绪`
            ),
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

        response = await this.dialogueGenerator.generate(
          prompt,
          scene.type,
          memoryCtx,
          userProfileSummary
        );
      } catch (error) {
        Logger.warn(
          `DialogueGenerator 失败，使用降级回复: ${(error as Error).message}`,
          'InteractionEngine'
        );
        response = this.summarizeResult(result);
      }
    } else {
      // 无 DialogueGenerator 时的降级
      response = this.summarizeResult(result);
    }

    // 应用人设规则
    const finalResponse = this.personaRules.adjustTone(
      response,
      scene.type
    ).adjustedContent;

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
  private summarizeResult(result: unknown): string {
    if (!result) return '任务已完成。';

    const r = result as Record<string, unknown>;

    // 提取关键信息
    const parts: string[] = [];

    if (r.success === true) {
      parts.push('执行成功');
    } else if (r.success === false) {
      parts.push('执行未成功');
    }

    if (r.summary && typeof r.summary === 'string') {
      parts.push(r.summary);
    }

    if (r.message && typeof r.message === 'string') {
      parts.push(r.message);
    }

    if (r.output) {
      const outputStr =
        typeof r.output === 'string'
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
  public async formatResultForOwner(
    result: unknown,
    taskDescription: string,
    _scene: string,
    emotion?: string
  ): Promise<string> {
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
      const response = await this.dialogueGenerator.generate(
        prompt,
        'work',
        memoryContext,
        userProfileSummary
      );

      // 应用人设规则
      return this.personaRules.adjustTone(response, emotion || 'daily')
        .adjustedContent;
    } catch {
      return this.summarizeResult(result);
    }
  }

  /**
   * 生成对话式回复（供 JiabaixingCore 直接调用）
   * 这是主要的对外接口，完全基于 LLM + 记忆
   *
   * v2 优化：使用 LLMContextBuilder 智能筛选记忆
   */
  public async generateChatResponse(
    input: string,
    scene: string,
    memoryContext: MemoryContextItem[],
    userProfileSummary?: UserProfileSummary
  ): Promise<string> {
    if (!this.dialogueGenerator) {
      Logger.warn(
        'DialogueGenerator 未注入，使用降级回复',
        'InteractionEngine'
      );
      return '我在。有什么可以帮你的？';
    }

    try {
      const enrichedContext = await this.retrieveMemoryEnrichedContext(
        input,
        scene
      );
      const mergedContext = [
        ...memoryContext,
        ...enrichedContext.filter(
          (ec) => !memoryContext.some((mc) => mc.content === ec.content)
        ),
      ];

      const memoryItems: MemoryItem[] = mergedContext.map((mc) => ({
        id: `ctx_${Math.random().toString(36).substring(2, 11)}`,
        type: mc.type as import('../memory/MemoryEngine').MemoryType,
        content: mc.content,
        timestamp: mc.timestamp || new Date(),
        relevanceScore: mc.relevance,
      }));

      const builtContext = this.contextBuilder.buildContext(
        input,
        memoryItems,
        scene,
        userProfileSummary?.behaviorHints?.[0] || '平静'
      );

      const optimizedContext = LLMContextBuilder.toMemoryContextItems(
        builtContext.memories
      );

      Logger.info(
        `🧠 记忆优化: ${memoryContext.length}→${optimizedContext.length}条 | ` +
          `去重${builtContext.deduplicatedCount} | 压缩${builtContext.compressedCount}`,
        'InteractionEngine'
      );

      const response = await this.dialogueGenerator.generate(
        input,
        scene,
        optimizedContext,
        userProfileSummary
      );

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
    } catch (error) {
      Logger.error('生成对话回复失败', error as Error, 'InteractionEngine');
      return '抱歉，我暂时无法回应。请稍后再试。';
    }
  }

  /**
   * 生成主动关怀消息
   */
  public async generateProactiveMessage(
    reason: string,
    scene: string,
    context: string,
    _memoryContext: MemoryItem[]
  ): Promise<string> {
    if (!this.dialogueGenerator) {
      return '有什么我可以帮你的吗？';
    }

    const memoryContext = await this.retrieveMemoryEnrichedContext(
      context,
      scene
    );
    const userProfileSummary = this.buildUserProfileSummary();

    const prompt = `作为用户的私人秘书，我需要主动发起一次交互。
原因：${reason}
上下文：${context}

请生成一条自然、不突兀的主动消息。像一位细心的秘书在合适的时机开口一样。
不要问"有什么可以帮你的"这种套话，而是基于上下文给出具体的关切或提醒。`;

    try {
      const response = await this.dialogueGenerator.generate(
        prompt,
        scene,
        memoryContext,
        userProfileSummary
      );

      return this.personaRules.adjustTone(response, scene).adjustedContent;
    } catch {
      return context || '有什么新情况需要我关注吗？';
    }
  }

  /**
   * 处理用户输入（供外部调用）
   */
  public async processUserInput(
    input: string,
    emotion: string = '平静',
    scene: string = 'daily'
  ): Promise<string> {
    // 保存用户输入到历史
    this.interactionHistory.push({
      type: 'user_input',
      content: input,
      emotion,
      scene,
      timestamp: new Date(),
    });

    // 如果有核心引擎，交给核心引擎处理
    if (this.core) {
      const result = await this.core.processInput(input, 'default');
      return (result as { response?: string }).response || '';
    }

    return '';
  }

  // ═══════════════════════════ v2: 多模态输入处理 ═══════════════════════════

  /**
   * 处理音频输入（语音转文字）
   */
  public async processAudioInput(
    audioBuffer: Buffer,
    _mimeType: string = 'audio/wav'
  ): Promise<{ text: string; confidence: number }> {
    try {
      Logger.info('🎤 处理音频输入', 'InteractionEngine');

      // 使用现有的 SpeechRecognizer（已集成 Whisper）
      const result = await this.speechRecognizer.recognize(audioBuffer);

      Logger.info(
        `🎤 语音识别结果: ${result.text} (置信度: ${result.confidence?.toFixed(2)})`,
        'InteractionEngine'
      );

      return {
        text: result.text,
        confidence: result.confidence || 0,
      };
    } catch (error) {
      Logger.error('❌ 音频处理失败', error as Error, 'InteractionEngine');
      return { text: '', confidence: 0 };
    }
  }

  /**
   * 处理图像输入
   */
  public async processImageInput(
    imageBuffer: Buffer,
    mimeType: string
  ): Promise<{ description: string; base64: string }> {
    try {
      Logger.info('🖼️ 处理图像输入', 'InteractionEngine');

      const base64 = imageBuffer.toString('base64');

      Logger.info(`🖼️ 图像处理完成: ${mimeType}`, 'InteractionEngine');

      return {
        description: `图像 (${mimeType})`,
        base64,
      };
    } catch (error) {
      Logger.error('❌ 图像处理失败', error as Error, 'InteractionEngine');
      return { description: '', base64: '' };
    }
  }

  /**
   * 处理文件输入
   */
  public async processFileInput(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string
  ): Promise<{ content: string; summary: string }> {
    try {
      Logger.info(`📄 处理文件输入: ${fileName}`, 'InteractionEngine');

      const content = fileBuffer.toString('utf-8');
      const summary = `${fileName} (${mimeType})`;

      Logger.info(`📄 文件分析完成: ${fileName}`, 'InteractionEngine');

      return {
        content,
        summary,
      };
    } catch (error) {
      Logger.error(
        `❌ 文件处理失败: ${fileName}`,
        error as Error,
        'InteractionEngine'
      );
      return { content: '', summary: `无法解析文件: ${fileName}` };
    }
  }

  // ═══════════════════════════ v2: 语音会话管理 ═══════════════════════════

  /**
   * 开始语音会话
   * @param language - 语音识别语言，默认 zh-CN
   * @returns 新创建的语音会话
   */
  public startVoiceSession(language: string = 'zh-CN'): VoiceSession {
    if (this.voiceSession) {
      Logger.warn(
        `语音会话已存在 (id=${this.voiceSession.id})，将先关闭旧会话`,
        'InteractionEngine'
      );
      this.stopVoiceSession();
    }

    const session: VoiceSession = {
      id: `voice_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      status: 'idle',
      language,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      turnCount: 0,
    };

    this.voiceSession = session;

    Logger.info(
      `🎤 语音会话已启动: id=${session.id}, language=${language}`,
      'InteractionEngine'
    );

    return { ...session };
  }

  /**
   * 停止语音会话
   */
  public stopVoiceSession(): void {
    if (!this.voiceSession) {
      Logger.warn('没有活跃的语音会话可以停止', 'InteractionEngine');
      return;
    }

    Logger.info(
      `🎤 语音会话已停止: id=${this.voiceSession.id}, 轮次=${this.voiceSession.turnCount}`,
      'InteractionEngine'
    );

    this.voiceSession = null;
  }

  /**
   * 处理语音输入（STT → LLM → TTS 完整流程）
   * @param audioData - 音频数据 Buffer
   * @returns 语音交互处理结果，包含文本和可选的音频数据
   */
  public async processVoiceInput(
    audioData: Buffer
  ): Promise<VoiceProcessResult> {
    const startTime = Date.now();

    if (!this.voiceSession) {
      Logger.error(
        '没有活跃的语音会话，请先调用 startVoiceSession',
        new Error('NoVoiceSession'),
        'InteractionEngine'
      );
      throw new Error('没有活跃的语音会话，请先调用 startVoiceSession');
    }

    // 更新会话状态为 listening
    this.updateVoiceSessionStatus('listening');

    try {
      // Step 1: STT — 语音识别
      this.updateVoiceSessionStatus('processing');
      Logger.info('🎤 语音交互: 开始 STT 识别...', 'InteractionEngine');

      const sttResult = await this.speechRecognizer.recognize(audioData);

      if (!sttResult.text || sttResult.text.trim().length === 0) {
        Logger.warn('语音识别结果为空', 'InteractionEngine');
        this.updateVoiceSessionStatus('idle');
        return {
          text: '',
          duration: Date.now() - startTime,
          turnCount: this.voiceSession.turnCount,
        };
      }

      Logger.info(
        `🎤 语音识别完成: "${sttResult.text}" (置信度: ${sttResult.confidence?.toFixed(2)})`,
        'InteractionEngine'
      );

      // Step 2: 构建完整 prompt 并调用 LLM
      const userText = sttResult.text;
      const memoryContext = this.buildMemoryContextFromHistory();
      const userProfileSummary = this.buildUserProfileSummary();

      let llmResponse = '';

      if (this.dialogueGenerator) {
        try {
          llmResponse = await this.dialogueGenerator.generate(
            userText,
            'daily',
            memoryContext,
            userProfileSummary
          );

          // 应用人设规则
          const toneResult = this.personaRules.adjustTone(llmResponse, 'daily');
          llmResponse = toneResult.adjustedContent;
        } catch (error) {
          Logger.error(
            '语音交互 LLM 生成失败',
            error as Error,
            'InteractionEngine'
          );
          llmResponse = '抱歉，我暂时无法回应。请稍后再试。';
        }
      } else {
        llmResponse = '我在。有什么可以帮你的？';
      }

      Logger.info(
        `🧠 LLM 响应: "${llmResponse.substring(0, 50)}${llmResponse.length > 50 ? '...' : ''}"`,
        'InteractionEngine'
      );

      // Step 3: TTS — 语音合成
      this.updateVoiceSessionStatus('speaking');
      let audioOutput: Buffer | undefined;

      try {
        const ttsResult = await this.speechSynthesizer.speak(llmResponse);
        if (ttsResult.success && ttsResult.audioData) {
          audioOutput = ttsResult.audioData;
        }
      } catch (error) {
        Logger.warn(
          `语音合成失败: ${(error as Error).message}，仅返回文本`,
          'InteractionEngine'
        );
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
    } catch (error) {
      Logger.error('语音交互处理失败', error as Error, 'InteractionEngine');
      this.updateVoiceSessionStatus('idle');
      throw new Error(`语音交互处理失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取当前语音会话状态
   * @returns 当前语音会话，如果没有活跃会话则返回 null
   */
  public getVoiceSession(): VoiceSession | null {
    if (!this.voiceSession) {
      return null;
    }
    return { ...this.voiceSession };
  }

  /**
   * 更新语音会话状态
   * @param status - 新的会话状态
   */
  private updateVoiceSessionStatus(status: VoiceSessionStatus): void {
    if (this.voiceSession) {
      this.voiceSession.status = status;
      this.voiceSession.lastActivityAt = new Date();
    }
  }

  // ═══════════════════════════ 内部方法 ═══════════════════════════

  private setupEventBusListeners(): void {
    EventBus.on('ws_send', (data: unknown) => {
      const message = data as Record<string, unknown>;
      this.interactionHistory.push({
        type: 'ws_send',
        content: message,
        timestamp: new Date(),
      });
    });

    EventBus.on('user_input', (data: unknown) => {
      const input = data as Record<string, unknown>;
      this.interactionHistory.push({
        type: 'user_input',
        content: input.text,
        timestamp: new Date(),
      });
    });
  }

  private async outputResponseInternal(
    response: string,
    _emotion?: string,
    _scene?: string
  ): Promise<void> {
    void EventBus.emit('response_ready', {
      response,
      traceId: Logger.getTraceId() || `ie_${Date.now()}`,
      success: true,
    });
  }

  private buildMemoryContextFromHistory(): MemoryContextItem[] {
    return this.interactionHistory.slice(-10).map((h) => ({
      content:
        typeof h.content === 'string' ? h.content : JSON.stringify(h.content),
      type: h.type,
      timestamp: h.timestamp,
    }));
  }

  /**
   * 从 MemoryEngine 检索相关记忆，与交互历史合并
   * 修复记忆链路断点：使交互引擎能获取用户历史记忆
   */
  private async retrieveMemoryEnrichedContext(
    input: string,
    scene?: string,
    emotion?: string
  ): Promise<MemoryContextItem[]> {
    const historyContext = this.buildMemoryContextFromHistory();

    if (!this.memoryEngine?.preciseHybridRetrieval) {
      return historyContext;
    }

    try {
      const memories = await this.memoryEngine.preciseHybridRetrieval!(
        input,
        scene,
        emotion,
        5
      );

      const memoryItems: MemoryContextItem[] = (
        memories as Array<{
          content: string;
          type?: string;
          timestamp?: Date;
          relevanceScore?: number;
        }>
      ).map((m) => ({
        content:
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        type: m.type || 'long_term',
        timestamp: m.timestamp || new Date(),
        relevance: m.relevanceScore,
      }));

      const existingContents = new Set(historyContext.map((h) => h.content));
      const uniqueMemoryItems = memoryItems.filter(
        (m) => !existingContents.has(m.content)
      );

      return [...uniqueMemoryItems, ...historyContext];
    } catch (error) {
      Logger.warn(
        `⚠️ MemoryEngine 检索失败，降级到交互历史: ${(error as Error).message}`,
        'InteractionEngine'
      );
      return historyContext;
    }
  }

  private buildUserProfileSummary(): UserProfileSummary {
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
  public async generateMaxRetryResponse(): Promise<string> {
    if (this.dialogueGenerator) {
      try {
        return await this.dialogueGenerator.generate(
          '我已经尝试了很多次，但似乎遇到了困难。请告诉我更多细节，或者换个方式描述您的需求。',
          'work',
          [],
          this.buildUserProfileSummary()
        );
      } catch {
        return '抱歉，经过多次尝试仍无法完成。请提供更多细节，或换个方式描述需求。';
      }
    }
    return '抱歉，经过多次尝试仍无法完成。请提供更多细节，或换个方式描述需求。';
  }

  /**
   * 生成错误响应
   */
  public async generateErrorResponse(error: Error): Promise<string> {
    const errorMsg = error?.message || '未知错误';

    if (this.dialogueGenerator) {
      try {
        return await this.dialogueGenerator.generate(
          `执行过程中遇到问题：${errorMsg}。请确认相关服务是否正常运行。`,
          'work',
          [],
          this.buildUserProfileSummary()
        );
      } catch {
        return `执行遇到问题：${errorMsg}。`;
      }
    }
    return `执行遇到问题：${errorMsg}。`;
  }

  /**
   * 关闭交互引擎（兼容 JiaBaiXing 主类）
   */
  public async shutdown(): Promise<void> {
    Logger.info('正在关闭 InteractionEngine...', 'InteractionEngine');
    this.interactionHistory = [];
    this.isSpeaking = false;
    this.voiceSession = null;
  }

  public async generateResponseWithPersona(
    input: string,
    emotion: string,
    scene: string,
    context: MemoryItem[],
    traceId?: string
  ): Promise<TrackedResponseResult> {
    const finalTraceId =
      traceId ||
      `ie_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const startTime = Date.now();

    EventBus.startTrace(finalTraceId, 'interaction_generate_response', {
      input: input.substring(0, 50),
      emotion,
      scene,
      contextCount: context.length,
    });

    try {
      const memoryContextItems: MemoryContextItem[] = context.map((item) => ({
        content:
          typeof item.content === 'string'
            ? item.content
            : JSON.stringify(item.content),
        type: item.type,
        timestamp: item.timestamp,
      }));

      const baseResponse = await this.generateChatResponse(
        input,
        scene,
        memoryContextItems
      );

      const personaAdjusted = this.personaRules.adjustTone(baseResponse, scene);

      const emotionAdjusted = this.adjustByEmotion(
        personaAdjusted.adjustedContent,
        emotion
      );

      const currentPersona = this.getCurrentPersona();

      const confidence = this.calculateConfidence(emotion, scene);

      EventBus.completeTrace(finalTraceId, true);

      void EventBus.emit('response_ready', {
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
    } catch (error) {
      EventBus.failTrace(finalTraceId, (error as Error).message);

      return {
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        traceId: finalTraceId,
      };
    }
  }

  private adjustByEmotion(response: string, emotion: string): string {
    const emotionAdjustments: Record<string, (response: string) => string> = {
      开心: (r) => `😊 ${r}`,
      难过: (r) => `抱抱你，${r}`,
      生气: (r) => `我理解你的感受，${r}`,
      焦虑: (r) => `别担心，${r}`,
      平静: (r) => r,
    };

    const adjust = emotionAdjustments[emotion] || emotionAdjustments['平静'];
    return adjust(response);
  }

  private getCurrentPersona(): string {
    return '御姐秘书';
  }

  private calculateConfidence(emotion: string, scene: string): number {
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
