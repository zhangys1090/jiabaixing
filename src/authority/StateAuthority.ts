import { Logger } from '../utils/Logger';
import { GoalAuthority } from './GoalAuthority';
import {
    CanonicalDecisionSnapshot,
    CapabilitySet,
    ContextView,
    MemoryView,
    SelfView,
    WorldView,
} from './types';

function generateSnapshotId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `SS_${ts}_${rand}`;
}

export interface StateReadProviders {
  readWorldState: () => Promise<WorldView>;
  readMemory: (query: string) => Promise<MemoryView>;
  readContext: (activeGoalIds: string[]) => Promise<ContextView>;
  readCapabilities: () => Promise<CapabilitySet>;
  getAgentId: () => string;
  getSafetyStatus: () => 'nominal' | 'degraded' | 'emergency';
}

export class StateAuthority {
  private static instance: StateAuthority | null = null;
  private providers: StateReadProviders | null = null;
  private latestSnapshot: CanonicalDecisionSnapshot | null = null;

  private constructor() {}

  public static getInstance(): StateAuthority {
    if (!StateAuthority.instance) {
      StateAuthority.instance = new StateAuthority();
    }
    return StateAuthority.instance;
  }

  public static resetInstance(): void {
    StateAuthority.instance = null;
  }

  public registerProviders(providers: StateReadProviders): void {
    this.providers = providers;
    Logger.info('StateAuthority: read providers registered', 'StateAuthority');
  }

  public async captureSnapshot(activeGoalIds?: string[]): Promise<CanonicalDecisionSnapshot> {
    const goalAuthority = GoalAuthority.getInstance();
    const goals = activeGoalIds
      ? activeGoalIds.map((id) => goalAuthority.getGoal(id)).filter((g): g is NonNullable<typeof g> => g !== null)
      : goalAuthority.getActiveGoals();

    const resolvedGoalIds = goals.map((g) => g.goalId);
    const primaryDescription = goals.length > 0 ? goals[0].description : '';

    if (!this.providers) {
      Logger.warn(
        'StateAuthority: no read providers registered, returning minimal snapshot',
        'StateAuthority'
      );
      return this.minimalSnapshot(resolvedGoalIds);
    }

    const [world, memory, context, capabilities] = await Promise.all([
      this.providers.readWorldState().catch((e) => {
        Logger.warn(`StateAuthority: world read failed — ${(e as Error).message}`, 'StateAuthority');
        return { observation: null, platform: 'server' as const, timestamp: Date.now() };
      }),
      this.providers.readMemory(primaryDescription).catch((e) => {
        Logger.warn(`StateAuthority: memory read failed — ${(e as Error).message}`, 'StateAuthority');
        return { relevantMemories: [], query: '', timestamp: Date.now() };
      }),
      this.providers.readContext(resolvedGoalIds).catch((e) => {
        Logger.warn(`StateAuthority: context read failed — ${(e as Error).message}`, 'StateAuthority');
        return { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now() };
      }),
      this.providers.readCapabilities().catch((e) => {
        Logger.warn(`StateAuthority: capabilities read failed — ${(e as Error).message}`, 'StateAuthority');
        return { availableTools: [], availableSkills: [], desktopAvailable: false, bridgeAvailable: false };
      }),
    ]);

    const self: SelfView = {
      agentId: this.providers.getAgentId(),
      activeGoalIds: resolvedGoalIds,
      currentStage: goals.length > 0 ? goals[0].currentStage : 'unknown',
      safetyStatus: this.providers.getSafetyStatus(),
    };

    const snapshot: CanonicalDecisionSnapshot = {
      snapshotId: generateSnapshotId(),
      timestamp: Date.now(),
      activeGoalIds: resolvedGoalIds,
      self,
      world,
      memory,
      context,
      capabilities,
    };

    this.latestSnapshot = snapshot;
    Logger.info(
      `StateAuthority: captured snapshot ${snapshot.snapshotId} for goals [${resolvedGoalIds.join(',')}]`,
      'StateAuthority'
    );
    return snapshot;
  }

  public getLatestSnapshot(): CanonicalDecisionSnapshot | null {
    return this.latestSnapshot;
  }

  private minimalSnapshot(activeGoalIds: string[]): CanonicalDecisionSnapshot {
    return {
      snapshotId: generateSnapshotId(),
      timestamp: Date.now(),
      activeGoalIds,
      self: {
        agentId: 'unknown',
        activeGoalIds,
        currentStage: 'unknown',
        safetyStatus: 'degraded',
      },
      world: { observation: null, platform: 'server', timestamp: Date.now() },
      memory: { relevantMemories: [], query: '', timestamp: Date.now() },
      context: {
        systemPrompt: '',
        conversationHistory: [],
        fileContexts: [],
        personaSummary: '',
        timestamp: Date.now(),
      },
      capabilities: {
        availableTools: [],
        availableSkills: [],
        desktopAvailable: false,
        bridgeAvailable: false,
      },
    };
  }
}
