/**
 * 消息处理中间件层
 *
 * 基于 EventBus 的 AgentMessage 格式，提供：
 * - 消息中间件链（过滤、转换、路由）
 * - 统一消息格式校验
 * - 消息优先级排序
 * - 消息广播与点对点投递
 */

import { Logger } from '../utils/Logger';

export interface MiddlewareContext {
  message: AgentMessage;
  modified: boolean;
  cancelled: boolean;
  metadata: Record<string, unknown>;
}

export type MessageMiddleware = (
  ctx: MiddlewareContext,
  next: () => void
) => void;

export interface AgentMessage {
  id: string;
  from: string;
  to?: string;
  topic: string;
  type: 'request' | 'response' | 'notification' | 'broadcast';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  payload: unknown;
  replyTo?: string;
  ttl?: number;
  timestamp: number;
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

type MessageHandler = (message: AgentMessage) => void;

interface Subscription {
  id: string;
  topic: string;
  handler: MessageHandler;
  filter?: (msg: AgentMessage) => boolean;
}

export class MessageProcessor {
  private static instance: MessageProcessor | null = null;

  private middlewares: MessageMiddleware[] = [];
  private subscriptions: Subscription[] = [];
  private subscriptionIdCounter = 0;
  private deadLetterQueue: AgentMessage[] = [];
  private readonly MAX_DLQ_SIZE = 1000;
  private processedCount = 0;

  private constructor() {}

  static create(): MessageProcessor {
    return new MessageProcessor();
  }

  static getInstance(): MessageProcessor {
    if (!MessageProcessor.instance) {
      MessageProcessor.instance = new MessageProcessor();
    }
    return MessageProcessor.instance;
  }

  static resetInstance(): void {
    if (MessageProcessor.instance) {
      MessageProcessor.instance.middlewares = [];
      MessageProcessor.instance.subscriptions = [];
      MessageProcessor.instance.deadLetterQueue = [];
      MessageProcessor.instance = null;
    }
  }

  use(middleware: MessageMiddleware): MessageProcessor {
    this.middlewares.push(middleware);
    return this;
  }

  removeMiddleware(middleware: MessageMiddleware): boolean {
    const idx = this.middlewares.indexOf(middleware);
    if (idx >= 0) {
      this.middlewares.splice(idx, 1);
      return true;
    }
    return false;
  }

  subscribe(
    topic: string,
    handler: MessageHandler,
    filter?: (msg: AgentMessage) => boolean
  ): string {
    const id = `sub_${++this.subscriptionIdCounter}`;
    this.subscriptions.push({ id, topic, handler, filter });
    return id;
  }

  unsubscribe(subscriptionId: string): boolean {
    const idx = this.subscriptions.findIndex((s) => s.id === subscriptionId);
    if (idx >= 0) {
      this.subscriptions.splice(idx, 1);
      return true;
    }
    return false;
  }

  dispatch(message: AgentMessage): void {
    this.processedCount++;

    const ctx: MiddlewareContext = {
      message: { ...message },
      modified: false,
      cancelled: false,
      metadata: {},
    };

    this.executeMiddlewareChain(ctx, 0, () => {
      if (ctx.cancelled) {
        this.deadLetterQueue.push(ctx.message);
        if (this.deadLetterQueue.length > this.MAX_DLQ_SIZE) {
          this.deadLetterQueue.shift();
        }
        Logger.debug(
          `消息已取消: ${ctx.message.id} (topic: ${ctx.message.topic})`,
          'MessageProcessor'
        );
        return;
      }

      this.deliver(ctx.message);
    });
  }

  getDeadLetters(limit = 50): AgentMessage[] {
    return this.deadLetterQueue.slice(-limit);
  }

  getStats(): {
    processedCount: number;
    middlewareCount: number;
    subscriptionCount: number;
    deadLetterCount: number;
  } {
    return {
      processedCount: this.processedCount,
      middlewareCount: this.middlewares.length,
      subscriptionCount: this.subscriptions.length,
      deadLetterCount: this.deadLetterQueue.length,
    };
  }

  private executeMiddlewareChain(
    ctx: MiddlewareContext,
    index: number,
    finalHandler: () => void
  ): void {
    if (index >= this.middlewares.length) {
      finalHandler();
      return;
    }

    const middleware = this.middlewares[index];
    middleware(ctx, () => {
      this.executeMiddlewareChain(ctx, index + 1, finalHandler);
    });
  }

  private deliver(message: AgentMessage): void {
    const matching = this.subscriptions
      .filter((s) => {
        if (s.topic !== '*' && s.topic !== message.topic) return false;
        if (s.filter && !s.filter(message)) return false;
        return true;
      })
      .sort((a, b) => {
        const aMatch = a.topic === message.topic ? 0 : 1;
        const bMatch = b.topic === message.topic ? 0 : 1;
        return aMatch - bMatch;
      });

    if (matching.length === 0) {
      Logger.debug(
        `无订阅者: topic=${message.topic}, from=${message.from}`,
        'MessageProcessor'
      );
      return;
    }

    for (const sub of matching) {
      try {
        sub.handler(message);
      } catch (err) {
        Logger.error(
          `消息处理异常: subscription=${sub.id}, topic=${message.topic}: ${(err as Error).message}`,
          err as Error,
          'MessageProcessor'
        );
      }
    }
  }

  static sortByPriority(messages: AgentMessage[]): AgentMessage[] {
    return [...messages].sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 2;
      const pb = PRIORITY_ORDER[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.timestamp - b.timestamp;
    });
  }

  static createMessage(
    from: string,
    topic: string,
    payload: unknown,
    options?: {
      to?: string;
      type?: AgentMessage['type'];
      priority?: AgentMessage['priority'];
      replyTo?: string;
      ttl?: number;
    }
  ): AgentMessage {
    return {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from,
      to: options?.to,
      topic,
      type: options?.type ?? 'notification',
      priority: options?.priority ?? 'medium',
      payload,
      replyTo: options?.replyTo,
      ttl: options?.ttl,
      timestamp: Date.now(),
    };
  }
}

export function createLoggingMiddleware(): MessageMiddleware {
  return (ctx, next) => {
    Logger.debug(
      `[MessageProcessor] ${ctx.message.type}:${ctx.message.topic} from=${ctx.message.from} priority=${ctx.message.priority}`,
      'MessageProcessor'
    );
    next();
  };
}

export function createFilterMiddleware(
  predicate: (msg: AgentMessage) => boolean,
  reason?: string
): MessageMiddleware {
  return (ctx, next) => {
    if (!predicate(ctx.message)) {
      ctx.cancelled = true;
      Logger.debug(
        `消息被过滤: ${ctx.message.id} (reason: ${reason ?? 'filter predicate'})`,
        'MessageProcessor'
      );
      return;
    }
    next();
  };
}

export function createTTLMiddleware(): MessageMiddleware {
  return (ctx, next) => {
    if (
      ctx.message.ttl &&
      Date.now() - ctx.message.timestamp > ctx.message.ttl
    ) {
      ctx.cancelled = true;
      Logger.debug(
        `消息已过期: ${ctx.message.id} (ttl: ${ctx.message.ttl}ms)`,
        'MessageProcessor'
      );
      return;
    }
    next();
  };
}

export function createRateLimitMiddleware(
  maxPerSecond: number,
  perTopic = false
): MessageMiddleware {
  const counters = new Map<string, { count: number; windowStart: number }>();

  return (ctx, next) => {
    const key = perTopic ? ctx.message.topic : '__global__';
    const now = Date.now();
    let counter = counters.get(key);

    if (!counter || now - counter.windowStart >= 1000) {
      counter = { count: 0, windowStart: now };
      counters.set(key, counter);
    }

    counter.count++;
    if (counter.count > maxPerSecond) {
      ctx.cancelled = true;
      Logger.debug(
        `消息被限流: ${ctx.message.id} (topic: ${ctx.message.topic}, limit: ${maxPerSecond}/s)`,
        'MessageProcessor'
      );
      return;
    }

    next();
  };
}
