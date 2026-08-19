import type { ToolResult } from '../../types';
import type { CircuitBreakerState } from './ToolRegistry';

export interface SemaphoreState {
  permits: number;
  waiters: Array<() => void>;
}

export interface QuotaRecord {
  date: string;
  count: number;
}

export interface ToolRuntimeState {
  getCircuitBreaker(toolName: string): CircuitBreakerState | undefined;
  setCircuitBreaker(toolName: string, state: CircuitBreakerState): void;
  getSemaphore(agentKey: string): SemaphoreState | undefined;
  setSemaphore(agentKey: string, sem: SemaphoreState): void;
  getQuota(key: string): QuotaRecord | undefined;
  setQuota(key: string, record: QuotaRecord): void;
  getDedupResult(dedupKey: string): ToolResult | undefined;
  setDedupResult(dedupKey: string, result: ToolResult): void;
  clear(): void;
}

export class InMemoryToolRuntimeState implements ToolRuntimeState {
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private semaphores: Map<string, SemaphoreState> = new Map();
  private quotaCounters: Map<string, QuotaRecord> = new Map();
  private dedupCache: Map<string, ToolResult> = new Map();

  getCircuitBreaker(toolName: string): CircuitBreakerState | undefined {
    return this.circuitBreakers.get(toolName);
  }

  setCircuitBreaker(toolName: string, state: CircuitBreakerState): void {
    this.circuitBreakers.set(toolName, state);
  }

  getSemaphore(agentKey: string): SemaphoreState | undefined {
    return this.semaphores.get(agentKey);
  }

  setSemaphore(agentKey: string, sem: SemaphoreState): void {
    this.semaphores.set(agentKey, sem);
  }

  getQuota(key: string): QuotaRecord | undefined {
    return this.quotaCounters.get(key);
  }

  setQuota(key: string, record: QuotaRecord): void {
    this.quotaCounters.set(key, record);
  }

  getDedupResult(dedupKey: string): ToolResult | undefined {
    return this.dedupCache.get(dedupKey);
  }

  setDedupResult(dedupKey: string, result: ToolResult): void {
    this.dedupCache.set(dedupKey, result);
  }

  clear(): void {
    this.circuitBreakers.clear();
    this.semaphores.clear();
    this.quotaCounters.clear();
    this.dedupCache.clear();
  }
}
