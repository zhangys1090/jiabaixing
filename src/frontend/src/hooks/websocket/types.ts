/**
 * WebSocket 类型定义
 * 所有事件类型和数据格式引用共享契约层 contracts.ts
 */

import {
  ConnectionStatus as ContractConnectionStatus,
  DialogStateValue as ContractDialogStateValue,
  WsAgentExecutionUpdateData,
  WsBrainStageUpdateData,
  WsClarificationRequestData,
  WsErrorData,
  WsEvolutionEventData,
  WsExecutionPreviewData,
  WsFileModifiedData,
  WsPerceptionUpdateData,
  WsProactiveMessageData,
  WsServerLogData,
  WsSkillExecutionUpdateData,
  WsToolTraceData,
  WsWeightUpdateData,
  WS_EVENTS,
  WsServerEventType,
} from '@shared/contracts';

export type ConnectionStatus = ContractConnectionStatus;
export type DialogStateValue = ContractDialogStateValue;

export interface ASRResult {
  text: string;
  confidence: number;
  timestamp: number;
}

export interface TTSChunk {
  audio: string;
  isLast: boolean;
  timestamp: number;
}

export interface DialogState {
  state: DialogStateValue;
  round: number;
  timestamp: number;
}

export type AgentExecutionUpdate = WsAgentExecutionUpdateData;
export type PerceptionUpdate = WsPerceptionUpdateData;
export type BrainStageUpdate = WsBrainStageUpdateData;
export type SkillExecutionUpdate = WsSkillExecutionUpdateData;
export type EvolutionEvent = WsEvolutionEventData;
export type ClarificationRequest = WsClarificationRequestData;
export type ExecutionPreview = WsExecutionPreviewData;
export type FileModifiedEvent = WsFileModifiedData;
export type ToolTraceEvent = WsToolTraceData;
export type ServerLogEntry = WsServerLogData;
export type ErrorEvent = WsErrorData;
export type ProactiveMessage = WsProactiveMessageData;
export type WeightUpdate = WsWeightUpdateData;
export type FileRollback = {
  traceId?: string;
  filePath?: string;
  success?: boolean;
  timestamp?: number;
};
export type MultiFileModified = {
  traceId?: string;
  files?: Array<{ path: string; changeType: string }>;
  timestamp?: number;
};
export type UserCorrection = unknown;

export interface WebSocketMessage {
  type: WsServerEventType;
  data?: Record<string, unknown>;
  traceId?: string;
  timestamp?: number;
}

export interface ConnectionConfig {
  url: string;
  onServerLog?: (entry: ServerLogEntry) => void;
}

export type StateChangeListener = (connected: boolean) => void;
export type DialogStateListener = (state: DialogStateValue) => void;
export type MessageListener = (message: WebSocketMessage) => void;
export type ConnectionStatusListener = (status: ConnectionStatus) => void;
export type AgentExecutionListener = (update: AgentExecutionUpdate) => void;
export type PerceptionUpdateListener = (update: PerceptionUpdate) => void;
export type BrainStageUpdateListener = (update: BrainStageUpdate) => void;
export type SkillExecutionUpdateListener = (update: SkillExecutionUpdate) => void;
export type EvolutionEventListener = (event: EvolutionEvent) => void;
export type ClarificationRequestListener = (request: ClarificationRequest) => void;
export type ExecutionPreviewListener = (preview: ExecutionPreview) => void;
export type FileModifiedListener = (event: FileModifiedEvent) => void;
export type ToolTraceListener = (event: ToolTraceEvent) => void;
export type ErrorEventListener = (error: ErrorEvent) => void;
export type ProactiveMessageListener = (message: ProactiveMessage) => void;
export type WeightUpdateListener = (update: WeightUpdate) => void;
export type FileRollbackListener = (event: FileRollback) => void;
export type MultiFileModifiedListener = (event: MultiFileModified) => void;
export type UserCorrectionListener = (data: UserCorrection) => void;

export interface UseWebSocketOptions {
  url?: string;
  onMessage?: (message: WebSocketMessage) => void;
  onConnectionChange?: (connected: boolean) => void;
  onConnectionStatusChange?: (status: ConnectionStatus) => void;
  onDialogStateChange?: (state: DialogStateValue) => void;
  onAgentExecutionUpdate?: (update: AgentExecutionUpdate) => void;
  onPerceptionUpdate?: (update: PerceptionUpdate) => void;
  onBrainStageUpdate?: (update: BrainStageUpdate) => void;
  onSkillExecutionUpdate?: (update: SkillExecutionUpdate) => void;
  onEvolutionEvent?: (event: EvolutionEvent) => void;
  onClarificationRequest?: (request: ClarificationRequest) => void;
  onExecutionPreview?: (preview: ExecutionPreview) => void;
  onFileModified?: (event: FileModifiedEvent) => void;
  onToolTrace?: (event: ToolTraceEvent) => void;
  onServerLog?: (entry: ServerLogEntry) => void;
  onResponseReady?: (response: unknown, traceId?: string) => void;
  onError?: (error: ErrorEvent) => void;
  onProactiveMessage?: (message: ProactiveMessage) => void;
  onWeightUpdate?: (update: WeightUpdate) => void;
  onFileRollback?: (event: FileRollback) => void;
  onMultiFileModified?: (event: MultiFileModified) => void;
  onUserCorrection?: (data: UserCorrection) => void;
}

export interface WebSocketState {
  connected: boolean;
  isConnected: boolean;
  connectionStatus: ConnectionStatus;
  dialogState: DialogStateValue;
  messages: WebSocketMessage[];
  agentExecutions: AgentExecutionUpdate[];
  perceptionUpdates: PerceptionUpdate[];
  brainStageUpdates: BrainStageUpdate[];
  skillExecutions: SkillExecutionUpdate[];
  evolutionEvents: EvolutionEvent[];
  clarificationRequests: ClarificationRequest[];
  executionPreviews: ExecutionPreview[];
  fileModifiedEvents: FileModifiedEvent[];
  toolTraces: ToolTraceEvent[];
  errors: ErrorEvent[];
  proactiveMessages: ProactiveMessage[];
  weightUpdates: WeightUpdate[];
  fileRollbacks: FileRollback[];
  multiFileModifiedEvents: MultiFileModified[];
  userCorrections: UserCorrection[];
}

export type { WS_EVENTS, WsServerEventType };
