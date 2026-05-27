import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { Message, MessageStatus } from '../../types/chat';
import { TypewriterText } from '../TypewriterText';
import './ChatInterface.css';

interface ChatWindowProps {
  messages: Message[];
  isLoading: boolean;
  isTyping: boolean;
  onRetry?: (message: Message) => void;
  onSkipTyping?: (messageId: string) => void;
  onQuickPrompt?: (text: string) => void;
}

const formatRelativeTime = (date: Date): string => {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
};

const getStatusLabel = (status: MessageStatus): string => {
  switch (status) {
    case 'sending':
      return '发送中';
    case 'thinking':
      return '思考中';
    case 'typing':
      return '输入中';
    case 'error':
      return '发送失败';
    case 'retrying':
      return '重试中';
    default:
      return '';
  }
};

const estimateMessageHeight = (message: Message): number => {
  const contentLength = message.content?.length || 0;
  const baseHeight = 80;
  const lines = Math.ceil(contentLength / 50);
  return Math.max(baseHeight, baseHeight + lines * 20);
};

const WELCOME_PROMPTS = [
  {
    icon: '👋',
    label: '打个招呼',
    desc: '开始今日对话',
    text: '你好，今天有什么可以帮你的？',
  },
  {
    icon: '📋',
    label: '整理日程',
    desc: '查看与安排任务',
    text: '帮我看看今天的日程安排',
  },
  {
    icon: '🔍',
    label: '搜索文件',
    desc: '本地代码与文档',
    text: '搜索项目中的配置文件',
  },
  {
    icon: '💡',
    label: '给我建议',
    desc: '基于上下文的建议',
    text: '根据我们之前的对话，给我一些工作建议',
  },
];

const ChatWindow: React.FC<ChatWindowProps> = ({
  messages,
  isLoading,
  isTyping,
  onRetry,
  onSkipTyping,
  onQuickPrompt,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = React.useState(600);

  const { metrics, startRender, endRender } = usePerformanceMonitor({
    enabled: process.env.NODE_ENV === 'development',
    logThreshold: 50,
  });

  const averageHeight = useMemo(() => {
    if (messages.length === 0) return 100;
    const total = messages.reduce((sum, m) => sum + estimateMessageHeight(m), 0);
    return Math.round(total / messages.length);
  }, [messages]);

  const {
    virtualItems,
    totalHeight,
    scrollToIndex,
    containerRef: virtualContainerRef,
  } = useVirtualScroll<Message>(messages, {
    itemHeight: averageHeight,
    overscan: 3,
    containerHeight,
  });

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        setContainerHeight(containerRef.current.clientHeight);
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (messages.length > 0) {
      scrollToIndex(messages.length - 1);
    }
  }, [messages.length, scrollToIndex]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, isLoading, isTyping, scrollToBottom]);

  useEffect(() => {
    startRender();
    return () => endRender();
  }, [messages, startRender, endRender]);

  const handleTypingComplete = useCallback(
    (messageId: string) => {
      if (onSkipTyping) {
        onSkipTyping(messageId);
      }
    },
    [onSkipTyping]
  );

  const renderMessageContent = (message: Message) => {
    const { status, sender, content, images } = message;

    if (status === 'sending' || status === 'retrying') {
      return (
        <div className="message-status-wrapper">
          <div className="message-status-indicator sending">
            <span className="status-spinner" />
            <span className="status-text">{getStatusLabel(status)}...</span>
          </div>
          {message.retryPayload?.text && <p className="message-text pending-text">{message.retryPayload.text}</p>}
        </div>
      );
    }

    if (status === 'error') {
      return (
        <div className="message-status-wrapper">
          <div className="message-error-content">
            <span className="error-icon">⚠️</span>
            <span className="error-text">{message.errorReason || '发送失败'}</span>
          </div>
          {onRetry && message.retryPayload && (
            <button className="retry-button" onClick={() => onRetry(message)} aria-label="重试发送">
              🔄 重试
            </button>
          )}
        </div>
      );
    }

    return (
      <>
        {images && images.length > 0 && (
          <div className="message-images">
            {images.map((img, idx) => (
              <img key={idx} src={img} alt={`图片 ${idx + 1}`} className="message-image" loading="lazy" />
            ))}
          </div>
        )}

        {sender === 'assistant' && status === 'typing' ? (
          <TypewriterText
            text={content}
            speed={40}
            messageId={message.id}
            onComplete={() => handleTypingComplete(message.id)}
            onSkip={onSkipTyping}
          />
        ) : (
          <p className="message-text">{content}</p>
        )}
      </>
    );
  };

  const enableVirtualScroll = messages.length > 30;

  return (
    <div className="chat-messages" ref={containerRef}>
      {messages.length === 0 && !isLoading && (
        <div className="chat-welcome">
          <div className="chat-welcome-avatar" aria-hidden="true">
            💼
          </div>
          <h3>你好，我是你的御姐秘书</h3>
          <p className="chat-welcome-tagline">
            成熟、专业、有记忆。可以聊天、执行任务、管理日程，也可以直接说出你的需求。
          </p>
          {onQuickPrompt && (
            <div className="welcome-widgets">
              {WELCOME_PROMPTS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="welcome-widget"
                  onClick={() => onQuickPrompt(item.text)}
                >
                  <span className="welcome-widget-icon">{item.icon}</span>
                  <span className="welcome-widget-label">{item.label}</span>
                  <span className="welcome-widget-desc">{item.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        ref={virtualContainerRef}
        style={{
          height: containerHeight,
          overflow: 'auto',
          position: 'relative',
        }}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          {enableVirtualScroll
            ? virtualItems.map(({ item: message, style }) => {
                const isUser = message.sender === 'user';
                const isAssistant = message.sender === 'assistant';
                const isSystem = message.sender === 'system';
                const hasError = message.status === 'error';

                return (
                  <div
                    key={message.id}
                    style={style}
                    className={`message-row ${isUser ? 'user-row' : isAssistant ? 'assistant-row' : 'system-row'}`}
                  >
                    <div
                      className={`message-bubble ${message.sender} ${message.status || 'sent'} ${hasError ? 'error' : ''}`}
                    >
                      <div className="message-avatar">{isAssistant ? '🤖' : isSystem ? '⚙️' : '👤'}</div>
                      <div className="message-content-wrapper">
                        {message.emoji && <span className="message-emoji">{message.emoji}</span>}
                        <div className="message-body">{renderMessageContent(message)}</div>
                        <div className="message-meta">
                          <span className="message-time" title={message.timestamp.toLocaleString()}>
                            {formatRelativeTime(message.timestamp)}
                          </span>
                          {isUser && message.status === 'sent' && <span className="read-status">已读</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            : messages.map((message) => {
                const isUser = message.sender === 'user';
                const isAssistant = message.sender === 'assistant';
                const isSystem = message.sender === 'system';
                const hasError = message.status === 'error';

                return (
                  <div
                    key={message.id}
                    className={`message-row ${isUser ? 'user-row' : isAssistant ? 'assistant-row' : 'system-row'}`}
                  >
                    <div
                      className={`message-bubble ${message.sender} ${message.status || 'sent'} ${hasError ? 'error' : ''}`}
                    >
                      <div className="message-avatar">{isAssistant ? '🤖' : isSystem ? '⚙️' : '👤'}</div>
                      <div className="message-content-wrapper">
                        {message.emoji && <span className="message-emoji">{message.emoji}</span>}
                        <div className="message-body">{renderMessageContent(message)}</div>
                        <div className="message-meta">
                          <span className="message-time" title={message.timestamp.toLocaleString()}>
                            {formatRelativeTime(message.timestamp)}
                          </span>
                          {isUser && message.status === 'sent' && <span className="read-status">已读</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
        </div>
      </div>

      {isLoading && !isTyping && (
        <div className="message-row assistant-row">
          <div className="message-bubble assistant thinking">
            <div className="message-avatar">🤖</div>
            <div className="message-content-wrapper">
              <div className="thinking-indicator">
                <div className="thinking-pulse">
                  <span className="pulse-dot" />
                  <span className="pulse-dot" />
                  <span className="pulse-dot" />
                </div>
                <span className="thinking-text">正在思考...</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatWindow;
