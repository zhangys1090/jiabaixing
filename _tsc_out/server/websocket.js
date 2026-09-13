"use strict";
/**
 * WebSocket 连接处理与输入处理
 * P0: 集成限流和熔断机制
 * P1: 自动重试 + 用户取消
 */
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupWebSocket = setupWebSocket;
exports.processInputOnce = processInputOnce;
const SecurityPolicyEngine_1 = require("../security/SecurityPolicyEngine");
const EventBus_1 = require("../shared/EventBus");
const contracts_1 = require("../shared/contracts");
const Logger_1 = require("../utils/Logger");
const bootstrap_1 = require("./bootstrap");
const audioStreamBuffers = new Map();
const AUDIO_STREAM_TIMEOUT_MS = 5 * 60 * 1000;
const AUDIO_STREAM_MAX_CHUNKS = 1000;
setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of audioStreamBuffers) {
        if (now - session.startedAt > AUDIO_STREAM_TIMEOUT_MS) {
            audioStreamBuffers.delete(sid);
            Logger_1.Logger.debug(`🗑️ 清理超时音频流会话: ${sid}`, 'WebSocket');
        }
    }
}, 60_000);
// LRU风格去重缓存（带容量限制）
class DedupCache {
    cache;
    maxSize;
    constructor(maxSize) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    has(traceId) {
        return this.cache.has(traceId);
    }
    add(traceId) {
        // 如果已存在，先删除以更新"最后访问时间"（用Map的插入顺序模拟）
        if (this.cache.has(traceId)) {
            this.cache.delete(traceId);
        }
        // 如果达到容量上限，删除最早的
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(traceId, Date.now());
    }
    delete(traceId) {
        this.cache.delete(traceId);
    }
}
const processedResponses = new DedupCache(contracts_1.SYSTEM_CONSTANTS.MAX_DEDUP_CACHE_SIZE);
function checkAndMarkResponse(traceId) {
    if (processedResponses.has(traceId)) {
        return true;
    }
    processedResponses.add(traceId);
    setTimeout(() => {
        processedResponses.delete(traceId);
    }, 5 * 60 * 1000);
    return false;
}
const activeTasks = new Map();
function isRetryableError(error) {
    const msg = error.message || '';
    const retryablePatterns = [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'socket hang up',
        'network',
        'timeout',
        '超时',
        '429',
        '503',
        '502',
        'rate limit',
        'temporarily',
    ];
    return retryablePatterns.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}
// 活跃任务自动清理定时器
let activeTaskCleanupInterval = null;
const MAX_WS_CONNECTIONS = 100;
const HEARTBEAT_INTERVAL_MS = 30_000;
const _HEARTBEAT_TIMEOUT_MS = 10_000;
function setupWebSocket(wss, core) {
    if (!wss)
        return;
    if (activeTaskCleanupInterval === null) {
        activeTaskCleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [traceId, task] of activeTasks.entries()) {
                if (now - task.createdAt > contracts_1.SYSTEM_CONSTANTS.ACTIVE_TASK_TIMEOUT_MS) {
                    if (!task.aborted && task.loopController) {
                        try {
                            task.loopController.abort();
                        }
                        catch {
                            // 忽略
                        }
                    }
                    activeTasks.delete(traceId);
                    Logger_1.Logger.debug(`🗑️ 自动清理超时活跃任务: traceId=${traceId}`, 'WebSocket');
                }
            }
        }, 60 * 1000);
    }
    const heartbeatInterval = setInterval(() => {
        for (const client of wss.clients) {
            const ext = client;
            if (!ext.isAlive) {
                ext.terminate();
                continue;
            }
            ext.isAlive = false;
            ext.ping();
        }
    }, HEARTBEAT_INTERVAL_MS);
    wss.on('close', () => {
        clearInterval(heartbeatInterval);
    });
    wss.on('connection', (ws, req) => {
        if (wss.clients.size > MAX_WS_CONNECTIONS) {
            Logger_1.Logger.warn(`⚠️ WebSocket 连接数超限 (${wss.clients.size}/${MAX_WS_CONNECTIONS})，拒绝新连接`, 'WebSocket');
            ws.close(1013, 'Server busy: max connections reached');
            return;
        }
        const clientIp = req.socket.remoteAddress || 'unknown';
        Logger_1.Logger.info(`💖 新客户端连接: ${clientIp} (在线: ${wss.clients.size})`, 'WebSocket');
        const ext = ws;
        ext.isAlive = true;
        ws.on('pong', () => {
            ext.isAlive = true;
        });
        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'user_input' || data.type === 'command') {
                    const input = data.payload?.input ||
                        data.payload?.text ||
                        data.payload?.message ||
                        data.data?.input ||
                        data.data?.text ||
                        data.data?.message ||
                        data.input ||
                        data.text ||
                        data.message ||
                        '';
                    const userId = data.payload?.userId ||
                        data.payload?.userid ||
                        data.data?.userId ||
                        data.userId ||
                        'anonymous';
                    if (!input) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '缺少输入内容' },
                        }));
                        return;
                    }
                    if (input.length > contracts_1.SYSTEM_CONSTANTS.MAX_INPUT_LENGTH) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: {
                                message: `消息过长（${input.length}字），请控制在${contracts_1.SYSTEM_CONSTANTS.MAX_INPUT_LENGTH}字以内`,
                            },
                        }));
                        return;
                    }
                    const policyEngine = SecurityPolicyEngine_1.SecurityPolicyEngine.getInstance();
                    const rateLimitResult = policyEngine.checkSlidingWindowRateLimit(`ws:${userId}:${clientIp}`, 30, 10000);
                    if (!rateLimitResult.allowed) {
                        Logger_1.Logger.warn(`⚠️ WebSocket限流: userId=${userId} ip=${clientIp}`, 'WebSocket');
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: {
                                message: `请求过于频繁，请${Math.ceil(rateLimitResult.resetIn / 1000)}秒后再试`,
                                code: 'rate_limit_exceeded',
                                retryAfter: rateLimitResult.resetIn,
                            },
                        }));
                        return;
                    }
                    const llmBreaker = policyEngine.getCircuitBreaker('llm_processing');
                    if (!llmBreaker.canExecute()) {
                        Logger_1.Logger.warn(`⚠️ LLM熔断器开启，拒绝请求: userId=${userId}`, 'WebSocket');
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: {
                                message: '服务暂时不可用，请稍后再试',
                                code: 'circuit_open',
                            },
                        }));
                        return;
                    }
                    const traceId = Logger_1.Logger.generateTraceId();
                    Logger_1.Logger.info(`📩 WebSocket收到: ${String(input).substring(0, 50)}${String(input).length > 50 ? '...' : ''}`, 'WebSocket');
                    processInputWithRetry(input, userId, traceId, ws, core, clientIp).catch((err) => {
                        Logger_1.Logger.error('❌ 处理输入失败（重试耗尽）', err, 'WebSocket');
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({
                                type: 'error',
                                data: { message: err.message, traceId },
                            }));
                        }
                    });
                }
                else if (data.type === 'cancel_task') {
                    const taskTraceId = data.traceId;
                    if (taskTraceId && activeTasks.has(taskTraceId)) {
                        const task = activeTasks.get(taskTraceId);
                        task.aborted = true;
                        if (task.loopController) {
                            task.loopController.abort();
                        }
                        activeTasks.delete(taskTraceId);
                        Logger_1.Logger.info(`🛑 用户取消任务: traceId=${taskTraceId}`, 'WebSocket');
                        void EventBus_1.EventBus.emit('agent_execution_update', {
                            traceId: taskTraceId,
                            phase: 'cancelled',
                            status: 'aborted',
                            message: '用户已取消任务',
                            timestamp: new Date().toISOString(),
                        });
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({
                                type: 'task_cancelled',
                                data: { traceId: taskTraceId, message: '任务已取消' },
                            }));
                        }
                    }
                    else {
                        Logger_1.Logger.info(`🛑 取消任务未找到: traceId=${taskTraceId}`, 'WebSocket');
                    }
                }
                else if (data.type === 'get_status') {
                    ws.send(JSON.stringify({
                        type: 'status',
                        data: {
                            status: 'running',
                            model: process.env.MODEL_NAME || 'qwen2.5:3b',
                            uptime: process.uptime(),
                            clients: wss?.clients.size || 0,
                        },
                    }));
                }
                else if (data.type === 'clarification_response') {
                    Logger_1.Logger.info(`💬 收到澄清回答: ${data.response}`, 'WebSocket');
                    void EventBus_1.EventBus.emit('clarification_response', data);
                }
                else if (data.type === 'execution_confirm') {
                    Logger_1.Logger.info(`✅ 收到执行确认: ${data.confirmed ? '确认' : '取消'}`, 'WebSocket');
                    void EventBus_1.EventBus.emit('execution_confirm', data);
                }
                else if (data.type === 'automation_task_toggle') {
                    Logger_1.Logger.info(`⚡ 自动化任务切换: ${data.taskId} -> ${data.enabled ? '启用' : '禁用'}`, 'WebSocket');
                    if (core?.getScenarioScheduler()) {
                        const scheduler = core.getScenarioScheduler();
                        if (data.enabled)
                            scheduler.toggleTask?.(data.taskId, true);
                        else
                            scheduler.toggleTask?.(data.taskId, false);
                    }
                    void EventBus_1.EventBus.emit('automation_task_toggle', data);
                }
                else if (data.type === 'automation_task_create') {
                    Logger_1.Logger.info(`⚡ 自动化任务创建: ${JSON.stringify(data.task)}`, 'WebSocket');
                    if (core?.getScenarioScheduler()) {
                        core.getScenarioScheduler().addTask(data.task);
                    }
                    void EventBus_1.EventBus.emit('automation_task_create', data);
                }
                else if (data.type === 'automation_trigger_execute') {
                    Logger_1.Logger.info(`⚡ 自动化触发执行: ${JSON.stringify(data.trigger)}`, 'WebSocket');
                    void EventBus_1.EventBus.emit('automation_trigger_execute', data);
                }
                else if (data.type === 'audio_chunk') {
                    // 实时音频流块 — 累积到会话缓冲区
                    try {
                        const sessionId = data.sessionId;
                        const chunk = data.chunk;
                        const format = data.format || 'webm';
                        if (!chunk)
                            return;
                        const sid = sessionId || `audio_${clientIp}_${Date.now()}`;
                        if (!audioStreamBuffers.has(sid)) {
                            audioStreamBuffers.set(sid, {
                                chunks: [],
                                format,
                                startedAt: Date.now(),
                            });
                        }
                        audioStreamBuffers.get(sid).chunks.push(chunk);
                        if (audioStreamBuffers.get(sid).chunks.length >
                            AUDIO_STREAM_MAX_CHUNKS) {
                            audioStreamBuffers
                                .get(sid)
                                .chunks.splice(0, audioStreamBuffers.get(sid).chunks.length -
                                AUDIO_STREAM_MAX_CHUNKS);
                        }
                    }
                    catch {
                        // 静默处理音频块错误
                    }
                }
                else if (data.type === 'audio_end') {
                    // 音频流结束 — 合并缓冲区，送入语音识别
                    try {
                        const sessionId = data.sessionId;
                        const sid = sessionId || '';
                        if (sid && audioStreamBuffers.has(sid)) {
                            const session = audioStreamBuffers.get(sid);
                            audioStreamBuffers.delete(sid);
                            // 将 base64 音频块合并为 Buffer
                            const audioBuffers = [];
                            for (const chunk of session.chunks) {
                                audioBuffers.push(Buffer.from(chunk, 'base64'));
                            }
                            const fullAudio = Buffer.concat(audioBuffers);
                            // 发送 ASR 识别结果
                            try {
                                const { SpeechRecognizer } = await Promise.resolve().then(() => __importStar(require('../multimodal/SpeechRecognizer')));
                                const recognizer = new SpeechRecognizer();
                                await recognizer.initialize();
                                // SpeechRecognizer 只有 recognize(buffer) 接口
                                const result = await recognizer.recognize(fullAudio);
                                if (ws.readyState === 1) {
                                    ws.send(JSON.stringify({
                                        type: 'asr_result',
                                        data: {
                                            text: result.text,
                                            confidence: result.confidence,
                                            language: result.language || 'zh-CN',
                                            duration: result.duration || 0,
                                            sessionId: sid,
                                        },
                                    }));
                                }
                                // 将识别文本作为用户输入处理
                                if (result.text) {
                                    const traceId = Logger_1.Logger.generateTraceId();
                                    processInputWithRetry(result.text, 'voice_user', traceId, ws, core, clientIp).catch((err) => {
                                        Logger_1.Logger.error('❌ 语音输入处理失败', err, 'WebSocket');
                                    });
                                }
                            }
                            catch (asrErr) {
                                Logger_1.Logger.error('❌ ASR识别失败', asrErr, 'WebSocket');
                                if (ws.readyState === 1) {
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        data: { message: '语音识别失败', sessionId: sid },
                                    }));
                                }
                            }
                        }
                    }
                    catch (audioErr) {
                        Logger_1.Logger.error('❌ 音频流处理失败', audioErr, 'WebSocket');
                    }
                }
                else {
                    Logger_1.Logger.info(`📨 WebSocket收到未知类型: ${data.type}`, 'WebSocket');
                }
            }
            catch (error) {
                Logger_1.Logger.error('❌ 解析WebSocket消息失败', error, 'WebSocket');
            }
        });
        ws.on('close', () => {
            Logger_1.Logger.info(`👋 客户端断开: ${clientIp}`, 'WebSocket');
            // 清理该用户的所有活跃任务
            for (const [traceId, task] of activeTasks.entries()) {
                if (task.clientIp === clientIp) {
                    if (!task.aborted && task.loopController) {
                        try {
                            task.loopController.abort();
                        }
                        catch {
                            // 忽略
                        }
                    }
                    activeTasks.delete(traceId);
                    Logger_1.Logger.debug(`🗑️ 清理客户端断开关联任务: traceId=${traceId}`, 'WebSocket');
                }
            }
        });
        ws.send(JSON.stringify({
            type: 'connected',
            data: {
                message: '💖 已连接到家百星智能助手',
                model: process.env.LLM_MODEL || 'deepseek-v4-flash',
                status: 'running',
                timestamp: new Date().toISOString(),
            },
        }));
    });
}
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
async function processInputWithRetry(input, userId, traceId, ws, core, clientIp) {
    if (checkAndMarkResponse(traceId)) {
        Logger_1.Logger.info(`⚠️ traceId ${traceId} 已处理，跳过重复请求`, 'WebSocket');
        return;
    }
    const taskHandle = {
        aborted: false,
        loopController: undefined,
        clientIp,
        createdAt: Date.now(),
    };
    activeTasks.set(traceId, taskHandle);
    if (ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: 'processing_status',
            data: {
                status: 'processing',
                message: '收到消息，正在处理中...',
                traceId,
            },
        }));
    }
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (taskHandle.aborted) {
            Logger_1.Logger.info(`🛑 任务已取消，停止重试: traceId=${traceId}`, 'WebSocket');
            return;
        }
        try {
            if (attempt > 0) {
                Logger_1.Logger.info(`🔄 第 ${attempt} 次重试, traceId: ${traceId}`, 'WebSocket');
                void EventBus_1.EventBus.emit('agent_execution_update', {
                    traceId,
                    phase: 'retrying',
                    status: 'in_progress',
                    message: `处理遇到问题，正在重试（第${attempt}次）...`,
                    attempt,
                    timestamp: new Date().toISOString(),
                });
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
                if (taskHandle.aborted) {
                    return;
                }
            }
            await processInputOnce(input, userId, traceId, ws, core, taskHandle);
            activeTasks.delete(traceId);
            return;
        }
        catch (error) {
            lastError = error;
            if (taskHandle.aborted) {
                activeTasks.delete(traceId);
                return;
            }
            const canRetry = isRetryableError(lastError) && attempt < MAX_RETRIES;
            Logger_1.Logger.warn(`❌ 处理失败 (attempt=${attempt}/${MAX_RETRIES}, retryable=${canRetry}): ${lastError.message}`, 'WebSocket');
            if (!canRetry) {
                break;
            }
        }
    }
    activeTasks.delete(traceId);
    const policyEngine = SecurityPolicyEngine_1.SecurityPolicyEngine.getInstance();
    policyEngine.getCircuitBreaker('llm_processing').recordFailure();
    if (ws.readyState === 1 && lastError) {
        const errorMsg = lastError.message;
        let response = '抱歉，处理出错了，请稍后重试。';
        if (isRetryableError(lastError)) {
            response = `抱歉，网络连接出现问题，已重试${MAX_RETRIES}次仍失败。\n\n请检查：\n1. 网络连接是否正常\n2. LLM 服务是否可用\n3. 稍后再试`;
        }
        else if (errorMsg.includes('API') ||
            errorMsg.includes('401') ||
            errorMsg.includes('认证')) {
            response = `抱歉，LLM API 认证失败。\n\n请检查 .env 文件中的 API Key 配置：\n- DEEPSEEK_API_KEY 或 OPENAI_API_KEY\n\n配置文件路径: c:\\zy\\jiabaixing\\.env`;
        }
        else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('连接')) {
            response = `抱歉，无法连接到 LLM 服务。\n\n请检查：\n1. 如果使用 DeepSeek API，确认网络连接正常\n2. 如果使用本地模型，请启动 Ollama 服务（ollama serve）`;
        }
        ws.send(JSON.stringify({
            type: 'response_ready',
            data: {
                response,
                traceId,
            },
        }));
    }
}
async function processInputOnce(input, userId, traceId, ws, core, taskHandle) {
    // WS 通道直接处理聊天消息：转发到 Python 后端并以流式事件回推，
    // 与 HTTP /api/process 互斥（前端仅在 WS 断开时回退 HTTP），保证单次生成只走一条路径。
    if ((0, bootstrap_1.isPythonBackend)()) {
        const bridge = (0, bootstrap_1.getPythonBridge)();
        const PROCESSING_TIMEOUT_MS = 120000;
        const timeoutId = setTimeout(() => {
            if (!taskHandle.aborted && ws.readyState === 1) {
                Logger_1.Logger.warn(`Python Agent 处理超时 (${PROCESSING_TIMEOUT_MS}ms): traceId=${traceId}`, 'WebSocket');
                ws.send(JSON.stringify({
                    type: 'response_ready',
                    data: {
                        response: '抱歉，处理时间过长，已自动终止。请稍后重试。',
                        traceId,
                        success: false,
                        timeout: true,
                    },
                }));
                taskHandle.aborted = true;
            }
        }, PROCESSING_TIMEOUT_MS);
        try {
            Logger_1.Logger.info(`[Python] 开始流式处理 [${traceId}]: "${input.substring(0, 50)}..."`, 'WebSocket');
            const contentBuffer = [];
            for await (const event of bridge.processInputStream(input, userId, traceId)) {
                if (taskHandle.aborted || ws.readyState !== 1)
                    break;
                const eventTraceId = event.trace_id || traceId;
                switch (event.type) {
                    case 'stream_start':
                        ws.send(JSON.stringify({
                            type: 'stream_start',
                            data: { traceId: eventTraceId },
                        }));
                        break;
                    case 'stream_chunk':
                        if (event.content) {
                            contentBuffer.push(event.content);
                            ws.send(JSON.stringify({
                                type: 'stream_chunk',
                                data: { traceId: eventTraceId, chunk: event.content },
                            }));
                        }
                        break;
                    case 'stream_done': {
                        const fullText = event.content || contentBuffer.join('');
                        ws.send(JSON.stringify({
                            type: 'stream_done',
                            data: { traceId: eventTraceId, fullText },
                        }));
                        ws.send(JSON.stringify({
                            type: 'response_ready',
                            data: {
                                response: fullText,
                                traceId: eventTraceId,
                                success: true,
                            },
                        }));
                        break;
                    }
                    case 'thinking':
                    case 'tool_start':
                    case 'tool_end':
                    case 'progress':
                        ws.send(JSON.stringify({
                            type: event.type,
                            data: {
                                traceId: eventTraceId,
                                content: event.content,
                                toolName: event.tool_name,
                                toolArgs: event.tool_args,
                                success: event.success,
                                resultSummary: event.result_summary,
                                durationMs: event.duration_ms,
                                phase: event.phase,
                                stepsCompleted: event.steps_completed,
                                stepsTotal: event.steps_total,
                                message: event.message,
                            },
                        }));
                        break;
                    case 'error':
                        ws.send(JSON.stringify({
                            type: 'response_ready',
                            data: {
                                response: event.content || '处理失败',
                                traceId: eventTraceId,
                                success: false,
                                error: event.raw_error || event.content,
                            },
                        }));
                        break;
                    case 'task_cancelled':
                        ws.send(JSON.stringify({
                            type: 'response_ready',
                            data: {
                                response: event.content || '任务已取消',
                                traceId: eventTraceId,
                                success: false,
                                cancelled: true,
                            },
                        }));
                        break;
                }
            }
            clearTimeout(timeoutId);
            if (taskHandle.aborted)
                return;
            const policyEngine = SecurityPolicyEngine_1.SecurityPolicyEngine.getInstance();
            policyEngine.getCircuitBreaker('llm_processing').recordSuccess();
            Logger_1.Logger.info(`[Python] 流式处理完成, traceId: ${traceId}`, 'WebSocket');
        }
        catch (error) {
            clearTimeout(timeoutId);
            Logger_1.Logger.error('[Python] processInputOnce 流式执行失败', error, 'WebSocket');
            if (ws.readyState === 1 && !taskHandle.aborted) {
                ws.send(JSON.stringify({
                    type: 'response_ready',
                    data: {
                        response: `处理失败: ${error.message}`,
                        traceId,
                        success: false,
                    },
                }));
            }
            throw error;
        }
        return;
    }
    // ── TS 本地路径 ──
    if (!core) {
        throw new Error('核心系统未初始化');
    }
    const llm = core.getLLM();
    if (!llm || !llm.isServiceAvailable()) {
        Logger_1.Logger.warn('⚠️ LLM 服务不可用，返回配置提示', 'WebSocket');
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'response_ready',
                data: {
                    response: `抱歉，LLM 服务暂时不可用。\n\n请检查以下配置：\n1. 确认 .env 文件中的 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 已正确设置\n2. 如果使用本地模型，请确认 Ollama 服务已启动\n3. 检查网络连接是否正常\n\n配置文件路径: c:\\zy\\jiabaixing\\.env`,
                    traceId,
                },
            }));
        }
        return;
    }
    const harness = core.getHarness();
    if (harness) {
        taskHandle.loopController = { abort: () => harness.abortCurrentLoop() };
    }
    try {
        const PROCESSING_TIMEOUT_MS = 120000;
        const timeoutId = setTimeout(() => {
            if (!taskHandle.aborted && ws.readyState === 1) {
                Logger_1.Logger.warn(`⚠️ 处理超时 (${PROCESSING_TIMEOUT_MS}ms): traceId=${traceId}`, 'WebSocket');
                ws.send(JSON.stringify({
                    type: 'response_ready',
                    data: {
                        response: `抱歉，处理时间过长，已自动终止。\n\n可能的原因：\n1. LLM 服务响应缓慢\n2. 任务过于复杂\n3. 网络连接不稳定\n\n请稍后重试，或简化您的请求。`,
                        traceId,
                        success: false,
                        timeout: true,
                    },
                }));
                taskHandle.aborted = true;
                if (taskHandle.loopController) {
                    taskHandle.loopController.abort();
                }
            }
        }, PROCESSING_TIMEOUT_MS);
        Logger_1.Logger.info(`🚀 开始处理输入 [${traceId}]: "${input.substring(0, 50)}..."`, 'WebSocket');
        const result = await core.processInput(input, userId, traceId);
        clearTimeout(timeoutId);
        if (taskHandle.aborted) {
            return;
        }
        const policyEngine = SecurityPolicyEngine_1.SecurityPolicyEngine.getInstance();
        policyEngine.getCircuitBreaker('llm_processing').recordSuccess();
        if (ws.readyState === 1) {
            Logger_1.Logger.info(`✅ 处理完成, traceId: ${result.traceId}（响应由 EventBus → eventBusSetup 统一广播）`, 'WebSocket');
        }
    }
    catch (error) {
        Logger_1.Logger.error('❌ processInputOnce 执行失败', error, 'WebSocket');
        if (ws.readyState === 1) {
            const errorMsg = error.message;
            let userFriendlyMessage = `抱歉，处理过程中出现了错误：${errorMsg}`;
            if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('连接')) {
                userFriendlyMessage = `抱歉，无法连接到 AI 服务。\n\n请检查：\n1. 网络连接是否正常\n2. API Key 是否正确配置\n3. LLM 服务是否可用`;
            }
            else if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
                userFriendlyMessage = `抱歉，AI 服务响应超时。\n\n可能原因：\n1. 服务器负载过高\n2. 网络延迟\n3. 请求队列拥堵\n\n请稍后重试。`;
            }
            else if (errorMsg.includes('API') ||
                errorMsg.includes('401') ||
                errorMsg.includes('认证')) {
                userFriendlyMessage = `抱歉，API 认证失败。\n\n请检查 .env 文件中的 API Key 配置是否正确。`;
            }
            ws.send(JSON.stringify({
                type: 'response_ready',
                data: {
                    response: userFriendlyMessage,
                    traceId,
                    success: false,
                    error: errorMsg,
                },
            }));
        }
        throw error;
    }
}
