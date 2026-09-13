"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectionManager = void 0;
exports.useWebSocket = useWebSocket;
const react_1 = require("react");
const WebSocketConnectionManager_1 = require("./WebSocketConnectionManager");
const DEFAULT_WS_URL = `ws://localhost:3111`;
function useWebSocket(options = {}) {
    const { url = DEFAULT_WS_URL } = options;
    const [connected, setConnected] = (0, react_1.useState)(false);
    const [connectionStatus, setConnectionStatus] = (0, react_1.useState)('disconnected');
    const [dialogState, setDialogState] = (0, react_1.useState)('idle');
    const [messages, setMessages] = (0, react_1.useState)([]);
    const [agentExecutions, setAgentExecutions] = (0, react_1.useState)([]);
    const [perceptionUpdates, setPerceptionUpdates] = (0, react_1.useState)([]);
    const [brainStageUpdates, setBrainStageUpdates] = (0, react_1.useState)([]);
    const [skillExecutions, setSkillExecutions] = (0, react_1.useState)([]);
    const [evolutionEvents, setEvolutionEvents] = (0, react_1.useState)([]);
    const [clarificationRequests, setClarificationRequests] = (0, react_1.useState)([]);
    const [executionPreviews, setExecutionPreviews] = (0, react_1.useState)([]);
    const [fileModifiedEvents, setFileModifiedEvents] = (0, react_1.useState)([]);
    const [toolTraces, setToolTraces] = (0, react_1.useState)([]);
    const [errors, setErrors] = (0, react_1.useState)([]);
    const [proactiveMessages, setProactiveMessages] = (0, react_1.useState)([]);
    const [weightUpdates, setWeightUpdates] = (0, react_1.useState)([]);
    const [fileRollbacks, setFileRollbacks] = (0, react_1.useState)([]);
    const [multiFileModifiedEvents, setMultiFileModifiedEvents] = (0, react_1.useState)([]);
    const [userCorrections, setUserCorrections] = (0, react_1.useState)([]);
    const [taskCancelledEvents, setTaskCancelledEvents] = (0, react_1.useState)([]);
    const [environmentUpdates, setEnvironmentUpdates] = (0, react_1.useState)([]);
    const [projectChanges, setProjectChanges] = (0, react_1.useState)([]);
    const [gitStatuses, setGitStatuses] = (0, react_1.useState)([]);
    const cleanupRef = (0, react_1.useRef)([]);
    const optionsRef = (0, react_1.useRef)(options);
    optionsRef.current = options;
    (0, react_1.useEffect)(() => {
        WebSocketConnectionManager_1.connectionManager.initialize({ url });
        const handleStateChange = (newConnected) => {
            setConnected(newConnected);
            optionsRef.current.onConnectionChange?.(newConnected);
        };
        const handleConnectionStatus = (status) => {
            setConnectionStatus(status);
            optionsRef.current.onConnectionStatusChange?.(status);
        };
        const handleDialogState = (state) => {
            setDialogState(state);
            optionsRef.current.onDialogStateChange?.(state);
        };
        const handleMessage = (message) => {
            setMessages((prev) => [...prev.slice(-99), message]);
            optionsRef.current.onMessage?.(message);
        };
        const handleAgentExecution = (update) => {
            setAgentExecutions((prev) => [...prev.slice(-19), update]);
            optionsRef.current.onAgentExecutionUpdate?.(update);
        };
        const handlePerceptionUpdate = (update) => {
            setPerceptionUpdates((prev) => [...prev.slice(-19), update]);
            optionsRef.current.onPerceptionUpdate?.(update);
        };
        const handleBrainStageUpdate = (update) => {
            setBrainStageUpdates((prev) => [...prev.slice(-19), update]);
            optionsRef.current.onBrainStageUpdate?.(update);
        };
        const handleSkillExecution = (update) => {
            setSkillExecutions((prev) => [...prev.slice(-19), update]);
            optionsRef.current.onSkillExecutionUpdate?.(update);
        };
        const handleEvolutionEvent = (event) => {
            setEvolutionEvents((prev) => [...prev.slice(-49), event]);
            optionsRef.current.onEvolutionEvent?.(event);
        };
        const handleClarificationRequest = (request) => {
            setClarificationRequests((prev) => [...prev.slice(-9), request]);
            optionsRef.current.onClarificationRequest?.(request);
        };
        const handleExecutionPreview = (preview) => {
            setExecutionPreviews((prev) => [...prev.slice(-9), preview]);
            optionsRef.current.onExecutionPreview?.(preview);
        };
        const handleFileModified = (event) => {
            setFileModifiedEvents((prev) => [...prev.slice(-19), event]);
            optionsRef.current.onFileModified?.(event);
        };
        const handleToolTrace = (event) => {
            setToolTraces((prev) => [...prev.slice(-49), event]);
            optionsRef.current.onToolTrace?.(event);
        };
        const handleServerLog = (entry) => {
            optionsRef.current.onServerLog?.(entry);
        };
        const handleResponseReady = (response, traceId) => {
            optionsRef.current.onResponseReady?.(response, traceId);
        };
        const handleError = (error) => {
            setErrors((prev) => [...prev.slice(-9), error]);
            optionsRef.current.onError?.(error);
        };
        const handleProactiveMessage = (message) => {
            setProactiveMessages((prev) => [...prev.slice(-9), message]);
            optionsRef.current.onProactiveMessage?.(message);
        };
        const handleWeightUpdate = (update) => {
            setWeightUpdates((prev) => [...prev.slice(-19), update]);
            optionsRef.current.onWeightUpdate?.(update);
        };
        const handleFileRollback = (event) => {
            setFileRollbacks((prev) => [...prev.slice(-9), event]);
            optionsRef.current.onFileRollback?.(event);
        };
        const handleMultiFileModified = (event) => {
            setMultiFileModifiedEvents((prev) => [...prev.slice(-9), event]);
            optionsRef.current.onMultiFileModified?.(event);
        };
        const handleUserCorrection = (data) => {
            setUserCorrections((prev) => [...prev.slice(-9), data]);
            optionsRef.current.onUserCorrection?.(data);
        };
        const handleProcessingStatus = (data) => {
            optionsRef.current.onProcessingStatus?.(data);
        };
        const handleTaskCancelled = (data) => {
            setTaskCancelledEvents((prev) => [...prev.slice(-9), data]);
            optionsRef.current.onTaskCancelled?.(data);
        };
        const handleEnvironmentUpdate = (data) => {
            setEnvironmentUpdates((prev) => [...prev.slice(-19), data]);
            optionsRef.current.onEnvironmentUpdate?.(data);
        };
        const handleProjectChange = (data) => {
            setProjectChanges((prev) => [...prev.slice(-19), data]);
            optionsRef.current.onProjectChange?.(data);
        };
        const handleGitStatus = (data) => {
            setGitStatuses((prev) => [...prev.slice(-9), data]);
            optionsRef.current.onGitStatus?.(data);
        };
        const handleStreamStart = (data) => {
            optionsRef.current.onStreamStart?.(data);
        };
        const handleStreamChunk = (data) => {
            optionsRef.current.onStreamChunk?.(data);
        };
        const handleStreamDone = (data) => {
            optionsRef.current.onStreamDone?.(data);
        };
        const handleAgentProgress = (data) => {
            optionsRef.current.onAgentProgress?.(data);
        };
        WebSocketConnectionManager_1.connectionManager.onStateChange(handleStateChange);
        WebSocketConnectionManager_1.connectionManager.onConnectionStatus(handleConnectionStatus);
        WebSocketConnectionManager_1.connectionManager.onDialogState(handleDialogState);
        WebSocketConnectionManager_1.connectionManager.onMessage(handleMessage);
        WebSocketConnectionManager_1.connectionManager.onAgentExecution(handleAgentExecution);
        WebSocketConnectionManager_1.connectionManager.onPerceptionUpdate(handlePerceptionUpdate);
        WebSocketConnectionManager_1.connectionManager.onBrainStageUpdate(handleBrainStageUpdate);
        WebSocketConnectionManager_1.connectionManager.onSkillExecutionUpdate(handleSkillExecution);
        WebSocketConnectionManager_1.connectionManager.onEvolutionEvent(handleEvolutionEvent);
        WebSocketConnectionManager_1.connectionManager.onClarificationRequest(handleClarificationRequest);
        WebSocketConnectionManager_1.connectionManager.onExecutionPreview(handleExecutionPreview);
        WebSocketConnectionManager_1.connectionManager.onFileModified(handleFileModified);
        WebSocketConnectionManager_1.connectionManager.onToolTrace(handleToolTrace);
        WebSocketConnectionManager_1.connectionManager.onServerLog(handleServerLog);
        WebSocketConnectionManager_1.connectionManager.onResponseReady(handleResponseReady);
        WebSocketConnectionManager_1.connectionManager.onError(handleError);
        WebSocketConnectionManager_1.connectionManager.onProactiveMessage(handleProactiveMessage);
        WebSocketConnectionManager_1.connectionManager.onWeightUpdate(handleWeightUpdate);
        WebSocketConnectionManager_1.connectionManager.onFileRollback(handleFileRollback);
        WebSocketConnectionManager_1.connectionManager.onMultiFileModified(handleMultiFileModified);
        WebSocketConnectionManager_1.connectionManager.onUserCorrection(handleUserCorrection);
        WebSocketConnectionManager_1.connectionManager.onProcessingStatus(handleProcessingStatus);
        WebSocketConnectionManager_1.connectionManager.onTaskCancelled(handleTaskCancelled);
        WebSocketConnectionManager_1.connectionManager.onEnvironmentUpdate(handleEnvironmentUpdate);
        WebSocketConnectionManager_1.connectionManager.onProjectChange(handleProjectChange);
        WebSocketConnectionManager_1.connectionManager.onGitStatus(handleGitStatus);
        WebSocketConnectionManager_1.connectionManager.onStreamStart(handleStreamStart);
        WebSocketConnectionManager_1.connectionManager.onStreamChunk(handleStreamChunk);
        WebSocketConnectionManager_1.connectionManager.onStreamDone(handleStreamDone);
        WebSocketConnectionManager_1.connectionManager.onAgentProgress(handleAgentProgress);
        cleanupRef.current = [
            () => WebSocketConnectionManager_1.connectionManager.offStateChange(handleStateChange),
            () => WebSocketConnectionManager_1.connectionManager.offConnectionStatus(handleConnectionStatus),
            () => WebSocketConnectionManager_1.connectionManager.offDialogState(handleDialogState),
            () => WebSocketConnectionManager_1.connectionManager.offMessage(handleMessage),
            () => WebSocketConnectionManager_1.connectionManager.offAgentExecution(handleAgentExecution),
            () => WebSocketConnectionManager_1.connectionManager.offPerceptionUpdate(handlePerceptionUpdate),
            () => WebSocketConnectionManager_1.connectionManager.offBrainStageUpdate(handleBrainStageUpdate),
            () => WebSocketConnectionManager_1.connectionManager.offSkillExecutionUpdate(handleSkillExecution),
            () => WebSocketConnectionManager_1.connectionManager.offEvolutionEvent(handleEvolutionEvent),
            () => WebSocketConnectionManager_1.connectionManager.offClarificationRequest(handleClarificationRequest),
            () => WebSocketConnectionManager_1.connectionManager.offExecutionPreview(handleExecutionPreview),
            () => WebSocketConnectionManager_1.connectionManager.offFileModified(handleFileModified),
            () => WebSocketConnectionManager_1.connectionManager.offToolTrace(handleToolTrace),
            () => WebSocketConnectionManager_1.connectionManager.offServerLog(handleServerLog),
            () => WebSocketConnectionManager_1.connectionManager.offResponseReady(handleResponseReady),
            () => WebSocketConnectionManager_1.connectionManager.offError(handleError),
            () => WebSocketConnectionManager_1.connectionManager.offProactiveMessage(handleProactiveMessage),
            () => WebSocketConnectionManager_1.connectionManager.offWeightUpdate(handleWeightUpdate),
            () => WebSocketConnectionManager_1.connectionManager.offFileRollback(handleFileRollback),
            () => WebSocketConnectionManager_1.connectionManager.offMultiFileModified(handleMultiFileModified),
            () => WebSocketConnectionManager_1.connectionManager.offUserCorrection(handleUserCorrection),
            () => WebSocketConnectionManager_1.connectionManager.offProcessingStatus(handleProcessingStatus),
            () => WebSocketConnectionManager_1.connectionManager.offTaskCancelled(handleTaskCancelled),
            () => WebSocketConnectionManager_1.connectionManager.offEnvironmentUpdate(handleEnvironmentUpdate),
            () => WebSocketConnectionManager_1.connectionManager.offProjectChange(handleProjectChange),
            () => WebSocketConnectionManager_1.connectionManager.offGitStatus(handleGitStatus),
            () => WebSocketConnectionManager_1.connectionManager.offStreamStart(handleStreamStart),
            () => WebSocketConnectionManager_1.connectionManager.offStreamChunk(handleStreamChunk),
            () => WebSocketConnectionManager_1.connectionManager.offStreamDone(handleStreamDone),
            () => WebSocketConnectionManager_1.connectionManager.offAgentProgress(handleAgentProgress),
        ];
        return () => {
            cleanupRef.current.forEach((cleanup) => cleanup());
        };
    }, [url]);
    const sendMessage = (0, react_1.useCallback)((input, userId = 'default') => {
        return WebSocketConnectionManager_1.connectionManager.sendMessage(input, userId);
    }, []);
    const send = (0, react_1.useCallback)((data) => {
        return WebSocketConnectionManager_1.connectionManager.send(data);
    }, []);
    const reconnect = (0, react_1.useCallback)(() => {
        WebSocketConnectionManager_1.connectionManager.reconnect();
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
var WebSocketConnectionManager_2 = require("./WebSocketConnectionManager");
Object.defineProperty(exports, "connectionManager", { enumerable: true, get: function () { return WebSocketConnectionManager_2.connectionManager; } });
__exportStar(require("./types"), exports);
