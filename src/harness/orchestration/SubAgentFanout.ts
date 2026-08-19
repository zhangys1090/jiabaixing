/**
 * Harness Phase 10: 多Agent编排 — Sub-Agent 扇出机制
 *
 * 管理子 Agent 的扇出执行：
 * - parallel: 所有子任务并行执行（无依赖时）
 * - sequential: 顺序执行（有依赖时）
 * - adaptive: 根据 TaskComplexityAnalyzer 自动选择
 *
 * 每个 Sub-Agent 拥有独立的上下文窗口，确保上下文隔离。
 */

import { randomUUID } from 'crypto';
import { Logger } from '../../utils/Logger';
import type { TaskNode, TaskExecutor } from './TaskDispatcher';
import { AgentRegistry } from './AgentRegistry';

/** 扇出策略 */
export type FanoutStrategy = 'parallel' | 'sequential' | 'adaptive';

/** 扇出配置 */
export interface FanoutConfig {
  /** 最大扇出数，默认5 */
  maxFanout: number;
  /** 执行策略，默认 adaptive */
  strategy: FanoutStrategy;
  /** 单个子任务超时 (ms)，默认30000 */
  taskTimeoutMs: number;
  /** 部分失败时是否继续，默认 true */
  continueOnPartialFailure: boolean;
}

const DEFAULT_FANOUT_CONFIG: FanoutConfig = {
  maxFanout: 5,
  strategy: 'adaptive',
  taskTimeoutMs: 30000,
  continueOnPartialFailure: true,
};

/**
 * W7：感知型子 Agent 预设（对齐 Python PERCEPTION_AGENT_TEMPLATES）。
 * 把五感能力下沉到专职子 Agent，声明其消费的模态与工具集。
 */
export interface PerceptionAgentTemplate {
  kind: string;
  description: string;
  modalities: string[];
  tools: string[];
  useSharedFusion: boolean;
}

export const PERCEPTION_AGENT_TEMPLATES: Record<string, PerceptionAgentTemplate> = {
  visual_operator: {
    kind: 'visual_operator',
    description: '视觉操作型子 Agent：结合视觉定位与 UI 自动化执行界面操作。',
    modalities: ['visual', 'uia', 'ocr'],
    tools: ['visual_grounding', 'uia', 'ocr', 'screen_capture'],
    useSharedFusion: true,
  },
  desktop_automation: {
    kind: 'desktop_automation',
    description: '桌面自动化型子 Agent：调度桌面自动化完成点击/输入/拖拽等动作。',
    modalities: ['uia', 'visual', 'proprioception'],
    tools: ['nut', 'playwright', 'uia', 'action_verifier'],
    useSharedFusion: true,
  },
  device_control: {
    kind: 'device_control',
    description: '设备控制型子 Agent：读取真实设备网关状态并下发控制指令。',
    modalities: ['environment', 'proprioception'],
    tools: ['device_manager', 'device_gateway', 'action_verifier'],
    useSharedFusion: true,
  },
};

/** 扇出可选参数（W7/W8：traceId 贯通 + 感知模板） */
export interface FanoutOptions {
  /** 贯通用链路ID；缺省自动生成并向下透传至每个子结果（W8） */
  traceId?: string;
  /** 感知型子 Agent 模板类型（W7），注入 task.perceptionTemplate */
  perceptionTemplate?: string;
}

/** 子任务执行结果 */
export interface SubTaskResult {
  /** 子任务ID */
  taskId: string;
  /** 是否成功 */
  success: boolean;
  /** 执行结果 */
  result?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时 (ms) */
  duration: number;
  /** 执行Agent ID */
  agentId?: string;
  /** 贯通用链路ID（W8） */
  traceId: string;
}

/** 扇出执行结果 */
export interface FanoutResult {
  /** 父任务ID */
  parentTaskId: string;
  /** 使用的策略 */
  strategy: FanoutStrategy;
  /** 所有子任务结果 */
  subResults: SubTaskResult[];
  /** 成功数 */
  successCount: number;
  /** 失败数 */
  failedCount: number;
  /** 总耗时 (ms) */
  totalDuration: number;
  /** 是否全部成功 */
  allSucceeded: boolean;
  /** 贯通用链路ID（W8） */
  traceId: string;
}

export class SubAgentFanout {
  private registry: AgentRegistry;
  private executor: TaskExecutor | null;
  private config: FanoutConfig;

  constructor(
    registry: AgentRegistry,
    executor?: TaskExecutor,
    config?: Partial<FanoutConfig>
  ) {
    this.registry = registry;
    this.executor = executor || null;
    this.config = { ...DEFAULT_FANOUT_CONFIG, ...config };
  }

  /**
   * 扇出执行子任务
   * @param parentTaskId - 父任务ID
   * @param subTasks - 子任务节点列表
   * @param configOverride - 可选的配置覆盖
   * @param options - W7/W8：traceId 贯通与感知模板
   * @returns 扇出执行结果
   */
  async fanout(
    parentTaskId: string,
    subTasks: TaskNode[],
    configOverride?: Partial<FanoutConfig>,
    options?: FanoutOptions
  ): Promise<FanoutResult> {
    const runConfig = { ...this.config, ...configOverride };
    const traceId = options?.traceId || randomUUID();
    const startTime = Date.now();

    const limitedTasks = subTasks.slice(0, runConfig.maxFanout);
    if (subTasks.length > runConfig.maxFanout) {
      Logger.warn(
        `⚠️ 子任务数 ${subTasks.length} 超过扇出限制 ${runConfig.maxFanout}，截断执行`,
        'SubAgentFanout'
      );
    }

    // W7：把感知模板透传到每个子任务的元数据，供执行器注入感知上下文
    if (options?.perceptionTemplate) {
      for (const t of limitedTasks) {
        t.metadata = { ...(t.metadata ?? {}), perceptionTemplate: options.perceptionTemplate };
      }
    }

    const strategy = this.resolveStrategy(limitedTasks, runConfig.strategy);
    Logger.info(
      `🔀 Sub-Agent 扇出: ${parentTaskId} | 策略=${strategy} | 子任务=${limitedTasks.length} | traceId=${traceId}`,
      'SubAgentFanout'
    );

    let subResults: SubTaskResult[];

    switch (strategy) {
      case 'parallel':
        subResults = await this.executeParallel(
          parentTaskId,
          limitedTasks,
          runConfig,
          traceId
        );
        break;
      case 'sequential':
        subResults = await this.executeSequential(
          parentTaskId,
          limitedTasks,
          runConfig,
          traceId
        );
        break;
      case 'adaptive':
      default:
        if (this.hasDependencies(limitedTasks)) {
          subResults = await this.executeSequential(
            parentTaskId,
            limitedTasks,
            runConfig,
            traceId
          );
        } else {
          subResults = await this.executeParallel(
            parentTaskId,
            limitedTasks,
            runConfig,
            traceId
          );
        }
        break;
    }

    const totalDuration = Date.now() - startTime;
    const successCount = subResults.filter((r) => r.success).length;
    const failedCount = subResults.filter((r) => !r.success).length;

    Logger.info(
      `🏁 Sub-Agent 扇出完成: ${parentTaskId} | 成功=${successCount} 失败=${failedCount} | 耗时=${totalDuration}ms | traceId=${traceId}`,
      'SubAgentFanout'
    );

    return {
      parentTaskId,
      strategy,
      subResults,
      successCount,
      failedCount,
      totalDuration,
      allSucceeded: failedCount === 0,
      traceId,
    };
  }

  /**
   * 并行执行所有子任务
   */
  private async executeParallel(
    parentTaskId: string,
    tasks: TaskNode[],
    config: FanoutConfig,
    traceId: string
  ): Promise<SubTaskResult[]> {
    const promises = tasks.map((task) =>
      this.executeSubTask(parentTaskId, task, config, traceId)
    );

    const settled = await Promise.allSettled(promises);

    return settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        taskId: tasks[index].id,
        success: false,
        error: result.reason?.message || String(result.reason),
        duration: 0,
        traceId,
      };
    });
  }

  /**
   * 顺序执行所有子任务
   */
  private async executeSequential(
    parentTaskId: string,
    tasks: TaskNode[],
    config: FanoutConfig,
    traceId: string
  ): Promise<SubTaskResult[]> {
    const results: SubTaskResult[] = [];

    for (const task of tasks) {
      try {
        const result = await this.executeSubTask(parentTaskId, task, config, traceId);
        results.push(result);

        if (!result.success && !config.continueOnPartialFailure) {
          for (const remaining of tasks.slice(results.length)) {
            results.push({
              taskId: remaining.id,
              success: false,
              error: '前置任务失败，跳过执行',
              duration: 0,
              traceId,
            });
          }
          break;
        }
      } catch (err) {
        results.push({
          taskId: task.id,
          success: false,
          error: (err as Error).message,
          duration: 0,
          traceId,
        });

        if (!config.continueOnPartialFailure) {
          for (const remaining of tasks.slice(results.length)) {
            results.push({
              taskId: remaining.id,
              success: false,
              error: '前置任务失败，跳过执行',
              duration: 0,
              traceId,
            });
          }
          break;
        }
      }
    }

    return results;
  }

  /**
   * 执行单个子任务
   */
  private async executeSubTask(
    parentTaskId: string,
    task: TaskNode,
    config: FanoutConfig,
    traceId: string
  ): Promise<SubTaskResult> {
    const startTime = Date.now();

    // P0-4: 优先使用动态角色分配指定的 Agent
    let agent = task.assignedTo
      ? this.registry.getAgent(task.assignedTo)
      : undefined;
    if (!agent) {
      agent =
        this.registry.findBestAgent((task.tools && task.tools[0]) || '') ||
        this.registry.findAgentByCapability((task.tools && task.tools[0]) || '');
    }

    if (!agent) {
      return {
        taskId: task.id,
        success: false,
        error: `无可用的 Agent 执行子任务: ${task.id}`,
        duration: Date.now() - startTime,
        traceId,
      };
    }

    this.registry.updateStatus(agent.id, 'busy');

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`子任务超时 (${config.taskTimeoutMs}ms)`)),
          config.taskTimeoutMs
        );
      });

      // W8：把 traceId 注入任务元数据，向下游执行器/Python 核心透传
      const taskWithTrace: TaskNode = {
        ...task,
        metadata: { ...(task.metadata ?? {}), traceId },
      };

      const result = this.executor
        ? await Promise.race([this.executor(taskWithTrace), timeoutPromise])
        : await Promise.race([
            Promise.resolve({
              taskId: task.id,
              goal: task.goal,
              completedAt: Date.now(),
            }),
            timeoutPromise,
          ]);

      const duration = Date.now() - startTime;
      this.registry.recordExecution(agent.id, true, duration);

      task.status = 'completed';
      task.result = result;
      task.assignedTo = agent.id;

      return {
        taskId: task.id,
        success: true,
        result,
        duration,
        agentId: agent.id,
        traceId,
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      this.registry.recordExecution(agent.id, false, duration);

      task.status = 'failed';
      task.error = (err as Error).message;

      return {
        taskId: task.id,
        success: false,
        error: (err as Error).message,
        duration,
        agentId: agent.id,
        traceId,
      };
    } finally {
      this.registry.updateStatus(agent.id, 'idle');
    }
  }

  /**
   * 解析执行策略
   */
  private resolveStrategy(
    tasks: TaskNode[],
    configured: FanoutStrategy
  ): FanoutStrategy {
    if (configured !== 'adaptive') return configured;
    return this.hasDependencies(tasks) ? 'sequential' : 'parallel';
  }

  /**
   * 检查任务间是否有依赖关系
   */
  private hasDependencies(tasks: TaskNode[]): boolean {
    return tasks.some((t) => t.dependencies.length > 0);
  }
}
