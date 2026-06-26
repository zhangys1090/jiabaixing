/**
 * 桌面Agent事件流系统
 * 参考 UI-TARS Event Stream 设计
 * 实时推送Agent状态、操作、观察结果，支持前端可视化
 *
 * 事件类型：
 * - task_start: 任务开始
 * - task_end: 任务结束
 * - observation: 观察结果（截图）
 * - planning: 规划中
 * - action_start: 动作开始执行
 * - action_end: 动作执行完成
 * - action_error: 动作执行错误
 * - retry: 重试
 * - checkpoint: 检查点
 * - status_change: 状态变化
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';

export type DesktopEventType =
  | 'task_start'
  | 'task_end'
  | 'observation'
  | 'planning'
  | 'action_start'
  | 'action_end'
  | 'action_error'
  | 'retry'
  | 'checkpoint'
  | 'status_change'
  | 'safety_warning'
  | 'user_intervention_required';

export interface DesktopEvent {
  id: string;
  type: DesktopEventType;
  timestamp: number;
  taskId: string;
  data: Record<string, unknown>;
  sequence: number;
}

export interface EventStreamOptions {
  maxBufferSize?: number;
  enablePersistence?: boolean;
  persistencePath?: string;
}

export class DesktopEventStream extends EventEmitter {
  private static instance: DesktopEventStream | null = null;
  private eventBuffer: DesktopEvent[] = [];
  private maxBufferSize: number = 1000;
  private sequenceCounter: number = 0;
  private currentTaskId: string = '';
  private subscribers: Set<(event: DesktopEvent) => void> = new Set();

  private constructor(options?: EventStreamOptions) {
    super();
    this.maxBufferSize = options?.maxBufferSize || 1000;
  }

  public static getInstance(options?: EventStreamOptions): DesktopEventStream {
    if (!DesktopEventStream.instance) {
      DesktopEventStream.instance = new DesktopEventStream(options);
    }
    return DesktopEventStream.instance;
  }

  /**
   * 开始一个新任务
   */
  public startTask(taskDescription: string): string {
    this.currentTaskId = this.generateId();
    this.sequenceCounter = 0;

    this.emitEvent('task_start', {
      description: taskDescription,
      startTime: Date.now(),
    });

    Logger.info(`📋 任务开始: ${taskDescription}`, 'EventStream');
    return this.currentTaskId;
  }

  /**
   * 结束任务
   */
  public endTask(
    success: boolean,
    result: string,
    details?: Record<string, unknown>
  ): void {
    this.emitEvent('task_end', {
      success,
      result,
      endTime: Date.now(),
      ...details,
    });

    Logger.info(
      `🏁 任务结束: ${success ? '成功' : '失败'} - ${result.substring(0, 50)}`,
      'EventStream'
    );
  }

  /**
   * 发送观察事件
   */
  public emitObservation(
    screenshotBase64: string,
    screenWidth: number,
    screenHeight: number,
    uiElements?: unknown[]
  ): void {
    this.emitEvent('observation', {
      screenshot: screenshotBase64,
      screenWidth,
      screenHeight,
      uiElements: uiElements || [],
      timestamp: Date.now(),
    });
  }

  /**
   * 发送规划事件
   */
  public emitPlanning(plan: unknown[], reasoning?: string): void {
    this.emitEvent('planning', {
      plan,
      reasoning: reasoning || '',
      stepCount: Array.isArray(plan) ? plan.length : 0,
    });

    Logger.debug(
      `🧠 规划完成，共 ${Array.isArray(plan) ? plan.length : 0} 步`,
      'EventStream'
    );
  }

  /**
   * 发送动作开始事件
   */
  public emitActionStart(
    actionType: string,
    description: string,
    params: Record<string, unknown>
  ): void {
    this.emitEvent('action_start', {
      actionType,
      description,
      params,
      startTime: Date.now(),
    });

    Logger.debug(`▶️ 动作开始: ${description}`, 'EventStream');
  }

  /**
   * 发送动作完成事件
   */
  public emitActionEnd(
    actionType: string,
    description: string,
    success: boolean,
    result?: unknown
  ): void {
    this.emitEvent('action_end', {
      actionType,
      description,
      success,
      result,
      endTime: Date.now(),
    });

    Logger.debug(
      `✅ 动作完成: ${description} (${success ? '成功' : '失败'})`,
      'EventStream'
    );
  }

  /**
   * 发送动作错误事件
   */
  public emitActionError(
    actionType: string,
    description: string,
    error: string,
    willRetry: boolean = false
  ): void {
    this.emitEvent('action_error', {
      actionType,
      description,
      error,
      willRetry,
      timestamp: Date.now(),
    });

    Logger.warn(`❌ 动作错误: ${description} - ${error}`, 'EventStream');
  }

  /**
   * 发送重试事件
   */
  public emitRetry(
    retryCount: number,
    maxRetries: number,
    reason: string
  ): void {
    this.emitEvent('retry', {
      retryCount,
      maxRetries,
      reason,
      timestamp: Date.now(),
    });

    Logger.warn(
      `🔄 重试 ${retryCount}/${maxRetries}: ${reason}`,
      'EventStream'
    );
  }

  /**
   * 发送检查点事件
   */
  public emitCheckpoint(checkpointId: string, description: string): void {
    this.emitEvent('checkpoint', {
      checkpointId,
      description,
      timestamp: Date.now(),
    });

    Logger.info(`💾 检查点: ${description}`, 'EventStream');
  }

  /**
   * 发送状态变化事件
   */
  public emitStatusChange(status: string, details?: string): void {
    this.emitEvent('status_change', {
      status,
      details: details || '',
      timestamp: Date.now(),
    });

    Logger.info(`📊 状态变化: ${status}`, 'EventStream');
  }

  /**
   * 发送安全警告事件
   */
  public emitSafetyWarning(
    warningType: string,
    message: string,
    severity: 'low' | 'medium' | 'high' | 'critical' = 'medium'
  ): void {
    this.emitEvent('safety_warning', {
      warningType,
      message,
      severity,
      timestamp: Date.now(),
    });

    Logger.warn(`⚠️ 安全警告 [${severity}]: ${message}`, 'EventStream');
  }

  /**
   * 发送需要用户干预事件
   */
  public emitUserInterventionRequired(
    reason: string,
    options: string[] = ['继续', '取消', '重试']
  ): void {
    this.emitEvent('user_intervention_required', {
      reason,
      options,
      timestamp: Date.now(),
    });

    Logger.info(`👤 需要用户干预: ${reason}`, 'EventStream');
  }

  /**
   * 订阅事件流
   */
  public subscribe(callback: (event: DesktopEvent) => void): () => void {
    this.subscribers.add(callback);

    // 返回取消订阅函数
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * 获取历史事件
   */
  public getHistory(limit?: number): DesktopEvent[] {
    const events = [...this.eventBuffer];
    if (limit) {
      return events.slice(-limit);
    }
    return events;
  }

  /**
   * 获取当前任务的事件
   */
  public getCurrentTaskEvents(): DesktopEvent[] {
    return this.eventBuffer.filter((e) => e.taskId === this.currentTaskId);
  }

  /**
   * 清空事件缓冲区
   */
  public clearBuffer(): void {
    this.eventBuffer = [];
    this.sequenceCounter = 0;
    Logger.debug('🧹 事件缓冲区已清空', 'EventStream');
  }

  /**
   * 导出事件为JSON
   */
  public exportEvents(taskId?: string): string {
    const events = taskId
      ? this.eventBuffer.filter((e) => e.taskId === taskId)
      : this.eventBuffer;
    return JSON.stringify(events, null, 2);
  }

  /**
   * 发送事件（内部方法）
   */
  private emitEvent(
    type: DesktopEventType,
    data: Record<string, unknown>
  ): void {
    const event: DesktopEvent = {
      id: this.generateId(),
      type,
      timestamp: Date.now(),
      taskId: this.currentTaskId,
      data,
      sequence: this.sequenceCounter++,
    };

    // 添加到缓冲区
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.shift();
    }

    // 通知订阅者
    this.subscribers.forEach((callback) => {
      try {
        callback(event);
      } catch (err) {
        Logger.error(
          `事件订阅者错误: ${(err as Error).message}`,
          err as Error,
          'EventStream'
        );
      }
    });

    // 触发EventEmitter事件
    this.emit(type, event);
    this.emit('*', event);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// 便捷导出
export const eventStream = DesktopEventStream.getInstance();
