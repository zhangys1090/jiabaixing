/**
 * Harness Tool: voice_interact - 实时语音交互工具
 *
 * 支持语音会话管理、语音合成（TTS）、语音识别（STT）等操作。
 * 参考 Hermes Agent Voice Mode 功能设计。
 */

import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const VOICE_INTERACT_DEF: ToolDefinition = {
  name: 'voice_interact',
  description:
    '语音交互工具。管理实时语音会话，支持语音合成(speak)、语音识别(listen)、会话控制等操作。适用场景：语音对话、语音播报、语音助手交互。',
  category: ToolCategory.SYSTEM,
  parameters: {
    action: {
      type: 'string',
      description:
        '操作类型：start_session=开始语音会话，stop_session=停止语音会话，speak=将文本转为语音，listen=获取语音输入并识别，status=获取语音会话状态',
      enum: [
        'start_session',
        'stop_session',
        'speak',
        'listen',
        'status',
      ],
    },
    text: {
      type: 'string',
      description: 'speak 操作时要转为语音的文本内容',
    },
    language: {
      type: 'string',
      description: '语音识别/合成的语言，默认 zh-CN',
      default: 'zh-CN',
    },
    emotion: {
      type: 'string',
      description: '语音合成的情绪参数',
      enum: ['平静', '开心', '悲伤', '惊讶', '愤怒', '温柔', '宠溺'],
      default: '平静',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'low',
  idempotent: false,
  timeout: 60000,
};

/**
 * 语音交互工具依赖接口
 */
export interface VoiceInteractDeps {
  interactionEngine?: {
    startVoiceSession(language?: string): {
      id: string;
      status: string;
      language: string;
      startedAt: Date;
      lastActivityAt: Date;
      turnCount: number;
    };
    stopVoiceSession(): void;
    processVoiceInput(audioData: Buffer): Promise<{
      text: string;
      audioData?: Buffer;
      duration: number;
      turnCount: number;
    }>;
    getVoiceSession(): {
      id: string;
      status: string;
      language: string;
      startedAt: Date;
      lastActivityAt: Date;
      turnCount: number;
    } | null;
    speechSynthesizer?: {
      speak(
        text: string,
        emotion?: string
      ): Promise<{
        success: boolean;
        audioData?: Buffer;
        duration?: number;
        error?: string;
      }>;
    };
  };
}

function ok(
  output: string,
  duration: number,
  metadata?: Record<string, unknown>
): ToolResult {
  return { success: true, output, duration, validated: false, metadata };
}

function fail(error: string, duration: number): ToolResult {
  return { success: false, output: '', error, duration, validated: false };
}

/**
 * 创建 voice_interact 执行器
 */
export function createVoiceInteractExecutor(deps: VoiceInteractDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const action = params.action as string;
    const text = params.text as string;
    const language = (params.language as string) || 'zh-CN';
    const emotion = (params.emotion as string) || '平静';

    try {
      switch (action) {
        case 'start_session':
          return handleStartSession(deps, language, startTime);

        case 'stop_session':
          return handleStopSession(deps, startTime);

        case 'speak':
          return handleSpeak(deps, text, emotion, startTime);

        case 'listen':
          return handleListen(deps, startTime);

        case 'status':
          return handleStatus(deps, startTime);

        default:
          return fail(
            `不支持的操作: ${action}。支持: start_session, stop_session, speak, listen, status`,
            Date.now() - startTime
          );
      }
    } catch (error) {
      Logger.error(
        '❌ voice_interact 失败',
        error as Error,
        'VoiceInteract'
      );
      return fail(
        `语音交互失败: ${(error as Error).message}`,
        Date.now() - startTime
      );
    }
  };
}

/**
 * 处理 start_session 操作
 */
function handleStartSession(
  deps: VoiceInteractDeps,
  language: string,
  startTime: number
): ToolResult {
  if (deps.interactionEngine) {
    const session = deps.interactionEngine.startVoiceSession(language);
    Logger.info(
      `🎤 voice_interact: 语音会话已启动 id=${session.id}`,
      'VoiceInteract'
    );
    return ok(
      `语音会话已启动 (id=${session.id}, language=${language})`,
      Date.now() - startTime,
      {
        sessionId: session.id,
        language: session.language,
        status: session.status,
      }
    );
  }

  // 模拟模式
  const mockSessionId = `voice_${Date.now()}_mock`;
  Logger.info(
    `🎤 voice_interact (模拟): 语音会话已启动 id=${mockSessionId}`,
    'VoiceInteract'
  );
  return ok(
    `语音会话已启动 (模拟模式, id=${mockSessionId}, language=${language})`,
    Date.now() - startTime,
    { sessionId: mockSessionId, language, status: 'idle', simulated: true }
  );
}

/**
 * 处理 stop_session 操作
 */
function handleStopSession(
  deps: VoiceInteractDeps,
  startTime: number
): ToolResult {
  if (deps.interactionEngine) {
    const currentSession = deps.interactionEngine.getVoiceSession();
    if (!currentSession) {
      return fail('没有活跃的语音会话', Date.now() - startTime);
    }
    const turnCount = currentSession.turnCount;
    deps.interactionEngine.stopVoiceSession();
    Logger.info('🎤 voice_interact: 语音会话已停止', 'VoiceInteract');
    return ok(
      `语音会话已停止 (轮次=${turnCount})`,
      Date.now() - startTime,
      { turnCount }
    );
  }

  Logger.info('🎤 voice_interact (模拟): 语音会话已停止', 'VoiceInteract');
  return ok('语音会话已停止 (模拟模式)', Date.now() - startTime, {
    simulated: true,
  });
}

/**
 * 处理 speak 操作
 */
async function handleSpeak(
  deps: VoiceInteractDeps,
  text: string,
  emotion: string,
  startTime: number
): Promise<ToolResult> {
  if (!text || text.trim().length === 0) {
    return fail('speak 操作需要提供 text 参数', Date.now() - startTime);
  }

  if (deps.interactionEngine?.speechSynthesizer) {
    try {
      const result = await deps.interactionEngine.speechSynthesizer.speak(
        text,
        emotion
      );
      if (result.success) {
        Logger.info(
          `🔊 voice_interact speak: "${text.substring(0, 30)}..."`,
          'VoiceInteract'
        );
        return ok(
          `语音已生成并播放 (${result.duration || 0}ms)`,
          Date.now() - startTime,
          {
            duration: result.duration,
            emotion,
            textLength: text.length,
            synthesized: true,
          }
        );
      }
      return fail(result.error || '语音合成失败', Date.now() - startTime);
    } catch (synthErr) {
      Logger.warn(
        `🔊 voice_interact SpeechSynthesizer 调用失败: ${(synthErr as Error).message}，降级到模拟模式`,
        'VoiceInteract'
      );
      return ok(
        `语音指令已接收: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        Date.now() - startTime,
        { emotion, textLength: text.length, simulated: true }
      );
    }
  }

  Logger.info(
    `🔊 voice_interact (模拟): "${text.substring(0, 30)}..."`,
    'VoiceInteract'
  );
  return ok(
    `语音指令已接收: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
    Date.now() - startTime,
    { emotion, textLength: text.length, simulated: true }
  );
}

/**
 * 处理 listen 操作
 * 注意：实际音频设备访问需要平台特定 API，当前使用模拟实现
 */
async function handleListen(
  deps: VoiceInteractDeps,
  startTime: number
): Promise<ToolResult> {
  if (deps.interactionEngine) {
    const session = deps.interactionEngine.getVoiceSession();
    if (!session) {
      return fail(
        '没有活跃的语音会话，请先使用 start_session',
        Date.now() - startTime
      );
    }

    // 模拟音频输入（实际实现需要平台特定 API 捕获麦克风数据）
    const mockAudioData = Buffer.from('模拟音频输入数据');
    try {
      const result = await deps.interactionEngine.processVoiceInput(
        mockAudioData
      );
      Logger.info(
        `🎤 voice_interact listen: 识别完成 turn=${result.turnCount}`,
        'VoiceInteract'
      );
      return ok(
        result.text
          ? `语音识别结果: "${result.text}" (轮次=${result.turnCount})`
          : '未检测到语音输入',
        Date.now() - startTime,
        {
          text: result.text,
          turnCount: result.turnCount,
          duration: result.duration,
          hasAudio: !!result.audioData,
        }
      );
    } catch (error) {
      return fail(
        `语音识别失败: ${(error as Error).message}`,
        Date.now() - startTime
      );
    }
  }

  // 模拟模式
  Logger.info('🎤 voice_interact (模拟): listen 操作', 'VoiceInteract');
  return ok('语音监听已就绪 (模拟模式，等待音频输入)', Date.now() - startTime, {
    simulated: true,
    note: '实际音频设备访问需要平台特定 API',
  });
}

/**
 * 处理 status 操作
 */
function handleStatus(
  deps: VoiceInteractDeps,
  startTime: number
): ToolResult {
  if (deps.interactionEngine) {
    const session = deps.interactionEngine.getVoiceSession();
    if (!session) {
      return ok('当前没有活跃的语音会话', Date.now() - startTime, {
        active: false,
      });
    }
    return ok(
      `语音会话状态: id=${session.id}, status=${session.status}, language=${session.language}, turns=${session.turnCount}`,
      Date.now() - startTime,
      {
        active: true,
        sessionId: session.id,
        status: session.status,
        language: session.language,
        turnCount: session.turnCount,
        startedAt: session.startedAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      }
    );
  }

  return ok('语音交互未初始化 (模拟模式)', Date.now() - startTime, {
    active: false,
    simulated: true,
  });
}
