"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTS_SPEAK_DEF = void 0;
exports.createTTSSpeakExecutor = createTTSSpeakExecutor;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.TTS_SPEAK_DEF = {
    name: 'tts_speak',
    description: '文本转语音工具。将文字转为语音输出。适用场景：语音播报、配音、语音助手回复。支持调节语速和音色。',
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
function createTTSSpeakExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const text = params.text;
        const voice = params.voice || 'default';
        const rawSpeed = params.speed || 1.0;
        const speed = Math.min(2.0, Math.max(0.5, rawSpeed));
        const rawPitch = params.pitch || 1.0;
        const _pitch = Math.min(2.0, Math.max(0.5, rawPitch));
        try {
            if (!text || text.trim().length === 0) {
                return fail('文本内容不能为空', Date.now() - startTime);
            }
            if (deps.speechSynthesizer) {
                try {
                    const result = await deps.speechSynthesizer.speak(text);
                    if (result.success) {
                        Logger_1.Logger.info(`🔊 tts_speak 成功: "${text.substring(0, 30)}..." voice=${voice} speed=${speed}`, 'TTSSpeak');
                        return ok(`语音已生成并播放 (${result.duration || 0}ms)`, Date.now() - startTime, {
                            duration: result.duration,
                            voice,
                            speed,
                            textLength: text.length,
                            synthesized: true,
                        });
                    }
                    return fail(result.error || '语音合成失败', Date.now() - startTime);
                }
                catch (synthErr) {
                    // 合成器调用抛错 → 诚实失败，不再静默降级为"模拟成功"
                    Logger_1.Logger.error(`❌ tts_speak SpeechSynthesizer 调用失败: ${synthErr.message}`, synthErr, 'TTSSpeak');
                    return fail(`语音合成调用失败: ${synthErr.message}`, Date.now() - startTime);
                }
            }
            // 未配置真实合成器 → 诚实失败，不再返回 success:true 的"模拟模式"
            Logger_1.Logger.warn(`🔊 tts_speak 未配置 speechSynthesizer，无法真实合成语音: "${text.substring(0, 30)}..."`, 'TTSSpeak');
            return fail('未配置语音合成器(speechSynthesizer)，无法真正合成并播放语音', Date.now() - startTime);
        }
        catch (error) {
            Logger_1.Logger.error('❌ tts_speak 失败', error, 'TTSSpeak');
            return fail(`语音合成失败: ${error.message}`, Date.now() - startTime);
        }
    };
}
