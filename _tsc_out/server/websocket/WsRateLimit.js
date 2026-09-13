"use strict";
/**
 * WebSocket 限流和熔断模块
 * 从 websocket.ts 提取，使用 SecurityPolicyEngine 统一限流
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsCircuitBreaker = exports.WsRateLimiter = void 0;
exports.createRateLimitErrorResponse = createRateLimitErrorResponse;
exports.createCircuitOpenResponse = createCircuitOpenResponse;
const SecurityPolicyEngine_1 = require("../../security/SecurityPolicyEngine");
/**
 * WebSocket 限流器
 */
class WsRateLimiter {
    policyEngine;
    defaultLimit;
    defaultWindowMs;
    constructor(limit, windowMs) {
        this.policyEngine = SecurityPolicyEngine_1.SecurityPolicyEngine.getInstance();
        this.defaultLimit = limit ?? 30;
        this.defaultWindowMs = windowMs ?? 10000;
    }
    /**
     * 检查滑动窗口限流
     * @param key - 限流键（如 userId:ip）
     * @param limit - 请求次数限制
     * @param windowMs - 时间窗口（毫秒）
     */
    check(key, limit, windowMs) {
        return this.policyEngine.checkSlidingWindowRateLimit(key, limit ?? this.defaultLimit, windowMs ?? this.defaultWindowMs);
    }
    /**
     * 标准化限流检查（使用默认配置）
     */
    checkStandard(key) {
        return this.check(key, 30, 10000);
    }
}
exports.WsRateLimiter = WsRateLimiter;
/**
 * WebSocket 熔断器
 */
class WsCircuitBreaker {
    policyEngine;
    name;
    constructor(name = 'llm_processing') {
        this.policyEngine = SecurityPolicyEngine_1.SecurityPolicyEngine.getInstance();
        this.name = name;
    }
    /**
     * 检查是否可以执行
     */
    canExecute() {
        const breaker = this.policyEngine.getCircuitBreaker(this.name);
        return {
            canExecute: breaker.canExecute(),
            state: breaker.getState(),
        };
    }
    /**
     * 记录成功
     */
    recordSuccess() {
        this.policyEngine.getCircuitBreaker(this.name).recordSuccess();
    }
    /**
     * 记录失败
     */
    recordFailure() {
        this.policyEngine.getCircuitBreaker(this.name).recordFailure();
    }
    /**
     * 获取熔断器状态
     */
    getState() {
        const breaker = this.policyEngine.getCircuitBreaker(this.name);
        const stats = breaker.getStats();
        return {
            state: stats.state,
            failureCount: stats.failureCount,
            successCount: stats.successCount,
        };
    }
}
exports.WsCircuitBreaker = WsCircuitBreaker;
/**
 * 限流检查失败响应
 */
function createRateLimitErrorResponse(retryAfterMs) {
    return {
        type: 'error',
        data: {
            message: `请求过于频繁，请${Math.ceil(retryAfterMs / 1000)}秒后再试`,
            code: 'rate_limit_exceeded',
            retryAfter: retryAfterMs,
        },
    };
}
/**
 * 熔断器开启响应
 */
function createCircuitOpenResponse() {
    return {
        type: 'error',
        data: {
            message: '服务暂时不可用，请稍后再试',
            code: 'circuit_open',
        },
    };
}
