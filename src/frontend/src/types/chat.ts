/**
 * 聊天消息类型定义
 * WebSocket 事件类型引用共享契约层
 */

import { ConnectionStatus as ContractConnectionStatus, WsServerEventType, WS_EVENTS } from '@shared/contracts';

export type MessageStatus = 'idle' | 'sending' | 'thinking' | 'typing' | 'sent' | 'error' | 'retrying' | 'progress';

export type MessageSender = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  content: string;
  sender: MessageSender;
  timestamp: Date;
  status: MessageStatus;
  emoji?: string;
  images?: string[];
  retryPayload?: { text: string; images?: string[] };
  errorReason?: string;
  isRead?: boolean;
}

export interface MessageBubbleProps {
  message: Message;
  onRetry?: (message: Message) => void;
  onSkipTyping?: (messageId: string) => void;
}

export interface TypewriterTextProps {
  text: string;
  speed?: number;
  onComplete?: () => void;
  onCharacterTyped?: () => void;
  messageId: string;
  onSkip?: (messageId: string) => void;
}

export type ConnectionStatus = ContractConnectionStatus;

export interface WebSocketMessage {
  type: WsServerEventType;
  data?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  traceId?: string;
  timestamp?: number;
}

export type { WS_EVENTS, WsServerEventType };
