/**
 * 循环观察者
 *
 * 【功能】
 * 增强 Agent 主循环的可观测性，让工作过程可见
 *
 * 【设计原则】
 * - 非侵入式：通过事件监听实现，不修改主循环逻辑
 * - 可配置：默认关闭，通过配置或环境变量开启
 * - 轻量级：不影响主循环性能
 * - 结构化：结构化的追踪数据，便于分析和展示
 *
 * 【追踪内容】
 * - 循环阶段状态（Planner/Executor/Evaluator/Reporter）
 * - 工具调用详情（名称、参数、结果、耗时）
 * - 思考过程摘要
 * - 错误和异常
 * - 性能指标
 *
 * 【使用场景】
 * - 调试和问题定位
 * - 性能分析和优化
 * - 用户透明度展示
 * - 学习和教学
 *
 * @module LoopObserver
 * @version 0.1.0
 * @status Beta - 功能基本完成，测试中
 * @since 2026-06-24
 */

import { Logger } from '../../utils/Logger';

// ========== 常量定义 ==========

/** 最大历史记录数 */
const MAX_HISTORY_SIZE = 100;

/** 环境变量：是否启用观察者 */
const ENV_OBSERVER_ENABLED = 'LOOP_OBSERVER_ENABLED';

/** 环境变量：是否启用详细模式 */
const ENV_OBSERVER_VERBOSE = 'LOOP_OBSERVER_VERBOSE';

/** 循环阶段 */
export type LoopPhase =
  | 'planner'
  | 'executor'
  | 'evaluator'
  | 'reporter'
  | 'idle';

/** 工具调用记录 */
export interface ToolCallRecord {
  /** 调用 ID */
  id: string;
  /** 工具名称 */
  toolName: string;
  /** 参数摘要 */
  paramsSummary: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 耗时（ms） */
  duration?: number;
  /** 是否成功 */
  success?: boolean;
  /** 结果摘要 */
  resultSummary?: string;
  /** 错误信息 */
  error?: string;
  /** 重试次数 */
  retryCount: number;
}

/** 阶段记录 */
export interface PhaseRecord {
  /** 阶段名称 */
  phase: LoopPhase;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 耗时（ms） */
  duration?: number;
  /** 输入摘要 */
  inputSummary?: string;
  /** 输出摘要 */
  outputSummary?: string;
  /** 是否成功 */
  success?: boolean;
  /** 错误信息 */
  error?: string;
}

/** 循环追踪记录 */
export interface LoopTrace {
  /** 追踪 ID */
  traceId: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 总耗时（ms） */
  totalDuration?: number;
  /** 阶段记录 */
  phases: PhaseRecord[];
  /** 工具调用记录 */
  toolCalls: ToolCallRecord[];
  /** 当前阶段 */
  currentPhase: LoopPhase;
  /** 是否成功 */
  success?: boolean;
  /** 错误信息 */
  error?: string;
  /** 用户输入摘要 */
  userInputSummary?: string;
  /** AI 输出摘要 */
  aiOutputSummary?: string;
}

/** 循环统计 */
export interface LoopStatistics {
  /** 总循环数 */
  totalLoops: number;
  /** 成功循环数 */
  successfulLoops: number;
  /** 失败循环数 */
  failedLoops: number;
  /** 平均耗时（ms） */
  averageDuration: number;
  /** 总工具调用数 */
  totalToolCalls: number;
  /** 工具成功率 */
  toolSuccessRate: number;
  /** 平均工具调用耗时（ms） */
  averageToolDuration: number;
  /** 各阶段平均耗时 */
  phaseDurations: Record<LoopPhase, number>;
}

/**
 * 循环观察者
 */
export class LoopObserver {
  private static instance: LoopObserver;

  /** 是否启用 */
  private enabled = false;

  /** 是否输出详细调试信息 */
  private verbose = false;

  /** 当前追踪 */
  private currentTrace: LoopTrace | null = null;

  /** 追踪历史 */
  private traceHistory: LoopTrace[] = [];

  /** 最大历史记录数 */
  private readonly maxHistorySize = MAX_HISTORY_SIZE;

  /** 统计数据 */
  private statistics: LoopStatistics = {
    totalLoops: 0,
    successfulLoops: 0,
    failedLoops: 0,
    averageDuration: 0,
    totalToolCalls: 0,
    toolSuccessRate: 0,
    averageToolDuration: 0,
    phaseDurations: {
      planner: 0,
      executor: 0,
      evaluator: 0,
      reporter: 0,
      idle: 0,
    },
  };

  /** 各阶段总耗时 */
  private phaseTotalDurations: Record<LoopPhase, number> = {
    planner: 0,
    executor: 0,
    evaluator: 0,
    reporter: 0,
    idle: 0,
  };

  /** 各阶段计数 */
  private phaseCounts: Record<LoopPhase, number> = {
    planner: 0,
    executor: 0,
    evaluator: 0,
    reporter: 0,
    idle: 0,
  };

  /** 工具总耗时 */
  private toolTotalDuration = 0;

  /** 成功的工具调用数（全局统计） */
  private successfulToolCalls = 0;

  private constructor() {
    // 检查环境变量决定是否启用
    if (process.env[ENV_OBSERVER_ENABLED] === 'true') {
      this.enabled = true;
      this.verbose = process.env[ENV_OBSERVER_VERBOSE] === 'true';
    }

    Logger.info(
      `🔍 循环观察者已初始化 (${this.enabled ? '已启用' : '已禁用'})`,
      'LoopObserver'
    );
  }

  static getInstance(): LoopObserver {
    if (!LoopObserver.instance) {
      LoopObserver.instance = new LoopObserver();
    }
    return LoopObserver.instance;
  }

  /**
   * 重置单例实例（测试用）
   *
   * 【注意】
   * - 仅供测试使用，生产环境请勿调用
   * - 会清除所有追踪数据和统计
   * - 调用后下次 getInstance() 会创建新实例
   */
  static resetInstance(): void {
    if (LoopObserver.instance) {
      LoopObserver.instance = null as any;
    }
  }

  /**
   * 创建测试用独立实例（测试用）
   *
   * 【注意】
   * - 仅供测试使用，生产环境请勿调用
   * - 创建的是独立实例，不影响单例
   */
  static createTestInstance(): LoopObserver {
    return new LoopObserver();
  }

  // ========== 循环追踪 ==========

  /**
   * 开始循环追踪
   */
  startLoop(userInput?: string): string {
    if (!this.enabled) return '';

    const traceId = `loop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.currentTrace = {
      traceId,
      startTime: Date.now(),
      phases: [],
      toolCalls: [],
      currentPhase: 'idle',
      userInputSummary: userInput ? this.summarize(userInput, 50) : undefined,
    };

    if (this.verbose) {
      Logger.info(`🔍 [追踪开始] ${traceId}`, 'LoopObserver');
    }

    return traceId;
  }

  /**
   * 结束循环追踪
   */
  endLoop(success: boolean, error?: string, aiOutput?: string): void {
    if (!this.enabled || !this.currentTrace) return;

    const trace = this.currentTrace;
    trace.endTime = Date.now();
    trace.totalDuration = trace.endTime - trace.startTime;
    trace.success = success;
    trace.error = error;
    trace.aiOutputSummary = aiOutput
      ? this.summarize(aiOutput, 100)
      : undefined;
    trace.currentPhase = 'idle';

    // 更新统计
    this.statistics.totalLoops++;
    if (success) {
      this.statistics.successfulLoops++;
    } else {
      this.statistics.failedLoops++;
    }

    // 更新平均耗时
    const totalDuration =
      this.statistics.averageDuration * (this.statistics.totalLoops - 1) +
      trace.totalDuration;
    this.statistics.averageDuration =
      totalDuration / this.statistics.totalLoops;

    // 添加到历史
    this.traceHistory.push(trace);
    if (this.traceHistory.length > this.maxHistorySize) {
      this.traceHistory.shift();
    }

    if (this.verbose) {
      const status = success ? '✅ 成功' : '❌ 失败';
      Logger.info(
        `🔍 [追踪结束] ${trace.traceId} ${status} 耗时 ${trace.totalDuration}ms`,
        'LoopObserver'
      );
    }

    this.currentTrace = null;
  }

  // ========== 阶段追踪 ==========

  /**
   * 开始阶段
   */
  startPhase(phase: LoopPhase, inputSummary?: string): void {
    if (!this.enabled || !this.currentTrace) return;

    const phaseRecord: PhaseRecord = {
      phase,
      startTime: Date.now(),
      inputSummary: inputSummary ? this.summarize(inputSummary, 50) : undefined,
    };

    this.currentTrace.phases.push(phaseRecord);
    this.currentTrace.currentPhase = phase;

    if (this.verbose) {
      Logger.info(`🔍 [阶段开始] ${phase}`, 'LoopObserver');
    }
  }

  /**
   * 结束阶段
   */
  endPhase(
    phase: LoopPhase,
    success: boolean = true,
    outputSummary?: string,
    error?: string
  ): void {
    if (!this.enabled || !this.currentTrace) return;

    const phaseRecord = this.currentTrace.phases.find(
      (p) => p.phase === phase && !p.endTime
    );
    if (!phaseRecord) return;

    phaseRecord.endTime = Date.now();
    phaseRecord.duration = phaseRecord.endTime - phaseRecord.startTime;
    phaseRecord.success = success;
    phaseRecord.error = error;
    phaseRecord.outputSummary = outputSummary
      ? this.summarize(outputSummary, 50)
      : undefined;

    // 更新统计
    this.phaseCounts[phase]++;
    this.phaseTotalDurations[phase] += phaseRecord.duration;
    if (this.phaseCounts[phase] > 0) {
      this.statistics.phaseDurations[phase] =
        this.phaseTotalDurations[phase] / this.phaseCounts[phase];
    }

    if (this.verbose) {
      const status = success ? '✅' : '❌';
      Logger.info(
        `🔍 [阶段结束] ${phase} ${status} 耗时 ${phaseRecord.duration}ms`,
        'LoopObserver'
      );
    }
  }

  // ========== 工具调用追踪 ==========

  /**
   * 开始工具调用
   */
  startToolCall(toolName: string, params?: Record<string, unknown>): string {
    if (!this.enabled || !this.currentTrace) return '';

    const callId = `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const toolCall: ToolCallRecord = {
      id: callId,
      toolName,
      paramsSummary: params ? this.summarizeParams(params) : '',
      startTime: Date.now(),
      retryCount: 0,
    };

    this.currentTrace.toolCalls.push(toolCall);

    if (this.verbose) {
      Logger.info(`🔍 [工具调用] ${toolName} 开始`, 'LoopObserver');
    }

    return callId;
  }

  /**
   * 结束工具调用
   */
  endToolCall(
    callId: string,
    success: boolean,
    result?: unknown,
    error?: string
  ): void {
    if (!this.enabled || !this.currentTrace) return;

    const toolCall = this.currentTrace.toolCalls.find((t) => t.id === callId);
    if (!toolCall) return;

    toolCall.endTime = Date.now();
    toolCall.duration = toolCall.endTime - toolCall.startTime;
    toolCall.success = success;
    toolCall.resultSummary = result
      ? this.summarize(String(result), 100)
      : undefined;
    toolCall.error = error;

    // 更新统计
    this.statistics.totalToolCalls++;
    this.toolTotalDuration += toolCall.duration;

    if (success) {
      this.successfulToolCalls++;
    }

    if (this.statistics.totalToolCalls > 0) {
      this.statistics.averageToolDuration =
        this.toolTotalDuration / this.statistics.totalToolCalls;

      // 全局工具成功率（修复前只算了当前 trace 的）
      this.statistics.toolSuccessRate =
        this.successfulToolCalls / this.statistics.totalToolCalls;
    }

    if (this.verbose) {
      const status = success ? '✅' : '❌';
      Logger.info(
        `🔍 [工具完成] ${toolCall.toolName} ${status} 耗时 ${toolCall.duration}ms`,
        'LoopObserver'
      );
    }
  }

  /**
   * 记录工具重试
   */
  recordToolRetry(callId: string): void {
    if (!this.enabled || !this.currentTrace) return;

    const toolCall = this.currentTrace.toolCalls.find((t) => t.id === callId);
    if (toolCall) {
      toolCall.retryCount++;

      if (this.verbose) {
        Logger.info(
          `🔍 [工具重试] ${toolCall.toolName} (第 ${toolCall.retryCount} 次重试)`,
          'LoopObserver'
        );
      }
    }
  }

  // ========== 查询方法 ==========

  /**
   * 获取当前追踪
   */
  getCurrentTrace(): LoopTrace | null {
    return this.currentTrace;
  }

  /**
   * 获取历史追踪
   */
  getTraceHistory(limit?: number): LoopTrace[] {
    if (limit) {
      return this.traceHistory.slice(-limit);
    }
    return [...this.traceHistory];
  }

  /**
   * 获取统计数据
   */
  getStatistics(): LoopStatistics {
    return { ...this.statistics };
  }

  /**
   * 获取最近的工具调用
   */
  getRecentToolCalls(limit: number = 10): ToolCallRecord[] {
    if (!this.currentTrace) return [];
    return this.currentTrace.toolCalls.slice(-limit);
  }

  // ========== 控制方法 ==========

  /**
   * 启用观察者
   */
  enable(verbose: boolean = false): void {
    this.enabled = true;
    this.verbose = verbose;
    Logger.info(`🔍 循环观察者已启用 (verbose=${verbose})`, 'LoopObserver');
  }

  /**
   * 禁用观察者
   */
  disable(): void {
    this.enabled = false;
    this.verbose = false;
    Logger.info('🔍 循环观察者已禁用', 'LoopObserver');
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 重置统计数据
   */
  resetStatistics(): void {
    this.statistics = {
      totalLoops: 0,
      successfulLoops: 0,
      failedLoops: 0,
      averageDuration: 0,
      totalToolCalls: 0,
      toolSuccessRate: 0,
      averageToolDuration: 0,
      phaseDurations: {
        planner: 0,
        executor: 0,
        evaluator: 0,
        reporter: 0,
        idle: 0,
      },
    };

    this.phaseTotalDurations = {
      planner: 0,
      executor: 0,
      evaluator: 0,
      reporter: 0,
      idle: 0,
    };

    this.phaseCounts = {
      planner: 0,
      executor: 0,
      evaluator: 0,
      reporter: 0,
      idle: 0,
    };

    this.toolTotalDuration = 0;
    this.successfulToolCalls = 0;
    this.traceHistory = [];

    Logger.info('🔍 循环观察者统计已重置', 'LoopObserver');
  }

  // ========== 辅助方法 ==========

  /**
   * 文本摘要
   */
  private summarize(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  /**
   * 参数摘要
   */
  private summarizeParams(params: Record<string, unknown>): string {
    try {
      const keys = Object.keys(params);
      if (keys.length === 0) return '{}';

      const summary: string[] = [];
      for (const key of keys.slice(0, 5)) {
        const value = params[key];
        const valueStr =
          typeof value === 'string'
            ? this.summarize(value, 20)
            : typeof value === 'object'
              ? '[object]'
              : String(value);
        summary.push(`${key}=${valueStr}`);
      }

      return (
        summary.join(', ') + (keys.length > 5 ? `...(+${keys.length - 5})` : '')
      );
    } catch {
      return '[params]';
    }
  }

  /**
   * 生成格式化的追踪报告
   */
  generateTraceReport(trace: LoopTrace): string {
    const lines: string[] = [];

    lines.push(`循环追踪报告: ${trace.traceId}`);
    lines.push(`状态: ${trace.success ? '✅ 成功' : '❌ 失败'}`);
    lines.push(`总耗时: ${trace.totalDuration}ms`);
    lines.push('');

    lines.push('阶段列表:');
    for (const phase of trace.phases) {
      const status = phase.success ? '✅' : '❌';
      lines.push(`  ${status} ${phase.phase}: ${phase.duration}ms`);
    }
    lines.push('');

    lines.push(`工具调用 (${trace.toolCalls.length} 次):`);
    for (const tool of trace.toolCalls) {
      const status = tool.success ? '✅' : '❌';
      lines.push(
        `  ${status} ${tool.toolName}: ${tool.duration}ms (重试 ${tool.retryCount} 次)`
      );
    }

    return lines.join('\n');
  }
}

export default LoopObserver;
