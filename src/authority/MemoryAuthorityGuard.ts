import { Logger } from '../utils/Logger';
import { MemoryAuthority, type MemoryWriteRequest, type MemoryDomain } from './MemoryAuthority';

export class MemoryAuthorityGuard {
  private static instance: MemoryAuthorityGuard | null = null;

  private constructor() {}

  public static getInstance(): MemoryAuthorityGuard {
    if (!MemoryAuthorityGuard.instance) {
      MemoryAuthorityGuard.instance = new MemoryAuthorityGuard();
    }
    return MemoryAuthorityGuard.instance;
  }

  public static resetInstance(): void {
    MemoryAuthorityGuard.instance = null;
  }

  public async writeShortTerm(
    content: string,
    scene: string,
    emotion: string,
    authorityMeta?: { goalId?: string; decisionId?: string; snapshotId?: string }
  ): Promise<boolean> {
    return this.guardedWrite({
      content,
      memoryType: 'short_term',
      scene,
      emotion,
      goalId: authorityMeta?.goalId,
      decisionId: authorityMeta?.decisionId,
      snapshotId: authorityMeta?.snapshotId,
    });
  }

  public async writeLongTerm(
    content: string,
    scene: string,
    emotion: string,
    authorityMeta?: { goalId?: string; decisionId?: string; snapshotId?: string }
  ): Promise<boolean> {
    return this.guardedWrite({
      content,
      memoryType: 'long_term',
      scene,
      emotion,
      goalId: authorityMeta?.goalId,
      decisionId: authorityMeta?.decisionId,
      snapshotId: authorityMeta?.snapshotId,
    });
  }

  public async writeInstant(
    content: string,
    scene: string,
    emotion: string,
    authorityMeta?: { goalId?: string; decisionId?: string; snapshotId?: string }
  ): Promise<boolean> {
    return this.guardedWrite({
      content,
      memoryType: 'short_term',
      scene,
      emotion,
      goalId: authorityMeta?.goalId,
      decisionId: authorityMeta?.decisionId,
      snapshotId: authorityMeta?.snapshotId,
    });
  }

  public async writeFeedback(
    data: {
      feedbackType: string;
      rating?: number;
      message?: string;
      traceId?: string;
      toolName?: string;
      userId?: string;
      timestamp?: number;
    },
    authorityMeta?: { goalId?: string; decisionId?: string; snapshotId?: string }
  ): Promise<boolean> {
    return this.guardedWrite({
      content: data.message || data.feedbackType,
      memoryType: 'feedback',
      scene: data.toolName || '',
      emotion: data.feedbackType,
      goalId: authorityMeta?.goalId,
      decisionId: authorityMeta?.decisionId,
      snapshotId: authorityMeta?.snapshotId,
      metadata: data as Record<string, unknown>,
    });
  }

  private async guardedWrite(request: MemoryWriteRequest): Promise<boolean> {
    try {
      const memoryAuthority = MemoryAuthority.getInstance();
      const result = await memoryAuthority.write(request);
      if (!result.success) {
        Logger.warn(
          `MemoryAuthorityGuard: write ${request.memoryType} returned success=false — operationId=${result.operationId} source=${result.source}`,
          'MemoryAuthorityGuard'
        );
      }
      return result.success;
    } catch (e) {
      Logger.warn(
        `MemoryAuthorityGuard: write ${request.memoryType} threw — ${(e as Error).message}`,
        'MemoryAuthorityGuard'
      );
      return false;
    }
  }
}
