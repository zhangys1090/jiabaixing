"use strict";
/**
 * Harness Layer 2: Tools - 统一权限守卫
 *
 * 合并原 PermissionGuard + AutonomyPermissionGuard
 * 单一职责：权限检查 + 自主性控制 + 审计追踪
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionGuard = void 0;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
const RISK_CONFIRMATION_MAP = {
    none: false,
    low: false,
    medium: false,
    high: true,
    critical: true,
};
const RISK_ORDER = ['none', 'low', 'medium', 'high', 'critical'];
const DEFAULT_PERMISSIONS = [
    types_1.Permission.MEMORY_READ,
    types_1.Permission.MEMORY_WRITE,
    types_1.Permission.FILE_READ,
    types_1.Permission.FILE_WRITE,
    types_1.Permission.CODE_EXECUTE,
    types_1.Permission.NETWORK_ACCESS,
];
const ADMIN_PERMISSIONS = [
    ...DEFAULT_PERMISSIONS,
    types_1.Permission.DESKTOP_CONTROL,
    types_1.Permission.NETWORK_ACCESS,
    types_1.Permission.SYSTEM_ADMIN,
];
const DEFAULT_SESSION_LIMITS = {
    maxToolCalls: 100,
    maxConsecutiveSame: 5,
    autoStopThreshold: 5,
    riskThreshold: 'high',
};
class PermissionGuard {
    static AUDIT_TRAIL_MAX = 2000;
    static AUDIT_TRAIL_TRIM_TO = 1500;
    userPermissions = new Map();
    pendingConfirmations = new Map();
    toolPolicies = new Map();
    sessionStats = new Map();
    sessionLimits = new Map();
    auditTrail = [];
    staleCleanupInterval;
    static STALE_CONFIRMATION_MS = 60000;
    static MAX_PENDING_CONFIRMATIONS = 100;
    constructor() {
        this.loadDefaultPolicies();
        this.staleCleanupInterval = setInterval(() => this.cleanupStaleConfirmations(), 30000);
        if (this.staleCleanupInterval.unref) {
            this.staleCleanupInterval.unref();
        }
    }
    cleanupStaleConfirmations() {
        const now = Date.now();
        for (const [id, entry] of this.pendingConfirmations) {
            if (now - entry.createdAt > PermissionGuard.STALE_CONFIRMATION_MS) {
                entry.resolve(false);
                this.pendingConfirmations.delete(id);
                Logger_1.Logger.warn(`⏰ 清理过期确认: ${entry.toolName}`, 'PermissionGuard');
            }
        }
    }
    loadDefaultPolicies() {
        const defaultAskTools = [
            'shell_exec',
            'desktop_automate',
            'multi_file_edit',
        ];
        for (const tool of defaultAskTools) {
            this.toolPolicies.set(tool, { toolName: tool, policy: 'ask' });
        }
    }
    /**
     * 统一权限检查 — 合并基础权限 + 自主性控制
     */
    check(toolName, requiredPermissions, riskLevel, context) {
        const sessionId = context.sessionId || 'default';
        const traceId = context.traceId || 'unknown';
        // 1. 会话限制检查
        const stats = this.getOrCreateStats(sessionId);
        const limits = this.getOrCreateLimits(sessionId);
        if (stats.toolCallCount >= limits.maxToolCalls) {
            this.recordAudit(traceId, toolName, false, `会话工具调用已达上限 (${limits.maxToolCalls})`, riskLevel);
            return {
                allowed: false,
                missing: [],
                reason: `会话工具调用已达上限 (${limits.maxToolCalls})`,
            };
        }
        if (stats.consecutiveTool?.tool === toolName &&
            stats.consecutiveTool.count >= limits.maxConsecutiveSame) {
            this.recordAudit(traceId, toolName, false, `连续调用 ${toolName} 已达上限`, riskLevel);
            return {
                allowed: false,
                missing: [],
                reason: `连续调用 ${toolName} 已达上限 (${limits.maxConsecutiveSame})`,
            };
        }
        // 2. 工具策略检查
        const policy = this.getEffectivePolicy(toolName);
        if (policy.policy === 'deny') {
            this.recordAudit(traceId, toolName, false, policy.reason || '工具已被禁用', riskLevel);
            return {
                allowed: false,
                missing: [],
                reason: policy.reason || '该工具已被禁用',
                policy: 'deny',
            };
        }
        // 3. 基础权限检查
        const missing = [];
        for (const perm of requiredPermissions) {
            if (!context.permissions.has(perm)) {
                missing.push(perm);
            }
        }
        if (missing.length > 0) {
            Logger_1.Logger.warn(`🚫 权限不足: ${toolName} 缺少 [${missing.join(', ')}]`, 'PermissionGuard');
            this.recordAudit(traceId, toolName, false, `缺少权限: ${missing.join(', ')}`, riskLevel);
            return {
                allowed: false,
                missing,
                reason: `缺少权限: ${missing.join(', ')}`,
            };
        }
        // 4. 风险阈值检查
        const riskIndex = RISK_ORDER.indexOf(riskLevel);
        const thresholdIndex = RISK_ORDER.indexOf(limits.riskThreshold);
        if (riskIndex >= thresholdIndex && policy.policy !== 'allow') {
            this.recordAudit(traceId, toolName, false, `风险超过阈值: ${riskLevel}`, riskLevel);
            return {
                allowed: false,
                missing: [],
                reason: `需要确认: ${riskLevel} 风险操作`,
                needsConfirmation: true,
                policy: 'ask',
            };
        }
        // 5. 高风险确认标记
        const needsConfirmation = policy.policy === 'ask' || RISK_CONFIRMATION_MAP[riskLevel];
        if (needsConfirmation) {
            Logger_1.Logger.info(`⚠️ 需确认: ${toolName} (${riskLevel})`, 'PermissionGuard');
        }
        this.recordAudit(traceId, toolName, true, needsConfirmation ? '等待确认' : '权限检查通过', riskLevel);
        return {
            allowed: true,
            missing: [],
            needsConfirmation,
            policy: policy.policy,
        };
    }
    /**
     * 记录工具执行结果 — 更新会话统计
     */
    recordExecution(sessionId, toolName, result) {
        const stats = this.getOrCreateStats(sessionId);
        stats.toolCallCount++;
        if (stats.consecutiveTool?.tool === toolName) {
            stats.consecutiveTool.count++;
        }
        else {
            stats.consecutiveTool = { tool: toolName, count: 1 };
        }
        if (!result.success) {
            stats.errorCount++;
            const limits = this.getOrCreateLimits(sessionId);
            if (stats.errorCount >= limits.autoStopThreshold) {
                Logger_1.Logger.warn(`🛑 错误次数已达阈值 (${limits.autoStopThreshold})`, 'PermissionGuard');
            }
        }
    }
    /**
     * 设置工具策略
     */
    setToolPolicy(toolName, policy, reason, expiresInMs) {
        this.toolPolicies.set(toolName, {
            toolName,
            policy,
            reason,
            expiresAt: expiresInMs ? Date.now() + expiresInMs : undefined,
        });
        Logger_1.Logger.info(`🔐 工具策略: ${toolName} → ${policy}`, 'PermissionGuard');
    }
    /**
     * 设置会话限制
     */
    setSessionLimits(sessionId, limits) {
        const current = this.getOrCreateLimits(sessionId);
        this.sessionLimits.set(sessionId, { ...current, ...limits });
    }
    getUserPermissions(userId) {
        let perms = this.userPermissions.get(userId);
        if (!perms) {
            perms = new Set(DEFAULT_PERMISSIONS);
            this.userPermissions.set(userId, perms);
        }
        return perms;
    }
    grantPermission(userId, permission) {
        this.getUserPermissions(userId).add(permission);
        Logger_1.Logger.info(`✅ 授予权限: ${permission} → ${userId}`, 'PermissionGuard');
    }
    revokePermission(userId, permission) {
        this.getUserPermissions(userId).delete(permission);
        Logger_1.Logger.info(`❌ 撤销权限: ${permission} → ${userId}`, 'PermissionGuard');
    }
    setAdmin(userId) {
        this.userPermissions.set(userId, new Set(ADMIN_PERMISSIONS));
        Logger_1.Logger.info(`👑 管理员: ${userId}`, 'PermissionGuard');
    }
    getSessionStatus(sessionId) {
        const stats = this.getOrCreateStats(sessionId);
        const limits = this.getOrCreateLimits(sessionId);
        return { ...stats, maxToolCalls: limits.maxToolCalls };
    }
    getAuditTrail(limit) {
        return limit ? this.auditTrail.slice(-limit) : this.auditTrail;
    }
    resetSession(sessionId) {
        this.sessionStats.delete(sessionId);
        this.sessionLimits.delete(sessionId);
    }
    destroy() {
        clearInterval(this.staleCleanupInterval);
        for (const [, entry] of this.pendingConfirmations) {
            entry.resolve(false);
        }
        this.pendingConfirmations.clear();
    }
    async requestConfirmation(toolName, riskLevel, timeoutMs = 30000) {
        if (this.pendingConfirmations.size >=
            PermissionGuard.MAX_PENDING_CONFIRMATIONS) {
            Logger_1.Logger.warn(`🛑 待确认队列已满 (${PermissionGuard.MAX_PENDING_CONFIRMATIONS})，拒绝: ${toolName}`, 'PermissionGuard');
            return false;
        }
        const confirmationId = `${toolName}-${Date.now()}`;
        return new Promise((resolve) => {
            this.pendingConfirmations.set(confirmationId, {
                toolName,
                riskLevel,
                resolve,
                createdAt: Date.now(),
            });
            setTimeout(() => {
                const pending = this.pendingConfirmations.get(confirmationId);
                if (pending) {
                    this.pendingConfirmations.delete(confirmationId);
                    Logger_1.Logger.warn(`⏰ 确认超时: ${toolName}`, 'PermissionGuard');
                    resolve(false);
                }
            }, timeoutMs);
        });
    }
    confirm(confirmationId, approved) {
        const pending = this.pendingConfirmations.get(confirmationId);
        if (pending) {
            this.pendingConfirmations.delete(confirmationId);
            pending.resolve(approved);
        }
    }
    getEffectivePolicy(toolName) {
        let policy = this.toolPolicies.get(toolName);
        if (!policy) {
            for (const [key, entry] of this.toolPolicies) {
                if (key.endsWith('*') && toolName.startsWith(key.slice(0, -1))) {
                    policy = entry;
                    break;
                }
            }
        }
        if (policy?.expiresAt && Date.now() > policy.expiresAt) {
            this.toolPolicies.delete(toolName);
            policy = undefined;
        }
        return policy || { toolName, policy: 'allow' };
    }
    getOrCreateStats(sessionId) {
        let stats = this.sessionStats.get(sessionId);
        if (!stats) {
            stats = { toolCallCount: 0, errorCount: 0, consecutiveTool: null };
            this.sessionStats.set(sessionId, stats);
        }
        return stats;
    }
    getOrCreateLimits(sessionId) {
        let limits = this.sessionLimits.get(sessionId);
        if (!limits) {
            limits = { ...DEFAULT_SESSION_LIMITS };
            this.sessionLimits.set(sessionId, limits);
        }
        return limits;
    }
    recordAudit(traceId, toolName, allowed, reason, riskLevel) {
        this.auditTrail.push({
            timestamp: Date.now(),
            traceId,
            toolName,
            allowed,
            reason,
            riskLevel,
        });
        if (this.auditTrail.length > PermissionGuard.AUDIT_TRAIL_MAX) {
            this.auditTrail = this.auditTrail.slice(-PermissionGuard.AUDIT_TRAIL_TRIM_TO);
        }
    }
}
exports.PermissionGuard = PermissionGuard;
