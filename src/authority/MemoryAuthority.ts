import { Logger } from '../utils/Logger';

function generateMemoryOpId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `MO_${ts}_${rand}`;
}

export interface MemoryAuthorityTrace {
  readonly operationId: string;
  readonly operation: 'store' | 'retrieve' | 'delete' | 'consolidate';
  readonly memoryType: MemoryDomain;
  readonly goalId: string | null;
  readonly decisionId: string | null;
  readonly snapshotId: string | null;
  readonly source: 'python' | 'ts_bridge' | 'ts_local' | 'failed_closed';
  readonly timestamp: number;
}

export type MemoryDomain =
  | 'short_term'
  | 'long_term'
  | 'episodic'
  | 'persistent_hermes'
  | 'cross_session'
  | 'visual'
  | 'tool_selection'
  | 'feedback';

export interface CanonicalMemoryOwner {
  readonly domain: MemoryDomain;
  readonly process: 'python' | 'ts_bridge';
  readonly description: string;
}

export interface MemoryWriteRequest {
  content: string;
  memoryType: MemoryDomain;
  goalId?: string;
  decisionId?: string;
  snapshotId?: string;
  scene?: string;
  emotion?: string;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryReadRequest {
  query: string;
  memoryType?: MemoryDomain;
  goalId?: string;
  limit?: number;
  scene?: string;
  emotion?: string;
}

export interface MemoryWriteResult {
  success: boolean;
  memoryId: string;
  operationId: string;
  source: 'python' | 'ts_bridge' | 'ts_local' | 'failed_closed';
}

export interface MemoryReadResult {
  items: Array<{
    id: string;
    content: string;
    memoryType: MemoryDomain;
    relevanceScore: number;
    timestamp: number;
  }>;
  operationId: string;
  source: 'python' | 'ts_bridge' | 'ts_local' | 'failed_closed';
}

export interface RogueStoreReport {
  filePath: string;
  className: string;
  domain: MemoryDomain;
  issue: string;
  recommendation: 'bridge_to_python' | 'deprecate' | 'keep_as_local_cache';
}

const CANONICAL_OWNERS: ReadonlyArray<CanonicalMemoryOwner> = [
  { domain: 'short_term', process: 'python', description: 'Python MemoryEngine.storeShortTerm' },
  { domain: 'long_term', process: 'python', description: 'Python MemoryEngine.storeLongTerm' },
  { domain: 'episodic', process: 'python', description: 'Python EpisodicMemoryStore' },
  { domain: 'cross_session', process: 'python', description: 'Python CrossSessionMemory' },
  { domain: 'visual', process: 'python', description: 'Python VisualMemory' },
  { domain: 'tool_selection', process: 'python', description: 'Python ToolSelectionMemory' },
  { domain: 'feedback', process: 'python', description: 'Python MemoryEngine.storeFeedbackSignal' },
  { domain: 'persistent_hermes', process: 'ts_bridge', description: 'TS PersistentMemoryService bridged to Python' },
];

const ROGUE_STORES: ReadonlyArray<RogueStoreReport> = [
  {
    filePath: 'src/memory/EpisodicMemoryStore.ts',
    className: 'EpisodicMemoryStore',
    domain: 'episodic',
    issue: 'Local JSON file storage bypasses Python canonical EpisodicMemoryStore',
    recommendation: 'bridge_to_python',
  },
  {
    filePath: 'src/memory/PersistentMemoryService.ts',
    className: 'PersistentMemoryService',
    domain: 'persistent_hermes',
    issue: 'MEMORY.md/USER.md file-based storage not bridged to Python',
    recommendation: 'bridge_to_python',
  },
  {
    filePath: 'src/memory/MemoryRetriever.ts',
    className: 'MemoryRetriever',
    domain: 'short_term',
    issue: 'Imports deprecated ShortTermMemory/LongTermMemory, not imported by anyone',
    recommendation: 'deprecate',
  },
];

export interface LocalFallbackStore {
  storeShortTermMemory: (content: string, scene: string, emotion: string) => Promise<unknown>;
  storeLongTermMemory: (content: string, scene: string, emotion: string) => Promise<unknown>;
  storeInstantMemory: (content: string, scene: string, emotion: string) => Promise<unknown>;
  storeFeedbackSignal: (data: { feedbackType: string; rating?: number; message?: string; traceId?: string; toolName?: string; userId?: string; timestamp?: number }) => Promise<unknown>;
  preciseHybridRetrieval: (query: string, scene?: string, emotion?: string, topK?: number) => Promise<unknown>;
}

export class MemoryAuthority {
  private static instance: MemoryAuthority | null = null;
  private operationLog: MemoryAuthorityTrace[] = [];
  private readonly MAX_OPERATION_LOG = 2000;
  private bridgeAvailable: boolean = false;
  private pythonWriteFn: ((req: MemoryWriteRequest) => Promise<MemoryWriteResult>) | null = null;
  private pythonReadFn: ((req: MemoryReadRequest) => Promise<MemoryReadResult>) | null = null;
  private localFallback: LocalFallbackStore | null = null;

  private constructor() {}

  public static getInstance(): MemoryAuthority {
    if (!MemoryAuthority.instance) {
      MemoryAuthority.instance = new MemoryAuthority();
    }
    return MemoryAuthority.instance;
  }

  public static resetInstance(): void {
    MemoryAuthority.instance = null;
  }

  public registerBridge(
    writeFn: (req: MemoryWriteRequest) => Promise<MemoryWriteResult>,
    readFn: (req: MemoryReadRequest) => Promise<MemoryReadResult>
  ): void {
    this.pythonWriteFn = writeFn;
    this.pythonReadFn = readFn;
    this.bridgeAvailable = true;
    Logger.info('MemoryAuthority: Python bridge registered', 'MemoryAuthority');
  }

  public registerLocalFallback(store: LocalFallbackStore): void {
    this.localFallback = store;
    Logger.info('MemoryAuthority: local fallback store registered (TS MemoryEngine)', 'MemoryAuthority');
  }

  public getLocalFallback(): LocalFallbackStore | null {
    return this.localFallback;
  }

  public isBridgeAvailable(): boolean {
    return this.bridgeAvailable;
  }

  public getCanonicalOwner(domain: MemoryDomain): CanonicalMemoryOwner | undefined {
    return CANONICAL_OWNERS.find((o) => o.domain === domain);
  }

  public getAllCanonicalOwners(): ReadonlyArray<CanonicalMemoryOwner> {
    return CANONICAL_OWNERS;
  }

  public getRogueStores(): ReadonlyArray<RogueStoreReport> {
    return ROGUE_STORES;
  }

  public async write(request: MemoryWriteRequest): Promise<MemoryWriteResult> {
    const operationId = generateMemoryOpId();
    const canonicalOwner = this.getCanonicalOwner(request.memoryType);

    if (!canonicalOwner) {
      Logger.warn(`MemoryAuthority: unknown domain "${request.memoryType}"`, 'MemoryAuthority');
      return { success: false, memoryId: '', operationId, source: 'ts_local' };
    }

    if (canonicalOwner.process === 'python' && this.pythonWriteFn) {
      try {
        const result = await this.pythonWriteFn(request);
        this.recordTrace({
          operationId,
          operation: 'store',
          memoryType: request.memoryType,
          goalId: request.goalId ?? null,
          decisionId: request.decisionId ?? null,
          snapshotId: request.snapshotId ?? null,
          source: 'python',
          timestamp: Date.now(),
        });
        return { ...result, operationId, source: 'python' };
      } catch (e) {
        Logger.warn(`MemoryAuthority: Python write failed — ${(e as Error).message}, falling back`, 'MemoryAuthority');
      }
    }

    if (canonicalOwner.process === 'ts_bridge') {
      this.recordTrace({
        operationId,
        operation: 'store',
        memoryType: request.memoryType,
        goalId: request.goalId ?? null,
        decisionId: request.decisionId ?? null,
        snapshotId: request.snapshotId ?? null,
        source: 'ts_bridge',
        timestamp: Date.now(),
      });
      return { success: true, memoryId: '', operationId, source: 'ts_bridge' };
    }

    if (canonicalOwner.process === 'python' && !this.pythonWriteFn) {
      if (this.localFallback) {
        try {
          await this.dispatchToLocalFallback(request);
          this.recordTrace({
            operationId,
            operation: 'store',
            memoryType: request.memoryType,
            goalId: request.goalId ?? null,
            decisionId: request.decisionId ?? null,
            snapshotId: request.snapshotId ?? null,
            source: 'ts_local',
            timestamp: Date.now(),
          });
          Logger.info(
            `MemoryAuthority: write for "${request.memoryType}" via ts_local fallback (Python bridge unavailable) — operationId=${operationId}`,
            'MemoryAuthority'
          );
          return { success: true, memoryId: '', operationId, source: 'ts_local' };
        } catch (e) {
          Logger.error(
            `MemoryAuthority: ts_local fallback write failed — ${(e as Error).message}`,
            e as Error,
            'MemoryAuthority'
          );
        }
      }
      this.recordTrace({
        operationId,
        operation: 'store',
        memoryType: request.memoryType,
        goalId: request.goalId ?? null,
        decisionId: request.decisionId ?? null,
        snapshotId: request.snapshotId ?? null,
        source: 'failed_closed',
        timestamp: Date.now(),
      });
      Logger.error(
        `E2-2: MemoryAuthority write for "${request.memoryType}" FAILED CLOSED — Python canonical owner unavailable, bridge not registered. Refusing silent ts_local fallback to prevent canonicality violation.`,
        new Error('E2-2: Memory write fail-closed — canonical owner unavailable'),
        'MemoryAuthority'
      );
      return { success: false, memoryId: '', operationId, source: 'failed_closed' };
    }

    return { success: false, memoryId: '', operationId, source: 'ts_local' };
  }

  public async read(request: MemoryReadRequest): Promise<MemoryReadResult> {
    const operationId = generateMemoryOpId();
    const domain = request.memoryType ?? 'short_term';
    const canonicalOwner = this.getCanonicalOwner(domain);

    if (!canonicalOwner) {
      Logger.warn(`MemoryAuthority: unknown domain "${domain}" for read`, 'MemoryAuthority');
      return { items: [], operationId, source: 'ts_local' };
    }

    if (canonicalOwner.process === 'python' && this.pythonReadFn) {
      try {
        const result = await this.pythonReadFn(request);
        this.recordTrace({
          operationId,
          operation: 'retrieve',
          memoryType: domain,
          goalId: request.goalId ?? null,
          decisionId: null,
          snapshotId: null,
          source: 'python',
          timestamp: Date.now(),
        });
        return { ...result, operationId, source: 'python' };
      } catch (e) {
        Logger.warn(`MemoryAuthority: Python read failed — ${(e as Error).message}, falling back`, 'MemoryAuthority');
      }
    }

    if (canonicalOwner.process === 'python' && !this.pythonReadFn) {
      this.recordTrace({
        operationId,
        operation: 'retrieve',
        memoryType: domain,
        goalId: request.goalId ?? null,
        decisionId: null,
        snapshotId: null,
        source: 'failed_closed',
        timestamp: Date.now(),
      });
      Logger.error(
        `E2-2: MemoryAuthority read for "${domain}" FAILED CLOSED — Python canonical owner unavailable, bridge not registered. Refusing silent ts_local fallback to prevent canonicality violation.`,
        new Error('E2-2: Memory read fail-closed — canonical owner unavailable'),
        'MemoryAuthority'
      );
      return { items: [], operationId, source: 'failed_closed' };
    }

    if (canonicalOwner.process === 'ts_bridge') {
      this.recordTrace({
        operationId,
        operation: 'retrieve',
        memoryType: domain,
        goalId: request.goalId ?? null,
        decisionId: null,
        snapshotId: null,
        source: 'ts_bridge',
        timestamp: Date.now(),
      });
      return { items: [], operationId, source: 'ts_bridge' };
    }

    this.recordTrace({
      operationId,
      operation: 'retrieve',
      memoryType: domain,
      goalId: request.goalId ?? null,
      decisionId: null,
      snapshotId: null,
      source: 'ts_local',
      timestamp: Date.now(),
    });
    return { items: [], operationId, source: 'ts_local' };
  }

  public getOperationLog(filter?: { goalId?: string; memoryType?: MemoryDomain }): MemoryAuthorityTrace[] {
    if (!filter) return [...this.operationLog];
    return this.operationLog.filter((op) => {
      if (filter.goalId && op.goalId !== filter.goalId) return false;
      if (filter.memoryType && op.memoryType !== filter.memoryType) return false;
      return true;
    });
  }

  public getOperationStats(): {
    total: number;
    bySource: Record<string, number>;
    byOperation: Record<string, number>;
    byDomain: Record<string, number>;
    withAuthorityTrace: number;
    withoutAuthorityTrace: number;
  } {
    const bySource: Record<string, number> = {};
    const byOperation: Record<string, number> = {};
    const byDomain: Record<string, number> = {};
    let withAuth = 0;
    let withoutAuth = 0;

    for (const op of this.operationLog) {
      bySource[op.source] = (bySource[op.source] ?? 0) + 1;
      byOperation[op.operation] = (byOperation[op.operation] ?? 0) + 1;
      byDomain[op.memoryType] = (byDomain[op.memoryType] ?? 0) + 1;
      if (op.goalId && op.decisionId) {
        withAuth++;
      } else {
        withoutAuth++;
      }
    }

    return {
      total: this.operationLog.length,
      bySource,
      byOperation,
      byDomain,
      withAuthorityTrace: withAuth,
      withoutAuthorityTrace: withoutAuth,
    };
  }

  public recordTraceDirect(trace: MemoryAuthorityTrace): void {
    this.recordTrace(trace);
  }

  private async dispatchToLocalFallback(request: MemoryWriteRequest): Promise<void> {
    if (!this.localFallback) throw new Error('No local fallback registered');
    const { content, memoryType, scene, emotion } = request;
    const sceneStr = scene || '';
    const emotionStr = emotion || 'neutral';
    switch (memoryType) {
      case 'short_term':
        await this.localFallback.storeShortTermMemory(content, sceneStr, emotionStr);
        break;
      case 'long_term':
        await this.localFallback.storeLongTermMemory(content, sceneStr, emotionStr);
        break;
      case 'episodic':
        await this.localFallback.storeLongTermMemory(content, sceneStr, emotionStr);
        break;
      case 'feedback':
        await this.localFallback.storeFeedbackSignal({
          feedbackType: 'success',
          message: content,
          traceId: request.metadata?.traceId as string | undefined,
        });
        break;
      default:
        await this.localFallback.storeShortTermMemory(content, sceneStr, emotionStr);
        break;
    }
  }

  private recordTrace(trace: MemoryAuthorityTrace): void {
    this.operationLog.push(trace);
    if (this.operationLog.length > this.MAX_OPERATION_LOG) {
      this.operationLog = this.operationLog.slice(-Math.floor(this.MAX_OPERATION_LOG * 0.75));
    }
  }
}
