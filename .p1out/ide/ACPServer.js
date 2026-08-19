"use strict";
/**
 * ACP (Agent Communication Protocol) 服务器
 *
 * 支持编辑器集成（VS Code / Zed / JetBrains）
 * 提供聊天、文件 diff、终端命令、工具活动等能力
 * 设计参考: Hermes Agent IDE 集成 (ACP)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACPPermissionGuard = exports.ACPAuthManager = exports.ACPServer = void 0;
const ACPActivityTracker_1 = require("./ACPActivityTracker");
const Logger_1 = require("../utils/Logger");
/** 会话默认过期时间（毫秒）— 24小时 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
class ACPServer {
    constructor(deps) {
        this.sessions = new Map();
        this.MAX_SESSIONS = 10000;
        this.deps = deps;
        this.tracker = ACPActivityTracker_1.ACPActivityTracker.getInstance();
        // 定期清理过期会话（每30分钟）
        this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 30 * 60 * 1000);
        if (this.cleanupInterval.unref)
            this.cleanupInterval.unref();
    }
    /**
     * 清理过期会话
     */
    cleanupExpiredSessions() {
        const now = Date.now();
        for (const [sessionId, meta] of this.sessions.entries()) {
            if (now - meta.lastActivity > SESSION_TTL_MS) {
                this.sessions.delete(sessionId);
                Logger_1.Logger.debug(`清理过期 ACP 会话: ${sessionId}`, 'ACPServer');
            }
        }
    }
    /**
     * 处理聊天请求
     * @param request - 聊天请求
     * @returns 聊天响应
     */
    async handleChat(request) {
        const { message, sessionId } = request;
        // 更新会话状态
        this.touchSession(sessionId);
        try {
            const result = await this.deps.processInput(message, sessionId);
            // 获取相关工具活动
            const toolActivities = this.deps.getToolActivities(sessionId);
            return {
                content: result.response,
                sessionId,
                toolActivities: toolActivities.length > 0 ? toolActivities : undefined,
            };
        }
        catch (err) {
            Logger_1.Logger.error(`ACP 聊天处理失败: ${err.message}`, err, 'ACPServer');
            return {
                content: `处理失败: ${err.message}`,
                sessionId,
            };
        }
    }
    /**
     * 获取文件 Diff
     * @param sessionId - 会话 ID
     * @returns 文件变更列表
     */
    getFileDiff(sessionId) {
        const tracked = this.tracker.getFileDiffs(sessionId);
        if (tracked.length > 0)
            return tracked;
        return this.deps.getFileDiffs(sessionId);
    }
    /**
     * 获取终端命令
     * @param sessionId - 会话 ID
     * @returns 终端命令列表
     */
    getTerminalCommands(sessionId) {
        const tracked = this.tracker.getTerminalCommands(sessionId);
        if (tracked.length > 0)
            return tracked;
        return this.deps.getTerminalCommands(sessionId);
    }
    /**
     * 获取工具活动
     * @param sessionId - 会话 ID
     * @returns 工具活动列表
     */
    getToolActivities(sessionId) {
        const tracked = this.tracker.getToolActivities(sessionId);
        if (tracked.length > 0)
            return tracked;
        return this.deps.getToolActivities(sessionId);
    }
    /**
     * 获取活跃会话列表
     * @returns 活跃会话信息数组
     */
    getActiveSessions() {
        return Array.from(this.sessions.entries()).map(([sessionId, meta]) => ({
            sessionId,
            ...meta,
        }));
    }
    /**
     * 关闭会话
     * @param sessionId - 会话 ID
     * @returns 是否成功关闭
     */
    closeSession(sessionId) {
        return this.sessions.delete(sessionId);
    }
    /**
     * 更新会话状态
     * @param sessionId - 会话 ID
     */
    touchSession(sessionId) {
        const now = Date.now();
        const existing = this.sessions.get(sessionId);
        if (existing) {
            existing.lastActivity = now;
        }
        else {
            if (this.sessions.size >= this.MAX_SESSIONS) {
                const oldestKey = this.sessions.keys().next().value;
                this.sessions.delete(oldestKey);
            }
            this.sessions.set(sessionId, { createdAt: now, lastActivity: now });
        }
    }
}
exports.ACPServer = ACPServer;
/** ACP 认证管理器 */
class ACPAuthManager {
    constructor() {
        this.tokens = new Map();
        this.MAX_TOKENS = 10000;
        this.apiKeys = new Map();
        this.MAX_API_KEYS = 100;
        this.requestCounts = new Map();
        this.MAX_REQUEST_COUNTS = 10000;
        this.secretKey = process.env.ACP_SECRET_KEY || 'jiabaixing-acp-default-key';
        const defaultKey = process.env.ACP_API_KEY;
        if (defaultKey) {
            this.registerApiKey(defaultKey, 'default-client', 'admin', {
                allowedCategories: undefined,
                deniedTools: [],
                allowedPaths: undefined,
                maxTokensPerRequest: 8192,
                maxRequestsPerHour: 1000,
            });
        }
        const readOnlyKey = process.env.ACP_READ_ONLY_KEY;
        if (readOnlyKey) {
            this.registerApiKey(readOnlyKey, 'readonly-client', 'read', {
                allowedCategories: ['cognition', 'memory'],
                deniedTools: ['shell_exec', 'file_edit', 'code_generate'],
                allowedPaths: undefined,
                maxTokensPerRequest: 4096,
                maxRequestsPerHour: 200,
            });
        }
    }
    /**
     * 注册 API Key
     */
    registerApiKey(apiKey, clientId, permissionLevel, scope) {
        if (this.apiKeys.size >= this.MAX_API_KEYS && !this.apiKeys.has(apiKey)) {
            const oldestKey = this.apiKeys.keys().next().value;
            this.apiKeys.delete(oldestKey);
        }
        this.apiKeys.set(apiKey, { clientId, permissionLevel, scope });
        Logger_1.Logger.info(`ACP API Key 已注册: ${clientId} (${permissionLevel})`, 'ACPAuth');
    }
    /**
     * 撤销 API Key
     */
    revokeApiKey(apiKey) {
        return this.apiKeys.delete(apiKey);
    }
    /**
     * 认证请求
     */
    authenticate(apiKey) {
        const keyInfo = this.apiKeys.get(apiKey);
        if (!keyInfo) {
            return { authenticated: false, error: 'Invalid API key' };
        }
        const now = Date.now();
        const tokenId = `tk_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const expiresAt = now + 24 * 60 * 60 * 1000;
        const token = {
            tokenId,
            clientId: keyInfo.clientId,
            permissionLevel: keyInfo.permissionLevel,
            scope: keyInfo.scope,
            issuedAt: now,
            expiresAt,
        };
        this.tokens.set(tokenId, token);
        if (this.tokens.size > this.MAX_TOKENS) {
            const oldestKey = this.tokens.keys().next().value;
            this.tokens.delete(oldestKey);
        }
        return { authenticated: true, token };
    }
    /**
     * 验证令牌
     */
    validateToken(tokenId) {
        const token = this.tokens.get(tokenId);
        if (!token)
            return null;
        if (Date.now() > token.expiresAt) {
            this.tokens.delete(tokenId);
            return null;
        }
        return token;
    }
    /**
     * 撤销令牌
     */
    revokeToken(tokenId) {
        return this.tokens.delete(tokenId);
    }
    /**
     * 检查工具权限
     */
    checkToolPermission(token, toolName, toolCategory) {
        if (token.permissionLevel === 'denied') {
            return { allowed: false, reason: 'Access denied' };
        }
        if (token.permissionLevel === 'admin') {
            return { allowed: true };
        }
        if (token.scope.deniedTools?.includes(toolName)) {
            return {
                allowed: false,
                reason: `Tool '${toolName}' is denied for this token`,
            };
        }
        if (toolCategory &&
            token.scope.allowedCategories &&
            token.scope.allowedCategories.length > 0) {
            if (!token.scope.allowedCategories.includes(toolCategory)) {
                return {
                    allowed: false,
                    reason: `Category '${toolCategory}' not allowed`,
                };
            }
        }
        if (token.permissionLevel === 'read') {
            const writeTools = [
                'shell_exec',
                'file_edit',
                'code_generate',
                'code_fix',
                'incremental_edit',
                'multi_file_edit',
            ];
            if (writeTools.includes(toolName)) {
                return {
                    allowed: false,
                    reason: `Write tool '${toolName}' requires write permission`,
                };
            }
        }
        return { allowed: true };
    }
    /**
     * 检查文件路径权限
     */
    checkPathPermission(token, filePath) {
        if (token.permissionLevel === 'admin') {
            return { allowed: true };
        }
        if (token.scope.allowedPaths && token.scope.allowedPaths.length > 0) {
            const allowed = token.scope.allowedPaths.some((p) => filePath.startsWith(p));
            if (!allowed) {
                return {
                    allowed: false,
                    reason: `Path '${filePath}' not in allowed paths`,
                };
            }
        }
        return { allowed: true };
    }
    /**
     * 检查请求频率限制
     */
    checkRateLimit(token) {
        const maxPerHour = token.scope.maxRequestsPerHour ?? 1000;
        const now = Date.now();
        const key = token.tokenId;
        const record = this.requestCounts.get(key);
        if (!record || now - record.windowStart > 3600000) {
            if (this.requestCounts.size >= this.MAX_REQUEST_COUNTS) {
                const oldestKey = this.requestCounts.keys().next().value;
                this.requestCounts.delete(oldestKey);
            }
            this.requestCounts.set(key, { count: 1, windowStart: now });
            return { allowed: true };
        }
        if (record.count >= maxPerHour) {
            return {
                allowed: false,
                reason: `Rate limit exceeded: ${maxPerHour} requests/hour`,
            };
        }
        record.count += 1;
        return { allowed: true };
    }
    /**
     * 获取活跃令牌统计
     */
    getStats() {
        const now = Date.now();
        let activeCount = 0;
        for (const [, token] of this.tokens) {
            if (now <= token.expiresAt)
                activeCount++;
        }
        return { activeTokens: activeCount, registeredKeys: this.apiKeys.size };
    }
    /**
     * 清理过期令牌
     */
    cleanup() {
        const now = Date.now();
        let removed = 0;
        for (const [id, token] of this.tokens) {
            if (now > token.expiresAt) {
                this.tokens.delete(id);
                removed++;
            }
        }
        return removed;
    }
}
exports.ACPAuthManager = ACPAuthManager;
/** ACP 权限守卫——在 ACPServer 处理请求前进行认证和权限检查 */
class ACPPermissionGuard {
    constructor(authManager) {
        this.authManager = authManager;
    }
    /**
     * 从请求头提取认证信息
     */
    extractAuth(headers) {
        const authHeader = headers['authorization'] || headers['Authorization'];
        if (!authHeader) {
            return { authenticated: false, error: 'Missing Authorization header' };
        }
        if (authHeader.startsWith('Bearer ')) {
            const tokenId = authHeader.slice(7);
            const token = this.authManager.validateToken(tokenId);
            if (token) {
                return { authenticated: true, token };
            }
            return { authenticated: false, error: 'Invalid or expired token' };
        }
        if (authHeader.startsWith('ApiKey ')) {
            const apiKey = authHeader.slice(7);
            return this.authManager.authenticate(apiKey);
        }
        return {
            authenticated: false,
            error: 'Unsupported auth scheme. Use Bearer or ApiKey',
        };
    }
    /**
     * 完整的请求权限检查
     */
    checkRequest(token, options) {
        const rateCheck = this.authManager.checkRateLimit(token);
        if (!rateCheck.allowed)
            return rateCheck;
        if (options?.toolName) {
            const toolCheck = this.authManager.checkToolPermission(token, options.toolName, options.toolCategory);
            if (!toolCheck.allowed)
                return toolCheck;
        }
        if (options?.filePath) {
            const pathCheck = this.authManager.checkPathPermission(token, options.filePath);
            if (!pathCheck.allowed)
                return pathCheck;
        }
        return { allowed: true };
    }
}
exports.ACPPermissionGuard = ACPPermissionGuard;
