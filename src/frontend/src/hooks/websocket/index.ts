import { useEffect, useRef, useState, useCallback } from 'react';
import { connectionManager } from './WebSocketConnectionManager';
import {
  UseWebSocketOptions,
  WebSocketState,
  WebSocketMessage,
  ConnectionStatus,
  DialogStateValue,
  AgentExecutionUpdate,
  PerceptionUpdate,
  BrainStageUpdate,
  SkillExecutionUpdate,
  EvolutionEvent,
  ClarificationRequest,
  ExecutionPreview,
  FileModifiedEvent,
  ToolTraceEvent,
  ServerLogEntry,
  ErrorEvent,
  ProactiveMessage,
  WeightUpdate,
  FileRollback,
  MultiFileModified,
  UserCorrection,
} from './types';

const DEFAULT_WS_URL = `ws://localhost:3111`;

export function useWebSocket(options: UseWebSocketOptions = {}): WebSocketState & {
  sendMessage: (input: string, userId?: string) => boolean;
  send: (data: Record<string, unknown>) => boolean;
} {
  const {
    url = DEFAULT_WS_URL,
    onMessage,
    onConnectionChange,
    onConnectionStatusChange,
    onDialogStateChange,
    onAgentExecutionUpdate,
    onPerceptionUpdate,
    onBrainStageUpdate,
    onSkillExecutionUpdate,
    onEvolutionEvent,
    onClarificationRequest,
    onExecutionPreview,
    onFileModified,
    onToolTrace,
    onServerLog,
    onResponseReady,
    onError,
    onProactiveMessage,
    onWeightUpdate,
    onFileRollback,
    onMultiFileModified,
    onUserCorrection,
  } = options;

  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [dialogState, setDialogState] = useState<DialogStateValue>('idle');
  const [messages, setMessages] = useState<WebSocketMessage[]>([]);
  const [agentExecutions, setAgentExecutions] = useState<AgentExecutionUpdate[]>([]);
  const [perceptionUpdates, setPerceptionUpdates] = useState<PerceptionUpdate[]>([]);
  const [brainStageUpdates, setBrainStageUpdates] = useState<BrainStageUpdate[]>([]);
  const [skillExecutions, setSkillExecutions] = useState<SkillExecutionUpdate[]>([]);
  const [evolutionEvents, setEvolutionEvents] = useState<EvolutionEvent[]>([]);
  const [clarificationRequests, setClarificationRequests] = useState<ClarificationRequest[]>([]);
  const [executionPreviews, setExecutionPreviews] = useState<ExecutionPreview[]>([]);
  const [fileModifiedEvents, setFileModifiedEvents] = useState<FileModifiedEvent[]>([]);
  const [toolTraces, setToolTraces] = useState<ToolTraceEvent[]>([]);
  const [errors, setErrors] = useState<ErrorEvent[]>([]);
  const [proactiveMessages, setProactiveMessages] = useState<ProactiveMessage[]>([]);
  const [weightUpdates, setWeightUpdates] = useState<WeightUpdate[]>([]);
  const [fileRollbacks, setFileRollbacks] = useState<FileRollback[]>([]);
  const [multiFileModifiedEvents, setMultiFileModifiedEvents] = useState<MultiFileModified[]>([]);
  const [userCorrections, setUserCorrections] = useState<UserCorrection[]>([]);

  const cleanupRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    connectionManager.initialize({ url });

    const handleStateChange = (newConnected: boolean) => {
      setConnected(newConnected);
      onConnectionChange?.(newConnected);
    };

    const handleConnectionStatus = (status: ConnectionStatus) => {
      setConnectionStatus(status);
      onConnectionStatusChange?.(status);
    };

    const handleDialogState = (state: DialogStateValue) => {
      setDialogState(state);
      onDialogStateChange?.(state);
    };

    const handleMessage = (message: WebSocketMessage) => {
      setMessages((prev) => [...prev.slice(-99), message]);
      onMessage?.(message);
    };

    const handleAgentExecution = (update: AgentExecutionUpdate) => {
      setAgentExecutions((prev) => [...prev.slice(-19), update]);
      onAgentExecutionUpdate?.(update);
    };

    const handlePerceptionUpdate = (update: PerceptionUpdate) => {
      setPerceptionUpdates((prev) => [...prev.slice(-19), update]);
      onPerceptionUpdate?.(update);
    };

    const handleBrainStageUpdate = (update: BrainStageUpdate) => {
      setBrainStageUpdates((prev) => [...prev.slice(-19), update]);
      onBrainStageUpdate?.(update);
    };

    const handleSkillExecution = (update: SkillExecutionUpdate) => {
      setSkillExecutions((prev) => [...prev.slice(-19), update]);
      onSkillExecutionUpdate?.(update);
    };

    const handleEvolutionEvent = (event: EvolutionEvent) => {
      setEvolutionEvents((prev) => [...prev.slice(-49), event]);
      onEvolutionEvent?.(event);
    };

    const handleClarificationRequest = (request: ClarificationRequest) => {
      setClarificationRequests((prev) => [...prev.slice(-9), request]);
      onClarificationRequest?.(request);
    };

    const handleExecutionPreview = (preview: ExecutionPreview) => {
      setExecutionPreviews((prev) => [...prev.slice(-9), preview]);
      onExecutionPreview?.(preview);
    };

    const handleFileModified = (event: FileModifiedEvent) => {
      setFileModifiedEvents((prev) => [...prev.slice(-19), event]);
      onFileModified?.(event);
    };

    const handleToolTrace = (event: ToolTraceEvent) => {
      setToolTraces((prev) => [...prev.slice(-49), event]);
      onToolTrace?.(event);
    };

    const handleServerLog = (entry: ServerLogEntry) => {
      onServerLog?.(entry);
    };

    const handleResponseReady = (response: unknown, traceId?: string) => {
      onResponseReady?.(response, traceId);
    };

    const handleError = (error: ErrorEvent) => {
      setErrors((prev) => [...prev.slice(-9), error]);
      onError?.(error);
    };

    const handleProactiveMessage = (message: ProactiveMessage) => {
      setProactiveMessages((prev) => [...prev.slice(-9), message]);
      onProactiveMessage?.(message);
    };

    const handleWeightUpdate = (update: WeightUpdate) => {
      setWeightUpdates((prev) => [...prev.slice(-19), update]);
      onWeightUpdate?.(update);
    };

    const handleFileRollback = (event: FileRollback) => {
      setFileRollbacks((prev) => [...prev.slice(-9), event]);
      onFileRollback?.(event);
    };

    const handleMultiFileModified = (event: MultiFileModified) => {
      setMultiFileModifiedEvents((prev) => [...prev.slice(-9), event]);
      onMultiFileModified?.(event);
    };

    const handleUserCorrection = (data: UserCorrection) => {
      setUserCorrections((prev) => [...prev.slice(-9), data]);
      onUserCorrection?.(data);
    };

    connectionManager.onStateChange(handleStateChange);
    connectionManager.onConnectionStatus(handleConnectionStatus);
    connectionManager.onDialogState(handleDialogState);
    connectionManager.onMessage(handleMessage);
    connectionManager.onAgentExecution(handleAgentExecution);
    connectionManager.onPerceptionUpdate(handlePerceptionUpdate);
    connectionManager.onBrainStageUpdate(handleBrainStageUpdate);
    connectionManager.onSkillExecutionUpdate(handleSkillExecution);
    connectionManager.onEvolutionEvent(handleEvolutionEvent);
    connectionManager.onClarificationRequest(handleClarificationRequest);
    connectionManager.onExecutionPreview(handleExecutionPreview);
    connectionManager.onFileModified(handleFileModified);
    connectionManager.onToolTrace(handleToolTrace);
    connectionManager.onServerLog(handleServerLog);
    connectionManager.onResponseReady(handleResponseReady);
    connectionManager.onError(handleError);
    connectionManager.onProactiveMessage(handleProactiveMessage);
    connectionManager.onWeightUpdate(handleWeightUpdate);
    connectionManager.onFileRollback(handleFileRollback);
    connectionManager.onMultiFileModified(handleMultiFileModified);
    connectionManager.onUserCorrection(handleUserCorrection);

    cleanupRef.current = [
      () => connectionManager.offStateChange(handleStateChange),
      () => connectionManager.offConnectionStatus(handleConnectionStatus),
      () => connectionManager.offDialogState(handleDialogState),
      () => connectionManager.offMessage(handleMessage),
      () => connectionManager.offAgentExecution(handleAgentExecution),
      () => connectionManager.offPerceptionUpdate(handlePerceptionUpdate),
      () => connectionManager.offBrainStageUpdate(handleBrainStageUpdate),
      () => connectionManager.offSkillExecutionUpdate(handleSkillExecution),
      () => connectionManager.offEvolutionEvent(handleEvolutionEvent),
      () => connectionManager.offClarificationRequest(handleClarificationRequest),
      () => connectionManager.offExecutionPreview(handleExecutionPreview),
      () => connectionManager.offFileModified(handleFileModified),
      () => connectionManager.offToolTrace(handleToolTrace),
      () => connectionManager.offServerLog(handleServerLog),
      () => connectionManager.offResponseReady(handleResponseReady),
      () => connectionManager.offError(handleError),
      () => connectionManager.offProactiveMessage(handleProactiveMessage),
      () => connectionManager.offWeightUpdate(handleWeightUpdate),
      () => connectionManager.offFileRollback(handleFileRollback),
      () => connectionManager.offMultiFileModified(handleMultiFileModified),
      () => connectionManager.offUserCorrection(handleUserCorrection),
    ];

    return () => {
      cleanupRef.current.forEach((cleanup) => cleanup());
    };
  }, [url]);

  const sendMessage = useCallback((input: string, userId: string = 'default') => {
    return connectionManager.sendMessage(input, userId);
  }, []);

  const send = useCallback((data: Record<string, unknown>) => {
    return connectionManager.send(data);
  }, []);

  return {
    connected,
    isConnected: connected,
    connectionStatus,
    dialogState,
    messages,
    agentExecutions,
    perceptionUpdates,
    brainStageUpdates,
    skillExecutions,
    evolutionEvents,
    clarificationRequests,
    executionPreviews,
    fileModifiedEvents,
    toolTraces,
    errors,
    proactiveMessages,
    weightUpdates,
    fileRollbacks,
    multiFileModifiedEvents,
    userCorrections,
    sendMessage,
    send,
  };
}

export { connectionManager } from './WebSocketConnectionManager';
export * from './types';
