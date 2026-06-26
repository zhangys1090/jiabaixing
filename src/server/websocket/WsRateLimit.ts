/**
 * WebSocket 限流和熔断模块
 * 从 websocket.ts 提取，使用 SecurityPolicyEngine 统一限流
 */

import { SecurityPolicyEngine } from '../../security/SecurityPolicyEngine';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

export interface CircuitBreakerResult {
  canExecute: boolean;
  state: string;
}

/**
 * WebSocket 限流器
 */
export class WsRateLimiter {
  private policyEngine: SecurityPolicyEngine;
  private defaultLimit: number;
  private defaultWindowMs: number;

  constructor(limit?: number, windowMs?: number) {
    this.policyEngine = SecurityPolicyEngine.getInstance();
    this.defaultLimit = limit ?? 30;
    this.defaultWindowMs = windowMs ?? 10000;
  }

  /**
   * 检查滑动窗口限流
   * @param key - 限流键（如 userId:ip）
   * @param limit - 请求次数限制
   * @param windowMs - 时间窗口（毫秒）
   */
  check(key: string, limit?: number, windowMs?: number): RateLimitResult {
    return this.policyEngine.checkSlidingWindowRateLimit(
      key,
      limit ?? this.defaultLimit,
      windowMs ?? this.defaultWindowMs
    );
  }

  /**
   * 标准化限流检查（使用默认配置）
   */
  checkStandard(key: string): RateLimitResult {
    return this.check(key, 30, 10000);
  }
}

/**
 * WebSocket 熔断器
 */
export class WsCircuitBreaker {
  private policyEngine: SecurityPolicyEngine;
  private readonly name: string;

  constructor(name: string = 'llm_processing') {
    this.policyEngine = SecurityPolicyEngine.getInstance();
    this.name = name;
  }

  /**
   * 检查是否可以执行
   */
  canExecute(): CircuitBreakerResult {
    const breaker = this.policyEngine.getCircuitBreaker(this.name);
    return {
      canExecute: breaker.canExecute(),
      state: breaker.getState(),
    };
  }

  /**
   * 记录成功
   */
  recordSuccess(): void {
    this.policyEngine.getCircuitBreaker(this.name).recordSuccess();
  }

  /**
   * 记录失败
   */
  recordFailure(): void {
    this.policyEngine.getCircuitBreaker(this.name).recordFailure();
  }

  /**
   * 获取熔断器状态
   */
  getState(): { state: string; failureCount: number; successCount: number } {
    const breaker = this.policyEngine.getCircuitBreaker(this.name);
    const stats = breaker.getStats();
    return {
      state: stats.state,
      failureCount: stats.failureCount,
      successCount: stats.successCount,
    };
  }
}

/**
 * 限流检查失败响应
 */
export function createRateLimitErrorResponse(retryAfterMs: number): object {
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
export function createCircuitOpenResponse(): object {
  return {
    type: 'error',
    data: {
      message: '服务暂时不可用，请稍后再试',
      code: 'circuit_open',
    },
  };
}
