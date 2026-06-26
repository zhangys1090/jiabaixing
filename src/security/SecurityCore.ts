/**
 * SecurityCore — 安全核心模块
 *
 * 合并自: SecurityPolicyEngine + SecurityGuard + NetworkGuard
 * 职责: 输入校验、策略引擎、网络守卫、沙箱检查、权限控制
 * 集成: UrlSafetyChecker + SslGuard + ShellHooks
 */

// ── 向后兼容: 重新导出原有模块 ──
export {
  CircuitBreaker,
  SecurityPolicyEngine,
  SlidingWindowRateLimiter,
} from './SecurityPolicyEngine';
export type {
  CircuitBreakerConfig,
  CircuitState,
} from './SecurityPolicyEngine';

export { SecurityGuard } from './SecurityGuard';
export type {
  PermissionConfig,
  SecurityCheckResult,
  SecurityContext,
  UserRole,
} from './SecurityGuard';

export { NetworkGuard } from './NetworkGuard';

export { UrlSafetyChecker } from './UrlSafetyChecker';
export type { UrlSafetyResult } from './UrlSafetyChecker';

export { SslGuard } from './SslGuard';
export type { SslCheckResult, SslGuardConfig } from './SslGuard';

export { ShellHooks, registerBuiltinShellHooks } from './ShellHooks';
export type {
  ShellHookContext,
  ShellHookEntry,
  ShellHookFn,
  ShellHookResult,
} from './ShellHooks';

// ── SecurityCore 统一入口 ──
import type {
  SensitiveCheckResult,
  SensitiveCheckScene,
} from '../harness/security/SensitiveDetector';
import {
  checkDangerousCommand as _checkDangerousCommand,
  checkSensitiveInfo as _checkSensitiveInfo,
  sanitizeText as _sanitizeText,
} from '../harness/security/SensitiveDetector';
import { NetworkGuard } from './NetworkGuard';
import { SecurityGuard } from './SecurityGuard';
import { SecurityPolicyEngine } from './SecurityPolicyEngine';
import { ShellHooks, registerBuiltinShellHooks } from './ShellHooks';
import { SslGuard } from './SslGuard';
import { UrlSafetyChecker } from './UrlSafetyChecker';

export interface SecurityCoreConfig {
  enableNetworkGuard: boolean;
  enableRateLimit: boolean;
  rateLimitPerMinute: number;
  riskThreshold: 'low' | 'medium' | 'high' | 'critical';
  enableUrlSafety: boolean;
  enableSslGuard: boolean;
  enableShellHooks: boolean;
  enableSensitiveDetection: boolean;
}

const DEFAULT_CORE_CONFIG: SecurityCoreConfig = {
  enableNetworkGuard: true,
  enableRateLimit: true,
  rateLimitPerMinute: 60,
  riskThreshold: 'high',
  enableUrlSafety: true,
  enableSslGuard: true,
  enableShellHooks: true,
  enableSensitiveDetection: true,
};

export class SecurityCore {
  private static instance: SecurityCore | null = null;
  private readonly policyEngine: SecurityPolicyEngine;
  private readonly guard: SecurityGuard;
  private readonly urlSafety: UrlSafetyChecker;
  private readonly sslGuard: SslGuard;
  private readonly shellHooks: ShellHooks;
  private readonly config: SecurityCoreConfig;

  private constructor(config?: Partial<SecurityCoreConfig>) {
    this.config = { ...DEFAULT_CORE_CONFIG, ...config };
    this.policyEngine = SecurityPolicyEngine.getInstance();
    this.guard = SecurityGuard.getInstance();
    this.urlSafety = UrlSafetyChecker.getInstance();
    this.sslGuard = SslGuard.getInstance();
    this.shellHooks = ShellHooks.getInstance();

    if (this.config.enableNetworkGuard) {
      NetworkGuard.install();
    }

    if (this.config.enableShellHooks) {
      registerBuiltinShellHooks();
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

  getUrlSafety(): UrlSafetyChecker {
    return this.urlSafety;
  }

  checkUrlSafety(url: string) {
    if (!this.config.enableUrlSafety) {
      return {
        safe: true,
        riskLevel: 'safe' as const,
        category: '已禁用',
        reason: 'URL安全检查已禁用',
        url,
      };
    }
    return this.urlSafety.check(url);
  }

  getSslGuard(): SslGuard {
    return this.sslGuard;
  }

  getShellHooks(): ShellHooks {
    return this.shellHooks;
  }

  async runShellPreHooks(context: import('./ShellHooks').ShellHookContext) {
    if (!this.config.enableShellHooks) {
      return { proceed: true };
    }
    return this.shellHooks.runPreHooks(context);
  }

  async runShellPostHooks(
    context: import('./ShellHooks').ShellHookContext,
    exitCode: number,
    stdout: string,
    stderr: string
  ) {
    if (!this.config.enableShellHooks) return;
    return this.shellHooks.runPostHooks(context, exitCode, stdout, stderr);
  }

  checkSensitiveInfo(
    text: string,
    scene: SensitiveCheckScene = 'output'
  ): SensitiveCheckResult {
    if (!this.config.enableSensitiveDetection) {
      return {
        safe: true,
        riskLevel: 'none',
        violations: [],
      };
    }
    return _checkSensitiveInfo(text, scene);
  }

  checkDangerousCommand(command: string): {
    dangerous: boolean;
    reason?: string;
  } {
    if (!this.config.enableSensitiveDetection) {
      return { dangerous: false };
    }
    return _checkDangerousCommand(command);
  }

  sanitizeText(text: string): string {
    return _sanitizeText(text);
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
    details.urlSafetyEnabled = this.config.enableUrlSafety;
    details.sslGuardEnabled = this.config.enableSslGuard;
    details.shellHooksEnabled = this.config.enableShellHooks;
    details.sensitiveDetectionEnabled = this.config.enableSensitiveDetection;

    if (this.config.enableShellHooks) {
      details.registeredShellHooks =
        this.shellHooks.getRegisteredHooks().length;
    }

    return { healthy, details };
  }
}
