"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketConnectionManager = exports.connectionManager = void 0;
const contracts_1 = require("@shared/contracts");
const logger_1 = require("../../utils/logger");
class WebSocketConnectionManager {
    static log = (0, logger_1.createLogger)('WebSocket');
    ws = null;
    config = null;
    reconnectTimer = null;
    reconnectAttempts = 0;
    maxReconnectAttempts = 50;
    isActive = false;
    stateListeners = new Set();
    dialogStateListeners = new Set();
    messageListeners = new Set();
    connectionStatusListeners = new Set();
    agentExecutionListeners = new Set();
    perceptionUpdateListeners = new Set();
    brainStageUpdateListeners = new Set();
    skillExecutionUpdateListeners = new Set();
    evolutionEventListeners = new Set();
    clarificationRequestListeners = new Set();
    executionPreviewListeners = new Set();
    fileModifiedListeners = new Set();
    toolTraceListeners = new Set();
    serverLogListeners = new Set();
    responseReadyListeners = new Set();
    errorListeners = new Set();
    proactiveMessageListeners = new Set();
    weightUpdateListeners = new Set();
    fileRollbackListeners = new Set();
    multiFileModifiedListeners = new Set();
    userCorrectionListeners = new Set();
    taskCancelledListeners = new Set();
    environmentUpdateListeners = new Set();
    projectChangeListeners = new Set();
    gitStatusListeners = new Set();
    processingStatusListeners = new Set();
    streamStartListeners = new Set();
    streamChunkListeners = new Set();
    streamDoneListeners = new Set();
    agentProgressListeners = new Set();
    currentDialogState = 'idle';
    currentConnected = false;
    currentConnectionStatus = 'disconnected';
    pendingMessages = [];
    static MAX_PENDING_MESSAGES = 20;
    initialize(config) {
        const urlChanged = this.config?.url !== config.url;
        this.config = config;
        this.isActive = true;
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            this.reconnectAttempts = 0;
            this.connect();
        }
        else if (urlChanged) {
            this.reconnectAttempts = 0;
            this.cleanupSocket();
            this.ws = null;
            this.connect();
        }
    }
    connect() {
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
        WebSocketConnectionManager.log.info(`正在连接WebSocket: ${this.config.url} (第${this.reconnectAttempts + 1}次)`);
        try {
            const ws = new WebSocket(this.config.url);
            this.ws = ws;
            ws.onopen = () => {
                WebSocketConnectionManager.log.info('WebSocket连接成功');
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
                    const delay = Math.min(contracts_1.SYSTEM_CONSTANTS.WS_RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempts), contracts_1.SYSTEM_CONSTANTS.WS_RECONNECT_MAX_DELAY_MS);
                    this.updateConnectionStatus('reconnecting');
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectAttempts++;
                        this.connect();
                    }, delay);
                }
                else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    this.updateConnectionStatus('disconnected');
                    console.error('❌ WebSocket重连次数已达上限，停止重连');
                }
            };
            ws.onmessage = (event) => {
                try {
                    const raw = typeof event.data === 'string' ? event.data : String(event.data);
                    const message = JSON.parse(raw);
                    this.handleMessage(message);
                }
                catch (error) {
                    console.error('❌ WebSocket消息解析失败', {
                        error: error instanceof Error ? error.message : String(error),
                        rawData: String(event.data).substring(0, 200),
                    });
                }
            };
            ws.onerror = (_error) => {
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
                    }
                    catch {
                        // 静默
                    }
                });
                // 出错后也尝试重连
                if (this.isActive && this.reconnectAttempts < this.maxReconnectAttempts) {
                    const delay = Math.min(contracts_1.SYSTEM_CONSTANTS.WS_RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempts), contracts_1.SYSTEM_CONSTANTS.WS_RECONNECT_MAX_DELAY_MS);
                    this.updateConnectionStatus('reconnecting');
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectAttempts++;
                        this.connect();
                    }, delay);
                }
            };
        }
        catch {
            this.updateConnectionState(false);
            this.updateConnectionStatus('disconnected');
        }
    }
    handleMessage(message) {
        const traceTag = message.traceId ? ` [traceId: ${message.traceId}]` : '';
        const timestamp = new Date().toISOString();
        WebSocketConnectionManager.log.debug(`📨 [${timestamp}] 收到WebSocket消息: ${message.type}${traceTag}`);
        if (message.type === 'response_ready') {
            const data = message.data;
            const responsePreview = typeof data?.response === 'string'
                ? data.response.substring(0, 80)
                : JSON.stringify(data?.response)?.substring(0, 80);
            WebSocketConnectionManager.log.debug(`💬 [WS] response_ready: "${responsePreview}..."${traceTag}`);
        }
        this.messageListeners.forEach((listener) => {
            try {
                listener(message);
            }
            catch (err) {
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
                const stateData = message.data;
                const stateMap = {
                    LISTENING: 'listening',
                    PROCESSING: 'processing',
                    SPEAKING: 'speaking',
                };
                this.updateDialogState(stateMap[stateData.state] || 'idle');
                break;
            }
            case 'agent_execution_update': {
                const updateData = message.data;
                this.agentExecutionListeners.forEach((listener) => {
                    try {
                        listener(updateData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'perception_update': {
                const updateData = message.data;
                this.perceptionUpdateListeners.forEach((listener) => {
                    try {
                        listener(updateData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'brain_stage_update': {
                const updateData = message.data;
                this.brainStageUpdateListeners.forEach((listener) => {
                    try {
                        listener(updateData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'skill_execution_update': {
                const updateData = message.data;
                this.skillExecutionUpdateListeners.forEach((listener) => {
                    try {
                        listener(updateData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'evolution_event': {
                const eventData = message.data;
                this.evolutionEventListeners.forEach((listener) => {
                    try {
                        listener(eventData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'clarification_request': {
                const requestData = message.data;
                WebSocketConnectionManager.log.debug('🤔 收到澄清请求:', requestData.question);
                this.clarificationRequestListeners.forEach((listener) => {
                    try {
                        listener(requestData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'execution_preview': {
                const previewData = message.data;
                WebSocketConnectionManager.log.debug('📋 收到执行预览:', previewData.summary);
                this.executionPreviewListeners.forEach((listener) => {
                    try {
                        listener(previewData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'file_modified': {
                const fileData = message.data;
                WebSocketConnectionManager.log.debug('✏️ 文件已修改:', fileData.filePath);
                this.fileModifiedListeners.forEach((listener) => {
                    try {
                        listener(fileData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'tool_trace': {
                const traceData = message.data;
                this.toolTraceListeners.forEach((listener) => {
                    try {
                        listener(traceData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'server_log': {
                const logData = message.data;
                this.serverLogListeners.forEach((listener) => {
                    try {
                        listener(logData);
                    }
                    catch (err) {
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
                    }
                    catch {
                        // 静默处理
                    }
                });
                setTimeout(() => this.updateDialogState('idle'), 200);
                break;
            case 'response_ready_ack': {
                const ackData = message.data;
                WebSocketConnectionManager.log.debug(`✅ [WS] Python后端响应确认: traceId=${ackData.traceId}, source=${ackData.source}`);
                this.updateDialogState('idle');
                break;
            }
            case 'response':
                this.updateDialogState('speaking');
                break;
            case 'processing_status': {
                const statusData = message.data;
                WebSocketConnectionManager.log.debug('⏳ 收到处理状态更新:', statusData.message);
                this.processingStatusListeners.forEach((listener) => {
                    try {
                        listener(statusData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'connected':
                WebSocketConnectionManager.log.debug('📨 WebSocket连接已确认');
                break;
            case 'error': {
                const errorData = message.data;
                console.error('❌ 收到服务器错误:', errorData);
                this.updateDialogState('idle');
                this.errorListeners.forEach((listener) => {
                    try {
                        listener(errorData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'proactive_message': {
                const messageData = message.data;
                WebSocketConnectionManager.log.debug('💬 收到主动消息:', messageData.message);
                this.proactiveMessageListeners.forEach((listener) => {
                    try {
                        listener(messageData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'weight_update': {
                const updateData = message.data;
                this.weightUpdateListeners.forEach((listener) => {
                    try {
                        listener(updateData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'file_rollback': {
                const rollbackData = message.data;
                WebSocketConnectionManager.log.debug('↩️ 文件已回滚:', rollbackData.filePath);
                this.fileRollbackListeners.forEach((listener) => {
                    try {
                        listener(rollbackData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'multi_file_modified': {
                const multiFileData = message.data;
                WebSocketConnectionManager.log.debug('📝 多个文件已修改:', multiFileData.files?.length || 0, '个文件');
                this.multiFileModifiedListeners.forEach((listener) => {
                    try {
                        listener(multiFileData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'user_correction': {
                const correctionData = message.data;
                this.userCorrectionListeners.forEach((listener) => {
                    try {
                        listener(correctionData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'task_cancelled': {
                const cancelledData = message.data;
                WebSocketConnectionManager.log.debug('🚫 任务已取消:', cancelledData.traceId ?? cancelledData.taskId ?? 'unknown');
                this.taskCancelledListeners.forEach((listener) => {
                    try {
                        listener(cancelledData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'environment_update': {
                const envData = message.data;
                this.environmentUpdateListeners.forEach((listener) => {
                    try {
                        listener(envData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'project_change': {
                const changeData = message.data;
                WebSocketConnectionManager.log.debug('📂 项目变更:', changeData.repo, changeData.type);
                this.projectChangeListeners.forEach((listener) => {
                    try {
                        listener(changeData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'git_status': {
                const gitData = message.data;
                this.gitStatusListeners.forEach((listener) => {
                    try {
                        listener(gitData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'stream_start': {
                const streamStartData = message.data;
                this.streamStartListeners.forEach((listener) => {
                    try {
                        listener(streamStartData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'stream_chunk': {
                const streamChunkData = message.data;
                this.streamChunkListeners.forEach((listener) => {
                    try {
                        listener(streamChunkData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'stream_done': {
                const streamDoneData = message.data;
                this.updateDialogState('idle');
                this.streamDoneListeners.forEach((listener) => {
                    try {
                        listener(streamDoneData);
                    }
                    catch {
                        // 静默处理
                    }
                });
                break;
            }
            case 'thinking':
            case 'tool_start':
            case 'tool_end':
            case 'progress': {
                const progressData = message.data;
                const progress = {
                    traceId: progressData.traceId,
                    type: message.type,
                    content: progressData.content,
                    toolName: progressData.toolName,
                    toolArgs: progressData.toolArgs,
                    success: progressData.success,
                    resultSummary: progressData.resultSummary,
                    durationMs: progressData.durationMs,
                    phase: progressData.phase,
                    stepsCompleted: progressData.stepsCompleted,
                    stepsTotal: progressData.stepsTotal,
                    message: progressData.message,
                };
                this.agentProgressListeners.forEach((listener) => {
                    try {
                        listener(progress);
                    }
                    catch {
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
    updateConnectionState(connected) {
        this.currentConnected = connected;
        this.stateListeners.forEach((listener) => listener(connected));
    }
    updateConnectionStatus(status) {
        this.currentConnectionStatus = status;
        this.connectionStatusListeners.forEach((listener) => listener(status));
    }
    updateDialogState(state) {
        this.currentDialogState = state;
        this.dialogStateListeners.forEach((listener) => listener(state));
    }
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const message = {
                ...data,
                traceId: data.traceId || `trace_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`,
                timestamp: data._timestamp || Date.now(),
            };
            WebSocketConnectionManager.log.debug(`📤 [WS] 发送消息: type=${data.type}, traceId=${message.traceId}`);
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
    sendProcess(input, userId = 'default') {
        this.updateDialogState('processing');
        return this.send({
            type: 'user_input',
            payload: { input, userId },
        });
    }
    sendMessage(input, userId = 'default') {
        this.updateDialogState('processing');
        return this.send({
            type: 'user_input',
            payload: { input, userId },
        });
    }
    onStateChange(listener) {
        this.stateListeners.add(listener);
        listener(this.currentConnected);
    }
    offStateChange(listener) {
        this.stateListeners.delete(listener);
    }
    onDialogState(listener) {
        this.dialogStateListeners.add(listener);
        listener(this.currentDialogState);
    }
    offDialogState(listener) {
        this.dialogStateListeners.delete(listener);
    }
    onMessage(listener) {
        this.messageListeners.add(listener);
    }
    offMessage(listener) {
        this.messageListeners.delete(listener);
    }
    onConnectionStatus(listener) {
        this.connectionStatusListeners.add(listener);
        listener(this.currentConnectionStatus);
    }
    offConnectionStatus(listener) {
        this.connectionStatusListeners.delete(listener);
    }
    onAgentExecution(listener) {
        this.agentExecutionListeners.add(listener);
    }
    offAgentExecution(listener) {
        this.agentExecutionListeners.delete(listener);
    }
    onPerceptionUpdate(listener) {
        this.perceptionUpdateListeners.add(listener);
    }
    offPerceptionUpdate(listener) {
        this.perceptionUpdateListeners.delete(listener);
    }
    onBrainStageUpdate(listener) {
        this.brainStageUpdateListeners.add(listener);
    }
    offBrainStageUpdate(listener) {
        this.brainStageUpdateListeners.delete(listener);
    }
    onSkillExecutionUpdate(listener) {
        this.skillExecutionUpdateListeners.add(listener);
    }
    offSkillExecutionUpdate(listener) {
        this.skillExecutionUpdateListeners.delete(listener);
    }
    onEvolutionEvent(listener) {
        this.evolutionEventListeners.add(listener);
    }
    offEvolutionEvent(listener) {
        this.evolutionEventListeners.delete(listener);
    }
    onClarificationRequest(listener) {
        this.clarificationRequestListeners.add(listener);
    }
    offClarificationRequest(listener) {
        this.clarificationRequestListeners.delete(listener);
    }
    onExecutionPreview(listener) {
        this.executionPreviewListeners.add(listener);
    }
    offExecutionPreview(listener) {
        this.executionPreviewListeners.delete(listener);
    }
    onFileModified(listener) {
        this.fileModifiedListeners.add(listener);
    }
    offFileModified(listener) {
        this.fileModifiedListeners.delete(listener);
    }
    onToolTrace(listener) {
        this.toolTraceListeners.add(listener);
    }
    offToolTrace(listener) {
        this.toolTraceListeners.delete(listener);
    }
    onServerLog(listener) {
        this.serverLogListeners.add(listener);
    }
    offServerLog(listener) {
        this.serverLogListeners.delete(listener);
    }
    onResponseReady(listener) {
        this.responseReadyListeners.add(listener);
    }
    offResponseReady(listener) {
        this.responseReadyListeners.delete(listener);
    }
    onError(listener) {
        this.errorListeners.add(listener);
    }
    offError(listener) {
        this.errorListeners.delete(listener);
    }
    onProactiveMessage(listener) {
        this.proactiveMessageListeners.add(listener);
    }
    offProactiveMessage(listener) {
        this.proactiveMessageListeners.delete(listener);
    }
    onWeightUpdate(listener) {
        this.weightUpdateListeners.add(listener);
    }
    offWeightUpdate(listener) {
        this.weightUpdateListeners.delete(listener);
    }
    onFileRollback(listener) {
        this.fileRollbackListeners.add(listener);
    }
    offFileRollback(listener) {
        this.fileRollbackListeners.delete(listener);
    }
    onMultiFileModified(listener) {
        this.multiFileModifiedListeners.add(listener);
    }
    offMultiFileModified(listener) {
        this.multiFileModifiedListeners.delete(listener);
    }
    onUserCorrection(listener) {
        this.userCorrectionListeners.add(listener);
    }
    offUserCorrection(listener) {
        this.userCorrectionListeners.delete(listener);
    }
    onTaskCancelled(listener) {
        this.taskCancelledListeners.add(listener);
    }
    offTaskCancelled(listener) {
        this.taskCancelledListeners.delete(listener);
    }
    onEnvironmentUpdate(listener) {
        this.environmentUpdateListeners.add(listener);
    }
    offEnvironmentUpdate(listener) {
        this.environmentUpdateListeners.delete(listener);
    }
    onProjectChange(listener) {
        this.projectChangeListeners.add(listener);
    }
    offProjectChange(listener) {
        this.projectChangeListeners.delete(listener);
    }
    onGitStatus(listener) {
        this.gitStatusListeners.add(listener);
    }
    offGitStatus(listener) {
        this.gitStatusListeners.delete(listener);
    }
    onProcessingStatus(listener) {
        this.processingStatusListeners.add(listener);
    }
    offProcessingStatus(listener) {
        this.processingStatusListeners.delete(listener);
    }
    onStreamStart(listener) {
        this.streamStartListeners.add(listener);
    }
    offStreamStart(listener) {
        this.streamStartListeners.delete(listener);
    }
    onStreamChunk(listener) {
        this.streamChunkListeners.add(listener);
    }
    offStreamChunk(listener) {
        this.streamChunkListeners.delete(listener);
    }
    onStreamDone(listener) {
        this.streamDoneListeners.add(listener);
    }
    offStreamDone(listener) {
        this.streamDoneListeners.delete(listener);
    }
    onAgentProgress(listener) {
        this.agentProgressListeners.add(listener);
    }
    offAgentProgress(listener) {
        this.agentProgressListeners.delete(listener);
    }
    on(event, listener) {
        const wrapper = (message) => {
            if (message.type === event) {
                listener(message.data);
            }
        };
        this.messageListeners.add(wrapper);
        return () => this.messageListeners.delete(wrapper);
    }
    off(_event, _listener) {
        // 通用事件移除（保留接口兼容）
    }
    shutdown() {
        this.isActive = false;
        this.clearReconnectTimer();
        this.reconnectAttempts = this.maxReconnectAttempts + 1;
        this.cleanupSocket();
        this.updateConnectionState(false);
        this.updateConnectionStatus('disconnected');
        this.updateDialogState('idle');
    }
    isActiveConnection() {
        return this.isActive && this.currentConnected;
    }
    reconnect() {
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        this.cleanupSocket();
        this.ws = null;
        this.updateConnectionState(false);
        if (this.config && this.isActive) {
            this.connect();
        }
    }
    getConnectionStatus() {
        return this.currentConnectionStatus;
    }
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    flushPendingMessages() {
        if (this.pendingMessages.length === 0)
            return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const messages = [...this.pendingMessages];
        this.pendingMessages = [];
        for (const msg of messages) {
            try {
                this.ws.send(JSON.stringify(msg));
                WebSocketConnectionManager.log.debug(`📤 [WS] 发送缓存消息: type=${msg.type}, traceId=${msg.traceId}`);
            }
            catch (err) {
                console.error('❌ [WS] 缓存消息发送失败', err);
            }
        }
    }
    cleanupSocket() {
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
exports.WebSocketConnectionManager = WebSocketConnectionManager;
exports.connectionManager = new WebSocketConnectionManager();
