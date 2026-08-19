/**
 * SkillMiddleware — Skill 执行中间件系统
 *
 * 为 SkillRegistry.executeSkill() 提供前置/后置 hook 机制：
 *   - beforeExecute: 执行前修改参数、检查权限、记录日志
 *   - afterExecute: 执行后处理结果、记录指标、触发进化
 *
 * 内置中间件：
 *   1. ApprovalMiddleware — 调用 ApprovalEngine 进行审批
 *   2. LoggingMiddleware — 记录执行日志和指标
 *   3. MetricsMiddleware — 收集执行时长、成功率
 *   4. EvolutionMiddleware — 触发进化引擎学习
 *
 * 设计参考 Hermes Agent 的 skill_preprocessing.py
 */

import {
  ApprovalType,
  getApprovalEngine,
  RiskLevel,
} from '../security/ApprovalEngine';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import type { SkillContext, SkillResult } from './SkillInterface';

/** 中间件上下文 */
export interface MiddlewareContext {
  /** Skill 名称 */
  skillName: string;
  /** 原始参数 */
  params: Record<string, unknown>;
  /** 执行上下文 */
  context?: SkillContext;
  /** 可修改的参数（中间件可修改） */
  modifiedParams?: Record<string, unknown>;
  /** traceId */
  traceId?: string;
  /** userId */
  userId?: string;
}

/** 前置中间件结果 */
export interface BeforeResult {
  /** 是否继续执行 */
  proceed: boolean;
  /** 修改后的参数 */
  params?: Record<string, unknown>;
  /** 直接返回的结果（不继续执行 Skill） */
  result?: SkillResult;
  /** 跳过原因 */
  reason?: string;
}

/** 后置中间件上下文 */
export interface AfterContext extends MiddlewareContext {
  /** 执行结果 */
  result: SkillResult;
  /** 执行时长（毫秒） */
  duration: number;
}

/** 前置中间件函数 */
export type BeforeHook = (
  ctx: MiddlewareContext
) => Promise<BeforeResult> | BeforeResult;

/** 后置中间件函数 */
export type AfterHook = (ctx: AfterContext) => Promise<void> | void;

/** 中间件注册项 */
export interface MiddlewareEntry {
  /** 名称 */
  name: string;
  /** 前置 hook */
  before?: BeforeHook;
  /** 后置 hook */
  after?: AfterHook;
  /** 优先级（数字越小越先执行） */
  priority: number;
  /** 是否启用 */
  enabled: boolean;
}

export class SkillMiddleware {
  private middlewares: MiddlewareEntry[] = [];
  private executionLog: Array<{
    skillName: string;
    success: boolean;
    duration: number;
    timestamp: number;
  }> = [];

  /**
   * 注册中间件
   */
  use(entry: Omit<MiddlewareEntry, 'enabled'> & { enabled?: boolean }): void {
    const existing = this.middlewares.findIndex((m) => m.name === entry.name);
    const full: MiddlewareEntry = {
      ...entry,
      enabled: entry.enabled ?? true,
    };

    if (existing >= 0) {
      this.middlewares[existing] = full;
      Logger.info(`🔄 Skill 中间件已更新: ${entry.name}`, 'SkillMiddleware');
    } else {
      this.middlewares.push(full);
      Logger.info(`➕ Skill 中间件已注册: ${entry.name}`, 'SkillMiddleware');
    }

    // 按优先级排序
    this.middlewares.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 卸载中间件
   */
  remove(name: string): boolean {
    const idx = this.middlewares.findIndex((m) => m.name === name);
    if (idx >= 0) {
      this.middlewares.splice(idx, 1);
      Logger.info(`➖ Skill 中间件已卸载: ${name}`, 'SkillMiddleware');
      return true;
    }
    return false;
  }

  /**
   * 启用/禁用中间件
   */
  toggle(name: string, enabled: boolean): void {
    const m = this.middlewares.find((m) => m.name === name);
    if (m) {
      m.enabled = enabled;
      Logger.info(
        `${enabled ? '启用' : '禁用'} Skill 中间件: ${name}`,
        'SkillMiddleware'
      );
    }
  }

  /**
   * 执行前置中间件链
   * 按优先级顺序执行，任一中间件返回 proceed=false 则终止
   */
  async runBefore(ctx: MiddlewareContext): Promise<BeforeResult> {
    let currentParams = { ...ctx.params };
    let currentCtx = { ...ctx, modifiedParams: currentParams };

    for (const mw of this.middlewares) {
      if (!mw.enabled || !mw.before) continue;

      try {
        const result = await mw.before(currentCtx);

        if (!result.proceed) {
          Logger.info(
            `⛔ Skill 中间件 ${mw.name} 阻止了 ${ctx.skillName} 执行: ${result.reason || ''}`,
            'SkillMiddleware'
          );
          return result;
        }

        // 中间件可能修改了参数
        if (result.params) {
          currentParams = { ...currentParams, ...result.params };
          currentCtx = { ...currentCtx, modifiedParams: currentParams };
        }
      } catch (err) {
        Logger.error(
          `Skill 中间件 ${mw.name} before 执行失败`,
          err as Error,
          'SkillMiddleware'
        );
        // 中间件失败不阻止 Skill 执行，但记录错误
      }
    }

    return { proceed: true, params: currentParams };
  }

  /**
   * 执行后置中间件链
   */
  async runAfter(ctx: AfterContext): Promise<void> {
    for (const mw of this.middlewares) {
      if (!mw.enabled || !mw.after) continue;

      try {
        await mw.after(ctx);
      } catch (err) {
        Logger.error(
          `Skill 中间件 ${mw.name} after 执行失败`,
          err as Error,
          'SkillMiddleware'
        );
      }
    }

    // 记录执行日志
    this.executionLog.push({
      skillName: ctx.skillName,
      success: ctx.result.success,
      duration: ctx.duration,
      timestamp: Date.now(),
    });

    // 保留最近 1000 条
    if (this.executionLog.length > 1000) {
      this.executionLog = this.executionLog.slice(-1000);
    }
  }

  /**
   * 获取执行统计
   */
  getStats(): {
    totalExecutions: number;
    successRate: number;
    averageDuration: number;
    bySkill: Record<
      string,
      { count: number; successRate: number; avgDuration: number }
    >;
  } {
    const total = this.executionLog.length;
    if (total === 0) {
      return {
        totalExecutions: 0,
        successRate: 0,
        averageDuration: 0,
        bySkill: {},
      };
    }

    const successCount = this.executionLog.filter((e) => e.success).length;
    const totalDuration = this.executionLog.reduce(
      (sum, e) => sum + e.duration,
      0
    );

    const bySkill: Record<
      string,
      { count: number; successRate: number; avgDuration: number }
    > = {};
    const skillStats: Record<
      string,
      { count: number; success: number; duration: number }
    > = {};

    for (const entry of this.executionLog) {
      if (!skillStats[entry.skillName]) {
        skillStats[entry.skillName] = { count: 0, success: 0, duration: 0 };
      }
      skillStats[entry.skillName].count++;
      if (entry.success) skillStats[entry.skillName].success++;
      skillStats[entry.skillName].duration += entry.duration;
    }

    for (const [name, stats] of Object.entries(skillStats)) {
      bySkill[name] = {
        count: stats.count,
        successRate: stats.success / stats.count,
        avgDuration: stats.duration / stats.count,
      };
    }

    return {
      totalExecutions: total,
      successRate: successCount / total,
      averageDuration: totalDuration / total,
      bySkill,
    };
  }
}

// ── 内置中间件 ──

/**
 * 审批中间件 — 调用 ApprovalEngine
 * 对来源不明或高风险 Skill 进行审批
 */
export function createApprovalMiddleware(): MiddlewareEntry {
  return {
    name: 'approval',
    priority: 10,
    enabled: true,
    before: async (ctx) => {
      const engine = getApprovalEngine();

      const approvalType: ApprovalType = 'skill_execute';
      const description = `执行 Skill: ${ctx.skillName}`;
      const target = ctx.skillName;

      const decision = await engine.requestApproval({
        type: approvalType,
        description,
        target,
        risk: 'low' as RiskLevel,
        params: ctx.params,
        traceId: ctx.traceId,
        userId: ctx.userId,
      });

      if (!decision.approved) {
        return {
          proceed: false,
          reason: `审批被拒绝: ${decision.reason || '用户拒绝'}`,
          result: {
            success: false,
            error: `Skill 执行被审批引擎拒绝: ${decision.reason || '用户拒绝'}`,
          },
        };
      }

      return { proceed: true };
    },
  };
}

/**
 * 日志中间件 — 记录执行日志
 */
export function createLoggingMiddleware(): MiddlewareEntry {
  return {
    name: 'logging',
    priority: 20,
    enabled: true,
    before: (ctx) => {
      Logger.info(`🔧 准备执行 Skill: ${ctx.skillName}`, 'SkillMiddleware');
      EventBus.emit('skill_execution_update', {
        traceId: ctx.traceId ?? '',
        skillName: ctx.skillName,
        step: 'started',
        timestamp: new Date().toISOString(),
      });
      return { proceed: true };
    },
    after: (ctx) => {
      const status = ctx.result.success ? 'completed' : 'failed';
      Logger.info(
        `${ctx.result.success ? '✅' : '❌'} Skill ${ctx.skillName} ${status} (${ctx.duration}ms)`,
        'SkillMiddleware'
      );
      EventBus.emit('skill_execution_update', {
        traceId: ctx.traceId ?? '',
        skillName: ctx.skillName,
        step: status,
        duration: ctx.duration,
        error: ctx.result.error,
        timestamp: new Date().toISOString(),
      });
    },
  };
}

/**
 * 指标中间件 — 收集执行指标
 */
export function createMetricsMiddleware(): MiddlewareEntry {
  return {
    name: 'metrics',
    priority: 30,
    enabled: true,
    after: (ctx) => {
      EventBus.emit('tool_trace', {
        timestamp: new Date().toISOString(),
        traceId: ctx.traceId || '',
        toolCallId: `skill_${ctx.skillName}_${Date.now()}`,
        toolName: ctx.skillName,
        status: ctx.result.success ? 'completed' : 'failed',
        duration: ctx.duration,
        success: ctx.result.success,
        errorMessage: ctx.result.error || null,
      });
    },
  };
}

// ── 全局单例 ──

let globalMiddleware: SkillMiddleware | null = null;

export function getSkillMiddleware(): SkillMiddleware {
  if (!globalMiddleware) {
    globalMiddleware = new SkillMiddleware();

    // 注册内置中间件
    globalMiddleware.use(createLoggingMiddleware());
    globalMiddleware.use(createMetricsMiddleware());
    globalMiddleware.use(createApprovalMiddleware());

    Logger.info(
      'SkillMiddleware 全局实例已创建，已注册 3 个内置中间件',
      'SkillMiddleware'
    );
  }
  return globalMiddleware;
}
