"use strict";
/**
 * SpeechSynthesizer —— 语音合成(TTS)后端切换
 *
 * P1-3 目标之一：TTS 非-mock 后端切换。
 *   - backend='mock'（默认）：仅记录合成意图，不实际播放/生成音频。
 *   - backend='real'：调用注入的真实合成器（如 Python TTS 服务 / 平台 TTS API）；
 *     未注入 realSpeak 时显式报错（fail-closed），不再静默降级为 mock。
 *
 * 后端选择优先级：调用方显式 ttsBackend 参数 > 注入 deps 的真实合成器 > 环境变量 TTS_BACKEND > mock。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpeechSynthesizer = void 0;
const Logger_1 = require("../utils/Logger");
class SpeechSynthesizer {
    constructor(backend, realSpeak) {
        this.realSpeak = realSpeak;
        this.backend =
            backend ?? (process.env.TTS_BACKEND || 'mock');
    }
    setBackend(backend) {
        this.backend = backend;
    }
    getBackend() {
        return this.backend;
    }
    async speak(text, emotion) {
        if (this.backend === 'real') {
            if (!this.realSpeak) {
                Logger_1.Logger.warn('TTS 真实后端未配置 realSpeak，无法合成', 'SpeechSynthesizer');
                return {
                    success: false,
                    error: '未配置真实 TTS 后端（realSpeak）',
                    backend: 'real',
                };
            }
            try {
                const r = await this.realSpeak(text, emotion);
                return { ...r, backend: 'real' };
            }
            catch (e) {
                Logger_1.Logger.error('TTS 真实后端合成失败', e, 'SpeechSynthesizer');
                return { success: false, error: e.message, backend: 'real' };
            }
        }
        // mock 后端：仅记录意图，不实际生成/播放音频
        Logger_1.Logger.info(`SpeechSynthesizer (mock) 合成: "${text.substring(0, 30)}..."`, 'SpeechSynthesizer');
        return { success: true, duration: 0, backend: 'mock' };
    }
}
exports.SpeechSynthesizer = SpeechSynthesizer;
