/**
 * SecurityCore — 安全核心模块
 *
 * 合并自: SecurityPolicyEngine + SecurityGuard + NetworkGuard
 * 职责: 输入校验、策略引擎、网络守卫、沙箱检查、权限控制
 */

// ── 向后兼容: 重新导出原有模块 ──
export {
  SecurityPolicyEngine,
  CircuitBreaker,
  SlidingWindowRateLimiter,
} from './SecurityPolicyEngine';
export type {
  CircuitBreakerConfig,
  CircuitState,
} from './SecurityPolicyEngine';

export { SecurityGuard } from './SecurityGuard';
export type {
  SecurityCheckResult,
  SecurityContext,
  UserRole,
  PermissionConfig,
} from './SecurityGuard';

export { NetworkGuard } from './NetworkGuard';

// ── SecurityCore 统一入口 ──
import { SecurityPolicyEngine } from './SecurityPolicyEngine';
import { SecurityGuard } from './SecurityGuard';
import { NetworkGuard } from './NetworkGuard';

export interface SecurityCoreConfig {
  enableNetworkGuard: boolean;
  enableRateLimit: boolean;
  rateLimitPerMinute: number;
  riskThreshold: 'low' | 'medium' | 'high' | 'critical';
}

const DEFAULT_CORE_CONFIG: SecurityCoreConfig = {
  enableNetworkGuard: true,
  enableRateLimit: true,
  rateLimitPerMinute: 60,
  riskThreshold: 'high',
};

export class SecurityCore {
  private static instance: SecurityCore | null = null;
  private readonly policyEngine: SecurityPolicyEngine;
  private readonly guard: SecurityGuard;
  private readonly config: SecurityCoreConfig;

  private constructor(config?: Partial<SecurityCoreConfig>) {
    this.config = { ...DEFAULT_CORE_CONFIG, ...config };
    this.policyEngine = SecurityPolicyEngine.getInstance();
    this.guard = SecurityGuard.getInstance();

    if (this.config.enableNetworkGuard) {
      NetworkGuard.install();
    }
  }

  static getInstance(config?: Partial<SecurityCoreConfig>): SecurityCore {
    if (!SecurityCore.instance) {
      SecurityCore.instance = new SecurityCore(config);
    }
    return SecurityCore.instance;
  }

  getPolicyEngine(): SecurityPolicyEngine {
    return this.policyEngine;
  }

  getGuard(): SecurityGuard {
    return this.guard;
  }

  validateInput(input: string, maxLength: number = 10000) {
    return this.guard.validateInput(input, maxLength);
  }

  validateCommand(command: string) {
    return this.guard.validateCommand(command);
  }

  sandboxCheck(code: string, language: string = 'javascript') {
    return this.guard.sandboxCheck(code, language);
  }

  checkRateLimit(userId: string, limit?: number, windowMs?: number): boolean {
    if (!this.config.enableRateLimit) return true;
    return this.policyEngine.checkRateLimit(userId, limit, windowMs);
  }

  detectPromptInjection(input: string) {
    return this.policyEngine.detectPromptInjection(input);
  }

  filterHarmfulContent(input: string) {
    return this.policyEngine.filterHarmfulContent(input);
  }

  checkSecurityRedlines(input: string) {
    return this.policyEngine.checkSecurityRedlines(input);
  }

  assessRisk(
    operation: string,
    resource: string,
    action: string,
    parameters: Record<string, unknown>
  ) {
    return this.policyEngine.assessRisk(
      operation,
      resource,
      action,
      parameters
    );
  }

  isUrlAllowed(url: string): boolean {
    return NetworkGuard.isUrlAllowed(url);
  }

  getCircuitBreaker(
    name: string,
    config?: Parameters<SecurityPolicyEngine['getCircuitBreaker']>[1]
  ) {
    return this.policyEngine.getCircuitBreaker(name, config);
  }

  healthCheck(): { healthy: boolean; details: Record<string, unknown> } {
    const details: Record<string, unknown> = {};
    let healthy = true;

    try {
      this.guard.getAuditLogs({ limit: 1 });
      details.guardAvailable = true;
    } catch {
      details.guardAvailable = false;
      healthy = false;
    }

    try {
      this.policyEngine.checkRateLimit('health-check', 1, 60000);
      details.policyEngineAvailable = true;
    } catch {
      details.policyEngineAvailable = false;
      healthy = false;
    }

    details.networkGuardEnabled = this.config.enableNetworkGuard;
    details.rateLimitEnabled = this.config.enableRateLimit;

    return { healthy, details };
  }
}
