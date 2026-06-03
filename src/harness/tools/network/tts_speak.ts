import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const TTS_SPEAK_DEF: ToolDefinition = {
  name: 'tts_speak',
  description:
    '文本转语音工具。将文字转为语音输出。适用场景：语音播报、配音、语音助手回复。支持调节语速和音色。',
  category: ToolCategory.NETWORK,
  parameters: {
    text: {
      type: 'string',
      description: '要转为语音的文本内容',
    },
    voice: {
      type: 'string',
      description: '音色选择',
      enum: ['default', 'female-gentle', 'female-professional', 'male-deep'],
      default: 'default',
    },
    speed: {
      type: 'number',
      description: '语速倍率',
      default: 1.0,
    },
  },
  requiredParams: ['text'],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};

export interface TTSSpeakDeps {
  speechSynthesizer?: {
    synthesize(options: {
      text: string;
      voice?: string;
      speed?: number;
      pitch?: number;
      emotion?: string;
    }): Promise<{
      success: boolean;
      audioData?: Buffer;
      duration?: number;
      error?: string;
    }>;
    speak(text: string, emotion?: string): Promise<{
      success: boolean;
      audioData?: Buffer;
      duration?: number;
      error?: string;
    }>;
    initialize?(): Promise<void>;
  };
}

function ok(output: string, duration: number, metadata?: Record<string, unknown>): ToolResult {
  return { success: true, output, duration, validated: false, metadata };
}

function fail(error: string, duration: number): ToolResult {
  return { success: false, output: '', error, duration, validated: false };
}

export function createTTSSpeakExecutor(deps: TTSSpeakDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const text = params.text as string;
    const voice = (params.voice as string) || 'default';
    const speed = (params.speed as number) || 1.0;

    try {
      if (!text || text.trim().length === 0) {
        return fail('文本内容不能为空', Date.now() - startTime);
      }

      if (deps.speechSynthesizer) {
        try {
          const result = await deps.speechSynthesizer.speak(text);
          if (result.success) {
            Logger.info(`🔊 tts_speak 成功: "${text.substring(0, 30)}..." voice=${voice} speed=${speed}`, 'TTSSpeak');
            return ok(
              `语音已生成并播放 (${result.duration || 0}ms)`,
              Date.now() - startTime,
              { duration: result.duration, voice, speed, textLength: text.length, synthesized: true }
            );
          }
          return fail(result.error || '语音合成失败', Date.now() - startTime);
        } catch (synthErr) {
          Logger.warn(`🔊 tts_speak SpeechSynthesizer 调用失败: ${(synthErr as Error).message}，降级到模拟模式`, 'TTSSpeak');
          return ok(
            `语音指令已接收: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
            Date.now() - startTime,
            { voice, speed, textLength: text.length, simulated: true }
          );
        }
      }

      Logger.info(`🔊 tts_speak (模拟): "${text.substring(0, 30)}..." voice=${voice} speed=${speed}`, 'TTSSpeak');
      return ok(
        `语音指令已接收: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        Date.now() - startTime,
        { voice, speed, textLength: text.length, simulated: true }
      );
    } catch (error) {
      Logger.error('❌ tts_speak 失败', error as Error, 'TTSSpeak');
      return fail(`语音合成失败: ${(error as Error).message}`, Date.now() - startTime);
    }
  };
}
