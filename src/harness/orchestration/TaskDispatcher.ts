/**
 * Harness Phase 10: 多Agent编排 — DAG任务分发引擎
 *
 * 基于DAG依赖关系的智能任务调度：
 * - 拓扑排序分层，无依赖的并行执行
 * - 通过AgentRegistry自动分配Agent
 * - 支持优先级调度
 * - 完整的错误处理和状态追踪
 * P10增强：超时控制、自动重试、任务取消、并发限制
 */

import { Logger } from '../../utils/Logger';
import { AgentRegistry } from './AgentRegistry';

/** 任务节点 */
export interface TaskNode {
  /** 任务唯一标识 */
  id: string;
  /** 指定的Agent ID（可选，不指定则自动分配） */
  agentId?: string;
  /** 任务目标 */
  goal: string;
  /** 上下文信息 */
  context: string;
  /** 依赖的task id列表 */
  dependencies: string[];
  /** 优先级 1-10，越高越优先 */
  priority: number;
  /** 所需工具列表 */
  tools?: string[];
  /** 当前状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** 执行结果 */
  result?: unknown;
  /** 错误信息 */
  error?: string;
  /** 分配给哪个Agent */
  assignedTo?: string;
}

/** DAG分层结果 */
interface DAGLayer {
  layer: number;
  tasks: TaskNode[];
}

/** 任务执行器 — 实际执行单个任务的回调 */
export type TaskExecutor = (task: TaskNode) => Promise<unknown>;

/** 任务分发器配置 */
export interface TaskDispatcherConfig {
  /** 单任务超时时间 (ms)，默认30000 */
  taskTimeoutMs?: number;
  /** 最大重试次数，默认2 */
  maxRetries?: number;
  /** 重试间隔 (ms)，默认1000 */
  retryDelayMs?: number;
  /** 每层最大并行任务数，默认5 */
  maxConcurrentPerLayer?: number;
}

const DEFAULT_DISPATCHER_CONFIG: Required<TaskDispatcherConfig> = {
  taskTimeoutMs: 30000,
  maxRetries: 2,
  retryDelayMs: 1000,
  maxConcurrentPerLayer: 5,
};

export class TaskDispatcher {
  private registry: AgentRegistry;
  private executor: TaskExecutor | null;
  private config: Required<TaskDispatcherConfig>;
  private activeControllers: Map<string, AbortController> = new Map();

  constructor(
    registry: AgentRegistry,
    executor?: TaskExecutor,
    config?: TaskDispatcherConfig
  ) {
    this.registry = registry;
    this.executor = executor || null;
    this.config = { ...DEFAULT_DISPATCHER_CONFIG, ...config };
  }

  /**
   * 分发所有任务，按DAG依赖关系执行
   * @param tasks - 任务节点列表
   * @param config - 可选的运行时配置覆盖
   * @returns 所有任务的结果映射 (taskId → result)
   */
  async dispatch(
    tasks: TaskNode[],
    config?: TaskDispatcherConfig
  ): Promise<Map<string, unknown>> {
    const runConfig = { ...this.config, ...config };
    const results = new Map<string, unknown>();
    const taskMap = new Map<string, TaskNode>();

    for (const task of tasks) {
      taskMap.set(task.id, { ...task, status: 'pending' });
    }

    this.validateDAG(tasks);

    const layers = this.buildDAG(tasks);
    Logger.info(
      `📋 DAG 分层完成: ${layers.length} 层, ${tasks.length} 个任务`,
      'TaskDispatcher'
    );

    for (const layer of layers) {
      Logger.info(
        `🏗️ 执行第 ${layer.layer + 1} 层 (${layer.tasks.length} 个任务)`,
        'TaskDispatcher'
      );

      const layerTasks = layer.tasks.slice(0, runConfig.maxConcurrentPerLayer);
      if (layer.tasks.length > runConfig.maxConcurrentPerLayer) {
        Logger.warn(
          `⚠️ 层任务数 ${layer.tasks.length} 超过并发限制 ${runConfig.maxConcurrentPerLayer}，截断执行`,
          'TaskDispatcher'
        );
      }

      const layerPromises = layerTasks.map((task) =>
        this.executeTaskWithRetry(taskMap.get(task.id)!, results, runConfig)
      );

      const layerResults = await Promise.allSettled(layerPromises);

      for (let i = 0; i < layerResults.length; i++) {
        const task = layerTasks[i];
        const settled = layerResults[i];
        const node = taskMap.get(task.id)!;

        if (settled.status === 'fulfilled') {
          results.set(task.id, settled.value);
        } else {
          node.status = 'failed';
          node.error = settled.reason?.message || String(settled.reason);
          results.set(task.id, { error: node.error });
          Logger.error(
            `❌ 任务执行失败: ${task.id} (${task.goal})`,
            settled.reason as Error,
            'TaskDispatcher'
          );
        }
      }
    }

    for (const task of tasks) {
      const updated = taskMap.get(task.id);
      if (updated) {
        task.status = updated.status;
        task.result = updated.result;
        task.error = updated.error;
        task.assignedTo = updated.assignedTo;
      }
    }

    Logger.info(
      `✅ DAG 执行完成: ${tasks.length} 个任务, ${results.size} 个结果`,
      'TaskDispatcher'
    );

    return results;
  }

  /**
   * 取消正在执行的任务
   * @param taskId - 任务ID
   */
  cancel(taskId: string): void {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(taskId);
      Logger.info(`🚫 任务已取消: ${taskId}`, 'TaskDispatcher');
    }
  }

  /**
   * 带重试的任务执行
   */
  private async executeTaskWithRetry(
    task: TaskNode,
    results: Map<string, unknown>,
    config: Required<TaskDispatcherConfig>
  ): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (task.status === 'cancelled') {
        throw new Error(`任务已取消: ${task.id}`);
      }

      try {
        return await this.executeTaskWithTimeout(task, results, config);
      } catch (err) {
        lastError = err as Error;

        if (
          this.isRetryableError(err as Error) &&
          attempt < config.maxRetries
        ) {
          Logger.info(
            `🔄 任务重试 (${attempt + 1}/${config.maxRetries}): ${task.id}`,
            'TaskDispatcher'
          );
          await this.delay(config.retryDelayMs * (attempt + 1));
        } else {
          break;
        }
      }
    }

    throw lastError || new Error(`任务执行失败: ${task.id}`);
  }

  /**
   * 带超时的任务执行
   */
  private async executeTaskWithTimeout(
    task: TaskNode,
    results: Map<string, unknown>,
    config: Required<TaskDispatcherConfig>
  ): Promise<unknown> {
    const controller = new AbortController();
    this.activeControllers.set(task.id, controller);

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`任务超时 (${config.taskTimeoutMs}ms): ${task.id}`));
      }, config.taskTimeoutMs);
      controller.signal.addEventListener('abort', () => clearTimeout(timer));
    });

    try {
      const result = await Promise.race([
        this.executeTask(task, results),
        timeoutPromise,
      ]);
      return result;
    } finally {
      this.activeControllers.delete(task.id);
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(
    task: TaskNode,
    results: Map<string, unknown>
  ): Promise<unknown> {
    task.status = 'running';

    const agent = this.assignAgent(task);
    if (!agent) {
      task.status = 'failed';
      task.error = `无可用的 Agent 执行任务: ${task.id} (需要工具: ${(task.tools || []).join(', ') || '(不限)'})`;
      throw new Error(task.error);
    }

    task.assignedTo = agent.id;
    this.registry.updateStatus(agent.id, 'busy');

    const execStart = Date.now();

    Logger.info(
      `🎯 执行任务: ${task.id} | Agent: ${agent.name} | 目标: ${task.goal.substring(0, 60)}`,
      'TaskDispatcher'
    );

    try {
      const dependencyContext = this.buildDependencyContext(task, results);

      const result = this.executor
        ? await this.executor({
            ...task,
            context: task.context
              ? `${task.context}\n依赖结果: ${JSON.stringify(dependencyContext)}`
              : `依赖结果: ${JSON.stringify(dependencyContext)}`,
          })
        : await Promise.resolve({
            taskId: task.id,
            goal: task.goal,
            context: task.context,
            dependencyContext,
            completedAt: Date.now(),
          });

      task.status = 'completed';
      task.result = result;

      const execDuration = Date.now() - execStart;
      this.registry.recordExecution(agent.id, true, execDuration);

      Logger.info(
        `✅ 任务完成: ${task.id} | Agent: ${agent.name}`,
        'TaskDispatcher'
      );

      return result;
    } catch (err) {
      task.status = 'failed';
      task.error = (err as Error).message;

      const execDuration = Date.now() - execStart;
      this.registry.recordExecution(agent.id, false, execDuration);

      throw err;
    } finally {
      this.registry.updateStatus(agent.id, 'idle');
    }
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: Error): boolean {
    const retryablePatterns = [
      'timeout',
      'ETIMEDOUT',
      'ECONNRESET',
      'rate_limit',
      '503',
      '429',
      'ECONNREFUSED',
    ];
    const msg = error.message.toLowerCase();
    return retryablePatterns.some((p) => msg.includes(p.toLowerCase()));
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 构建DAG分层（拓扑排序）
   */
  private buildDAG(tasks: TaskNode[]): DAGLayer[] {
    const taskIds = new Set(tasks.map((t) => t.id));
    const visited = new Set<string>();
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, Set<string>>();

    for (const task of tasks) {
      inDegree.set(task.id, 0);
      dependents.set(task.id, new Set());
    }

    for (const task of tasks) {
      for (const depId of task.dependencies) {
        if (!taskIds.has(depId)) {
          Logger.warn(
            `依赖任务不存在: ${depId} (来自: ${task.id})`,
            'TaskDispatcher'
          );
          continue;
        }
        inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
        const depSet = dependents.get(depId) || new Set();
        depSet.add(task.id);
        dependents.set(depId, depSet);
      }
    }

    const layers: DAGLayer[] = [];
    let layerIndex = 0;
    let remaining = tasks.length;

    const currentLayer = new Set<string>();

    for (const [taskId, degree] of inDegree) {
      if (degree === 0) {
        currentLayer.add(taskId);
      }
    }

    while (currentLayer.size > 0) {
      const layerTasks: TaskNode[] = [];
      const nextLayer = new Set<string>();

      const sorted = Array.from(currentLayer)
        .map((id) => tasks.find((t) => t.id === id)!)
        .filter(Boolean)
        .sort((a, b) => b.priority - a.priority);

      for (const task of sorted) {
        layerTasks.push(task);
        visited.add(task.id);
        remaining--;

        const deps = dependents.get(task.id) || new Set();
        for (const dependentId of deps) {
          const newDegree = (inDegree.get(dependentId) || 1) - 1;
          inDegree.set(dependentId, newDegree);
          if (newDegree === 0 && !visited.has(dependentId)) {
            nextLayer.add(dependentId);
          }
        }
      }

      layers.push({ layer: layerIndex, tasks: layerTasks });
      layerIndex++;
      currentLayer.clear();
      for (const id of nextLayer) {
        currentLayer.add(id);
      }
    }

    if (remaining > 0) {
      Logger.warn(
        `⚠️ DAG 可能存在环路: ${remaining} 个任务无法排序`,
        'TaskDispatcher'
      );
    }

    return layers;
  }

  /**
   * 验证DAG合法性
   */
  private validateDAG(tasks: TaskNode[]): void {
    const taskIds = new Set<string>();

    for (const task of tasks) {
      if (taskIds.has(task.id)) {
        throw new Error(`重复的任务ID: ${task.id}`);
      }
      taskIds.add(task.id);

      if (task.dependencies.includes(task.id)) {
        throw new Error(`任务自依赖: ${task.id}`);
      }

      if (task.priority < 1 || task.priority > 10) {
        throw new Error(`优先级超出范围 (1-10): ${task.id} → ${task.priority}`);
      }
    }
  }

  /**
   * 为任务分配Agent（使用findBestAgent优先）
   */
  private assignAgent(
    task: TaskNode
  ): import('./AgentRegistry').AgentRegistration | null {
    if (task.agentId) {
      const agent = this.registry.getAgent(task.agentId);
      if (!agent) {
        Logger.warn(`指定的 Agent 不存在: ${task.agentId}`, 'TaskDispatcher');
        return null;
      }
      if (agent.status !== 'idle') {
        Logger.warn(
          `指定的 Agent 不空闲: ${task.agentId} (${agent.status})`,
          'TaskDispatcher'
        );
        return null;
      }
      return agent;
    }

    if (task.tools && task.tools.length > 0) {
      for (const toolName of task.tools) {
        const agent =
          this.registry.findBestAgent(toolName) ||
          this.registry.findAgentByCapability(toolName);
        if (agent) return agent;
      }
      Logger.warn(
        `未找到具备任何所需工具的 Agent: ${task.tools.join(', ')}`,
        'TaskDispatcher'
      );
      return null;
    }

    const agents = this.registry.getIdleAgents();
    if (agents.length === 0) {
      Logger.warn('没有空闲的 Agent 可用', 'TaskDispatcher');
      return null;
    }

    return agents[0];
  }

  /**
   * 构建依赖上下文
   */
  private buildDependencyContext(
    task: TaskNode,
    results: Map<string, unknown>
  ): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    for (const depId of task.dependencies) {
      if (results.has(depId)) {
        context[depId] = results.get(depId);
      } else {
        Logger.warn(
          `依赖任务结果不存在: ${depId} (来自: ${task.id})`,
          'TaskDispatcher'
        );
      }
    }

    return context;
  }
}
