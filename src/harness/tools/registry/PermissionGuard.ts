/**
 * Harness Layer 2: Tools - 统一权限守卫
 *
 * 合并原 PermissionGuard + AutonomyPermissionGuard
 * 单一职责：权限检查 + 自主性控制 + 审计追踪
 */

import { Logger } from '../../../utils/Logger';
import { Permission } from '../../types';
import type { RiskLevel, ToolContext, ToolResult } from '../../types';

/** 工具访问策略 */
export type ToolAccessPolicy = 'allow' | 'deny' | 'ask';

/** 权限检查结果 */
export interface PermissionCheckResult {
  allowed: boolean;
  missing: Permission[];
  reason?: string;
  needsConfirmation?: boolean;
  policy?: ToolAccessPolicy;
}

/** 工具策略条目 */
interface ToolPolicyEntry {
  toolName: string;
  policy: ToolAccessPolicy;
  reason?: string;
  expiresAt?: number;
}

/** 审计记录 */
interface AuditEntry {
  timestamp: number;
  traceId: string;
  toolName: string;
  allowed: boolean;
  reason: string;
  riskLevel: RiskLevel;
}

/** 会话统计 */
interface SessionStats {
  toolCallCount: number;
  errorCount: number;
  consecutiveTool: { tool: string; count: number } | null;
}

/** 会话限制配置 */
export interface SessionLimits {
  maxToolCalls: number;
  maxConsecutiveSame: number;
  autoStopThreshold: number;
  riskThreshold: RiskLevel;
}

const RISK_CONFIRMATION_MAP: Record<RiskLevel, boolean> = {
  low: false,
  medium: false,
  high: true,
  critical: true,
};

const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

const DEFAULT_PERMISSIONS: Permission[] = [
  Permission.MEMORY_READ,
  Permission.MEMORY_WRITE,
  Permission.FILE_READ,
  Permission.FILE_WRITE,
  Permission.CODE_EXECUTE,
  Permission.NETWORK_ACCESS,
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...DEFAULT_PERMISSIONS,
  Permission.DESKTOP_CONTROL,
  Permission.NETWORK_ACCESS,
  Permission.SYSTEM_ADMIN,
];

const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxToolCalls: 100,
  maxConsecutiveSame: 5,
  autoStopThreshold: 5,
  riskThreshold: 'high',
};

export class PermissionGuard {
  private userPermissions: Map<string, Set<Permission>> = new Map();
  private pendingConfirmations: Map<
    string,
    {
      toolName: string;
      riskLevel: RiskLevel;
      resolve: (confirmed: boolean) => void;
    }
  > = new Map();

  private toolPolicies: Map<string, ToolPolicyEntry> = new Map();
  private sessionStats: Map<string, SessionStats> = new Map();
  private sessionLimits: Map<string, SessionLimits> = new Map();
  private auditTrail: AuditEntry[] = [];

  constructor() {
    this.loadDefaultPolicies();
  }

  private loadDefaultPolicies(): void {
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
  check(
    toolName: string,
    requiredPermissions: Permission[],
    riskLevel: RiskLevel,
    context: ToolContext & { sessionId?: string }
  ): PermissionCheckResult {
    const sessionId = context.sessionId || 'default';
    const traceId = context.traceId || 'unknown';

    // 1. 会话限制检查
    const stats = this.getOrCreateStats(sessionId);
    const limits = this.getOrCreateLimits(sessionId);
    if (stats.toolCallCount >= limits.maxToolCalls) {
      this.recordAudit(
        traceId,
        toolName,
        false,
        `会话工具调用已达上限 (${limits.maxToolCalls})`,
        riskLevel
      );
      return {
        allowed: false,
        missing: [],
        reason: `会话工具调用已达上限 (${limits.maxToolCalls})`,
      };
    }
    if (
      stats.consecutiveTool?.tool === toolName &&
      stats.consecutiveTool.count >= limits.maxConsecutiveSame
    ) {
      this.recordAudit(
        traceId,
        toolName,
        false,
        `连续调用 ${toolName} 已达上限`,
        riskLevel
      );
      return {
        allowed: false,
        missing: [],
        reason: `连续调用 ${toolName} 已达上限 (${limits.maxConsecutiveSame})`,
      };
    }

    // 2. 工具策略检查
    const policy = this.getEffectivePolicy(toolName);
    if (policy.policy === 'deny') {
      this.recordAudit(
        traceId,
        toolName,
        false,
        policy.reason || '工具已被禁用',
        riskLevel
      );
      return {
        allowed: false,
        missing: [],
        reason: policy.reason || '该工具已被禁用',
        policy: 'deny',
      };
    }

    // 3. 基础权限检查
    const missing: Permission[] = [];
    for (const perm of requiredPermissions) {
      if (!context.permissions.has(perm)) {
        missing.push(perm);
      }
    }
    if (missing.length > 0) {
      Logger.warn(
        `🚫 权限不足: ${toolName} 缺少 [${missing.join(', ')}]`,
        'PermissionGuard'
      );
      this.recordAudit(
        traceId,
        toolName,
        false,
        `缺少权限: ${missing.join(', ')}`,
        riskLevel
      );
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
      this.recordAudit(
        traceId,
        toolName,
        false,
        `风险超过阈值: ${riskLevel}`,
        riskLevel
      );
      return {
        allowed: false,
        missing: [],
        reason: `需要确认: ${riskLevel} 风险操作`,
        needsConfirmation: true,
        policy: 'ask',
      };
    }

    // 5. 高风险确认标记
    const needsConfirmation =
      policy.policy === 'ask' || RISK_CONFIRMATION_MAP[riskLevel];
    if (needsConfirmation) {
      Logger.info(`⚠️ 需确认: ${toolName} (${riskLevel})`, 'PermissionGuard');
    }

    this.recordAudit(
      traceId,
      toolName,
      true,
      needsConfirmation ? '等待确认' : '权限检查通过',
      riskLevel
    );
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
  recordExecution(
    sessionId: string,
    toolName: string,
    result: ToolResult
  ): void {
    const stats = this.getOrCreateStats(sessionId);
    stats.toolCallCount++;

    if (stats.consecutiveTool?.tool === toolName) {
      stats.consecutiveTool.count++;
    } else {
      stats.consecutiveTool = { tool: toolName, count: 1 };
    }

    if (!result.success) {
      stats.errorCount++;
      const limits = this.getOrCreateLimits(sessionId);
      if (stats.errorCount >= limits.autoStopThreshold) {
        Logger.warn(
          `🛑 错误次数已达阈值 (${limits.autoStopThreshold})`,
          'PermissionGuard'
        );
      }
    }
  }

  /**
   * 设置工具策略
   */
  setToolPolicy(
    toolName: string,
    policy: ToolAccessPolicy,
    reason?: string,
    expiresInMs?: number
  ): void {
    this.toolPolicies.set(toolName, {
      toolName,
      policy,
      reason,
      expiresAt: expiresInMs ? Date.now() + expiresInMs : undefined,
    });
    Logger.info(`🔐 工具策略: ${toolName} → ${policy}`, 'PermissionGuard');
  }

  /**
   * 设置会话限制
   */
  setSessionLimits(sessionId: string, limits: Partial<SessionLimits>): void {
    const current = this.getOrCreateLimits(sessionId);
    this.sessionLimits.set(sessionId, { ...current, ...limits });
  }

  getUserPermissions(userId: string): Set<Permission> {
    let perms = this.userPermissions.get(userId);
    if (!perms) {
      perms = new Set(DEFAULT_PERMISSIONS);
      this.userPermissions.set(userId, perms);
    }
    return perms;
  }

  grantPermission(userId: string, permission: Permission): void {
    this.getUserPermissions(userId).add(permission);
    Logger.info(`✅ 授予权限: ${permission} → ${userId}`, 'PermissionGuard');
  }

  revokePermission(userId: string, permission: Permission): void {
    this.getUserPermissions(userId).delete(permission);
    Logger.info(`❌ 撤销权限: ${permission} → ${userId}`, 'PermissionGuard');
  }

  setAdmin(userId: string): void {
    this.userPermissions.set(userId, new Set(ADMIN_PERMISSIONS));
    Logger.info(`👑 管理员: ${userId}`, 'PermissionGuard');
  }

  getSessionStatus(sessionId: string): SessionStats & { maxToolCalls: number } {
    const stats = this.getOrCreateStats(sessionId);
    const limits = this.getOrCreateLimits(sessionId);
    return { ...stats, maxToolCalls: limits.maxToolCalls };
  }

  getAuditTrail(limit?: number): AuditEntry[] {
    return limit ? this.auditTrail.slice(-limit) : this.auditTrail;
  }

  resetSession(sessionId: string): void {
    this.sessionStats.delete(sessionId);
    this.sessionLimits.delete(sessionId);
  }

  async requestConfirmation(
    toolName: string,
    riskLevel: RiskLevel,
    timeoutMs: number = 30000
  ): Promise<boolean> {
    const confirmationId = `${toolName}-${Date.now()}`;
    return new Promise<boolean>((resolve) => {
      this.pendingConfirmations.set(confirmationId, {
        toolName,
        riskLevel,
        resolve,
      });
      setTimeout(() => {
        const pending = this.pendingConfirmations.get(confirmationId);
        if (pending) {
          this.pendingConfirmations.delete(confirmationId);
          Logger.warn(`⏰ 确认超时: ${toolName}`, 'PermissionGuard');
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  confirm(confirmationId: string, approved: boolean): void {
    const pending = this.pendingConfirmations.get(confirmationId);
    if (pending) {
      this.pendingConfirmations.delete(confirmationId);
      pending.resolve(approved);
    }
  }

  private getEffectivePolicy(toolName: string): ToolPolicyEntry {
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

  private getOrCreateStats(sessionId: string): SessionStats {
    let stats = this.sessionStats.get(sessionId);
    if (!stats) {
      stats = { toolCallCount: 0, errorCount: 0, consecutiveTool: null };
      this.sessionStats.set(sessionId, stats);
    }
    return stats;
  }

  private getOrCreateLimits(sessionId: string): SessionLimits {
    let limits = this.sessionLimits.get(sessionId);
    if (!limits) {
      limits = { ...DEFAULT_SESSION_LIMITS };
      this.sessionLimits.set(sessionId, limits);
    }
    return limits;
  }

  private recordAudit(
    traceId: string,
    toolName: string,
    allowed: boolean,
    reason: string,
    riskLevel: RiskLevel
  ): void {
    this.auditTrail.push({
      timestamp: Date.now(),
      traceId,
      toolName,
      allowed,
      reason,
      riskLevel,
    });
    if (this.auditTrail.length > 10000) this.auditTrail.shift();
  }
}
