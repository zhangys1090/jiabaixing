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

import type { EventName } from '../../shared/eventTypes';
import { Logger } from '../../utils/Logger';
import {
    EventStore,
    type EventMetadata,
    type EventStoreEvent,
    type EventStoreEventType,
} from './EventStore';

export interface EventStoreBridgeOptions {
  sessionId: string;
  agentId?: string;
  userId?: string;
  enabledEvents?: EventName[];
  disabledEvents?: EventName[];
}

const DEFAULT_ENABLED_EVENTS: EventName[] = [
  'user_input',
  'response_ready',
  'agent_execution_update',
  'tool_trace',
  'context_update',
  'session_reset',
  'learning_signal',
  'cognition_result',
];

const EVENT_TYPE_MAP: Partial<Record<EventName, EventStoreEventType>> = {
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

export class EventStoreBridge {
  private eventBus: EventBus;
  private eventStore: EventStore;
  private options: EventStoreBridgeOptions;
  private listeners: Array<{ eventName: EventName; listener: (...args: unknown[]) => void }> = [];
  private active = false;
  private eventCounter = 0;

  constructor(
    eventBus: EventBus,
    eventStore: EventStore,
    options: EventStoreBridgeOptions
  ) {
    this.eventBus = eventBus;
    this.eventStore = eventStore;
    this.options = options;
  }

  start(): void {
    if (this.active) return;

    const enabledEvents = this.options.enabledEvents ?? DEFAULT_ENABLED_EVENTS;
    const disabledEvents = new Set(this.options.disabledEvents ?? []);

    const eventsToSubscribe = enabledEvents.filter(
      (e) => !disabledEvents.has(e)
    );

    for (const eventName of eventsToSubscribe) {
      const listener = (...args: unknown[]) => {
        this.handleEvent(eventName, args);
      };

      this.eventBus.on(eventName, listener as never);
      this.listeners.push({ eventName, listener });
    }

    this.active = true;
    Logger.info(
      `🌉 EventStoreBridge 已启动, 监听 ${eventsToSubscribe.length} 种事件`,
      'EventStoreBridge'
    );
  }

  stop(): void {
    if (!this.active) return;

    for (const { eventName, listener } of this.listeners) {
      this.eventBus.off(eventName, listener as never);
    }

    this.listeners = [];
    this.active = false;
    Logger.info('EventStoreBridge 已停止', 'EventStoreBridge');
  }

  isActive(): boolean {
    return this.active;
  }

  getEventCount(): number {
    return this.eventCounter;
  }

  private handleEvent(eventName: EventName, args: unknown[]): void {
    try {
      const storeEventType = EVENT_TYPE_MAP[eventName] ?? 'custom';
      const payload = this.extractPayload(eventName, args);
      const metadata = this.buildMetadata(eventName);

      const event: Omit<EventStoreEvent, 'sequenceNum' | 'timestamp'> = {
        eventId: this.generateEventId(eventName),
        sessionId: this.options.sessionId,
        eventType: storeEventType,
        payload,
        metadata,
      };

      this.eventStore.append(event);
      this.eventCounter++;
    } catch (error) {
      Logger.error(
        `EventStoreBridge 处理事件失败: ${String(eventName)}`,
        error as Error,
        'EventStoreBridge'
      );
    }
  }

  private extractPayload(
    eventName: EventName,
    args: unknown[]
  ): Record<string, unknown> {
    if (args.length === 0) return { eventName };

    const firstArg = args[0];

    if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
      return {
        eventName,
        ...(firstArg as Record<string, unknown>),
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

  private buildMetadata(eventName: EventName): EventMetadata {
    return {
      source: 'EventStoreBridge',
      agentId: this.options.agentId,
      userId: this.options.userId,
      originalEventName: String(eventName),
      bridgeTimestamp: Date.now(),
    };
  }

  private generateEventId(eventName: EventName): string {
    this.eventCounter++;
    const timestamp = Date.now().toString(36);
    const counter = this.eventCounter.toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `evt_${String(eventName)}_${timestamp}_${counter}_${random}`;
  }

  updateSessionId(sessionId: string): void {
    this.options.sessionId = sessionId;
  }

  destroy(): void {
    this.stop();
    this.eventCounter = 0;
  }
}
