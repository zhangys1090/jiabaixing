"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTS_SPEAK_DEF = void 0;
exports.createTTSSpeakExecutor = createTTSSpeakExecutor;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.TTS_SPEAK_DEF = {
    name: 'tts_speak',
    description: '文本转语音工具。将文字转为语音输出。适用场景：语音播报、配音、语音助手回复。支持调节语速、音色和音量，支持SSML标记。',
    category: types_1.ToolCategory.NETWORK,
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
            description: '语速倍率（0.5-2.0，1.0为正常语速）',
            default: 1.0,
        },
        pitch: {
            type: 'number',
            description: '音调倍率（0.5-2.0，1.0为正常音调）',
            default: 1.0,
        },
        volume: {
            type: 'number',
            description: '音量（0.0-1.0，1.0为最大音量）',
            default: 1.0,
        },
        format: {
            type: 'string',
            description: '输出音频格式',
            enum: ['mp3', 'wav', 'pcm'],
            default: 'mp3',
        },
        ssml: {
            type: 'boolean',
            description: '文本是否为SSML格式，默认false',
            default: false,
        },
    },
    requiredParams: ['text'],
    requiredPermissions: [types_1.Permission.NETWORK_ACCESS],
    riskLevel: 'low',
    idempotent: true,
    timeout: 30000,
};
function ok(output, duration, metadata) {
    return { success: true, output, duration, validated: false, metadata };
}
function fail(error, duration) {
    return { success: false, output: '', error, duration, validated: false };
}
function preprocessText(text) {
    let processed = text;
    processed = processed.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, '$1年$2月$3日');
    processed = processed.replace(/(\d+)%/g, '$1百分之');
    processed = processed.replace(/(\d+\.?\d*)°C/g, '$1摄氏度');
    processed = processed.replace(/(\d+\.?\d*)°F/g, '$1华氏度');
    processed = processed.replace(/(\d{3,})/g, (match) => match.split('').join(' '));
    return processed;
}

function wrapSSML(text, voice, speed, pitch, volume) {
    const prosodyAttrs = [];
    if (speed !== 1.0) prosodyAttrs.push(`rate="${speed > 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%"`);
    if (pitch !== 1.0) prosodyAttrs.push(`pitch="${pitch > 1 ? '+' : ''}${Math.round((pitch - 1) * 100)}%"`);
    if (volume < 1.0) prosodyAttrs.push(`volume="${Math.round(volume * 100)}%"`);
    const voiceTag = voice !== 'default' ? `<voice name="${voice}">` : '';
    const voiceClose = voice !== 'default' ? '</voice>' : '';
    const prosodyOpen = prosodyAttrs.length > 0 ? `<prosody ${prosodyAttrs.join(' ')}>` : '';
    const prosodyClose = prosodyAttrs.length > 0 ? '</prosody>' : '';
    const inner = `${prosodyOpen}${text}${prosodyClose}`;
    return `<speak>${voiceTag}${inner}${voiceClose}</speak>`;
}

function createTTSSpeakExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const text = params.text;
        const voice = params.voice || 'default';
        const rawSpeed = params.speed || 1.0;
        const speed = Math.min(2.0, Math.max(0.5, rawSpeed));
        const rawPitch = params.pitch || 1.0;
        const pitch = Math.min(2.0, Math.max(0.5, rawPitch));
        const volume = Math.min(1.0, Math.max(0.0, Number(params.volume) || 1.0));
        const audioFormat = params.format || 'mp3';
        const isSSML = params.ssml === true;
        try {
            if (!text || text.trim().length === 0) {
                return fail('文本内容不能为空', Date.now() - startTime);
            }
            let processedText = text;
            if (!isSSML) {
                processedText = preprocessText(text);
            }
            const ssmlContent = isSSML ? processedText : wrapSSML(processedText, voice, speed, pitch, volume);
            if (deps.speechSynthesizer) {
                try {
                    const result = await deps.speechSynthesizer.speak(processedText, {
                        voice,
                        speed,
                        pitch,
                        volume,
                        format: audioFormat,
                        ssml: ssmlContent,
                    });
                    if (result.success) {
                        Logger_1.Logger.info(`🔊 tts_speak 成功: "${text.substring(0, 30)}..." voice=${voice} speed=${speed} format=${audioFormat}`, 'TTSSpeak');
                        return ok(`语音已生成并播放 (${result.duration || 0}ms, ${audioFormat})`, Date.now() - startTime, {
                            duration: result.duration,
                            voice,
                            speed,
                            volume,
                            format: audioFormat,
                            textLength: text.length,
                            synthesized: true,
                        });
                    }
                    return fail(result.error || '语音合成失败', Date.now() - startTime);
                }
                catch (synthErr) {
                    Logger_1.Logger.warn(`🔊 tts_speak SpeechSynthesizer 调用失败: ${synthErr.message}，降级到模拟模式`, 'TTSSpeak');
                    return ok(`[模拟模式] 语音指令已接收: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`, Date.now() - startTime, { voice, speed, pitch, volume, format: audioFormat, textLength: text.length, simulated: true });
                }
            }
            Logger_1.Logger.info(`🔊 tts_speak (模拟): "${text.substring(0, 30)}..." voice=${voice} speed=${speed} pitch=${pitch} volume=${volume} format=${audioFormat}`, 'TTSSpeak');
            return ok(`[模拟模式] 语音指令已接收: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`, Date.now() - startTime, { voice, speed, pitch, volume, format: audioFormat, textLength: text.length, simulated: true });
        }
        catch (error) {
            Logger_1.Logger.error('❌ tts_speak 失败', error, 'TTSSpeak');
            return fail(`语音合成失败: ${error.message}`, Date.now() - startTime);
        }
    };
}
