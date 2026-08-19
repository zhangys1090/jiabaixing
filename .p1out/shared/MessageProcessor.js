"use strict";
/**
 * 消息处理中间件层
 *
 * 基于 EventBus 的 AgentMessage 格式，提供：
 * - 消息中间件链（过滤、转换、路由）
 * - 统一消息格式校验
 * - 消息优先级排序
 * - 消息广播与点对点投递
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageProcessor = void 0;
exports.createLoggingMiddleware = createLoggingMiddleware;
exports.createFilterMiddleware = createFilterMiddleware;
exports.createTTLMiddleware = createTTLMiddleware;
exports.createRateLimitMiddleware = createRateLimitMiddleware;
const Logger_1 = require("../utils/Logger");
const PRIORITY_ORDER = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
};
class MessageProcessor {
    constructor() {
        this.middlewares = [];
        this.subscriptions = [];
        this.subscriptionIdCounter = 0;
        this.deadLetterQueue = [];
        this.MAX_DLQ_SIZE = 1000;
        this.processedCount = 0;
    }
    static getInstance() {
        if (!MessageProcessor.instance) {
            MessageProcessor.instance = new MessageProcessor();
        }
        return MessageProcessor.instance;
    }
    static resetInstance() {
        if (MessageProcessor.instance) {
            MessageProcessor.instance.middlewares = [];
            MessageProcessor.instance.subscriptions = [];
            MessageProcessor.instance.deadLetterQueue = [];
            MessageProcessor.instance = null;
        }
    }
    use(middleware) {
        this.middlewares.push(middleware);
        return this;
    }
    removeMiddleware(middleware) {
        const idx = this.middlewares.indexOf(middleware);
        if (idx >= 0) {
            this.middlewares.splice(idx, 1);
            return true;
        }
        return false;
    }
    subscribe(topic, handler, filter) {
        const id = `sub_${++this.subscriptionIdCounter}`;
        this.subscriptions.push({ id, topic, handler, filter });
        return id;
    }
    unsubscribe(subscriptionId) {
        const idx = this.subscriptions.findIndex((s) => s.id === subscriptionId);
        if (idx >= 0) {
            this.subscriptions.splice(idx, 1);
            return true;
        }
        return false;
    }
    dispatch(message) {
        this.processedCount++;
        const ctx = {
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
                Logger_1.Logger.debug(`消息已取消: ${ctx.message.id} (topic: ${ctx.message.topic})`, 'MessageProcessor');
                return;
            }
            this.deliver(ctx.message);
        });
    }
    getDeadLetters(limit = 50) {
        return this.deadLetterQueue.slice(-limit);
    }
    getStats() {
        return {
            processedCount: this.processedCount,
            middlewareCount: this.middlewares.length,
            subscriptionCount: this.subscriptions.length,
            deadLetterCount: this.deadLetterQueue.length,
        };
    }
    executeMiddlewareChain(ctx, index, finalHandler) {
        if (index >= this.middlewares.length) {
            finalHandler();
            return;
        }
        const middleware = this.middlewares[index];
        middleware(ctx, () => {
            this.executeMiddlewareChain(ctx, index + 1, finalHandler);
        });
    }
    deliver(message) {
        const matching = this.subscriptions
            .filter((s) => {
            if (s.topic !== '*' && s.topic !== message.topic)
                return false;
            if (s.filter && !s.filter(message))
                return false;
            return true;
        })
            .sort((a, b) => {
            const aMatch = a.topic === message.topic ? 0 : 1;
            const bMatch = b.topic === message.topic ? 0 : 1;
            return aMatch - bMatch;
        });
        if (matching.length === 0) {
            Logger_1.Logger.debug(`无订阅者: topic=${message.topic}, from=${message.from}`, 'MessageProcessor');
            return;
        }
        for (const sub of matching) {
            try {
                sub.handler(message);
            }
            catch (err) {
                Logger_1.Logger.error(`消息处理异常: subscription=${sub.id}, topic=${message.topic}: ${err.message}`, err, 'MessageProcessor');
            }
        }
    }
    static sortByPriority(messages) {
        return [...messages].sort((a, b) => {
            const pa = PRIORITY_ORDER[a.priority] ?? 2;
            const pb = PRIORITY_ORDER[b.priority] ?? 2;
            if (pa !== pb)
                return pa - pb;
            return a.timestamp - b.timestamp;
        });
    }
    static createMessage(from, topic, payload, options) {
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
exports.MessageProcessor = MessageProcessor;
MessageProcessor.instance = null;
function createLoggingMiddleware() {
    return (ctx, next) => {
        Logger_1.Logger.debug(`[MessageProcessor] ${ctx.message.type}:${ctx.message.topic} from=${ctx.message.from} priority=${ctx.message.priority}`, 'MessageProcessor');
        next();
    };
}
function createFilterMiddleware(predicate, reason) {
    return (ctx, next) => {
        if (!predicate(ctx.message)) {
            ctx.cancelled = true;
            Logger_1.Logger.debug(`消息被过滤: ${ctx.message.id} (reason: ${reason ?? 'filter predicate'})`, 'MessageProcessor');
            return;
        }
        next();
    };
}
function createTTLMiddleware() {
    return (ctx, next) => {
        if (ctx.message.ttl &&
            Date.now() - ctx.message.timestamp > ctx.message.ttl) {
            ctx.cancelled = true;
            Logger_1.Logger.debug(`消息已过期: ${ctx.message.id} (ttl: ${ctx.message.ttl}ms)`, 'MessageProcessor');
            return;
        }
        next();
    };
}
function createRateLimitMiddleware(maxPerSecond, perTopic = false) {
    const counters = new Map();
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
            Logger_1.Logger.debug(`消息被限流: ${ctx.message.id} (topic: ${ctx.message.topic}, limit: ${maxPerSecond}/s)`, 'MessageProcessor');
            return;
        }
        next();
    };
}
