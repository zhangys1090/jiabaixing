"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useVoiceStore = exports.DEFAULT_VOICE_SETTINGS = void 0;
const zustand_1 = require("zustand");
const apiService_1 = require("../api/apiService");
const logger_1 = require("../utils/logger");
const log = (0, logger_1.createLogger)('VoiceStore');
exports.DEFAULT_VOICE_SETTINGS = {
    language: 'zh-CN',
    ttsVoice: '',
    ttsRate: 1.0,
    ttsPitch: 1.0,
    autoSpeak: false,
    continuousMode: false,
    vadEnabled: true,
    vadThreshold: 0.5,
};
exports.useVoiceStore = (0, zustand_1.create)((set, get) => ({
    dialogState: 'idle',
    isSupported: true,
    currentSession: null,
    settings: exports.DEFAULT_VOICE_SETTINGS,
    interimTranscript: '',
    error: null,
    volumeLevel: 0,
    setDialogState: (dialogState) => set({ dialogState }),
    setIsSupported: (isSupported) => set({ isSupported }),
    startSession: () => {
        const session = {
            id: `voice-${Date.now()}`,
            startedAt: new Date().toISOString(),
            utterances: [],
            status: 'active',
        };
        set({ currentSession: session, dialogState: 'listening', error: null });
    },
    endSession: () => {
        const { currentSession } = get();
        if (currentSession) {
            set({
                currentSession: { ...currentSession, status: 'ended', endedAt: new Date().toISOString() },
                dialogState: 'idle',
                interimTranscript: '',
                volumeLevel: 0,
            });
        }
        else {
            set({ dialogState: 'idle', interimTranscript: '', volumeLevel: 0 });
        }
    },
    addUtterance: (direction, text) => {
        const { currentSession } = get();
        if (!currentSession)
            return;
        const utterance = {
            id: `utt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            text,
            direction,
            timestamp: new Date().toISOString(),
        };
        set({
            currentSession: {
                ...currentSession,
                utterances: [...currentSession.utterances, utterance],
            },
        });
    },
    updateSettings: (updates) => set((state) => ({ settings: { ...state.settings, ...updates } })),
    setInterimTranscript: (interimTranscript) => set({ interimTranscript }),
    setError: (error) => set({ error }),
    setVolumeLevel: (volumeLevel) => set({ volumeLevel }),
    speak: async (text) => {
        const { settings } = get();
        set({ dialogState: 'speaking' });
        try {
            if ('speechSynthesis' in window) {
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = settings.language;
                utterance.rate = settings.ttsRate;
                utterance.pitch = settings.ttsPitch;
                if (settings.ttsVoice) {
                    const voices = speechSynthesis.getVoices();
                    const match = voices.find((v) => v.name === settings.ttsVoice);
                    if (match)
                        utterance.voice = match;
                }
                utterance.onend = () => {
                    const { currentSession } = get();
                    if (currentSession?.status === 'active') {
                        set({ dialogState: 'listening' });
                    }
                    else {
                        set({ dialogState: 'idle' });
                    }
                };
                utterance.onerror = () => {
                    set({ dialogState: 'idle' });
                };
                speechSynthesis.speak(utterance);
            }
            else {
                const result = await apiService_1.apiService.speakTts(text, settings.ttsVoice, settings.ttsRate);
                if (!result.success) {
                    log.error('TTS 后端调用失败:', result.error);
                }
                set({ dialogState: 'idle' });
            }
            get().addUtterance('assistant', text);
        }
        catch (err) {
            log.error('speak 失败:', err);
            set({ dialogState: 'idle', error: err instanceof Error ? err.message : '语音合成失败' });
        }
    },
    sendVoiceToBackend: async (text) => {
        set({ dialogState: 'processing' });
        try {
            const result = await apiService_1.apiService.executeTool({
                toolName: 'voice_interact',
                params: { action: 'listen', text },
            });
            if (result.success && result.data?.output) {
                const output = result.data.output;
                const responseText = typeof output === 'string' ? output : output?.text || text;
                get().addUtterance('user', text);
                return responseText;
            }
            get().addUtterance('user', text);
            return text;
        }
        catch (err) {
            log.error('sendVoiceToBackend 失败:', err);
            set({ error: err instanceof Error ? err.message : '语音后端通信失败' });
            return null;
        }
        finally {
            const { currentSession } = get();
            if (currentSession?.status === 'active') {
                set({ dialogState: 'listening' });
            }
        }
    },
}));
