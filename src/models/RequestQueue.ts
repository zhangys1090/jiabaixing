/**
 * @deprecated 已迁移到 Python agent/llm/queue.py。
 * 此存根仅保持向后兼容，V6.0 后移除。
 */
export interface RequestQueueConfig {
  maxConcurrent?: number;
}

export class RequestQueue {
  private _queue: Array<() => Promise<void>> = [];
  private _running = 0;
  private _maxConcurrent: number;

  constructor(config?: RequestQueueConfig | number) {
    this._maxConcurrent =
      typeof config === 'number' ? config : (config?.maxConcurrent ?? 5);
  }

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  get pending(): number {
    return this._queue.length;
  }

  get running(): number {
    return this._running;
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }
}
