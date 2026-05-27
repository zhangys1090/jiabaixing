import React, { useEffect, useState, useCallback, useRef } from 'react';
import './TypewriterText.css';

interface TypewriterTextProps {
  text: string;
  speed?: number;
  onComplete?: () => void;
  onCharacterTyped?: () => void;
  messageId: string;
  onSkip?: (messageId: string) => void;
}

/**
 * 打字机效果组件
 * 支持中文逐字显示、英文按词显示
 * 点击可加速/跳过
 */
const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  speed = 45,
  onComplete,
  onCharacterTyped,
  messageId,
  onSkip,
}) => {
  const [displayedText, setDisplayedText] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const indexRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTypingInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const completeTyping = useCallback(() => {
    clearTypingInterval();
    setDisplayedText(text);
    setIsComplete(true);
    onComplete?.();
  }, [text, clearTypingInterval, onComplete]);

  const handleSkip = useCallback(() => {
    if (!isComplete) {
      completeTyping();
      onSkip?.(messageId);
    }
  }, [isComplete, completeTyping, onSkip, messageId]);

  useEffect(() => {
    if (!text) {
      setIsComplete(true);
      onComplete?.();
      return;
    }

    indexRef.current = 0;
    setDisplayedText('');
    setIsComplete(false);

    const typeNextChar = () => {
      const currentIndex = indexRef.current;
      if (currentIndex >= text.length) {
        completeTyping();
        return;
      }

      // 判断当前字符类型
      const currentChar = text[currentIndex];
      const isChinese = /[\u4e00-\u9fa5]/.test(currentChar);

      let nextIndex: number;
      if (isChinese) {
        // 中文逐字显示
        nextIndex = currentIndex + 1;
      } else if (/[a-zA-Z]/.test(currentChar)) {
        // 英文按词显示（显示到下一个非字母字符）
        let wordEnd = currentIndex + 1;
        while (wordEnd < text.length && /[a-zA-Z]/.test(text[wordEnd])) {
          wordEnd++;
        }
        nextIndex = wordEnd;
      } else if (currentChar === ' ') {
        // 空格直接跳过，显示下一个非空格字符
        nextIndex = currentIndex + 1;
      } else {
        // 其他字符（标点、数字等）逐个显示
        nextIndex = currentIndex + 1;
      }

      const nextText = text.slice(0, nextIndex);
      setDisplayedText(nextText);
      indexRef.current = nextIndex;
      onCharacterTyped?.();
    };

    intervalRef.current = setInterval(typeNextChar, speed);

    return () => {
      clearTypingInterval();
    };
  }, [text, speed, completeTyping, onCharacterTyped, clearTypingInterval]);

  // 用户发送新消息时自动完成当前打字
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
  }, [isComplete, handleSkip]);

  return (
    <span
      className={`typewriter-text ${isComplete ? 'complete' : 'typing'}`}
      onClick={handleSkip}
      title={isComplete ? '' : '点击显示全部'}
    >
      {displayedText}
      {!isComplete && <span className="typewriter-cursor">|</span>}
    </span>
  );
};

export default TypewriterText;
