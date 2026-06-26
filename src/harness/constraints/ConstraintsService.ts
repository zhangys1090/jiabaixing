/**
 * Harness Layer 6: Constraints - 约束服务
 *
 * 5 重防御体系 + 生命周期钩子
 *
 * 重构：敏感信息检测和危险命令检测委托给统一模块
 * SensitiveDetector，消除三处重复实现
 */

import { Logger } from '../../utils/Logger';
import { HookManager } from '../hooks/HookManager';
import {
  checkDangerousCommand,
  checkSensitiveInfo,
} from '../security/SensitiveDetector';
import type {
  AdaptiveBudgetConfig,
  BudgetAllocation,
  BudgetCheckResult,
  BudgetState,
  ConstraintDefinition,
  ConstraintLevel,
  CreativeExplorationConfig,
  HookContext,
  HookResult,
  LifecycleEvent,
  LifecycleHook,
  Permission,
  PermissionResult,
  ToolContext,
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
  /** Hook 管理器 — 注入时委托给 HookManager 统一管理 */
  hookManager?: HookManager;
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
   *
   * 委托给统一检测器，消除重复的危险命令检测逻辑
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

    // 委托给统一危险命令检测器
    const cmdCheck = checkDangerousCommand(action);
    if (cmdCheck.dangerous) {
      return { allowed: false, reason: cmdCheck.reason || '禁止执行危险操作' };
    }

    return { allowed: true };
  }

  private static LIFECYCLE_TO_HOOK_EVENT: Record<string, string | undefined> = {
    before_tool_call: 'beforeToolCall',
    after_tool_call: 'afterToolCall',
    on_error: 'onToolError',
    before_loop: 'beforeLoop',
    after_loop: 'afterLoop',
    on_budget_exceeded: 'onBudgetExceeded',
  };

  /**
   * 注册生命周期钩子
   */
  registerHook(event: LifecycleEvent, hook: LifecycleHook): void {
    // 委托给 HookManager（如果已注入且事件可映射）
    if (this.deps.hookManager) {
      const mappedEvent =
        ConstraintsService.LIFECYCLE_TO_HOOK_EVENT[event as string];
      if (mappedEvent) {
        this.deps.hookManager.registerHook(
          mappedEvent,
          hook as (
            context: unknown
          ) => Promise<{ proceed: boolean; reason?: string }>
        );
        Logger.debug(
          `委托 HookManager 注册钩子: ${event} → ${mappedEvent}`,
          'ConstraintsService'
        );
        return;
      }
      // 不可映射的事件回退到本地注册
      Logger.debug(
        `事件 ${event} 无 HookManager 映射，回退本地注册`,
        'ConstraintsService'
      );
    }

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
    // 委托给 HookManager（如果已注入且事件可映射）
    if (this.deps.hookManager) {
      const mappedEvent =
        ConstraintsService.LIFECYCLE_TO_HOOK_EVENT[event as string];
      if (mappedEvent) {
        return this.deps.hookManager.executeHooks(mappedEvent, context);
      }
      // 不可映射的事件回退到本地执行
    }

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
   *
   * 敏感信息检测和危险命令检测已委托给 SensitiveDetector 统一模块
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
            process.env.HOME,
            process.env.USERPROFILE,
            '/etc',
            '/root',
            'C:\\Windows',
            'C:\\Program Files',
            'C:\\Program Files (x86)',
          ].filter((p): p is string => !!p && p.length > 0);
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
          // 委托给统一敏感信息检测器
          const result = checkSensitiveInfo(outputStr, 'output');
          if (!result.safe) {
            const topViolation = result.violations[0];
            // 密码和密钥类违规合并显示为"密码/密钥"
            const displayName =
              topViolation?.name === '密码泄露' ||
              topViolation?.name === '密钥/Token泄露'
                ? '密码/密钥'
                : topViolation?.name || '未知';
            return {
              compliant: false,
              violation: `检测到可能泄露的敏感信息: ${displayName}`,
            };
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
        // 委托给统一敏感信息检测器（storage 场景使用更严格的模式）
        const result = checkSensitiveInfo(content, 'storage');
        if (!result.safe) {
          // 优先选择更具体的违规类型（非通用的"密钥/Token泄露"）
          const specificNames = [
            'API密钥',
            'AWS密钥',
            'GitHub令牌',
            'GitHub OAuth令牌',
            'Slack令牌',
            '密钥凭证',
            '银行卡号',
            '身份证号',
            '身份证号(18位)',
            'CVV码',
            '密码泄露',
            '敏感凭证关键词',
          ];
          const topViolation =
            result.violations.find((v) => specificNames.includes(v.name)) ||
            result.violations[0];
          return {
            compliant: false,
            violation: `禁止存储敏感信息 (${topViolation?.name || '未知'})，请勿将密钥、凭证等敏感数据保存到记忆中`,
          };
        }
        return { compliant: true };
      }

      case 'no-dangerous-commands': {
        const cmd =
          (ctx?.params?.command as string) ||
          (ctx?.params?.script as string) ||
          '';
        // 委托给统一危险命令检测器
        const result = checkDangerousCommand(cmd);
        if (result.dangerous) {
          return {
            compliant: false,
            violation:
              result.reason || `检测到危险命令: ${cmd.substring(0, 50)}`,
          };
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

  // ===== 约束分级体系 =====

  /**
   * 内置约束定义表 — 区分硬约束（安全）和软约束（建议）
   *
   * 硬约束：不可违反，违反则拦截
   * 软约束：建议遵守，违反仅警告
   * 建议约束：仅供参考，不拦截不警告
   */
  private static readonly CONSTRAINT_DEFINITIONS: ConstraintDefinition[] = [
    {
      name: 'no-sensitive-data-leak',
      level: 'hard',
      description: '禁止泄露敏感信息（密钥、密码、身份证等）',
    },
    {
      name: 'no-sensitive-storage',
      level: 'hard',
      description: '禁止存储敏感信息到记忆',
    },
    {
      name: 'no-dangerous-commands',
      level: 'hard',
      description: '禁止执行危险命令（rm -rf、drop table等）',
    },
    {
      name: 'no-unauthorized-file-access',
      level: 'hard',
      description: '禁止访问系统目录',
    },
    {
      name: 'no-unbounded-recursion',
      level: 'hard',
      description: '禁止无限递归',
    },
    {
      name: 'resource-limit-check',
      level: 'soft',
      description: '资源使用建议限制',
    },
  ];

  /**
   * 获取约束等级
   */
  getConstraintLevel(constraintName: string): ConstraintLevel {
    const def = ConstraintsService.CONSTRAINT_DEFINITIONS.find(
      (d) => d.name === constraintName
    );
    return def?.level ?? 'advisory';
  }

  /**
   * 获取所有约束定义
   */
  getConstraintDefinitions(): ConstraintDefinition[] {
    return ConstraintsService.CONSTRAINT_DEFINITIONS;
  }

  /**
   * 分级执行约束 — 硬约束拦截，软约束仅警告
   */
  enforceWithLevel(
    constraint: string,
    context: unknown
  ): { compliant: boolean; violation?: string; level: ConstraintLevel } {
    const result = this.enforceBehaviorConstraint(constraint, context);
    const level = this.getConstraintLevel(constraint);

    // 软约束不拦截，只记录
    if (!result.compliant && level === 'soft') {
      Logger.warn(`⚠️ 软约束建议: ${result.violation}`, 'ConstraintsService');
      return { compliant: true, level };
    }

    // 建议约束不拦截不警告
    if (!result.compliant && level === 'advisory') {
      return { compliant: true, level };
    }

    return { ...result, level };
  }

  // ===== 自适应预算 =====

  /** 默认自适应预算配置 */
  private static readonly DEFAULT_ADAPTIVE_BUDGET: AdaptiveBudgetConfig = {
    simple: {
      maxRounds: 4,
      maxToolCalls: 5,
      maxTokens: 3000,
      maxDurationMs: 30000,
    },
    moderate: {
      maxRounds: 8,
      maxToolCalls: 10,
      maxTokens: 5000,
      maxDurationMs: 60000,
    },
    complex: {
      maxRounds: 12,
      maxToolCalls: 15,
      maxTokens: 8000,
      maxDurationMs: 120000,
    },
    creativeBonus: { maxToolCalls: 4, maxRounds: 3, maxTokens: 2000 },
  };

  /** 默认创造性探索配置 */
  private static readonly DEFAULT_CREATIVE_CONFIG: CreativeExplorationConfig = {
    enabled: true,
    maxExtraToolCalls: 4,
    maxExtraRounds: 3,
    qualityThreshold: 0.7,
    explorationPrompt:
      '当前任务进展良好。你可以尝试更有创造性的方法来提升结果质量，例如探索额外信息、优化输出格式、或提供更深入的见解。',
  };

  private adaptiveBudget: AdaptiveBudgetConfig | undefined;
  private creativeConfig: CreativeExplorationConfig | undefined;

  /**
   * 获取自适应预算配置
   */
  getAdaptiveBudget(): Readonly<AdaptiveBudgetConfig> {
    return this.adaptiveBudget ?? ConstraintsService.DEFAULT_ADAPTIVE_BUDGET;
  }

  /**
   * 获取创造性探索配置
   */
  getCreativeConfig(): Readonly<CreativeExplorationConfig> {
    return this.creativeConfig ?? ConstraintsService.DEFAULT_CREATIVE_CONFIG;
  }

  /**
   * 更新自适应预算配置
   */
  setAdaptiveBudget(config: Partial<AdaptiveBudgetConfig>): void {
    this.adaptiveBudget = {
      ...ConstraintsService.DEFAULT_ADAPTIVE_BUDGET,
      ...this.adaptiveBudget,
      ...config,
    };
  }

  /**
   * 更新创造性探索配置
   */
  setCreativeConfig(config: Partial<CreativeExplorationConfig>): void {
    this.creativeConfig = {
      ...ConstraintsService.DEFAULT_CREATIVE_CONFIG,
      ...this.creativeConfig,
      ...config,
    };
  }

  /**
   * 根据任务复杂度计算自适应预算
   *
   * @param complexity - 任务复杂度 'simple' | 'moderate' | 'complex'
   * @param enableCreative - 是否启用创造性探索加成
   * @returns 预算分配
   */
  resolveAdaptiveBudget(
    complexity: 'simple' | 'moderate' | 'complex',
    enableCreative = false
  ): BudgetAllocation {
    const budget = this.getAdaptiveBudget();
    const base = budget[complexity];

    if (!enableCreative || !this.getCreativeConfig().enabled) {
      return { ...base };
    }

    // 叠加创造性探索加成
    const bonus = budget.creativeBonus;
    return {
      maxRounds: base.maxRounds + (bonus.maxRounds ?? 0),
      maxToolCalls: base.maxToolCalls + (bonus.maxToolCalls ?? 0),
      maxTokens: base.maxTokens + (bonus.maxTokens ?? 0),
      maxDurationMs: base.maxDurationMs + (bonus.maxDurationMs ?? 0),
    };
  }

  /**
   * 判断是否允许创造性探索
   *
   * 条件：当前质量评分 >= 阈值 且 预算有余量
   */
  canExploreCreatively(
    currentQuality: number,
    budgetState: BudgetState
  ): { allowed: boolean; reason?: string } {
    const config = this.getCreativeConfig();

    if (!config.enabled) {
      return { allowed: false, reason: '创造性探索未启用' };
    }

    if (currentQuality < config.qualityThreshold) {
      return {
        allowed: false,
        reason: `质量评分 ${currentQuality.toFixed(2)} 低于阈值 ${config.qualityThreshold}`,
      };
    }

    // 检查预算余量
    const remainingRounds = budgetState.hardRoundLimit - budgetState.roundsUsed;
    if (remainingRounds < config.maxExtraRounds) {
      return { allowed: false, reason: '剩余轮次不足以支持探索' };
    }

    return { allowed: true };
  }

  // ===== 预算压力警告 =====

  /**
   * 预算压力级别
   *
   * none — 预算充裕，无需警告
   * caution — 达 70% 阈值，建议 LLM 注意效率
   * critical — 达 90% 阈值，强烈建议 LLM 收敛
   */
  static readonly PRESSURE_THRESHOLDS = {
    caution: 0.7,
    critical: 0.9,
  };

  /**
   * 计算当前预算压力
   *
   * 仿 Hermes _budget_warning 设计：综合评估轮次/token/工具调用/时间四维度，
   * 取最高压力级别，注入到工具结果中让 LLM 自主调整行为。
   *
   * @param budget - 当前预算状态
   * @returns 压力评估结果
   */
  getBudgetPressure(budget: BudgetState): {
    level: 'none' | 'caution' | 'critical';
    warning?: string;
    details: {
      rounds: number;
      tokens: number;
      toolCalls: number;
      duration: number;
    };
  } {
    const rounds =
      budget.hardRoundLimit > 0 ? budget.roundsUsed / budget.hardRoundLimit : 0;
    const tokens =
      budget.tokenHardLimit > 0 ? budget.tokensUsed / budget.tokenHardLimit : 0;
    const toolCalls =
      budget.maxToolCalls > 0 ? budget.toolCallsUsed / budget.maxToolCalls : 0;
    const elapsed = Date.now() - budget.startTime;
    const duration =
      budget.maxDurationMs > 0 ? elapsed / budget.maxDurationMs : 0;

    const details = { rounds, tokens, toolCalls, duration };
    const maxUsage = Math.max(rounds, tokens, toolCalls, duration);

    if (maxUsage >= ConstraintsService.PRESSURE_THRESHOLDS.critical) {
      const dimension = this.getHighestDimension(details);
      const warning = this.buildCriticalWarning(dimension, budget);
      return { level: 'critical', warning, details };
    }

    if (maxUsage >= ConstraintsService.PRESSURE_THRESHOLDS.caution) {
      const dimension = this.getHighestDimension(details);
      const warning = this.buildCautionWarning(dimension, budget);
      return { level: 'caution', warning, details };
    }

    return { level: 'none', details };
  }

  private getHighestDimension(details: Record<string, number>): string {
    let max = 0;
    let dim = 'rounds';
    for (const [k, v] of Object.entries(details)) {
      if (v > max) {
        max = v;
        dim = k;
      }
    }
    return dim;
  }

  private buildCautionWarning(dimension: string, budget: BudgetState): string {
    const labels: Record<string, string> = {
      rounds: `轮次 ${budget.roundsUsed}/${budget.hardRoundLimit}`,
      tokens: `Token ${budget.tokensUsed}/${budget.tokenHardLimit}`,
      toolCalls: `工具调用 ${budget.toolCallsUsed}/${budget.maxToolCalls}`,
      duration: `时间 ${Math.round((Date.now() - budget.startTime) / 1000)}s/${Math.round(budget.maxDurationMs / 1000)}s`,
    };
    return `预算注意: ${labels[dimension] || '未知'} 已达 70%，请注意效率`;
  }

  private buildCriticalWarning(dimension: string, budget: BudgetState): string {
    const labels: Record<string, string> = {
      rounds: `轮次 ${budget.roundsUsed}/${budget.hardRoundLimit}`,
      tokens: `Token ${budget.tokensUsed}/${budget.tokenHardLimit}`,
      toolCalls: `工具调用 ${budget.toolCallsUsed}/${budget.maxToolCalls}`,
      duration: `时间 ${Math.round((Date.now() - budget.startTime) / 1000)}s/${Math.round(budget.maxDurationMs / 1000)}s`,
    };
    return `预算紧急: ${labels[dimension] || '未知'} 已达 90%，请尽快收敛`;
  }

  /**
   * 将预算压力格式化为可注入工具结果的 _budget_warning 字符串
   *
   * 格式仿 Hermes: 在工具结果末尾追加 JSON 块，LLM 可识别并自主调整
   *
   * @param pressure - getBudgetPressure 的返回值
   * @returns 格式化的警告字符串，none 级别返回空字符串
   */
  static formatBudgetWarning(pressure: {
    level: 'none' | 'caution' | 'critical';
    warning?: string;
  }): string {
    if (pressure.level === 'none') return '';
    return `\n{"_budget_warning": {"level": "${pressure.level}", "message": "${pressure.warning}"}}`;
  }
}
