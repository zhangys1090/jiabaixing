/**
 * Harness Layer 2: Tools - 工具注册表
 *
 * 声明式工具注册 + Schema 验证 + 权限检查
 * 替代 SkillRegistry 的基础设施工具注册功能
 */

import { Logger } from '../../../utils/Logger';
import {
  ToolCategory,
} from '../../types';
import type {
  ToolDefinition,
  ToolParameterDef,
  ToolResult,
  ToolContext,
  RegisteredTool,
  RiskLevel,
} from '../../types';

/** OpenAI Function Calling 工具格式 */
interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  /** toOpenAITools() 缓存 */
  private cachedOpenAITools: OpenAIToolDef[] | null = null;

  /**
   * 注册工具
   */
  register(
    definition: ToolDefinition,
    execute: (
      params: Record<string, unknown>,
      context: ToolContext
    ) => Promise<ToolResult>
  ): void {
    if (this.tools.has(definition.name)) {
      Logger.debug(
        `工具已存在，跳过重复注册: ${definition.name}`,
        'ToolRegistry'
      );
      return;
    }

    this.tools.set(definition.name, { definition, execute });
    this.cachedOpenAITools = null;

    Logger.info(
      `🔧 注册工具: ${definition.name} [${definition.category}] 风险=${definition.riskLevel}`,
      'ToolRegistry'
    );
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      this.cachedOpenAITools = null;
      Logger.info(`🔧 注销工具: ${name}`, 'ToolRegistry');
    }
    return removed;
  }

  /**
   * 获取已注册工具
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册工具
   */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 按分类获取工具
   */
  getByCategory(category: ToolCategory): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.definition.category === category
    );
  }

  /**
   * 按风险等级获取工具
   */
  getByRiskLevel(riskLevel: RiskLevel): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.definition.riskLevel === riskLevel
    );
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取已注册工具数量
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * 执行工具调用
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `工具不存在: ${name}`,
        duration: 0,
        validated: false,
      };
    }

    const startTime = Date.now();
    try {
      Logger.info(
        `🧠 执行工具: ${name} | 风险=${tool.definition.riskLevel}`,
        'ToolRegistry'
      );

      // 超时控制
      const result = await Promise.race([
        tool.execute(params, context),
        this.createTimeoutPromise(tool.definition.timeout, name),
      ]);

      const finalResult: ToolResult = {
        ...result,
        duration: Date.now() - startTime,
        validated: result.validated ?? false,
      };

      this.reliabilityTracker.recordCall(name, finalResult.success, finalResult.duration, finalResult.error);

      return finalResult;
    } catch (err) {
      const errorResult: ToolResult = {
        success: false,
        output: null,
        error: (err as Error).message,
        duration: Date.now() - startTime,
        validated: false,
      };

      this.reliabilityTracker.recordCall(name, false, errorResult.duration, errorResult.error);

      return errorResult;
    }
  }

  /**
   * 执行 LLM 返回的 tool call
   */
  async executeToolCall(
    toolCall: {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    },
    context: ToolContext
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }

    return this.execute(toolName, args, context);
  }

  /**
   * 转换为 OpenAI Function Calling 工具格式
   * 进化闭环：按综合评分排序（成功率 × 进化权重），权重差异注入 description
   */
  toOpenAITools(): OpenAIToolDef[] {
    if (this.cachedOpenAITools) return this.cachedOpenAITools;

    const tools: OpenAIToolDef[] = [];

    const categoryOrder: ToolCategory[] = [
      ToolCategory.COGNITION,
      ToolCategory.MEMORY,
      ToolCategory.DAILY,
      ToolCategory.NETWORK,
      ToolCategory.SYSTEM,
      ToolCategory.FILE,
      ToolCategory.CODE,
      ToolCategory.DESKTOP,
    ];

    const sorted = Array.from(this.tools.values()).sort((a, b) => {
      const ai = categoryOrder.indexOf(a.definition.category);
      const bi = categoryOrder.indexOf(b.definition.category);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);

      const scoreA = this.reliabilityTracker.getCompositeScore(a.definition.name);
      const scoreB = this.reliabilityTracker.getCompositeScore(b.definition.name);
      return scoreB - scoreA;
    });

    const avgCompositeScore = sorted.length > 0
      ? sorted.reduce((sum, t) => sum + this.reliabilityTracker.getCompositeScore(t.definition.name), 0) / sorted.length
      : 1.0;

    for (const tool of sorted) {
      const properties: Record<string, unknown> = {};
      for (const [paramName, paramDef] of Object.entries(
        tool.definition.parameters
      )) {
        properties[paramName] = this.parameterDefToOpenAI(paramDef);
      }

      const compositeScore = this.reliabilityTracker.getCompositeScore(tool.definition.name);
      const evolutionWeight = this.reliabilityTracker.getEvolutionWeight(tool.definition.name);
      let description = tool.definition.description;

      if (evolutionWeight !== 1.0 || compositeScore < avgCompositeScore * 0.8) {
        if (evolutionWeight > 1.0) {
          description += ` [推荐:进化权重${evolutionWeight.toFixed(2)}]`;
        } else if (evolutionWeight < 1.0) {
          description += ` [慎用:进化权重${evolutionWeight.toFixed(2)}]`;
        }
        if (compositeScore < 0.5) {
          description += ` [低可靠度:${(compositeScore * 100).toFixed(0)}%]`;
        }
      }

      tools.push({
        type: 'function',
        function: {
          name: tool.definition.name,
          description,
          parameters: {
            type: 'object',
            properties,
            required: tool.definition.requiredParams,
          },
        },
      });
    }

    this.cachedOpenAITools = tools;
    return tools;
  }

  /**
   * 将 ToolParameterDef 转换为 OpenAI Schema 格式
   */
  private parameterDefToOpenAI(param: ToolParameterDef): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };

    if (param.enum) {
      schema.enum = param.enum;
    }

    if (param.default !== undefined) {
      schema.default = param.default;
    }

    if (param.type === 'array' && param.items) {
      schema.items = this.parameterDefToOpenAI(param.items);
    }

    if (param.type === 'object' && param.properties) {
      const props: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(param.properties)) {
        props[key] = this.parameterDefToOpenAI(val);
      }
      schema.properties = props;
    }

    return schema;
  }

  /**
   * 创建超时 Promise
   */
  private createTimeoutPromise(
    timeoutMs: number,
    toolName: string
  ): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`工具执行超时: ${toolName} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  /**
   * 清除缓存（注册/注销后自动调用，也可手动调用）
   */
  invalidateCache(): void {
    this.cachedOpenAITools = null;
  }

  private reliabilityTracker = new ToolReliabilityTracker();

  /**
   * 获取工具可靠性追踪器
   */
  getReliabilityTracker(): ToolReliabilityTracker {
    return this.reliabilityTracker;
  }
}

export class ToolReliabilityTracker {
  private stats: Map<string, { calls: number; successes: number; totalDuration: number; lastError?: string }> = new Map();
  private evolutionWeights: Map<string, number> = new Map();

  /**
   * 应用进化引擎产出的技能权重调整
   * 权重影响工具推荐排序：权重越高越优先推荐
   */
  applyEvolutionWeights(weights: Record<string, number>): void {
    for (const [toolName, weight] of Object.entries(weights)) {
      this.evolutionWeights.set(toolName, weight);
    }
    Logger.info(
      `🔧 进化权重已应用: ${Object.keys(weights).join(', ') || '(无变更)'}`,
      'ToolReliabilityTracker'
    );
  }

  /**
   * 获取所有进化权重（用于外部消费）
   */
  getEvolutionWeights(): Map<string, number> {
    return new Map(this.evolutionWeights);
  }

  /**
   * 获取工具的进化权重（用于推荐排序）
   */
  getEvolutionWeight(toolName: string): number {
    return this.evolutionWeights.get(toolName) ?? 1.0;
  }

  /**
   * 获取综合评分（成功率 × 进化权重）
   */
  getCompositeScore(toolName: string): number {
    const successRate = this.getSuccessRate(toolName);
    const weight = this.getEvolutionWeight(toolName);
    return successRate * weight;
  }

  /**
   * 记录工具调用结果
   * @param toolName - 工具名称
   * @param success - 是否成功
   * @param duration - 执行时长(ms)
   * @param error - 错误信息
   */
  recordCall(toolName: string, success: boolean, duration: number, error?: string): void {
    const existing = this.stats.get(toolName);
    if (existing) {
      existing.calls++;
      if (success) existing.successes++;
      existing.totalDuration += duration;
      if (error) existing.lastError = error;
    } else {
      this.stats.set(toolName, {
        calls: 1,
        successes: success ? 1 : 0,
        totalDuration: duration,
        lastError: error,
      });
    }
  }

  /**
   * 获取工具成功率
   * @param toolName - 工具名称
   * @returns 成功率 (0-1)
   */
  getSuccessRate(toolName: string): number {
    const stat = this.stats.get(toolName);
    if (!stat || stat.calls === 0) return 0;
    return stat.successes / stat.calls;
  }

  /**
   * 获取工具平均执行时长
   * @param toolName - 工具名称
   * @returns 平均时长(ms)
   */
  getAverageDuration(toolName: string): number {
    const stat = this.stats.get(toolName);
    if (!stat || stat.calls === 0) return 0;
    return stat.totalDuration / stat.calls;
  }

  /**
   * 获取不可靠工具列表（成功率低于阈值）
   * @param threshold - 成功率阈值，默认0.9
   * @returns 不可靠工具名称列表
   */
  getUnreliableTools(threshold: number = 0.9): string[] {
    const unreliable: string[] = [];
    for (const [toolName, stat] of this.stats) {
      if (stat.calls > 0 && stat.successes / stat.calls < threshold) {
        unreliable.push(toolName);
      }
    }
    return unreliable;
  }

  /**
   * 获取单个工具统计信息
   * @param toolName - 工具名称
   * @returns 统计信息或null
   */
  getStats(toolName: string): { calls: number; successes: number; successRate: number; avgDuration: number; lastError?: string } | null {
    const stat = this.stats.get(toolName);
    if (!stat) return null;
    return {
      calls: stat.calls,
      successes: stat.successes,
      successRate: stat.calls > 0 ? stat.successes / stat.calls : 0,
      avgDuration: stat.calls > 0 ? stat.totalDuration / stat.calls : 0,
      lastError: stat.lastError,
    };
  }

  /**
   * 获取所有工具统计信息
   * @returns 所有工具统计信息映射
   */
  getAllStats(): Map<string, { calls: number; successes: number; successRate: number; avgDuration: number; lastError?: string }> {
    const result = new Map<string, { calls: number; successes: number; successRate: number; avgDuration: number; lastError?: string }>();
    for (const [toolName, stat] of this.stats) {
      result.set(toolName, {
        calls: stat.calls,
        successes: stat.successes,
        successRate: stat.calls > 0 ? stat.successes / stat.calls : 0,
        avgDuration: stat.calls > 0 ? stat.totalDuration / stat.calls : 0,
        lastError: stat.lastError,
      });
    }
    return result;
  }

  /**
   * 重置所有统计信息
   */
  reset(): void {
    this.stats.clear();
  }
}
