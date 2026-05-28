/**
 * Harness Layer 6: Constraints - 约束服务
 *
 * 5 重防御体系 + 生命周期钩子
 */

import { Logger } from '../../utils/Logger';
import type {
  BudgetState,
  BudgetCheckResult,
  Permission,
  PermissionResult,
  ToolContext,
  LifecycleEvent,
  LifecycleHook,
  HookContext,
  HookResult,
} from '../types';

/** 约束服务依赖 */
export interface ConstraintsServiceDeps {
  /** 权限守卫 */
  permissionGuard: {
    check(
      toolName: string,
      requiredPermissions: Permission[],
      riskLevel: string,
      context: ToolContext
    ): { allowed: boolean; missing: Permission[]; reason?: string };
  };
}

export class ConstraintsService {
  private deps: ConstraintsServiceDeps;
  private hooks: Map<LifecycleEvent, LifecycleHook[]> = new Map();

  constructor(deps: ConstraintsServiceDeps) {
    this.deps = deps;
  }

  /**
   * 检查预算
   */
  checkBudget(state: BudgetState): BudgetCheckResult {
    const warnings: string[] = [];

    if (state.roundsUsed >= state.hardRoundLimit) {
      warnings.push(`轮次已达硬限制 ${state.hardRoundLimit}`);
    } else if (state.roundsUsed >= state.softRoundLimit) {
      warnings.push(
        `轮次已达软限制 ${state.softRoundLimit}/${state.hardRoundLimit}`
      );
    }

    if (state.tokensUsed >= state.tokenHardLimit) {
      warnings.push(`Token 已达硬限制 ${state.tokenHardLimit}`);
    } else if (state.tokensUsed >= state.tokenWarningLimit) {
      warnings.push(
        `Token 接近限制 ${state.tokenWarningLimit}/${state.tokenHardLimit}`
      );
    }

    if (state.toolCallsUsed >= state.maxToolCalls) {
      warnings.push(`工具调用已达上限 ${state.maxToolCalls}`);
    }

    const elapsed = Date.now() - state.startTime;
    if (elapsed >= state.maxDurationMs) {
      warnings.push(`时间已达上限 ${state.maxDurationMs}ms`);
    }

    return {
      withinBudget: warnings.length === 0,
      warnings,
      remaining: {
        rounds: Math.max(0, state.hardRoundLimit - state.roundsUsed),
        tokens: Math.max(0, state.tokenHardLimit - state.tokensUsed),
        toolCalls: Math.max(0, state.maxToolCalls - state.toolCallsUsed),
        durationMs: Math.max(0, state.maxDurationMs - elapsed),
      },
    };
  }

  /**
   * 检查权限
   */
  checkPermission(
    toolName: string,
    requiredPermissions: Permission[],
    riskLevel: string,
    context: ToolContext
  ): PermissionResult {
    const result = this.deps.permissionGuard.check(
      toolName,
      requiredPermissions,
      riskLevel,
      context
    );
    return {
      allowed: result.allowed,
      missing: result.missing,
      reason: result.reason,
    };
  }

  /**
   * 安全边界检查
   */
  checkSafetyBoundary(
    input: string,
    action: string
  ): {
    allowed: boolean;
    reason?: string;
  } {
    // 检查输入长度
    if (input.length > 10000) {
      return { allowed: false, reason: '输入过长，可能存在注入攻击' };
    }

    // 检查危险操作
    const dangerousActions = [
      'rm -rf',
      'del /f',
      'format',
      'shutdown',
      'drop table',
    ];
    const lowerAction = action.toLowerCase();
    for (const da of dangerousActions) {
      if (lowerAction.includes(da)) {
        return { allowed: false, reason: `禁止执行危险操作: ${da}` };
      }
    }

    return { allowed: true };
  }

  /**
   * 注册生命周期钩子
   */
  registerHook(event: LifecycleEvent, hook: LifecycleHook): void {
    const existing = this.hooks.get(event) || [];
    existing.push(hook);
    this.hooks.set(event, existing);
    Logger.debug(`注册生命周期钩子: ${event}`, 'ConstraintsService');
  }

  /**
   * 执行生命周期钩子
   */
  async executeHooks(
    event: LifecycleEvent,
    context: HookContext
  ): Promise<HookResult> {
    const hooks = this.hooks.get(event) || [];

    for (const hook of hooks) {
      try {
        const result = await hook(context);
        if (!result.proceed) {
          Logger.info(
            `🛑 钩子拦截: ${event} - ${result.reason || '未提供原因'}`,
            'ConstraintsService'
          );
          return result;
        }

        // 应用修改
        if (result.modifiedParams) {
          context.params = result.modifiedParams;
        }
      } catch (err) {
        Logger.warn(
          `钩子执行失败: ${event} - ${(err as Error).message}`,
          'ConstraintsService'
        );
      }
    }

    return { proceed: true };
  }

  /**
   * 行为约束检查
   */
  enforceBehaviorConstraint(
    constraint: string,
    context: unknown
  ): { compliant: boolean; violation?: string } {
    const ctx = context as {
      toolName?: string;
      params?: Record<string, unknown>;
      result?: { success: boolean; output?: unknown };
    } | null;

    switch (constraint) {
      case 'no-unbounded-recursion': {
        const recursionDepth = (ctx?.params?.recursionDepth as number) || 0;
        const maxDepth = 10;
        if (recursionDepth >= maxDepth) {
          return {
            compliant: false,
            violation: `递归深度 ${recursionDepth} 超过限制 ${maxDepth}，可能存在无限递归风险`,
          };
        }
        return { compliant: true };
      }

      case 'no-unauthorized-file-access': {
        const filePath = ctx?.params?.filePath as string;
        if (filePath) {
          const forbiddenPaths = [
            process.env.HOME || '',
            process.env.USERPROFILE || '',
            '/etc',
            '/root',
            'C:\\Windows',
            'C:\\Program Files',
            'C:\\Program Files (x86)',
          ];
          for (const forbidden of forbiddenPaths) {
            if (filePath.startsWith(forbidden)) {
              return {
                compliant: false,
                violation: `禁止访问系统目录: ${forbidden}`,
              };
            }
          }
        }
        return { compliant: true };
      }

      case 'no-sensitive-data-leak': {
        const output = ctx?.result?.output;
        if (output) {
          const outputStr =
            typeof output === 'string' ? output : JSON.stringify(output);
          const sensitivePatterns = [
            { pattern: /\b\d{16,19}\b/g, name: '银行卡号' },
            { pattern: /\b\d{6}\d{4}\d{2}\d{2}\d{4}\b/g, name: '身份证号' },
            {
              pattern: /(?:password|密码|secret|密钥)\s*[:=]\s*\S+/gi,
              name: '密码/密钥',
            },
            {
              pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
              name: '邮箱地址',
            },
            { pattern: /\b1[3-9]\d{9}\b/g, name: '手机号码' },
            {
              pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
              name: 'IPv4地址',
            },
            {
              pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/gi,
              name: 'IPv6地址',
            },
            {
              pattern: /::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/gi,
              name: 'IPv6地址',
            },
          ];

          for (const { pattern, name } of sensitivePatterns) {
            if (pattern.test(outputStr)) {
              return {
                compliant: false,
                violation: `检测到可能泄露的敏感信息: ${name}`,
              };
            }
          }
        }
        return { compliant: true };
      }

      case 'no-sensitive-storage': {
        const toolName = ctx?.toolName as string;
        if (toolName !== 'memory_store' && toolName !== 'note_take') {
          return { compliant: true };
        }
        const allParamValues = Object.values(ctx?.params || {})
          .map((v) => String(v))
          .join(' ');
        const content =
          String(ctx?.params?.content || ctx?.params?.text || '') +
          ' ' +
          allParamValues;
        if (!content.trim()) return { compliant: true };
        const storageSensitivePatterns = [
          { pattern: /\bsk-[a-zA-Z0-9]{8,}/, name: 'API密钥' },
          { pattern: /\bAKIA[A-Z0-9]{16}\b/, name: 'AWS密钥' },
          { pattern: /\bghp_[a-zA-Z0-9]{36}\b/, name: 'GitHub令牌' },
          {
            pattern:
              /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"]?[a-zA-Z0-9]{8,}/i,
            name: '密钥凭证',
          },
          { pattern: /\b\d{16,19}\b/, name: '银行卡号' },
          { pattern: /\b\d{17}[\dXx]\b/, name: '身份证号' },
          {
            pattern: /密钥|密码|口令|私钥|secret|credential/i,
            name: '敏感凭证关键词',
          },
        ];
        for (const { pattern, name } of storageSensitivePatterns) {
          if (pattern.test(content)) {
            return {
              compliant: false,
              violation: `禁止存储敏感信息 (${name})，请勿将密钥、凭证等敏感数据保存到记忆中`,
            };
          }
        }
        return { compliant: true };
      }

      case 'no-dangerous-commands': {
        const cmd =
          (ctx?.params?.command as string) ||
          (ctx?.params?.script as string) ||
          '';
        const dangerousPatterns = [
          /\brm\s+-rf\s+\//,
          /\bdel\s+\/f\s+\/q\s+/i,
          /\bformat\s+[A-Za-z]:/i,
          /\bshutdown\b/,
          /\bdrop\s+table\b/i,
          /\bdrop\s+database\b/i,
          /\btruncate\b.*\btable\b/i,
          /\b--\s*;\s*drop\b/i,
        ];

        for (const pattern of dangerousPatterns) {
          if (pattern.test(cmd)) {
            return {
              compliant: false,
              violation: `检测到危险命令: ${cmd.substring(0, 50)}...`,
            };
          }
        }
        return { compliant: true };
      }

      case 'resource-limit-check': {
        const memoryUsage = (ctx?.params?.memoryMB as number) || 0;
        const maxMemoryMB = 512;
        const cpuTime = (ctx?.params?.cpuTimeMs as number) || 0;
        const maxCpuTimeMs = 30000;

        if (memoryUsage > maxMemoryMB) {
          return {
            compliant: false,
            violation: `内存使用 ${memoryUsage}MB 超过限制 ${maxMemoryMB}MB`,
          };
        }
        if (cpuTime > maxCpuTimeMs) {
          return {
            compliant: false,
            violation: `CPU 时间 ${cpuTime}ms 超过限制 ${maxCpuTimeMs}ms`,
          };
        }
        return { compliant: true };
      }

      default:
        return { compliant: true };
    }
  }
}
