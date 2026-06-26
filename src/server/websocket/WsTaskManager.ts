/**
 * WebSocket 任务管理模块
 * 从 websocket.ts 提取，专门处理活跃任务追踪
 */

import { Logger } from '../../utils/Logger';
import { SYSTEM_CONSTANTS } from '../../shared/contracts';

/**
 * 活跃任务接口
 */
export interface ActiveTask {
  aborted: boolean;
  loopController?: { abort(): void };
  clientIp: string;
  createdAt: number;
}

/**
 * WebSocket 任务管理器
 */
export class WsTaskManager {
  private tasks: Map<string, ActiveTask> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly timeoutMs: number;
  private readonly cleanupIntervalMs: number;

  constructor(timeoutMs?: number, cleanupIntervalMs?: number) {
    this.timeoutMs = timeoutMs ?? SYSTEM_CONSTANTS.ACTIVE_TASK_TIMEOUT_MS;
    this.cleanupIntervalMs = cleanupIntervalMs ?? 60 * 1000;
  }

  /**
   * 注册新任务
   */
  register(traceId: string, task: ActiveTask): void {
    this.tasks.set(traceId, task);
  }

  /**
   * 获取任务
   */
  get(traceId: string): ActiveTask | undefined {
    return this.tasks.get(traceId);
  }

  /**
   * 取消任务
   */
  cancel(traceId: string): boolean {
    const task = this.tasks.get(traceId);
    if (!task) return false;

    task.aborted = true;
    if (task.loopController) {
      try {
        task.loopController.abort();
      } catch {
        // 忽略
      }
    }
    this.tasks.delete(traceId);
    return true;
  }

  /**
   * 删除任务
   */
  delete(traceId: string): boolean {
    return this.tasks.delete(traceId);
  }

  /**
   * 检查任务是否存在
   */
  has(traceId: string): boolean {
    return this.tasks.has(traceId);
  }

  /**
   * 获取任务数量
   */
  get size(): number {
    return this.tasks.size;
  }

  /**
   * 按客户端 IP 获取所有任务
   */
  getByClientIp(clientIp: string): ActiveTask[] {
    const result: ActiveTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.clientIp === clientIp) {
        result.push(task);
      }
    }
    return result;
  }

  /**
   * 清理超时任务
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [traceId, task] of this.tasks.entries()) {
      if (now - task.createdAt > this.timeoutMs) {
        if (!task.aborted && task.loopController) {
          try {
            task.loopController.abort();
          } catch {
            // 忽略
          }
        }
        this.tasks.delete(traceId);
        cleaned++;
        Logger.debug(
          `🗑️ 自动清理超时活跃任务: traceId=${traceId}`,
          'WsTaskManager'
        );
      }
    }

    return cleaned;
  }

  /**
   * 按客户端 IP 清理所有任务
   */
  cleanupByClientIp(clientIp: string): number {
    let cleaned = 0;

    for (const [traceId, task] of this.tasks.entries()) {
      if (task.clientIp === clientIp) {
        if (!task.aborted && task.loopController) {
          try {
            task.loopController.abort();
          } catch {
            // 忽略
          }
        }
        this.tasks.delete(traceId);
        cleaned++;
        Logger.debug(
          `🗑️ 清理客户端断开关联任务: traceId=${traceId}`,
          'WsTaskManager'
        );
      }
    }

    return cleaned;
  }

  /**
   * 启动定时清理
   */
  startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, this.cleanupIntervalMs);
    }
  }

  /**
   * 停止定时清理
   */
  stopCleanup(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * 创建任务元数据
   */
  createTaskMeta(
    clientIp: string,
    loopController?: { abort(): void }
  ): ActiveTask {
    return {
      aborted: false,
      loopController,
      clientIp,
      createdAt: Date.now(),
    };
  }
}

/**
 * 全局任务管理器实例
 */
export const activeTasks = new WsTaskManager();
