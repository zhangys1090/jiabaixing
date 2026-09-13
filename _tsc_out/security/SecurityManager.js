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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityCore = exports.AuditService = exports.SecurityManager = void 0;
const crypto = __importStar(require("crypto"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const PerformanceMonitor_1 = require("../monitoring/PerformanceMonitor");
const ApiKeyManager_1 = require("./ApiKeyManager");
const AuditLogger_1 = require("./AuditLogger");
const AuthenticationManager_1 = require("./AuthenticationManager");
const EncryptionManager_1 = require("./EncryptionManager");
const SecurityPolicyEngine_1 = require("./SecurityPolicyEngine");
class SecurityManager {
    initialized = false;
    encryptionManager;
    authenticationManager;
    auditLogger;
    policyEngine;
    apiKeyManager;
    emergencyMode = false;
    constructor() {
        this.encryptionManager = new EncryptionManager_1.EncryptionManager();
        this.authenticationManager = new AuthenticationManager_1.AuthenticationManager();
        this.auditLogger = new AuditLogger_1.AuditLogger();
        this.policyEngine = SecurityPolicyEngine_1.SecurityPolicyEngine.getInstance();
        this.apiKeyManager = ApiKeyManager_1.ApiKeyManager.create();
    }
    async initialize() {
        await this.encryptionManager.initialize();
        await this.authenticationManager.initialize();
        await this.auditLogger.initialize();
        this.apiKeyManager.setAuditLogger(this.auditLogger);
        await this.apiKeyManager.initialize();
        this.initialized = true;
    }
    async shutdown() {
        void this.encryptionManager.shutdown();
        void this.authenticationManager.shutdown();
        void this.auditLogger.shutdown();
        await this.apiKeyManager.shutdown();
        this.initialized = false;
        this.policyEngine.clearRateLimits();
        this.emergencyMode = false;
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('安全管理器未初始化');
        }
    }
    getApiKeyManager() {
        return this.apiKeyManager;
    }
    encrypt(data, _options) {
        this.ensureInitialized();
        return PerformanceMonitor_1.perf.measureSync('security.encrypt', () => {
            const encrypted = this.encryptionManager.encrypt(data);
            return JSON.stringify(encrypted);
        }, 'security');
    }
    decrypt(encryptedData) {
        this.ensureInitialized();
        return PerformanceMonitor_1.perf.measureSync('security.decrypt', () => {
            try {
                const parsed = JSON.parse(encryptedData);
                const encryptedDataObj = {
                    iv: parsed.iv,
                    data: parsed.data,
                    timestamp: new Date(parsed.timestamp),
                };
                return this.encryptionManager.decrypt(encryptedDataObj);
            }
            catch {
                return encryptedData;
            }
        }, 'security');
    }
    generateEncryptionKey(length = 32) {
        this.ensureInitialized();
        return this.encryptionManager.generateRandomKey(length);
    }
    generateAES256Key() {
        this.ensureInitialized();
        return this.encryptionManager.generateRandomKey(32);
    }
    hashPassword(password) {
        this.ensureInitialized();
        const salt = this.encryptionManager.generateRandomKey(16);
        const hash = this.encryptionManager.hashWithSaltSync(password, salt);
        return salt + hash;
    }
    verifyPassword(password, hashedPassword) {
        this.ensureInitialized();
        const salt = hashedPassword.substring(0, 32);
        const hash = hashedPassword.substring(32);
        return this.encryptionManager.verifyHashWithSalt(password, hash, salt);
    }
    userStore = new Map();
    addUser(user) {
        this.ensureInitialized();
        const newUser = {
            ...user,
            id: `user_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.userStore.set(newUser.id, newUser);
        return newUser;
    }
    getUser(id) {
        this.ensureInitialized();
        return this.userStore.get(id) || null;
    }
    getUsers() {
        this.ensureInitialized();
        return Array.from(this.userStore.values());
    }
    updateUser(id, updates) {
        this.ensureInitialized();
        const user = this.userStore.get(id);
        if (!user)
            return null;
        const updated = { ...user, ...updates, updatedAt: new Date() };
        this.userStore.set(id, updated);
        return updated;
    }
    deleteUser(id) {
        this.ensureInitialized();
        return this.userStore.delete(id);
    }
    async authenticate(username, password) {
        this.ensureInitialized();
        return PerformanceMonitor_1.perf.measure('security.authenticate', async () => {
            const result = await this.authenticationManager.authenticate({
                username,
                password,
            });
            if (result && typeof result === 'object' && 'user' in result) {
                return result.user;
            }
            return null;
        }, 'security');
    }
    generateAccessToken(userId) {
        this.ensureInitialized();
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            throw new Error('JWT_SECRET 环境变量未配置，拒绝生成令牌');
        }
        return jsonwebtoken_1.default.sign({ userId }, secret, { expiresIn: '24h' });
    }
    validateAccessToken(token) {
        this.ensureInitialized();
        try {
            const result = this.authenticationManager.verifyToken(token);
            const authResult = result;
            if (result &&
                typeof result === 'object' &&
                'valid' in result &&
                authResult.valid) {
                const userId = authResult.userId;
                return this.userStore.get(userId) || null;
            }
        }
        catch {
            return null;
        }
        return null;
    }
    checkPermission(userId, resource, action, context) {
        this.ensureInitialized();
        const user = this.userStore.get(userId) || null;
        return this.policyEngine.checkPermission(user, resource, action, context);
    }
    enableMFA(userId) {
        this.ensureInitialized();
        const user = this.userStore.get(userId);
        if (!user)
            throw new Error('用户不存在');
        const secret = this.encryptionManager.generateRandomKey(16);
        const updated = {
            ...user,
            mfaEnabled: true,
            mfaSecret: secret,
            updatedAt: new Date(),
        };
        this.userStore.set(userId, updated);
        return secret;
    }
    verifyMFA(userId, code) {
        this.ensureInitialized();
        const user = this.userStore.get(userId);
        if (!user || !user.mfaEnabled || !user.mfaSecret)
            return false;
        if (!code || !/^\d{4,8}$/.test(code))
            return false;
        const secret = user.mfaSecret;
        const timeSlice = Math.floor(Date.now() / 30000);
        for (let offset = -1; offset <= 1; offset++) {
            const expectedCode = this.generateTOTP(secret, timeSlice + offset);
            if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expectedCode))) {
                return true;
            }
        }
        return false;
    }
    generateTOTP(secret, timeSlice) {
        const buf = Buffer.alloc(8);
        const hex = timeSlice.toString(16).padStart(16, '0');
        for (let i = 0; i < 8; i++) {
            buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        const key = Buffer.from(secret, 'utf8');
        const hmac = crypto.createHmac('sha1', key).update(buf).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const binary = ((hmac[offset] & 0x7f) << 24) |
            ((hmac[offset + 1] & 0xff) << 16) |
            ((hmac[offset + 2] & 0xff) << 8) |
            (hmac[offset + 3] & 0xff);
        const otp = binary % 1000000;
        return otp.toString().padStart(6, '0');
    }
    disableMFA(userId) {
        this.ensureInitialized();
        const user = this.userStore.get(userId);
        if (!user)
            return false;
        const updated = {
            ...user,
            mfaEnabled: false,
            mfaSecret: undefined,
            updatedAt: new Date(),
        };
        this.userStore.set(userId, updated);
        return true;
    }
    sessionStore = new Map();
    createSession(userId, deviceId, deviceName, ipAddress, userAgent) {
        this.ensureInitialized();
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        this.sessionStore.set(sessionId, {
            userId,
            deviceId,
            deviceName,
            ipAddress,
            userAgent,
            createdAt: new Date(),
            lastAccessed: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        return sessionId;
    }
    validateSession(sessionId) {
        this.ensureInitialized();
        const session = this.sessionStore.get(sessionId);
        if (!session)
            return { valid: false };
        if (session.expiresAt < new Date()) {
            this.sessionStore.delete(sessionId);
            return { valid: false };
        }
        session.lastAccessed = new Date();
        return { valid: true, userId: session.userId };
    }
    getUserSessions(userId) {
        this.ensureInitialized();
        const sessions = [];
        for (const [sessionId, session] of this.sessionStore.entries()) {
            if (session.userId === userId) {
                sessions.push({ sessionId, ...session });
            }
        }
        return sessions;
    }
    terminateSession(sessionId) {
        this.ensureInitialized();
        return this.sessionStore.delete(sessionId);
    }
    terminateAllSessions(userId) {
        this.ensureInitialized();
        let terminated = false;
        for (const [sessionId, session] of this.sessionStore.entries()) {
            if (session.userId === userId) {
                this.sessionStore.delete(sessionId);
                terminated = true;
            }
        }
        return terminated;
    }
    getUserDevices(userId) {
        this.ensureInitialized();
        const devices = [];
        const seen = new Set();
        for (const session of this.sessionStore.values()) {
            if (session.userId === userId && !seen.has(session.deviceId)) {
                seen.add(session.deviceId);
                devices.push({
                    deviceId: session.deviceId,
                    deviceName: session.deviceName,
                    lastLogin: session.lastAccessed,
                    ipAddress: session.ipAddress,
                    userAgent: session.userAgent,
                });
            }
        }
        return devices;
    }
    recordAudit(audit) {
        this.ensureInitialized();
        this.auditLogger.log({
            userId: audit.userId,
            action: audit.action,
            resource: audit.resource,
            result: audit.status,
            details: audit.parameters,
        });
        return {
            ...audit,
            id: `audit_${Date.now()}`,
            timestamp: new Date(),
        };
    }
    getAuditLogs(userId, startDate, endDate) {
        this.ensureInitialized();
        const result = this.auditLogger.queryLogs({
            userId,
            startDate,
            endDate,
        });
        return (Array.isArray(result) ? result : []).map((entry) => ({
            id: entry.id || `audit_${Date.now()}`,
            userId: entry._userId || 'unknown',
            operation: entry.action || 'unknown',
            resource: entry._resource || 'unknown',
            action: entry._action || 'unknown',
            parameters: entry.details || {},
            result: entry._result || 'unknown',
            timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
            ipAddress: entry._ipAddress || 'unknown',
            deviceId: entry._deviceId || 'unknown',
            status: (entry.severity === 'info' ? 'success' : 'failure'),
        }));
    }
    recordSecurityEvent(event) {
        this.ensureInitialized();
        this.auditLogger.log({
            userId: event.userId,
            action: event.type,
            resource: 'security',
            result: 'failure',
            details: { message: event.message, ipAddress: event.ipAddress },
        });
        return {
            ...event,
            id: `event_${Date.now()}`,
            timestamp: new Date(),
        };
    }
    detectPromptInjection(input) {
        this.ensureInitialized();
        return this.policyEngine.detectPromptInjection(input);
    }
    filterHarmfulContent(input) {
        this.ensureInitialized();
        return this.policyEngine.filterHarmfulContent(input);
    }
    checkRateLimit(userId, limit = 60, windowMs = 60000) {
        this.ensureInitialized();
        return this.policyEngine.checkRateLimit(userId, limit, windowMs);
    }
    validateInput(input, maxLength = 1000) {
        this.ensureInitialized();
        return this.policyEngine.validateInput(input, maxLength);
    }
    checkSecurityRedlines(input) {
        this.ensureInitialized();
        return this.policyEngine.checkSecurityRedlines(input);
    }
    secureInputProcessing(input, userId = 'anonymous') {
        this.ensureInitialized();
        return this.policyEngine.secureInputProcessing(input, userId);
    }
    assessRisk(operation, resource, action, parameters) {
        this.ensureInitialized();
        return this.policyEngine.assessRisk(operation, resource, action, parameters);
    }
    activateEmergencyMode(reason) {
        this.ensureInitialized();
        this.emergencyMode = true;
        this.recordSecurityEvent({
            type: 'suspicious_activity',
            severity: 'critical',
            message: `应急模式激活: ${reason}`,
            userId: 'system',
            ipAddress: 'localhost',
            actionTaken: '激活应急模式',
        });
    }
    deactivateEmergencyMode() {
        this.ensureInitialized();
        this.emergencyMode = false;
        this.recordSecurityEvent({
            type: 'suspicious_activity',
            severity: 'low',
            message: '应急模式已解除',
            userId: 'system',
            ipAddress: 'localhost',
            actionTaken: '解除应急模式',
        });
    }
    isEmergencyMode() {
        return this.emergencyMode;
    }
    securityHealthCheck() {
        const issues = [];
        let score = 100;
        try {
            const logStats = this.auditLogger.getLogStats();
            if (logStats.totalLogs === 0) {
                issues.push('审计日志为空');
                score -= 20;
            }
            if (logStats.totalLogs > 0) {
                const failureRate = logStats.failureCount / logStats.totalLogs;
                if (failureRate > 0.5) {
                    issues.push(`认证失败率过高: ${(failureRate * 100).toFixed(1)}%`);
                    score -= 30;
                }
                else if (failureRate > 0.2) {
                    issues.push(`认证失败率偏高: ${(failureRate * 100).toFixed(1)}%`);
                    score -= 15;
                }
            }
        }
        catch {
            issues.push('审计日志服务不可用');
            score -= 30;
        }
        try {
            const securityStats = PerformanceMonitor_1.perf.getCategoryStats('security');
            if (securityStats.totalCalls > 0 && securityStats.errorRate > 0.3) {
                issues.push(`安全操作错误率过高: ${(securityStats.errorRate * 100).toFixed(1)}%`);
                score -= 20;
            }
        }
        catch {
            issues.push('性能监控服务不可用');
            score -= 10;
        }
        try {
            this.encryptionManager.encrypt('healthcheck');
        }
        catch {
            issues.push('加密服务不可用');
            score -= 40;
        }
        if (this.emergencyMode) {
            issues.push('系统处于应急模式');
            score -= 25;
        }
        if (!this.initialized) {
            issues.push('安全管理器未初始化');
            score -= 50;
        }
        score = Math.max(0, Math.min(100, score));
        return {
            healthy: score >= 60,
            score,
            issues,
        };
    }
    async secureExecuteOperation(userId, operation, resource, action, parameters, ipAddress, deviceId) {
        this.ensureInitialized();
        if (this.emergencyMode)
            return { success: false, result: null, error: '系统处于应急模式' };
        const redlineCheck = this.policyEngine.checkSecurityRedlines(`${operation} ${action} ${JSON.stringify(parameters)}`);
        if (redlineCheck.violation) {
            this.recordSecurityEvent({
                type: 'unauthorized',
                severity: 'critical',
                message: `违反安全红线: ${redlineCheck.reasons.join(', ')}`,
                userId,
                ipAddress,
                actionTaken: '拒绝操作',
            });
            return { success: false, result: null, error: '操作违反安全红线' };
        }
        this.recordAudit({
            userId,
            operation,
            resource,
            action,
            parameters,
            result: 'pending',
            ipAddress,
            deviceId,
            status: 'pending',
        });
        return { success: true, result: { success: true, data: '操作执行成功' } };
    }
}
exports.SecurityManager = SecurityManager;
var AuditService_1 = require("./AuditService");
Object.defineProperty(exports, "AuditService", { enumerable: true, get: function () { return AuditService_1.AuditService; } });
var SecurityCore_1 = require("./SecurityCore");
Object.defineProperty(exports, "SecurityCore", { enumerable: true, get: function () { return SecurityCore_1.SecurityCore; } });
