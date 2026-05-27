/**
 * 流式响应处理器
 * 支持实时返回生成内容、中断控制、错误恢复
 */

import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';

export interface StreamChunk {
  content: string;
  isComplete: boolean;
  tokenCount?: number;
  timestamp: number;
}

export interface StreamOptions {
  onChunk?: (chunk: StreamChunk) => void;
  onComplete?: (fullContent: string) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
  timeout?: number;
}

export interface StreamResult {
  content: string;
  tokenCount: number;
  duration: number;
  interrupted: boolean;
}

export class StreamingResponseHandler {
  private activeStreams: Map<string, AbortController> = new Map();
  private readonly DEFAULT_TIMEOUT = 60000;

  constructor() {
    Logger.info(
      '🌊 StreamingResponseHandler 初始化完成',
      'StreamingResponseHandler'
    );
  }

  public async *handleStream(
    stream: AsyncIterable<string>,
    traceId: string,
    options: StreamOptions = {}
  ): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    this.activeStreams.set(traceId, controller);

    const timeout = options.timeout || this.DEFAULT_TIMEOUT;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let fullContent = '';
    let tokenCount = 0;
    const startTime = Date.now();

    try {
      for await (const chunk of stream) {
        if (options.signal?.aborted || controller.signal.aborted) {
          void EventBus.emit('brain_stage_update', {
            traceId,
            stage: 'llm_generation',
            status: 'failed',
            timestamp: new Date().toISOString(),
          });

          yield {
            content: fullContent,
            isComplete: false,
            tokenCount,
            timestamp: Date.now(),
          };

          return;
        }

        fullContent += chunk;
        tokenCount++;

        const streamChunk: StreamChunk = {
          content: chunk,
          isComplete: false,
          tokenCount,
          timestamp: Date.now(),
        };

        void EventBus.emit('brain_stage_update', {
          traceId,
          stage: 'llm_generation',
          status: 'started',
          timestamp: new Date().toISOString(),
        });

        options.onChunk?.(streamChunk);
        yield streamChunk;
      }

      const finalChunk: StreamChunk = {
        content: '',
        isComplete: true,
        tokenCount,
        timestamp: Date.now(),
      };

      void EventBus.emit('brain_stage_update', {
        traceId,
        stage: 'llm_generation',
        status: 'completed',
        result: { tokenCount, duration: Date.now() - startTime },
        timestamp: new Date().toISOString(),
      });

      options.onComplete?.(fullContent);
      yield finalChunk;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      void EventBus.emit('brain_stage_update', {
        traceId,
        stage: 'llm_generation',
        status: 'completed',
        result: { tokenCount, duration: Date.now() - startTime },
        timestamp: new Date().toISOString(),
      });

      options.onError?.(err);
      throw err;
    } finally {
      clearTimeout(timeoutId);
      this.activeStreams.delete(traceId);
    }
  }

  public async collectStream(
    stream: AsyncIterable<string>,
    traceId: string,
    options: StreamOptions = {}
  ): Promise<StreamResult> {
    const startTime = Date.now();
    let fullContent = '';
    let tokenCount = 0;
    let interrupted = false;

    try {
      for await (const chunk of this.handleStream(stream, traceId, options)) {
        if (!chunk.isComplete) {
          fullContent += chunk.content;
          tokenCount = chunk.tokenCount || tokenCount;
        }
      }
    } catch {
      interrupted = true;
    }

    return {
      content: fullContent,
      tokenCount,
      duration: Date.now() - startTime,
      interrupted,
    };
  }

  public interrupt(traceId: string): boolean {
    const controller = this.activeStreams.get(traceId);
    if (controller) {
      controller.abort();
      Logger.info(`⏹️ 中断流式响应: ${traceId}`, 'StreamingResponseHandler');
      return true;
    }
    return false;
  }

  public interruptAll(): number {
    let count = 0;
    for (const [traceId, controller] of this.activeStreams) {
      controller.abort();
      count++;
      Logger.debug(`⏹️ 中断流式响应: ${traceId}`, 'StreamingResponseHandler');
    }
    this.activeStreams.clear();
    return count;
  }

  public getActiveStreams(): string[] {
    return Array.from(this.activeStreams.keys());
  }

  public hasActiveStream(traceId: string): boolean {
    return this.activeStreams.has(traceId);
  }
}

export const streamingResponseHandler = new StreamingResponseHandler();
