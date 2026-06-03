/**
 * ChatContext - 聊天状态管理
 * 提取 ChatInterface 中的共享状态，使用 Context + useReducer 模式
 * 消除 props drilling，支持复合组件架构
 */

import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import { Message } from '../types/chat';
import { apiService } from '../api/apiService';
import { connectionManager } from '../hooks/websocket';
import type { BrainStageUpdate, PerceptionUpdate, SkillExecutionUpdate, EvolutionEvent } from '../hooks/useWebSocket';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface ChatState {
  messages: Message[];
  inputText: string;
  isLoading: boolean;
  isTyping: boolean;
  isRunning: boolean;
  logPanelVisible: boolean;
  ttsEnabled: boolean;
  serverLogs: Array<{
    timestamp: string;
    level: string;
    message: string;
    module?: string;
  }>;
  agentSteps: Array<{
    name: string;
    label: string;
    status: 'pending' | 'in-progress' | 'completed' | 'failed';
  }>;
  brainStageUpdates: BrainStageUpdate[];
  perceptionUpdates: PerceptionUpdate[];
  skillExecutionUpdates: SkillExecutionUpdate[];
  evolutionEvents: EvolutionEvent[];
  currentTraceId: string | null;
}

type ChatAction =
  | { type: 'SET_MESSAGES'; payload: Message[] }
  | { type: 'ADD_MESSAGE'; payload: Message }
  | { type: 'UPDATE_MESSAGE'; id: string; updates: Partial<Message> }
  | { type: 'SET_INPUT_TEXT'; payload: string }
  | { type: 'SET_IS_LOADING'; payload: boolean }
  | { type: 'SET_IS_TYPING'; payload: boolean }
  | { type: 'SET_IS_RUNNING'; payload: boolean }
  | { type: 'TOGGLE_LOG_PANEL' }
  | { type: 'TOGGLE_TTS' }
  | { type: 'ADD_SERVER_LOG'; payload: ChatState['serverLogs'][0] }
  | {
      type: 'UPDATE_AGENT_STEP';
      name: string;
      status: ChatState['agentSteps'][0]['status'];
    }
  | { type: 'RESET_AGENT_STEPS' }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'PREPEND_MESSAGES'; payload: Message[] }
  | { type: 'ADD_BRAIN_STAGE_UPDATE'; payload: BrainStageUpdate }
  | { type: 'ADD_PERCEPTION_UPDATE'; payload: PerceptionUpdate }
  | { type: 'ADD_SKILL_EXECUTION_UPDATE'; payload: SkillExecutionUpdate }
  | { type: 'ADD_EVOLUTION_EVENT'; payload: EvolutionEvent }
  | { type: 'CLEAR_EXECUTION_UPDATES' }
  | { type: 'MARK_SENDING_AS_SENT' }
  | { type: 'CLEAR_PROGRESS_MESSAGES' }
  | { type: 'SET_CURRENT_TRACE_ID'; payload: string | null }
  | { type: 'APPEND_STREAM_CHUNK'; id: string; chunk: string }
  | { type: 'FINISH_STREAM'; id: string };

interface ChatContextValue {
  state: ChatState;
  dispatch: React.Dispatch<ChatAction>;
  generateMessageId: () => string;
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

const STORAGE_KEY = 'jiabaixing_chat_messages';
const MAX_MESSAGES = 100;

const INITIAL_AGENT_STEPS: ChatState['agentSteps'] = [
  { name: 'perceive', label: '感知阶段', status: 'pending' },
  { name: 'plan', label: '规划阶段', status: 'pending' },
  { name: 'execute', label: '执行阶段', status: 'pending' },
  { name: 'verify', label: '校验阶段', status: 'pending' },
  { name: 'output', label: '输出阶段', status: 'pending' },
  { name: 'learn', label: '学习阶段', status: 'pending' },
];

// ═══════════════════════════════════════════════════════════════
// Reducer
// ═══════════════════════════════════════════════════════════════

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_MESSAGES':
      return { ...state, messages: action.payload };
    case 'ADD_MESSAGE':
      return {
        ...state,
        messages: [...state.messages, action.payload].slice(-MAX_MESSAGES),
      };
    case 'UPDATE_MESSAGE':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === action.id ? { ...m, ...action.updates } : m)),
      };
    case 'SET_INPUT_TEXT':
      return { ...state, inputText: action.payload };
    case 'SET_IS_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_IS_TYPING':
      return { ...state, isTyping: action.payload };
    case 'SET_IS_RUNNING':
      return { ...state, isRunning: action.payload };
    case 'TOGGLE_LOG_PANEL':
      return { ...state, logPanelVisible: !state.logPanelVisible };
    case 'TOGGLE_TTS':
      return { ...state, ttsEnabled: !state.ttsEnabled };
    case 'ADD_SERVER_LOG':
      return {
        ...state,
        serverLogs: [...state.serverLogs, action.payload].slice(-200),
      };
    case 'UPDATE_AGENT_STEP':
      return {
        ...state,
        agentSteps: state.agentSteps.map((s) => (s.name === action.name ? { ...s, status: action.status } : s)),
      };
    case 'RESET_AGENT_STEPS':
      return {
        ...state,
        agentSteps: INITIAL_AGENT_STEPS.map((s) => ({ ...s })),
      };
    case 'CLEAR_MESSAGES':
      return {
        ...state,
        messages: [
          {
            id: 'msg_init_welcome',
            content: '我在。有什么可以帮你的？',
            sender: 'assistant',
            timestamp: new Date(),
            status: 'sent',
            emoji: '👋',
          },
        ],
      };
    case 'PREPEND_MESSAGES':
      const existingIds = new Set(state.messages.map((m) => m.id));
      const newMessages = action.payload.filter((m) => !existingIds.has(m.id));
      return {
        ...state,
        messages: [...newMessages, ...state.messages].slice(-MAX_MESSAGES),
      };
    case 'ADD_BRAIN_STAGE_UPDATE':
      return {
        ...state,
        brainStageUpdates: [...state.brainStageUpdates, action.payload].slice(-50),
      };
    case 'ADD_PERCEPTION_UPDATE':
      return {
        ...state,
        perceptionUpdates: [...state.perceptionUpdates, action.payload].slice(-50),
      };
    case 'ADD_SKILL_EXECUTION_UPDATE':
      return {
        ...state,
        skillExecutionUpdates: [...state.skillExecutionUpdates, action.payload].slice(-50),
      };
    case 'ADD_EVOLUTION_EVENT':
      return {
        ...state,
        evolutionEvents: [...state.evolutionEvents, action.payload].slice(-50),
      };
    case 'CLEAR_EXECUTION_UPDATES':
      return {
        ...state,
        brainStageUpdates: [],
        perceptionUpdates: [],
        skillExecutionUpdates: [],
      };
    case 'MARK_SENDING_AS_SENT':
      return {
        ...state,
        messages: state.messages.map((m) => (m.status === 'sending' ? { ...m, status: 'sent' as const } : m)),
      };
    case 'CLEAR_PROGRESS_MESSAGES':
      return {
        ...state,
        messages: state.messages.filter((m) => m.status !== 'progress'),
      };
    case 'SET_CURRENT_TRACE_ID':
      return {
        ...state,
        currentTraceId: action.payload,
      };
    case 'APPEND_STREAM_CHUNK':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, content: m.content + action.chunk } : m
        ),
      };
    case 'FINISH_STREAM':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, status: 'sent' as const } : m
        ),
        isTyping: false,
      };
    default:
      return state;
  }
}

// ═══════════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════════

const ChatContext = createContext<ChatContextValue | null>(null);

// ═══════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const messageCounterRef = useRef(0);
  const historyLoadedRef = useRef(false);

  const loadPersistedMessages = (): Message[] => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: Message[] = JSON.parse(stored);
        const cleaned = parsed.filter((m) => {
          if (m.status === 'error') return false;
          if (
            m.content &&
            typeof m.content === 'string' &&
            (m.content.includes('执行失败') || m.content.includes('参数验证失败'))
          )
            return false;
          return true;
        });
        return cleaned.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
      }
    } catch {
      // noop
    }
    return [];
  };

  const convertConversationToMessages = (
    conversations: Array<{
      id: string;
      timestamp: string;
      content: unknown;
      scene?: string;
      emotion?: string;
    }>
  ): Message[] => {
    const messages: Message[] = [];
    let msgIndex = 0;

    for (const conv of conversations) {
      try {
        const content = typeof conv.content === 'string' ? JSON.parse(conv.content) : conv.content;

        if (content.user_input) {
          messages.push({
            id: `history_user_${conv.id}_${msgIndex}`,
            content: content.user_input,
            sender: 'user',
            timestamp: new Date(conv.timestamp),
            status: 'sent',
          });
          msgIndex++;
        }

        if (content.response || content.ai_response) {
          const responseText = content.response || content.ai_response;
          messages.push({
            id: `history_ai_${conv.id}_${msgIndex}`,
            content: responseText,
            sender: 'assistant',
            timestamp: new Date(conv.timestamp),
            status: 'sent',
          });
          msgIndex++;
        }
      } catch {
        // noop
      }
    }

    return messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  };

  const persisted = loadPersistedMessages();
  const initialMessages: Message[] =
    persisted.length > 0
      ? persisted
      : [
          {
            id: 'msg_init_welcome',
            content: '我在。有什么可以帮你的？',
            sender: 'assistant',
            timestamp: new Date(),
            status: 'sent',
            emoji: '👋',
          },
        ];

  const [state, dispatch] = useReducer(chatReducer, {
    messages: initialMessages,
    inputText: '',
    isLoading: false,
    isTyping: false,
    isRunning: false,
    logPanelVisible: false,
    ttsEnabled: true,
    serverLogs: [],
    agentSteps: INITIAL_AGENT_STEPS.map((s) => ({ ...s })),
    brainStageUpdates: [],
    perceptionUpdates: [],
    skillExecutionUpdates: [],
    evolutionEvents: [],
    currentTraceId: null,
  });

  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;

    const loadHistoryFromBackend = async (): Promise<void> => {
      try {
        const response = await apiService.getConversations(50);
        if (response.success && response.data) {
          const conversations = response.data as Array<{
            id: string;
            timestamp: string;
            content: unknown;
            scene?: string;
            emotion?: string;
          }>;
          const historyMessages = convertConversationToMessages(conversations);
          if (historyMessages.length > 0) {
            dispatch({ type: 'PREPEND_MESSAGES', payload: historyMessages });
          }
        }
      } catch {
        // noop
      }
    };

    loadHistoryFromBackend();
  }, []);

  // 订阅 WebSocket 事件
  useEffect(() => {
    const streamMessageIdRef = useRef<string | null>(null);

    const handleResponseReady = (response: unknown, traceId?: string) => {
      const data = response as Record<string, unknown> | undefined;
      const responseText = typeof data?.response === 'string'
        ? data.response
        : typeof data?.text === 'string'
          ? data.text
          : typeof data?.message === 'string'
            ? data.message
            : '';

      if (responseText) {
        dispatch({
          type: 'ADD_MESSAGE',
          payload: {
            id: `msg_response_${Date.now().toString(36)}`,
            content: responseText,
            sender: 'assistant' as const,
            timestamp: new Date(),
            status: 'sent' as const,
          },
        });
        dispatch({ type: 'SET_IS_TYPING', payload: false });
        dispatch({ type: 'SET_IS_RUNNING', payload: false });
      }

      if (traceId) {
        dispatch({ type: 'SET_CURRENT_TRACE_ID', payload: null });
      }
    };

    const handleStreamStart = (data: { traceId?: string; totalLength?: number; timestamp?: number }) => {
      const msgId = `msg_stream_${Date.now().toString(36)}`;
      streamMessageIdRef.current = msgId;
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: msgId,
          content: '',
          sender: 'assistant' as const,
          timestamp: new Date(),
          status: 'typing' as const,
        },
      });
      dispatch({ type: 'SET_IS_TYPING', payload: true });
      if (data.traceId) {
        dispatch({ type: 'SET_CURRENT_TRACE_ID', payload: data.traceId });
      }
    };

    const handleStreamChunk = (data: { traceId?: string; chunk?: string; offset?: number; timestamp?: number }) => {
      const msgId = streamMessageIdRef.current;
      if (msgId && data.chunk) {
        dispatch({ type: 'APPEND_STREAM_CHUNK', id: msgId, chunk: data.chunk });
      }
    };

    const handleStreamDone = (data: { traceId?: string; fullText?: string; timestamp?: number }) => {
      const msgId = streamMessageIdRef.current;
      if (msgId) {
        dispatch({ type: 'FINISH_STREAM', id: msgId });
        streamMessageIdRef.current = null;
      }
      dispatch({ type: 'SET_IS_TYPING', payload: false });
      dispatch({ type: 'SET_IS_RUNNING', payload: false });
      if (data.traceId) {
        dispatch({ type: 'SET_CURRENT_TRACE_ID', payload: null });
      }
    };

    const handleProcessingStatus = (data: { status: string; message: string; traceId?: string }) => {
      if (data.status === 'started' || data.status === 'processing') {
        dispatch({ type: 'SET_IS_RUNNING', payload: true });
      } else if (data.status === 'completed' || data.status === 'done') {
        dispatch({ type: 'SET_IS_RUNNING', payload: false });
      }
      if (data.traceId) {
        dispatch({ type: 'SET_CURRENT_TRACE_ID', payload: data.traceId });
      }
    };

    connectionManager.onResponseReady(handleResponseReady);
    connectionManager.onStreamStart(handleStreamStart);
    connectionManager.onStreamChunk(handleStreamChunk);
    connectionManager.onStreamDone(handleStreamDone);
    connectionManager.onProcessingStatus(handleProcessingStatus);

    return () => {
      connectionManager.offResponseReady(handleResponseReady);
      connectionManager.offStreamStart(handleStreamStart);
      connectionManager.offStreamChunk(handleStreamChunk);
      connectionManager.offStreamDone(handleStreamDone);
      connectionManager.offProcessingStatus(handleProcessingStatus);
    };
  }, []);

  // 持久化消息
  useEffect(() => {
    try {
      const toStore = state.messages
        .filter((m) => m.status !== 'sending' && m.status !== 'thinking' && m.status !== 'typing')
        .slice(-MAX_MESSAGES)
        .map((m) => ({ ...m, timestamp: m.timestamp.toISOString() }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } catch {
      // noop
    }
  }, [state.messages]);

  const generateMessageId = useCallback((): string => {
    messageCounterRef.current += 1;
    return `msg_${Date.now().toString(36)}_${messageCounterRef.current.toString(36)}`;
  }, []);

  return <ChatContext.Provider value={{ state, dispatch, generateMessageId }}>{children}</ChatContext.Provider>;
};

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}

export function useChatState(): ChatState {
  return useChat().state;
}

export function useChatDispatch(): React.Dispatch<ChatAction> {
  return useChat().dispatch;
}
