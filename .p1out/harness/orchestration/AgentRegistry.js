"use strict";
/**
 * Harness Phase 10: 多Agent编排 — Agent注册与发现服务
 *
 * 管理多Agent的注册、发现、状态跟踪。
 * 支持按能力查找可用Agent，提供运行时状态监控。
 * P10增强：健康检查、能力评分排序、心跳检测
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.A2AProtocolManager = exports.AgentRegistry = void 0;
const Logger_1 = require("../../utils/Logger");
const DEFAULT_HEALTH = {
    lastHeartbeat: Date.now(),
    successRate: 1.0,
    avgResponseTime: 0,
    errorCount: 0,
    totalExecutions: 0,
};
class AgentRegistry {
    constructor() {
        this.agents = new Map();
        this.healthMap = new Map();
        // ============ 知识共享系统 ============
        this.knowledgeEntries = new Map();
        this.knowledgeSubscriptions = new Map();
        // ============ 结构化通信系统 ============
        this.messageHandlers = new Map();
        // ============ 协商协议系统 ============
        this.negotiationSessions = new Map();
        // ============ 竞价系统 ============
        this.bidHandlers = new Map();
        this.biddingSessions = new Map();
    }
    /**
     * 注册Agent
     * @param registration - Agent注册信息
     * @throws 如果agentId已存在则跳过（日志警告）
     */
    register(registration) {
        if (this.agents.has(registration.id)) {
            Logger_1.Logger.warn(`Agent 已存在，跳过重复注册: ${registration.id} (${registration.name})`, 'AgentRegistry');
            return;
        }
        this.agents.set(registration.id, {
            ...registration,
            createdAt: registration.createdAt || new Date(),
            lastActiveAt: registration.lastActiveAt || new Date(),
        });
        this.healthMap.set(registration.id, { ...DEFAULT_HEALTH });
        Logger_1.Logger.info(`🤖 注册 Agent: ${registration.name} (${registration.id}) | 能力: ${registration.capabilities.map((c) => c.name).join(', ') || '(无)'}`, 'AgentRegistry');
    }
    /**
     * 注销Agent
     * @param agentId - Agent唯一标识
     */
    unregister(agentId) {
        const agent = this.agents.get(agentId);
        if (!agent) {
            Logger_1.Logger.warn(`Agent 不存在，无法注销: ${agentId}`, 'AgentRegistry');
            return;
        }
        this.agents.delete(agentId);
        this.healthMap.delete(agentId);
        Logger_1.Logger.info(`👋 注销 Agent: ${agent.name} (${agentId})`, 'AgentRegistry');
    }
    /**
     * 按工具能力查找合适的Agent（寻找空闲的、具备该工具的Agent）
     * @param toolName - 工具名称
     * @returns 第一个匹配的空闲Agent，或null
     */
    findAgentByCapability(toolName) {
        for (const agent of this.agents.values()) {
            if (agent.status !== 'idle')
                continue;
            const hasCapability = agent.capabilities.some((cap) => cap.tools.includes(toolName));
            if (hasCapability) {
                return agent;
            }
        }
        Logger_1.Logger.debug(`未找到具备工具能力的空闲 Agent: ${toolName}`, 'AgentRegistry');
        return null;
    }
    /**
     * 按能力评分 + 健康状态查找最佳Agent
     * P10增强：综合考虑能力评分、健康状态、成功率排序
     * @param toolName - 工具名称
     * @returns 最佳匹配的空闲Agent，或null
     */
    findBestAgent(toolName) {
        const candidates = [];
        for (const agent of this.agents.values()) {
            if (agent.status !== 'idle')
                continue;
            const matchingCap = agent.capabilities.find((cap) => cap.tools.includes(toolName));
            if (!matchingCap)
                continue;
            const health = this.healthMap.get(agent.id) || DEFAULT_HEALTH;
            const capabilityScore = matchingCap.score ?? 50;
            const healthBonus = health.successRate * 25;
            const latencyPenalty = Math.min(health.avgResponseTime / 1000, 10);
            const errorPenalty = Math.min(health.errorCount * 2, 20);
            const compositeScore = capabilityScore + healthBonus - latencyPenalty - errorPenalty;
            candidates.push({ agent, score: compositeScore });
        }
        if (candidates.length === 0) {
            Logger_1.Logger.debug(`未找到具备工具能力的空闲 Agent: ${toolName}`, 'AgentRegistry');
            return null;
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].agent;
    }
    /**
     * 更新Agent健康状态
     * @param agentId - Agent唯一标识
     * @param healthUpdate - 健康状态更新（部分字段）
     */
    updateHealth(agentId, healthUpdate) {
        const current = this.healthMap.get(agentId) || { ...DEFAULT_HEALTH };
        this.healthMap.set(agentId, {
            ...current,
            ...healthUpdate,
            lastHeartbeat: Date.now(),
        });
    }
    /**
     * 记录Agent执行结果（自动更新健康指标）
     * @param agentId - Agent唯一标识
     * @param success - 是否成功
     * @param durationMs - 执行耗时
     */
    recordExecution(agentId, success, durationMs) {
        const health = this.healthMap.get(agentId);
        if (!health)
            return;
        health.totalExecutions++;
        health.lastHeartbeat = Date.now();
        if (success) {
            const prevAvg = health.avgResponseTime;
            health.avgResponseTime =
                (prevAvg * (health.totalExecutions - 1) + durationMs) /
                    health.totalExecutions;
            health.successRate =
                (health.successRate * (health.totalExecutions - 1) + 1) /
                    health.totalExecutions;
        }
        else {
            health.errorCount++;
            health.successRate =
                (health.successRate * (health.totalExecutions - 1)) /
                    health.totalExecutions;
        }
        const agent = this.agents.get(agentId);
        if (agent) {
            agent.lastActiveAt = new Date();
        }
    }
    /**
     * 获取Agent健康状态
     * @param agentId - Agent唯一标识
     * @returns 健康状态，或null
     */
    getHealthStatus(agentId) {
        return this.healthMap.get(agentId) || null;
    }
    /**
     * 清理超时无心跳的Agent（标记为error状态）
     * @param timeoutMs - 超时阈值（默认60秒）
     * @returns 被标记为error的Agent数量
     */
    cleanupStaleAgents(timeoutMs = 60000) {
        const now = Date.now();
        let cleaned = 0;
        for (const [agentId, health] of this.healthMap) {
            if (now - health.lastHeartbeat > timeoutMs) {
                const agent = this.agents.get(agentId);
                if (agent && agent.status !== 'error') {
                    agent.status = 'error';
                    Logger_1.Logger.warn(`💀 Agent 心跳超时，标记为 error: ${agent.name} (${agentId})`, 'AgentRegistry');
                    cleaned++;
                }
            }
        }
        return cleaned;
    }
    /**
     * 获取Agent信息
     * @param agentId - Agent唯一标识
     * @returns Agent注册信息，或undefined
     */
    getAgent(id) {
        return this.agents.get(id);
    }
    /**
     * 列出所有Agent（可按状态过滤）
     * @param status - 可选的状态过滤器
     * @returns Agent注册信息列表
     */
    listAgents(status) {
        const all = Array.from(this.agents.values());
        if (status === undefined)
            return all;
        return all.filter((a) => a.status === status);
    }
    /**
     * 更新Agent状态
     * @param agentId - Agent唯一标识
     * @param status - 新状态
     * @throws 如果Agent不存在则日志警告
     */
    updateStatus(agentId, status) {
        const agent = this.agents.get(agentId);
        if (!agent) {
            Logger_1.Logger.warn(`Agent 不存在，无法更新状态: ${agentId}`, 'AgentRegistry');
            return;
        }
        agent.status = status;
        agent.lastActiveAt = new Date();
        if (this.healthMap.has(agentId)) {
            this.healthMap.get(agentId).lastHeartbeat = Date.now();
        }
        Logger_1.Logger.debug(`Agent 状态更新: ${agentId} → ${status}`, 'AgentRegistry');
    }
    /**
     * 获取当前注册的Agent数量
     */
    get size() {
        return this.agents.size;
    }
    /**
     * 获取空闲Agent列表
     */
    getIdleAgents() {
        return this.listAgents('idle');
    }
    /**
     * 获取忙碌Agent列表
     */
    getBusyAgents() {
        return this.listAgents('busy');
    }
    /**
     * 获取异常Agent列表
     */
    getErrorAgents() {
        return this.listAgents('error');
    }
    publishKnowledge(input) {
        const id = `know_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry = {
            id,
            publisherId: input.publisherId,
            type: input.type,
            title: input.title,
            content: input.content,
            tags: input.tags,
            applicableScenes: input.applicableScenes,
            qualityScore: input.qualityScore,
            referenceCount: 0,
            createdAt: Date.now(),
        };
        this.knowledgeEntries.set(id, entry);
        for (const [, sub] of this.knowledgeSubscriptions) {
            if (sub.type === input.type) {
                try {
                    sub.onNewKnowledge(entry);
                }
                catch {
                    // 忽略回调错误
                }
            }
        }
        return entry;
    }
    queryKnowledge(filter) {
        let results = Array.from(this.knowledgeEntries.values());
        if (filter.type) {
            results = results.filter((e) => e.type === filter.type);
        }
        if (filter.scene) {
            results = results.filter((e) => e.applicableScenes.includes(filter.scene));
        }
        if (filter.minQualityScore !== undefined) {
            results = results.filter((e) => e.qualityScore >= filter.minQualityScore);
        }
        if (filter.keywords && filter.keywords.length > 0) {
            results = results.filter((e) => filter.keywords.some((kw) => e.title.includes(kw) ||
                e.content.includes(kw) ||
                e.tags.some((t) => t.includes(kw))));
        }
        if (filter.maxResults !== undefined) {
            results = results.slice(0, filter.maxResults);
        }
        return results;
    }
    referenceKnowledge(id) {
        const entry = this.knowledgeEntries.get(id);
        if (entry) {
            entry.referenceCount++;
        }
    }
    subscribeToKnowledge(input) {
        const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.knowledgeSubscriptions.set(subId, {
            id: subId,
            subscriberId: input.subscriberId,
            type: input.type,
            onNewKnowledge: input.onNewKnowledge,
        });
        return subId;
    }
    unsubscribeFromKnowledge(subId) {
        this.knowledgeSubscriptions.delete(subId);
    }
    getKnowledgeStats() {
        const entries = Array.from(this.knowledgeEntries.values());
        const entriesByType = {};
        const contributorMap = {};
        let totalQuality = 0;
        for (const entry of entries) {
            entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;
            contributorMap[entry.publisherId] =
                (contributorMap[entry.publisherId] || 0) + 1;
            totalQuality += entry.qualityScore;
        }
        const topContributors = Object.entries(contributorMap)
            .map(([agentId, count]) => ({ agentId, count }))
            .sort((a, b) => b.count - a.count);
        return {
            totalEntries: entries.length,
            entriesByType,
            topContributors,
            avgQualityScore: entries.length > 0 ? totalQuality / entries.length : 0,
        };
    }
    registerMessageHandler(agentId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler) {
        this.messageHandlers.set(agentId, handler);
    }
    broadcastMessage(fromAgentId, message) {
        const delivered = [];
        for (const [agentId, registration] of this.agents) {
            if (agentId !== fromAgentId &&
                registration.status === 'idle' &&
                this.messageHandlers.has(agentId)) {
                try {
                    this.messageHandlers.get(agentId)(message);
                    delivered.push(agentId);
                }
                catch {
                    // 忽略发送失败
                }
            }
        }
        return delivered;
    }
    async negotiateBetweenAgents(fromAgentId, toAgentId, topic) {
        const handler = this.messageHandlers.get(toAgentId);
        if (!handler) {
            return { agreed: false, terms: {} };
        }
        try {
            const response = await handler({
                type: 'query',
                payload: { requestedInfo: topic },
                sessionId: `neg_${Date.now()}`,
            });
            if (response && typeof response === 'object') {
                const resp = response;
                return {
                    agreed: true,
                    terms: resp.payload || {},
                };
            }
        }
        catch {
            // 协商失败
        }
        return { agreed: false, terms: {} };
    }
    startNegotiation(initiatorId, participants, topic, payload) {
        const id = `neg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const session = {
            id,
            initiatorId,
            participants,
            topic,
            payload,
            status: 'open',
        };
        this.negotiationSessions.set(id, session);
        return {
            id,
            initiatorId,
            participants,
            topic,
            status: 'active',
            messages: [
                {
                    type: 'task_proposal',
                    fromAgentId: initiatorId,
                    payload,
                },
            ],
        };
    }
    sendNegotiationMessage(message) {
        const session = this.negotiationSessions.get(message.sessionId);
        if (!session)
            return null;
        if (message.type === 'acceptance') {
            session.status = 'completed';
            session.result = { agreedAgentId: message.fromAgentId };
            return { id: session.id, status: 'completed', result: session.result };
        }
        if (message.type === 'rejection') {
            session.status = 'failed';
            return { id: session.id, status: 'failed' };
        }
        return { id: session.id, status: session.status };
    }
    getNegotiationSession(sessionId) {
        const session = this.negotiationSessions.get(sessionId);
        if (!session)
            return null;
        return {
            id: session.id,
            initiatorId: session.initiatorId,
            participants: session.participants,
            topic: session.topic,
            status: session.status,
            result: session.result,
        };
    }
    getActiveNegotiations(agentId) {
        const result = [];
        for (const session of this.negotiationSessions.values()) {
            if (session.status === 'open' &&
                (session.participants.includes(agentId) ||
                    session.initiatorId === agentId)) {
                result.push({
                    id: session.id,
                    participants: session.participants,
                    topic: session.topic,
                    status: session.status,
                });
            }
        }
        return result;
    }
    getMessageHandler(agentId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) {
        return this.messageHandlers.get(agentId);
    }
    registerBidHandler(agentId, handler) {
        this.bidHandlers.set(agentId, handler);
    }
    publishBidding(taskId, description, requiredTools) {
        const id = `bid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const session = {
            id,
            taskId,
            description,
            requiredTools,
            status: 'open',
            bids: [],
        };
        for (const [agentId, handler] of this.bidHandlers) {
            const registration = this.agents.get(agentId);
            if (!registration)
                continue;
            const hasRequiredTools = requiredTools.every((tool) => registration.capabilities.some((cap) => cap.tools.some((t) => t === tool)));
            if (!hasRequiredTools && requiredTools.length > 0)
                continue;
            try {
                const bid = handler({ id: taskId });
                session.bids.push(bid);
            }
            catch {
                // 忽略投标失败
            }
        }
        this.biddingSessions.set(id, session);
        return session;
    }
    evaluateBids(sessionId, strategy = 'balanced') {
        const session = this.biddingSessions.get(sessionId);
        if (!session || session.bids.length === 0)
            return null;
        let winner = null;
        switch (strategy) {
            case 'fastest':
                winner = session.bids.reduce((best, bid) => bid.estimatedTime < best.estimatedTime ? bid : best);
                break;
            case 'most_confident':
                winner = session.bids.reduce((best, bid) => bid.confidence > best.confidence ? bid : best);
                break;
            case 'balanced':
            default:
                winner = session.bids.reduce((best, bid) => {
                    const bestScore = best.confidence * 0.6 + (1 / Math.max(best.estimatedTime, 1)) * 0.4;
                    const bidScore = bid.confidence * 0.6 + (1 / Math.max(bid.estimatedTime, 1)) * 0.4;
                    return bidScore > bestScore ? bid : best;
                });
                break;
        }
        if (winner) {
            session.status = 'awarded';
            return { winnerId: winner.agentId, bid: winner };
        }
        return null;
    }
    submitBid(bid) {
        for (const session of this.biddingSessions.values()) {
            if (session.taskId === bid.taskId && session.status === 'open') {
                session.bids.push(bid);
                return true;
            }
        }
        return false;
    }
}
exports.AgentRegistry = AgentRegistry;
/**
 * A2A 协议管理器 — 扩展 AgentRegistry，提供标准化的 A2A 通信
 *
 * @deprecated 架构违规：A2A 协议主实现应在 Python 端（`agent/a2a/`）。
 * 本内存实现仅用于单进程本地回放/测试，无网络传输层，无法跨进程通信，
 * **不可作为生产跨 Agent 通信路径**。
 * 生产跨进程 A2A 的规范入口是 TS 薄壳 `src/a2a/`：
 *   - `registerA2ARoutes(app)` 把 `/a2a/*` HTTP 入口透明转发到 Python 后端；
 *   - `A2AClient` 提供 TS 侧出站调用远端 A2A Agent 的薄封装。
 * 调用方应优先使用 `src/a2a` 薄壳（逻辑全在 Python），本类仅作本地兜底。
 * @see AGENTS.md §0.1 模块归属强制表
 * @see src/a2a
 */
class A2AProtocolManager {
    constructor(registry) {
        this.agentCards = new Map();
        this.tasks = new Map();
        this.taskEventHandlers = new Map();
        this.registry = registry;
        // P1-4: Python A2A 桥接配置
        this._pythonBridgeUrl = process.env.A2A_PYTHON_BRIDGE_URL || '';
        this._pythonBridgeEnabled = !!this._pythonBridgeUrl;
        this._syncInterval = null;
        if (this._pythonBridgeEnabled) {
            Logger_1.Logger.info(`🔗 P1-4: A2A Python桥接已启用: ${this._pythonBridgeUrl}`, 'A2AProtocol');
        }
    }
    /**
     * P1-4: 启动与 Python A2A 的双向同步
     *
     * 定期从 Python A2A 端拉取 Agent Card 和 Task 状态，
     * 同时将本地的 Agent Card 推送到 Python 端。
     * 实现 TS/Python 双端 A2A 能力统一。
     */
    startPythonBridgeSync(intervalMs = 15000) {
        if (!this._pythonBridgeEnabled || this._syncInterval) {
            return;
        }
        this._syncInterval = setInterval(async () => {
            try {
                await this._syncFromPython();
                await this._syncToPython();
            }
            catch (err) {
                Logger_1.Logger.debug(`A2A Python桥接同步失败: ${err.message}`, 'A2AProtocol');
            }
        }, intervalMs);
        if (this._syncInterval.unref)
            this._syncInterval.unref();
        Logger_1.Logger.info(`A2A Python桥接同步已启动 (间隔: ${intervalMs}ms)`, 'A2AProtocol');
    }
    /**
     * P1-4: 停止 Python A2A 同步
     */
    stopPythonBridgeSync() {
        if (this._syncInterval) {
            clearInterval(this._syncInterval);
            this._syncInterval = null;
            Logger_1.Logger.info('A2A Python桥接同步已停止', 'A2AProtocol');
        }
    }
    /**
     * P1-4: 从 Python A2A 端拉取 Agent Card 和 Task 状态
     */
    async _syncFromPython() {
        if (!this._pythonBridgeUrl) return;
        try {
            const http = require('http');
            const fetchJson = (path) => new Promise((resolve, reject) => {
                const url = `${this._pythonBridgeUrl}${path}`;
                http.get(url, { timeout: 5000 }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); }
                        catch { resolve(null); }
                    });
                }).on('error', reject);
            });
            // 同步 Agent Cards
            const cardsData = await fetchJson('/a2a/agent-cards');
            if (cardsData && Array.isArray(cardsData)) {
                for (const card of cardsData) {
                    if (!this.agentCards.has(card.id)) {
                        this.agentCards.set(card.id, card);
                        Logger_1.Logger.debug(`从Python同步Agent Card: ${card.id}`, 'A2AProtocol');
                    }
                }
            }
            // 同步 Task 状态
            const tasksData = await fetchJson('/a2a/tasks');
            if (tasksData && Array.isArray(tasksData)) {
                for (const pyTask of tasksData) {
                    const localTask = this.tasks.get(pyTask.id);
                    if (localTask && localTask.status !== pyTask.status) {
                        localTask.status = pyTask.status;
                        localTask.updatedAt = Date.now();
                        if (pyTask.output) localTask.output = pyTask.output;
                        if (pyTask.error) localTask.error = pyTask.error;
                        Logger_1.Logger.debug(`从Python同步Task状态: ${pyTask.id} → ${pyTask.status}`, 'A2AProtocol');
                    }
                }
            }
        }
        catch (err) {
            Logger_1.Logger.debug(`从Python同步失败: ${err.message}`, 'A2AProtocol');
        }
    }
    /**
     * P1-4: 将本地 Agent Card 推送到 Python A2A 端
     */
    async _syncToPython() {
        if (!this._pythonBridgeUrl) return;
        try {
            const http = require('http');
            for (const [id, card] of this.agentCards) {
                const postData = JSON.stringify(card);
                const url = new URL(`${this._pythonBridgeUrl}/a2a/agent-card`);
                const options = {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                    timeout: 5000,
                };
                await new Promise((resolve, reject) => {
                    const req = http.request(options, resolve);
                    req.on('error', reject);
                    req.write(postData);
                    req.end();
                });
            }
        }
        catch (err) {
            Logger_1.Logger.debug(`推送到Python失败: ${err.message}`, 'A2AProtocol');
        }
    }
    /**
     * P1-4: 通过 Python A2A 创建远程 Task
     *
     * 当目标 Agent 不在本地注册表中时，尝试通过 Python 端创建远程 Task。
     */
    async createRemoteTask(input) {
        if (!this._pythonBridgeUrl) {
            Logger_1.Logger.warn('Python桥接未启用，无法创建远程Task', 'A2AProtocol');
            return null;
        }
        try {
            const http = require('http');
            const postData = JSON.stringify({
                from_agent_id: input.fromAgentId,
                to_agent_id: input.toAgentId,
                description: input.description,
                input_data: input.input,
            });
            const url = new URL(`${this._pythonBridgeUrl}/a2a/tasks`);
            const options = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                timeout: 10000,
            };
            const result = await new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); }
                        catch { resolve(null); }
                    });
                });
                req.on('error', reject);
                req.write(postData);
                req.end();
            });
            if (result) {
                Logger_1.Logger.info(`远程Task创建成功: ${result.id} (via Python)`, 'A2AProtocol');
                this.tasks.set(result.id, {
                    id: result.id,
                    sessionId: result.session_id,
                    description: input.description,
                    fromAgentId: input.fromAgentId,
                    toAgentId: input.toAgentId,
                    status: 'submitted',
                    input: input.input,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    statusHistory: [{ status: 'submitted', timestamp: Date.now() }],
                    isRemote: true,
                });
                return result;
            }
            return null;
        }
        catch (err) {
            Logger_1.Logger.warn(`远程Task创建失败: ${err.message}`, 'A2AProtocol');
            return null;
        }
    }
    /**
     * 发布 Agent Card
     */
    publishAgentCard(card) {
        this.agentCards.set(card.id, card);
        Logger_1.Logger.info(`📇 A2A Agent Card 发布: ${card.name} (${card.id})`, 'A2AProtocol');
    }
    /**
     * 获取 Agent Card
     */
    getAgentCard(agentId) {
        return this.agentCards.get(agentId);
    }
    /**
     * 发现具备指定能力的 Agent
     */
    discoverAgents(capabilityType) {
        const cards = Array.from(this.agentCards.values());
        if (!capabilityType)
            return cards;
        return cards.filter((card) => card.capabilities.some((cap) => cap.type === capabilityType));
    }
    /**
     * 创建 A2A Task
     */
    createTask(input) {
        const id = `a2a_task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        const task = {
            id,
            sessionId: `session_${Date.now()}`,
            description: input.description,
            fromAgentId: input.fromAgentId,
            toAgentId: input.toAgentId,
            status: 'submitted',
            input: input.input,
            createdAt: now,
            updatedAt: now,
            statusHistory: [{ status: 'submitted', timestamp: now }],
        };
        this.tasks.set(id, task);
        Logger_1.Logger.info(`📋 A2A Task 创建: ${task.id} (${input.fromAgentId} → ${input.toAgentId})`, 'A2AProtocol');
        this.emitTaskEvent(task.id, {
            taskId: task.id,
            type: 'status-change',
            status: 'submitted',
            timestamp: now,
        });
        return task;
    }
    /**
     * 更新 Task 状态
     */
    updateTaskStatus(taskId, newStatus, message) {
        const task = this.tasks.get(taskId);
        if (!task) {
            Logger_1.Logger.warn(`A2A Task 不存在: ${taskId}`, 'A2AProtocol');
            return null;
        }
        const now = Date.now();
        task.status = newStatus;
        task.updatedAt = now;
        task.statusHistory.push({ status: newStatus, timestamp: now, message });
        if (newStatus === 'completed' ||
            newStatus === 'failed' ||
            newStatus === 'cancelled') {
            task.completedAt = now;
        }
        if (newStatus === 'completed') {
            this.registry.recordExecution(task.toAgentId, true, now - task.createdAt);
        }
        else if (newStatus === 'failed') {
            this.registry.recordExecution(task.toAgentId, false, now - task.createdAt);
            task.error = message;
        }
        Logger_1.Logger.info(`📋 A2A Task 状态更新: ${taskId} → ${newStatus}`, 'A2AProtocol');
        this.emitTaskEvent(taskId, {
            taskId,
            type: 'status-change',
            status: newStatus,
            message,
            timestamp: now,
        });
        return task;
    }
    /**
     * 完成 Task 并设置输出
     */
    completeTask(taskId, output) {
        const task = this.tasks.get(taskId);
        if (!task)
            return null;
        task.output = output;
        return this.updateTaskStatus(taskId, 'completed');
    }
    /**
     * 获取 Task
     */
    getTask(taskId) {
        return this.tasks.get(taskId);
    }
    /**
     * 获取 Agent 的所有 Task
     */
    getAgentTasks(agentId, role) {
        const tasks = Array.from(this.tasks.values());
        if (!role) {
            return tasks.filter((t) => t.fromAgentId === agentId || t.toAgentId === agentId);
        }
        if (role === 'from')
            return tasks.filter((t) => t.fromAgentId === agentId);
        return tasks.filter((t) => t.toAgentId === agentId);
    }
    /**
     * 取消 Task
     */
    cancelTask(taskId, reason) {
        return this.updateTaskStatus(taskId, 'cancelled', reason);
    }
    /**
     * 请求额外输入
     */
    requestInput(taskId, message) {
        return this.updateTaskStatus(taskId, 'input-required', message);
    }
    /**
     * 订阅 Task 事件
     */
    onTaskEvent(taskId, handler) {
        if (!this.taskEventHandlers.has(taskId)) {
            this.taskEventHandlers.set(taskId, []);
        }
        this.taskEventHandlers.get(taskId).push(handler);
    }
    /**
     * 取消订阅 Task 事件
     */
    offTaskEvent(taskId, handler) {
        const handlers = this.taskEventHandlers.get(taskId);
        if (handlers) {
            const idx = handlers.indexOf(handler);
            if (idx >= 0)
                handlers.splice(idx, 1);
        }
    }
    /**
     * 获取活跃 Task 统计
     */
    getTaskStats() {
        const tasks = Array.from(this.tasks.values());
        const byStatus = {
            submitted: 0,
            working: 0,
            'input-required': 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
        };
        let totalCompletionTime = 0;
        let completedCount = 0;
        for (const task of tasks) {
            byStatus[task.status]++;
            if (task.completedAt && task.status === 'completed') {
                totalCompletionTime += task.completedAt - task.createdAt;
                completedCount++;
            }
        }
        return {
            total: tasks.length,
            byStatus,
            avgCompletionTimeMs: completedCount > 0 ? totalCompletionTime / completedCount : 0,
        };
    }
    emitTaskEvent(taskId, event) {
        const handlers = this.taskEventHandlers.get(taskId);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(event);
                }
                catch {
                    // 忽略回调错误
                }
            }
        }
    }
}
exports.A2AProtocolManager = A2AProtocolManager;
