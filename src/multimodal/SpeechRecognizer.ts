/**
 * 语音识别器 v2
 * 集成 Whisper 本地语音识别，支持中文优化
 * 保持向后兼容原有接口
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';

// 固定 Python 代码片段（常量，绝不拼接任何外部输入）。
// 通过 `python -c <CODE> model lang tmpfile` 调用，CODE 读取 sys.argv[1..3]，
// 用户可控值始终作为独立 argv 元素传递，从根本上杜绝命令注入。
const PY_TRANSCRIBE_FASTER = `import sys
from faster_whisper import WhisperModel
_model, _lang, _audio = sys.argv[1], sys.argv[2], sys.argv[3]
_m = WhisperModel(_model)
_segments, _ = _m.transcribe(_audio, language=_lang)
print('\\n'.join([s.text for s in _segments]))`;

const PY_TRANSCRIBE_OPENAI = `import sys
import whisper
_model, _lang, _audio = sys.argv[1], sys.argv[2], sys.argv[3]
_m = whisper.load_model(_model)
_r = _m.transcribe(_audio, language=_lang)
print(_r['text'])`;

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
        // faster-whisper (Python) — 通过 CLI 检测（无 shell 调用）
        execFileSync(
          'python',
          ['-c', "from faster_whisper import WhisperModel; print('ok')"],
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
          // openai-whisper (Python) — 通过 CLI 检测（无 shell 调用）
          execFileSync('python', ['-c', "import whisper; print('ok')"], {
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

      // 输入白名单校验：模型名 / 语言 / 临时路径，拒绝含元字符或路径穿越的值
      this.validateWhisperInputs(this.config.model, lang, tmpFile);

      // 安全调用约定：
      // 1) execFileSync 默认关闭 shell —— 不经过任何 shell、无字符串拼接，
      //    模型名/路径中的引号、分号、&& 等元字符绝不会被解释执行。
      // 2) 用户可控值（model / lang / tmpFile）作为独立 argv 元素传入，
      //    由 Python 的 sys.argv[1..3] 读取，而非嵌入 -c 源码字符串。
      let output: string;
      if (modelType === 'faster-whisper') {
        output = execFileSync(
          'python',
          ['-c', PY_TRANSCRIBE_FASTER, this.config.model, lang, tmpFile],
          { stdio: 'pipe', timeout: 60000, encoding: 'utf-8' }
        );
      } else {
        output = execFileSync(
          'python',
          ['-c', PY_TRANSCRIBE_OPENAI, this.config.model, lang, tmpFile],
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

  /**
   * 白名单校验 ASR 调用的外部可控输入（模型名 / 语言 / 临时文件），
   * 防止命令注入与路径穿越。任意一项不合规即抛错，
   * 由调用方 catch 后降级为空结果（fail-closed）。
   */
  private validateWhisperInputs(model: string, lang: string, tmpFile: string): void {
    // 模型名：仅允许字母/数字/下划线/连字符（tiny/base/small/medium/large-v3 等）
    if (!/^[A-Za-z0-9_-]+$/.test(model)) {
      throw new Error(`非法的 Whisper 模型名（含非法字符）: ${JSON.stringify(model)}`);
    }
    // 语言代码：仅允许字母与连字符（如 zh / en）
    if (!/^[A-Za-z-]+$/.test(lang)) {
      throw new Error(`非法的 Whisper 语言代码（含非法字符）: ${JSON.stringify(lang)}`);
    }
    // 临时文件路径：必须归一化落在 <cwd>/tmp 内且以 .wav 结尾，杜绝路径穿越
    const allowedDir = path.resolve(process.cwd(), 'tmp');
    const resolved = path.resolve(tmpFile);
    const inside = resolved === allowedDir || resolved.startsWith(allowedDir + path.sep);
    if (path.extname(resolved) !== '.wav' || !inside) {
      throw new Error(
        `非法的 Whisper 临时文件路径（路径穿越或非法扩展名）: ${JSON.stringify(tmpFile)}`
      );
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
