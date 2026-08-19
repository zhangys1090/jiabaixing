
export interface TraceRecord {
  traceId: string;
  eventName: string;
  duration: number;
  success: boolean;
  timestamp: number;
}

export interface TokenUsageRecord {
  traceId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: number;
}

export interface ToolCallRecord {
  traceId: string;
  toolName: string;
  success: boolean;
  duration: number;
  tokenCost?: number;
  timestamp: number;
}

export interface TracePhase {
  phase: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  success?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FullTrace {
  traceId: string;
  startTime: number;
  endTime?: number;
  phases: TracePhase[];
  totalTokens: number;
  totalToolCalls: number;
  status: 'running' | 'completed' | 'failed';
}

export interface TraceStats {
  totalTraces: number;
  successfulTraces: number;
  failedTraces: number;
  averageDuration: number;
  totalTokenUsage: number;
  totalToolCalls: number;
  slowestTraces: TraceRecord[];
  recentTraces: TraceRecord[];
}

export class TraceCollector {
  private activeTraces: Map<string, { eventName: string; startTime: number; metadata?: Record<string, unknown> }> = new Map();
  private traceHistory: TraceRecord[] = [];
  private readonly MAX_TRACE_HISTORY = 1000;

  private tokenUsage: TokenUsageRecord[] = [];
  private readonly MAX_TOKEN_RECORDS = 5000;

  private toolCallRecords: ToolCallRecord[] = [];
  private readonly MAX_TOOL_CALL_RECORDS = 5000;

  private fullTraces: Map<string, FullTrace> = new Map();
  private readonly MAX_FULL_TRACES = 100;

  startTrace(traceId: string, eventName: string, metadata?: Record<string, unknown>): void {
    this.activeTraces.set(traceId, { eventName, startTime: Date.now(), metadata });
  }

  completeTrace(traceId: string, success: boolean = true): TraceRecord | null {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return null;

    const duration = Date.now() - trace.startTime;
    const record: TraceRecord = {
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

  failTrace(traceId: string, error: string): TraceRecord | null {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return null;

    const duration = Date.now() - trace.startTime;
    const record: TraceRecord = {
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

  recordTokenUsage(traceId: string, model: string, promptTokens: number, completionTokens: number): void {
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

  recordToolCall(traceId: string, toolName: string, success: boolean, duration: number): void {
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

  startFullTrace(traceId: string): void {
    if (this.fullTraces.size >= this.MAX_FULL_TRACES) {
      const oldestKey = this.fullTraces.keys().next().value;
      if (oldestKey) this.fullTraces.delete(oldestKey);
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

  addTracePhase(traceId: string, phase: string, metadata?: Record<string, unknown>): void {
    const fullTrace = this.fullTraces.get(traceId);
    if (!fullTrace) return;

    fullTrace.phases.push({
      phase,
      startTime: Date.now(),
      metadata,
    });
  }

  completeTracePhase(traceId: string, phase: string, success: boolean = true): void {
    const fullTrace = this.fullTraces.get(traceId);
    if (!fullTrace) return;

    const phaseInfo = fullTrace.phases.find(p => p.phase === phase && p.endTime === undefined);
    if (phaseInfo) {
      phaseInfo.endTime = Date.now();
      phaseInfo.duration = phaseInfo.endTime - phaseInfo.startTime;
      phaseInfo.success = success;
    }
  }

  completeFullTrace(traceId: string, status: 'completed' | 'failed' = 'completed'): void {
    const fullTrace = this.fullTraces.get(traceId);
    if (!fullTrace) return;

    fullTrace.endTime = Date.now();
    fullTrace.status = status;
  }

  getFullTrace(traceId: string): FullTrace | null {
    return this.fullTraces.get(traceId) || null;
  }

  getFullTraces(): FullTrace[] {
    return Array.from(this.fullTraces.values());
  }

  getTraceStats(): TraceStats {
    const total = this.traceHistory.length;
    const successful = this.traceHistory.filter(t => t.success).length;
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

  getTokenUsageByModel(model: string): TokenUsageRecord[] {
    return this.tokenUsage.filter(t => t.model === model);
  }

  getToolCallStats(): { toolName: string; callCount: number; successRate: number; avgDuration: number }[] {
    const stats = new Map<string, { count: number; success: number; totalDuration: number }>();
    for (const record of this.toolCallRecords) {
      const existing = stats.get(record.toolName) || { count: 0, success: 0, totalDuration: 0 };
      existing.count++;
      if (record.success) existing.success++;
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

  clear(): void {
    this.activeTraces.clear();
    this.traceHistory = [];
    this.tokenUsage = [];
    this.toolCallRecords = [];
    this.fullTraces.clear();
  }
}
