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
  TaskCancelled,
  EnvironmentUpdate,
  ProjectChange,
  GitStatus,
} from './types';

const DEFAULT_WS_URL = `ws://localhost:3111`;

export function useWebSocket(options: UseWebSocketOptions = {}): WebSocketState & {
  sendMessage: (input: string, userId?: string) => boolean;
  send: (data: Record<string, unknown>) => boolean;
  reconnect: () => void;
} {
  const { url = DEFAULT_WS_URL } = options;

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
  const [taskCancelledEvents, setTaskCancelledEvents] = useState<TaskCancelled[]>([]);
  const [environmentUpdates, setEnvironmentUpdates] = useState<EnvironmentUpdate[]>([]);
  const [projectChanges, setProjectChanges] = useState<ProjectChange[]>([]);
  const [gitStatuses, setGitStatuses] = useState<GitStatus[]>([]);

  const cleanupRef = useRef<(() => void)[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    connectionManager.initialize({ url });

    const handleStateChange = (newConnected: boolean) => {
      setConnected(newConnected);
      optionsRef.current.onConnectionChange?.(newConnected);
    };

    const handleConnectionStatus = (status: ConnectionStatus) => {
      setConnectionStatus(status);
      optionsRef.current.onConnectionStatusChange?.(status);
    };

    const handleDialogState = (state: DialogStateValue) => {
      setDialogState(state);
      optionsRef.current.onDialogStateChange?.(state);
    };

    const handleMessage = (message: WebSocketMessage) => {
      setMessages((prev) => [...prev.slice(-99), message]);
      optionsRef.current.onMessage?.(message);
    };

    const handleAgentExecution = (update: AgentExecutionUpdate) => {
      setAgentExecutions((prev) => [...prev.slice(-19), update]);
      optionsRef.current.onAgentExecutionUpdate?.(update);
    };

    const handlePerceptionUpdate = (update: PerceptionUpdate) => {
      setPerceptionUpdates((prev) => [...prev.slice(-19), update]);
      optionsRef.current.onPerceptionUpdate?.(update);
    };

    const handleBrainStageUpdate = (update: BrainStageUpdate) => {
      setBrainStageUpdates((prev) => [...prev.slice(-19), update]);
      optionsRef.current.onBrainStageUpdate?.(update);
    };

    const handleSkillExecution = (update: SkillExecutionUpdate) => {
      setSkillExecutions((prev) => [...prev.slice(-19), update]);
      optionsRef.current.onSkillExecutionUpdate?.(update);
    };

    const handleEvolutionEvent = (event: EvolutionEvent) => {
      setEvolutionEvents((prev) => [...prev.slice(-49), event]);
      optionsRef.current.onEvolutionEvent?.(event);
    };

    const handleClarificationRequest = (request: ClarificationRequest) => {
      setClarificationRequests((prev) => [...prev.slice(-9), request]);
      optionsRef.current.onClarificationRequest?.(request);
    };

    const handleExecutionPreview = (preview: ExecutionPreview) => {
      setExecutionPreviews((prev) => [...prev.slice(-9), preview]);
      optionsRef.current.onExecutionPreview?.(preview);
    };

    const handleFileModified = (event: FileModifiedEvent) => {
      setFileModifiedEvents((prev) => [...prev.slice(-19), event]);
      optionsRef.current.onFileModified?.(event);
    };

    const handleToolTrace = (event: ToolTraceEvent) => {
      setToolTraces((prev) => [...prev.slice(-49), event]);
      optionsRef.current.onToolTrace?.(event);
    };

    const handleServerLog = (entry: ServerLogEntry) => {
      optionsRef.current.onServerLog?.(entry);
    };

    const handleResponseReady = (response: unknown, traceId?: string) => {
      optionsRef.current.onResponseReady?.(response, traceId);
    };

    const handleError = (error: ErrorEvent) => {
      setErrors((prev) => [...prev.slice(-9), error]);
      optionsRef.current.onError?.(error);
    };

    const handleProactiveMessage = (message: ProactiveMessage) => {
      setProactiveMessages((prev) => [...prev.slice(-9), message]);
      optionsRef.current.onProactiveMessage?.(message);
    };

    const handleWeightUpdate = (update: WeightUpdate) => {
      setWeightUpdates((prev) => [...prev.slice(-19), update]);
      optionsRef.current.onWeightUpdate?.(update);
    };

    const handleFileRollback = (event: FileRollback) => {
      setFileRollbacks((prev) => [...prev.slice(-9), event]);
      optionsRef.current.onFileRollback?.(event);
    };

    const handleMultiFileModified = (event: MultiFileModified) => {
      setMultiFileModifiedEvents((prev) => [...prev.slice(-9), event]);
      optionsRef.current.onMultiFileModified?.(event);
    };

    const handleUserCorrection = (data: UserCorrection) => {
      setUserCorrections((prev) => [...prev.slice(-9), data]);
      optionsRef.current.onUserCorrection?.(data);
    };

    const handleProcessingStatus = (data: { status: string; message: string; traceId?: string }) => {
      optionsRef.current.onProcessingStatus?.(data);
    };

    const handleTaskCancelled = (data: TaskCancelled) => {
      setTaskCancelledEvents((prev) => [...prev.slice(-9), data]);
      optionsRef.current.onTaskCancelled?.(data);
    };

    const handleEnvironmentUpdate = (data: EnvironmentUpdate) => {
      setEnvironmentUpdates((prev) => [...prev.slice(-19), data]);
      optionsRef.current.onEnvironmentUpdate?.(data);
    };

    const handleProjectChange = (data: ProjectChange) => {
      setProjectChanges((prev) => [...prev.slice(-19), data]);
      optionsRef.current.onProjectChange?.(data);
    };

    const handleGitStatus = (data: GitStatus) => {
      setGitStatuses((prev) => [...prev.slice(-9), data]);
      optionsRef.current.onGitStatus?.(data);
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
    connectionManager.onProcessingStatus(handleProcessingStatus);
    connectionManager.onTaskCancelled(handleTaskCancelled);
    connectionManager.onEnvironmentUpdate(handleEnvironmentUpdate);
    connectionManager.onProjectChange(handleProjectChange);
    connectionManager.onGitStatus(handleGitStatus);

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
      () => connectionManager.offProcessingStatus(handleProcessingStatus),
      () => connectionManager.offTaskCancelled(handleTaskCancelled),
      () => connectionManager.offEnvironmentUpdate(handleEnvironmentUpdate),
      () => connectionManager.offProjectChange(handleProjectChange),
      () => connectionManager.offGitStatus(handleGitStatus),
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

  const reconnect = useCallback(() => {
    connectionManager.reconnect();
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
    taskCancelledEvents,
    environmentUpdates,
    projectChanges,
    gitStatuses,
    sendMessage,
    send,
    reconnect,
  };
}

export { connectionManager } from './WebSocketConnectionManager';
export * from './types';
