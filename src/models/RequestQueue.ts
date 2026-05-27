import { Logger } from '../utils/Logger';

export class RequestQueue {
  private queue: Array<{
    execute: () => Promise<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private activeRequests: number = 0;
  private maxConcurrent: number = 2;

  constructor(maxConcurrent?: number) {
    if (maxConcurrent !== undefined) {
      this.maxConcurrent = maxConcurrent;
    }
  }

  enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        execute: execute as unknown as () => Promise<string>,
        resolve: resolve as unknown as (value: string) => void,
        reject,
      });
      setImmediate(() => this.processQueue());
    });
  }

  private processQueue(): void {
    while (
      this.queue.length > 0 && this.activeRequests < this.maxConcurrent
    ) {
      const request = this.queue.shift();
      if (request) {
        this.activeRequests++;
        request
          .execute()
          .then(request.resolve)
          .catch(request.reject)
          .finally(() => {
            this.activeRequests--;
            this.processQueue();
          });
      }
    }
  }

  getActiveCount(): number {
    return this.activeRequests;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}
