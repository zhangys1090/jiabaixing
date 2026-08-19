/**
 * Harness Tool: voice_interact - 实时语音交互工具
 *
 * 支持语音会话管理、语音合成（TTS）、语音识别（STT）等操作。
 * 参考 Hermes Agent Voice Mode 功能设计。
 */

import * as fs from 'fs';
import { Logger } from '../../../utils/Logger';
import { EventBus } from '../../../shared/EventBus';
import { SpeechRecognizer } from '../../../multimodal/SpeechRecognizer';
import {
  SpeechSynthesizer,
  type TTSBackend,
} from '../../../multimodal/SpeechSynthesizer';
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
      enum: ['start_session', 'stop_session', 'speak', 'listen', 'status'],
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
    audioPath: {
      type: 'string',
      description:
        'listen 操作：待识别的音频文件路径（wav）。提供后执行真实 ASR，替换原先的模拟音频。',
    },
    ttsBackend: {
      type: 'string',
      description: 'speak 操作：TTS 后端选择（mock=仅记录意图 / real=真实合成）。默认 mock。',
      enum: ['mock', 'real'],
      default: 'mock',
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
    /** 真实麦克风采集器（返回 PCM/wav Buffer）；未注入则 listen 需要 audioPath */
    audioCapturer?: (language: string) => Promise<Buffer>;
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

let _sharedRecognizer: SpeechRecognizer | null = null;
function getSharedRecognizer(): SpeechRecognizer {
  if (!_sharedRecognizer) _sharedRecognizer = new SpeechRecognizer();
  return _sharedRecognizer;
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
          return handleSpeak(deps, text, emotion, params, startTime);

        case 'listen':
          return handleListen(deps, params, startTime);

        case 'status':
          return handleStatus(deps, startTime);

        default:
          return fail(
            `不支持的操作: ${action}。支持: start_session, stop_session, speak, listen, status`,
            Date.now() - startTime
          );
      }
    } catch (error) {
      Logger.error('❌ voice_interact 失败', error as Error, 'VoiceInteract');
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
    return ok(`语音会话已停止 (轮次=${turnCount})`, Date.now() - startTime, {
      turnCount,
    });
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
  params: Record<string, unknown>,
  startTime: number
): Promise<ToolResult> {
  if (!text || text.trim().length === 0) {
    return fail('speak 操作需要提供 text 参数', Date.now() - startTime);
  }

  // P1-3：TTS 后端切换（real 走真实合成器，mock 仅记录意图）
  const ttsBackend = (
    (params.ttsBackend as TTSBackend) ||
    (deps.interactionEngine?.speechSynthesizer ? 'real' : 'mock')
  ) as TTSBackend;

  const synthesizer = new SpeechSynthesizer(
    ttsBackend,
    deps.interactionEngine?.speechSynthesizer
      ? (t, e) => deps.interactionEngine!.speechSynthesizer!.speak(t, e)
      : undefined
  );

  const result = await synthesizer.speak(text, emotion);
  if (!result.success) {
    return fail(result.error || '语音合成失败', Date.now() - startTime);
  }

  Logger.info(
    `🔊 voice_interact speak [${result.backend}]: "${text.substring(0, 30)}..."`,
    'VoiceInteract'
  );
  return ok(
    result.backend === 'real'
      ? `语音已生成并播放 (${(result.duration ?? 0)}ms)`
      : `语音指令已接收: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
    Date.now() - startTime,
    {
      emotion,
      textLength: text.length,
      synthesized: result.backend === 'real',
      backend: result.backend,
    }
  );
}

/**
 * 处理 listen 操作
 * 注意：实际音频设备访问需要平台特定 API，当前使用模拟实现
 */
async function handleListen(
  deps: VoiceInteractDeps,
  params: Record<string, unknown>,
  startTime: number
): Promise<ToolResult> {
  const language = (params.language as string) || 'zh-CN';

  // P1-3：获取真实音频数据源，替换原先硬编码的 Buffer.from('模拟音频输入数据')
  let audioBuffer: Buffer | null = null;
  const audioPath = params.audioPath as string | undefined;
  if (audioPath) {
    try {
      audioBuffer = fs.readFileSync(audioPath);
    } catch (readErr) {
      return fail(
        `无法读取音频文件: ${audioPath} (${(readErr as Error).message})`,
        Date.now() - startTime
      );
    }
  } else if (deps.audioCapturer) {
    try {
      audioBuffer = await deps.audioCapturer(language);
    } catch (capErr) {
      Logger.warn(
        `🎤 麦克风采集失败: ${(capErr as Error).message}`,
        'VoiceInteract'
      );
    }
  }

  if (audioBuffer && audioBuffer.length > 0) {
    // 真实 ASR：经 SpeechRecognizer（识别过程会自动写入感知总线 EventBus）
    const recognizer = getSharedRecognizer();
    const result = await recognizer.recognize(audioBuffer);

    // ASR 结果写入感知总线（voice_recognized 事件供对话/感知链路消费）
    EventBus.emit('voice_recognized', {
      text: result.text,
      language,
      confidence: result.confidence,
      timestamp: new Date().toISOString(),
    });

    // 回灌对话引擎（若已装配真实交互引擎）
    if (deps.interactionEngine && result.text) {
      try {
        (
          deps.interactionEngine as {
            handleUserSpeech?: (t: string) => void;
          }
        ).handleUserSpeech?.(result.text);
      } catch {
        /* 交互引擎不一定实现 handleUserSpeech，忽略 */
      }
    }

    Logger.info(
      `🎤 voice_interact listen: 真实识别="${result.text}"`,
      'VoiceInteract'
    );
    return ok(
      result.text ? `语音识别结果: "${result.text}"` : '未检测到语音输入',
      Date.now() - startTime,
      {
        text: result.text,
        confidence: result.confidence,
        language,
        hasAudio: true,
        asr: true,
        turnCount: deps.interactionEngine?.getVoiceSession?.()?.turnCount ?? 0,
      }
    );
  }

  // 无音频源：fail-closed（不再回退到静默 mock）
  return fail(
    '未提供音频源（audioPath 参数），且当前环境无可用的麦克风采集，无法执行真实语音识别',
    Date.now() - startTime
  );
}

/**
 * 处理 status 操作
 */
function handleStatus(deps: VoiceInteractDeps, startTime: number): ToolResult {
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
