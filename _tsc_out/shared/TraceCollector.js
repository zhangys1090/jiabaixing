"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraceCollector = void 0;
class TraceCollector {
    activeTraces = new Map();
    traceHistory = [];
    MAX_TRACE_HISTORY = 1000;
    tokenUsage = [];
    MAX_TOKEN_RECORDS = 5000;
    toolCallRecords = [];
    MAX_TOOL_CALL_RECORDS = 5000;
    fullTraces = new Map();
    MAX_FULL_TRACES = 100;
    startTrace(traceId, eventName, metadata) {
        this.activeTraces.set(traceId, {
            eventName,
            startTime: Date.now(),
            metadata,
        });
    }
    completeTrace(traceId, success = true) {
        const trace = this.activeTraces.get(traceId);
        if (!trace)
            return null;
        const duration = Date.now() - trace.startTime;
        const record = {
            traceId,
            eventName: trace.eventName,
            duration,
            success,
            timestamp: Date.now(),
        };
        this.traceHistory.push(record);
        if (this.traceHistory.length > this.MAX_TRACE_HISTORY) {
            this.traceHistory = this.traceHistory.slice(-this.MAX_TRACE_HISTORY);
        }
        this.activeTraces.delete(traceId);
        return record;
    }
    failTrace(traceId, _error) {
        const trace = this.activeTraces.get(traceId);
        if (!trace)
            return null;
        const duration = Date.now() - trace.startTime;
        const record = {
            traceId,
            eventName: trace.eventName,
            duration,
            success: false,
            timestamp: Date.now(),
        };
        this.traceHistory.push(record);
        if (this.traceHistory.length > this.MAX_TRACE_HISTORY) {
            this.traceHistory = this.traceHistory.slice(-this.MAX_TRACE_HISTORY);
        }
        this.activeTraces.delete(traceId);
        return record;
    }
    recordTokenUsage(traceId, model, promptTokens, completionTokens) {
        this.tokenUsage.push({
            traceId,
            model,
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            timestamp: Date.now(),
        });
        if (this.tokenUsage.length > this.MAX_TOKEN_RECORDS) {
            this.tokenUsage = this.tokenUsage.slice(-this.MAX_TOKEN_RECORDS);
        }
        const fullTrace = this.fullTraces.get(traceId);
        if (fullTrace) {
            fullTrace.totalTokens += promptTokens + completionTokens;
        }
    }
    recordToolCall(traceId, toolName, success, duration) {
        this.toolCallRecords.push({
            traceId,
            toolName,
            success,
            duration,
            timestamp: Date.now(),
        });
        if (this.toolCallRecords.length > this.MAX_TOOL_CALL_RECORDS) {
            this.toolCallRecords = this.toolCallRecords.slice(-this.MAX_TOOL_CALL_RECORDS);
        }
        const fullTrace = this.fullTraces.get(traceId);
        if (fullTrace) {
            fullTrace.totalToolCalls++;
        }
    }
    startFullTrace(traceId) {
        if (this.fullTraces.size >= this.MAX_FULL_TRACES) {
            const oldestKey = this.fullTraces.keys().next().value;
            if (oldestKey)
                this.fullTraces.delete(oldestKey);
        }
        this.fullTraces.set(traceId, {
            traceId,
            startTime: Date.now(),
            phases: [],
            totalTokens: 0,
            totalToolCalls: 0,
            status: 'running',
        });
    }
    addTracePhase(traceId, phase, metadata) {
        const fullTrace = this.fullTraces.get(traceId);
        if (!fullTrace)
            return;
        fullTrace.phases.push({
            phase,
            startTime: Date.now(),
            metadata,
        });
    }
    completeTracePhase(traceId, phase, success = true) {
        const fullTrace = this.fullTraces.get(traceId);
        if (!fullTrace)
            return;
        const phaseInfo = fullTrace.phases.find((p) => p.phase === phase && p.endTime === undefined);
        if (phaseInfo) {
            phaseInfo.endTime = Date.now();
            phaseInfo.duration = phaseInfo.endTime - phaseInfo.startTime;
            phaseInfo.success = success;
        }
    }
    completeFullTrace(traceId, status = 'completed') {
        const fullTrace = this.fullTraces.get(traceId);
        if (!fullTrace)
            return;
        fullTrace.endTime = Date.now();
        fullTrace.status = status;
    }
    getFullTrace(traceId) {
        return this.fullTraces.get(traceId) || null;
    }
    getFullTraces() {
        return Array.from(this.fullTraces.values());
    }
    getTraceStats() {
        const total = this.traceHistory.length;
        const successful = this.traceHistory.filter((t) => t.success).length;
        const failed = total - successful;
        const avgDuration = total > 0
            ? this.traceHistory.reduce((sum, t) => sum + t.duration, 0) / total
            : 0;
        const totalTokens = this.tokenUsage.reduce((sum, t) => sum + t.totalTokens, 0);
        const totalToolCalls = this.toolCallRecords.length;
        const slowestTraces = [...this.traceHistory]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 10);
        const recentTraces = this.traceHistory.slice(-20);
        return {
            totalTraces: total,
            successfulTraces: successful,
            failedTraces: failed,
            averageDuration: avgDuration,
            totalTokenUsage: totalTokens,
            totalToolCalls,
            slowestTraces,
            recentTraces,
        };
    }
    getTokenUsageByModel(model) {
        return this.tokenUsage.filter((t) => t.model === model);
    }
    getToolCallStats() {
        const stats = new Map();
        for (const record of this.toolCallRecords) {
            const existing = stats.get(record.toolName) || {
                count: 0,
                success: 0,
                totalDuration: 0,
            };
            existing.count++;
            if (record.success)
                existing.success++;
            existing.totalDuration += record.duration;
            stats.set(record.toolName, existing);
        }
        return Array.from(stats.entries()).map(([toolName, s]) => ({
            toolName,
            callCount: s.count,
            successRate: s.count > 0 ? s.success / s.count : 0,
            avgDuration: s.count > 0 ? s.totalDuration / s.count : 0,
        }));
    }
    clear() {
        this.activeTraces.clear();
        this.traceHistory = [];
        this.tokenUsage = [];
        this.toolCallRecords = [];
        this.fullTraces.clear();
    }
}
exports.TraceCollector = TraceCollector;
