"use strict";
/**
 * PythonAgentBridge — TS ↔ Python Agent 通信桥
 *
 * 实现 ACPDeps 接口，将请求转发到 Python FastAPI 后端
 * 通过 AGENT_BACKEND=python 环境变量启用
 *
 * 混合架构下，TS 薄网关将 AI 请求转发到 Python AI 引擎：
 *   TS (Express :3111)  →  HTTP/WS  →  Python (FastAPI :3112)
 *
 * v2 优化：
 *   - HTTP 连接池 (keepAlive + maxSockets)
 *   - WS 流式聊天通道 (优先 WS，回退 HTTP)
 *   - 支持 streaming callback 和 cancel
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PythonAgentBridge = exports.BridgeError = void 0;
const axios_1 = __importDefault(require("axios"));
const node_crypto_1 = require("node:crypto");
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const ws_1 = __importDefault(require("ws"));
const Logger_1 = require("../utils/Logger");
const EventBus_1 = require("../shared/EventBus");
const ACPActivityTracker_1 = require("./ACPActivityTracker");
class BridgeError extends Error {
    constructor(bridgePhase, originalError, fallbackUsed = false, pythonHealthy = false) {
        const phaseLabel = `Bridge[${bridgePhase}]`;
        super(`${phaseLabel}: ${originalError.message}`);
        this.name = 'BridgeError';
        this.bridgePhase = bridgePhase;
        this.originalError = originalError;
        this.fallbackUsed = fallbackUsed;
        this.pythonHealthy = pythonHealthy;
        this.timestamp = Date.now();
    }
}
exports.BridgeError = BridgeError;
class PythonAgentBridge {
    constructor(config) {
        var _a, _b, _c;
        this.ws = null; // EventBus WS
        this.chatWs = null; // Chat streaming WS
        this.eventHandlers = new Map();
        this.healthy = false;
        this.tsEventBusForward = null;
        // WS 流式聊天请求管理
        this._pendingRequests = new Map();
        this._requestIdCounter = 0;
        this._chatReconnectTimer = null;
        this._chatReconnectDelay = 1000; // 初始 1s，指数退避
        this._eventReconnectDelay = 1000; // EventBus 重连初始 1s
        this._disconnected = false; // 标记已主动断开，阻止重连
        // WS 流式聊天超时：默认 120s，通过 AGENT_WS_TIMEOUT_SEC 环境变量可配
        this._wsTimeout =
            (parseInt(process.env.AGENT_WS_TIMEOUT_SEC || '', 10) || 120) * 1000;
        // 连接池优化：keepAlive + maxSockets 减少 TCP 握手开销
        const httpAgent = new node_http_1.default.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 10,
            maxFreeSockets: 5,
            timeout: ((_a = config.timeout) !== null && _a !== void 0 ? _a : 60000) + 5000,
        });
        const httpsAgent = new node_https_1.default.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 10,
            maxFreeSockets: 5,
            timeout: ((_b = config.timeout) !== null && _b !== void 0 ? _b : 60000) + 5000,
        });
        this.client = axios_1.default.create({
            baseURL: config.baseUrl,
            timeout: (_c = config.timeout) !== null && _c !== void 0 ? _c : 60000,
            httpAgent,
            httpsAgent,
            headers: config.apiKey
                ? { Authorization: `Bearer ${config.apiKey}` }
                : {},
        });
        // 跨语言追踪：响应拦截器，提取Python后端返回的x-trace-id
        this.client.interceptors.response.use((response) => {
            var _a;
            const respTraceId = (_a = response.headers) === null || _a === void 0 ? void 0 : _a['x-trace-id'];
            if (respTraceId && typeof respTraceId === 'string') {
                // 将traceId附加到响应data上，供调用方使用
                if (response.data && typeof response.data === 'object') {
                    response.data._trace_id = respTraceId;
                }
            }
            return response;
        }, (error) => error);
    }
    // ── ACPDeps 实现 ──────────────────────────
    /**
     * 处理用户输入 — 优先使用 WS 流式通道，回退 HTTP
     * 降级时发出 bridge:fallback 事件（可观测），最终不可用时抛出 BridgeError
     */
    async processInput(message, sessionId, traceId, images) {
        var _a;
        const sid = sessionId !== null && sessionId !== void 0 ? sessionId : 'default';
        const tid = traceId !== null && traceId !== void 0 ? traceId : (0, node_crypto_1.randomUUID)();
        if (((_a = this.chatWs) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.OPEN) {
            try {
                return await this._processInputViaWs(message, sid, tid, images);
            }
            catch (wsError) {
                const err = wsError;
                Logger_1.Logger.warn(`WS 流式聊天失败，回退 HTTP: ${err.message}`, 'PythonAgentBridge');
                this._emitFallbackEvent('ws', 'http', 'ws_request', err.message);
            }
        }
        try {
            return await this._processInputViaHttp(message, sid, tid, images);
        }
        catch (httpError) {
            const err = httpError;
            const bridgeErr = new BridgeError('python_unavailable', err, false, this.healthy);
            this._emitUnavailableEvent('python_unavailable', err.message);
            throw bridgeErr;
        }
    }
    /**
     * 流式处理用户输入 — AsyncGenerator，逐 token 产出事件
     * 仅在 WS 通道可用时工作
     */
    async *processInputStream(message, sessionId, traceId, images) {
        var _a;
        const sid = sessionId !== null && sessionId !== void 0 ? sessionId : 'default';
        const tid = traceId !== null && traceId !== void 0 ? traceId : (0, node_crypto_1.randomUUID)();
        if (((_a = this.chatWs) === null || _a === void 0 ? void 0 : _a.readyState) !== ws_1.default.OPEN) {
            try {
                const result = await this._processInputViaHttp(message, sid, tid, images);
                this._emitFallbackEvent('ws', 'http', 'ws_connect', 'WS channel not open');
                const content = result.response;
                yield { type: 'stream_start', session_id: sid, trace_id: tid };
                for (let i = 0; i < content.length; i += 10) {
                    yield {
                        type: 'stream_chunk',
                        content: content.slice(i, i + 10),
                        session_id: sid,
                        trace_id: tid,
                    };
                }
                yield {
                    type: 'stream_done',
                    content,
                    session_id: sid,
                    trace_id: tid,
                    done: true,
                };
            }
            catch (error) {
                const err = error;
                this._emitUnavailableEvent('python_unavailable', err.message);
                yield {
                    type: 'error',
                    content: `Python Agent 不可用: ${err.message}`,
                    done: true,
                };
            }
            return;
        }
        // WS 流式通道可用 — 使用事件驱动生成器
        const requestId = `chat_${++this._requestIdCounter}_${Date.now()}`;
        const eventQueue = [];
        let finished = false;
        let finishResolve = null;
        let errorResult = null;
        const onEvent = (event) => {
            eventQueue.push(event);
            if (event.done ||
                event.type === 'error' ||
                event.type === 'task_cancelled') {
                finished = true;
                finishResolve === null || finishResolve === void 0 ? void 0 : finishResolve();
            }
        };
        // 注册响应处理器
        const timeout = setTimeout(() => {
            if (!finished) {
                errorResult = new Error('WS 流式聊天超时');
                finished = true;
                finishResolve === null || finishResolve === void 0 ? void 0 : finishResolve();
            }
        }, 300000); // 5 分钟超时
        try {
            this.chatWs.send(JSON.stringify({
                type: 'user_input',
                message,
                session_id: sid,
                trace_id: tid,
                request_id: requestId,
                images: images !== null && images !== void 0 ? images : [],
            }));
            // 注册 handler 到临时列表
            this._pendingRequests.set(requestId, {
                resolve: () => { },
                reject: () => { },
                onStream: onEvent,
                contentBuffer: [],
                timeout,
            });
            // 轮询事件队列
            while (!finished) {
                if (eventQueue.length > 0) {
                    const event = eventQueue.shift();
                    yield event;
                }
                else {
                    // 等待新事件
                    await new Promise((resolve) => {
                        finishResolve = resolve;
                    });
                    // 如果有积压的事件，继续产出
                    while (eventQueue.length > 0) {
                        yield eventQueue.shift();
                    }
                }
            }
            // 产出剩余事件
            while (eventQueue.length > 0) {
                yield eventQueue.shift();
            }
            if (errorResult) {
                yield {
                    type: 'error',
                    content: errorResult.message,
                    done: true,
                };
            }
        }
        finally {
            clearTimeout(timeout);
            this._pendingRequests.delete(requestId);
        }
    }
    /**
     * 取消正在执行的任务
     */
    cancelTask(sessionId) {
        var _a;
        if (((_a = this.chatWs) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.OPEN) {
            this.chatWs.send(JSON.stringify({
                type: 'cancel_task',
                session_id: sessionId,
            }));
        }
    }
    getFileDiffs(sessionId) {
        return ACPActivityTracker_1.ACPActivityTracker.getInstance().getFileDiffs(sessionId);
    }
    getTerminalCommands(sessionId) {
        return ACPActivityTracker_1.ACPActivityTracker.getInstance().getTerminalCommands(sessionId);
    }
    getToolActivities(sessionId) {
        return ACPActivityTracker_1.ACPActivityTracker.getInstance().getToolActivities(sessionId);
    }
    // ── 核心 AI 操作 ──────────────────────────
    async searchMemory(query, limit = 10) {
        const { data } = await this.client.get('/v1/memory/search', {
            params: { query, limit },
        });
        return data;
    }
    async storeMemory(entry) {
        const { data } = await this.client.post('/v1/memory/store', entry);
        return data;
    }
    async getMemoryStats() {
        const { data } = await this.client.get('/v1/memory/stats');
        return data;
    }
    async getMemoryProfile() {
        const { data } = await this.client.get('/v1/memory/profile');
        return data;
    }
    async listSkills() {
        const { data } = await this.client.get('/v1/skills');
        return data;
    }
    async executeSkill(name, params = {}) {
        const { data } = await this.client.post('/v1/skills/execute', {
            name,
            params,
        });
        return data;
    }
    async submitFeedback(feedback) {
        await this.client.post('/v1/evolution/feedback', feedback);
    }
    async getEvolutionStatus() {
        const { data } = await this.client.get('/v1/evolution/status');
        return data;
    }
    async triggerEvolution() {
        const { data } = await this.client.post('/v1/evolution/trigger');
        return data;
    }
    async listCronJobs() {
        const { data } = await this.client.get('/v1/cron/jobs');
        return data;
    }
    async registerCronJob(job) {
        const { data } = await this.client.post('/v1/cron/jobs', job);
        return data;
    }
    async deleteCronJob(jobId) {
        const { data } = await this.client.delete(`/v1/cron/jobs/${jobId}`);
        return data;
    }
    async listSessions() {
        const { data } = await this.client.get('/v1/sessions');
        return data;
    }
    async getSessionMessages(sessionId) {
        const { data } = await this.client.get(`/v1/sessions/${sessionId}/messages`);
        return data;
    }
    async getLlmStatus() {
        try {
            const { data } = await this.client.get('/health');
            return {
                available: data.status === 'ok',
                message: data.llm_available ? 'LLM available' : 'LLM unavailable',
                models: data.llm_model
                    ? [{ id: data.llm_model, name: data.llm_model }]
                    : [],
            };
        }
        catch {
            return { available: false, message: 'Python Agent unreachable' };
        }
    }
    async getAgentStatus() {
        const { data } = await this.client.get('/v1/status');
        return data;
    }
    async getTrajectoryData(query = {}) {
        const { data } = await this.client.get('/v1/trajectory', { params: query });
        return data;
    }
    async getMetrics() {
        const { data } = await this.client.get('/v1/metrics');
        return data;
    }
    async getInsights() {
        const { data } = await this.client.get('/v1/evolution/insights');
        return data;
    }
    async getEvolutionMetrics() {
        const { data } = await this.client.get('/v1/evolution/metrics');
        return data;
    }
    async healthCheck() {
        try {
            const { status } = await this.client.get('/health');
            this.healthy = status === 200;
            return this.healthy;
        }
        catch {
            this.healthy = false;
            return false;
        }
    }
    isHealthy() {
        return this.healthy;
    }
    // ── MCP 服务器管理（代理到 Python agent.mcp，AGENT_BACKEND=python 主实现）──
    /** 列出所有 MCP 服务器及其状态 → Record<name, status> */
    async getMcpServersStatus() {
        var _a;
        const { data } = await this.client.get('/v1/mcp/servers');
        const servers = (_a = data === null || data === void 0 ? void 0 : data.servers) !== null && _a !== void 0 ? _a : [];
        const map = {};
        for (const s of servers) {
            const name = s.name;
            const { name: _n, ...status } = s;
            map[name] = status;
        }
        return map;
    }
    /** 获取单个 MCP 服务器状态 */
    async getMcpServerStatus(name) {
        var _a;
        const { data } = await this.client.get(`/v1/mcp/servers/${encodeURIComponent(name)}/status`);
        return (_a = data === null || data === void 0 ? void 0 : data.status) !== null && _a !== void 0 ? _a : data;
    }
    /** 启动指定 MCP 服务器，返回是否成功 */
    async startMcpServer(name) {
        const { data } = await this.client.post(`/v1/mcp/servers/${encodeURIComponent(name)}/start`);
        return Boolean(data === null || data === void 0 ? void 0 : data.success);
    }
    /** 停止指定 MCP 服务器，返回是否成功 */
    async stopMcpServer(name) {
        const { data } = await this.client.post(`/v1/mcp/servers/${encodeURIComponent(name)}/stop`);
        return Boolean(data === null || data === void 0 ? void 0 : data.success);
    }
    /** 启动所有已启用的 MCP 服务器 */
    async startAllMcpServers() {
        var _a, _b;
        const { data } = await this.client.post('/v1/mcp/servers/start-all');
        return { running: (_a = data === null || data === void 0 ? void 0 : data.running) !== null && _a !== void 0 ? _a : 0, total: (_b = data === null || data === void 0 ? void 0 : data.total) !== null && _b !== void 0 ? _b : 0 };
    }
    /** 停止所有运行的 MCP 服务器 */
    async stopAllMcpServers() {
        const running = await this.getRunningMcpServers();
        await Promise.all(running.map((name) => this.stopMcpServer(name)));
    }
    /** 当前运行的 MCP 服务器名称列表 */
    async getRunningMcpServers() {
        const status = await this.getMcpServersStatus();
        return Object.entries(status)
            .filter(([, s]) => Boolean(s.running))
            .map(([name]) => name);
    }
    /** 当前运行的 MCP 服务器数量 */
    async getRunningMcpServerCount() {
        return (await this.getRunningMcpServers()).length;
    }
    /** 已注册 MCP 服务器总数 */
    async getMcpServerCount() {
        var _a, _b, _c;
        const { data } = await this.client.get('/v1/mcp/servers');
        return (_c = (_a = data === null || data === void 0 ? void 0 : data.total) !== null && _a !== void 0 ? _a : (_b = data === null || data === void 0 ? void 0 : data.servers) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0;
    }
    /** 列出指定 MCP 服务器的工具 */
    async listMcpTools(name) {
        var _a;
        const { data } = await this.client.get(`/v1/mcp/servers/${encodeURIComponent(name)}/tools`);
        return (_a = data === null || data === void 0 ? void 0 : data.tools) !== null && _a !== void 0 ? _a : [];
    }
    /** 调用指定 MCP 服务器的工具 */
    async callMcpTool(name, tool, args = {}) {
        var _a;
        const { data } = await this.client.post(`/v1/mcp/servers/${encodeURIComponent(name)}/tools/call`, { tool_name: tool, arguments: args });
        return (_a = data === null || data === void 0 ? void 0 : data.result) !== null && _a !== void 0 ? _a : data;
    }
    /** 向指定 MCP 服务器发送原始 JSON-RPC 消息（透传） */
    async sendMcpMessage(name, message) {
        var _a;
        const { data } = await this.client.post(`/v1/mcp/servers/${encodeURIComponent(name)}/message`, { message });
        return (_a = data === null || data === void 0 ? void 0 : data.response) !== null && _a !== void 0 ? _a : data;
    }
    /**
     * W3：把真实设备网关（HttpDeviceAdapter）拉取到的设备状态推送至 Python 环境感通道。
     * TS 仅入口/透传（AGENTS.md §0.1），Python 端经 ``POST /v1/devices/telemetry`` 写入
     * ``DeviceSenseChannel``，进而灌入 ``SensoryFusion``。
     */
    async postDeviceTelemetry(payloads) {
        var _a;
        const { data } = await this.client.post('/v1/devices/telemetry', {
            statuses: payloads,
        });
        return {
            ok: Boolean(data === null || data === void 0 ? void 0 : data.ok),
            ingested: Number((_a = data === null || data === void 0 ? void 0 : data.ingested) !== null && _a !== void 0 ? _a : 0),
        };
    }
    /**
     * D2 认知信号回灌: 把 TS 侧认知工具的 cognition_result 转发到 Python
     * POST /v1/cognition/signal, 由 Python ReAct 循环注入会话级 LLM 上下文
     * (元认知回灌: 如高负向情绪降速、反思建议进 evolution)。
     */
    async sendCognitionSignal(sessionId, payload) {
        try {
            await this.client.post('/v1/cognition/signal', {
                session_id: sessionId,
                tool: payload.tool,
                category: payload.category,
                success: payload.success,
                duration_ms: payload.durationMs,
                output_preview: payload.outputPreview,
                error: payload.error,
                timestamp: payload.timestamp,
            });
        }
        catch (error) {
            // 转发失败静默降级 (不阻断认知工具主链路), 仅 debug 记录
            Logger_1.Logger.debug(`⚠️ D2: 认知信号转发失败 (${sessionId}): ${error.message}`, 'PythonAgentBridge');
        }
    }
    /** 注册一个新的 MCP 服务器配置 */
    async registerMcpServer(config) {
        await this.client.post('/v1/mcp/register', config);
    }
    /** 列出指定 MCP 服务器的资源 */
    async listMcpResources(name) {
        var _a;
        const { data } = await this.client.get(`/v1/mcp/servers/${encodeURIComponent(name)}/resources`);
        return (_a = data === null || data === void 0 ? void 0 : data.resources) !== null && _a !== void 0 ? _a : [];
    }
    /** 读取指定 MCP 服务器的资源内容 */
    async readMcpResource(name, uri) {
        var _a;
        const { data } = await this.client.post(`/v1/mcp/servers/${encodeURIComponent(name)}/resources/read`, { uri });
        return (_a = data === null || data === void 0 ? void 0 : data.contents) !== null && _a !== void 0 ? _a : data;
    }
    /** 列出指定 MCP 服务器的提示模板 */
    async listMcpPrompts(name) {
        var _a;
        const { data } = await this.client.get(`/v1/mcp/servers/${encodeURIComponent(name)}/prompts`);
        return (_a = data === null || data === void 0 ? void 0 : data.prompts) !== null && _a !== void 0 ? _a : [];
    }
    /** 获取指定 MCP 服务器的提示内容 */
    async getMcpPrompt(name, promptName, args) {
        var _a;
        const { data } = await this.client.post(`/v1/mcp/servers/${encodeURIComponent(name)}/prompts/get`, { name: promptName, arguments: args });
        return (_a = data === null || data === void 0 ? void 0 : data.messages) !== null && _a !== void 0 ? _a : data;
    }
    // ── LLM 桥接（代理到 Python agent/llm，第一批：chat/chatWithTools/health/model/mark/reset）──
    async llmChat(message, history = [], systemPrompt) {
        var _a;
        const { data } = await this.client.post('/v1/llm/chat', {
            message,
            history,
            system_prompt: systemPrompt !== null && systemPrompt !== void 0 ? systemPrompt : null,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM chat failed');
        }
        return (_a = data.content) !== null && _a !== void 0 ? _a : '';
    }
    async llmChatWithTools(messages, tools, maxTokens = 4096, toolChoice = 'auto') {
        var _a, _b;
        const { data } = await this.client.post('/v1/llm/chat-with-tools', {
            messages,
            tools,
            max_tokens: maxTokens,
            tool_choice: toolChoice,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM chatWithTools failed');
        }
        return {
            content: (_a = data.content) !== null && _a !== void 0 ? _a : '',
            toolCalls: (_b = data.tool_calls) !== null && _b !== void 0 ? _b : undefined,
        };
    }
    async llmHealthCheck() {
        var _a;
        try {
            const { data } = await this.client.get('/v1/llm/health');
            return {
                available: Boolean(data === null || data === void 0 ? void 0 : data.available),
                message: (_a = data === null || data === void 0 ? void 0 : data.message) !== null && _a !== void 0 ? _a : '',
            };
        }
        catch {
            return { available: false, message: 'Python LLM unreachable' };
        }
    }
    async llmGetModelName() {
        var _a;
        const { data } = await this.client.get('/v1/llm/model');
        return (_a = data === null || data === void 0 ? void 0 : data.model) !== null && _a !== void 0 ? _a : 'unknown';
    }
    async llmMarkUnavailable(reason) {
        await this.client.post('/v1/llm/mark-unavailable', {
            reason: reason !== null && reason !== void 0 ? reason : '',
        });
    }
    async llmResetAvailability() {
        await this.client.post('/v1/llm/reset-availability');
    }
    // ── LLM 桥接 第二批：stream / multimodal / code ─────────────────
    async llmStreamChat(messages, systemPrompt, tools) {
        const { data } = await this.client.post('/v1/llm/stream-chat', {
            messages,
            system_prompt: systemPrompt !== null && systemPrompt !== void 0 ? systemPrompt : null,
            tools: tools !== null && tools !== void 0 ? tools : null,
        }, { responseType: 'stream' });
        return data;
    }
    async llmMultimodalChat(message, images = [], history = []) {
        var _a;
        const { data } = await this.client.post('/v1/llm/multimodal-chat', {
            message,
            images,
            history,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM multimodalChat failed');
        }
        return (_a = data.content) !== null && _a !== void 0 ? _a : '';
    }
    async llmMultimodalCodeAnalysis(userQuery, images, filePath) {
        var _a;
        const { data } = await this.client.post('/v1/llm/multimodal-code-analysis', {
            user_query: userQuery,
            images,
            file_path: filePath !== null && filePath !== void 0 ? filePath : null,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM multimodalCodeAnalysis failed');
        }
        return (_a = data.content) !== null && _a !== void 0 ? _a : '';
    }
    async llmCodeAnalyze(filePath, content, userQuery) {
        var _a;
        const { data } = await this.client.post('/v1/llm/code-analyze', {
            file_path: filePath,
            content,
            user_query: userQuery,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM codeAnalyze failed');
        }
        return (_a = data.content) !== null && _a !== void 0 ? _a : '';
    }
    async llmCodeModificationPlan(filePath, content, userQuery) {
        var _a;
        const { data } = await this.client.post('/v1/llm/code-modification-plan', {
            file_path: filePath,
            content,
            user_query: userQuery,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM codeModificationPlan failed');
        }
        return (_a = data.content) !== null && _a !== void 0 ? _a : '';
    }
    async llmCodeModifiedContent(filePath, currentContent, userRequest, fileExists = true) {
        var _a;
        const { data } = await this.client.post('/v1/llm/code-modified-content', {
            file_path: filePath,
            current_content: currentContent,
            user_request: userRequest,
            file_exists: fileExists,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM codeModifiedContent failed');
        }
        return (_a = data.content) !== null && _a !== void 0 ? _a : '';
    }
    async llmDevGenerateCode(userRequest, filePath, existingContent) {
        var _a;
        const { data } = await this.client.post('/v1/llm/dev-generate-code', {
            user_request: userRequest,
            file_path: filePath !== null && filePath !== void 0 ? filePath : null,
            existing_content: existingContent !== null && existingContent !== void 0 ? existingContent : null,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'LLM devGenerateCode failed');
        }
        return (_a = data.content) !== null && _a !== void 0 ? _a : '';
    }
    // ── Memory 桥接（代理到 Python agent/memory）───────────────────
    async memoryStoreShortTerm(content, scene, emotion) {
        var _a;
        const { data } = await this.client.post('/v1/memory/store-short-term', {
            content,
            scene: scene !== null && scene !== void 0 ? scene : '',
            emotion: emotion !== null && emotion !== void 0 ? emotion : 'neutral',
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory storeShortTerm failed');
        }
        return (_a = data.id) !== null && _a !== void 0 ? _a : '';
    }
    async memoryStoreLongTerm(content, scene, emotion) {
        var _a;
        const { data } = await this.client.post('/v1/memory/store-long-term', {
            content,
            scene: scene !== null && scene !== void 0 ? scene : '',
            emotion: emotion !== null && emotion !== void 0 ? emotion : 'neutral',
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory storeLongTerm failed');
        }
        return (_a = data.id) !== null && _a !== void 0 ? _a : '';
    }
    async memoryStoreInstant(content, scene, emotion) {
        var _a;
        const { data } = await this.client.post('/v1/memory/store-instant', {
            content,
            scene: scene !== null && scene !== void 0 ? scene : '',
            emotion: emotion !== null && emotion !== void 0 ? emotion : 'neutral',
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory storeInstant failed');
        }
        return (_a = data.id) !== null && _a !== void 0 ? _a : '';
    }
    async memoryStoreFeedback(data) {
        var _a, _b, _c, _d, _e, _f;
        const { data: resp } = await this.client.post('/v1/memory/store-feedback', {
            trace_id: (_a = data.traceId) !== null && _a !== void 0 ? _a : null,
            tool_name: (_b = data.toolName) !== null && _b !== void 0 ? _b : null,
            feedback_type: data.feedbackType,
            rating: (_c = data.rating) !== null && _c !== void 0 ? _c : null,
            message: (_d = data.message) !== null && _d !== void 0 ? _d : null,
            user_id: (_e = data.userId) !== null && _e !== void 0 ? _e : null,
            timestamp: (_f = data.timestamp) !== null && _f !== void 0 ? _f : null,
        });
        if (!(resp === null || resp === void 0 ? void 0 : resp.success)) {
            throw new Error((resp === null || resp === void 0 ? void 0 : resp.error) || 'Memory storeFeedback failed');
        }
    }
    async memoryStoreEpisodic(content, options) {
        var _a, _b, _c, _d;
        const { data } = await this.client.post('/v1/memory/store-episodic', {
            content,
            importance: (_a = options === null || options === void 0 ? void 0 : options.importance) !== null && _a !== void 0 ? _a : null,
            tags: (_b = options === null || options === void 0 ? void 0 : options.tags) !== null && _b !== void 0 ? _b : null,
            scene: (_c = options === null || options === void 0 ? void 0 : options.scene) !== null && _c !== void 0 ? _c : null,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory storeEpisodic failed');
        }
        return (_d = data.id) !== null && _d !== void 0 ? _d : '';
    }
    async memoryHybridRetrieval(query, scene, emotion, topK = 10) {
        var _a;
        const { data } = await this.client.post('/v1/memory/hybrid-retrieval', {
            query,
            scene: scene !== null && scene !== void 0 ? scene : null,
            emotion: emotion !== null && emotion !== void 0 ? emotion : null,
            top_k: topK,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory hybridRetrieval failed');
        }
        return (_a = data.results) !== null && _a !== void 0 ? _a : [];
    }
    async memoryGetUserProfile() {
        var _a;
        const { data } = await this.client.get('/v1/memory/user-profile');
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            return {};
        }
        return (_a = data.profile) !== null && _a !== void 0 ? _a : {};
    }
    async memoryUpdate(memoryId, updates) {
        var _a, _b, _c, _d;
        const { data } = await this.client.post('/v1/memory/update', {
            memory_id: memoryId,
            content: (_a = updates.content) !== null && _a !== void 0 ? _a : null,
            scene: (_b = updates.scene) !== null && _b !== void 0 ? _b : null,
            emotion: (_c = updates.emotion) !== null && _c !== void 0 ? _c : null,
            metadata: (_d = updates.metadata) !== null && _d !== void 0 ? _d : null,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory update failed');
        }
    }
    async memoryRetrieveContext(query, userId, limit = 10) {
        var _a;
        const { data } = await this.client.post('/v1/memory/retrieve-context', {
            query,
            user_id: userId !== null && userId !== void 0 ? userId : null,
            limit,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory retrieveContext failed');
        }
        return (_a = data.results) !== null && _a !== void 0 ? _a : [];
    }
    async memoryQueryRecentFeedback(hours = 24) {
        var _a;
        const { data } = await this.client.post('/v1/memory/query-recent-feedback', {
            hours,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory queryRecentFeedback failed');
        }
        return (_a = data.results) !== null && _a !== void 0 ? _a : [];
    }
    async memoryCalculateDecayScore(memoryType, timestamp, accessCount = 0, importance = 5.0) {
        var _a;
        const { data } = await this.client.post('/v1/memory/decay-score', {
            memory_type: memoryType,
            timestamp,
            access_count: accessCount,
            importance,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory decay score calculation failed');
        }
        return (_a = data.decay_score) !== null && _a !== void 0 ? _a : 0;
    }
    async memoryUpdateDecayScores(batchSize = 100) {
        var _a;
        const { data } = await this.client.post('/v1/memory/update-decay-scores', null, {
            params: { batch_size: batchSize },
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory decay scores update failed');
        }
        return (_a = data.updated) !== null && _a !== void 0 ? _a : 0;
    }
    async memoryPerformDream() {
        var _a;
        const { data } = await this.client.post('/v1/memory/dream');
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory dream failed');
        }
        return (_a = data.stats) !== null && _a !== void 0 ? _a : {};
    }
    async memoryGetDreamStats() {
        var _a;
        const { data } = await this.client.get('/v1/memory/dream-stats');
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory dream stats failed');
        }
        return (_a = data.stats) !== null && _a !== void 0 ? _a : {};
    }
    async memoryBuildKnowledgeGraph(limit = 100) {
        var _a, _b;
        const { data } = await this.client.get('/v1/memory/knowledge-graph', {
            params: { limit },
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory knowledge graph failed');
        }
        return { nodes: (_a = data.nodes) !== null && _a !== void 0 ? _a : [], edges: (_b = data.edges) !== null && _b !== void 0 ? _b : [] };
    }
    async memoryStoreEncrypted(content, memoryType = 'long_term', scene = '', emotion = 'neutral') {
        var _a;
        const { data } = await this.client.post('/v1/memory/store-encrypted', {
            content,
            memory_type: memoryType,
            scene,
            emotion,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory store encrypted failed');
        }
        return (_a = data.id) !== null && _a !== void 0 ? _a : '';
    }
    async memoryStoreWithTrace(content, traceId, memoryType = 'short_term', scene = '', emotion = 'neutral') {
        var _a;
        const { data } = await this.client.post('/v1/memory/store-with-trace', {
            content,
            trace_id: traceId,
            memory_type: memoryType,
            scene,
            emotion,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory store with trace failed');
        }
        return (_a = data.id) !== null && _a !== void 0 ? _a : '';
    }
    async memorySearchByTrace(traceId) {
        var _a;
        const { data } = await this.client.post('/v1/memory/search-by-trace', {
            trace_id: traceId,
        });
        if (!(data === null || data === void 0 ? void 0 : data.success)) {
            throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Memory search by trace failed');
        }
        return (_a = data.results) !== null && _a !== void 0 ? _a : [];
    }
    // ── 浏览器/桌面自动化 桥接 ────────────────
    /**
     * 浏览器自动化操作
     *
     * 代理到 Python POST /api/browser/action，执行网页导航、点击、输入等浏览器操作。
     *
     * @param params - 浏览器操作参数
     * @param params.action - 操作类型（如 navigate、click、type、screenshot 等）
     * @param params.url - 目标 URL（navigate 操作时必填）
     * @param params.selector - CSS 选择器（click/type 操作时必填）
     * @param params.value - 输入值（type 操作时必填）
     * @returns 操作执行结果
     * @throws {Error} Python Agent 不可用或操作执行失败时抛出
     */
    async browserAction(params) {
        var _a, _b, _c, _d;
        try {
            const { data } = await this.client.post('/api/browser/action', {
                action: params.action,
                url: (_a = params.url) !== null && _a !== void 0 ? _a : null,
                selector: (_b = params.selector) !== null && _b !== void 0 ? _b : null,
                value: (_c = params.value) !== null && _c !== void 0 ? _c : null,
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Browser action failed');
            }
            return (_d = data.result) !== null && _d !== void 0 ? _d : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`浏览器自动化操作失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`浏览器自动化操作失败: ${err.message}`);
        }
    }
    /**
     * 桌面自动化操作
     *
     * 代理到 Python POST /api/desktop/action，执行窗口管理、键盘鼠标模拟等桌面操作。
     *
     * @param params - 桌面操作参数
     * @param params.action - 操作类型（如 click、type、screenshot、launch 等）
     * @param params.target - 操作目标（窗口标题、坐标等）
     * @param params.value - 输入值（type 操作时使用）
     * @returns 操作执行结果
     * @throws {Error} Python Agent 不可用或操作执行失败时抛出
     */
    async desktopAction(params) {
        var _a, _b, _c;
        try {
            const { data } = await this.client.post('/api/desktop/action', {
                action: params.action,
                target: (_a = params.target) !== null && _a !== void 0 ? _a : null,
                value: (_b = params.value) !== null && _b !== void 0 ? _b : null,
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Desktop action failed');
            }
            return (_c = data.result) !== null && _c !== void 0 ? _c : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`桌面自动化操作失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`桌面自动化操作失败: ${err.message}`);
        }
    }
    // ── 工具集/安全/重构 桥接 ──────────────────
    /**
     * 代码重构操作
     *
     * 代理到 Python POST /api/tools/execute，通过 tool_name 路由到具体重构工具。
     * 支持的重构类型：refactor_rename（重命名）、refactor_extract（提取函数/变量）、
     * refactor_move（移动）、refactor_preview（预览重构变更）。
     *
     * @param params - 重构操作参数
     * @param params.tool_name - 重构工具名称（refactor_rename / refactor_extract / refactor_move / refactor_preview）
     * @param params - 其余参数根据 tool_name 不同而异，直接透传给 Python 端
     * @returns 重构执行结果（预览或实际变更）
     * @throws {Error} Python Agent 不可用或重构操作失败时抛出
     */
    async refactorCode(params) {
        var _a;
        try {
            const { tool_name, ...toolParams } = params;
            const { data } = await this.client.post('/api/tools/execute', {
                tool_name,
                params: toolParams,
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Refactor code failed');
            }
            return (_a = data.result) !== null && _a !== void 0 ? _a : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`代码重构操作失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`代码重构操作失败: ${err.message}`);
        }
    }
    /**
     * 多模态视觉分析
     *
     * 代理到 Python POST /api/tools/execute，调用 vision_understand 工具
     * 对图片进行理解和分析。
     *
     * @param params - 视觉分析参数
     * @param params.image_path - 待分析的图片路径
     * @param params.prompt - 分析提示词（描述想了解的图片内容）
     * @returns 视觉分析结果文本
     * @throws {Error} Python Agent 不可用或视觉分析失败时抛出
     */
    async visionAnalysis(params) {
        var _a, _b, _c;
        try {
            const { data } = await this.client.post('/api/tools/execute', {
                tool_name: 'vision_understand',
                params: {
                    image_path: (_a = params.image_path) !== null && _a !== void 0 ? _a : null,
                    prompt: (_b = params.prompt) !== null && _b !== void 0 ? _b : null,
                },
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Vision analysis failed');
            }
            return (_c = data.result) !== null && _c !== void 0 ? _c : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`多模态视觉分析失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`多模态视觉分析失败: ${err.message}`);
        }
    }
    /**
     * 工具集列表查询
     *
     * 代理到 Python GET /api/tools/list，按分类和场景筛选可用工具。
     *
     * @param params - 查询参数
     * @param params.category - 工具分类（如 browser、desktop、code 等）
     * @param params.scene - 使用场景（如 development、testing 等）
     * @returns 工具列表
     * @throws {Error} Python Agent 不可用或查询失败时抛出
     */
    async toolsetList(params) {
        var _a, _b, _c;
        try {
            const { data } = await this.client.get('/api/tools/list', {
                params: {
                    category: (_a = params.category) !== null && _a !== void 0 ? _a : undefined,
                    scene: (_b = params.scene) !== null && _b !== void 0 ? _b : undefined,
                },
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Toolset list failed');
            }
            return (_c = data.tools) !== null && _c !== void 0 ? _c : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`工具集列表查询失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`工具集列表查询失败: ${err.message}`);
        }
    }
    /**
     * 工具执行
     *
     * 代理到 Python POST /api/tools/execute，按名称调用指定工具并传入参数。
     *
     * @param params - 工具执行参数
     * @param params.tool_name - 要执行的工具名称
     * @param params.params - 工具执行参数对象
     * @returns 工具执行结果
     * @throws {Error} Python Agent 不可用或工具执行失败时抛出
     */
    async toolsetExecute(params) {
        var _a;
        try {
            const { data } = await this.client.post('/api/tools/execute', {
                tool_name: params.tool_name,
                params: params.params,
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Toolset execute failed');
            }
            return (_a = data.result) !== null && _a !== void 0 ? _a : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`工具执行失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`工具执行失败: ${err.message}`);
        }
    }
    /**
     * 工具执行(原始响应, 不吞逻辑失败)。
     *
     * 与 toolsetExecute 不同: 仅当传输层出错(网络/连接)时抛异常; 若 Python 端
     * 返回 success=false(含安全策略拒绝), 直接把原始响应体返回, 由调用方决定
     * 是否降级。F1 归一 Phase1 shell_exec 代理依赖此语义以区分"Python 拒绝命令"
     * 与"Python 不可用"——前者必须诚实返回(绝不回退到更宽松的 TS 本地执行)。
     *
     * @param toolName - 工具名称
     * @param params - 工具执行参数
     * @returns 原始响应 { success, output?, error?, duration?, metadata? }
     * @throws 仅当传输层失败时抛出
     */
    async toolsetExecuteRaw(toolName, params) {
        try {
            const { data } = await this.client.post('/api/tools/execute', {
                tool_name: toolName,
                params,
            });
            return data;
        }
        catch (error) {
            Logger_1.Logger.debug(`⚠️ toolsetExecuteRaw 传输失败 (${toolName}): ${error.message}`, 'PythonAgentBridge');
            throw error;
        }
    }
    /**
     * 安全检查
     *
     * 代理到 Python POST /api/security/check，对指定目标执行安全扫描。
     *
     * @param params - 安全检查参数
     * @param params.target - 检查目标（文件路径、代码片段、URL 等）
     * @param params.check_type - 检查类型（如 xss、sql_injection、secrets 等）
     * @returns 安全检查结果，包含发现的问题和风险等级
     * @throws {Error} Python Agent 不可用或安全检查失败时抛出
     */
    async securityCheck(params) {
        var _a, _b;
        try {
            const { data } = await this.client.post('/api/security/check', {
                target: params.target,
                check_type: (_a = params.check_type) !== null && _a !== void 0 ? _a : null,
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Security check failed');
            }
            return (_b = data.result) !== null && _b !== void 0 ? _b : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`安全检查失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`安全检查失败: ${err.message}`);
        }
    }
    /**
     * 混合记忆检索
     *
     * 代理到 Python POST /api/memory/search-hybrid，结合全文检索和向量检索
     * 返回最相关的记忆条目。
     *
     * @param params - 检索参数
     * @param params.query - 检索查询文本
     * @param params.n_results - 返回结果数量（默认 10）
     * @param params.use_vector - 是否启用向量检索（默认 true）
     * @returns 混合检索结果列表
     * @throws {Error} Python Agent 不可用或检索失败时抛出
     */
    async hybridMemorySearch(params) {
        var _a, _b, _c;
        try {
            const { data } = await this.client.post('/api/memory/search-hybrid', {
                query: params.query,
                n_results: (_a = params.n_results) !== null && _a !== void 0 ? _a : 10,
                use_vector: (_b = params.use_vector) !== null && _b !== void 0 ? _b : true,
            });
            if (!(data === null || data === void 0 ? void 0 : data.success)) {
                throw new Error((data === null || data === void 0 ? void 0 : data.error) || 'Hybrid memory search failed');
            }
            return (_c = data.results) !== null && _c !== void 0 ? _c : data;
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error(`混合记忆检索失败: ${err.message}`, err, 'PythonAgentBridge');
            throw new Error(`混合记忆检索失败: ${err.message}`);
        }
    }
    // ── WS 流式聊天通道 ───────────────────────
    /**
     * 建立聊天 WebSocket 连接 (ws_root)
     * 与 EventBus WS (/v1/events) 分开，用于流式对话
     */
    connectChatWs() {
        var _a;
        if (this._disconnected)
            return;
        const wsUrl = (_a = this.client.defaults.baseURL) === null || _a === void 0 ? void 0 : _a.replace('http', 'ws');
        if (!wsUrl)
            return;
        try {
            this.chatWs = new ws_1.default(`${wsUrl}/`);
            this.chatWs.on('open', () => {
                Logger_1.Logger.info('Python Agent Chat WS 已连接', 'PythonAgentBridge');
                this._chatReconnectDelay = 1000; // 重置退避
            });
            this.chatWs.on('message', (raw) => {
                try {
                    const rawStr = raw.toString();
                    const parsed = JSON.parse(rawStr);
                    // 统一消息协议路由：支持 UnifiedBridgeMessage 和旧版 StreamEvent
                    if (parsed &&
                        typeof parsed.type === 'string' &&
                        ['chat', 'event', 'mcp_sync', 'ping', 'pong', 'cancel'].includes(parsed.type)) {
                        this._handleUnifiedMessage(parsed);
                    }
                    else {
                        const event = parsed;
                        this._handleChatEvent(event);
                    }
                }
                catch {
                    // ignore parse errors
                }
            });
            this.chatWs.on('error', (err) => {
                Logger_1.Logger.warn(`Python Agent Chat WS 错误: ${err.message}`, 'PythonAgentBridge');
            });
            this.chatWs.on('close', () => {
                Logger_1.Logger.info('Python Agent Chat WS 已断开', 'PythonAgentBridge');
                this.chatWs = null;
                // 清理所有未完成请求
                this._failAllPending(new Error('Chat WS 连接断开'));
                // 指数退避重连
                this._scheduleChatReconnect();
            });
            this.chatWs.on('unexpected-response', () => {
                var _a;
                Logger_1.Logger.warn('Python Agent Chat WS 意外响应，将重连', 'PythonAgentBridge');
                (_a = this.chatWs) === null || _a === void 0 ? void 0 : _a.close();
                this.chatWs = null;
            });
        }
        catch (error) {
            Logger_1.Logger.warn(`Python Agent Chat WS 连接失败: ${error.message}`, 'PythonAgentBridge');
            this._scheduleChatReconnect();
        }
    }
    /** 检查 chat WS 是否就绪 */
    isChatReady() {
        var _a;
        return ((_a = this.chatWs) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.OPEN;
    }
    // ── EventBus 双向同步 ─────────────────────
    setTsEventBusForward(forwardFn) {
        this.tsEventBusForward = forwardFn;
    }
    connectEvents() {
        var _a;
        if (this._disconnected)
            return; // 已主动断开，不重连
        const wsUrl = (_a = this.client.defaults.baseURL) === null || _a === void 0 ? void 0 : _a.replace('http', 'ws');
        if (!wsUrl)
            return;
        try {
            this.ws = new ws_1.default(`${wsUrl}/v1/events`);
            this.ws.on('open', () => {
                Logger_1.Logger.info('Python Agent EventBus WS 已连接', 'PythonAgentBridge');
                this._eventReconnectDelay = 1000; // 重置退避
            });
            this.ws.on('message', (raw) => {
                try {
                    const { event, payload } = JSON.parse(raw.toString());
                    const handlers = this.eventHandlers.get(event);
                    if (handlers) {
                        handlers.forEach((h) => h(payload));
                    }
                    if (this.tsEventBusForward) {
                        this.tsEventBusForward(event, payload);
                    }
                }
                catch {
                    // ignore parse errors
                }
            });
            this.ws.on('error', (err) => {
                Logger_1.Logger.warn(`Python Agent EventBus WS 错误: ${err.message}`, 'PythonAgentBridge');
            });
            this.ws.on('close', () => {
                Logger_1.Logger.info('Python Agent EventBus WS 已断开', 'PythonAgentBridge');
                this.ws = null;
                if (this._disconnected)
                    return;
                const delay = this._eventReconnectDelay;
                this._eventReconnectDelay = Math.min(this._eventReconnectDelay * 2, 30000);
                Logger_1.Logger.info(`EventBus WS ${delay}ms 后指数退避重连 (下次: ${this._eventReconnectDelay}ms)`, 'PythonAgentBridge');
                setTimeout(() => {
                    if (!this._disconnected &&
                        (this.eventHandlers.size > 0 || this.tsEventBusForward)) {
                        this.connectEvents();
                    }
                }, delay);
            });
            this.ws.on('unexpected-response', () => {
                var _a;
                Logger_1.Logger.warn('Python Agent EventBus WS 意外响应，将重连', 'PythonAgentBridge');
                (_a = this.ws) === null || _a === void 0 ? void 0 : _a.close();
                this.ws = null;
            });
        }
        catch (error) {
            Logger_1.Logger.warn(`Python Agent EventBus WS 连接失败: ${error.message}`, 'PythonAgentBridge');
        }
    }
    onEvent(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event).add(handler);
    }
    emitEvent(event, payload) {
        var _a;
        if (((_a = this.ws) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.OPEN) {
            this.ws.send(JSON.stringify({ event, payload }));
        }
    }
    forwardTsEvent(event, payload) {
        this.emitEvent(event, payload);
    }
    disconnect() {
        var _a, _b;
        this._disconnected = true;
        this.tsEventBusForward = null;
        // 断开 EventBus WS
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.eventHandlers.clear();
        // 断开 Chat WS
        if (this.chatWs) {
            this.chatWs.close();
            this.chatWs = null;
        }
        this._failAllPending(new Error('Bridge 已断开'));
        // 清理重连定时器
        if (this._chatReconnectTimer) {
            clearTimeout(this._chatReconnectTimer);
            this._chatReconnectTimer = null;
        }
        // 销毁 HTTP 连接池
        (_a = this.client.defaults.httpAgent) === null || _a === void 0 ? void 0 : _a.destroy();
        (_b = this.client.defaults.httpsAgent) === null || _b === void 0 ? void 0 : _b.destroy();
    }
    // ── 私有方法 ──────────────────────────────
    /** HTTP 回退处理 — 失败时抛出 BridgeError */
    async _processInputViaHttp(message, sessionId, traceId, images) {
        var _a;
        // 生成 requestId，与 WS 路径保持一致
        const requestId = `chat_${++this._requestIdCounter}_${Date.now()}`;
        // 跨语言追踪：通过x-trace-id header将traceId透传给Python后端
        const headers = {};
        if (traceId) {
            headers['x-trace-id'] = traceId;
        }
        try {
            const { data } = await this.client.post('/v1/chat', {
                message,
                session_id: sessionId,
                trace_id: traceId,
                request_id: requestId,
                images: images !== null && images !== void 0 ? images : [],
            }, { headers });
            return {
                response: data.content || '',
                traceId: (_a = data.trace_id) !== null && _a !== void 0 ? _a : traceId,
                intent: data.intent,
            };
        }
        catch (error) {
            const err = error;
            Logger_1.Logger.error('Python Agent 聊天请求失败', err, 'PythonAgentBridge');
            throw new BridgeError('http_request', err, false, this.healthy);
        }
    }
    /** WS 流式处理 */
    _processInputViaWs(message, sessionId, traceId, images) {
        return new Promise((resolve, reject) => {
            const requestId = `chat_${++this._requestIdCounter}_${Date.now()}`;
            const contentBuffer = [];
            const timeout = setTimeout(() => {
                this._pendingRequests.delete(requestId);
                reject(new Error(`WS 流式聊天超时 (${this._wsTimeout / 1000}s)`));
            }, this._wsTimeout);
            this._pendingRequests.set(requestId, {
                resolve,
                reject,
                contentBuffer,
                timeout,
            });
            try {
                this.chatWs.send(JSON.stringify({
                    type: 'user_input',
                    message,
                    session_id: sessionId,
                    trace_id: traceId,
                    request_id: requestId,
                    images: images !== null && images !== void 0 ? images : [],
                }));
            }
            catch (err) {
                clearTimeout(timeout);
                this._pendingRequests.delete(requestId);
                reject(err);
            }
        });
    }
    /** 处理来自 Chat WS 的事件 */
    _handleChatEvent(event) {
        // 尝试通过 request_id 路由
        const requestId = event
            .request_id;
        if (requestId) {
            const pending = this._pendingRequests.get(requestId);
            if (pending) {
                if (pending.onStream) {
                    pending.onStream(event);
                }
                else {
                    // 非流式模式：累积内容
                    if (event.type === 'stream_chunk' && event.content) {
                        // 兼容 content 为 {'content': '某字'} 格式
                        const text = typeof event.content === 'string' &&
                            event.content.startsWith("{'content':")
                            ? event.content.replace(/\{'content':\s*'([^']*)'\}/g, '$1')
                            : event.content;
                        pending.contentBuffer.push(text);
                    }
                    else if (event.done || event.type === 'stream_done') {
                        clearTimeout(pending.timeout);
                        pending.resolve({
                            response: event.content || pending.contentBuffer.join('') || '',
                            traceId: event.trace_id,
                        });
                        this._pendingRequests.delete(requestId);
                    }
                    else if (event.type === 'error') {
                        clearTimeout(pending.timeout);
                        pending.reject(new Error(event.content || '未知 WS 错误'));
                        this._pendingRequests.delete(requestId);
                    }
                }
                return;
            }
        }
        // 无对应请求 — 可能是全局事件（如 tool_start 广播），通过 EventBus 转发
        Logger_1.Logger.warn(`Chat event without request_id: type=${event.type}, 无法路由到pending请求`, 'PythonAgentBridge');
        if (this.tsEventBusForward) {
            this.tsEventBusForward(`chat:${event.type}`, event);
        }
    }
    /** 清理所有未完成请求 */
    _failAllPending(err) {
        for (const [, pending] of this._pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(err);
        }
        this._pendingRequests.clear();
    }
    /** 指数退避重连 Chat WS */
    _scheduleChatReconnect() {
        if (this._disconnected || this._chatReconnectTimer)
            return;
        const delay = this._chatReconnectDelay;
        this._chatReconnectDelay = Math.min(this._chatReconnectDelay * 2, 30000);
        Logger_1.Logger.info(`Chat WS ${delay}ms 后重连...`, 'PythonAgentBridge');
        this._chatReconnectTimer = setTimeout(() => {
            this._chatReconnectTimer = null;
            this.connectChatWs();
        }, delay);
    }
    /** 发出降级可观测事件 */
    _emitFallbackEvent(from, to, phase, error) {
        const payload = {
            from,
            to,
            phase,
            error,
            pythonHealthy: this.healthy,
            timestamp: Date.now(),
        };
        try {
            EventBus_1.JiabaixingEventBus.getInstance().emit('bridge:fallback', payload);
        }
        catch {
            // EventBus 不可用时静默，不影响主流程
        }
        Logger_1.Logger.warn(`Bridge 降级: ${from} → ${to} (phase=${phase})`, 'PythonAgentBridge');
    }
    /** 发出不可用可观测事件 */
    _emitUnavailableEvent(phase, error) {
        const payload = {
            phase,
            error,
            timestamp: Date.now(),
        };
        try {
            EventBus_1.JiabaixingEventBus.getInstance().emit('bridge:unavailable', payload);
        }
        catch {
            // EventBus 不可用时静默
        }
        Logger_1.Logger.error(`Bridge 不可用 (phase=${phase}): ${error}`, undefined, 'PythonAgentBridge');
    }
    /** 统一消息协议路由处理器 */
    _handleUnifiedMessage(msg) {
        switch (msg.type) {
            case 'chat': {
                const event = msg.payload;
                this._handleChatEvent(event);
                break;
            }
            case 'event': {
                try {
                    EventBus_1.JiabaixingEventBus.getInstance().emit('bridge:python_event', msg.payload);
                }
                catch {
                    // EventBus 不可用时静默
                }
                break;
            }
            case 'mcp_sync': {
                try {
                    EventBus_1.JiabaixingEventBus.getInstance().emit('bridge:mcp_sync', msg.payload);
                }
                catch {
                    // EventBus 不可用时静默
                }
                break;
            }
            case 'pong': {
                Logger_1.Logger.debug('Bridge pong received', 'PythonAgentBridge');
                break;
            }
            default: {
                Logger_1.Logger.debug(`Unified message type unhandled: ${msg.type}`, 'PythonAgentBridge');
            }
        }
    }
}
exports.PythonAgentBridge = PythonAgentBridge;
