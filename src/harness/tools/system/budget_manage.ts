/**
 * Harness Tool: budget_manage - 预算管理
 *
 * 管理 Agent 执行预算，包括 Token、轮次、工具调用次数、
 * 时间等维度的预算分配与消耗追踪。防止资源超支。
 */

import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

/**将可能为 NaN 的数值安全地转换为有限值；非有限时回退到 fallback。
 * 避免 `Number('abc')` 产生的 NaN 静默破坏预算比较（`>= NaN` 恒为 false）。*/
function toFiniteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}


export const BUDGET_MANAGE_DEF: ToolDefinition = {
  name: 'budget_manage',
  description:
    '管理 Agent 执行预算。支持操作：set=设置预算, check=检查剩余预算, consume=记录消耗, report=预算报告, reset=重置预算。适用场景：控制Token消耗、限制执行轮次、防止资源超支。',
  category: ToolCategory.SYSTEM,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型：set|check|consume|report|reset',
      enum: ['set', 'check', 'consume', 'report', 'reset'],
    },
    max_tokens: {
      type: 'number',
      description: '最大 Token 预算（set 操作时使用）',
    },
    max_rounds: {
      type: 'number',
      description: '最大执行轮次（set 操作时使用）',
    },
    max_tool_calls: {
      type: 'number',
      description: '最大工具调用次数（set 操作时使用）',
    },
    max_duration_ms: {
      type: 'number',
      description: '最大执行时间（毫秒，set 操作时使用）',
    },
    tokens_used: {
      type: 'number',
      description: '本次消耗的 Token 数（consume 操作时使用）',
    },
    tool_name: {
      type: 'string',
      description: '消耗来源的工具名称（consume 操作时使用）',
    },
    warning_threshold: {
      type: 'number',
      description: '预算警告阈值百分比（0-1），默认 0.8',
      default: 0.8,
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.SYSTEM_ADMIN],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

interface BudgetConfig {
  maxTokens: number;
  maxRounds: number;
  maxToolCalls: number;
  maxDurationMs: number;
  warningThreshold: number;
}

const DEFAULT_BUDGET: BudgetConfig = {
  maxTokens: 100000,
  maxRounds: 20,
  maxToolCalls: 50,
  maxDurationMs: 300000,
  warningThreshold: 0.8,
};

class BudgetManager {
  private config: BudgetConfig = { ...DEFAULT_BUDGET };
  private tokensUsed = 0;
  private roundsUsed = 0;
  private toolCallsUsed = 0;
  private startTime = Date.now();
  private toolBreakdown: Map<string, { calls: number; tokens: number }> =
    new Map();
  private warnings: string[] = [];
  private overBudget = false;

  setBudget(params: Record<string, unknown>): ToolResult {
    if (params.max_tokens !== undefined)
      this.config.maxTokens = toFiniteOr(Number(params.max_tokens), 0);
    if (params.max_rounds !== undefined)
      this.config.maxRounds = toFiniteOr(Number(params.max_rounds), 0);
    if (params.max_tool_calls !== undefined)
      this.config.maxToolCalls = toFiniteOr(Number(params.max_tool_calls), 0);
    if (params.max_duration_ms !== undefined)
      this.config.maxDurationMs = toFiniteOr(Number(params.max_duration_ms), 0);
    if (params.warning_threshold !== undefined)
      this.config.warningThreshold = toFiniteOr(Number(params.warning_threshold), 0);
    this.overBudget = false;
    this.warnings = [];
    return {
      success: true,
      output: [
        '💰 预算已设置:',
        `  Token: ${this.config.maxTokens.toLocaleString()}`,
        `  轮次: ${this.config.maxRounds}`,
        `  工具调用: ${this.config.maxToolCalls}`,
        `  时长: ${(this.config.maxDurationMs / 1000).toFixed(0)}s`,
        `  警告阈值: ${(this.config.warningThreshold * 100).toFixed(0)}%`,
      ].join('\n'),
      duration: 0,
      validated: false,
      metadata: { config: this.config },
    };
  }

  checkBudget(): ToolResult {
    const elapsed = Date.now() - this.startTime;
    const tokenPct =
      this.config.maxTokens > 0 ? this.tokensUsed / this.config.maxTokens : 0;
    const roundPct =
      this.config.maxRounds > 0 ? this.roundsUsed / this.config.maxRounds : 0;
    const toolPct =
      this.config.maxToolCalls > 0
        ? this.toolCallsUsed / this.config.maxToolCalls
        : 0;
    const timePct =
      this.config.maxDurationMs > 0 ? elapsed / this.config.maxDurationMs : 0;
    const maxPct = Math.max(tokenPct, roundPct, toolPct, timePct);
    const withinBudget = maxPct < 1;
    const nearLimit = maxPct >= this.config.warningThreshold;

    if (!withinBudget && !this.overBudget) {
      this.overBudget = true;
      void EventBus.emit('budget_exceeded', {
        tokensUsed: this.tokensUsed,
        roundsUsed: this.roundsUsed,
        toolCallsUsed: this.toolCallsUsed,
        elapsed,
        timestamp: new Date().toISOString(),
      });
    }

    const remaining = {
      tokens: Math.max(0, this.config.maxTokens - this.tokensUsed),
      rounds: Math.max(0, this.config.maxRounds - this.roundsUsed),
      toolCalls: Math.max(0, this.config.maxToolCalls - this.toolCallsUsed),
      durationMs: Math.max(0, this.config.maxDurationMs - elapsed),
    };

    const icon = !withinBudget ? '🔴' : nearLimit ? '🟡' : '🟢';
    const status = !withinBudget ? '已超支' : nearLimit ? '接近上限' : '正常';

    const lines = [
      `${icon} 预算状态: ${status}`,
      '',
      `Token: ${this.tokensUsed.toLocaleString()} / ${this.config.maxTokens.toLocaleString()} (${(tokenPct * 100).toFixed(1)}%)`,
      `轮次: ${this.roundsUsed} / ${this.config.maxRounds} (${(roundPct * 100).toFixed(1)}%)`,
      `工具调用: ${this.toolCallsUsed} / ${this.config.maxToolCalls} (${(toolPct * 100).toFixed(1)}%)`,
      `时长: ${(elapsed / 1000).toFixed(1)}s / ${(this.config.maxDurationMs / 1000).toFixed(0)}s (${(timePct * 100).toFixed(1)}%)`,
      '',
      `剩余: Token=${remaining.tokens.toLocaleString()}, 轮次=${remaining.rounds}, 调用=${remaining.toolCalls}, 时长=${(remaining.durationMs / 1000).toFixed(0)}s`,
    ];

    if (this.warnings.length > 0) {
      lines.push('', '⚠️ 警告:');
      for (const w of this.warnings.slice(-5)) lines.push(`  ${w}`);
    }

    return {
      success: true,
      output: lines.join('\n'),
      duration: 0,
      validated: false,
      metadata: {
        withinBudget,
        nearLimit,
        overBudget: this.overBudget,
        remaining,
      },
    };
  }

  consumeBudget(params: Record<string, unknown>): ToolResult {
    const tokens = Number(params.tokens_used) || 0;
    const toolName = String(params.tool_name || 'unknown');
    this.tokensUsed += tokens;
    this.toolCallsUsed++;
    if (!this.toolBreakdown.has(toolName))
      this.toolBreakdown.set(toolName, { calls: 0, tokens: 0 });
    const bd = this.toolBreakdown.get(toolName)!;
    bd.calls++;
    bd.tokens += tokens;

    const tokenPct =
      this.config.maxTokens > 0 ? this.tokensUsed / this.config.maxTokens : 0;
    if (tokenPct >= this.config.warningThreshold && tokenPct < 1) {
      const warning = `Token 使用达 ${(tokenPct * 100).toFixed(0)}%`;
      if (!this.warnings.includes(warning)) {
        this.warnings.push(warning);
        Logger.warn(`💰 ${warning}`, 'BudgetManage');
      }
    }

    return {
      success: true,
      output: `📊 已记录: +${tokens} Token (${toolName}) | 总计: ${this.tokensUsed.toLocaleString()} / ${this.config.maxTokens.toLocaleString()}`,
      duration: 0,
      validated: false,
      metadata: {
        tokensUsed: this.tokensUsed,
        toolCallsUsed: this.toolCallsUsed,
      },
    };
  }

  reportBudget(): ToolResult {
    const elapsed = Date.now() - this.startTime;
    const breakdown = Array.from(this.toolBreakdown.entries())
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 15);

    const lines = [
      '💰 预算消耗报告',
      '',
      '📊 总览:',
      `  Token: ${this.tokensUsed.toLocaleString()} / ${this.config.maxTokens.toLocaleString()}`,
      `  轮次: ${this.roundsUsed} / ${this.config.maxRounds}`,
      `  工具调用: ${this.toolCallsUsed} / ${this.config.maxToolCalls}`,
      `  运行时长: ${(elapsed / 1000).toFixed(1)}s`,
    ];

    if (breakdown.length > 0) {
      lines.push('', '🔧 工具消耗明细:');
      for (const [name, info] of breakdown) {
        lines.push(
          `  ${name}: ${info.calls}次调用, ${info.tokens.toLocaleString()} Token`
        );
      }
    }

    if (this.warnings.length > 0) {
      lines.push('', `⚠️ 警告 (${this.warnings.length}条):`);
      for (const w of this.warnings) lines.push(`  ${w}`);
    }

    return {
      success: true,
      output: lines.join('\n'),
      duration: 0,
      validated: false,
      metadata: {
        totalTokens: this.tokensUsed,
        totalToolCalls: this.toolCallsUsed,
        elapsed,
      },
    };
  }

  resetBudget(): ToolResult {
    this.tokensUsed = 0;
    this.roundsUsed = 0;
    this.toolCallsUsed = 0;
    this.startTime = Date.now();
    this.toolBreakdown.clear();
    this.warnings = [];
    this.overBudget = false;
    return {
      success: true,
      output: '🔄 预算已重置',
      duration: 0,
      validated: false,
    };
  }

  incrementRound(): void {
    this.roundsUsed++;
  }
}

const globalBudgetManager = new BudgetManager();

export function createBudgetManageExecutor() {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const action = String(params.action || '');
    let result: ToolResult;

    switch (action) {
      case 'set':
        result = globalBudgetManager.setBudget(params);
        Logger.info('💰 budget_manage: 预算已设置', 'BudgetManage');
        break;
      case 'check':
        result = globalBudgetManager.checkBudget();
        break;
      case 'consume':
        result = globalBudgetManager.consumeBudget(params);
        break;
      case 'report':
        result = globalBudgetManager.reportBudget();
        break;
      case 'reset':
        result = globalBudgetManager.resetBudget();
        Logger.info('💰 budget_manage: 预算已重置', 'BudgetManage');
        break;
      default:
        result = {
          success: false,
          output: '',
          error: `不支持的操作: ${action}。支持: set, check, consume, report, reset`,
          duration: Date.now() - startTime,
          validated: false,
        };
    }

    result.duration = Date.now() - startTime;
    return result;
  };
}

export { globalBudgetManager as BudgetManagerInstance };
