import { create } from 'zustand';
import { apiService } from '../api/apiService';
import { createLogger } from '../utils/logger';

const log = createLogger('VoiceStore');

export type VoiceDialogState = 'idle' | 'listening' | 'processing' | 'speaking';

export interface VoiceSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  utterances: VoiceUtterance[];
  status: 'active' | 'ended';
}

export interface VoiceUtterance {
  id: string;
  text: string;
  direction: 'user' | 'assistant';
  timestamp: string;
}

export interface VoiceSettings {
  language: string;
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  autoSpeak: boolean;
  continuousMode: boolean;
  vadEnabled: boolean;
  vadThreshold: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  language: 'zh-CN',
  ttsVoice: '',
  ttsRate: 1.0,
  ttsPitch: 1.0,
  autoSpeak: false,
  continuousMode: false,
  vadEnabled: true,
  vadThreshold: 0.5,
};

export interface VoiceState {
  dialogState: VoiceDialogState;
  isSupported: boolean;
  currentSession: VoiceSession | null;
  settings: VoiceSettings;
  interimTranscript: string;
  error: string | null;
  volumeLevel: number;

  setDialogState: (state: VoiceDialogState) => void;
  setIsSupported: (supported: boolean) => void;
  startSession: () => void;
  endSession: () => void;
  addUtterance: (direction: 'user' | 'assistant', text: string) => void;
  updateSettings: (updates: Partial<VoiceSettings>) => void;
  setInterimTranscript: (text: string) => void;
  setError: (error: string | null) => void;
  setVolumeLevel: (level: number) => void;
  speak: (text: string) => Promise<void>;
  sendVoiceToBackend: (text: string) => Promise<string | null>;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  dialogState: 'idle',
  isSupported: true,
  currentSession: null,
  settings: DEFAULT_VOICE_SETTINGS,
  interimTranscript: '',
  error: null,
  volumeLevel: 0,

  setDialogState: (dialogState) => set({ dialogState }),

  setIsSupported: (isSupported) => set({ isSupported }),

  startSession: () => {
    const session: VoiceSession = {
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
    } else {
      set({ dialogState: 'idle', interimTranscript: '', volumeLevel: 0 });
    }
  },

  addUtterance: (direction, text) => {
    const { currentSession } = get();
    if (!currentSession) return;
    const utterance: VoiceUtterance = {
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
          if (match) utterance.voice = match;
        }

        utterance.onend = () => {
          const { currentSession } = get();
          if (currentSession?.status === 'active') {
            set({ dialogState: 'listening' });
          } else {
            set({ dialogState: 'idle' });
          }
        };

        utterance.onerror = () => {
          set({ dialogState: 'idle' });
        };

        speechSynthesis.speak(utterance);
      } else {
        const result = await apiService.speakTts(text, settings.ttsVoice, settings.ttsRate);
        if (!result.success) {
          log.error('TTS 后端调用失败:', result.error);
        }
        set({ dialogState: 'idle' });
      }

      get().addUtterance('assistant', text);
    } catch (err) {
      log.error('speak 失败:', err);
      set({ dialogState: 'idle', error: err instanceof Error ? err.message : '语音合成失败' });
    }
  },

  sendVoiceToBackend: async (text) => {
    set({ dialogState: 'processing' });
    try {
      const result = await apiService.executeTool({
        toolName: 'voice_interact',
        params: { action: 'listen', text },
      });

      if (result.success && result.data?.output) {
        const output = result.data.output;
        const responseText =
          typeof output === 'string' ? output : ((output as Record<string, unknown>)?.text as string) || text;
        get().addUtterance('user', text);
        return responseText;
      }

      get().addUtterance('user', text);
      return text;
    } catch (err) {
      log.error('sendVoiceToBackend 失败:', err);
      set({ error: err instanceof Error ? err.message : '语音后端通信失败' });
      return null;
    } finally {
      const { currentSession } = get();
      if (currentSession?.status === 'active') {
        set({ dialogState: 'listening' });
      }
    }
  },
}));
