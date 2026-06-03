import {
  ConnectionConfig,
  StateChangeListener,
  DialogStateListener,
  MessageListener,
  ConnectionStatusListener,
  AgentExecutionListener,
  PerceptionUpdateListener,
  BrainStageUpdateListener,
  SkillExecutionUpdateListener,
  EvolutionEventListener,
  ClarificationRequestListener,
  ExecutionPreviewListener,
  FileModifiedListener,
  ToolTraceListener,
  DialogStateValue,
  DialogState,
  AgentExecutionUpdate,
  PerceptionUpdate,
  BrainStageUpdate,
  SkillExecutionUpdate,
  EvolutionEvent,
  ClarificationRequest,
  ExecutionPreview,
  FileModifiedEvent,
  ToolTraceEvent,
  ConnectionStatus,
  WebSocketMessage,
  ServerLogEntry,
  ErrorEventListener,
  ProactiveMessageListener,
  WeightUpdateListener,
  FileRollbackListener,
  MultiFileModifiedListener,
  UserCorrectionListener,
  ErrorEvent,
  ProactiveMessage,
  WeightUpdate,
  FileRollback,
  MultiFileModified,
  UserCorrection,
  TaskCancelled,
  TaskCancelledListener,
  EnvironmentUpdate,
  EnvironmentUpdateListener,
  ProjectChange,
  ProjectChangeListener,
  GitStatus,
  GitStatusListener,
  StreamStartListener,
  StreamChunkListener,
  StreamDoneListener,
} from './types';
import { SYSTEM_CONSTANTS } from '@shared/contracts';

type ServerLogListener = (entry: ServerLogEntry) => void;
type ResponseReadyListener = (response: unknown, traceId?: string) => void;

class WebSocketConnectionManager {
  private ws: WebSocket | null = null;
  private config: ConnectionConfig | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50;
  private isActive = false;

  private stateListeners = new Set<StateChangeListener>();
  private dialogStateListeners = new Set<DialogStateListener>();
  private messageListeners = new Set<MessageListener>();
  private connectionStatusListeners = new Set<ConnectionStatusListener>();
  private agentExecutionListeners = new Set<AgentExecutionListener>();
  private perceptionUpdateListeners = new Set<PerceptionUpdateListener>();
  private brainStageUpdateListeners = new Set<BrainStageUpdateListener>();
  private skillExecutionUpdateListeners = new Set<SkillExecutionUpdateListener>();
  private evolutionEventListeners = new Set<EvolutionEventListener>();
  private clarificationRequestListeners = new Set<ClarificationRequestListener>();
  private executionPreviewListeners = new Set<ExecutionPreviewListener>();
  private fileModifiedListeners = new Set<FileModifiedListener>();
  private toolTraceListeners = new Set<ToolTraceListener>();
  private serverLogListeners = new Set<ServerLogListener>();
  private responseReadyListeners = new Set<ResponseReadyListener>();
  private errorListeners = new Set<ErrorEventListener>();
  private proactiveMessageListeners = new Set<ProactiveMessageListener>();
  private weightUpdateListeners = new Set<WeightUpdateListener>();
  private fileRollbackListeners = new Set<FileRollbackListener>();
  private multiFileModifiedListeners = new Set<MultiFileModifiedListener>();
  private userCorrectionListeners = new Set<UserCorrectionListener>();
  private taskCancelledListeners = new Set<TaskCancelledListener>();
  private environmentUpdateListeners = new Set<EnvironmentUpdateListener>();
  private projectChangeListeners = new Set<ProjectChangeListener>();
  private gitStatusListeners = new Set<GitStatusListener>();
  private processingStatusListeners = new Set<(data: { status: string; message: string; traceId?: string }) => void>();
  private streamStartListeners = new Set<StreamStartListener>();
  private streamChunkListeners = new Set<StreamChunkListener>();
  private streamDoneListeners = new Set<StreamDoneListener>();

  private currentDialogState: DialogStateValue = 'idle';
  private currentConnected = false;
  private currentConnectionStatus: ConnectionStatus = 'disconnected';
  private pendingMessages: Array<Record<string, unknown>> = [];
  private static readonly MAX_PENDING_MESSAGES = 20;

  initialize(config: ConnectionConfig): void {
    const urlChanged = this.config?.url !== config.url;
    this.config = config;
    this.isActive = true;

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.reconnectAttempts = 0;
      this.connect();
    } else if (urlChanged) {
      this.reconnectAttempts = 0;
      this.cleanupSocket();
      this.ws = null;
      this.connect();
    }
  }

  private connect(): void {
    this.clearReconnectTimer();

    if (!this.config || !this.isActive) {
      return;
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        return;
      }
      this.cleanupSocket();
    }

    this.updateConnectionStatus('connecting');
    console.log(`🔌 正在连接WebSocket: ${this.config.url} (第${this.reconnectAttempts + 1}次)`);

    try {
      const ws = new WebSocket(this.config.url);
      this.ws = ws;

      ws.onopen = () => {
        console.log('✅ WebSocket连接成功');
        this.updateConnectionState(true);
        this.updateConnectionStatus('connected');
        this.reconnectAttempts = 0;
        this.flushPendingMessages();
      };

      ws.onclose = (event) => {
        const wasConnected = this.currentConnected;
        this.updateConnectionState(false);
        this.ws = null;

        if (wasConnected) {
          console.warn(`🔌 WebSocket连接已断开: code=${event.code}`);
        }

        if (this.isActive && this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(
            SYSTEM_CONSTANTS.WS_RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            SYSTEM_CONSTANTS.WS_RECONNECT_MAX_DELAY_MS
          );
          this.updateConnectionStatus('reconnecting');
          this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect();
          }, delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.updateConnectionStatus('disconnected');
          console.error('❌ WebSocket重连次数已达上限，停止重连');
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          const message: WebSocketMessage = JSON.parse(raw);
          this.handleMessage(message);
        } catch (error) {
          console.error('❌ WebSocket消息解析失败', {
            error: error instanceof Error ? error.message : String(error),
            rawData: String(event.data).substring(0, 200),
          });
        }
      };

      ws.onerror = (_error: Event) => {
        console.error('❌ WebSocket连接错误', {
          wasConnected: this.currentConnected,
          reconnectAttempts: this.reconnectAttempts,
          url: this.config?.url,
        });
        this.updateConnectionState(false);
        this.updateConnectionStatus('disconnected');
        // 通知 error 监听器
        this.errorListeners.forEach((listener) => {
          try {
            listener({
              message: `WebSocket连接失败: ${this.config?.url || '未知'}`,
              traceId: '',
            });
          } catch {
            // 静默
          }
        });
        // 出错后也尝试重连
        if (this.isActive && this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(
            SYSTEM_CONSTANTS.WS_RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            SYSTEM_CONSTANTS.WS_RECONNECT_MAX_DELAY_MS
          );
          this.updateConnectionStatus('reconnecting');
          this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect();
          }, delay);
        }
      };
    } catch {
      this.updateConnectionState(false);
      this.updateConnectionStatus('disconnected');
    }
  }

  private handleMessage(message: WebSocketMessage): void {
    const traceTag = message.traceId ? ` [traceId: ${message.traceId}]` : '';
    const timestamp = new Date().toISOString();
    console.log(`📨 [${timestamp}] 收到WebSocket消息: ${message.type}${traceTag}`);

    if (message.type === 'response_ready') {
      const data = message.data as Record<string, unknown> | undefined;
      const responsePreview =
        typeof data?.response === 'string'
          ? data.response.substring(0, 80)
          : JSON.stringify(data?.response)?.substring(0, 80);
      console.log(`💬 [WS] response_ready: "${responsePreview}..."${traceTag}`);
    }

    this.messageListeners.forEach((listener) => {
      try {
        listener(message);
      } catch (err) {
        console.error(`❌ [WS] 消息监听器处理失败: ${message.type}`, err);
      }
    });

    switch (message.type) {
      case 'asr_result':
        this.updateDialogState('listening');
        break;
      case 'tts_chunk':
        this.updateDialogState('speaking');
        break;
      case 'dialog_state': {
        const stateData = message.data as unknown as DialogState;
        const stateMap: Record<string, DialogStateValue> = {
          LISTENING: 'listening',
          PROCESSING: 'processing',
          SPEAKING: 'speaking',
        };
        this.updateDialogState(stateMap[stateData.state] || 'idle');
        break;
      }
      case 'agent_execution_update': {
        const updateData = message.data as unknown as AgentExecutionUpdate;
        this.agentExecutionListeners.forEach((listener) => {
          try {
            listener(updateData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'perception_update': {
        const updateData = message.data as unknown as PerceptionUpdate;
        this.perceptionUpdateListeners.forEach((listener) => {
          try {
            listener(updateData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'brain_stage_update': {
        const updateData = message.data as unknown as BrainStageUpdate;
        this.brainStageUpdateListeners.forEach((listener) => {
          try {
            listener(updateData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'skill_execution_update': {
        const updateData = message.data as unknown as SkillExecutionUpdate;
        this.skillExecutionUpdateListeners.forEach((listener) => {
          try {
            listener(updateData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'evolution_event': {
        const eventData = message.data as unknown as EvolutionEvent;
        this.evolutionEventListeners.forEach((listener) => {
          try {
            listener(eventData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'clarification_request': {
        const requestData = message.data as unknown as ClarificationRequest;
        console.log('🤔 收到澄清请求:', requestData.question);
        this.clarificationRequestListeners.forEach((listener) => {
          try {
            listener(requestData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'execution_preview': {
        const previewData = message.data as unknown as ExecutionPreview;
        console.log('📋 收到执行预览:', previewData.summary);
        this.executionPreviewListeners.forEach((listener) => {
          try {
            listener(previewData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'file_modified': {
        const fileData = message.data as unknown as FileModifiedEvent;
        console.log('✏️ 文件已修改:', fileData.filePath);
        this.fileModifiedListeners.forEach((listener) => {
          try {
            listener(fileData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'tool_trace': {
        const traceData = message.data as unknown as ToolTraceEvent;
        this.toolTraceListeners.forEach((listener) => {
          try {
            listener(traceData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'server_log': {
        const logData = message.data as unknown as ServerLogEntry;
        this.serverLogListeners.forEach((listener) => {
          try {
            listener(logData);
          } catch (err) {
            console.error(`❌ [WS] server_log监听器处理失败`, err);
          }
        });
        break;
      }
      case 'response_ready':
        this.updateDialogState('speaking');
        this.responseReadyListeners.forEach((listener) => {
          try {
            listener(message.data, message.traceId);
          } catch {
            // 静默处理
          }
        });
        break;
      case 'response':
        this.updateDialogState('speaking');
        break;
      case 'processing_status': {
        const statusData = message.data as unknown as { status: string; message: string; traceId?: string };
        console.log('⏳ 收到处理状态更新:', statusData.message);
        this.processingStatusListeners.forEach((listener) => {
          try {
            listener(statusData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'connected':
        console.log('📨 WebSocket连接已确认');
        break;
      case 'error': {
        const errorData = message.data as unknown as ErrorEvent;
        console.error('❌ 收到服务器错误:', errorData);
        this.errorListeners.forEach((listener) => {
          try {
            listener(errorData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'proactive_message': {
        const messageData = message.data as unknown as ProactiveMessage;
        console.log('💬 收到主动消息:', messageData.message);
        this.proactiveMessageListeners.forEach((listener) => {
          try {
            listener(messageData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'weight_update': {
        const updateData = message.data as unknown as WeightUpdate;
        this.weightUpdateListeners.forEach((listener) => {
          try {
            listener(updateData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'file_rollback': {
        const rollbackData = message.data as unknown as FileRollback;
        console.log('↩️ 文件已回滚:', rollbackData.filePath);
        this.fileRollbackListeners.forEach((listener) => {
          try {
            listener(rollbackData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'multi_file_modified': {
        const multiFileData = message.data as unknown as MultiFileModified;
        console.log('📝 多个文件已修改:', multiFileData.files?.length || 0, '个文件');
        this.multiFileModifiedListeners.forEach((listener) => {
          try {
            listener(multiFileData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'user_correction': {
        const correctionData = message.data as unknown as UserCorrection;
        this.userCorrectionListeners.forEach((listener) => {
          try {
            listener(correctionData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'task_cancelled': {
        const cancelledData = message.data as unknown as TaskCancelled;
        console.log('🚫 任务已取消:', cancelledData.traceId ?? cancelledData.taskId ?? 'unknown');
        this.taskCancelledListeners.forEach((listener) => {
          try {
            listener(cancelledData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'environment_update': {
        const envData = message.data as unknown as EnvironmentUpdate;
        this.environmentUpdateListeners.forEach((listener) => {
          try {
            listener(envData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'project_change': {
        const changeData = message.data as unknown as ProjectChange;
        console.log('📂 项目变更:', changeData.repo, changeData.type);
        this.projectChangeListeners.forEach((listener) => {
          try {
            listener(changeData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'git_status': {
        const gitData = message.data as unknown as GitStatus;
        this.gitStatusListeners.forEach((listener) => {
          try {
            listener(gitData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'stream_start': {
        const streamStartData = message.data as unknown as { traceId?: string; totalLength?: number; timestamp?: number };
        this.streamStartListeners.forEach((listener) => {
          try {
            listener(streamStartData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'stream_chunk': {
        const streamChunkData = message.data as unknown as { traceId?: string; chunk?: string; offset?: number; timestamp?: number };
        this.streamChunkListeners.forEach((listener) => {
          try {
            listener(streamChunkData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      case 'stream_done': {
        const streamDoneData = message.data as unknown as { traceId?: string; fullText?: string; timestamp?: number };
        this.streamDoneListeners.forEach((listener) => {
          try {
            listener(streamDoneData);
          } catch {
            // 静默处理
          }
        });
        break;
      }
      default:
        console.warn(`⚠️ 未知的WebSocket消息类型: ${message.type}`);
        break;
    }
  }

  private updateConnectionState(connected: boolean): void {
    this.currentConnected = connected;
    this.stateListeners.forEach((listener) => listener(connected));
  }

  private updateConnectionStatus(status: ConnectionStatus): void {
    this.currentConnectionStatus = status;
    this.connectionStatusListeners.forEach((listener) => listener(status));
  }

  private updateDialogState(state: DialogStateValue): void {
    this.currentDialogState = state;
    this.dialogStateListeners.forEach((listener) => listener(state));
  }

  send(data: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = {
        ...data,
        traceId: data.traceId || `trace_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`,
        timestamp: data._timestamp || Date.now(),
      };
      console.log(`📤 [WS] 发送消息: type=${data.type}, traceId=${message.traceId}`);
      this.ws.send(JSON.stringify(message));
      return true;
    }

    if (data.type === 'user_input' && this.pendingMessages.length < WebSocketConnectionManager.MAX_PENDING_MESSAGES) {
      const queuedMessage = {
        ...data,
        traceId: data.traceId || `trace_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`,
        timestamp: Date.now(),
      };
      this.pendingMessages.push(queuedMessage);
      console.warn(`📤 [WS] WebSocket未连接，消息已缓存 (队列:${this.pendingMessages.length}), type=${data.type}`);
      return true;
    }

    console.warn(`📤 [WS] 发送失败: WebSocket未连接 (readyState=${this.ws?.readyState})`);
    return false;
  }

  sendProcess(input: string, userId: string = 'default'): boolean {
    return this.send({
      type: 'user_input',
      payload: { input, userId },
    });
  }

  sendMessage(input: string, userId: string = 'default'): boolean {
    return this.send({
      type: 'user_input',
      payload: { input, userId },
    });
  }

  onStateChange(listener: StateChangeListener): void {
    this.stateListeners.add(listener);
    listener(this.currentConnected);
  }

  offStateChange(listener: StateChangeListener): void {
    this.stateListeners.delete(listener);
  }

  onDialogState(listener: DialogStateListener): void {
    this.dialogStateListeners.add(listener);
    listener(this.currentDialogState);
  }

  offDialogState(listener: DialogStateListener): void {
    this.dialogStateListeners.delete(listener);
  }

  onMessage(listener: MessageListener): void {
    this.messageListeners.add(listener);
  }

  offMessage(listener: MessageListener): void {
    this.messageListeners.delete(listener);
  }

  onConnectionStatus(listener: ConnectionStatusListener): void {
    this.connectionStatusListeners.add(listener);
    listener(this.currentConnectionStatus);
  }

  offConnectionStatus(listener: ConnectionStatusListener): void {
    this.connectionStatusListeners.delete(listener);
  }

  onAgentExecution(listener: AgentExecutionListener): void {
    this.agentExecutionListeners.add(listener);
  }

  offAgentExecution(listener: AgentExecutionListener): void {
    this.agentExecutionListeners.delete(listener);
  }

  onPerceptionUpdate(listener: PerceptionUpdateListener): void {
    this.perceptionUpdateListeners.add(listener);
  }

  offPerceptionUpdate(listener: PerceptionUpdateListener): void {
    this.perceptionUpdateListeners.delete(listener);
  }

  onBrainStageUpdate(listener: BrainStageUpdateListener): void {
    this.brainStageUpdateListeners.add(listener);
  }

  offBrainStageUpdate(listener: BrainStageUpdateListener): void {
    this.brainStageUpdateListeners.delete(listener);
  }

  onSkillExecutionUpdate(listener: SkillExecutionUpdateListener): void {
    this.skillExecutionUpdateListeners.add(listener);
  }

  offSkillExecutionUpdate(listener: SkillExecutionUpdateListener): void {
    this.skillExecutionUpdateListeners.delete(listener);
  }

  onEvolutionEvent(listener: EvolutionEventListener): void {
    this.evolutionEventListeners.add(listener);
  }

  offEvolutionEvent(listener: EvolutionEventListener): void {
    this.evolutionEventListeners.delete(listener);
  }

  onClarificationRequest(listener: ClarificationRequestListener): void {
    this.clarificationRequestListeners.add(listener);
  }

  offClarificationRequest(listener: ClarificationRequestListener): void {
    this.clarificationRequestListeners.delete(listener);
  }

  onExecutionPreview(listener: ExecutionPreviewListener): void {
    this.executionPreviewListeners.add(listener);
  }

  offExecutionPreview(listener: ExecutionPreviewListener): void {
    this.executionPreviewListeners.delete(listener);
  }

  onFileModified(listener: FileModifiedListener): void {
    this.fileModifiedListeners.add(listener);
  }

  offFileModified(listener: FileModifiedListener): void {
    this.fileModifiedListeners.delete(listener);
  }

  onToolTrace(listener: ToolTraceListener): void {
    this.toolTraceListeners.add(listener);
  }

  offToolTrace(listener: ToolTraceListener): void {
    this.toolTraceListeners.delete(listener);
  }

  onServerLog(listener: ServerLogListener): void {
    this.serverLogListeners.add(listener);
  }

  offServerLog(listener: ServerLogListener): void {
    this.serverLogListeners.delete(listener);
  }

  onResponseReady(listener: ResponseReadyListener): void {
    this.responseReadyListeners.add(listener);
  }

  offResponseReady(listener: ResponseReadyListener): void {
    this.responseReadyListeners.delete(listener);
  }

  onError(listener: ErrorEventListener): void {
    this.errorListeners.add(listener);
  }

  offError(listener: ErrorEventListener): void {
    this.errorListeners.delete(listener);
  }

  onProactiveMessage(listener: ProactiveMessageListener): void {
    this.proactiveMessageListeners.add(listener);
  }

  offProactiveMessage(listener: ProactiveMessageListener): void {
    this.proactiveMessageListeners.delete(listener);
  }

  onWeightUpdate(listener: WeightUpdateListener): void {
    this.weightUpdateListeners.add(listener);
  }

  offWeightUpdate(listener: WeightUpdateListener): void {
    this.weightUpdateListeners.delete(listener);
  }

  onFileRollback(listener: FileRollbackListener): void {
    this.fileRollbackListeners.add(listener);
  }

  offFileRollback(listener: FileRollbackListener): void {
    this.fileRollbackListeners.delete(listener);
  }

  onMultiFileModified(listener: MultiFileModifiedListener): void {
    this.multiFileModifiedListeners.add(listener);
  }

  offMultiFileModified(listener: MultiFileModifiedListener): void {
    this.multiFileModifiedListeners.delete(listener);
  }

  onUserCorrection(listener: UserCorrectionListener): void {
    this.userCorrectionListeners.add(listener);
  }

  offUserCorrection(listener: UserCorrectionListener): void {
    this.userCorrectionListeners.delete(listener);
  }

  onTaskCancelled(listener: TaskCancelledListener): void {
    this.taskCancelledListeners.add(listener);
  }

  offTaskCancelled(listener: TaskCancelledListener): void {
    this.taskCancelledListeners.delete(listener);
  }

  onEnvironmentUpdate(listener: EnvironmentUpdateListener): void {
    this.environmentUpdateListeners.add(listener);
  }

  offEnvironmentUpdate(listener: EnvironmentUpdateListener): void {
    this.environmentUpdateListeners.delete(listener);
  }

  onProjectChange(listener: ProjectChangeListener): void {
    this.projectChangeListeners.add(listener);
  }

  offProjectChange(listener: ProjectChangeListener): void {
    this.projectChangeListeners.delete(listener);
  }

  onGitStatus(listener: GitStatusListener): void {
    this.gitStatusListeners.add(listener);
  }

  offGitStatus(listener: GitStatusListener): void {
    this.gitStatusListeners.delete(listener);
  }

  onProcessingStatus(listener: (data: { status: string; message: string; traceId?: string }) => void): void {
    this.processingStatusListeners.add(listener);
  }

  offProcessingStatus(listener: (data: { status: string; message: string; traceId?: string }) => void): void {
    this.processingStatusListeners.delete(listener);
  }

  onStreamStart(listener: StreamStartListener): void {
    this.streamStartListeners.add(listener);
  }

  offStreamStart(listener: StreamStartListener): void {
    this.streamStartListeners.delete(listener);
  }

  onStreamChunk(listener: StreamChunkListener): void {
    this.streamChunkListeners.add(listener);
  }

  offStreamChunk(listener: StreamChunkListener): void {
    this.streamChunkListeners.delete(listener);
  }

  onStreamDone(listener: StreamDoneListener): void {
    this.streamDoneListeners.add(listener);
  }

  offStreamDone(listener: StreamDoneListener): void {
    this.streamDoneListeners.delete(listener);
  }

  on(event: string, listener: (data: unknown) => void): () => void {
    const wrapper = (message: WebSocketMessage) => {
      if (message.type === event) {
        listener(message.data);
      }
    };
    this.messageListeners.add(wrapper);
    return () => this.messageListeners.delete(wrapper);
  }

  off(_event: string, _listener: (data: unknown) => void): void {
    // 通用事件移除（保留接口兼容）
  }

  shutdown(): void {
    this.isActive = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = this.maxReconnectAttempts + 1;
    this.cleanupSocket();
    this.updateConnectionState(false);
    this.updateConnectionStatus('disconnected');
    this.updateDialogState('idle');
  }

  isActiveConnection(): boolean {
    return this.isActive && this.currentConnected;
  }

  reconnect(): void {
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.cleanupSocket();
    this.ws = null;
    this.updateConnectionState(false);
    if (this.config && this.isActive) {
      this.connect();
    }
  }

  getConnectionStatus(): ConnectionStatus {
    return this.currentConnectionStatus;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flushPendingMessages(): void {
    if (this.pendingMessages.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const messages = [...this.pendingMessages];
    this.pendingMessages = [];

    for (const msg of messages) {
      try {
        this.ws.send(JSON.stringify(msg));
        console.log(`📤 [WS] 发送缓存消息: type=${msg.type}, traceId=${msg.traceId}`);
      } catch (err) {
        console.error('❌ [WS] 缓存消息发送失败', err);
      }
    }
  }

  private cleanupSocket(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

export const connectionManager = new WebSocketConnectionManager();
export { WebSocketConnectionManager };
