"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionTokenQuotaManager = void 0;
const EventBus_1 = require("../../shared/EventBus");
const errors_1 = require("../../shared/errors");
const Logger_1 = require("../../utils/Logger");
const DEFAULT_QUOTA_CONFIG = {
    maxTokensPerSession: 500000,
    maxTokensPerRequest: 50000,
    warningThresholdPercent: 80,
    resetIntervalMs: 3600000,
};
class SessionTokenQuotaManager {
    static instance = null;
    sessions = new Map();
    config;
    cleanupTimerId = null;
    static MAX_SESSIONS = 5000;
    constructor(config = {}) {
        this.config = { ...DEFAULT_QUOTA_CONFIG, ...config };
        this.startCleanupTimer();
        Logger_1.Logger.info(`📊 SessionTokenQuotaManager 已初始化 (会话上限: ${this.config.maxTokensPerSession} tokens, 请求上限: ${this.config.maxTokensPerRequest} tokens)`, 'SessionTokenQuota');
    }
    static create(config = {}) {
        return new SessionTokenQuotaManager(config);
    }
    static getInstance(config) {
        if (!SessionTokenQuotaManager.instance) {
            SessionTokenQuotaManager.instance = new SessionTokenQuotaManager(config);
        }
        return SessionTokenQuotaManager.instance;
    }
    static resetInstance() {
        if (SessionTokenQuotaManager.instance) {
            SessionTokenQuotaManager.instance.shutdown();
            SessionTokenQuotaManager.instance = null;
        }
    }
    recordUsage(sessionId, promptTokens, completionTokens) {
        let usage = this.sessions.get(sessionId);
        const now = Date.now();
        if (!usage) {
            usage = {
                sessionId,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                requestCount: 0,
                lastActivityTime: now,
                createdAt: now,
            };
            this.sessions.set(sessionId, usage);
        }
        usage.promptTokens += promptTokens;
        usage.completionTokens += completionTokens;
        usage.totalTokens += promptTokens + completionTokens;
        usage.requestCount++;
        usage.lastActivityTime = now;
        const usagePercent = (usage.totalTokens / this.config.maxTokensPerSession) * 100;
        if (usagePercent >= this.config.warningThresholdPercent &&
            usagePercent < 100) {
            Logger_1.Logger.warn(`⚠️ 会话 ${sessionId} Token 使用率: ${usagePercent.toFixed(1)}% (${usage.totalTokens}/${this.config.maxTokensPerSession})`, 'SessionTokenQuota');
            EventBus_1.EventBus.emit('token_quota_warning', {
                sessionId,
                usagePercent,
                totalTokens: usage.totalTokens,
                maxTokens: this.config.maxTokensPerSession,
                timestamp: new Date().toISOString(),
            });
        }
        return usage;
    }
    checkQuota(sessionId, estimatedTokens = 0) {
        const usage = this.sessions.get(sessionId);
        if (!usage) {
            return {
                allowed: true,
                remaining: this.config.maxTokensPerSession,
                usage: null,
            };
        }
        const remaining = this.config.maxTokensPerSession - usage.totalTokens;
        if (remaining <= 0) {
            return {
                allowed: false,
                remaining: 0,
                usage,
                reason: `会话 ${sessionId} Token 配额已耗尽 (${usage.totalTokens}/${this.config.maxTokensPerSession})`,
            };
        }
        if (estimatedTokens > this.config.maxTokensPerRequest) {
            return {
                allowed: false,
                remaining,
                usage,
                reason: `预估 Token 数 (${estimatedTokens}) 超过单次请求上限 (${this.config.maxTokensPerRequest})`,
            };
        }
        if (estimatedTokens > remaining) {
            return {
                allowed: false,
                remaining,
                usage,
                reason: `预估 Token 数 (${estimatedTokens}) 超过剩余配额 (${remaining})`,
            };
        }
        return { allowed: true, remaining, usage };
    }
    enforceQuota(sessionId, estimatedTokens = 0) {
        const check = this.checkQuota(sessionId, estimatedTokens);
        if (!check.allowed) {
            const usage = check.usage;
            throw new errors_1.TokenQuotaExceededError(usage?.totalTokens ?? estimatedTokens, this.config.maxTokensPerSession, sessionId);
        }
    }
    getSessionUsage(sessionId) {
        return this.sessions.get(sessionId) ?? null;
    }
    getAllSessionUsages() {
        return Array.from(this.sessions.values());
    }
    resetSession(sessionId) {
        this.sessions.delete(sessionId);
        Logger_1.Logger.info(`🔄 会话 ${sessionId} Token 配额已重置`, 'SessionTokenQuota');
    }
    getQuotaStats() {
        const usages = Array.from(this.sessions.values());
        const totalTokens = usages.reduce((sum, u) => sum + u.totalTokens, 0);
        const nearLimitThreshold = this.config.maxTokensPerSession *
            (this.config.warningThresholdPercent / 100);
        return {
            activeSessions: usages.length,
            totalTokensConsumed: totalTokens,
            averageTokensPerSession: usages.length > 0 ? Math.round(totalTokens / usages.length) : 0,
            sessionsNearLimit: usages.filter((u) => u.totalTokens >= nearLimitThreshold).length,
        };
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        Logger_1.Logger.info(`📊 SessionTokenQuota 配置已更新: 会话上限=${this.config.maxTokensPerSession}, 请求上限=${this.config.maxTokensPerRequest}`, 'SessionTokenQuota');
    }
    startCleanupTimer() {
        this.cleanupTimerId = setInterval(() => this.cleanupExpiredSessions(), this.config.resetIntervalMs);
    }
    cleanupExpiredSessions() {
        const now = Date.now();
        let cleaned = 0;
        for (const [sessionId, usage] of this.sessions) {
            const inactiveTime = now - usage.lastActivityTime;
            if (inactiveTime > this.config.resetIntervalMs) {
                this.sessions.delete(sessionId);
                cleaned++;
            }
        }
        if (this.sessions.size > SessionTokenQuotaManager.MAX_SESSIONS) {
            const sorted = Array.from(this.sessions.entries()).sort(([, a], [, b]) => a.lastActivityTime - b.lastActivityTime);
            const toRemove = sorted.slice(0, this.sessions.size - SessionTokenQuotaManager.MAX_SESSIONS);
            for (const [sessionId] of toRemove) {
                this.sessions.delete(sessionId);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            Logger_1.Logger.debug(`🧹 清理 ${cleaned} 个过期会话的 Token 配额记录`, 'SessionTokenQuota');
        }
    }
    shutdown() {
        if (this.cleanupTimerId) {
            clearInterval(this.cleanupTimerId);
            this.cleanupTimerId = null;
        }
        this.sessions.clear();
        Logger_1.Logger.info('📊 SessionTokenQuotaManager 已关闭', 'SessionTokenQuota');
    }
}
exports.SessionTokenQuotaManager = SessionTokenQuotaManager;
