"use strict";
/**
 * Harness Layer 4: SessionReplay — 会话回放服务
 *
 * 基于 EventStore 的 append-only 事件流，提供会话回放能力：
 * - 时间旅行：回到任意序列号查看 Agent 状态
 * - 逐步回放：逐事件重建上下文，观察状态变迁
 * - 差异分析：比较两个时间点的状态差异
 * - 轨迹导出：将会话事件流导出为 SFT 训练格式
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionReplay = void 0;
class SessionReplay {
    eventStore;
    constructor(eventStore) {
        this.eventStore = eventStore;
    }
    replaySession(sessionId, options = {}) {
        const startTime = Date.now();
        const events = this.eventStore.query({
            sessionId,
            fromSequence: options.fromSequence,
            toSequence: options.toSequence,
            eventTypes: options.eventFilter,
        });
        const steps = [];
        let currentState = {};
        if (options.fromSequence && options.fromSequence > 1) {
            const priorProjection = this.eventStore.projectConversationState(sessionId);
            if (priorProjection.lastSequenceNum < options.fromSequence) {
                currentState = priorProjection.state;
            }
        }
        for (const event of events) {
            const stateBefore = JSON.parse(JSON.stringify(currentState));
            this.applyEventToState(currentState, event);
            const stateAfter = JSON.parse(JSON.stringify(currentState));
            const step = {
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
    diff(sessionId, sequenceA, sequenceB) {
        const _projectionA = this.eventStore.projectConversationState(sessionId);
        const stateA = this.rebuildStateAtSequence(sessionId, sequenceA);
        const stateB = this.rebuildStateAtSequence(sessionId, sequenceB);
        const added = {};
        const removed = {};
        const changed = {};
        const allKeys = new Set([...Object.keys(stateA), ...Object.keys(stateB)]);
        for (const key of allKeys) {
            const inA = key in stateA;
            const inB = key in stateB;
            if (inA && !inB) {
                removed[key] = stateA[key];
            }
            else if (!inA && inB) {
                added[key] = stateB[key];
            }
            else {
                const valA = JSON.stringify(stateA[key]);
                const valB = JSON.stringify(stateB[key]);
                if (valA !== valB) {
                    changed[key] = { before: stateA[key], after: stateB[key] };
                }
            }
        }
        const changeCount = Object.keys(added).length +
            Object.keys(removed).length +
            Object.keys(changed).length;
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
    exportTrajectory(sessionId, options) {
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
    rebuildStateAtSequence(sessionId, targetSequence) {
        const _result = this.eventStore.project(sessionId, (state, event) => {
            this.applyEventToState(state, event);
            return state;
        }, {}, 0);
        const events = this.eventStore.query({
            sessionId,
            toSequence: targetSequence,
        });
        let state = {};
        for (const event of events) {
            this.applyEventToState(state, event);
        }
        return state;
    }
    applyEventToState(state, event) {
        switch (event.eventType) {
            case 'user_input': {
                const messages = state.messages ?? [];
                messages.push({
                    role: 'user',
                    content: String(event.payload.content ?? event.payload.input ?? ''),
                    timestamp: event.timestamp,
                });
                state.messages = messages;
                break;
            }
            case 'agent_thinking': {
                const messages = state.messages ?? [];
                messages.push({
                    role: 'assistant',
                    content: String(event.payload.thinking ?? event.payload.content ?? ''),
                    timestamp: event.timestamp,
                });
                state.messages = messages;
                break;
            }
            case 'tool_result': {
                const toolCalls = state.toolCalls ?? [];
                toolCalls.push({
                    toolName: String(event.payload.toolName ?? 'unknown'),
                    success: Boolean(event.payload.success),
                    duration: Number(event.payload.duration ?? 0),
                });
                state.toolCalls = toolCalls;
                break;
            }
            case 'dynamic_tool_defined': {
                const dynamicTools = state.dynamicTools ?? [];
                const name = String(event.payload.name ?? '');
                if (name && !dynamicTools.includes(name)) {
                    dynamicTools.push(name);
                }
                state.dynamicTools = dynamicTools;
                break;
            }
            case 'dynamic_tool_undefined': {
                const dynamicTools = state.dynamicTools ?? [];
                const name = String(event.payload.name ?? '');
                state.dynamicTools = dynamicTools.filter((t) => t !== name);
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
    computeDelta(before, after) {
        const delta = {};
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
    exportSFT(events, projection, options) {
        const messages = [];
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
                        if (Boolean(event.payload.success))
                            successCount++;
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
        const entry = {
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
    exportDPO(events, _projection, _options) {
        const userEvents = events.filter((e) => e.eventType === 'user_input');
        const assistantEvents = events.filter((e) => e.eventType === 'agent_thinking');
        const errorEvents = events.filter((e) => e.eventType === 'error_occurred');
        if (userEvents.length === 0 || assistantEvents.length === 0) {
            return [];
        }
        const chosen = [];
        const rejected = [];
        for (const event of events) {
            if (event.eventType === 'user_input') {
                const content = String(event.payload.content ?? event.payload.input ?? '');
                chosen.push({ role: 'user', content });
                rejected.push({ role: 'user', content });
            }
            else if (event.eventType === 'agent_thinking') {
                const content = String(event.payload.thinking ?? event.payload.content ?? '');
                chosen.push({ role: 'assistant', content });
            }
        }
        if (errorEvents.length > 0) {
            rejected.push({
                role: 'assistant',
                content: `[Failed] ${errorEvents.map((e) => String(e.payload.message ?? e.payload.error ?? '')).join('; ')}`,
            });
        }
        else {
            rejected.push({
                role: 'assistant',
                content: '[No response]',
            });
        }
        const qualityScore = errorEvents.length === 0
            ? 1.0
            : Math.max(0, 1 - errorEvents.length / events.length);
        const entry = {
            chosen,
            rejected,
            metadata: {
                sessionId: events[0]?.sessionId ?? '',
                qualityScore,
            },
        };
        return [JSON.stringify(entry)];
    }
    exportJSONL(events, _options) {
        return events.map((event) => JSON.stringify({
            eventId: event.eventId,
            sessionId: event.sessionId,
            sequenceNum: event.sequenceNum,
            eventType: event.eventType,
            payload: event.payload,
            metadata: event.metadata,
            timestamp: event.timestamp,
        }));
    }
    getSessionSummary(sessionId) {
        const events = this.eventStore.getSessionEvents(sessionId);
        const projection = this.eventStore.projectConversationState(sessionId);
        const messageEvents = events.filter((e) => e.eventType === 'user_input' || e.eventType === 'agent_thinking');
        const toolResultEvents = events.filter((e) => e.eventType === 'tool_result');
        const successTools = toolResultEvents.filter((e) => Boolean(e.payload.success));
        const errorEvents = events.filter((e) => e.eventType === 'error_occurred');
        return {
            sessionId,
            eventCount: events.length,
            duration: events.length > 1
                ? events[events.length - 1].timestamp - events[0].timestamp
                : 0,
            messageCount: messageEvents.length,
            toolCallCount: toolResultEvents.length,
            toolSuccessRate: toolResultEvents.length > 0
                ? successTools.length / toolResultEvents.length
                : 0,
            dynamicToolCount: projection.state.dynamicTools?.length ?? 0,
            errorCount: errorEvents.length,
            firstEvent: events[0] ?? null,
            lastEvent: events[events.length - 1] ?? null,
        };
    }
}
exports.SessionReplay = SessionReplay;
