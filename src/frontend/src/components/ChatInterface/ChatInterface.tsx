/**
 * ChatInterface v2 - 复合组件模式重构
 * 消除 boolean prop 泛滥，使用 ChatContext 管理状态
 * 设计原则：
 * - ChatInterface 作为容器，不直接管理状态
 * - 子组件通过 useChat/useChatState 消费状态
 * - 复合组件模式：ChatInterface.Header/Window/Input 等
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { apiService } from '../../api/apiService';
import { useChat } from '../../contexts/ChatContext';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Message, MessageStatus } from '../../types/chat';
import { AgentExecutionPanel } from '../AgentExecutionPanel/AgentExecutionPanel';
import { LogPanel } from '../LogPanel/LogPanel';
import './ChatInterface.css';
import ChatWindow from './ChatWindow';
import DevQuickActions, { QuickAction } from './DevQuickActions';
import MessageInput from './MessageInput';
import VoiceInteraction from './VoiceInteraction';

const WS_URL = `ws://${window.location.hostname}:3111`;
const RESPONSE_TIMEOUT_MS = 35000;
const MAX_INPUT_LENGTH = 500;

// ═══════════════════════════════════════════════════════════════
// 子组件：头部控制栏
// ═══════════════════════════════════════════════════════════════

const ChatHeader: React.FC<{ isConnected: boolean }> = ({ isConnected }) => {
  const { state, dispatch } = useChat();

  const connectionStatus = isConnected ? 'connected' : 'disconnected';
  const statusLabel = isConnected ? '已连接' : '未连接';

  return (
    <div className="chat-header">
      <div className="chat-header-title">
        <h2>家百星 · 御姐秘书</h2>
        <span className="chat-header-sub">成熟、专业、有记忆</span>
      </div>
      <div className="chat-controls">
        <div className={`connection-indicator ${connectionStatus}`}>
          <span className="status-dot" />
          <span>{statusLabel}</span>
        </div>
        {state.isRunning && (
          <button
            className="control-button stop-btn"
            onClick={() => dispatch({ type: 'SET_IS_RUNNING', payload: false })}
            title="停止执行"
          >
            ⏹
          </button>
        )}
        <button
          className="control-button"
          onClick={() => dispatch({ type: 'TOGGLE_LOG_PANEL' })}
          title="显示/隐藏系统日志"
        >
          📝
        </button>
        <button
          className="control-button"
          onClick={() => dispatch({ type: 'TOGGLE_TTS' })}
          title={state.ttsEnabled ? '关闭语音播报' : '开启语音播报'}
        >
          {state.ttsEnabled ? '🔊' : '🔇'}
        </button>
        <button
          className="control-button"
          onClick={() => {
            localStorage.removeItem('jiabaixing_chat_messages');
            dispatch({ type: 'CLEAR_MESSAGES' });
          }}
          title="清空对话"
        >
          🗑️
        </button>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// 子组件：执行状态面板
// ═══════════════════════════════════════════════════════════════

const ExecutionPanel: React.FC = () => {
  const { state, dispatch } = useChat();

  return (
    <AgentExecutionPanel
      steps={state.agentSteps}
      isRunning={state.isRunning}
      onStop={() => dispatch({ type: 'SET_IS_RUNNING', payload: false })}
      brainStageUpdates={state.brainStageUpdates}
      perceptionUpdates={state.perceptionUpdates}
      skillExecutionUpdates={state.skillExecutionUpdates}
    />
  );
};

// ═══════════════════════════════════════════════════════════════
// 子组件：日志面板
// ═══════════════════════════════════════════════════════════════

const ServerLogPanel: React.FC = () => {
  const { state } = useChat();

  if (!state.logPanelVisible) return null;

  return (
    <LogPanel
      wsLogs={state.serverLogs.map((log, index) => ({
        id: `ws_log_${index}_${Date.now()}`,
        timestamp: log.timestamp || new Date().toISOString(),
        level: (log.level as 'debug' | 'info' | 'warn' | 'error') || 'info',
        module: log.module || 'Backend',
        message: log.message,
      }))}
    />
  );
};

// ═══════════════════════════════════════════════════════════════
// 主组件：ChatInterface
// ═══════════════════════════════════════════════════════════════

const ChatInterface: React.FC = () => {
  const { state, dispatch, generateMessageId } = useChat();
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRespondedOnceRef = useRef(false);
  const typingMessageIdRef = useRef<string | null>(null);

  // 处理 Agent 执行状态更新
  const handleAgentExecutionUpdate = useCallback(
    (update: { traceId: string; phase: string; status: string; result?: unknown; timestamp: string }) => {
      const phaseName = (update.phase || '').toLowerCase();
      const status = (update.status || '').toLowerCase();
      const isInProgress = status === 'in-progress' || status === 'running' || status === 'started';
      const isCompleted = status === 'completed' || status === 'success' || status === 'done';
      const isFailed = status === 'failed' || status === 'error';
      const stepName = ['perceive', 'plan', 'execute', 'verify', 'output', 'learn'].find((name) =>
        phaseName.includes(name)
      );

      if (stepName) {
        dispatch({
          type: 'UPDATE_AGENT_STEP',
          name: stepName,
          status: isInProgress ? 'in-progress' : isCompleted ? 'completed' : isFailed ? 'failed' : 'pending',
        });
      }

      if (isInProgress) {
        dispatch({ type: 'SET_IS_RUNNING', payload: true });
      }
      if (isCompleted || isFailed) {
        dispatch({ type: 'SET_IS_RUNNING', payload: false });
      }

      if (isFailed && typeof update.result === 'string') {
        dispatch({
          type: 'ADD_MESSAGE',
          payload: {
            id: generateMessageId(),
            content: `Agent 执行失败：${update.result}`,
            sender: 'system',
            timestamp: new Date(),
            status: 'error',
            emoji: '⚠️',
          },
        });
      }
    },
    [dispatch, generateMessageId]
  );

  const { send, isConnected, dialogState } = useWebSocket({
    url: WS_URL,
    onResponseReady: handleResponseReady,
    onServerLog: handleServerLog,
    onAgentExecutionUpdate: handleAgentExecutionUpdate,
    onBrainStageUpdate: (update) => {
      dispatch({ type: 'ADD_BRAIN_STAGE_UPDATE', payload: update });
    },
    onPerceptionUpdate: (update) => {
      dispatch({ type: 'ADD_PERCEPTION_UPDATE', payload: update });
    },
    onSkillExecutionUpdate: (update) => {
      dispatch({ type: 'ADD_SKILL_EXECUTION_UPDATE', payload: update });
    },
    onEvolutionEvent: (event) => {
      dispatch({ type: 'ADD_EVOLUTION_EVENT', payload: event });
    },
  });

  // 清理超时定时器
  const clearResponseTimeout = useCallback(() => {
    if (responseTimeoutRef.current !== null) {
      clearTimeout(responseTimeoutRef.current);
      responseTimeoutRef.current = null;
    }
  }, []);

  // 语音播报
  const speakResponse = useCallback(
    (text: string) => {
      if (!state.ttsEnabled || !text || typeof window === 'undefined') return;
      const synth = window.speechSynthesis;
      if (!synth) return;

      synth.cancel();
      const cleanText = text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]*`/g, '')
        .replace(/#{1,6}\s/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\n+/g, ' ')
        .trim();

      if (!cleanText) return;
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.1;
      utterance.pitch = 1.05;
      utterance.volume = 0.9;

      const voices = synth.getVoices();
      const zhVoice = voices.find((v) => v.lang.startsWith('zh'));
      if (zhVoice) utterance.voice = zhVoice;
      synth.speak(utterance);
    },
    [state.ttsEnabled]
  );

  // 应用助手回复
  const applyAssistantResponse = useCallback(
    (responseText: string, _traceId?: string) => {
      clearResponseTimeout();
      hasRespondedOnceRef.current = true;

      const assistantMessageId = generateMessageId();
      typingMessageIdRef.current = assistantMessageId;

      dispatch({
        type: 'SET_MESSAGES',
        payload: [
          ...state.messages.map((m) => (m.status === 'sending' ? { ...m, status: 'sent' as MessageStatus } : m)),
          {
            id: assistantMessageId,
            content: responseText,
            sender: 'assistant',
            timestamp: new Date(),
            status: 'typing',
            emoji: '🤔',
          },
        ],
      });

      dispatch({ type: 'SET_IS_LOADING', payload: false });
      dispatch({ type: 'SET_IS_RUNNING', payload: false });
      dispatch({ type: 'SET_IS_TYPING', payload: true });

      setTimeout(() => speakResponse(responseText), 300);
    },
    [state.messages, generateMessageId, clearResponseTimeout, speakResponse, dispatch]
  );

  // 处理响应就绪
  function handleResponseReady(response: string | unknown, _traceId?: string) {
    let responseText: string;
    if (typeof response === 'string') {
      responseText = response;
    } else if (typeof response === 'object' && response !== null) {
      const respObj = response as { response?: string };
      responseText = respObj.response || JSON.stringify(response);
    } else {
      responseText = String(response || '');
    }
    applyAssistantResponse(responseText, _traceId);
  }

  // 处理服务器日志
  function handleServerLog(entry: { timestamp: string; level: string; message: string; module?: string }) {
    dispatch({ type: 'ADD_SERVER_LOG', payload: entry });
  }

  // 标记消息失败
  const markMessageFailed = useCallback(
    (messageId: string, reason: string) => {
      clearResponseTimeout();
      dispatch({
        type: 'UPDATE_MESSAGE',
        id: messageId,
        updates: { status: 'error', errorReason: reason, emoji: '💔' },
      });
      dispatch({ type: 'SET_IS_LOADING', payload: false });
      dispatch({ type: 'SET_IS_TYPING', payload: false });
      dispatch({ type: 'SET_IS_RUNNING', payload: false });
      typingMessageIdRef.current = null;
    },
    [clearResponseTimeout, dispatch]
  );

  // 跳过打字效果
  const skipTyping = useCallback(
    (messageId: string) => {
      if (typingMessageIdRef.current === messageId) {
        typingMessageIdRef.current = null;
        dispatch({ type: 'SET_IS_TYPING', payload: false });
      }
      dispatch({
        type: 'UPDATE_MESSAGE',
        id: messageId,
        updates: { status: 'sent' },
      });
    },
    [dispatch]
  );

  // 重试发送
  const retrySend = useCallback(
    (failedMessage: Message) => {
      if (!failedMessage.retryPayload) return;
      const { text, images } = failedMessage.retryPayload;

      dispatch({
        type: 'UPDATE_MESSAGE',
        id: failedMessage.id,
        updates: { status: 'retrying', content: '', emoji: '⏳' },
      });

      clearResponseTimeout();
      responseTimeoutRef.current = setTimeout(() => {
        markMessageFailed(failedMessage.id, '响应超时，请稍后重试');
      }, RESPONSE_TIMEOUT_MS);

      if (isConnected && send) {
        send({
          type: 'user_input',
          payload: { input: text, userId: 'web_user', images },
        });
      } else {
        apiService
          .processMultimodalMessage(text, images)
          .then((response) => {
            clearResponseTimeout();
            if (response.success && response.data) {
              const responseData = response.data as Record<string, unknown>;
              const rawResponse = responseData.response;
              const responseText =
                typeof rawResponse === 'string'
                  ? rawResponse
                  : typeof rawResponse === 'object' && rawResponse !== null
                    ? ((rawResponse as Record<string, unknown>)?.response as string) || JSON.stringify(rawResponse)
                    : String(rawResponse || '');

              dispatch({
                type: 'UPDATE_MESSAGE',
                id: failedMessage.id,
                updates: {
                  status: 'sent',
                  content: responseText,
                  sender: 'assistant',
                  emoji: '🤔',
                },
              });
              dispatch({ type: 'SET_IS_LOADING', payload: false });
              dispatch({ type: 'SET_IS_TYPING', payload: false });
              setTimeout(() => speakResponse(responseText), 300);
            } else {
              markMessageFailed(failedMessage.id, response.error || '服务端处理失败');
            }
          })
          .catch(() => {
            clearResponseTimeout();
            markMessageFailed(failedMessage.id, '网络连接异常');
          });
      }
    },
    [isConnected, send, clearResponseTimeout, markMessageFailed, speakResponse, dispatch]
  );

  // 发送消息
  const handleSendMessage = useCallback(
    async (images?: string[]) => {
      if (!state.inputText.trim() && (!images || images.length === 0)) return;

      if (state.inputText.length > MAX_INPUT_LENGTH) {
        dispatch({
          type: 'ADD_MESSAGE',
          payload: {
            id: generateMessageId(),
            content: `消息过长（${state.inputText.length}字），请控制在${MAX_INPUT_LENGTH}字以内`,
            sender: 'assistant',
            timestamp: new Date(),
            status: 'sent',
            emoji: '⚠️',
          },
        });
        return;
      }

      const pendingId = generateMessageId();
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: pendingId,
          content: state.inputText || `[图片${images?.length || 0}张]`,
          sender: 'user',
          timestamp: new Date(),
          status: 'sending',
          retryPayload: { text: state.inputText, images },
        },
      });

      dispatch({ type: 'SET_INPUT_TEXT', payload: '' });
      dispatch({ type: 'SET_IS_RUNNING', payload: true });
      dispatch({ type: 'RESET_AGENT_STEPS' });
      dispatch({ type: 'SET_IS_LOADING', payload: true });
      hasRespondedOnceRef.current = false;

      clearResponseTimeout();
      responseTimeoutRef.current = setTimeout(() => {
        if (!hasRespondedOnceRef.current) {
          markMessageFailed(pendingId, '对方响应超时，可能正在忙碌');
        }
      }, RESPONSE_TIMEOUT_MS);

      // 优先走 WebSocket（响应通过 onResponseReady 回调返回）
      if (isConnected && send) {
        send({
          type: 'user_input',
          payload: { input: state.inputText, userId: 'web_user', images },
        });
        return;
      }

      // WebSocket 未连接时，回退到 HTTP API
      try {
        const response = await apiService.processMultimodalMessage(state.inputText, images);
        clearResponseTimeout();
        dispatch({ type: 'SET_IS_TYPING', payload: false });

        if (response.success && response.data) {
          const responseData = response.data as Record<string, unknown>;
          const rawResponse = responseData.response;
          const responseText =
            typeof rawResponse === 'string'
              ? rawResponse
              : typeof rawResponse === 'object' && rawResponse !== null
                ? ((rawResponse as Record<string, unknown>)?.response as string) || JSON.stringify(rawResponse)
                : String(rawResponse || '');

          hasRespondedOnceRef.current = true;
          applyAssistantResponse(responseText);
        } else {
          markMessageFailed(pendingId, response.error || '服务端处理失败');
        }
      } catch (error) {
        clearResponseTimeout();
        dispatch({ type: 'SET_IS_TYPING', payload: false });
        const errorMessage = error instanceof Error ? error.message : '网络连接异常';
        markMessageFailed(pendingId, errorMessage);
      } finally {
        dispatch({ type: 'SET_IS_LOADING', payload: false });
        dispatch({ type: 'SET_IS_RUNNING', payload: false });
      }
    },
    [
      state.inputText,
      isConnected,
      send,
      generateMessageId,
      clearResponseTimeout,
      markMessageFailed,
      applyAssistantResponse,
      dispatch,
    ]
  );

  // 语音输入
  const handleVoiceInput = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      dispatch({ type: 'SET_INPUT_TEXT', payload: text });
      setTimeout(() => handleSendMessage(), 100);
    },
    [handleSendMessage, dispatch]
  );

  // 快捷操作
  const handleQuickAction = useCallback(
    (action: QuickAction) => {
      dispatch({ type: 'SET_INPUT_TEXT', payload: action.prompt });
      setTimeout(() => handleSendMessage(), 50);
    },
    [handleSendMessage, dispatch]
  );

  // 取消执行
  const cancelExecution = useCallback(() => {
    if (isConnected && send) {
      send({ type: 'cancel', payload: { reason: 'user_cancelled' } });
    }
    dispatch({ type: 'SET_IS_RUNNING', payload: false });
    dispatch({ type: 'SET_IS_LOADING', payload: false });
    dispatch({ type: 'SET_IS_TYPING', payload: false });
    typingMessageIdRef.current = null;
    clearResponseTimeout();
  }, [isConnected, send, clearResponseTimeout, dispatch]);

  // 清理
  useEffect(() => {
    return () => clearResponseTimeout();
  }, [clearResponseTimeout]);

  return (
    <div className="chat-interface">
      <ChatHeader isConnected={isConnected} />
      <ExecutionPanel />
      <DevQuickActions onAction={handleQuickAction} disabled={state.isLoading} />
      <ChatWindow
        messages={state.messages}
        isLoading={state.isLoading}
        isTyping={state.isTyping}
        onRetry={retrySend}
        onSkipTyping={skipTyping}
        onQuickPrompt={(text) => {
          dispatch({ type: 'SET_INPUT_TEXT', payload: text });
          setTimeout(() => handleSendMessage(), 50);
        }}
      />
      <VoiceInteraction onVoiceInput={handleVoiceInput} isProcessing={state.isLoading} dialogState={dialogState} />
      <MessageInput
        inputText={state.inputText}
        setInputText={(text) => dispatch({ type: 'SET_INPUT_TEXT', payload: text })}
        isLoading={state.isLoading}
        onSend={handleSendMessage}
        isTyping={state.isTyping}
      />
      <ServerLogPanel />
    </div>
  );
};

export default ChatInterface;
