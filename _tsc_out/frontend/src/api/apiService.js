"use strict";
/**
 * API服务层
 * 统一管理所有API请求，确保模块间的数据交互标准一致
 * 所有端点引用共享契约层 contracts.ts，禁止硬编码
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiService = exports.JiabaixingApiService = void 0;
exports.getApiBaseUrl = getApiBaseUrl;
exports.getWsBaseUrl = getWsBaseUrl;
const contracts_1 = require("@shared/contracts");
class ApiService {
    baseUrl;
    cache = new Map();
    defaultCacheExpiry = 5 * 60 * 1000;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    setBaseUrl(baseUrl) {
        this.baseUrl = baseUrl;
    }
    clearCache() {
        this.cache.clear();
    }
    clearCacheForEndpoint(endpoint) {
        const keys = Array.from(this.cache.keys());
        keys.forEach((key) => {
            if (key.startsWith(endpoint)) {
                this.cache.delete(key);
            }
        });
    }
    generateCacheKey(endpoint, params) {
        const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
        return `${endpoint}${queryString}`;
    }
    isCacheValid(cacheKey) {
        const cacheItem = this.cache.get(cacheKey);
        if (!cacheItem)
            return false;
        return Date.now() < cacheItem.timestamp + cacheItem.expiry;
    }
    getCache(cacheKey) {
        if (this.isCacheValid(cacheKey)) {
            return this.cache.get(cacheKey)?.data;
        }
        this.cache.delete(cacheKey);
        return null;
    }
    setCache(cacheKey, data, expiry) {
        this.cache.set(cacheKey, {
            data,
            timestamp: Date.now(),
            expiry: expiry || this.defaultCacheExpiry,
        });
    }
    async request(endpoint, options = {}, cacheExpiry, params) {
        if (options.method === 'GET' || !options.method) {
            const cacheKey = this.generateCacheKey(endpoint, params);
            const cachedData = this.getCache(cacheKey);
            if (cachedData) {
                return { success: true, data: cachedData };
            }
        }
        const maxRetries = 3;
        let retries = 0;
        while (retries < maxRetries) {
            try {
                const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
                const url = `${this.baseUrl}${endpoint}${queryString}`;
                const response = await fetch(url, {
                    ...options,
                    headers: {
                        'Content-Type': 'application/json',
                        ...options.headers,
                    },
                });
                const data = await response.json();
                if (!response.ok) {
                    return {
                        success: false,
                        error: data.error || `HTTP Error: ${response.status}`,
                    };
                }
                if (options.method === 'GET' || !options.method) {
                    const cacheKey = this.generateCacheKey(endpoint, params);
                    this.setCache(cacheKey, data, cacheExpiry);
                }
                return { success: true, data };
            }
            catch (error) {
                retries++;
                if (retries >= maxRetries) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error',
                    };
                }
                const delay = Math.pow(2, retries) * 1000;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        return { success: false, error: 'Maximum retries exceeded' };
    }
    async get(endpoint, params, cacheExpiry) {
        return this.request(endpoint, { method: 'GET' }, cacheExpiry, params);
    }
    async post(endpoint, data, timeoutMs = 30000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await this.request(endpoint, {
                method: 'POST',
                body: JSON.stringify(data),
                signal: controller.signal,
            });
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return { success: false, error: `请求超时 (${timeoutMs / 1000}s)，请稍后重试` };
            }
            return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    async put(endpoint, data) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }
    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }
}
class JiabaixingApiService extends ApiService {
    async getHealth() {
        return this.get(contracts_1.API_ENDPOINTS.HEALTH, undefined, 30000);
    }
    async processMessage(input, images, userId) {
        return this.post(contracts_1.API_ENDPOINTS.PROCESS, {
            input,
            images,
            userId,
        }, 60000);
    }
    async processMultimodalMessage(input, images, files) {
        return this.post(contracts_1.API_ENDPOINTS.PROCESS, {
            input,
            images,
            files,
        });
    }
    async uploadFile(file) {
        const formData = new FormData();
        formData.append('file', file);
        try {
            const response = await fetch(`${this.baseUrl}${contracts_1.API_ENDPOINTS.FILE_UPLOAD}`, {
                method: 'POST',
                body: formData,
            });
            return response.json();
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async uploadAudio(file) {
        const formData = new FormData();
        formData.append('audio', file);
        try {
            const response = await fetch(`${this.baseUrl}${contracts_1.API_ENDPOINTS.AUDIO_UPLOAD}`, {
                method: 'POST',
                body: formData,
            });
            return response.json();
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    async getUploadHistory() {
        return this.get(contracts_1.API_ENDPOINTS.FILE_UPLOAD_HISTORY);
    }
    async submitCorrection(toolId, correctionType, reason, severity, traceId) {
        return this.post(contracts_1.API_ENDPOINTS.CORRECT, {
            toolId,
            correctionType,
            reason,
            severity,
            traceId,
        });
    }
    getLogs() {
        return new EventSource(`${this.baseUrl}${contracts_1.API_ENDPOINTS.LOGS_SSE}`);
    }
    async getModels() {
        return this.get(contracts_1.API_ENDPOINTS.MODELS);
    }
    async getModelStatus() {
        return this.get(contracts_1.API_ENDPOINTS.MODELS_STATUS);
    }
    async getModelHealth() {
        return this.get(contracts_1.API_ENDPOINTS.MODELS_HEALTH);
    }
    async switchModel(targetModel, reason) {
        return this.post(contracts_1.API_ENDPOINTS.MODELS_SWITCH, { targetModel, reason });
    }
    async getEvolutionStatus() {
        return this.get(contracts_1.API_ENDPOINTS.EVOLUTION_STATUS);
    }
    async getEvolutionMetrics() {
        return this.get(contracts_1.API_ENDPOINTS.EVOLUTION_METRICS);
    }
    async triggerEvolution(reason) {
        return this.post(contracts_1.API_ENDPOINTS.EVOLUTION_TRIGGER, { reason: reason || '手动触发' });
    }
    async triggerEvolutionCycle() {
        return this.post(contracts_1.API_ENDPOINTS.EVOLUTION_CYCLE);
    }
    async triggerHealing() {
        return this.post(contracts_1.API_ENDPOINTS.EVOLUTION_HEALING);
    }
    async triggerRefactor() {
        return this.post(contracts_1.API_ENDPOINTS.EVOLUTION_REFACTOR);
    }
    async triggerEnhance() {
        return this.post(contracts_1.API_ENDPOINTS.EVOLUTION_ENHANCE);
    }
    async storeMemory(content, userId, importance, tags, emotion, scene) {
        return this.post(contracts_1.API_ENDPOINTS.MEMORY_STORE, {
            content,
            userId,
            importance,
            tags,
            emotion,
            scene,
        });
    }
    async searchMemory(query, userId, limit) {
        return this.get(contracts_1.API_ENDPOINTS.MEMORY_SEARCH, {
            query,
            userId,
            limit: limit || 10,
        });
    }
    async getMemoryProfile(userId) {
        return this.get(contracts_1.API_ENDPOINTS.MEMORY_PROFILE, userId ? { userId } : undefined);
    }
    async updateMemoryPreferences(preferences) {
        return this.post(contracts_1.API_ENDPOINTS.MEMORY_PREFERENCES, { preferences });
    }
    async getMemoryStats() {
        return this.get(contracts_1.API_ENDPOINTS.MEMORY_STATS);
    }
    async getSecurityLogs(limit, level, category) {
        return this.get(contracts_1.API_ENDPOINTS.SECURITY_LOGS, {
            limit: limit || 100,
            level,
            category,
        });
    }
    async validateSecurityInput(input) {
        return this.post(contracts_1.API_ENDPOINTS.SECURITY_VALIDATE, { input });
    }
    async getSecurityAudit(limit, type) {
        return this.get(contracts_1.API_ENDPOINTS.SECURITY_AUDIT, { limit, type });
    }
    async executeSkill(skillName, params, userId) {
        return this.post(contracts_1.API_ENDPOINTS.SKILLS_EXECUTE, {
            skillName,
            params,
            userId,
        });
    }
    async listSkills() {
        return this.get(contracts_1.API_ENDPOINTS.SKILLS_LIST);
    }
    async getPerformanceSnapshot() {
        return this.get(contracts_1.API_ENDPOINTS.PERFORMANCE_SNAPSHOT);
    }
    async getPerformanceMetrics(limit) {
        return this.get(contracts_1.API_ENDPOINTS.PERFORMANCE_METRICS, {
            limit: limit || 100,
        });
    }
    async getPerformanceErrors(limit) {
        return this.get(contracts_1.API_ENDPOINTS.PERFORMANCE_ERRORS, {
            limit: limit || 50,
        });
    }
    async getSystemResources() {
        return this.get(contracts_1.API_ENDPOINTS.SYSTEM_RESOURCES);
    }
    async getSystemIntegrity() {
        return this.get(contracts_1.API_ENDPOINTS.SYSTEM_INTEGRITY);
    }
    async getSystemMetrics() {
        return this.get(contracts_1.API_ENDPOINTS.SYSTEM_METRICS);
    }
    async getSystemConfig() {
        return this.get(contracts_1.API_ENDPOINTS.SYSTEM_CONFIG);
    }
    async osvScan(directory, severity) {
        return this.post(contracts_1.API_ENDPOINTS.SYSTEM_OSV_SCAN, { directory, severity });
    }
    async diskCleanup(directory, categories, confirm, dryRun) {
        return this.post(contracts_1.API_ENDPOINTS.SYSTEM_DISK_CLEANUP, { directory, categories, confirm, dryRun });
    }
    async subdirectoryHints(directory, query) {
        return this.get(contracts_1.API_ENDPOINTS.SYSTEM_SUBDIRECTORY_HINTS, {
            directory,
            query,
        });
    }
    async getAutomationTasks() {
        return this.get(contracts_1.API_ENDPOINTS.AUTOMATION_TASKS);
    }
    async createAutomationTask(task) {
        return this.post(contracts_1.API_ENDPOINTS.AUTOMATION_TASKS, task);
    }
    async getAutomationTriggers() {
        return this.get(contracts_1.API_ENDPOINTS.AUTOMATION_TRIGGERS);
    }
    async getAutomationPatterns() {
        return this.get(contracts_1.API_ENDPOINTS.AUTOMATION_PATTERNS);
    }
    async getErrorLogs(hours, level, limit) {
        return this.get(contracts_1.API_ENDPOINTS.LOGS_ERRORS, { hours, level, limit });
    }
    async getLogsQuery(limit, level, module) {
        return this.get(contracts_1.API_ENDPOINTS.LOGS_QUERY, {
            limit,
            level,
            module,
        });
    }
    async getEvolutionInsights() {
        return this.get(contracts_1.API_ENDPOINTS.EVOLUTION_INSIGHTS);
    }
    async getOrchestratorMetrics() {
        return this.get(contracts_1.API_ENDPOINTS.ORCHESTRATOR_METRICS);
    }
    async triggerOrchestratorOptimize() {
        return this.post(contracts_1.API_ENDPOINTS.ORCHESTRATOR_OPTIMIZE);
    }
    async getSecurityEvents(limit) {
        return this.get(contracts_1.API_ENDPOINTS.SECURITY_EVENTS, { limit });
    }
    async getSecurityReport() {
        return this.get(contracts_1.API_ENDPOINTS.SECURITY_REPORT);
    }
    async getLLMPerformance() {
        return this.get(contracts_1.API_ENDPOINTS.LLM_PERFORMANCE);
    }
    async createTask(taskData) {
        return this.post(contracts_1.API_ENDPOINTS.TASKS_CREATE, taskData);
    }
    async listTasks(limit) {
        return this.get(contracts_1.API_ENDPOINTS.TASKS_LIST, { limit });
    }
    async cancelTask(taskId) {
        const endpoint = contracts_1.API_ENDPOINTS.TASKS_CANCEL.replace(':id', taskId);
        return this.post(endpoint);
    }
    async pauseTask(taskId) {
        const endpoint = contracts_1.API_ENDPOINTS.TASKS_PAUSE.replace(':id', taskId);
        return this.post(endpoint);
    }
    async resumeTask(taskId) {
        const endpoint = contracts_1.API_ENDPOINTS.TASKS_RESUME.replace(':id', taskId);
        return this.post(endpoint);
    }
    async getHarnessTaskStatus() {
        return this.get(contracts_1.API_ENDPOINTS.TASKS_HARNESS_STATUS);
    }
    async getIntegrationStatus() {
        return this.get(contracts_1.API_ENDPOINTS.INTEGRATION + '/system-status');
    }
    async getConversations(limit = 50) {
        return this.get(contracts_1.API_ENDPOINTS.CONVERSATIONS, { limit });
    }
    async simulateTask(taskId, prompt) {
        return this.post(contracts_1.API_ENDPOINTS.SIMULATE_TASK, { taskId, prompt });
    }
    async processOptimizationPlan(planId, action) {
        return this.post(contracts_1.API_ENDPOINTS.OPTIMIZATION_PROCESS, {
            planId,
            action,
        });
    }
    async getOptimizationHistory() {
        return this.get(contracts_1.API_ENDPOINTS.OPTIMIZATION_HISTORY);
    }
    async sendUserBehaviorEvents(events) {
        return this.post(contracts_1.API_ENDPOINTS.USER_BEHAVIOR_EVENTS, events);
    }
    async getRecommendations(userId, limit = 5) {
        return this.get(contracts_1.API_ENDPOINTS.RECOMMENDATIONS, {
            userId,
            limit,
        });
    }
    async sendPerformanceMetrics(metrics) {
        return this.post(contracts_1.API_ENDPOINTS.PERFORMANCE_METRICS_POST, metrics);
    }
    async sendErrorMonitoring(error) {
        return this.post(contracts_1.API_ENDPOINTS.ERROR_MONITORING, error);
    }
    // 集成相关 API
    async getIntegrationPlatforms() {
        return this.get(contracts_1.API_ENDPOINTS.INTEGRATION_PLATFORMS);
    }
    async getIntegrationPlatformStatus(platform) {
        const endpoint = contracts_1.API_ENDPOINTS.INTEGRATION_STATUS.replace(':platform', platform);
        return this.get(endpoint);
    }
    async connectIntegrationPlatform(platform, config) {
        const endpoint = contracts_1.API_ENDPOINTS.INTEGRATION_CONNECT.replace(':platform', platform);
        return this.post(endpoint, { config });
    }
    async disconnectIntegrationPlatform(platform) {
        const endpoint = contracts_1.API_ENDPOINTS.INTEGRATION_DISCONNECT.replace(':platform', platform);
        return this.post(endpoint);
    }
    async sendIntegrationMessage(request) {
        const endpoint = contracts_1.API_ENDPOINTS.INTEGRATION_SEND.replace(':platform', request.platform);
        return this.post(endpoint, request);
    }
    async getIntegrationWebhook(platform) {
        const endpoint = contracts_1.API_ENDPOINTS.INTEGRATION_WEBHOOK.replace(':platform', platform);
        return this.get(endpoint);
    }
    async getWeChatQRCode() {
        return this.get(contracts_1.API_ENDPOINTS.INTEGRATION_WECHAT_QRCODE);
    }
    // Desktop API
    async takeDesktopScreenshot() {
        return this.post(contracts_1.API_ENDPOINTS.DESKTOP_SCREENSHOT);
    }
    async desktopAutomate(task) {
        return this.post(contracts_1.API_ENDPOINTS.DESKTOP_AUTOMATE, { task });
    }
    // MCP API
    async getMCPServers() {
        return this.get(contracts_1.API_ENDPOINTS.MCP_SERVERS);
    }
    async getMCPServerDetail(name) {
        const endpoint = contracts_1.API_ENDPOINTS.MCP_SERVER_DETAIL.replace(':name', name);
        return this.get(endpoint);
    }
    async startMCPServer(name) {
        const endpoint = contracts_1.API_ENDPOINTS.MCP_SERVER_START.replace(':name', name);
        return this.post(endpoint);
    }
    async stopMCPServer(name) {
        const endpoint = contracts_1.API_ENDPOINTS.MCP_SERVER_STOP.replace(':name', name);
        return this.post(endpoint);
    }
    async startAllMCPServers() {
        return this.post(contracts_1.API_ENDPOINTS.MCP_SERVERS_START_ALL);
    }
    async getMCPServerTools(name) {
        const endpoint = contracts_1.API_ENDPOINTS.MCP_SERVER_TOOLS.replace(':name', name);
        return this.get(endpoint);
    }
    async callMCPTool(name, tool, args) {
        const endpoint = contracts_1.API_ENDPOINTS.MCP_SERVER_CALL.replace(':name', name);
        return this.post(endpoint, { tool, args });
    }
    async sendMCPMessage(name, message) {
        const endpoint = contracts_1.API_ENDPOINTS.MCP_SERVER_MESSAGE.replace(':name', name);
        return this.post(endpoint, message);
    }
    async registerMCPServer(config) {
        return this.post(contracts_1.API_ENDPOINTS.MCP_REGISTER, config);
    }
    // TRAE API
    async getTRAEHealth() {
        return this.get(contracts_1.API_ENDPOINTS.TRAE_HEALTH);
    }
    async getTRAEPerformance() {
        return this.get(contracts_1.API_ENDPOINTS.TRAE_PERFORMANCE);
    }
    async getTRAEMCPStatus() {
        return this.get(contracts_1.API_ENDPOINTS.TRAE_MCP_STATUS);
    }
    async getTRAESkillsStatus() {
        return this.get(contracts_1.API_ENDPOINTS.TRAE_SKILLS_STATUS);
    }
    async executeTRAESkill(skillName, params) {
        return this.post(contracts_1.API_ENDPOINTS.TRAE_SKILLS_EXECUTE, { skillName, params });
    }
    async traeSecurityAudit(target, auditType) {
        return this.post(contracts_1.API_ENDPOINTS.TRAE_SECURITY_AUDIT, { target, auditType });
    }
    async traeTestingGenerate(targetFile, testType, framework) {
        return this.post(contracts_1.API_ENDPOINTS.TRAE_TESTING_GENERATE, { targetFile, testType, framework });
    }
    // Debug API
    async getDebugWeights() {
        return this.get(contracts_1.API_ENDPOINTS.DEBUG_WEIGHTS);
    }
    async getDebugRecentHistory() {
        return this.get(contracts_1.API_ENDPOINTS.DEBUG_RECENT_HISTORY);
    }
    async getDebugToolUsage() {
        return this.get(contracts_1.API_ENDPOINTS.DEBUG_TOOL_USAGE);
    }
    // Docs API
    async getDocsIndex() {
        return this.get(contracts_1.API_ENDPOINTS.DOCS_INDEX);
    }
    async generateDocs() {
        return this.post(contracts_1.API_ENDPOINTS.DOCS_GENERATE);
    }
    // Chat API
    async sendChatMessage(message, conversationId) {
        return this.post(contracts_1.API_ENDPOINTS.CHAT, { message, conversation_id: conversationId });
    }
    // Orchestrate & Evaluate API
    async orchestrate(goal, context) {
        return this.post(contracts_1.API_ENDPOINTS.ORCHESTRATE, { goal, context });
    }
    async evaluate(evalContext) {
        return this.post(contracts_1.API_ENDPOINTS.EVALUATE, { context: evalContext });
    }
    // Automation extended API
    async toggleAutomationTask(taskId, enabled) {
        const endpoint = contracts_1.API_ENDPOINTS.AUTOMATION_TASK_TOGGLE.replace(':taskId', taskId);
        return this.post(endpoint, { enabled });
    }
    async executeAutomationTask(taskId) {
        const endpoint = contracts_1.API_ENDPOINTS.AUTOMATION_TASK_EXECUTE.replace(':taskId', taskId);
        return this.post(endpoint);
    }
    // General logs API
    async getLogsGeneral(params) {
        return this.get(contracts_1.API_ENDPOINTS.LOGS_GENERAL, params);
    }
    // Harness status
    async getHarnessStatus() {
        return this.get(contracts_1.API_ENDPOINTS.HARNESS_STATUS);
    }
    // ===== Hermes P2: 批处理 / IDE / 轨迹导出 =====
    /**
     * 批量并行运行多个 prompt（Hermes Task 8）
     */
    async runBatch(request) {
        return this.post(contracts_1.API_ENDPOINTS.BATCH_RUN, request);
    }
    /**
     * IDE 聊天（Hermes Task 18，ACP 协议）
     */
    async chatWithIde(request) {
        return this.post(contracts_1.API_ENDPOINTS.IDE_CHAT, request);
    }
    /**
     * 获取活跃 IDE 会话列表（Hermes Task 18）
     */
    async getIdeSessions() {
        return this.get(contracts_1.API_ENDPOINTS.IDE_SESSIONS);
    }
    /**
     * 导出累积的 RL 训练轨迹（Hermes Task 19）
     */
    async exportTrajectories(format) {
        return this.post(contracts_1.API_ENDPOINTS.TRAJECTORY_EXPORT, { format });
    }
    /**
     * 获取 RL 训练轨迹统计信息（Hermes Task 19）
     */
    async getTrajectoryStats() {
        return this.get(contracts_1.API_ENDPOINTS.TRAJECTORY_STATS);
    }
    // ===== Hermes P2: 工具执行（image_generate / tts_speak / web_fetch） =====
    /**
     * 执行任意已注册的 Harness 工具
     */
    async executeTool(request) {
        return this.post(contracts_1.API_ENDPOINTS.TOOL_EXECUTE, request);
    }
    /**
     * 图像生成（image_generate 工具）
     */
    async generateImage(prompt, size, style) {
        return this.executeTool({
            toolName: 'image_generate',
            params: { prompt, size, style },
        });
    }
    /**
     * 文本转语音（tts_speak 工具）
     */
    async speakTts(text, voice, speed) {
        return this.executeTool({
            toolName: 'tts_speak',
            params: { text, voice, speed },
        });
    }
    /**
     * 网页抓取（web_fetch 工具，作为 browser 功能）
     */
    async fetchWebPage(url, format) {
        return this.executeTool({
            toolName: 'web_fetch',
            params: { url, format },
        });
    }
    /**
     * 列出所有已注册工具
     */
    async listTools() {
        return this.get(contracts_1.API_ENDPOINTS.TOOL_LIST);
    }
    // ===== Workspace / Budget / Gateway / Session APIs =====
    async getWorkspaces() {
        try {
            const result = await this.get('/api/workspaces');
            if (result.success && Array.isArray(result.data)) {
                return result;
            }
        }
        catch {
            /* 后端未实现时降级到 mock */
        }
        return { success: true, data: [] };
    }
    async createWorkspace(name, path, description) {
        try {
            const result = await this.post('/api/workspaces', { name, path, description });
            if (result.success && result.data) {
                return result;
            }
        }
        catch {
            /* 后端未实现时降级到本地生成 */
        }
        const workspace = {
            id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            name,
            path,
            description,
            lastActive: new Date().toISOString(),
        };
        return { success: true, data: workspace };
    }
    async getBudgetStatus() {
        try {
            const result = await this.get('/api/budget/status');
            if (result.success && result.data) {
                return result;
            }
        }
        catch {
            /* 后端未实现时降级到 mock */
        }
        return {
            success: true,
            data: { tokenUsed: 0, tokenBudget: 500000, costUsed: 0, costBudget: 10, period: 'daily' },
        };
    }
    async getGatewayStatus() {
        try {
            const result = await this.getIntegrationPlatforms();
            if (result.success && result.data) {
                const platforms = result.data.platforms.map((p) => ({
                    id: p.id,
                    name: p.name,
                    type: p.id || 'im',
                    connected: p.status?.status === 'connected',
                    unreadCount: 0,
                }));
                const connectedCount = platforms.filter((p) => p.connected).length;
                const status = connectedCount === 0 ? 'offline' : connectedCount === platforms.length ? 'online' : 'partial';
                return { success: true, data: { status, platforms } };
            }
        }
        catch {
            /* 降级到 mock */
        }
        return { success: true, data: { status: 'offline', platforms: [] } };
    }
    async getSessions() {
        try {
            const result = await this.getConversations(50);
            if (result.success && Array.isArray(result.data)) {
                const sessions = result.data
                    .filter((c) => c.id)
                    .map((c) => ({
                    id: c.id,
                    title: c.title || '未命名会话',
                    lastActive: c.timestamp || new Date().toISOString(),
                }));
                return { success: true, data: sessions };
            }
        }
        catch {
            /* 降级到 mock */
        }
        return { success: true, data: [] };
    }
}
exports.JiabaixingApiService = JiabaixingApiService;
const apiBaseUrl = process.env.NODE_ENV === 'development'
    ? 'http://localhost:3111'
    : process.env.REACT_APP_API_BASE_URL || 'http://localhost:3111';
function getApiBaseUrl() {
    return apiBaseUrl;
}
function getWsBaseUrl() {
    const httpUrl = getApiBaseUrl();
    return httpUrl.replace(/^http/, 'ws');
}
exports.apiService = new JiabaixingApiService(apiBaseUrl);
