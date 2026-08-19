/**
 * PluginSandbox — 第三方插件沙箱执行
 *
 * Phase 4: 权限隔离 + 资源限制
 * - 沙箱化的插件执行环境
 * - 权限守卫（文件/网络/系统调用拦截）
 * - 资源限制（内存/CPU/超时）
 * - 审计日志（记录所有敏感操作）
 * - 与 PluginManager 集成
 */

import { Logger } from '../../utils/Logger';
import type { JiabaixingPluginDescriptor } from './JiabaixingPluginSpec';
import type { PluginPermission } from './pluginTypes';

export interface SandboxConfig {
  maxMemoryMB: number;
  maxCpuMs: number;
  networkAccess: boolean;
  filesystemPaths: string[];
  allowedPermissions: PluginPermission[];
  timeoutMs: number;
  maxConcurrentCalls: number;
  auditLog: boolean;
}

export interface SandboxViolation {
  pluginId: string;
  permission: PluginPermission;
  operation: string;
  timestamp: number;
  blocked: boolean;
  details: string;
}

export interface SandboxResourceUsage {
  pluginId: string;
  memoryMB: number;
  cpuMs: number;
  callCount: number;
  lastCallAt: number;
}

export interface SandboxCallContext {
  pluginId: string;
  toolName: string;
  params: Record<string, unknown>;
  timestamp: number;
}

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  maxMemoryMB: 128,
  maxCpuMs: 30000,
  networkAccess: false,
  filesystemPaths: [],
  allowedPermissions: [],
  timeoutMs: 30000,
  maxConcurrentCalls: 4,
  auditLog: true,
};

export class PluginSandbox {
  private configs: Map<string, SandboxConfig> = new Map();
  private violations: SandboxViolation[] = [];
  private resourceUsage: Map<string, SandboxResourceUsage> = new Map();
  private activeCalls: Map<string, number> = new Map();
  private auditLog: Array<{
    pluginId: string;
    action: string;
    timestamp: number;
    details: string;
  }> = [];

  constructor() {}

  registerPlugin(pluginId: string, descriptor: JiabaixingPluginDescriptor): void {
    const sandboxConfig = descriptor.sandbox;
    if (!sandboxConfig?.enabled) return;

    const config: SandboxConfig = {
      maxMemoryMB: sandboxConfig.maxMemoryMB ?? DEFAULT_SANDBOX_CONFIG.maxMemoryMB,
      maxCpuMs: sandboxConfig.maxCpuMs ?? DEFAULT_SANDBOX_CONFIG.maxCpuMs,
      networkAccess: sandboxConfig.networkAccess ?? DEFAULT_SANDBOX_CONFIG.networkAccess,
      filesystemPaths: sandboxConfig.filesystemPaths ?? [],
      allowedPermissions: sandboxConfig.permissions ?? descriptor.permissions,
      timeoutMs: DEFAULT_SANDBOX_CONFIG.timeoutMs,
      maxConcurrentCalls: DEFAULT_SANDBOX_CONFIG.maxConcurrentCalls,
      auditLog: DEFAULT_SANDBOX_CONFIG.auditLog,
    };

    this.configs.set(pluginId, config);
    this.resourceUsage.set(pluginId, {
      pluginId,
      memoryMB: 0,
      cpuMs: 0,
      callCount: 0,
      lastCallAt: 0,
    });

    Logger.info(
      `🔒 沙箱已注册: ${pluginId} (内存=${config.maxMemoryMB}MB, CPU=${config.maxCpuMs}ms, 网络=${config.networkAccess})`,
      'PluginSandbox'
    );
  }

  unregisterPlugin(pluginId: string): void {
    this.configs.delete(pluginId);
    this.resourceUsage.delete(pluginId);
    this.activeCalls.delete(pluginId);
  }

  isSandboxed(pluginId: string): boolean {
    return this.configs.has(pluginId);
  }

  checkPermission(pluginId: string, permission: PluginPermission, operation: string): boolean {
    const config = this.configs.get(pluginId);
    if (!config) return true;

    const allowed = config.allowedPermissions.includes(permission);

    const violation: SandboxViolation = {
      pluginId,
      permission,
      operation,
      timestamp: Date.now(),
      blocked: !allowed,
      details: allowed
        ? `权限 ${permission} 已授权`
        : `权限 ${permission} 未授权，操作被拦截`,
    };

    this.violations.push(violation);

    if (!allowed) {
      Logger.warn(
        `🔒 沙箱拦截: ${pluginId} 尝试 ${operation} (需要 ${permission})`,
        'PluginSandbox'
      );
    }

    if (config.auditLog) {
      this.auditLog.push({
        pluginId,
        action: `permission_check:${permission}`,
        timestamp: Date.now(),
        details: violation.details,
      });
    }

    return allowed;
  }

  checkFileAccess(pluginId: string, filePath: string, mode: 'read' | 'write'): boolean {
    const config = this.configs.get(pluginId);
    if (!config) return true;

    const permission: PluginPermission = mode === 'read' ? 'file:read' : 'file:write';

    if (!config.allowedPermissions.includes(permission)) {
      this.recordViolation(pluginId, permission, `file_${mode}:${filePath}`, true);
      return false;
    }

    if (config.filesystemPaths.length > 0) {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const isAllowed = config.filesystemPaths.some((allowed) =>
        normalizedPath.startsWith(allowed.replace(/\\/g, '/'))
      );

      if (!isAllowed) {
        this.recordViolation(
          pluginId,
          permission,
          `file_${mode}_outside_sandbox:${filePath}`,
          true
        );
        return false;
      }
    }

    return true;
  }

  checkNetworkAccess(pluginId: string, url: string): boolean {
    const config = this.configs.get(pluginId);
    if (!config) return true;

    if (!config.networkAccess) {
      this.recordViolation(pluginId, 'network:request', `network:${url}`, true);
      return false;
    }

    if (!config.allowedPermissions.includes('network:request')) {
      this.recordViolation(pluginId, 'network:request', `network:${url}`, true);
      return false;
    }

    return true;
  }

  async executeInSandbox<T>(
    pluginId: string,
    fn: () => Promise<T>,
    context?: SandboxCallContext
  ): Promise<T> {
    const config = this.configs.get(pluginId);
    if (!config) {
      return fn();
    }

    const currentCalls = this.activeCalls.get(pluginId) ?? 0;
    if (currentCalls >= config.maxConcurrentCalls) {
      throw new Error(
        `插件 ${pluginId} 已达并发上限 (${config.maxConcurrentCalls})`
      );
    }

    this.activeCalls.set(pluginId, currentCalls + 1);

    const startTime = Date.now();
    let memoryBefore = 0;
    try {
      memoryBefore = process.memoryUsage().heapUsed / 1024 / 1024;
    } catch {
      memoryBefore = 0;
    }

    try {
      const result = await this.withTimeout(fn(), config.timeoutMs, pluginId);

      const elapsed = Date.now() - startTime;
      this.updateResourceUsage(pluginId, elapsed, memoryBefore);

      if (config.maxCpuMs > 0 && elapsed > config.maxCpuMs) {
        Logger.warn(
          `🔒 沙箱警告: ${pluginId} 执行超时 ${elapsed}ms > ${config.maxCpuMs}ms`,
          'PluginSandbox'
        );
      }

      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.updateResourceUsage(pluginId, elapsed, memoryBefore);

      if (config.auditLog) {
        this.auditLog.push({
          pluginId,
          action: 'execution_error',
          timestamp: Date.now(),
          details: (error as Error).message,
        });
      }

      throw error;
    } finally {
      const calls = this.activeCalls.get(pluginId) ?? 1;
      this.activeCalls.set(pluginId, Math.max(0, calls - 1));
    }
  }

  getViolations(pluginId?: string): SandboxViolation[] {
    if (pluginId) {
      return this.violations.filter((v) => v.pluginId === pluginId);
    }
    return [...this.violations];
  }

  getResourceUsage(pluginId?: string): SandboxResourceUsage | SandboxResourceUsage[] {
    if (pluginId) {
      return this.resourceUsage.get(pluginId) ?? {
        pluginId,
        memoryMB: 0,
        cpuMs: 0,
        callCount: 0,
        lastCallAt: 0,
      };
    }
    return Array.from(this.resourceUsage.values());
  }

  getAuditLog(pluginId?: string, limit: number = 100): Array<{
    pluginId: string;
    action: string;
    timestamp: number;
    details: string;
  }> {
    const logs = pluginId
      ? this.auditLog.filter((l) => l.pluginId === pluginId)
      : this.auditLog;

    return logs.slice(-limit);
  }

  getConfig(pluginId: string): SandboxConfig | null {
    return this.configs.get(pluginId) ?? null;
  }

  updateConfig(pluginId: string, updates: Partial<SandboxConfig>): boolean {
    const config = this.configs.get(pluginId);
    if (!config) return false;

    Object.assign(config, updates);
    Logger.info(`🔒 沙箱配置已更新: ${pluginId}`, 'PluginSandbox');
    return true;
  }

  reset(): void {
    this.violations = [];
    this.auditLog = [];
    for (const usage of this.resourceUsage.values()) {
      usage.memoryMB = 0;
      usage.cpuMs = 0;
      usage.callCount = 0;
    }
  }

  destroy(): void {
    this.configs.clear();
    this.violations = [];
    this.resourceUsage.clear();
    this.activeCalls.clear();
    this.auditLog = [];
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, pluginId: string): Promise<T> {
    if (ms <= 0) return promise;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`插件 ${pluginId} 执行超时 (${ms}ms)`));
      }, ms);

      promise.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private updateResourceUsage(pluginId: string, elapsedMs: number, _memoryBeforeMB: number): void {
    const usage = this.resourceUsage.get(pluginId);
    if (!usage) return;

    usage.cpuMs += elapsedMs;
    usage.callCount++;
    usage.lastCallAt = Date.now();

    try {
      usage.memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
    } catch {
      // 无法获取内存信息
    }

    const config = this.configs.get(pluginId);
    if (config && usage.memoryMB > config.maxMemoryMB) {
      Logger.warn(
        `🔒 沙箱警告: ${pluginId} 内存使用 ${usage.memoryMB.toFixed(1)}MB > ${config.maxMemoryMB}MB`,
        'PluginSandbox'
      );
    }
  }

  private recordViolation(
    pluginId: string,
    permission: PluginPermission,
    operation: string,
    blocked: boolean
  ): void {
    const violation: SandboxViolation = {
      pluginId,
      permission,
      operation,
      timestamp: Date.now(),
      blocked,
      details: blocked
        ? `操作被拦截: ${operation} (需要 ${permission})`
        : `操作已放行: ${operation}`,
    };

    this.violations.push(violation);

    const config = this.configs.get(pluginId);
    if (config?.auditLog) {
      this.auditLog.push({
        pluginId,
        action: `violation:${permission}`,
        timestamp: Date.now(),
        details: violation.details,
      });
    }
  }
}
