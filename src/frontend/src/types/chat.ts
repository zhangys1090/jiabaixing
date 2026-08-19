/**
 * 聊天消息类型定义
 * WebSocket 事件类型引用共享契约层
 */

import { ConnectionStatus as ContractConnectionStatus, WS_EVENTS, WsServerEventType } from '@shared/contracts';

export type MessageStatus =
  | 'idle'
  | 'sending'
  | 'thinking'
  | 'typing'
  | 'streaming'
  | 'sent'
  | 'error'
  | 'retrying'
  | 'progress';

export type MessageSender = 'user' | 'assistant' | 'system';

export interface ToolCallEvent {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  success?: boolean;
  resultSummary?: string;
  error?: string;
  durationMs?: number;
  timestamp: number;
}

export interface Message {
  id: string;
  content: string;
  sender: MessageSender;
  timestamp: Date;
  status: MessageStatus;
  emoji?: string;
  images?: string[];
  retryPayload?: { text: string; images?: string[]; files?: unknown[] };
  errorReason?: string;
  isRead?: boolean;
  toolEvents?: ToolCallEvent[];
  thinkingText?: string;
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

export type ModuleId =
  | 'chat'
  | 'memory'
  | 'agent'
  | 'evolution'
  | 'skills'
  | 'desktop'
  | 'automation'
  | 'security'
  | 'monitor';

export interface WebSocketMessage {
  type: WsServerEventType;
  data?: unknown;
  payload?: unknown;
  traceId?: string;
  timestamp?: number;
}

export type { WS_EVENTS, WsServerEventType };
