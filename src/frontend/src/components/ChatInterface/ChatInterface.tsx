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
import { Message } from '../../types/chat';
import { AgentExecutionPanel } from '../AgentExecutionPanel/AgentExecutionPanel';
import { LogPanel } from '../LogPanel/LogPanel';
import './ChatInterface.css';
import ChatWindow from './ChatWindow';
import MessageInput from './MessageInput';
import VoiceInteraction from './VoiceInteraction';
import {
  WsBrainStageUpdateData,
  WsPerceptionUpdateData,
  WsSkillExecutionUpdateData,
  WsEvolutionEventData,
  SYSTEM_CONSTANTS,
} from '@shared/contracts';

const WS_URL = (window as unknown as Record<string, string>).REACT_APP_WS_URL || `ws://${window.location.hostname}:3111`;
const API_BASE = (window as unknown as Record<string, string>).REACT_APP_API_URL || `http://${window.location.hostname}:3111`;
const RESPONSE_TIMEOUT_MS = 0;

const ChatHeader: React.FC<{
  isConnected: boolean;
  onCancelTask: () => void;
  onReconnect?: () => void;
}> = ({ isConnected, onCancelTask, onReconnect }) => {
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
          {!isConnected && onReconnect && (
            <button className="reconnect-button" onClick={onReconnect} title="重新连接">
              🔄
            </button>
          )}
        </div>
        {state.isRunning && (
          <button className="control-button stop-btn" onClick={onCancelTask} title="取消执行">
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

const ServerLogPanel: React.FC = () => {
  const { state } = useChat();

  if (!state.logPanelVisible) return null;

  return (
    <LogPanel
      wsLogs={state.serverLogs.map(
        (log: { timestamp?: string; level?: string; module?: string; message?: string }, index: number) => ({
          id: `ws_log_${index}_${Date.now()}`,
          timestamp: log.timestamp || new Date().toISOString(),
          level: (log.level as 'debug' | 'info' | 'warn' | 'error') || 'info',
          module: log.module || 'Backend',
          message: log.message || '',
        })
      )}
    />
  );
};

const ChatInterface: React.FC = () => {
  const { state, dispatch, generateMessageId } = useChat();
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRespondedOnceRef = useRef(false);
  const typingMessageIdRef = useRef<string | null>(null);
  const currentTraceIdRef = useRef<string | null>(null);

  const setCurrentTraceId = useCallback(
    (traceId: string | null) => {
      currentTraceIdRef.current = traceId;
      dispatch({ type: 'SET_CURRENT_TRACE_ID', payload: traceId });
    },
    [dispatch]
  );

  const logFrontend = useCallback(
    (level: 'debug' | 'info' | 'warn' | 'error', module: string, message: string) => {
      const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'info' ? 'ℹ️' : '🔍';
      console.log(`${prefix} [${module}] ${message}`);
      dispatch({
        type: 'ADD_SERVER_LOG',
        payload: {
          timestamp: new Date().toISOString(),
          level,
          module: `FE:${module}`,
          message,
        },
      });
    },
    [dispatch]
  );

  const handleAgentExecutionUpdate = useCallback(
    (update: {
      traceId: string;
      phase: string;
      status: string;
      result?: unknown;
      timestamp: string;
      roundsUsed?: number;
      toolCallsUsed?: number;
      elapsedMs?: number;
    }) => {
      if (update.traceId) {
        setCurrentTraceId(update.traceId);
      }
      const phaseName = (update.phase || '').toLowerCase();
      const status = (update.status || '').toLowerCase();
      const isInProgress = status === 'in-progress' || status === 'running' || status === 'started';
      const isCompleted = status === 'completed' || status === 'success' || status === 'done';
      const isFailed = status === 'failed' || status === 'error' || status === 'aborted';

      const phaseToStepMap: Record<string, string> = {
        planning: 'plan',
        plan: 'plan',
        executing: 'execute',
        execute: 'execute',
        evaluating: 'verify',
        verify: 'verify',
        reporting: 'output',
        output: 'output',
        learning: 'learn',
        learn: 'learn',
        processing_start: 'perceive',
        perceive: 'perceive',
        harness_start: 'perceive',
        building_context: 'perceive',
        processing_error: 'output',
        retrying: 'execute',
        cancelled: 'output',
      };

      const stepName = phaseToStepMap[phaseName] || Object.keys(phaseToStepMap).find((key) => phaseName.includes(key));

      if (stepName) {
        dispatch({
          type: 'UPDATE_AGENT_STEP',
          name: stepName,
          status: isInProgress ? 'in-progress' : isCompleted ? 'completed' : isFailed ? 'failed' : 'pending',
        });
      }

      const _fallbackMessages: Record<string, string> = {
        planning: '正在分析需求...',
        plan: '正在制定方案...',
        executing: `正在执行中... (${update.toolCallsUsed || 0} 次工具调用)`,
        execute: `正在执行中... (${update.toolCallsUsed || 0} 次工具调用)`,
        evaluating: '正在验证结果...',
        verify: '正在验证结果...',
        reporting: '正在生成回复...',
        output: '正在生成回复...',
        processing_start: '已收到消息，开始处理...',
        harness_start: '正在初始化智能引擎...',
        building_context: '正在构建上下文...',
        completed: '处理完成',
        retrying: '处理遇到问题，正在重试...',
        cancelled: '任务已取消',
      };

      if (isInProgress) {
        dispatch({ type: 'SET_IS_RUNNING', payload: true });
      }
      if (isCompleted) {
        dispatch({ type: 'SET_IS_RUNNING', payload: false });
      }
      if (isFailed) {
        dispatch({ type: 'SET_IS_RUNNING', payload: false });
      }

      if (isFailed && typeof update.result === 'string') {
        dispatch({
          type: 'ADD_MESSAGE',
          payload: {
            id: generateMessageId(),
            content: `执行失败：${update.result}`,
            sender: 'system',
            timestamp: new Date(),
            status: 'error',
            emoji: '⚠️',
          },
        });
      }
    },
    [dispatch, generateMessageId, setCurrentTraceId]
  );

  const { send, isConnected, dialogState, reconnect } = useWebSocket({
    url: WS_URL,
    onResponseReady: handleResponseReady,
    onServerLog: handleServerLog,
    onAgentExecutionUpdate: handleAgentExecutionUpdate,
    onBrainStageUpdate: (update) => {
      dispatch({ type: 'ADD_BRAIN_STAGE_UPDATE', payload: update as WsBrainStageUpdateData });
    },
    onPerceptionUpdate: (update) => {
      dispatch({ type: 'ADD_PERCEPTION_UPDATE', payload: update as WsPerceptionUpdateData });
    },
    onSkillExecutionUpdate: (update) => {
      dispatch({ type: 'ADD_SKILL_EXECUTION_UPDATE', payload: update as WsSkillExecutionUpdateData });
    },
    onEvolutionEvent: (event) => {
      dispatch({ type: 'ADD_EVOLUTION_EVENT', payload: event as WsEvolutionEventData });
    },
    onProcessingStatus: (data) => {
      logFrontend('info', 'Chat', `收到处理状态: ${data.message}, traceId=${data.traceId}`);
      dispatch({ type: 'SET_IS_TYPING', payload: true });
    },
    onTaskCancelled: (data) => {
      logFrontend('info', 'Chat', `任务已取消: traceId=${data.traceId}`);
      dispatch({ type: 'SET_IS_RUNNING', payload: false });
      dispatch({ type: 'CLEAR_PROGRESS_MESSAGES' });
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: generateMessageId(),
          content: data.message || '任务已取消',
          sender: 'system',
          timestamp: new Date(),
          status: 'error',
          emoji: '🚫',
        },
      });
      currentTraceIdRef.current = null;
      setCurrentTraceId(null);
    },
    onStreamStart: (data) => {
      const traceId = data.traceId || '';
      logFrontend('info', 'Chat', `流式开始: traceId=${traceId}, totalLength=${data.totalLength}`);
      clearResponseTimeout();
      hasRespondedOnceRef.current = true;
      dispatch({ type: 'MARK_SENDING_AS_SENT' });
      const streamMsgId = generateMessageId();
      typingMessageIdRef.current = streamMsgId;
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: streamMsgId,
          content: '',
          sender: 'assistant',
          timestamp: new Date(),
          status: 'streaming',
          emoji: '🤔',
        },
      });
      dispatch({ type: 'SET_IS_LOADING', payload: false });
      dispatch({ type: 'SET_IS_TYPING', payload: true });
    },
    onStreamChunk: (data) => {
      const chunk = data.chunk || '';
      if (chunk && typingMessageIdRef.current) {
        dispatch({ type: 'APPEND_STREAM_CHUNK', id: typingMessageIdRef.current, chunk });
      }
    },
    onStreamDone: (data) => {
      const fullText = data.fullText || '';
      logFrontend('info', 'Chat', `流式完成: traceId=${data.traceId}, 长度=${fullText.length}`);
      if (typingMessageIdRef.current) {
        dispatch({ type: 'FINISH_STREAM', id: typingMessageIdRef.current });
        typingMessageIdRef.current = null;
      }
      dispatch({ type: 'SET_IS_RUNNING', payload: false });
      dispatch({ type: 'SET_IS_TYPING', payload: false });
      setTimeout(() => speakResponse(fullText), 300);
    },
  });

  const clearResponseTimeout = useCallback(() => {
    if (responseTimeoutRef.current !== null) {
      clearTimeout(responseTimeoutRef.current);
      responseTimeoutRef.current = null;
    }
  }, []);

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

  const applyAssistantResponse = useCallback(
    (responseText: string, _traceId?: string) => {
      clearResponseTimeout();
      hasRespondedOnceRef.current = true;

      const assistantMessageId = generateMessageId();
      typingMessageIdRef.current = assistantMessageId;

      logFrontend(
        'info',
        'Chat',
        `applyAssistantResponse: 添加AI消息 id=${assistantMessageId.substring(0, 8)}, traceId=${_traceId}`
      );

      dispatch({
        type: 'MARK_SENDING_AS_SENT',
      });

      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: assistantMessageId,
          content: responseText,
          sender: 'assistant',
          timestamp: new Date(),
          status: 'typing',
          emoji: '🤔',
        },
      });

      dispatch({ type: 'SET_IS_LOADING', payload: false });
      dispatch({ type: 'SET_IS_RUNNING', payload: false });
      dispatch({ type: 'SET_IS_TYPING', payload: true });

      setTimeout(() => speakResponse(responseText), 300);
    },
    [generateMessageId, clearResponseTimeout, speakResponse, dispatch, logFrontend]
  );

  function handleResponseReady(response: string | unknown, _traceId?: string) {
    if (hasRespondedOnceRef.current && typingMessageIdRef.current) {
      logFrontend('info', 'Chat', `handleResponseReady: 已有流式响应在处理中，跳过`);
      return;
    }

    let responseText: string;
    if (typeof response === 'string') {
      responseText = response;
    } else if (typeof response === 'object' && response !== null) {
      const respObj = response as { response?: string };
      responseText = respObj.response || JSON.stringify(response);
    } else {
      responseText = String(response || '');
    }
    console.log(
      `✅ [Chat] handleResponseReady: traceId=${_traceId}, 长度=${responseText.length}, 预览="${responseText.substring(0, 60)}"`
    );
    logFrontend('info', 'Chat', `handleResponseReady: traceId=${_traceId}, 响应长度=${responseText.length}`);
    applyAssistantResponse(responseText, _traceId);
  }

  function handleServerLog(entry: { timestamp: string; level: string; message: string; module?: string }) {
    dispatch({ type: 'ADD_SERVER_LOG', payload: entry });
  }

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
      if (RESPONSE_TIMEOUT_MS > 0) {
        responseTimeoutRef.current = setTimeout(() => {
          markMessageFailed(failedMessage.id, '响应超时，请稍后重试');
        }, RESPONSE_TIMEOUT_MS);
      }

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

  const handleSendMessage = useCallback(
    async (images?: string[]) => {
      if (!state.inputText.trim() && (!images || images.length === 0)) return;

      // 斜杠命令处理
      const text = state.inputText.trim();
      if (text.startsWith('/')) {
        const parts = text.slice(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const _args = parts.slice(1).join(' ');

        // 本地命令（不请求后端）
        if (cmd === 'clear') {
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({ type: 'SET_INPUT_TEXT', payload: '' });
          return;
        }
        if (cmd === 'help') {
          dispatch({
            type: 'ADD_MESSAGE',
            payload: {
              id: generateMessageId(),
              content: `**家百星 · 命令帮助**\n\n/help — 显示此帮助\n/clear — 清空对话\n/skills — 打开技能面板\n/status — 查看系统状态\n/model — 查看当前模型\n\n也可以直接跟我聊天，我会自动判断是否需要调工具来完成任务。`,
              sender: 'assistant' as const,
              timestamp: new Date(),
              status: 'sent' as const,
              emoji: '💡',
            },
          });
          dispatch({ type: 'SET_INPUT_TEXT', payload: '' });
          return;
        }
        if (cmd === 'skills') {
          // 切换到技能面板
          window.location.hash = '#skills';
          dispatch({ type: 'SET_INPUT_TEXT', payload: '' });
          return;
        }
        if (cmd === 'status') {
          // 调后端获取状态
          try {
            const resp = await fetch(`${API_BASE}/api/health`);
            const data = await resp.json();
            dispatch({
              type: 'ADD_MESSAGE',
              payload: {
                id: generateMessageId(),
                content: `**系统状态**\n- 模型: ${data.model}\n- 运行时间: ${Math.floor(data.uptime / 60)} 分钟\n- LLM: ${data.llm?.available ? '✅ 可用' : '❌ 不可用'}\n- 自动优化: ${data.autoOptimize ? '✅ 开启' : '❌ 关闭'}`,
                sender: 'assistant' as const,
                timestamp: new Date(),
                status: 'sent' as const,
                emoji: '📊',
              },
            });
          } catch {
            dispatch({ type: 'ADD_MESSAGE', payload: { id: generateMessageId(), content: '获取状态失败', sender: 'system' as const, timestamp: new Date(), status: 'error' as const, emoji: '⚠️' } });
          }
          dispatch({ type: 'SET_INPUT_TEXT', payload: '' });
          return;
        }
        if (cmd === 'model') {
          dispatch({
            type: 'ADD_MESSAGE',
            payload: {
              id: generateMessageId(),
              content: `当前模型: ${API_BASE.replace('http://', '').split(':')[0]}:3111 (DeepSeek 兼容接口)`,
              sender: 'assistant' as const,
              timestamp: new Date(),
              status: 'sent' as const,
              emoji: '🤖',
            },
          });
          dispatch({ type: 'SET_INPUT_TEXT', payload: '' });
          return;
        }
      }

      if (text.length > SYSTEM_CONSTANTS.MAX_INPUT_LENGTH) {
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: generateMessageId(),
          content: `消息过长（${state.inputText.length}字），请控制在${SYSTEM_CONSTANTS.MAX_INPUT_LENGTH}字以内`,
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
          status: 'sent',
          retryPayload: { text: state.inputText, images },
        },
      });

      logFrontend(
        'info',
        'Chat',
        `用户消息已添加: id=${pendingId.substring(0, 8)}, 内容="${state.inputText.substring(0, 30)}"`
      );

      dispatch({ type: 'SET_INPUT_TEXT', payload: '' });
      dispatch({ type: 'SET_IS_RUNNING', payload: true });
      dispatch({ type: 'RESET_AGENT_STEPS' });
      dispatch({ type: 'SET_IS_LOADING', payload: true });
      hasRespondedOnceRef.current = false;

      clearResponseTimeout();
      if (RESPONSE_TIMEOUT_MS > 0) {
        responseTimeoutRef.current = setTimeout(() => {
          if (!hasRespondedOnceRef.current) {
            markMessageFailed(pendingId, '对方响应超时，可能正在忙碌');
          }
        }, RESPONSE_TIMEOUT_MS);
      }

      if (isConnected && send) {
        logFrontend('info', 'Chat', `WS发送: "${state.inputText.substring(0, 50)}", 已连接=${isConnected}`);
        send({
          type: 'user_input',
          payload: { input: state.inputText, userId: 'web_user', images },
        });
        return;
      }

      logFrontend('info', 'Chat', `WS未连接，走HTTP API: "${state.inputText.substring(0, 50)}"`);
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
      logFrontend,
    ]
  );

  const handleVoiceInput = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      dispatch({ type: 'SET_INPUT_TEXT', payload: text });
      setTimeout(() => handleSendMessage(), 100);
    },
    [handleSendMessage, dispatch]
  );

  useEffect(() => {
    return () => clearResponseTimeout();
  }, [clearResponseTimeout]);

  return (
    <div className="chat-interface">
      <ChatHeader
        isConnected={isConnected}
        onReconnect={reconnect}
        onCancelTask={() => {
          if (currentTraceIdRef.current && send) {
            send({ type: 'cancel_task', traceId: currentTraceIdRef.current });
          }
          dispatch({ type: 'SET_IS_RUNNING', payload: false });
          dispatch({ type: 'CLEAR_PROGRESS_MESSAGES' });
          setCurrentTraceId(null);
        }}
      />
      <ExecutionPanel />
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
