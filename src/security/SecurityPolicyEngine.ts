import { Logger } from '../utils/Logger';
import type { RiskAssessment, RiskLevel, User } from './types';
type SecurityRiskLevel = Exclude<RiskLevel, 'none'>;

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  halfOpenMaxRequests: number;
  monitorIntervalMs: number;
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeoutMs: 30000,
  halfOpenMaxRequests: 1,
  monitorIntervalMs: 10000,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private halfOpenRequests = 0;
  private readonly config: CircuitBreakerConfig;
  private readonly name: string;

  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    this.name = name;
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  getState(): CircuitState {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.config.recoveryTimeoutMs) {
        this.state = 'half_open';
        this.halfOpenRequests = 0;
        Logger.info(`🔓 熔断器 [${this.name}] 进入半开状态`, 'CircuitBreaker');
      }
    }
    return this.state;
  }

  canExecute(): boolean {
    const state = this.getState();
    if (state === 'closed') return true;
    if (state === 'half_open') {
      return this.halfOpenRequests < this.config.halfOpenMaxRequests;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenMaxRequests) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
        Logger.info(
          `✅ 熔断器 [${this.name}] 恢复为关闭状态`,
          'CircuitBreaker'
        );
      }
    } else if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      this.state = 'open';
      this.successCount = 0;
      Logger.warn(
        `🔒 熔断器 [${this.name}] 半开状态失败，重新开启`,
        'CircuitBreaker'
      );
      return;
    }

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
      Logger.warn(
        `🔒 熔断器 [${this.name}] 开启 (失败${this.failureCount}次 >= 阈值${this.config.failureThreshold})`,
        'CircuitBreaker'
      );
    }
  }

  getStats(): {
    name: string;
    state: CircuitState;
    failureCount: number;
    successCount: number;
  } {
    return {
      name: this.name,
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenRequests = 0;
  }
}

export interface SlidingWindowEntry {
  timestamp: number;
}

export class SlidingWindowRateLimiter {
  private windows: Map<string, SlidingWindowEntry[]> = new Map();
  private readonly limit: number;
  private readonly windowMs: number;
  private lastCleanup: number = Date.now();
  private static readonly CLEANUP_INTERVAL_MS = 120000;
  private static readonly MAX_KEYS = 10000;

  constructor(limit: number = 60, windowMs: number = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < SlidingWindowRateLimiter.CLEANUP_INTERVAL_MS)
      return;
    this.lastCleanup = now;

    const cutoff = now - this.windowMs;
    for (const [key, entries] of this.windows) {
      const active = entries.filter((e) => e.timestamp > cutoff);
      if (active.length === 0) {
        this.windows.delete(key);
      } else if (active.length !== entries.length) {
        this.windows.set(key, active);
      }
    }

    if (this.windows.size > SlidingWindowRateLimiter.MAX_KEYS) {
      const keys = [...this.windows.keys()].sort((a, b) => {
        const aLast = this.windows.get(a)!.at(-1)?.timestamp ?? 0;
        const bLast = this.windows.get(b)!.at(-1)?.timestamp ?? 0;
        return aLast - bLast;
      });
      const toDelete = keys.slice(
        0,
        this.windows.size - SlidingWindowRateLimiter.MAX_KEYS
      );
      for (const k of toDelete) this.windows.delete(k);
    }
  }

  check(key: string): { allowed: boolean; remaining: number; resetIn: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let entries = this.windows.get(key) || [];
    entries = entries.filter((e) => e.timestamp > cutoff);

    if (entries.length >= this.limit) {
      const oldestInWindow = entries[0];
      const resetIn = oldestInWindow
        ? oldestInWindow.timestamp + this.windowMs - now
        : this.windowMs;
      this.windows.set(key, entries);
      this.maybeCleanup();
      return { allowed: false, remaining: 0, resetIn: Math.max(0, resetIn) };
    }

    entries.push({ timestamp: now });
    this.windows.set(key, entries);
    this.maybeCleanup();
    return {
      allowed: true,
      remaining: this.limit - entries.length,
      resetIn: this.windowMs,
    };
  }

  getRemaining(key: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entries = (this.windows.get(key) || []).filter(
      (e) => e.timestamp > cutoff
    );
    return Math.max(0, this.limit - entries.length);
  }

  reset(key?: string): void {
    if (key) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
    }
  }
}

export class SecurityPolicyEngine {
  private static instance: SecurityPolicyEngine;
  private rateLimits: Map<string, { count: number; lastReset: number }> =
    new Map();
  private slidingWindowLimiter: SlidingWindowRateLimiter;
  private customSlidingWindowLimiters: Map<string, SlidingWindowRateLimiter> =
    new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  private promptInjectionPatterns: RegExp[] = [
    /(ignore previous|forget previous|reset|clear context)/i,
    /(system prompt|system instruction)/i,
    /(role:|act as|pretend to be)/i,
    /(bypass|break|override)/i,
    /(prompt injection|prompt hacking)/i,
  ];

  private forbiddenContentPatterns: RegExp[] = [
    /(harmful|dangerous|illegal|unethical)/i,
    /(violence|hate|discrimination)/i,
    /(pornography|obscenity|adult content)/i,
    /(spam|phishing|scam)/i,
    /(炸弹|爆炸|炸药|武器|枪械|制造.*炸弹|自制.*炸药)/i,
    /(杀人|伤害|暴力|攻击)/i,
    /(毒品|赌博|诈骗)/i,
  ];

  private securityRedlines: RegExp[] = [
    /(system access|system control|bypass security)/i,
    /(delete all data|format disk|system shutdown)/i,
    /(unauthorized access|privilege escalation)/i,
    /(data exfiltration|data theft)/i,
    /(malware|virus|trojan)/i,
  ];

  private constructor() {
    this.slidingWindowLimiter = new SlidingWindowRateLimiter(60, 60000);
  }

  static create(): SecurityPolicyEngine {
    return new SecurityPolicyEngine();
  }

  static getInstance(): SecurityPolicyEngine {
    if (!SecurityPolicyEngine.instance) {
      SecurityPolicyEngine.instance = new SecurityPolicyEngine();
    }
    return SecurityPolicyEngine.instance;
  }

  checkPermission(
    user: User | null,
    resource: string,
    action: string,
    _context?: Record<string, unknown>
  ): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissions.some(
      (p) =>
        p === `${resource}:${action}` ||
        p === `${resource}:*` ||
        p === `*:${action}`
    );
  }

  checkRateLimit(
    userId: string,
    limit: number = 60,
    windowMs: number = 60000
  ): boolean {
    const now = Date.now();
    const rateLimit = this.rateLimits.get(userId);
    if (!rateLimit) {
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

  detectPromptInjection(input: string): {
    detected: boolean;
    riskLevel: SecurityRiskLevel;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let riskLevel: SecurityRiskLevel = 'low';
    for (const pattern of this.promptInjectionPatterns) {
      if (pattern.test(input)) {
        reasons.push(`检测到潜在的Prompt注入模式: ${pattern.source}`);
        riskLevel = 'high';
      }
    }
    return { detected: reasons.length > 0, riskLevel, reasons };
  }

  filterHarmfulContent(input: string): {
    filtered: boolean;
    riskLevel: SecurityRiskLevel;
    reasons: string[];
    safeContent: string;
  } {
    const reasons: string[] = [];
    let riskLevel: SecurityRiskLevel = 'low';
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

  validateInput(
    input: string,
    maxLength: number = 1000
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!input || input.trim().length === 0) errors.push('输入不能为空');
    if (input.length > maxLength)
      errors.push(`输入长度不能超过 ${maxLength} 个字符`);
    if (/<script[^>]*>.*?<\/script>/i.test(input))
      errors.push('输入不能包含脚本标签');
    const sqlInjectionPatterns = [
      /(\bunion\s+(all\s+)?select\b[\s\S]{0,80}\bfrom\b)/i,
      /(\binsert\s+into\b[\s\S]{0,40}\bvalues\b)/i,
      /(\bupdate\s+\w+\s+set\b[\s\S]{0,40}=)/i,
      /(\bdelete\s+from\b[\s\S]{0,20}\bwhere\b)/i,
      /(\bdrop\s+table\b)/i,
      /(\balter\s+table\b)/i,
      /('\s*or\s+'[^']*'\s*=\s*')/i,
      /('\s*;\s*(drop|delete|update|insert|select)\b)/i,
    ];
    for (const pattern of sqlInjectionPatterns) {
      if (pattern.test(input)) {
        errors.push('输入可能包含SQL注入攻击');
        break;
      }
    }
    return { valid: errors.length === 0, errors };
  }

  checkSecurityRedlines(input: string): {
    violation: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    for (const pattern of this.securityRedlines) {
      if (pattern.test(input)) reasons.push(`违反安全红线: ${pattern.source}`);
    }
    return { violation: reasons.length > 0, reasons };
  }

  secureInputProcessing(
    input: string,
    userId: string = 'anonymous'
  ): {
    safe: boolean;
    message: string;
    processedInput: string;
    warnings: string[];
  } {
    const warnings: string[] = [];
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
    if (contentFiltering.filtered) warnings.push(...contentFiltering.reasons);
    return {
      safe: true,
      message: '输入处理成功',
      processedInput: contentFiltering.safeContent,
      warnings,
    };
  }

  assessRisk(
    operation: string,
    resource: string,
    action: string,
    parameters: Record<string, unknown>
  ): RiskAssessment {
    const reasons: string[] = [];
    const requiredActions: string[] = [];
    let level: RiskLevel = 'low';
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
      if (
        pattern.test(operation) ||
        pattern.test(action) ||
        pattern.test(String(input))
      ) {
        reasons.push('检测到高风险操作');
        level = 'high';
        requiredActions.push('多因子二次确认');
        break;
      }
    }
    if (level === 'low') {
      for (const pattern of mediumRiskPatterns) {
        if (
          pattern.test(operation) ||
          pattern.test(action) ||
          pattern.test(input as string)
        ) {
          reasons.push('检测到中风险操作');
          level = 'medium';
          requiredActions.push('单次确认');
          break;
        }
      }
    }
    if (level === 'low') {
      for (const pattern of lowRiskPatterns) {
        if (
          pattern.test(operation) ||
          pattern.test(action) ||
          pattern.test(input as string)
        ) {
          reasons.push('检测到低风险操作');
          requiredActions.push('自动执行');
        }
      }
    }
    return { level, reasons, requiredActions };
  }

  clearRateLimits(): void {
    this.rateLimits.clear();
    this.slidingWindowLimiter.reset();
  }

  /**
   * 滑动窗口限流检查（比固定窗口更精确）
   */
  checkSlidingWindowRateLimit(
    key: string,
    limit?: number,
    windowMs?: number
  ): { allowed: boolean; remaining: number; resetIn: number } {
    if (limit && windowMs && (limit !== 60 || windowMs !== 60000)) {
      const cacheKey = `${limit}:${windowMs}`;
      let limiter = this.customSlidingWindowLimiters.get(cacheKey);
      if (!limiter) {
        limiter = new SlidingWindowRateLimiter(limit, windowMs);
        this.customSlidingWindowLimiters.set(cacheKey, limiter);
      }
      return limiter.check(key);
    }
    return this.slidingWindowLimiter.check(key);
  }

  /**
   * 获取或创建熔断器
   */
  getCircuitBreaker(
    name: string,
    config?: Partial<CircuitBreakerConfig>
  ): CircuitBreaker {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(name, new CircuitBreaker(name, config));
    }
    return this.circuitBreakers.get(name)!;
  }

  /**
   * 检查熔断器是否允许执行
   */
  canExecuteWithCircuitBreaker(name: string): boolean {
    const breaker = this.circuitBreakers.get(name);
    if (!breaker) return true;
    return breaker.canExecute();
  }

  /**
   * 获取所有熔断器状态
   */
  getAllCircuitBreakerStats(): Array<{
    name: string;
    state: CircuitState;
    failureCount: number;
    successCount: number;
  }> {
    return Array.from(this.circuitBreakers.values()).map((cb) => cb.getStats());
  }
}
