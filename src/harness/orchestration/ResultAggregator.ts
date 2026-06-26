/**
 * Harness Phase 10: 多Agent编排 — 结果聚合器
 *
 * 合并多个Agent的执行结果，生成结构化摘要报告。
 * 提供成功/失败统计、执行时长、详细追踪等维度。
 * P10增强：LLM摘要生成、冲突检测
 */

import { Logger } from '../../utils/Logger';
import type { TaskNode } from './TaskDispatcher';

/** 单个任务详情 */
export interface TaskDetail {
  /** 任务ID */
  taskId: string;
  /** 完成状态 */
  status: 'completed' | 'failed';
  /** 执行结果 */
  result?: unknown;
  /** 错误信息 */
  error?: string;
}

/** 结果冲突 */
export interface ResultConflict {
  /** 冲突类型 */
  type:
    | 'file_write'
    | 'data_inconsistency'
    | 'resource_contention'
    | 'goal_overlap';
  /** 冲突描述 */
  description: string;
  /** 涉及的任务ID */
  involvedTasks: string[];
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high';
}

/** 聚合结果 */
export interface AggregatedResult {
  /** 整体是否成功（全部任务成功） */
  success: boolean;
  /** 摘要文本 */
  summary: string;
  /** 详细结果映射 (taskId → TaskDetail) */
  details: Map<string, TaskDetail>;
  /** 总任务数 */
  totalTasks: number;
  /** 成功任务数 */
  completedTasks: number;
  /** 失败任务数 */
  failedTasks: number;
  /** 执行总时长 (ms) */
  duration: number;
  /** 五维质量评分（自动评估生成） */
  qualityScore?: import('../evaluation/QualityScorer').QualityScore;
  /** P10: 检测到的冲突 */
  conflicts?: ResultConflict[];
  /** P10: LLM生成的自然语言摘要 */
  llmSummary?: string;
}

export class ResultAggregator {
  private llm?: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };

  constructor(llm?: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  }) {
    this.llm = llm;
  }

  /**
   * 聚合所有Agent的执行结果
   */
  aggregate(
    agentResults: Map<string, unknown>,
    taskNodes: TaskNode[]
  ): AggregatedResult {
    const startTime = Date.now();
    const details = new Map<string, TaskDetail>();

    let completedCount = 0;
    let failedCount = 0;
    const failedTasks: string[] = [];

    const taskMap = new Map<string, TaskNode>();
    for (const task of taskNodes) {
      taskMap.set(task.id, task);
    }

    for (const task of taskNodes) {
      const detail: TaskDetail = {
        taskId: task.id,
        status: 'failed',
      };

      if (task.status === 'completed' && agentResults.has(task.id)) {
        detail.status = 'completed';
        detail.result = agentResults.get(task.id);
        completedCount++;
      } else if (task.status === 'failed') {
        detail.status = 'failed';
        detail.error = task.error || '未知错误';
        failedCount++;
        failedTasks.push(task.id);
      } else {
        detail.status = 'failed';
        detail.error = `任务未完成 (状态: ${task.status})`;
        failedCount++;
        failedTasks.push(task.id);
      }

      details.set(task.id, detail);
    }

    const success = failedCount === 0;
    const duration = Date.now() - startTime;

    const conflicts = this.detectConflicts(agentResults, taskNodes);

    const summary = this.buildSummary(
      success,
      taskNodes.length,
      completedCount,
      failedCount,
      failedTasks,
      duration
    );

    Logger.info(
      `📊 结果聚合: ${completedCount}/${taskNodes.length} 成功 | 耗时 ${duration}ms | 冲突 ${conflicts.length}`,
      'ResultAggregator'
    );

    return {
      success,
      summary,
      details,
      totalTasks: taskNodes.length,
      completedTasks: completedCount,
      failedTasks: failedCount,
      duration,
      conflicts,
    };
  }

  /**
   * 聚合并生成LLM自然语言摘要
   */
  async aggregateWithSummary(
    agentResults: Map<string, unknown>,
    taskNodes: TaskNode[]
  ): Promise<AggregatedResult> {
    const result = this.aggregate(agentResults, taskNodes);

    if (this.llm && result.totalTasks > 0) {
      try {
        const taskSummaries = taskNodes
          .map(
            (t) => `- ${t.id}: ${t.status} | 目标: ${t.goal.substring(0, 80)}`
          )
          .join('\n');

        const prompt = `请用简洁的中文总结以下多Agent编排执行结果：

总任务数: ${result.totalTasks}
成功: ${result.completedTasks}
失败: ${result.failedTasks}
冲突: ${result.conflicts?.length || 0}

任务详情:
${taskSummaries}

请生成一段100字以内的执行摘要。`;

        result.llmSummary = await this.llm.chat(prompt);
      } catch (err) {
        Logger.debug(
          `LLM摘要生成失败: ${(err as Error).message}`,
          'ResultAggregator'
        );
      }
    }

    return result;
  }

  /**
   * 检测不同Agent结果之间的冲突
   */
  detectConflicts(
    agentResults: Map<string, unknown>,
    taskNodes: TaskNode[]
  ): ResultConflict[] {
    const conflicts: ResultConflict[] = [];

    const fileWriteMap = new Map<string, string[]>();
    const goalMap = new Map<string, string[]>();

    for (const task of taskNodes) {
      if (task.status !== 'completed') continue;
      const result = agentResults.get(task.id);
      if (!result || typeof result !== 'object') continue;

      const resultObj = result as Record<string, unknown>;
      const filePath =
        resultObj.filePath || resultObj.path || resultObj.file_path;
      if (typeof filePath === 'string') {
        if (!fileWriteMap.has(filePath)) {
          fileWriteMap.set(filePath, []);
        }
        fileWriteMap.get(filePath)!.push(task.id);
      }

      if (task.goal) {
        if (!goalMap.has(task.goal)) {
          goalMap.set(task.goal, []);
        }
        goalMap.get(task.goal)!.push(task.id);
      }
    }

    for (const [filePath, taskIds] of fileWriteMap) {
      if (taskIds.length > 1) {
        conflicts.push({
          type: 'file_write',
          description: `多个Agent写入同一文件: ${filePath}`,
          involvedTasks: taskIds,
          severity: 'high',
        });
      }
    }

    for (const [goal, taskIds] of goalMap) {
      if (taskIds.length > 1) {
        conflicts.push({
          type: 'goal_overlap',
          description: `多个Agent执行相同目标: ${goal}`,
          involvedTasks: taskIds,
          severity: 'medium',
        });
      }
    }

    return conflicts;
  }

  /**
   * 使用 LLM 仲裁解决结果冲突
   * @param conflicts - 待解决的冲突列表
   * @param llm - LLM 接口
   * @returns 仲裁结果列表
   */
  async resolveConflictsWithLLM(
    conflicts: ResultConflict[],
    llm: { chat(prompt: string, systemPrompt?: string): Promise<string> }
  ): Promise<
    Array<{
      conflict: ResultConflict;
      winnerTaskId: string;
      resolution: string;
    }>
  > {
    const resolutions: Array<{
      conflict: ResultConflict;
      winnerTaskId: string;
      resolution: string;
    }> = [];

    for (const conflict of conflicts) {
      const prompt = `请仲裁以下任务结果冲突，选择最佳结果：

冲突类型: ${conflict.type}
冲突描述: ${conflict.description}
涉及任务: ${conflict.involvedTasks.join(', ')}

请以 JSON 格式返回仲裁结果，包含 winnerTaskId（获胜任务ID）和 reasoning（仲裁理由）。`;

      try {
        const response = await llm.chat(prompt);
        const parsed = JSON.parse(response);
        resolutions.push({
          conflict,
          winnerTaskId: parsed.winnerTaskId,
          resolution: `${parsed.winnerTaskId}: ${parsed.reasoning || ''}`,
        });
      } catch (err) {
        Logger.warn(
          `LLM 仲裁失败: ${(err as Error).message}`,
          'ResultAggregator'
        );
        resolutions.push({
          conflict,
          winnerTaskId: conflict.involvedTasks[0],
          resolution: `默认选择第一个任务: ${conflict.involvedTasks[0]}`,
        });
      }
    }

    return resolutions;
  }

  /**
   * 置信度加权合并 — 选择最高置信度的结果
   * @param results - 带置信度的结果列表
   * @returns 合并后的共识结果
   */
  mergeWithConsensus(
    results: Array<{
      taskId: string;
      result: unknown;
      confidence: number;
      agentId: string;
    }>
  ): {
    selectedTaskId: string;
    result: unknown;
    averageConfidence: number;
    selectedAgentId: string;
  } {
    if (results.length === 0) {
      return {
        selectedTaskId: '',
        result: null,
        averageConfidence: 0,
        selectedAgentId: '',
      };
    }

    const sorted = [...results].sort((a, b) => b.confidence - a.confidence);
    const winner = sorted[0];
    const avgConfidence =
      results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

    return {
      selectedTaskId: winner.taskId,
      result: winner.result,
      averageConfidence: avgConfidence,
      selectedAgentId: winner.agentId,
    };
  }

  /**
   * 构建可读的摘要文本
   */
  private buildSummary(
    success: boolean,
    total: number,
    completed: number,
    failed: number,
    failedTaskIds: string[],
    duration: number
  ): string {
    const lines: string[] = [];
    const statusEmoji = success ? '✅' : '⚠️';
    const statusText = success ? '全部任务执行成功' : '部分任务执行失败';

    lines.push(`${statusEmoji} 多Agent编排: ${statusText}`);
    lines.push(`   总任务数: ${total}`);
    lines.push(`   成功: ${completed}`);
    lines.push(`   失败: ${failed}`);
    lines.push(`   总耗时: ${duration}ms`);

    if (!success && failedTaskIds.length > 0) {
      lines.push(`   失败任务: ${failedTaskIds.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * 快速检查结果是否全部成功
   */
  static isAllSuccessful(result: AggregatedResult): boolean {
    return result.success;
  }

  /**
   * 提取所有失败任务的详细信息
   */
  static getFailedDetails(result: AggregatedResult): TaskDetail[] {
    const failed: TaskDetail[] = [];
    for (const detail of result.details.values()) {
      if (detail.status === 'failed') {
        failed.push(detail);
      }
    }
    return failed;
  }
}
