/**
 * Harness Layer 2: Tools - 权限守卫
 *
 * 工具执行前的权限检查
 * 基于 Permission 枚举和 RiskLevel 分级控制
 */

import { Logger } from '../../../utils/Logger';
import { Permission } from '../../types';
import type { RiskLevel, ToolContext } from '../../types';

/** 权限检查结果 */
export interface PermissionCheckResult {
  allowed: boolean;
  missing: Permission[];
  reason?: string;
}

/** 风险等级对应的确认要求 */
const RISK_CONFIRMATION_MAP: Record<RiskLevel, boolean> = {
  low: false,
  medium: false,
  high: true,
  critical: true,
};

/** 默认权限集 — 普通用户 */
const DEFAULT_PERMISSIONS: Permission[] = [
  Permission.MEMORY_READ,
  Permission.MEMORY_WRITE,
  Permission.FILE_READ,
  Permission.FILE_WRITE,
  Permission.CODE_EXECUTE,
];

/** 管理员权限集 */
const ADMIN_PERMISSIONS: Permission[] = [
  ...DEFAULT_PERMISSIONS,
  Permission.DESKTOP_CONTROL,
  Permission.NETWORK_ACCESS,
  Permission.SYSTEM_ADMIN,
];

export class PermissionGuard {
  /** 用户权限缓存 */
  private userPermissions: Map<string, Set<Permission>> = new Map();

  /** 待确认的操作 */
  private pendingConfirmations: Map<
    string,
    {
      toolName: string;
      riskLevel: RiskLevel;
      resolve: (confirmed: boolean) => void;
    }
  > = new Map();

  /**
   * 检查工具执行权限
   */
  check(
    toolName: string,
    requiredPermissions: Permission[],
    riskLevel: RiskLevel,
    context: ToolContext
  ): PermissionCheckResult {
    const userPerms = context.permissions;

    // 检查缺失的权限
    const missing: Permission[] = [];
    for (const perm of requiredPermissions) {
      if (!userPerms.has(perm)) {
        missing.push(perm);
      }
    }

    if (missing.length > 0) {
      Logger.warn(
        `🚫 权限不足: ${toolName} 缺少 [${missing.join(', ')}]`,
        'PermissionGuard'
      );
      return {
        allowed: false,
        missing,
        reason: `缺少权限: ${missing.join(', ')}`,
      };
    }

    // 检查风险等级是否需要确认
    if (RISK_CONFIRMATION_MAP[riskLevel]) {
      Logger.info(
        `⚠️ 高风险操作: ${toolName} 风险=${riskLevel}，需要确认`,
        'PermissionGuard'
      );
      // 实际确认逻辑由 Constraints 层的 LifecycleHook 处理
      // 这里只记录，不阻止（确认是异步流程）
    }

    return { allowed: true, missing: [] };
  }

  /**
   * 获取用户权限集
   */
  getUserPermissions(userId: string): Set<Permission> {
    let perms = this.userPermissions.get(userId);
    if (!perms) {
      perms = new Set(DEFAULT_PERMISSIONS);
      this.userPermissions.set(userId, perms);
    }
    return perms;
  }

  /**
   * 授予用户权限
   */
  grantPermission(userId: string, permission: Permission): void {
    const perms = this.getUserPermissions(userId);
    perms.add(permission);
    Logger.info(
      `✅ 授予权限: ${permission} → 用户 ${userId}`,
      'PermissionGuard'
    );
  }

  /**
   * 撤销用户权限
   */
  revokePermission(userId: string, permission: Permission): void {
    const perms = this.getUserPermissions(userId);
    perms.delete(permission);
    Logger.info(
      `❌ 撤销权限: ${permission} → 用户 ${userId}`,
      'PermissionGuard'
    );
  }

  /**
   * 设置用户为管理员
   */
  setAdmin(userId: string): void {
    this.userPermissions.set(userId, new Set(ADMIN_PERMISSIONS));
    Logger.info(`👑 设置管理员: ${userId}`, 'PermissionGuard');
  }

  /**
   * 请求确认高风险操作
   */
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

      // 超时自动拒绝
      setTimeout(() => {
        const pending = this.pendingConfirmations.get(confirmationId);
        if (pending) {
          this.pendingConfirmations.delete(confirmationId);
          Logger.warn(
            `⏰ 确认超时: ${toolName}，自动拒绝`,
            'PermissionGuard'
          );
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  /**
   * 确认操作
   */
  confirm(confirmationId: string, approved: boolean): void {
    const pending = this.pendingConfirmations.get(confirmationId);
    if (pending) {
      this.pendingConfirmations.delete(confirmationId);
      pending.resolve(approved);
      Logger.info(
        `${approved ? '✅' : '❌'} 用户${approved ? '确认' : '拒绝'}: ${pending.toolName}`,
        'PermissionGuard'
      );
    }
  }
}
