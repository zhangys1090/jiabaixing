import React, { useCallback, useEffect, useRef, useState } from 'react';
import './VoiceInteraction.css';

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResult[];
  error?: string;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface VoiceInteractionProps {
  onVoiceInput: (text: string) => void;
  isProcessing: boolean;
  dialogState?: 'idle' | 'listening' | 'processing' | 'speaking';
}

const VoiceInteraction: React.FC<VoiceInteractionProps> = ({ onVoiceInput, isProcessing, dialogState = 'idle' }) => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(true);
  const [volumeLevel, setVolumeLevel] = useState(0);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const isListeningRef = useRef(false);
  const animationFrameRef = useRef<number>(0);

  useEffect(() => {
    const windowWithSpeech = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };

    const SpeechRecognition = windowWithSpeech.SpeechRecognition || windowWithSpeech.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      if (finalText) {
        setTranscript((prev) => prev + finalText);
      }
      setInterimTranscript(interimText);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'not-allowed') {
        setIsSupported(false);
        setIsListening(false);
        isListeningRef.current = false;
      }
      if (event.error !== 'aborted') {
        setIsListening(false);
        isListeningRef.current = false;
      }
    };

    recognition.onend = () => {
      if (isListeningRef.current) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
          isListeningRef.current = false;
        }
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const simulateVolume = useCallback(() => {
    if (!isListeningRef.current) {
      setVolumeLevel(0);
      return;
    }

    const level = Math.random() * 0.8 + 0.2;
    setVolumeLevel(level);
    animationFrameRef.current = requestAnimationFrame(() => {
      setTimeout(() => simulateVolume(), 100);
    });
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current || isProcessing) return;

    setTranscript('');
    setInterimTranscript('');
    setIsListening(true);
    isListeningRef.current = true;

    try {
      recognitionRef.current.start();
      simulateVolume();
    } catch {
      setIsListening(false);
      isListeningRef.current = false;
    }
  }, [isProcessing, simulateVolume]);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;

    setIsListening(false);
    isListeningRef.current = false;
    setVolumeLevel(0);

    try {
      recognitionRef.current.stop();
    } catch {
      // noop
    }

    const fullText = (transcript + interimTranscript).trim();
    if (fullText) {
      onVoiceInput(fullText);
    }
    setTranscript('');
    setInterimTranscript('');
  }, [transcript, interimTranscript, onVoiceInput]);

  const getButtonClass = () => {
    if (isProcessing) return 'voice-button processing';
    if (isListening) return 'voice-button listening';
    if (dialogState === 'speaking') return 'voice-button speaking';
    return 'voice-button';
  };

  const getButtonIcon = () => {
    if (isProcessing) return '⏳';
    if (isListening) return '⏹️';
    if (dialogState === 'speaking') return '🔊';
    return '🎤';
  };

  const getButtonLabel = () => {
    if (isProcessing) return '处理中...';
    if (isListening) return '点击停止';
    if (dialogState === 'speaking') return '播报中...';
    return '语音输入';
  };

  if (!isSupported) {
    return null;
  }

  return (
    <div className="voice-interaction">
      <div className="voice-controls">
        <button
          className={getButtonClass()}
          onClick={isListening ? stopListening : startListening}
          disabled={isProcessing && !isListening}
          aria-label={getButtonLabel()}
          title={getButtonLabel()}
        >
          <span className="voice-icon">{getButtonIcon()}</span>
        </button>

        {isListening && (
          <div className="voice-wave-container">
            <div className="voice-wave">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="voice-wave-bar"
                  style={{
                    height: `${20 + volumeLevel * 30 * Math.sin(i + Date.now() / 200)}px`,
                  }}
                />
              ))}
            </div>
            <div className="voice-transcript">
              {transcript}
              <span className="voice-interim">{interimTranscript}</span>
            </div>
          </div>
        )}

        {dialogState === 'speaking' && (
          <div className="speaking-indicator">
            <span className="speaking-dot" />
            <span className="speaking-dot" />
            <span className="speaking-dot" />
            <span className="speaking-text">正在播报...</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default VoiceInteraction;
