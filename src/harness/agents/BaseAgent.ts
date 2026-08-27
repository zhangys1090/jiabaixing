/**
 * BaseAgent — 抽象 Agent 基类
 *
 * 定义统一的 Agent 接口，持有 llm、tools、memory 引用。
 * 具体 Agent（CodingAgent/FileAgent/DesktopAgent/OrchestratorAgent）继承此类，
 * 配置各自工具集和执行逻辑。
 *
 * V5.6 增强：
 * - bid() 竞标接口：供 OrchestratorAgent 选择最佳执行者
 * - healthCheck() 健康检查：供 AgentRegistry 监控
 * - canHandle() 能力匹配：供任务分配
 *
 * 设计原则：
 * - Agent 自治：每个 Agent 独立持有自己的资源
 * - 状态外置：执行状态可被外部观察
 * - 可恢复：失败后可重置
 */

import { Logger } from '../../utils/Logger';
import { ToolCategory } from '../types';

/** Agent 执行结果 */
export interface AgentResult {
  /** 是否成功 */
  success: boolean;
  /** 结果摘要 */
  summary: string;
  /** 详细数据 */
  data?: Record<string, unknown>;
  /** 执行时长 (ms) */
  duration: number;
}

/** Agent 竞标结果 — 供 OrchestratorAgent 选择执行者 */
export interface AgentBid {
  /** 竞标 Agent ID */
  agentId: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 预估执行时长 (ms) */
  estimatedDuration?: number;
  /** 竞标理由 */
  reason?: string;
}

/** Agent 健康状态 */
export interface AgentHealthStatus {
  /** 是否健康 */
  healthy: boolean;
  /** 成功率 0-1 */
  successRate: number;
  /** 平均响应时间 (ms) */
  avgResponseTime: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 错误次数 */
  errorCount: number;
  /** 总执行次数 */
  totalExecutions: number;
}

/** Agent 执行函数类型 */
export type AgentExecuteFn = (
  goal: string,
  context: string,
  agent: BaseAgent
) => Promise<string>;

/** Agent 状态 */
export type AgentStatus = 'idle' | 'busy' | 'error';

/** Agent 配置 */
export interface BaseAgentConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 能力列表（如 ['coding', 'refactoring']） */
  capabilities: string[];
  /** 工具分类列表（该 Agent 可使用的工具分类） */
  toolCategories: ToolCategory[];
}

export abstract class BaseAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: string[];
  readonly toolCategories: ToolCategory[];

  private _status: AgentStatus = 'idle';
  private executeFn: AgentExecuteFn | null = null;
  private lastExecuteTime: number = 0;
  private errorCount: number = 0;
  private successCount: number = 0;
  private totalResponseTime: number = 0;

  constructor(config: BaseAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.capabilities = config.capabilities;
    this.toolCategories = config.toolCategories;
  }

  /** 当前状态 */
  get status(): AgentStatus {
    return this._status;
  }

  /** 成功次数 */
  get successRate(): number {
    const total = this.successCount + this.errorCount;
    return total === 0 ? 1.0 : this.successCount / total;
  }

  /** 设置执行函数 */
  setExecuteFn(fn: AgentExecuteFn): void {
    this.executeFn = fn;
  }

  /** 检查 Agent 是否已设置执行函数 */
  get isReady(): boolean {
    return this.executeFn !== null;
  }

  /**
   * 执行任务
   * @param goal - 任务目标
   * @param context - 上下文信息
   * @returns 执行结果文本
   */
  async execute(goal: string, context: string = ''): Promise<string> {
    if (!this.executeFn) {
      throw new Error(`${this.name} 未设置 executeFn，无法执行任务`);
    }

    this._status = 'busy';
    const startTime = Date.now();

    try {
      Logger.info(
        `🤖 ${this.name} 开始执行: ${goal.substring(0, 80)}`,
        this.id
      );

      const result = await this.executeFn(goal, context, this);
      this._status = 'idle';
      this.successCount++;
      this.lastExecuteTime = Date.now() - startTime;
      this.totalResponseTime += this.lastExecuteTime;

      Logger.info(
        `✅ ${this.name} 执行完成 (${this.lastExecuteTime}ms)`,
        this.id
      );

      return result;
    } catch (error) {
      this._status = 'error';
      this.errorCount++;
      this.lastExecuteTime = Date.now() - startTime;
      this.totalResponseTime += this.lastExecuteTime;

      Logger.error(`${this.name} 执行失败`, error as Error, this.id);

      throw error;
    }
  }

  /**
   * 竞标接口 — 供 OrchestratorAgent 选择最佳执行者
   * 子类可覆盖以实现更精细的竞标逻辑
   * @param taskGoal - 任务目标
   * @param requiredTools - 所需工具列表
   * @returns 竞标结果，null 表示不参与竞标
   */
  async bid(
    taskGoal: string,
    requiredTools?: string[]
  ): Promise<AgentBid | null> {
    if (this._status !== 'idle') return null;
    if (!this.canHandle(taskGoal, requiredTools)) return null;

    const confidence = this.estimateConfidence(taskGoal);
    return {
      agentId: this.id,
      confidence,
      estimatedDuration:
        this.lastExecuteTime > 0 ? this.lastExecuteTime * 1.2 : undefined,
      reason: `${this.name} 匹配能力: ${this.capabilities.join(', ')}`,
    };
  }

  /**
   * 能力匹配 — 检查本 Agent 是否能处理给定任务
   * @param taskGoal - 任务目标
   * @param requiredTools - 所需工具列表
   */
  canHandle(taskGoal: string, requiredTools?: string[]): boolean {
    if (requiredTools && requiredTools.length > 0) {
      return requiredTools.some((tool) =>
        this.toolCategories.some(
          (cat) => String(cat) === tool || String(cat) === '*'
        )
      );
    }
    return true;
  }

  /**
   * 估算置信度 — 基于历史成功率
   * 子类可覆盖以实现更精细的估算
   */
  protected estimateConfidence(_taskGoal: string): number {
    return this.successRate;
  }

  /**
   * 健康检查 — 供 AgentRegistry 监控
   */
  async healthCheck(): Promise<AgentHealthStatus> {
    const total = this.successCount + this.errorCount;
    return {
      healthy: this._status !== 'error',
      successRate: this.successRate,
      avgResponseTime: total > 0 ? this.totalResponseTime / total : 0,
      lastActiveAt: Date.now() - this.lastExecuteTime,
      errorCount: this.errorCount,
      totalExecutions: total,
    };
  }

  /** 重置状态 */
  reset(): void {
    this._status = 'idle';
    Logger.debug(`${this.name} 状态已重置`, this.id);
  }

  /** 获取统计信息 */
  getStats(): {
    status: AgentStatus;
    successCount: number;
    errorCount: number;
    successRate: number;
    lastExecuteTime: number;
    avgResponseTime: number;
  } {
    const total = this.successCount + this.errorCount;
    return {
      status: this._status,
      successCount: this.successCount,
      errorCount: this.errorCount,
      successRate: this.successRate,
      lastExecuteTime: this.lastExecuteTime,
      avgResponseTime: total > 0 ? this.totalResponseTime / total : 0,
    };
  }
}
