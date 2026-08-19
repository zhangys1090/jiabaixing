/**
 * 工具调用守卫 — 去重 + 缓存 + 速率限制
 *
 * 从 AI Agent 工具设计模式学到的核心模式：
 * - Pattern 6.1: Call deduplication — 相同工具+参数返回缓存结果
 * - Pattern 6.2: Rate limiting — 同一工具每轮最多 N 次
 * - Pattern 6.3: Result caching with TTL — 缓存工具结果避免重复网络请求
 *
 * 解决的核心问题：Agent 重复调用 web_search 相同关键词
 */

import { Logger } from '../../../utils/Logger';
import type { ToolResult } from '../../types';

interface CachedResult {
  result: ToolResult;
  timestamp: number;
}

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  timestamp: number;
}

/** 宪法/人格约束违规项（与 Python ConstitutionGuard 对齐） */
export interface ConstitutionGuardViolation {
  ruleId: string;
  reason: string;
}

/** 宪法/人格约束裁决（与 Python ConstitutionGuard 对齐） */
export interface ConstitutionGuardVerdict {
  allowed: boolean;
  violations: ConstitutionGuardViolation[];
  reason: string;
  dangerDetected: boolean;
}

/**
 * 宪法守卫 provider（TS 入口透传 → Python 宪法守卫核心）。
 * 实际"危险感知 → 动作拦截"判断在 Python 端完成，TS 仅调用与渲染。
 */
export type ConstitutionGuardProvider = (
  action: { toolName: string; args: Record<string, unknown> }
) => Promise<ConstitutionGuardVerdict>;

/** check / guard 的统一返回类型 */
type GuardOutcome = { blocked: boolean; result?: ToolResult; reason?: string };

export class ToolCallGuard {
  // 结果缓存：(toolName + argsHash) → cached result
  private resultCache: Map<string, CachedResult> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

  // 调用历史（当前轮次）
  private callHistory: ToolCallRecord[] = [];
  private readonly MAX_HISTORY = 20;

  // 每工具每轮调用限制
  private perToolCounts: Map<string, number> = new Map();
  private readonly MAX_SAME_TOOL = 2;

  // 去重窗口
  private readonly DEDUP_WINDOW_MS = 30_000; // 30 秒内相同调用视为重复

  // 宪法/人格约束 provider（U4 第2项）：TS 入口透传 → Python 宪法守卫核心
  private constitutionProvider?: ConstitutionGuardProvider;

  /**
   * 检查工具调用是否应该被拦截
   * 返回 null = 允许执行，返回 ToolResult = 直接返回缓存/拦截结果
   */
  check(
    toolName: string,
    args: Record<string, unknown>
  ): { blocked: boolean; result?: ToolResult; reason?: string } {
    const argsHash = this.hashArgs(args);
    const now = Date.now();

    // 1. 检查结果缓存（相同工具+参数在 TTL 内）
    const cacheKey = `${toolName}:${argsHash}`;
    const cached = this.resultCache.get(cacheKey);
    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      Logger.debug(
        `📋 工具缓存命中: ${toolName} (${((now - cached.timestamp) / 1000).toFixed(0)}s前的结果)`,
        'ToolCallGuard'
      );
      return {
        blocked: true,
        result: {
          ...cached.result,
          output: `[缓存结果 ${((now - cached.timestamp) / 1000).toFixed(0)}秒前]\n${typeof cached.result.output === 'string' ? cached.result.output : JSON.stringify(cached.result.output)}`,
          metadata: { ...cached.result.metadata, fromCache: true },
        },
      };
    }

    // 2. 检查去重（30 秒内相同工具+参数）
    const recentDuplicate = this.callHistory.find(
      (r) =>
        r.toolName === toolName &&
        r.argsHash === argsHash &&
        now - r.timestamp < this.DEDUP_WINDOW_MS
    );
    if (recentDuplicate) {
      const ageSec = ((now - recentDuplicate.timestamp) / 1000).toFixed(0);
      Logger.warn(
        `🔄 工具去重拦截: ${toolName} (${ageSec}秒前已调用相同参数)`,
        'ToolCallGuard'
      );
      return {
        blocked: true,
        result: {
          success: true,
          output: `[去重] ${toolName} 在 ${ageSec} 秒前已用相同参数调用过，结果没有变化。请使用已有结果或换一个不同的关键词/参数重试。`,
          duration: 0,
          validated: true,
          metadata: { deduplicated: true },
        },
        reason: `${ageSec}秒前已调用相同参数`,
      };
    }

    // 3. 检查每工具速率限制
    const toolCount = this.perToolCounts.get(toolName) || 0;
    if (toolCount >= this.MAX_SAME_TOOL) {
      Logger.warn(
        `🚫 工具速率限制: ${toolName} 已调用 ${toolCount} 次，超过上限 ${this.MAX_SAME_TOOL}`,
        'ToolCallGuard'
      );
      return {
        blocked: true,
        result: {
          success: true,
          output: `[速率限制] ${toolName} 已调用 ${toolCount} 次。请立即基于已有结果回复用户，不要再调用此工具。`,
          duration: 0,
          validated: true,
          metadata: { rateLimited: true },
        },
        reason: `已调用 ${toolCount} 次，超过上限 ${this.MAX_SAME_TOOL}`,
      };
    }

    return { blocked: false };
  }

  /**
   * 设置宪法/人格约束 provider（可选）。
   * 未设置时 guard() 等价于 check()，不影响既有行为。
   */
  setConstitutionGuardProvider(provider: ConstitutionGuardProvider): void {
    this.constitutionProvider = provider;
  }

  /**
   * 执行前守卫：先咨询宪法/人格约束（若注入 provider），
   * 再走去重/缓存/限速。异步以兼容 Python 端感知融合裁决（与 ToolCallGuard 协同）。
   *
   * 实现"宪法约束前置到动作执行守卫"——避免"感知到危险仍执行"。
   */
  async guard(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<GuardOutcome> {
    if (this.constitutionProvider) {
      const verdict = await this.constitutionProvider({ toolName, args });
      if (!verdict.allowed) {
        Logger.warn(
          `🛡️ 宪法守卫拦截: ${toolName} - ${verdict.reason}`,
          'ToolCallGuard'
        );
        return {
          blocked: true,
          reason: verdict.reason,
          result: {
            success: false,
            output: `[宪法守卫拦截] ${verdict.reason}`,
            metadata: {
              constitutionBlocked: true,
              violations: verdict.violations.map((v) => v.ruleId),
            },
          },
        };
      }
    }
    return this.check(toolName, args);
  }

  /**
   * 记录工具调用（在工具执行成功后调用）
   */
  record(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult
  ): void {
    const argsHash = this.hashArgs(args);
    const now = Date.now();

    // 记录调用历史
    this.callHistory.push({ toolName, argsHash, timestamp: now });
    if (this.callHistory.length > this.MAX_HISTORY) {
      this.callHistory = this.callHistory.slice(-this.MAX_HISTORY);
    }

    // 更新每工具计数
    this.perToolCounts.set(
      toolName,
      (this.perToolCounts.get(toolName) || 0) + 1
    );

    // 缓存成功结果
    if (result.success) {
      const cacheKey = `${toolName}:${argsHash}`;
      this.resultCache.set(cacheKey, { result, timestamp: now });

      // 清理过期缓存
      if (this.resultCache.size > 50) {
        for (const [key, entry] of this.resultCache) {
          if (now - entry.timestamp > this.CACHE_TTL_MS) {
            this.resultCache.delete(key);
          }
        }
      }
    }

    Logger.debug(
      `📝 工具调用记录: ${toolName} (总计 ${this.perToolCounts.get(toolName)} 次)`,
      'ToolCallGuard'
    );
  }

  /**
   * 重置当前轮次状态（在新一轮对话开始时调用）
   */
  resetRound(): void {
    this.callHistory = [];
    this.perToolCounts.clear();
  }

  /**
   * 获取当前轮次的调用统计
   */
  getStats(): {
    totalCalls: number;
    perTool: Record<string, number>;
    cacheSize: number;
  } {
    const perTool: Record<string, number> = {};
    for (const [name, count] of this.perToolCounts) {
      perTool[name] = count;
    }
    return {
      totalCalls: this.callHistory.length,
      perTool,
      cacheSize: this.resultCache.size,
    };
  }

  /**
   * 参数哈希（简单但足够用于去重）
   */
  private hashArgs(args: Record<string, unknown>): string {
    try {
      const sorted = Object.keys(args)
        .sort()
        .reduce(
          (acc, key) => {
            acc[key] = args[key];
            return acc;
          },
          {} as Record<string, unknown>
        );
      return JSON.stringify(sorted);
    } catch {
      return Math.random().toString(); // 无法哈希则不去重
    }
  }
}
