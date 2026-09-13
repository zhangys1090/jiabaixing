"use strict";
/**
 * Harness Layer 4: EventStoreBridge — EventBus → EventStore 桥接器
 *
 * 将现有 EventBus 的实时事件流桥接到 EventStore 的 append-only 存储，
 * 实现事件溯源的透明接入，无需修改现有 EventBus 的使用方式。
 *
 * 工作原理：
 * 1. 订阅 EventBus 的关键事件
 * 2. 将事件转换为 EventStore 的标准格式
 * 3. 追加写入 EventStore
 * 4. 支持动态启停，不影响 EventBus 的广播功能
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStoreBridge = void 0;
const Logger_1 = require("../../utils/Logger");
const DEFAULT_ENABLED_EVENTS = [
    'user_input',
    'response_ready',
    'agent_execution_update',
    'tool_trace',
    'context_update',
    'session_reset',
    'learning_signal',
    'cognition_result',
];
const EVENT_TYPE_MAP = {
    user_input: 'user_input',
    response_ready: 'agent_thinking',
    agent_execution_update: 'state_transition',
    tool_trace: 'tool_result',
    context_update: 'context_update',
    session_reset: 'session_started',
    learning_signal: 'custom',
    cognition_result: 'custom',
    stream_start: 'custom',
    stream_done: 'custom',
    task_started: 'state_transition',
    task_completed: 'state_transition',
    task_failed: 'error_occurred',
};
class EventStoreBridge {
    eventBus;
    eventStore;
    options;
    listeners = [];
    active = false;
    eventCounter = 0;
    constructor(eventBus, eventStore, options) {
        this.eventBus = eventBus;
        this.eventStore = eventStore;
        this.options = options;
    }
    start() {
        if (this.active)
            return;
        const enabledEvents = this.options.enabledEvents ?? DEFAULT_ENABLED_EVENTS;
        const disabledEvents = new Set(this.options.disabledEvents ?? []);
        const eventsToSubscribe = enabledEvents.filter((e) => !disabledEvents.has(e));
        for (const eventName of eventsToSubscribe) {
            const listener = (...args) => {
                this.handleEvent(eventName, args);
            };
            this.eventBus.on(eventName, listener);
            this.listeners.push({ eventName, listener });
        }
        this.active = true;
        Logger_1.Logger.info(`🌉 EventStoreBridge 已启动, 监听 ${eventsToSubscribe.length} 种事件`, 'EventStoreBridge');
    }
    stop() {
        if (!this.active)
            return;
        for (const { eventName, listener } of this.listeners) {
            this.eventBus.off(eventName, listener);
        }
        this.listeners = [];
        this.active = false;
        Logger_1.Logger.info('EventStoreBridge 已停止', 'EventStoreBridge');
    }
    isActive() {
        return this.active;
    }
    getEventCount() {
        return this.eventCounter;
    }
    handleEvent(eventName, args) {
        try {
            const storeEventType = EVENT_TYPE_MAP[eventName] ?? 'custom';
            const payload = this.extractPayload(eventName, args);
            const metadata = this.buildMetadata(eventName);
            const event = {
                eventId: this.generateEventId(eventName),
                sessionId: this.options.sessionId,
                eventType: storeEventType,
                payload,
                metadata,
            };
            this.eventStore.append(event);
            this.eventCounter++;
        }
        catch (error) {
            Logger_1.Logger.error(`EventStoreBridge 处理事件失败: ${String(eventName)}`, error, 'EventStoreBridge');
        }
    }
    extractPayload(eventName, args) {
        if (args.length === 0)
            return { eventName };
        const firstArg = args[0];
        if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
            return {
                eventName,
                ...firstArg,
            };
        }
        if (args.length === 1) {
            return { eventName, value: args[0] };
        }
        if (args.length === 2) {
            return { eventName, key: args[0], value: args[1] };
        }
        return { eventName, args };
    }
    buildMetadata(eventName) {
        return {
            source: 'EventStoreBridge',
            agentId: this.options.agentId,
            userId: this.options.userId,
            originalEventName: String(eventName),
            bridgeTimestamp: Date.now(),
        };
    }
    generateEventId(eventName) {
        this.eventCounter++;
        const timestamp = Date.now().toString(36);
        const counter = this.eventCounter.toString(36);
        const random = Math.random().toString(36).substring(2, 8);
        return `evt_${String(eventName)}_${timestamp}_${counter}_${random}`;
    }
    updateSessionId(sessionId) {
        this.options.sessionId = sessionId;
    }
    destroy() {
        this.stop();
        this.eventCounter = 0;
    }
}
exports.EventStoreBridge = EventStoreBridge;
