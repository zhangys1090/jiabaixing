/**
 * Harness Layer 1: Loop - ReflectionEngine 反思引擎
 *
 * 阶段3核心能力"反思纠错"的载体
 * - reflect: 工具级反思，分析失败根因，修正参数或替换工具
 * - deepReflect: 深度反思，分析整条轨迹并给出修正计划
 * - reflectOnTaskFailure: 任务级反思闭环（P2-3），全局诊断失败任务
 * - recordExperience/getRelevantExperiences: 经验记忆与检索
 * - getReflectionMetrics: 反思效果度量（P2-7）
 */

import { Logger } from '../../utils/Logger';
import type { TrajectoryDatabase } from '../persistence/TrajectoryDatabase';

/** 反思引擎依赖的 LLM 接口 */
export interface ReflectionLLM {
  chat(prompt: string, systemPrompt?: string): Promise<string>;
}

/** 反思引擎配置 */
export interface ReflectionEngineOptions {
  /** 是否启用深度反思 */
  enableDeepReflection?: boolean;
  /** 经验缓冲区最大记录数 */
  maxExperienceRecords?: number;
}

/** 工具级反思结果 */
export interface ReflectionResult {
  rootCause: string;
  correctedArgs: Record<string, unknown> | null;
  alternativeTool: string | null;
  shouldRetry: boolean;
}

/** 深度反思结果 */
export interface DeepReflectionResult {
  diagnosis: string;
  rootCause: string;
  fixStrategy: string;
  correctedPlan?: Array<{
    stepDescription: string;
    toolName?: string;
    args?: Record<string, unknown>;
  }>;
}

/** 任务级反思输入 */
export interface TaskReflectionInput {
  userInput: string;
  taskGoal: string;
  executionTrace: Array<{
    toolName: string;
    args?: Record<string, unknown>;
    success: boolean;
    error?: string;
    output?: string;
    duration?: number;
  }>;
  failures: Array<{
    toolName: string;
    error: string;
    stepDescription: string;
  }>;
  goalProgress: number;
  roundsUsed: number;
}

/** 任务级反思结果 */
export interface TaskReflectionResult {
  taskDiagnosis: string;
  rootCause: string;
  strategyAdjustment: string;
  correctedPlan?: Array<{
    stepDescription: string;
    toolName?: string;
    args?: Record<string, unknown>;
  }>;
  lessonsLearned: string;
  confidence: number;
}

/** 经验记录 */
export interface ExperienceEntry {
  toolName: string;
  args: Record<string, unknown>;
  error: string;
  rootCause: string;
  resolution: string;
  success: boolean;
  timestamp?: number;
}

/** 任务级反思经验记录 */
export interface TaskReflectionExperience {
  userInput: string;
  taskGoal: string;
  taskDiagnosis: string;
  rootCause: string;
  strategyAdjustment: string;
  lessonsLearned: string;
  confidence: number;
  success: boolean;
  timestamp: number;
}

/** 反思效果度量 */
export interface ReflectionMetrics {
  totalReflections: number;
  retrySuccessRate: number;
  deepReflectionSuccessRate: number;
  experienceReuseRate: number;
  experienceRecordCount: number;
  taskReflections: number;
  taskReflectionSuccessRate: number;
}

/** 错误类型分类映射 */
const ERROR_CATEGORIES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /ENOENT|not found|找不到|不存在/i, category: 'not_found' },
  { pattern: /EACCES|EPERM|permission|权限|拒绝访问/i, category: 'permission' },
  { pattern: /timeout|ETIMEDOUT|超时/i, category: 'timeout' },
  { pattern: /network|ECONNREFUSED|网络|连接/i, category: 'network' },
  { pattern: /syntax|parse|语法|解析/i, category: 'syntax' },
  { pattern: /empty|null|空/i, category: 'empty' },
];

/**
 * 反思引擎
 * 在工具失败时分析根因，提供参数修正、工具替换或重试建议
 */
export class ReflectionEngine {
  private llm: ReflectionLLM;
  private trajectoryDb: TrajectoryDatabase | null = null;
  private options: Required<ReflectionEngineOptions>;
  private experienceBuffer: ExperienceEntry[] = [];
  private taskReflectionBuffer: TaskReflectionExperience[] = [];

  private metrics = {
    totalReflections: 0,
    deepReflections: 0,
    deepReflectionSuccesses: 0,
    experienceReuses: 0,
    taskReflections: 0,
    taskReflectionSuccesses: 0,
  };

  constructor(
    llm: ReflectionLLM,
    trajectoryDb?: TrajectoryDatabase | null,
    options?: ReflectionEngineOptions
  ) {
    this.llm = llm;
    this.trajectoryDb = trajectoryDb ?? null;
    this.options = {
      enableDeepReflection: options?.enableDeepReflection ?? true,
      maxExperienceRecords: options?.maxExperienceRecords ?? 100,
    };
  }

  /**
   * 动态注入 TrajectoryDatabase（修复 initHarness 持久化断裂）
   */
  setTrajectoryDatabase(db: TrajectoryDatabase): void {
    this.trajectoryDb = db;
    Logger.info(
      '🔗 ReflectionEngine 已动态注入 TrajectoryDatabase',
      'ReflectionEngine'
    );
  }

  /**
   * 工具级反思：分析失败根因，提供修正建议
   */
  async reflect(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    context: { traceId: string; loopCount: number }
  ): Promise<ReflectionResult> {
    this.metrics.totalReflections++;

    const similarExperiences = this.getRelevantExperiences(toolName, error, 3);
    const historicalFailures = this.queryHistoricalFailures(toolName, error);

    const prompt = this.buildReflectPrompt(
      toolName,
      args,
      error,
      context,
      similarExperiences,
      historicalFailures
    );

    try {
      const response = await this.llm.chat(prompt);
      const parsed = this.parseJsonResponse(response);

      if (parsed) {
        if (similarExperiences.length > 0) {
          this.metrics.experienceReuses++;
        }
        return {
          rootCause: this.getString(
            parsed,
            'rootCause',
            `${toolName} 执行失败`
          ),
          correctedArgs: this.getCorrectedArgs(parsed),
          alternativeTool:
            typeof parsed.alternativeTool === 'string'
              ? parsed.alternativeTool
              : null,
          shouldRetry: this.getBoolean(parsed, 'shouldRetry', true),
        };
      }

      return this.fallbackReflect(toolName, args, error);
    } catch (err) {
      Logger.warn(
        `reflect LLM 调用失败，降级为规则化分析: ${(err as Error).message}`,
        'ReflectionEngine'
      );
      return this.fallbackReflect(toolName, args, error);
    }
  }

  /**
   * 深度反思：分析整条执行轨迹，给出修正计划
   */
  async deepReflect(
    userInput: string,
    trajectory: Array<{
      toolName: string;
      success: boolean;
      error?: string;
      output?: string;
    }>,
    evalResult: {
      goalProgress: number;
      suggestedAction: string;
      reason: string;
    }
  ): Promise<DeepReflectionResult> {
    if (!this.options.enableDeepReflection) {
      return {
        diagnosis: '深度反思已禁用',
        rootCause: '未启用深度反思',
        fixStrategy: '启用 enableDeepReflection 以获取深度分析',
      };
    }

    this.metrics.deepReflections++;

    const prompt = this.buildDeepReflectPrompt(
      userInput,
      trajectory,
      evalResult
    );

    try {
      const response = await this.llm.chat(prompt);
      const parsed = this.parseJsonResponse(response);

      if (parsed && parsed.diagnosis) {
        this.metrics.deepReflectionSuccesses++;
        return {
          diagnosis: this.getString(parsed, 'diagnosis', '未知诊断'),
          rootCause: this.getString(parsed, 'rootCause', '未知'),
          fixStrategy: this.getString(parsed, 'fixStrategy', '重新规划'),
          correctedPlan: this.getCorrectedPlan(parsed),
        };
      }

      return this.fallbackDeepReflect(userInput, trajectory, evalResult);
    } catch (err) {
      Logger.warn(
        `deepReflect LLM 调用失败: ${(err as Error).message}`,
        'ReflectionEngine'
      );
      return this.fallbackDeepReflect(userInput, trajectory, evalResult);
    }
  }

  /**
   * 任务级反思闭环（P2-3）：对任务失败进行全局诊断并返回修正计划
   */
  async reflectOnTaskFailure(
    input: TaskReflectionInput
  ): Promise<TaskReflectionResult> {
    this.metrics.taskReflections++;

    const historicalTaskFailures = this.queryHistoricalTaskFailures(
      input.userInput
    );

    const prompt = this.buildTaskReflectPrompt(input, historicalTaskFailures);

    try {
      const response = await this.llm.chat(prompt);
      const parsed = this.parseJsonResponse(response);

      if (parsed && parsed.taskDiagnosis) {
        this.metrics.taskReflectionSuccesses++;
        const result: TaskReflectionResult = {
          taskDiagnosis: this.getString(parsed, 'taskDiagnosis', '诊断'),
          rootCause: this.getString(parsed, 'rootCause', '未知根因'),
          strategyAdjustment: this.getString(
            parsed,
            'strategyAdjustment',
            '调整策略'
          ),
          correctedPlan: this.getCorrectedPlan(parsed),
          lessonsLearned: this.getString(parsed, 'lessonsLearned', ''),
          confidence: this.getNumber(parsed, 'confidence', 0.5),
        };

        this.recordTaskReflectionExperience(input, result, true);
        return result;
      }

      return this.fallbackTaskReflect(input);
    } catch (err) {
      Logger.warn(
        `reflectOnTaskFailure LLM 调用失败，安全降级: ${(err as Error).message}`,
        'ReflectionEngine'
      );
      return this.fallbackTaskReflect(input);
    }
  }

  /**
   * 记录经验（工具级）
   */
  recordExperience(entry: ExperienceEntry): void {
    const timestamp = Date.now();
    const record: ExperienceEntry = {
      ...entry,
      timestamp,
    };

    this.experienceBuffer.push(record);
    if (this.experienceBuffer.length > this.options.maxExperienceRecords) {
      this.experienceBuffer.shift();
    }

    if (this.trajectoryDb) {
      try {
        this.trajectoryDb.recordExecution({
          id: `reflection-${record.toolName}-${timestamp}`,
          input: JSON.stringify(record.args),
          intent: `reflection:${record.toolName}`,
          status: record.success ? 'success' : 'failed',
          quality_overall: record.success ? 1.0 : 0.0,
          loop_rounds: 0,
          total_tool_calls: 1,
          total_duration: 0,
          created_at: timestamp,
          updated_at: timestamp,
        });
      } catch (err) {
        Logger.warn(
          `recordExperience 持久化失败: ${(err as Error).message}`,
          'ReflectionEngine'
        );
      }
    }
  }

  /**
   * 获取相关经验（工具级）
   */
  getRelevantExperiences(
    toolName: string,
    error?: string,
    limit?: number
  ): ExperienceEntry[] {
    const max = limit ?? 5;
    const errorCategory = error ? this.categorizeError(error) : undefined;

    const scored = this.experienceBuffer
      .filter((e) => e.toolName === toolName)
      .map((e) => {
        let score = 1;
        if (error && e.error === error) {
          score += 3;
        } else if (
          errorCategory &&
          this.categorizeError(e.error) === errorCategory
        ) {
          score += 2;
        }
        if (e.timestamp) {
          const ageDays = (Date.now() - e.timestamp) / (1000 * 60 * 60 * 24);
          score += Math.max(0, 1 - ageDays / 30);
        }
        return { entry: e, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => s.entry);

    return scored;
  }

  /**
   * 获取任务级反思经验
   */
  getTaskReflectionExperiences(): TaskReflectionExperience[] {
    return [...this.taskReflectionBuffer];
  }

  /**
   * 获取反思效果度量（P2-7）
   */
  getReflectionMetrics(): ReflectionMetrics {
    const retrySuccessRate =
      this.experienceBuffer.length > 0
        ? this.experienceBuffer.filter((e) => e.success).length /
          this.experienceBuffer.length
        : 0;

    const deepReflectionSuccessRate =
      this.metrics.deepReflections > 0
        ? this.metrics.deepReflectionSuccesses / this.metrics.deepReflections
        : 0;

    const experienceReuseRate =
      this.metrics.totalReflections > 0
        ? this.metrics.experienceReuses / this.metrics.totalReflections
        : 0;

    const taskReflectionSuccessRate =
      this.metrics.taskReflections > 0
        ? this.metrics.taskReflectionSuccesses / this.metrics.taskReflections
        : 0;

    return {
      totalReflections: this.metrics.totalReflections,
      retrySuccessRate,
      deepReflectionSuccessRate,
      experienceReuseRate,
      experienceRecordCount: this.experienceBuffer.length,
      taskReflections: this.metrics.taskReflections,
      taskReflectionSuccessRate,
    };
  }

  private buildReflectPrompt(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    context: { traceId: string; loopCount: number },
    similarExperiences: ExperienceEntry[],
    historicalFailures: Array<{ input: string; status: string }>
  ): string {
    let prompt = `你是反思引擎。工具执行失败，请分析根因并给出修正建议。

工具: ${toolName}
参数: ${JSON.stringify(args)}
错误: ${error}
上下文: traceId=${context.traceId}, loopCount=${context.loopCount}
`;

    if (similarExperiences.length > 0) {
      prompt += `\n历史相似经验:\n`;
      for (const exp of similarExperiences) {
        prompt += `- 工具=${exp.toolName}, 错误=${exp.error}, 根因=${exp.rootCause}, 解决=${exp.resolution}\n`;
      }
    }

    if (historicalFailures.length > 0) {
      prompt += `\n历史失败经验:\n`;
      for (const fail of historicalFailures) {
        prompt += `- ${fail.input} (状态: ${fail.status})\n`;
      }
    }

    prompt += `
请返回 JSON:
{
  "rootCause": "根因分析",
  "correctedArgs": {} 或 null,
  "alternativeTool": "替代工具名" 或 null,
  "shouldRetry": true/false
}`;
    return prompt;
  }

  private buildDeepReflectPrompt(
    userInput: string,
    trajectory: Array<{
      toolName: string;
      success: boolean;
      error?: string;
      output?: string;
    }>,
    evalResult: {
      goalProgress: number;
      suggestedAction: string;
      reason: string;
    }
  ): string {
    let prompt = `你是深度反思引擎。任务执行后进展不足，请分析整条轨迹并给出修正计划。

用户目标: ${userInput}
目标进度: ${evalResult.goalProgress}
建议动作: ${evalResult.suggestedAction}
原因: ${evalResult.reason}

执行轨迹:`;
    for (const step of trajectory) {
      prompt += `\n- 工具=${step.toolName}, 成功=${step.success}`;
      if (step.error) prompt += `, 错误=${step.error}`;
      if (step.output) prompt += `, 输出=${step.output.substring(0, 100)}`;
    }

    prompt += `

请返回 JSON:
{
  "diagnosis": "诊断",
  "rootCause": "根因",
  "fixStrategy": "修复策略",
  "correctedPlan": [{"stepDescription":"步骤","toolName":"工具","args":{}}]
}`;
    return prompt;
  }

  private buildTaskReflectPrompt(
    input: TaskReflectionInput,
    historicalTaskFailures: Array<{ input: string; status: string }>
  ): string {
    let prompt = `你是任务级反思引擎。整个任务执行失败，请进行全局诊断。

用户输入: ${input.userInput}
任务目标: ${input.taskGoal}
目标进度: ${input.goalProgress}
已用轮次: ${input.roundsUsed}

执行轨迹:`;
    for (const step of input.executionTrace) {
      prompt += `\n- 工具=${step.toolName}, 成功=${step.success}`;
      if (step.error) prompt += `, 错误=${step.error}`;
    }

    prompt += `\n\n失败点:`;
    for (const fail of input.failures) {
      prompt += `\n- 工具=${fail.toolName}, 错误=${fail.error}, 步骤=${fail.stepDescription}`;
    }

    if (historicalTaskFailures.length > 0) {
      prompt += `\n\n历史任务失败经验:\n`;
      for (const fail of historicalTaskFailures) {
        prompt += `- ${fail.input} (状态: ${fail.status})\n`;
      }
    }

    prompt += `

请返回 JSON:
{
  "taskDiagnosis": "任务诊断",
  "rootCause": "根因",
  "strategyAdjustment": "策略调整",
  "correctedPlan": [{"stepDescription":"步骤","toolName":"工具","args":{}}],
  "lessonsLearned": "经验教训",
  "confidence": 0.0-1.0
}`;
    return prompt;
  }

  private fallbackReflect(
    toolName: string,
    args: Record<string, unknown>,
    error: string
  ): ReflectionResult {
    const category = this.categorizeError(error);
    let rootCause = `${toolName} 执行失败`;
    let shouldRetry = true;

    switch (category) {
      case 'not_found':
        rootCause = `${toolName}: 资源不存在`;
        shouldRetry = false;
        break;
      case 'permission':
        rootCause = `${toolName}: 权限不足`;
        shouldRetry = false;
        break;
      case 'timeout':
      case 'network':
        rootCause = `${toolName}: 网络/超时错误，可重试`;
        shouldRetry = true;
        break;
      case 'empty':
        rootCause = `${toolName}: 参数为空`;
        shouldRetry = false;
        break;
    }

    return {
      rootCause,
      correctedArgs: null,
      alternativeTool: null,
      shouldRetry,
    };
  }

  private fallbackDeepReflect(
    userInput: string,
    trajectory: Array<{ toolName: string; success: boolean; error?: string }>,
    _evalResult: { goalProgress: number; reason: string }
  ): DeepReflectionResult {
    const failedSteps = trajectory.filter((s) => !s.success);
    const diagnosis = '深度反思失败，使用规则化分析';
    const rootCause =
      failedSteps.length > 0
        ? `步骤 ${failedSteps[0].toolName} 失败: ${failedSteps[0].error ?? '未知'}`
        : '目标进度不足，可能规划方向偏差';
    return {
      diagnosis,
      rootCause,
      fixStrategy: '重新规划执行路径',
    };
  }

  private fallbackTaskReflect(
    input: TaskReflectionInput
  ): TaskReflectionResult {
    const diagnosis = 'LLM 不可用，降级为规则化分析';
    const rootCause =
      input.failures.length > 0
        ? `主要失败: ${input.failures[0].toolName} - ${input.failures[0].error}`
        : '目标进度不足';
    const result: TaskReflectionResult = {
      taskDiagnosis: diagnosis,
      rootCause,
      strategyAdjustment: '重新分析用户意图并调整执行策略',
      lessonsLearned: '',
      confidence: 0.3,
    };
    this.recordTaskReflectionExperience(input, result, false);
    return result;
  }

  private recordTaskReflectionExperience(
    input: TaskReflectionInput,
    result: TaskReflectionResult,
    success: boolean
  ): void {
    const entry: TaskReflectionExperience = {
      userInput: input.userInput,
      taskGoal: input.taskGoal,
      taskDiagnosis: result.taskDiagnosis,
      rootCause: result.rootCause,
      strategyAdjustment: result.strategyAdjustment,
      lessonsLearned: result.lessonsLearned,
      confidence: result.confidence,
      success,
      timestamp: Date.now(),
    };

    this.taskReflectionBuffer.push(entry);
    if (this.taskReflectionBuffer.length > this.options.maxExperienceRecords) {
      this.taskReflectionBuffer.shift();
    }

    if (this.trajectoryDb) {
      try {
        this.trajectoryDb.recordExecution({
          id: `task-reflection-${entry.timestamp}`,
          input: input.userInput,
          intent: 'task_reflection',
          status: success ? 'success' : 'failed',
          quality_overall: result.confidence,
          loop_rounds: input.roundsUsed,
          total_tool_calls: input.executionTrace.length,
          total_duration: 0,
          created_at: entry.timestamp,
          updated_at: entry.timestamp,
        });
      } catch (err) {
        Logger.warn(
          `recordTaskReflectionExperience 持久化失败: ${(err as Error).message}`,
          'ReflectionEngine'
        );
      }
    }
  }

  private queryHistoricalFailures(
    toolName: string,
    error: string
  ): Array<{ input: string; status: string }> {
    if (!this.trajectoryDb) return [];
    try {
      const results = this.trajectoryDb.querySimilarTasks(
        `${toolName} ${error}`,
        { includeFailed: true, maxResults: 3 }
      );
      return results.map((r) => ({
        input: r.execution.input,
        status: r.execution.status,
      }));
    } catch {
      return [];
    }
  }

  private queryHistoricalTaskFailures(
    userInput: string
  ): Array<{ input: string; status: string }> {
    if (!this.trajectoryDb) return [];
    try {
      const results = this.trajectoryDb.querySimilarTasks(userInput, {
        includeFailed: true,
        maxResults: 3,
      });
      return results.map((r) => ({
        input: r.execution.input,
        status: r.execution.status,
      }));
    } catch {
      return [];
    }
  }

  private categorizeError(error: string): string | undefined {
    for (const { pattern, category } of ERROR_CATEGORIES) {
      if (pattern.test(error)) return category;
    }
    return undefined;
  }

  private parseJsonResponse(response: string): Record<string, unknown> | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private getString(
    parsed: Record<string, unknown>,
    key: string,
    fallback: string
  ): string {
    const val = parsed[key];
    return typeof val === 'string' ? val : fallback;
  }

  private getNumber(
    parsed: Record<string, unknown>,
    key: string,
    fallback: number
  ): number {
    const val = parsed[key];
    return typeof val === 'number' ? val : fallback;
  }

  private getBoolean(
    parsed: Record<string, unknown>,
    key: string,
    fallback: boolean
  ): boolean {
    const val = parsed[key];
    return typeof val === 'boolean' ? val : fallback;
  }

  private getCorrectedArgs(
    parsed: Record<string, unknown>
  ): Record<string, unknown> | null {
    const val = parsed.correctedArgs;
    if (val === null || val === undefined) return null;
    if (typeof val === 'object' && !Array.isArray(val))
      return val as Record<string, unknown>;
    return null;
  }

  private getCorrectedPlan(parsed: Record<string, unknown>):
    | Array<{
        stepDescription: string;
        toolName?: string;
        args?: Record<string, unknown>;
      }>
    | undefined {
    const val = parsed.correctedPlan;
    if (!Array.isArray(val)) return undefined;
    return val.map((item) => {
      const obj = item as Record<string, unknown>;
      return {
        stepDescription:
          typeof obj.stepDescription === 'string' ? obj.stepDescription : '',
        toolName: typeof obj.toolName === 'string' ? obj.toolName : undefined,
        args:
          typeof obj.args === 'object' &&
          obj.args !== null &&
          !Array.isArray(obj.args)
            ? (obj.args as Record<string, unknown>)
            : undefined,
      };
    });
  }
}
