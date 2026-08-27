/**
 * DistillationPipeline — 蒸馏管道
 *
 * Phase 3: 从 EventStore 事件流和 TrajectoryDatabase 轨迹数据中
 * 生成高质量训练数据，支持 SFT / DPO / RLHF 格式。
 *
 * 增强点（相比现有 TrajectoryExporter）：
 * - 从 EventStore 溯源，而非仅 TrajectoryDatabase
 * - 质量标注自动打分（QualityAnnotator 集成）
 * - 多维度过滤（质量/长度/多样性/去重）
 * - 工具调用轨迹结构化（tool_call + tool_result 配对）
 * - 支持思维链（CoT）标注
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/Logger';
import type { EventStore, EventStoreEvent } from '../persistence/EventStore';
import type { AnnotatedTrajectory, QualityAnnotator } from './QualityAnnotator';

export type DistillationFormat = 'sft' | 'dpo' | 'rlhf' | 'sharegpt' | 'jsonl';

export interface DistillationConfig {
  format: DistillationFormat;
  minQuality: number;
  maxQuality: number;
  minSteps: number;
  maxSteps: number;
  includeToolCalls: boolean;
  includeThinking: boolean;
  includeErrors: boolean;
  deduplicate: boolean;
  maxTokensPerEntry: number;
  qualityAnnotator?: QualityAnnotator;
}

export interface DistilledEntry {
  id: string;
  format: DistillationFormat;
  data: unknown;
  quality: number;
  metadata: {
    sessionId: string;
    eventCount: number;
    toolCallCount: number;
    duration: number;
    source: string;
  };
}

export interface DistillationResult {
  totalSessions: number;
  totalEntries: number;
  filteredOut: number;
  avgQuality: number;
  entries: DistilledEntry[];
  stats: {
    byFormat: Record<string, number>;
    byQualityRange: Record<string, number>;
    byToolCount: Record<string, number>;
  };
}

export interface SFTEntry {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  metadata: {
    sessionId: string;
    quality: number;
    toolCallCount: number;
    duration: number;
  };
}

export interface DPOEntry {
  chosen: Array<{ role: string; content: string }>;
  rejected: Array<{ role: string; content: string }>;
  preference: number;
  metadata: {
    sessionId: string;
    qualityChosen: number;
    qualityRejected: number;
  };
}

export interface RLHFEntry {
  prompt: Array<{ role: string; content: string }>;
  completions: Array<{
    messages: Array<{ role: string; content: string }>;
    quality: number;
  }>;
  metadata: {
    sessionId: string;
  };
}

const DEFAULT_CONFIG: DistillationConfig = {
  format: 'sft',
  minQuality: 0.5,
  maxQuality: 1.0,
  minSteps: 2,
  maxSteps: 100,
  includeToolCalls: true,
  includeThinking: true,
  includeErrors: false,
  deduplicate: true,
  maxTokensPerEntry: 4096,
};

export class DistillationPipeline {
  private config: DistillationConfig;
  private eventStore: EventStore | null;
  private seenHashes: Set<string> = new Set();

  constructor(
    eventStore: EventStore | null,
    config: Partial<DistillationConfig> = {}
  ) {
    this.eventStore = eventStore;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async distill(sessionIds?: string[]): Promise<DistillationResult> {
    const startTime = Date.now();
    const entries: DistilledEntry[] = [];
    let filteredOut = 0;

    const sessions = sessionIds ?? this.getAvailableSessions();

    for (const sessionId of sessions) {
      const sessionEntries = await this.distillSession(sessionId);

      for (const entry of sessionEntries) {
        if (this.shouldFilter(entry)) {
          filteredOut++;
          continue;
        }

        if (this.config.deduplicate && this.isDuplicate(entry)) {
          filteredOut++;
          continue;
        }

        entries.push(entry);
      }
    }

    const avgQuality =
      entries.length > 0
        ? entries.reduce((sum, e) => sum + e.quality, 0) / entries.length
        : 0;

    const result: DistillationResult = {
      totalSessions: sessions.length,
      totalEntries: entries.length,
      filteredOut,
      avgQuality,
      entries,
      stats: this.computeStats(entries),
    };

    Logger.info(
      `DistillationPipeline: 蒸馏完成, ${entries.length} 条 / ${filteredOut} 过滤 / ${sessions.length} 会话 / ${Date.now() - startTime}ms`,
      'DistillationPipeline'
    );

    return result;
  }

  async distillSession(sessionId: string): Promise<DistilledEntry[]> {
    if (!this.eventStore) return [];

    const events = this.eventStore.getSessionEvents(sessionId);
    if (events.length < this.config.minSteps) return [];

    const annotated = this.config.qualityAnnotator
      ? this.config.qualityAnnotator.annotate(events)
      : this.fallbackAnnotate(events);

    if (
      annotated.quality < this.config.minQuality ||
      annotated.quality > this.config.maxQuality
    ) {
      return [];
    }

    const entry = this.convertToFormat(annotated, sessionId);
    if (!entry) return [];

    return [entry];
  }

  exportToFile(result: DistillationResult, filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    switch (this.config.format) {
      case 'jsonl':
      case 'sft':
      case 'dpo':
      case 'rlhf': {
        const lines = result.entries.map((e) => JSON.stringify(e.data));
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        break;
      }
      case 'sharegpt': {
        const data = result.entries.map((e) => e.data);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        break;
      }
    }

    Logger.info(
      `DistillationPipeline: 已导出 ${result.entries.length} 条到 ${filePath}`,
      'DistillationPipeline'
    );
  }

  private convertToFormat(
    annotated: AnnotatedTrajectory,
    sessionId: string
  ): DistilledEntry | null {
    const events = annotated.events;
    const quality = annotated.quality;

    switch (this.config.format) {
      case 'sft':
        return this.convertToSFT(events, sessionId, quality);
      case 'dpo':
        return this.convertToDPO(events, sessionId, quality);
      case 'rlhf':
        return this.convertToRLHF(events, sessionId, quality);
      case 'sharegpt':
        return this.convertToShareGPT(events, sessionId, quality);
      case 'jsonl':
        return this.convertToJSONL(events, sessionId, quality);
      default:
        return null;
    }
  }

  private convertToSFT(
    events: EventStoreEvent[],
    sessionId: string,
    quality: number
  ): DistilledEntry {
    const messages: SFTEntry['messages'] = [];
    let toolCallCount = 0;
    let toolCallIdCounter = 0;
    const startTime = events[0]?.timestamp ?? Date.now();
    const endTime = events[events.length - 1]?.timestamp ?? Date.now();

    for (const event of events) {
      switch (event.eventType) {
        case 'user_input':
          messages.push({
            role: 'user',
            content: String(event.payload.content ?? event.payload.input ?? ''),
          });
          break;

        case 'agent_thinking':
          if (this.config.includeThinking) {
            messages.push({
              role: 'assistant',
              content: String(
                event.payload.thinking ?? event.payload.content ?? ''
              ),
            });
          }
          break;

        case 'tool_call':
          if (this.config.includeToolCalls) {
            toolCallCount++;
            toolCallIdCounter++;
            messages.push({
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: `call_${toolCallIdCounter}`,
                  type: 'function' as const,
                  function: {
                    name: String(event.payload.toolName ?? 'unknown'),
                    arguments: JSON.stringify(event.payload.args ?? {}),
                  },
                },
              ],
            });
          }
          break;

        case 'tool_result':
          if (this.config.includeToolCalls) {
            messages.push({
              role: 'tool',
              content: String(
                event.payload.output ?? event.payload.result ?? ''
              ),
              tool_call_id: `call_${toolCallIdCounter}`,
            });
          }
          break;

        case 'error_occurred':
          if (this.config.includeErrors) {
            messages.push({
              role: 'system',
              content: `[Error] ${String(event.payload.message ?? event.payload.error ?? '')}`,
            });
          }
          break;
      }
    }

    const data: SFTEntry = {
      messages,
      metadata: {
        sessionId,
        quality,
        toolCallCount,
        duration: endTime - startTime,
      },
    };

    return {
      id: `sft_${sessionId}_${Date.now()}`,
      format: 'sft',
      data,
      quality,
      metadata: {
        sessionId,
        eventCount: events.length,
        toolCallCount,
        duration: endTime - startTime,
        source: 'EventStore',
      },
    };
  }

  private convertToDPO(
    events: EventStoreEvent[],
    sessionId: string,
    quality: number
  ): DistilledEntry {
    const chosen: Array<{ role: string; content: string }> = [];
    const rejected: Array<{ role: string; content: string }> = [];
    const errorEvents = events.filter((e) => e.eventType === 'error_occurred');

    for (const event of events) {
      if (event.eventType === 'user_input') {
        const content = String(
          event.payload.content ?? event.payload.input ?? ''
        );
        chosen.push({ role: 'user', content });
        rejected.push({ role: 'user', content });
      } else if (event.eventType === 'agent_thinking') {
        const content = String(
          event.payload.thinking ?? event.payload.content ?? ''
        );
        chosen.push({ role: 'assistant', content });
      }
    }

    if (errorEvents.length > 0) {
      rejected.push({
        role: 'assistant',
        content: `[Failed] ${errorEvents.map((e) => String(e.payload.message ?? e.payload.error ?? '')).join('; ')}`,
      });
    } else {
      rejected.push({ role: 'assistant', content: '[No response]' });
    }

    const data: DPOEntry = {
      chosen,
      rejected,
      preference: quality,
      metadata: {
        sessionId,
        qualityChosen: quality,
        qualityRejected: Math.max(0, quality - 0.3),
      },
    };

    return {
      id: `dpo_${sessionId}_${Date.now()}`,
      format: 'dpo',
      data,
      quality,
      metadata: {
        sessionId,
        eventCount: events.length,
        toolCallCount: 0,
        duration: 0,
        source: 'EventStore',
      },
    };
  }

  private convertToRLHF(
    events: EventStoreEvent[],
    sessionId: string,
    quality: number
  ): DistilledEntry {
    const prompt: Array<{ role: string; content: string }> = [];
    const completion: Array<{ role: string; content: string }> = [];

    let foundFirstAssistant = false;
    for (const event of events) {
      if (event.eventType === 'user_input') {
        prompt.push({
          role: 'user',
          content: String(event.payload.content ?? event.payload.input ?? ''),
        });
      } else if (event.eventType === 'agent_thinking' && !foundFirstAssistant) {
        foundFirstAssistant = true;
      }

      if (foundFirstAssistant && event.eventType === 'agent_thinking') {
        completion.push({
          role: 'assistant',
          content: String(
            event.payload.thinking ?? event.payload.content ?? ''
          ),
        });
      }
    }

    const data: RLHFEntry = {
      prompt,
      completions: [{ messages: completion, quality }],
      metadata: { sessionId },
    };

    return {
      id: `rlhf_${sessionId}_${Date.now()}`,
      format: 'rlhf',
      data,
      quality,
      metadata: {
        sessionId,
        eventCount: events.length,
        toolCallCount: 0,
        duration: 0,
        source: 'EventStore',
      },
    };
  }

  private convertToShareGPT(
    events: EventStoreEvent[],
    sessionId: string,
    quality: number
  ): DistilledEntry {
    const conversations: Array<{
      from: 'human' | 'gpt' | 'system';
      value: string;
    }> = [];

    for (const event of events) {
      if (event.eventType === 'user_input') {
        conversations.push({
          from: 'human',
          value: String(event.payload.content ?? event.payload.input ?? ''),
        });
      } else if (event.eventType === 'agent_thinking') {
        conversations.push({
          from: 'gpt',
          value: String(event.payload.thinking ?? event.payload.content ?? ''),
        });
      }
    }

    return {
      id: `sharegpt_${sessionId}_${Date.now()}`,
      format: 'sharegpt',
      data: { conversations },
      quality,
      metadata: {
        sessionId,
        eventCount: events.length,
        toolCallCount: 0,
        duration: 0,
        source: 'EventStore',
      },
    };
  }

  private convertToJSONL(
    events: EventStoreEvent[],
    sessionId: string,
    quality: number
  ): DistilledEntry {
    return {
      id: `jsonl_${sessionId}_${Date.now()}`,
      format: 'jsonl',
      data: events.map((e) => ({
        eventType: e.eventType,
        payload: e.payload,
        timestamp: e.timestamp,
      })),
      quality,
      metadata: {
        sessionId,
        eventCount: events.length,
        toolCallCount: 0,
        duration: 0,
        source: 'EventStore',
      },
    };
  }

  private shouldFilter(entry: DistilledEntry): boolean {
    if (entry.quality < this.config.minQuality) return true;
    if (entry.quality > this.config.maxQuality) return true;
    if (entry.metadata.eventCount < this.config.minSteps) return true;
    if (entry.metadata.eventCount > this.config.maxSteps) return true;
    return false;
  }

  private isDuplicate(entry: DistilledEntry): boolean {
    const hash = this.computeHash(entry);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    return false;
  }

  private computeHash(entry: DistilledEntry): string {
    const content = JSON.stringify(entry.data);
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(36);
  }

  private fallbackAnnotate(events: EventStoreEvent[]): AnnotatedTrajectory {
    const userEvents = events.filter((e) => e.eventType === 'user_input');
    const toolResultEvents = events.filter(
      (e) => e.eventType === 'tool_result'
    );
    const errorEvents = events.filter((e) => e.eventType === 'error_occurred');
    const successTools = toolResultEvents.filter((e) =>
      Boolean(e.payload.success)
    );

    const toolSuccessRate =
      toolResultEvents.length > 0
        ? successTools.length / toolResultEvents.length
        : 1.0;

    const errorPenalty = Math.min(0.3, errorEvents.length * 0.1);
    const quality = Math.max(
      0,
      Math.min(1, toolSuccessRate - errorPenalty + 0.2)
    );

    return {
      events,
      quality,
      labels: {
        taskCompletion: toolSuccessRate,
        toolEfficiency:
          toolResultEvents.length > 0
            ? successTools.length / toolResultEvents.length
            : 0.5,
        errorRate: errorEvents.length / Math.max(1, events.length),
        coherence: 0.7,
        usefulness: quality,
      },
      annotations: [],
    };
  }

  private getAvailableSessions(): string[] {
    if (!this.eventStore) return [];
    return [];
  }

  private computeStats(entries: DistilledEntry[]): DistillationResult['stats'] {
    const byFormat: Record<string, number> = {};
    const byQualityRange: Record<string, number> = {};
    const byToolCount: Record<string, number> = {};

    for (const entry of entries) {
      byFormat[entry.format] = (byFormat[entry.format] ?? 0) + 1;

      const qRange =
        entry.quality >= 0.8 ? 'high' : entry.quality >= 0.5 ? 'medium' : 'low';
      byQualityRange[qRange] = (byQualityRange[qRange] ?? 0) + 1;

      const tRange =
        entry.metadata.toolCallCount > 5
          ? 'many'
          : entry.metadata.toolCallCount > 0
            ? 'some'
            : 'none';
      byToolCount[tRange] = (byToolCount[tRange] ?? 0) + 1;
    }

    return { byFormat, byQualityRange, byToolCount };
  }
}
