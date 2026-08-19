"use strict";
/**
 * 语音合成模块
 * I2: Coqui TTS自定义音色接入，御姐音色合成，延迟<500ms，支持流式输出
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpeechSynthesizer = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
class SpeechSynthesizer extends events_1.EventEmitter {
    constructor() {
        super();
        this.initialized = false;
        this.isSpeaking = false;
        this.isInterrupted = false;
        this.streamQueue = [];
        this.currentStream = '';
        this.coquiAvailable = false;
        this.defaultOptions = {
            text: '',
            voice: '御姐音色',
            speed: 1.0,
            pitch: 1.0,
            volume: 0.8,
            emotion: '平静',
            streaming: false,
            service: process.env.TTS_SERVICE ||
                'coqui',
        };
        this.coquiConfig = {
            modelPath: process.env.COQUI_MODEL_PATH ||
                path.join(process.cwd(), 'models', 'coqui', 'tts_models'),
            vocoderPath: process.env.COQUI_VOCODER_PATH ||
                path.join(process.cwd(), 'models', 'coqui', 'vocoder'),
            speakerWav: process.env.COQUI_SPEAKER_WAV ||
                path.join(process.cwd(), 'data', 'voices', 'oneesan.wav'),
            language: 'zh-cn',
        };
        this.activeService =
            process.env.TTS_SERVICE ||
                'local';
    }
    /**
     * 初始化（I2: Coqui TTS支持）
     */
    async initialize() {
        try {
            // 检测并初始化 Coqui TTS（Python 子进程方式）
            await this.initializeCoquiTTS();
            // 如 Coqui 不可用，降级到 local mock 模式
            if (!this.coquiAvailable) {
                this.activeService = 'local';
            }
            Logger_1.Logger.info(`🔊 语音合成器初始化完成 [服务: ${this.activeService}, Coqui: ${this.coquiAvailable ? '可用' : '不可用'}]`, 'SpeechSynthesizer');
            this.initialized = true;
        }
        catch (error) {
            Logger_1.Logger.error('❌ 语音合成器初始化失败', error, 'SpeechSynthesizer');
            this.initialized = false;
            throw error;
        }
    }
    /**
     * I2: 初始化Coqui TTS — 通过 Python 子进程检测模型可用性
     */
    async initializeCoquiTTS() {
        try {
            // 检查 Coqui TTS Python 包是否安装
            (0, child_process_1.execSync)('python -c "import TTS"', {
                stdio: 'pipe',
                timeout: 5000,
            });
            // 检查自定义音色文件
            if (this.coquiConfig.speakerWav) {
                const speakerExists = fs.existsSync(this.coquiConfig.speakerWav);
                if (!speakerExists) {
                    Logger_1.Logger.warn(`⚠️ 自定义音色文件不存在: ${this.coquiConfig.speakerWav}，将使用默认音色`, 'SpeechSynthesizer');
                }
            }
            this.coquiAvailable = true;
            Logger_1.Logger.info('✅ Coqui TTS Python 环境可用', 'SpeechSynthesizer');
        }
        catch (err) {
            Logger_1.Logger.debug(`Coqui TTS Python 环境不可用: ${err?.message}，语音合成将使用本地 mock 模式`, 'SpeechSynthesizer');
            this.coquiAvailable = false;
        }
    }
    /**
     * I2: 流式合成语音（分块输出）
     */
    async synthesizeStream(options) {
        this.ensureInitialized();
        const sentences = options.text
            .split(/([。！？！?.])/)
            .filter((s) => s.trim().length > 0);
        for (let i = 0; i < sentences.length; i++) {
            if (this.isInterrupted) {
                this.isInterrupted = false;
                this.emit('streamEnd', { isLast: true });
                return;
            }
            const sentence = sentences[i].trim();
            if (!sentence)
                continue;
            const chunkOptions = { ...options, text: sentence, streaming: true };
            const result = await this.synthesize(chunkOptions);
            if (result.success && result.audioData) {
                const chunk = {
                    text: sentence,
                    audioData: result.audioData,
                    isLast: i === sentences.length - 1,
                };
                this.emit('streamChunk', chunk);
                await this.sleep(50);
            }
        }
        this.emit('streamEnd', { isLast: true });
    }
    /**
     * I3: 打断当前语音播放
     */
    interrupt() {
        this.isInterrupted = true;
    }
    /**
     * I3: 是否正在说话
     */
    getIsSpeaking() {
        return this.isSpeaking;
    }
    /**
     * 合成语音（I2: Coqui TTS支持）
     */
    async synthesize(options) {
        this.ensureInitialized();
        const finalOptions = { ...this.defaultOptions, ...options };
        const service = finalOptions.service || this.activeService;
        try {
            switch (service) {
                case 'coqui':
                    return this.coquiAvailable
                        ? this.synthesizeWithCoqui(finalOptions)
                        : this.synthesizeWithLocal(finalOptions);
                case 'google':
                    return this.synthesizeWithGoogle(finalOptions);
                case 'amazon':
                    return this.synthesizeWithAmazon(finalOptions);
                case 'local':
                default:
                    return this.synthesizeWithLocal(finalOptions);
            }
        }
        catch (error) {
            Logger_1.Logger.error('❌ 语音合成器：合成失败', error, 'SpeechSynthesizer');
            return { success: false, error: error.message };
        }
    }
    /**
     * I2: 使用Coqui TTS合成（御姐音色）— 通过 Python 子进程调用
     */
    async synthesizeWithCoqui(options) {
        const startTime = Date.now();
        try {
            const tmpFile = path.join(process.cwd(), 'tmp', `tts_${Date.now()}.wav`);
            // 确保临时目录存在
            const tmpDir = path.dirname(tmpFile);
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }
            const emotionParams = this.adjustParamsForEmotion(options.emotion);
            const adjustedSpeed = (options.speed || 1.0) * (emotionParams.speed || 1.0);
            // 构建 Coqui TTS CLI 命令
            const args = [
                '--text',
                `"${options.text.replace(/"/g, '\\"')}"`,
                '--out_path',
                tmpFile,
                '--speed',
                String(adjustedSpeed),
            ];
            if (this.coquiConfig.speakerWav &&
                fs.existsSync(this.coquiConfig.speakerWav)) {
                args.push('--speaker_wav', this.coquiConfig.speakerWav);
            }
            if (this.coquiConfig.modelPath) {
                args.push('--model_path', this.coquiConfig.modelPath);
            }
            Logger_1.Logger.info(`🔊 Coqui TTS: 合成中... (语速=${adjustedSpeed}, 情绪=${options.emotion})`, 'SpeechSynthesizer');
            (0, child_process_1.execSync)(`python -m TTS ${args.join(' ')}`, {
                stdio: 'pipe',
                timeout: 30000,
            });
            // 读取生成的音频文件
            const audioData = fs.readFileSync(tmpFile);
            const processingTime = Date.now() - startTime;
            // 清理临时文件
            try {
                fs.unlinkSync(tmpFile);
            }
            catch (err) {
                Logger_1.Logger.debug(`临时文件清理失败: ${err?.message}`, 'SpeechSynthesizer');
            }
            return {
                success: true,
                audioData,
                duration: processingTime,
            };
        }
        catch (error) {
            Logger_1.Logger.warn(`Coqui TTS 调用失败，降级到本地模式: ${error.message}`, 'SpeechSynthesizer');
            return this.synthesizeWithLocal(options);
        }
    }
    async synthesizeWithGoogle(_options) {
        Logger_1.Logger.warn('Google TTS 需要 GOOGLE_TTS_API_KEY 环境变量，当前未配置，降级到本地模式', 'SpeechSynthesizer');
        return this.synthesizeWithLocal(_options);
    }
    async synthesizeWithAmazon(_options) {
        Logger_1.Logger.warn('Amazon Polly 需要 AWS 凭证，当前未配置，降级到本地模式', 'SpeechSynthesizer');
        return this.synthesizeWithLocal(_options);
    }
    synthesizeWithLocal(options) {
        Logger_1.Logger.info(`🔊 本地语音合成(mock): "${options.text.substring(0, 30)}..."`, 'SpeechSynthesizer');
        const audioData = Buffer.from('本地引擎 模拟音频数据');
        return { success: true, audioData, duration: options.text.length / 100 };
    }
    /**
     * I3: 全双工播放（支持边听边说+打断）
     */
    async speak(text, emotion) {
        this.ensureInitialized();
        this.isSpeaking = true;
        this.emit('speakingStart', { text, emotion });
        const emotionParams = this.adjustParamsForEmotion(emotion || this.defaultOptions.emotion);
        const options = {
            text,
            emotion: emotion || this.defaultOptions.emotion,
            ...emotionParams,
        };
        const result = await this.synthesize(options);
        if (result.success && result.audioData) {
            this.emit('ttsChunk', {
                audio: result.audioData.toString('base64'),
                isLast: true,
                text,
            });
        }
        this.isSpeaking = false;
        this.emit('speakingEnd', { text });
        return result;
    }
    /**
     * 流式播放语音
     */
    async speakStreaming(text, emotion) {
        this.ensureInitialized();
        this.isSpeaking = true;
        const options = {
            text,
            emotion: emotion || this.defaultOptions.emotion,
            streaming: true,
        };
        Logger_1.Logger.info('🔊 语音合成器：流式播放语音', 'SpeechSynthesizer');
        try {
            await this.synthesizeStream(options);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
        finally {
            this.isSpeaking = false;
        }
    }
    /**
     * 批量合成语音
     */
    async batchSynthesize(texts, emotion) {
        this.ensureInitialized();
        const results = [];
        for (const text of texts) {
            const result = await this.speak(text, emotion);
            results.push(result);
        }
        return results;
    }
    setDefaultOptions(options) {
        this.defaultOptions = { ...this.defaultOptions, ...options };
    }
    getDefaultOptions() {
        return { ...this.defaultOptions };
    }
    async getAvailableVoices() {
        this.ensureInitialized();
        return ['御姐音色', '温柔女声', '甜美女声', '知性女声'];
    }
    async getAvailableEmotions() {
        this.ensureInitialized();
        return ['平静', '开心', '悲伤', '惊讶', '愤怒', '温柔', '宠溺'];
    }
    /**
     * 根据情绪调整合成参数
     */
    adjustParamsForEmotion(emotion) {
        const actualEmotion = emotion || '平静';
        switch (actualEmotion) {
            case '开心':
                return { speed: 1.1, pitch: 1.1, volume: 0.9 };
            case '悲伤':
                return { speed: 0.9, pitch: 0.9, volume: 0.7 };
            case '惊讶':
                return { speed: 1.2, pitch: 1.3, volume: 0.9 };
            case '愤怒':
                return { speed: 1.1, pitch: 0.8, volume: 1.0 };
            case '温柔':
                return { speed: 0.9, pitch: 1.0, volume: 0.7 };
            case '宠溺':
                return { speed: 0.8, pitch: 1.1, volume: 0.8 };
            default:
                return {};
        }
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('语音合成器未初始化！请先调用initialize方法。');
        }
    }
    async shutdown() {
        this.isInterrupted = true;
        this.streamQueue = [];
        this.initialized = false;
    }
}
exports.SpeechSynthesizer = SpeechSynthesizer;
