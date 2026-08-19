import React, { useCallback, useEffect, useRef, useState } from 'react';
import './TypewriterText.css';

interface TypewriterTextProps {
  text: string;
  speed?: number;
  onComplete?: () => void;
  onCharacterTyped?: () => void;
  messageId: string;
  onSkip?: (messageId: string) => void;
  enableMarkdown?: boolean;
  enableSound?: boolean;
  pauseOnHover?: boolean;
}

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;

let _audioCtx: AudioContext | null = null;

function playTick(freq: number = 800, duration: number = 0.03, volume: number = 0.04) {
  try {
    if (!_audioCtx) {
      _audioCtx = new AudioContext();
    }
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = volume;
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.start();
    osc.stop(_audioCtx.currentTime + duration);
  } catch {
    /* 静默失败：某些浏览器限制自动播放 */
  }
}

function isInsideMarkdown(text: string, index: number): boolean {
  const beforeText = text.slice(0, index);
  const codeBlockMatches = beforeText.match(CODE_BLOCK_REGEX);
  if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) return true;
  const inlineCodeMatches = beforeText.match(INLINE_CODE_REGEX);
  if (inlineCodeMatches && inlineCodeMatches.length % 2 !== 0) return true;
  return false;
}

function getSmartDelay(char: string, prevChar: string, nextChar: string, baseSpeed: number): number {
  if (char === '\n') return baseSpeed * 3;
  if (char === '。' || char === '！' || char === '？' || char === '.' || char === '!' || char === '?') {
    return baseSpeed * 2.5;
  }
  if (char === '，' || char === '、' || char === '；' || char === ',' || char === ';' || char === ':') {
    return baseSpeed * 1.5;
  }
  if (char === '—' || char === '…') return baseSpeed * 1.8;
  if (prevChar === '\n') return baseSpeed * 1.2;
  return baseSpeed;
}

const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  speed = 45,
  onComplete,
  onCharacterTyped,
  messageId,
  onSkip,
  enableMarkdown = true,
  enableSound = false,
  pauseOnHover = false,
}) => {
  const [displayedText, setDisplayedText] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const indexRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRef = useRef(false);

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const completeTyping = useCallback(() => {
    clearTimeoutRef();
    setDisplayedText(text);
    setIsComplete(true);
    setProgress(100);
    onComplete?.();
  }, [text, clearTimeoutRef, onComplete]);

  const handleSkip = useCallback(() => {
    if (!isComplete) {
      completeTyping();
      onSkip?.(messageId);
    }
  }, [isComplete, completeTyping, onSkip, messageId]);

  useEffect(() => {
    if (!text) {
      setIsComplete(true);
      setProgress(100);
      onComplete?.();
      return;
    }

    indexRef.current = 0;
    setDisplayedText('');
    setIsComplete(false);
    setProgress(0);

    const typeNextChar = () => {
      if (hoverRef.current && pauseOnHover) {
        setIsPaused(true);
        timeoutRef.current = setTimeout(typeNextChar, 100);
        return;
      }

      const currentIndex = indexRef.current;
      if (currentIndex >= text.length) {
        completeTyping();
        return;
      }

      setIsPaused(false);

      const currentChar = text[currentIndex];
      const prevChar = currentIndex > 0 ? text[currentIndex - 1] : '';
      const nextChar = currentIndex < text.length - 1 ? text[currentIndex + 1] : '';
      const isChinese = /[\u4e00-\u9fa5]/.test(currentChar);
      const inMarkdown = enableMarkdown && isInsideMarkdown(text, currentIndex);

      let nextIndex: number;
      if (inMarkdown) {
        let end = currentIndex + 1;
        while (end < text.length && isInsideMarkdown(text, end)) {
          end++;
        }
        nextIndex = Math.min(end, currentIndex + 20);
      } else if (isChinese) {
        nextIndex = currentIndex + 1;
      } else if (/[a-zA-Z]/.test(currentChar)) {
        let wordEnd = currentIndex + 1;
        while (wordEnd < text.length && /[a-zA-Z]/.test(text[wordEnd])) {
          wordEnd++;
        }
        nextIndex = wordEnd;
      } else if (currentChar === ' ') {
        nextIndex = currentIndex + 1;
      } else {
        nextIndex = currentIndex + 1;
      }

      const nextText = text.slice(0, nextIndex);
      setDisplayedText(nextText);
      setProgress(Math.round((nextIndex / text.length) * 100));
      indexRef.current = nextIndex;
      onCharacterTyped?.();

      if (enableSound) {
        const tickFreq = isChinese ? 660 : 880;
        const tickVol = inMarkdown ? 0.02 : 0.04;
        playTick(tickFreq, 0.025, tickVol);
      }

      const delay = getSmartDelay(currentChar, prevChar, nextChar, speed);
      timeoutRef.current = setTimeout(typeNextChar, delay);
    };

    const delay = speed;
    timeoutRef.current = setTimeout(typeNextChar, delay);

    return () => {
      clearTimeoutRef();
    };
  }, [text, speed, completeTyping, onCharacterTyped, clearTimeoutRef, onComplete, enableMarkdown, pauseOnHover]);

  useEffect(() => {
    const handleNewMessage = () => {
      if (!isComplete) {
        handleSkip();
      }
    };

    window.addEventListener('jiabaixing:new-message', handleNewMessage);
    return () => {
      window.removeEventListener('jiabaixing:new-message', handleNewMessage);
    };
  }, [isComplete, handleSkip, onComplete]);

  const handleMouseEnter = useCallback(() => {
    hoverRef.current = true;
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoverRef.current = false;
    setIsPaused(false);
  }, []);

  return (
    <span
      className={`typewriter-text ${isComplete ? 'complete' : 'typing'} ${isPaused ? 'paused' : ''}`}
      onClick={handleSkip}
      onMouseEnter={pauseOnHover ? handleMouseEnter : undefined}
      onMouseLeave={pauseOnHover ? handleMouseLeave : undefined}
      title={isComplete ? '' : '点击显示全部'}
    >
      {displayedText}
      {!isComplete && <span className="typewriter-cursor">|</span>}
      {!isComplete && (
        <span className="typewriter-progress" aria-label={`打字进度 ${progress}%`}>
          <span className="typewriter-progress-bar" style={{ width: `${progress}%` }} />
        </span>
      )}
    </span>
  );
};

export default TypewriterText;
