/**
 * Harness Layer 4: SessionReplay — 会话回放服务
 *
 * 基于 EventStore 的 append-only 事件流，提供会话回放能力：
 * - 时间旅行：回到任意序列号查看 Agent 状态
 * - 逐步回放：逐事件重建上下文，观察状态变迁
 * - 差异分析：比较两个时间点的状态差异
 * - 轨迹导出：将会话事件流导出为 SFT 训练格式
 */

import {
    EventStore,
    type EventStoreEvent,
    type EventStoreEventType,
    type ProjectionResult,
} from './EventStore';

export interface ReplayStep {
  event: EventStoreEvent;
  stateBefore: Record<string, unknown>;
  stateAfter: Record<string, unknown>;
  stateDelta: Record<string, { before: unknown; after: unknown }>;
}

export interface ReplayResult {
  sessionId: string;
  totalEvents: number;
  replayedEvents: number;
  steps: ReplayStep[];
  finalState: Record<string, unknown>;
  duration: number;
}

export interface DiffResult {
  sessionId: string;
  sequenceA: number;
  sequenceB: number;
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { before: unknown; after: unknown }>;
  summary: string;
}

export interface TrajectoryExportOptions {
  format: 'sft' | 'dpo' | 'jsonl' | 'json';
  includeToolCalls?: boolean;
  includeThinking?: boolean;
  includeErrors?: boolean;
  maxTokens?: number;
}

export interface SFTEntry {
  messages: Array<{ role: string; content: string }>;
  metadata: {
    sessionId: string;
    eventCount: number;
    duration: number;
    toolCallCount: number;
    successRate: number;
  };
}

export interface DPOEntry {
  chosen: Array<{ role: string; content: string }>;
  rejected: Array<{ role: string; content: string }>;
  metadata: {
    sessionId: string;
    qualityScore: number;
  };
}

export class SessionReplay {
  private eventStore: EventStore;

  constructor(eventStore: EventStore) {
    this.eventStore = eventStore;
  }

  replaySession(
    sessionId: string,
    options: {
      fromSequence?: number;
      toSequence?: number;
      eventFilter?: EventStoreEventType[];
      includeStateDelta?: boolean;
    } = {}
  ): ReplayResult {
    const startTime = Date.now();

    const events = this.eventStore.query({
      sessionId,
      fromSequence: options.fromSequence,
      toSequence: options.toSequence,
      eventTypes: options.eventFilter,
    });

    const steps: ReplayStep[] = [];
    let currentState: Record<string, unknown> = {};

    if (options.fromSequence && options.fromSequence > 1) {
      const priorProjection = this.eventStore.projectConversationState(sessionId);
      if (priorProjection.lastSequenceNum < options.fromSequence) {
        currentState = priorProjection.state as Record<string, unknown>;
      }
    }

    for (const event of events) {
      const stateBefore = JSON.parse(JSON.stringify(currentState));

      this.applyEventToState(currentState, event);

      const stateAfter = JSON.parse(JSON.stringify(currentState));

      const step: ReplayStep = {
        event,
        stateBefore,
        stateAfter,
        stateDelta: options.includeStateDelta
          ? this.computeDelta(stateBefore, stateAfter)
          : {},
      };

      steps.push(step);
    }

    return {
      sessionId,
      totalEvents: this.eventStore.getEventCount(sessionId),
      replayedEvents: events.length,
      steps,
      finalState: currentState,
      duration: Date.now() - startTime,
    };
  }

  diff(
    sessionId: string,
    sequenceA: number,
    sequenceB: number
  ): DiffResult {
    const projectionA = this.eventStore.projectConversationState(sessionId);
    const stateA = this.rebuildStateAtSequence(sessionId, sequenceA);
    const stateB = this.rebuildStateAtSequence(sessionId, sequenceB);

    const added: Record<string, unknown> = {};
    const removed: Record<string, unknown> = {};
    const changed: Record<string, { before: unknown; after: unknown }> = {};

    const allKeys = new Set([
      ...Object.keys(stateA),
      ...Object.keys(stateB),
    ]);

    for (const key of allKeys) {
      const inA = key in stateA;
      const inB = key in stateB;

      if (inA && !inB) {
        removed[key] = stateA[key];
      } else if (!inA && inB) {
        added[key] = stateB[key];
      } else {
        const valA = JSON.stringify(stateA[key]);
        const valB = JSON.stringify(stateB[key]);
        if (valA !== valB) {
          changed[key] = { before: stateA[key], after: stateB[key] };
        }
      }
    }

    const changeCount = Object.keys(added).length + Object.keys(removed).length + Object.keys(changed).length;

    return {
      sessionId,
      sequenceA,
      sequenceB,
      added,
      removed,
      changed,
      summary: `状态差异: +${Object.keys(added).length} 新增, -${Object.keys(removed).length} 移除, ~${Object.keys(changed).length} 变更 (共 ${changeCount} 处)`,
    };
  }

  exportTrajectory(
    sessionId: string,
    options: TrajectoryExportOptions
  ): string[] {
    const events = this.eventStore.getSessionEvents(sessionId);
    const projection = this.eventStore.projectConversationState(sessionId);

    switch (options.format) {
      case 'sft':
        return this.exportSFT(events, projection, options);
      case 'dpo':
        return this.exportDPO(events, projection, options);
      case 'jsonl':
        return this.exportJSONL(events, options);
      case 'json':
      default:
        return [JSON.stringify(events, null, 2)];
    }
  }

  private rebuildStateAtSequence(
    sessionId: string,
    targetSequence: number
  ): Record<string, unknown> {
    const result = this.eventStore.project(
      sessionId,
      (state, event) => {
        this.applyEventToState(state as Record<string, unknown>, event);
        return state;
      },
      {} as Record<string, unknown>,
      0
    );

    const events = this.eventStore.query({
      sessionId,
      toSequence: targetSequence,
    });

    let state: Record<string, unknown> = {};
    for (const event of events) {
      this.applyEventToState(state, event);
    }

    return state;
  }

  private applyEventToState(
    state: Record<string, unknown>,
    event: EventStoreEvent
  ): void {
    switch (event.eventType) {
      case 'user_input': {
        const messages = (state.messages as Array<{ role: string; content: string; timestamp: number }>) ?? [];
        messages.push({
          role: 'user',
          content: String(event.payload.content ?? event.payload.input ?? ''),
          timestamp: event.timestamp,
        });
        state.messages = messages;
        break;
      }

      case 'agent_thinking': {
        const messages = (state.messages as Array<{ role: string; content: string; timestamp: number }>) ?? [];
        messages.push({
          role: 'assistant',
          content: String(event.payload.thinking ?? event.payload.content ?? ''),
          timestamp: event.timestamp,
        });
        state.messages = messages;
        break;
      }

      case 'tool_result': {
        const toolCalls = (state.toolCalls as Array<{ toolName: string; success: boolean; duration: number }>) ?? [];
        toolCalls.push({
          toolName: String(event.payload.toolName ?? 'unknown'),
          success: Boolean(event.payload.success),
          duration: Number(event.payload.duration ?? 0),
        });
        state.toolCalls = toolCalls;
        break;
      }

      case 'dynamic_tool_defined': {
        const dynamicTools = (state.dynamicTools as string[]) ?? [];
        const name = String(event.payload.name ?? '');
        if (name && !dynamicTools.includes(name)) {
          dynamicTools.push(name);
        }
        state.dynamicTools = dynamicTools;
        break;
      }

      case 'dynamic_tool_undefined': {
        const dynamicTools = (state.dynamicTools as string[]) ?? [];
        const name = String(event.payload.name ?? '');
        state.dynamicTools = dynamicTools.filter((t: string) => t !== name);
        break;
      }

      case 'context_update':
        state = { ...state, ...event.payload };
        break;

      case 'state_transition':
        state._currentState = event.payload.toState;
        break;
    }
  }

  private computeDelta(
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): Record<string, { before: unknown; after: unknown }> {
    const delta: Record<string, { before: unknown; after: unknown }> = {};
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of allKeys) {
      const valBefore = JSON.stringify(before[key]);
      const valAfter = JSON.stringify(after[key]);
      if (valBefore !== valAfter) {
        delta[key] = { before: before[key], after: after[key] };
      }
    }

    return delta;
  }

  private exportSFT(
    events: EventStoreEvent[],
    projection: ProjectionResult<unknown>,
    options: TrajectoryExportOptions
  ): string[] {
    const messages: Array<{ role: string; content: string }> = [];
    let toolCallCount = 0;
    let successCount = 0;

    for (const event of events) {
      switch (event.eventType) {
        case 'user_input':
          messages.push({
            role: 'user',
            content: String(event.payload.content ?? event.payload.input ?? ''),
          });
          break;

        case 'agent_thinking':
          if (options.includeThinking !== false) {
            messages.push({
              role: 'assistant',
              content: String(event.payload.thinking ?? event.payload.content ?? ''),
            });
          }
          break;

        case 'tool_call':
          if (options.includeToolCalls !== false) {
            messages.push({
              role: 'assistant',
              content: `[Tool Call] ${String(event.payload.toolName ?? 'unknown')}(${JSON.stringify(event.payload.args ?? {})})`,
            });
          }
          break;

        case 'tool_result':
          if (options.includeToolCalls !== false) {
            toolCallCount++;
            if (Boolean(event.payload.success)) successCount++;
            messages.push({
              role: 'tool',
              content: String(event.payload.output ?? event.payload.result ?? ''),
            });
          }
          break;

        case 'error_occurred':
          if (options.includeErrors !== false) {
            messages.push({
              role: 'system',
              content: `[Error] ${String(event.payload.message ?? event.payload.error ?? 'unknown error')}`,
            });
          }
          break;
      }
    }

    const entry: SFTEntry = {
      messages,
      metadata: {
        sessionId: events[0]?.sessionId ?? '',
        eventCount: events.length,
        duration: events.length > 0
          ? events[events.length - 1].timestamp - events[0].timestamp
          : 0,
        toolCallCount,
        successRate: toolCallCount > 0 ? successCount / toolCallCount : 0,
      },
    };

    return [JSON.stringify(entry)];
  }

  private exportDPO(
    events: EventStoreEvent[],
    projection: ProjectionResult<unknown>,
    options: TrajectoryExportOptions
  ): string[] {
    const userEvents = events.filter((e) => e.eventType === 'user_input');
    const assistantEvents = events.filter((e) => e.eventType === 'agent_thinking');
    const errorEvents = events.filter((e) => e.eventType === 'error_occurred');

    if (userEvents.length === 0 || assistantEvents.length === 0) {
      return [];
    }

    const chosen: Array<{ role: string; content: string }> = [];
    const rejected: Array<{ role: string; content: string }> = [];

    for (const event of events) {
      if (event.eventType === 'user_input') {
        const content = String(event.payload.content ?? event.payload.input ?? '');
        chosen.push({ role: 'user', content });
        rejected.push({ role: 'user', content });
      } else if (event.eventType === 'agent_thinking') {
        const content = String(event.payload.thinking ?? event.payload.content ?? '');
        chosen.push({ role: 'assistant', content });
      }
    }

    if (errorEvents.length > 0) {
      rejected.push({
        role: 'assistant',
        content: `[Failed] ${errorEvents.map((e) => String(e.payload.message ?? e.payload.error ?? '')).join('; ')}`,
      });
    } else {
      rejected.push({
        role: 'assistant',
        content: '[No response]',
      });
    }

    const qualityScore = errorEvents.length === 0 ? 1.0 : Math.max(0, 1 - errorEvents.length / events.length);

    const entry: DPOEntry = {
      chosen,
      rejected,
      metadata: {
        sessionId: events[0]?.sessionId ?? '',
        qualityScore,
      },
    };

    return [JSON.stringify(entry)];
  }

  private exportJSONL(
    events: EventStoreEvent[],
    _options: TrajectoryExportOptions
  ): string[] {
    return events.map((event) =>
      JSON.stringify({
        eventId: event.eventId,
        sessionId: event.sessionId,
        sequenceNum: event.sequenceNum,
        eventType: event.eventType,
        payload: event.payload,
        metadata: event.metadata,
        timestamp: event.timestamp,
      })
    );
  }

  getSessionSummary(sessionId: string): {
    sessionId: string;
    eventCount: number;
    duration: number;
    messageCount: number;
    toolCallCount: number;
    toolSuccessRate: number;
    dynamicToolCount: number;
    errorCount: number;
    firstEvent: EventStoreEvent | null;
    lastEvent: EventStoreEvent | null;
  } {
    const events = this.eventStore.getSessionEvents(sessionId);
    const projection = this.eventStore.projectConversationState(sessionId);

    const messageEvents = events.filter(
      (e) => e.eventType === 'user_input' || e.eventType === 'agent_thinking'
    );
    const toolResultEvents = events.filter((e) => e.eventType === 'tool_result');
    const successTools = toolResultEvents.filter(
      (e) => Boolean(e.payload.success)
    );
    const errorEvents = events.filter((e) => e.eventType === 'error_occurred');

    return {
      sessionId,
      eventCount: events.length,
      duration:
        events.length > 1
          ? events[events.length - 1].timestamp - events[0].timestamp
          : 0,
      messageCount: messageEvents.length,
      toolCallCount: toolResultEvents.length,
      toolSuccessRate:
        toolResultEvents.length > 0
          ? successTools.length / toolResultEvents.length
          : 0,
      dynamicToolCount: projection.state.dynamicTools?.length ?? 0,
      errorCount: errorEvents.length,
      firstEvent: events[0] ?? null,
      lastEvent: events[events.length - 1] ?? null,
    };
  }
}
