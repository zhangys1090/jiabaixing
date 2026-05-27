/**
 * 语音识别器 v2
 * 集成 Whisper 本地语音识别，支持中文优化
 * 保持向后兼容原有接口
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';

export interface SpeechRecognitionResult {
  text: string;
  confidence: number;
  language?: string;
  duration?: number;
  timestamp?: Date;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    confidence: number;
  }>;
}

export interface SpeechRecognizerConfig {
  language: string;
  sampleRate: number;
  model: string;
  enableAutomaticPunctuation: boolean;
  device?: 'cpu' | 'cuda';
  computeType?: 'int8' | 'float16' | 'float32';
}

export class SpeechRecognizer {
  private initialized = false;
  private config: SpeechRecognizerConfig;
  private whisperModel: unknown = null;

  constructor(config?: Partial<SpeechRecognizerConfig>) {
    this.config = {
      language: 'zh-CN',
      sampleRate: 16000,
      model: 'base',
      enableAutomaticPunctuation: true,
      device: 'cpu',
      computeType: 'int8',
      ...config,
    };
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      Logger.info(
        `🎤 初始化 Whisper 模型: ${this.config.model} (${this.config.device})`,
        'SpeechRecognizer'
      );

      // 尝试检测 Whisper Python 环境
      try {
        // faster-whisper (Python) — 通过 CLI 检测
        execSync(
          'python -c "from faster_whisper import WhisperModel; print(\'ok\')"',
          {
            stdio: 'pipe',
            timeout: 5000,
          }
        );
        this.whisperModel = { type: 'faster-whisper' };
        Logger.info('✅ faster-whisper Python 环境可用', 'SpeechRecognizer');
      } catch {
        Logger.info(
          'faster-whisper 不可用，尝试 openai-whisper',
          'SpeechRecognizer'
        );
        try {
          // openai-whisper (Python) — 通过 CLI 检测
          execSync('python -c "import whisper; print(\'ok\')"', {
            stdio: 'pipe',
            timeout: 5000,
          });
          this.whisperModel = { type: 'openai-whisper' };
          Logger.info('✅ openai-whisper Python 环境可用', 'SpeechRecognizer');
        } catch {
          Logger.warn(
            'Whisper Python 环境均不可用，语音识别将运行在降级模式（返回空结果）',
            'SpeechRecognizer'
          );
        }
      }

      this.initialized = true;
    } catch (error) {
      Logger.error(
        '❌ Whisper 模型初始化失败',
        error as Error,
        'SpeechRecognizer'
      );
      // 降级为模拟模式
      this.initialized = true;
    }
  }

  public async recognize(audioData: Buffer): Promise<SpeechRecognitionResult> {
    // 懒初始化：如果未初始化，自动初始化（不阻塞调用方）
    if (!this.initialized) {
      Logger.warn('语音识别器未初始化，正在懒初始化...', 'SpeechRecognizer');
      try {
        await this.initialize();
      } catch {
        // 懒初始化失败，返回降级结果
        return {
          text: '',
          confidence: 0,
          language: this.config.language,
          duration: 0,
          timestamp: new Date(),
        };
      }
    }

    const startTime = Date.now();
    const traceId = `voice_${Date.now()}`;

    void EventBus.emit('perception_update', {
      traceId,
      modality: 'voice',
      status: 'started',
      timestamp: new Date().toISOString(),
    });

    try {
      // 如果有 Whisper 模型，使用它
      if (this.whisperModel) {
        void EventBus.emit('perception_update', {
          traceId,
          modality: 'voice',
          status: 'processing',
          progress: 0.5,
          timestamp: new Date().toISOString(),
        });
        const result = await this.transcribeWithWhisper(audioData);
        void EventBus.emit('perception_update', {
          traceId,
          modality: 'voice',
          status: 'completed',
          progress: 1,
          result: { text: result.text, language: result.language },
          confidence: result.confidence,
          timestamp: new Date().toISOString(),
        });
        return {
          ...result,
          duration: Date.now() - startTime,
          timestamp: new Date(),
        };
      }

      // 降级：返回空结果
      void EventBus.emit('perception_update', {
        traceId,
        modality: 'voice',
        status: 'completed',
        progress: 1,
        result: { text: '', language: this.config.language },
        confidence: 0,
        timestamp: new Date().toISOString(),
      });
      return {
        text: '',
        confidence: 0,
        language: this.config.language,
        duration: Date.now() - startTime,
        timestamp: new Date(),
      };
    } catch (error) {
      Logger.error('❌ 语音识别失败', error as Error, 'SpeechRecognizer');
      void EventBus.emit('perception_update', {
        traceId,
        modality: 'voice',
        status: 'failed',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
      return {
        text: '',
        confidence: 0,
        language: this.config.language,
        duration: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private async transcribeWithWhisper(
    audioData: Buffer
  ): Promise<SpeechRecognitionResult> {
    const tmpFile = path.join(
      process.cwd(),
      'tmp',
      `whisper_${Date.now()}.wav`
    );

    try {
      // 确保临时目录存在
      const tmpDir = path.dirname(tmpFile);
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }

      // 写入临时音频文件
      fs.writeFileSync(tmpFile, audioData);

      const modelType =
        (this.whisperModel as { type?: string })?.type || 'faster-whisper';
      const lang = this.config.language?.split('-')[0] || 'zh';

      // 调用 Python Whisper CLI 进行转录
      let output: string;
      if (modelType === 'faster-whisper') {
        output = execSync(
          `python -c "from faster_whisper import WhisperModel; m = WhisperModel('${this.config.model}'); segments, _ = m.transcribe('${tmpFile}', language='${lang}'); print('\\n'.join([s.text for s in segments]))"`,
          { stdio: 'pipe', timeout: 60000, encoding: 'utf-8' }
        );
      } else {
        output = execSync(
          `python -c "import whisper; m = whisper.load_model('${this.config.model}'); r = m.transcribe('${tmpFile}', language='${lang}'); print(r['text'])"`,
          { stdio: 'pipe', timeout: 60000, encoding: 'utf-8' }
        );
      }

      const text = this.postProcessText(output.trim());

      return {
        text,
        confidence: text.length > 0 ? 0.8 : 0,
        language: this.config.language,
        duration: 0,
        timestamp: new Date(),
      };
    } catch (error) {
      Logger.warn(
        `Whisper 转录失败: ${(error as Error).message}`,
        'SpeechRecognizer'
      );
      return { text: '', confidence: 0, language: this.config.language };
    } finally {
      // 清理临时文件
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }

  private postProcessText(text: string): string {
    let processed = text.trim();

    // 添加标点
    processed = this.addPunctuation(processed);

    // 数字格式化
    processed = this.formatNumbers(processed);

    // 去除重复词
    processed = this.removeRepeatedWords(processed);

    return processed;
  }

  private addPunctuation(text: string): string {
    const withPeriods = text.replace(
      /(?<=[\u4e00-\u9fa5]{3,})(?=\s+[\u4e00-\u9fa5])/g,
      '。'
    );
    if (!/[。！？.!?]$/.test(withPeriods)) {
      return withPeriods + '。';
    }
    return withPeriods;
  }

  private formatNumbers(text: string): string {
    return text.replace(/(\d{4})[-\s]?(\d{4})[-\s]?(\d{4})/g, '$1-$2-$3');
  }

  private removeRepeatedWords(text: string): string {
    return text.replace(/(\b\w+\b)\s+\1/g, '$1');
  }

  private calculateAverageConfidence(
    segments: Array<{ confidence: number }>
  ): number {
    if (segments.length === 0) return 0;
    const sum = segments.reduce((acc, seg) => acc + seg.confidence, 0);
    return sum / segments.length;
  }

  public updateConfig(config: Partial<SpeechRecognizerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public getConfig(): SpeechRecognizerConfig {
    return { ...this.config };
  }

  public async shutdown(): Promise<void> {
    this.whisperModel = null;
    this.initialized = false;
    Logger.info('🎤 语音识别器已关闭', 'SpeechRecognizer');
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('语音识别器未初始化！请先调用initialize方法。');
    }
  }
}

export default SpeechRecognizer;
