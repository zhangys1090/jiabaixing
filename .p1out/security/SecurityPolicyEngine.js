"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityPolicyEngine = exports.SlidingWindowRateLimiter = exports.CircuitBreaker = void 0;
const Logger_1 = require("../utils/Logger");
const DEFAULT_CIRCUIT_CONFIG = {
    failureThreshold: 5,
    recoveryTimeoutMs: 30000,
    halfOpenMaxRequests: 1,
    monitorIntervalMs: 10000,
};
class CircuitBreaker {
    constructor(name, config) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = 0;
        this.halfOpenRequests = 0;
        this.name = name;
        this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    }
    getState() {
        if (this.state === 'open') {
            if (Date.now() - this.lastFailureTime >= this.config.recoveryTimeoutMs) {
                this.state = 'half_open';
                this.halfOpenRequests = 0;
                Logger_1.Logger.info(`🔓 熔断器 [${this.name}] 进入半开状态`, 'CircuitBreaker');
            }
        }
        return this.state;
    }
    canExecute() {
        const state = this.getState();
        if (state === 'closed')
            return true;
        if (state === 'half_open') {
            return this.halfOpenRequests < this.config.halfOpenMaxRequests;
        }
        return false;
    }
    recordSuccess() {
        if (this.state === 'half_open') {
            this.successCount++;
            if (this.successCount >= this.config.halfOpenMaxRequests) {
                this.state = 'closed';
                this.failureCount = 0;
                this.successCount = 0;
                Logger_1.Logger.info(`✅ 熔断器 [${this.name}] 恢复为关闭状态`, 'CircuitBreaker');
            }
        }
        else {
            this.failureCount = Math.max(0, this.failureCount - 1);
        }
    }
    recordFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.state === 'half_open') {
            this.state = 'open';
            this.successCount = 0;
            Logger_1.Logger.warn(`🔒 熔断器 [${this.name}] 半开状态失败，重新开启`, 'CircuitBreaker');
            return;
        }
        if (this.failureCount >= this.config.failureThreshold) {
            this.state = 'open';
            Logger_1.Logger.warn(`🔒 熔断器 [${this.name}] 开启 (失败${this.failureCount}次 >= 阈值${this.config.failureThreshold})`, 'CircuitBreaker');
        }
    }
    getStats() {
        return {
            name: this.name,
            state: this.getState(),
            failureCount: this.failureCount,
            successCount: this.successCount,
        };
    }
    reset() {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
        this.halfOpenRequests = 0;
    }
}
exports.CircuitBreaker = CircuitBreaker;
class SlidingWindowRateLimiter {
    constructor(limit = 60, windowMs = 60000) {
        this.windows = new Map();
        this.limit = limit;
        this.windowMs = windowMs;
        this.MAX_KEYS = 10000;
    }
    check(key) {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        let entries = this.windows.get(key) || [];
        entries = entries.filter((e) => e.timestamp > cutoff);
        if (entries.length === 0 && this.windows.size >= this.MAX_KEYS) {
            const oldestKey = this.windows.keys().next().value;
            this.windows.delete(oldestKey);
        }
        if (entries.length >= this.limit) {
            const oldestInWindow = entries[0];
            const resetIn = oldestInWindow
                ? oldestInWindow.timestamp + this.windowMs - now
                : this.windowMs;
            this.windows.set(key, entries);
            return { allowed: false, remaining: 0, resetIn: Math.max(0, resetIn) };
        }
        entries.push({ timestamp: now });
        this.windows.set(key, entries);
        return {
            allowed: true,
            remaining: this.limit - entries.length,
            resetIn: this.windowMs,
        };
    }
    getRemaining(key) {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        const entries = (this.windows.get(key) || []).filter((e) => e.timestamp > cutoff);
        return Math.max(0, this.limit - entries.length);
    }
    reset(key) {
        if (key) {
            this.windows.delete(key);
        }
        else {
            this.windows.clear();
        }
    }
}
exports.SlidingWindowRateLimiter = SlidingWindowRateLimiter;
class SecurityPolicyEngine {
    constructor() {
        this.rateLimits = new Map();
        this.MAX_RATE_LIMIT_KEYS = 10000;
        this.circuitBreakers = new Map();
        this.promptInjectionPatterns = [
            /(ignore previous|forget previous|reset|clear context)/i,
            /(system prompt|system instruction)/i,
            /(role:|act as|pretend to be)/i,
            /(bypass|break|override)/i,
            /(prompt injection|prompt hacking)/i,
        ];
        this.forbiddenContentPatterns = [
            /(harmful|dangerous|illegal|unethical)/i,
            /(violence|hate|discrimination)/i,
            /(pornography|obscenity|adult content)/i,
            /(spam|phishing|scam)/i,
            /(炸弹|爆炸|炸药|武器|枪械|制造.*炸弹|自制.*炸药)/i,
            /(杀人|伤害|暴力|攻击)/i,
            /(毒品|赌博|诈骗)/i,
        ];
        this.securityRedlines = [
            /(system access|system control|bypass security)/i,
            /(delete all data|format disk|system shutdown)/i,
            /(unauthorized access|privilege escalation)/i,
            /(data exfiltration|data theft)/i,
            /(malware|virus|trojan)/i,
        ];
        this.slidingWindowLimiter = new SlidingWindowRateLimiter(60, 60000);
    }
    static getInstance() {
        if (!SecurityPolicyEngine.instance) {
            SecurityPolicyEngine.instance = new SecurityPolicyEngine();
        }
        return SecurityPolicyEngine.instance;
    }
    checkPermission(user, resource, action, _context) {
        if (!user)
            return false;
        if (user.role === 'admin')
            return true;
        return user.permissions.some((p) => p === `${resource}:${action}` ||
            p === `${resource}:*` ||
            p === `*:${action}`);
    }
    checkRateLimit(userId, limit = 60, windowMs = 60000) {
        const now = Date.now();
        const rateLimit = this.rateLimits.get(userId);
        if (!rateLimit) {
            if (this.rateLimits.size >= this.MAX_RATE_LIMIT_KEYS) {
                const oldestKey = this.rateLimits.keys().next().value;
                this.rateLimits.delete(oldestKey);
            }
            this.rateLimits.set(userId, { count: 1, lastReset: now });
            return true;
        }
        if (now - rateLimit.lastReset > windowMs) {
            this.rateLimits.set(userId, { count: 1, lastReset: now });
            return true;
        }
        if (rateLimit.count >= limit) {
            return false;
        }
        this.rateLimits.set(userId, {
            count: rateLimit.count + 1,
            lastReset: rateLimit.lastReset,
        });
        return true;
    }
    detectPromptInjection(input) {
        const reasons = [];
        let riskLevel = 'low';
        for (const pattern of this.promptInjectionPatterns) {
            if (pattern.test(input)) {
                reasons.push(`检测到潜在的Prompt注入模式: ${pattern.source}`);
                riskLevel = 'high';
            }
        }
        return { detected: reasons.length > 0, riskLevel, reasons };
    }
    filterHarmfulContent(input) {
        const reasons = [];
        let riskLevel = 'low';
        let safeContent = input;
        for (const pattern of this.forbiddenContentPatterns) {
            if (pattern.test(input)) {
                reasons.push(`检测到有害内容: ${pattern.source}`);
                riskLevel = 'high';
                safeContent = safeContent.replace(pattern, '[内容已过滤]');
            }
        }
        return { filtered: reasons.length > 0, riskLevel, reasons, safeContent };
    }
    validateInput(input, maxLength = 1000) {
        const errors = [];
        if (!input || input.trim().length === 0)
            errors.push('输入不能为空');
        if (input.length > maxLength)
            errors.push(`输入长度不能超过 ${maxLength} 个字符`);
        if (/<script[^>]*>.*?<\/script>/i.test(input))
            errors.push('输入不能包含脚本标签');
        if (/('|"|\b(union|select|insert|update|delete|drop|alter)\b)/i.test(input))
            errors.push('输入可能包含SQL注入攻击');
        return { valid: errors.length === 0, errors };
    }
    checkSecurityRedlines(input) {
        const reasons = [];
        for (const pattern of this.securityRedlines) {
            if (pattern.test(input))
                reasons.push(`违反安全红线: ${pattern.source}`);
        }
        return { violation: reasons.length > 0, reasons };
    }
    secureInputProcessing(input, userId = 'anonymous') {
        const warnings = [];
        if (!this.checkRateLimit(userId)) {
            return {
                safe: false,
                message: '请求过于频繁，请稍后再试',
                processedInput: '',
                warnings: ['速率限制触发'],
            };
        }
        const validation = this.validateInput(input);
        if (!validation.valid) {
            return {
                safe: false,
                message: '输入验证失败',
                processedInput: '',
                warnings: validation.errors,
            };
        }
        const injectionDetection = this.detectPromptInjection(input);
        if (injectionDetection.detected)
            warnings.push(...injectionDetection.reasons);
        const contentFiltering = this.filterHarmfulContent(input);
        if (contentFiltering.filtered)
            warnings.push(...contentFiltering.reasons);
        return {
            safe: true,
            message: '输入处理成功',
            processedInput: contentFiltering.safeContent,
            warnings,
        };
    }
    assessRisk(operation, resource, action, parameters) {
        const reasons = [];
        const requiredActions = [];
        let level = 'low';
        const input = parameters.input || '';
        const highRiskPatterns = [
            /\b(delete|remove|destroy)\b/i,
            /\b(admin|system|security)\b/i,
            /\b(shutdown|restart|reset)\b/i,
            /\b(format|wipe|clear)\b/i,
            /\b(删除|移除|销毁)\b/i,
            /\b(系统|安全|管理员)\b/i,
            /\b(关闭|重启|重置)\b/i,
            /\b(格式化|清除|清空)\b/i,
        ];
        const mediumRiskPatterns = [
            /(write|update|modify)/i,
            /(create|add|new)/i,
            /(execute|run)/i,
        ];
        const lowRiskPatterns = [/(read|view|list)/i, /(info|status|get)/i];
        for (const pattern of highRiskPatterns) {
            if (pattern.test(operation) ||
                pattern.test(action) ||
                pattern.test(String(input))) {
                reasons.push('检测到高风险操作');
                level = 'high';
                requiredActions.push('多因子二次确认');
                break;
            }
        }
        if (level === 'low') {
            for (const pattern of mediumRiskPatterns) {
                if (pattern.test(operation) ||
                    pattern.test(action) ||
                    pattern.test(input)) {
                    reasons.push('检测到中风险操作');
                    level = 'medium';
                    requiredActions.push('单次确认');
                    break;
                }
            }
        }
        if (level === 'low') {
            for (const pattern of lowRiskPatterns) {
                if (pattern.test(operation) ||
                    pattern.test(action) ||
                    pattern.test(input)) {
                    reasons.push('检测到低风险操作');
                    requiredActions.push('自动执行');
                }
            }
        }
        return { level, reasons, requiredActions };
    }
    clearRateLimits() {
        this.rateLimits.clear();
        this.slidingWindowLimiter.reset();
    }
    /**
     * 滑动窗口限流检查（比固定窗口更精确）
     */
    checkSlidingWindowRateLimit(key, limit, windowMs) {
        if (limit && windowMs && (limit !== 60 || windowMs !== 60000)) {
            const limiter = new SlidingWindowRateLimiter(limit, windowMs);
            return limiter.check(key);
        }
        return this.slidingWindowLimiter.check(key);
    }
    /**
     * 获取或创建熔断器
     */
    getCircuitBreaker(name, config) {
        if (!this.circuitBreakers.has(name)) {
            if (this.circuitBreakers.size >= this.MAX_CIRCUIT_BREAKERS) {
                const oldestKey = this.circuitBreakers.keys().next().value;
                this.circuitBreakers.delete(oldestKey);
            }
            this.circuitBreakers.set(name, new CircuitBreaker(name, config));
        }
        return this.circuitBreakers.get(name);
    }
    /**
     * 检查熔断器是否允许执行
     */
    canExecuteWithCircuitBreaker(name) {
        const breaker = this.circuitBreakers.get(name);
        if (!breaker)
            return true;
        return breaker.canExecute();
    }
    /**
     * 获取所有熔断器状态
     */
    getAllCircuitBreakerStats() {
        return Array.from(this.circuitBreakers.values()).map((cb) => cb.getStats());
    }
}
exports.SecurityPolicyEngine = SecurityPolicyEngine;
