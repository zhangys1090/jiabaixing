/**
 * 定时器管理器
 * 集中管理所有 setInterval/setTimeout，防止内存泄漏
 * 提供命名空间、自动清理、生命周期管理
 */

import { Logger } from './Logger';

interface TimerEntry {
  id: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  type: 'timeout' | 'interval';
  namespace: string;
  description: string;
  createdAt: number;
}

export class TimerManager {
  private static instance: TimerManager;
  private timers: Map<string, TimerEntry> = new Map();
  private namespaceCounters: Map<string, number> = new Map();

  static getInstance(): TimerManager {
    if (!TimerManager.instance) {
      TimerManager.instance = new TimerManager();
    }
    return TimerManager.instance;
  }

  /**
   * 注册 setTimeout
   */
  setTimeout(
    callback: () => void,
    delay: number,
    namespace: string = 'default',
    description: string = ''
  ): string {
    const id = this.generateId(namespace);
    const timerId = setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, delay);

    this.timers.set(id, {
      id: timerId,
      type: 'timeout',
      namespace,
      description,
      createdAt: Date.now(),
    });

    return id;
  }

  /**
   * 注册 setInterval
   */
  setInterval(
    callback: () => void,
    interval: number,
    namespace: string = 'default',
    description: string = ''
  ): string {
    const id = this.generateId(namespace);
    const timerId = setInterval(callback, interval);

    this.timers.set(id, {
      id: timerId,
      type: 'interval',
      namespace,
      description,
      createdAt: Date.now(),
    });

    return id;
  }

  /**
   * 清除指定定时器
   */
  clear(id: string): boolean {
    const entry = this.timers.get(id);
    if (!entry) return false;

    if (entry.type === 'timeout') {
      clearTimeout(entry.id as ReturnType<typeof setTimeout>);
    } else {
      clearInterval(entry.id as ReturnType<typeof setInterval>);
    }

    this.timers.delete(id);
    return true;
  }

  /**
   * 清除指定命名空间的所有定时器
   */
  clearNamespace(namespace: string): number {
    let count = 0;
    for (const [id, entry] of this.timers.entries()) {
      if (entry.namespace === namespace) {
        this.clear(id);
        count++;
      }
    }
    Logger.debug(
      `🧹 清理命名空间 "${namespace}" 的 ${count} 个定时器`,
      'TimerManager'
    );
    return count;
  }

  /**
   * 清除所有定时器
   */
  clearAll(): number {
    const count = this.timers.size;
    for (const [id] of this.timers.entries()) {
      this.clear(id);
    }
    Logger.info(`🧹 清理全部 ${count} 个定时器`, 'TimerManager');
    return count;
  }

  /**
   * 获取定时器统计
   */
  getStats(): {
    total: number;
    timeouts: number;
    intervals: number;
    namespaces: Record<string, number>;
  } {
    const namespaces: Record<string, number> = {};
    let timeouts = 0;
    let intervals = 0;

    for (const [, entry] of this.timers.entries()) {
      namespaces[entry.namespace] = (namespaces[entry.namespace] || 0) + 1;
      if (entry.type === 'timeout') timeouts++;
      else intervals++;
    }

    return {
      total: this.timers.size,
      timeouts,
      intervals,
      namespaces,
    };
  }

  /**
   * 获取指定命名空间的定时器列表
   */
  getTimersByNamespace(namespace: string): Array<{
    id: string;
    type: string;
    description: string;
    age: number;
  }> {
    const result: Array<{
      id: string;
      type: string;
      description: string;
      age: number;
    }> = [];
    const now = Date.now();

    for (const [id, entry] of this.timers.entries()) {
      if (entry.namespace === namespace) {
        result.push({
          id,
          type: entry.type,
          description: entry.description,
          age: now - entry.createdAt,
        });
      }
    }

    return result;
  }

  /**
   * 清除指定定时器（兼容 clearTimer 别名）
   */
  clearTimer(id: string): boolean {
    return this.clear(id);
  }

  private generateId(namespace: string): string {
    const count = (this.namespaceCounters.get(namespace) || 0) + 1;
    this.namespaceCounters.set(namespace, count);
    return `${namespace}_${count}_${Date.now()}`;
  }
}

// 便捷导出
