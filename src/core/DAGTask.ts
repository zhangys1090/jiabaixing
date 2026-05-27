/**
 * DAG任务图实现
 * 用于任务拆解、依赖管理和执行调度
 */

/**
 * 任务状态枚举
 */
export enum TaskStatus {
  PENDING = 'pending', // 待执行
  RUNNING = 'running', // 执行中
  SUCCESS = 'success', // 执行成功
  FAILED = 'failed', // 执行失败
  SKIPPED = 'skipped', // 跳过
  RETRYING = 'retrying', // 重试中
}

/**
 * 任务优先级枚举
 */
export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * 任务节点类
 */
export class TaskNode {
  public id: string; // 任务ID
  public description: string; // 任务描述
  public toolName: string; // 要调用的工具名称
  public params: Record<string, unknown>; // 工具参数
  public status: TaskStatus; // 任务状态
  public dependencies: string[]; // 依赖的任务ID列表
  public result?: unknown; // 执行结果
  public error?: Error; // 错误信息
  public startTime?: Date; // 开始执行时间
  public endTime?: Date; // 结束执行时间
  public estimatedTime: number = 0; // 预计执行时间（秒）
  public priority: TaskPriority = TaskPriority.MEDIUM; // 任务优先级
  public maxRetries: number = 3; // 最大重试次数
  public currentRetry: number = 0; // 当前重试次数
  public timeout: number = 300; // 超时时间（秒）
  public retryDelay: number = 1; // 重试延迟（秒）
  public metadata: Record<string, unknown> = {}; // 任务元数据
  public isEssential: boolean = true; // 是否为关键步骤（默认是）

  constructor(
    id: string,
    description: string,
    toolName: string,
    params: Record<string, unknown>,
    status: TaskStatus = TaskStatus.PENDING,
    dependencies: string[] = [],
    priority: TaskPriority = TaskPriority.MEDIUM
  ) {
    this.id = id;
    this.description = description;
    this.toolName = toolName;
    this.params = params;
    this.status = status;
    this.dependencies = dependencies;
    this.priority = priority;
  }

  /**
   * 获取任务执行耗时（秒）
   */
  public getDuration(): number {
    if (!this.startTime || !this.endTime) {
      return 0;
    }
    return (this.endTime.getTime() - this.startTime.getTime()) / 1000;
  }

  /**
   * 开始执行任务
   */
  public start(): void {
    this.status = TaskStatus.RUNNING;
    this.startTime = new Date();
  }

  /**
   * 任务执行成功
   */
  public succeed(result: unknown): void {
    this.status = TaskStatus.SUCCESS;
    this.result = result;
    this.endTime = new Date();
  }

  /**
   * 任务执行失败
   */
  public fail(error: Error): void {
    this.status = TaskStatus.FAILED;
    this.error = error;
    this.endTime = new Date();
  }

  /**
   * 跳过任务
   */
  public skip(): void {
    this.status = TaskStatus.SKIPPED;
    this.endTime = new Date();
  }

  /**
   * 开始重试任务
   */
  public retry(): boolean {
    if (this.currentRetry < this.maxRetries) {
      this.currentRetry++;
      this.status = TaskStatus.RETRYING;
      this.error = undefined;
      return true;
    }
    return false;
  }

  /**
   * 检查任务是否可执行（所有依赖都已完成）
   */
  public isExecutable(dependencyStatuses: Map<string, TaskStatus>): boolean {
    if (
      this.status !== TaskStatus.PENDING &&
      this.status !== TaskStatus.RETRYING
    ) {
      return false;
    }

    return this.dependencies.every((depId) => {
      const status = dependencyStatuses.get(depId);
      return status === TaskStatus.SUCCESS;
    });
  }

  /**
   * 检查任务是否可以重试
   */
  public canRetry(): boolean {
    return this.currentRetry < this.maxRetries;
  }

  /**
   * 设置任务元数据
   */
  public setMetadata(key: string, value: unknown): void {
    this.metadata[key] = value;
  }

  /**
   * 获取任务元数据
   */
  public getMetadata(key: string): unknown {
    return this.metadata[key];
  }
}

/**
 * DAG任务图类
 */
export class DAGTask {
  private name: string; // 任务图名称
  private nodes: Map<string, TaskNode> = new Map(); // 任务节点集合
  private adjacencyList: Map<string, string[]> = new Map(); // 邻接表（依赖关系）
  private eventHandlers: Map<string, ((node: TaskNode) => void)[]> = new Map(); // 事件处理器
  private maxParallelTasks: number = 4; // 最大并行任务数
  private runningTasks: Set<string> = new Set(); // 正在执行的任务

  constructor(name: string, maxParallelTasks: number = 4) {
    this.name = name;
    this.maxParallelTasks = maxParallelTasks;
  }

  /**
   * 获取任务图名称
   */
  public getName(): string {
    return this.name;
  }

  /**
   * 添加任务节点
   */
  public addNode(node: TaskNode): void {
    this.nodes.set(node.id, node);

    // 更新邻接表
    if (node.dependencies.length > 0) {
      node.dependencies.forEach((depId) => {
        if (!this.adjacencyList.has(depId)) {
          this.adjacencyList.set(depId, []);
        }
        this.adjacencyList.get(depId)?.push(node.id);
      });
    }

    // 检查是否存在循环依赖
    if (this.hasCycle()) {
      throw new Error(`检测到循环依赖！节点: ${node.id}`);
    }
  }

  /**
   * 获取任务节点
   */
  public getNode(id: string): TaskNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * 获取所有任务节点
   */
  public getAllNodes(): TaskNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * 获取任务节点数量
   */
  public getNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * 获取所有可执行的任务节点（所有依赖都已完成）
   */
  public getExecutableNodes(): TaskNode[] {
    const dependencyStatuses = new Map<string, TaskStatus>();
    this.nodes.forEach((node, id) => {
      dependencyStatuses.set(id, node.status);
    });

    return Array.from(this.nodes.values())
      .filter((node) => node.isExecutable(dependencyStatuses))
      .sort((a, b) => {
        // 按优先级排序
        const priorityOrder = {
          [TaskPriority.CRITICAL]: 0,
          [TaskPriority.HIGH]: 1,
          [TaskPriority.MEDIUM]: 2,
          [TaskPriority.LOW]: 3,
        };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  /**
   * 获取当前可以并行执行的任务节点
   */
  public getAvailableParallelNodes(): TaskNode[] {
    const executableNodes = this.getExecutableNodes();
    const availableSlots = this.maxParallelTasks - this.runningTasks.size;
    return executableNodes.slice(0, availableSlots);
  }

  /**
   * 标记任务开始执行
   */
  public markTaskRunning(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.start();
      this.runningTasks.add(nodeId);
      this.emitEvent('task_started', node);
    }
  }

  /**
   * 标记任务执行成功
   */
  public markTaskSuccess(nodeId: string, result: unknown): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.succeed(result);
      this.runningTasks.delete(nodeId);
      this.emitEvent('task_succeeded', node);
    }
  }

  /**
   * 标记任务执行失败
   */
  public markTaskFailed(nodeId: string, error: Error): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.fail(error);
      this.runningTasks.delete(nodeId);
      this.emitEvent('task_failed', node);
    }
  }

  /**
   * 标记任务跳过
   */
  public markTaskSkipped(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.skip();
      this.runningTasks.delete(nodeId);
      this.emitEvent('task_skipped', node);
    }
  }

  /**
   * 尝试重试失败的任务
   */
  public retryFailedTasks(): TaskNode[] {
    const failedNodes = Array.from(this.nodes.values()).filter(
      (node) => node.status === TaskStatus.FAILED && node.canRetry()
    );

    failedNodes.forEach((node) => {
      if (node.retry()) {
        this.emitEvent('task_retrying', node);
      }
    });

    return failedNodes.filter((node) => node.status === TaskStatus.RETRYING);
  }

  /**
   * 更新所有节点的状态
   */
  public updateNodeStatuses(): void {
    this.retryFailedTasks();
    this.checkTaskTimeouts();
    this.detectDeadlock();
  }

  /**
   * 检查任务超时
   */
  private checkTaskTimeouts(): void {
    const now = new Date();
    this.nodes.forEach((node) => {
      if (node.status === TaskStatus.RUNNING && node.startTime) {
        const duration = (now.getTime() - node.startTime.getTime()) / 1000;
        if (duration > node.timeout) {
          const timeoutError = new Error(
            `任务执行超时（超过 ${node.timeout} 秒）`
          );
          this.markTaskFailed(node.id, timeoutError);
        }
      }
    });
  }

  /**
   * 检测死锁：存在待执行节点但没有可执行节点且没有运行中节点
   * 死锁条件：有 PENDING/RETRYING 节点 + 无 RUNNING 节点 + 无可执行节点
   */
  private detectDeadlock(): void {
    const hasPending = Array.from(this.nodes.values()).some(
      (node) =>
        node.status === TaskStatus.PENDING ||
        node.status === TaskStatus.RETRYING
    );
    if (!hasPending) return;

    const hasRunning = this.runningTasks.size > 0;
    if (hasRunning) return;

    const executableNodes = this.getExecutableNodes();
    if (executableNodes.length > 0) return;

    const pendingNodes = Array.from(this.nodes.values()).filter(
      (node) =>
        node.status === TaskStatus.PENDING ||
        node.status === TaskStatus.RETRYING
    );

    const failedDeps = pendingNodes.filter((node) => {
      return node.dependencies.some((depId) => {
        const depNode = this.nodes.get(depId);
        return (
          depNode && depNode.status === TaskStatus.FAILED && !depNode.canRetry()
        );
      });
    });

    if (failedDeps.length > 0) {
      failedDeps.forEach((node) => {
        node.skip();
        this.emitEvent('task_skipped', node);
      });
      return;
    }

    const deadlockError = new Error(
      `DAG死锁检测：${pendingNodes.length}个节点等待执行但无可执行节点，依赖关系可能存在无法满足的条件`
    );
    pendingNodes.forEach((node) => {
      node.fail(deadlockError);
      this.runningTasks.delete(node.id);
      this.emitEvent('task_failed', node);
    });
  }

  /**
   * 获取任务图的预计总执行时间（秒）
   */
  public getEstimatedTime(): number {
    // 基于拓扑排序计算关键路径
    const topoOrder = this.topologicalSort();
    const earliestStart = new Map<string, number>();
    const earliestFinish = new Map<string, number>();

    topoOrder.forEach((nodeId) => {
      const node = this.nodes.get(nodeId);
      if (node) {
        let maxEST = 0;
        node.dependencies.forEach((depId) => {
          const depEFT = earliestFinish.get(depId) || 0;
          if (depEFT > maxEST) {
            maxEST = depEFT;
          }
        });
        earliestStart.set(nodeId, maxEST);
        earliestFinish.set(nodeId, maxEST + node.estimatedTime);
      }
    });

    let maxEFT = 0;
    earliestFinish.forEach((eft) => {
      if (eft > maxEFT) {
        maxEFT = eft;
      }
    });

    return maxEFT;
  }

  /**
   * 获取任务图的执行状态
   */
  public getStatus(): TaskStatus {
    const nodes = Array.from(this.nodes.values());

    // 如果DAG中没有节点，返回PENDING状态
    if (nodes.length === 0) {
      return TaskStatus.PENDING;
    }

    // 如果有任何节点执行失败且无法重试，整个任务图失败
    if (
      nodes.some(
        (node) => node.status === TaskStatus.FAILED && !node.canRetry()
      )
    ) {
      return TaskStatus.FAILED;
    }

    // 如果所有节点都执行成功，整个任务图成功
    if (nodes.every((node) => node.status === TaskStatus.SUCCESS)) {
      return TaskStatus.SUCCESS;
    }

    // 如果有节点正在执行或重试中，整个任务图正在执行
    if (
      nodes.some(
        (node) =>
          node.status === TaskStatus.RUNNING ||
          node.status === TaskStatus.RETRYING
      )
    ) {
      return TaskStatus.RUNNING;
    }

    // 否则任务图处于待执行状态
    return TaskStatus.PENDING;
  }

  /**
   * 拓扑排序 - 获取任务执行顺序
   */
  public topologicalSort(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const tempVisited = new Set<string>();

    const dfs = (nodeId: string): void => {
      if (tempVisited.has(nodeId)) {
        throw new Error(`检测到循环依赖！节点: ${nodeId}`);
      }

      if (!visited.has(nodeId)) {
        tempVisited.add(nodeId);

        // 获取所有依赖此节点的节点
        const dependents = this.adjacencyList.get(nodeId) || [];
        dependents.forEach((dependentId) => {
          dfs(dependentId);
        });

        tempVisited.delete(nodeId);
        visited.add(nodeId);
        result.push(nodeId);
      }
    };

    // 对所有节点执行DFS
    this.nodes.forEach((node, id) => {
      if (!visited.has(id)) {
        dfs(id);
      }
    });

    return result.reverse(); // 反转得到正确的执行顺序
  }

  /**
   * 检查任务图是否存在循环依赖
   */
  private hasCycle(): boolean {
    try {
      this.topologicalSort();
      return false;
    } catch {
      return true;
    }
  }

  /**
   * 获取任务图的统计信息
   */
  public getStatistics(): {
    nodeCount: number;
    pendingCount: number;
    runningCount: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    retryingCount: number;
    estimatedTime: number;
    actualTime?: number;
    runningTasks: string[];
  } {
    const nodes = Array.from(this.nodes.values());
    const statusCount = {
      pending: 0,
      running: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      retrying: 0,
    };

    nodes.forEach((node) => {
      statusCount[node.status]++;
    });

    // 计算实际总执行时间（只有当所有节点都完成时才有效）
    let actualTime: number | undefined;
    if (
      nodes.every(
        (node) =>
          node.status === TaskStatus.SUCCESS ||
          node.status === TaskStatus.FAILED ||
          node.status === TaskStatus.SKIPPED
      )
    ) {
      const startTime = Math.min(
        ...nodes.filter((n) => n.startTime).map((n) => n.startTime!.getTime())
      );
      const endTime = Math.max(
        ...nodes.filter((n) => n.endTime).map((n) => n.endTime!.getTime())
      );
      actualTime = (endTime - startTime) / 1000;
    }

    return {
      nodeCount: this.getNodeCount(),
      pendingCount: statusCount.pending,
      runningCount: statusCount.running,
      successCount: statusCount.success,
      failedCount: statusCount.failed,
      skippedCount: statusCount.skipped,
      retryingCount: statusCount.retrying,
      estimatedTime: this.getEstimatedTime(),
      actualTime,
      runningTasks: Array.from(this.runningTasks),
    };
  }

  /**
   * 重置任务图状态
   */
  public reset(): void {
    this.nodes.forEach((node) => {
      node.status = TaskStatus.PENDING;
      node.result = undefined;
      node.error = undefined;
      node.startTime = undefined;
      node.endTime = undefined;
      node.currentRetry = 0;
    });
    this.runningTasks.clear();
  }

  /**
   * 注册事件处理器
   */
  public on(event: string, handler: (node: TaskNode) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)?.push(handler);
  }

  /**
   * 触发事件
   */
  private emitEvent(event: string, node: TaskNode): void {
    const handlers = this.eventHandlers.get(event);
    handlers?.forEach((handler) => handler(node));
  }

}
