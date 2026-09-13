import type { GoalImpact, WorldObservation, Goal } from './types';
import type { AutonomousLoopResult, LoopSafetyConfig } from './AutonomousLoop';
import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';

export enum RuntimeState {
  IDLE = 'idle',
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPED = 'stopped',
}

export interface RuntimeConfig {
  observationIntervalMs: number;
  maxConcurrentGoals: number;
  goalCooldownMs: number;
  loopSafety: Partial<LoopSafetyConfig>;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  observationIntervalMs: 5000,
  maxConcurrentGoals: 3,
  goalCooldownMs: 10000,
  loopSafety: {},
};

export interface GoalLoopStatus {
  goalId: string;
  running: boolean;
  lastStartTime: number | null;
  lastEndTime: number | null;
  lastResult: AutonomousLoopResult | null;
  totalRuns: number;
}

export interface AutonomousRuntime {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  getState(): RuntimeState;
  getGoalStatuses(): Map<string, GoalLoopStatus>;
  injectObservation(observation: WorldObservation): Promise<void>;
  getConfig(): RuntimeConfig;
}

class AutonomousRuntimeImpl implements AutonomousRuntime {
  private state: RuntimeState = RuntimeState.IDLE;
  private config: RuntimeConfig;
  private observationTimer: ReturnType<typeof setInterval> | null = null;
  private goalStatuses: Map<string, GoalLoopStatus> = new Map();
  private activeLoops: Set<string> = new Set();
  private pendingObservations: WorldObservation[] = [];

  constructor(config?: Partial<RuntimeConfig>) {
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...config };
  }

  start(): void {
    if (this.state === RuntimeState.RUNNING) {
      Logger.warn('[D7-4] Runtime already running', 'AutonomousRuntime');
      return;
    }

    this.state = RuntimeState.RUNNING;
    Logger.info(
      `[D7-4] AutonomousRuntime started: interval=${this.config.observationIntervalMs}ms maxConcurrent=${this.config.maxConcurrentGoals}`,
      'AutonomousRuntime'
    );

    EventBus.emit('runtime_state_changed', { state: this.state });

    this.observationTimer = setInterval(() => {
      this.tick().catch((err) => {
        Logger.error(
          `[D7-4] Runtime tick error: ${(err as Error).message}`,
          err as Error,
          'AutonomousRuntime'
        );
      });
    }, this.config.observationIntervalMs);
  }

  pause(): void {
    if (this.state !== RuntimeState.RUNNING) return;
    this.state = RuntimeState.PAUSED;
    this.clearTimer();
    Logger.info('[D7-4] Runtime paused', 'AutonomousRuntime');
    EventBus.emit('runtime_state_changed', { state: this.state });
  }

  resume(): void {
    if (this.state !== RuntimeState.PAUSED) return;
    this.state = RuntimeState.RUNNING;
    Logger.info('[D7-4] Runtime resumed', 'AutonomousRuntime');
    EventBus.emit('runtime_state_changed', { state: this.state });

    this.observationTimer = setInterval(() => {
      this.tick().catch((err) => {
        Logger.error(
          `[D7-4] Runtime tick error: ${(err as Error).message}`,
          err as Error,
          'AutonomousRuntime'
        );
      });
    }, this.config.observationIntervalMs);
  }

  stop(): void {
    this.state = RuntimeState.STOPPED;
    this.clearTimer();
    this.activeLoops.clear();
    Logger.info('[D7-4] Runtime stopped', 'AutonomousRuntime');
    EventBus.emit('runtime_state_changed', { state: this.state });
  }

  getState(): RuntimeState {
    return this.state;
  }

  getGoalStatuses(): Map<string, GoalLoopStatus> {
    return new Map(this.goalStatuses);
  }

  async injectObservation(observation: WorldObservation): Promise<void> {
    this.pendingObservations.push(observation);
    if (this.state === RuntimeState.RUNNING) {
      await this.processObservation(observation);
    }
  }

  getConfig(): RuntimeConfig {
    return { ...this.config };
  }

  private async tick(): Promise<void> {
    if (this.state !== RuntimeState.RUNNING) return;

    const { GoalAuthority } = require('./GoalAuthority');
    const goalAuthority = GoalAuthority.getInstance();
    const activeGoals = goalAuthority.getActiveGoals();

    if (activeGoals.length === 0) return;

    while (this.pendingObservations.length > 0) {
      const obs = this.pendingObservations.shift()!;
      await this.processObservation(obs);
    }

    for (const goal of activeGoals) {
      if (this.activeLoops.has(goal.goalId)) continue;

      const status = this.goalStatuses.get(goal.goalId);
      if (status?.running) continue;

      if (status?.lastEndTime) {
        const elapsed = Date.now() - status.lastEndTime;
        if (elapsed < this.config.goalCooldownMs) continue;
      }

      if (this.activeLoops.size >= this.config.maxConcurrentGoals) break;

      await this.initiateLoopForGoal(goal);
    }
  }

  private async processObservation(observation: WorldObservation): Promise<void> {
    const { GoalAuthority } = require('./GoalAuthority');
    const goalAuthority = GoalAuthority.getInstance();
    const activeGoals = goalAuthority.getActiveGoals();

    if (activeGoals.length === 0) return;

    const { getGoalImpactEvaluator } = require('./GoalImpactEvaluator');
    const evaluator = getGoalImpactEvaluator();
    const impacts = evaluator.evaluate(activeGoals, observation);

    const affectedImpacts = impacts.filter((i: GoalImpact) => i.affected);

    if (affectedImpacts.length === 0) return;

    Logger.info(
      `[D7-4] Observation ${observation.observationId} affects ${affectedImpacts.length} goal(s)`,
      'AutonomousRuntime'
    );

    for (const impact of affectedImpacts) {
      if (this.activeLoops.has(impact.goalId)) {
        Logger.info(
          `[D7-4] Goal ${impact.goalId} already has active loop — skipping`,
          'AutonomousRuntime'
        );
        continue;
      }

      if (this.activeLoops.size >= this.config.maxConcurrentGoals) {
        Logger.warn(
          `[D7-4] Max concurrent goals reached (${this.config.maxConcurrentGoals}) — deferring goal ${impact.goalId}`,
          'AutonomousRuntime'
        );
        continue;
      }

      const goal = goalAuthority.getGoal(impact.goalId);
      if (!goal || goal.status !== 'active') continue;

      await this.initiateLoopForGoal(goal, impact, observation);
    }
  }

  private async initiateLoopForGoal(
    goal: Goal,
    impact?: GoalImpact,
    observation?: WorldObservation
  ): Promise<void> {
    if (!impact) {
      const { getGoalImpactEvaluator } = require('./GoalImpactEvaluator');
      const evaluator = getGoalImpactEvaluator();
      const defaultObs: WorldObservation = {
        observationId: `OBS_proactive_${Date.now().toString(36)}`,
        source: 'proactive',
        type: 'proactive_check',
        timestamp: new Date().toISOString(),
        payload: { reason: 'proactive_goal_check' },
      };
      const impacts = evaluator.evaluate([goal], defaultObs);
      impact = impacts.find((i: GoalImpact) => i.affected) || {
        goalId: goal.goalId,
        observationId: defaultObs.observationId,
        affected: true,
        impactType: 'proactive_signal' as const,
        reason: 'proactive goal check',
        confidence: 0.5,
      };
      observation = defaultObs;
    }

    if (!observation) {
      observation = {
        observationId: `OBS_proactive_${Date.now().toString(36)}`,
        source: 'proactive',
        type: 'proactive_check',
        timestamp: new Date().toISOString(),
        payload: {},
      };
    }

    this.activeLoops.add(goal.goalId);

    if (!this.goalStatuses.has(goal.goalId)) {
      this.goalStatuses.set(goal.goalId, {
        goalId: goal.goalId,
        running: true,
        lastStartTime: Date.now(),
        lastEndTime: null,
        lastResult: null,
        totalRuns: 0,
      });
    } else {
      const status = this.goalStatuses.get(goal.goalId)!;
      status.running = true;
      status.lastStartTime = Date.now();
    }

    Logger.info(
      `[D7-4] Initiating loop for goal ${goal.goalId} (activeLoops=${this.activeLoops.size})`,
      'AutonomousRuntime'
    );

    try {
      const { getAutonomousLoop } = require('./AutonomousLoop');
      const loop = getAutonomousLoop();
      const result = await loop.run(
        goal.goalId,
        impact,
        observation,
        this.config.loopSafety
      );

      const status = this.goalStatuses.get(goal.goalId)!;
      status.running = false;
      status.lastEndTime = Date.now();
      status.lastResult = result;
      status.totalRuns++;

      Logger.info(
        `[D7-4] Loop completed for goal ${goal.goalId}: reason=${result.terminationReason} steps=${result.totalSteps} progress=${result.finalGoalProgress.toFixed(2)}`,
        'AutonomousRuntime'
      );
    } catch (err) {
      Logger.error(
        `[D7-4] Loop failed for goal ${goal.goalId}: ${(err as Error).message}`,
        err as Error,
        'AutonomousRuntime'
      );

      const status = this.goalStatuses.get(goal.goalId);
      if (status) {
        status.running = false;
        status.lastEndTime = Date.now();
      }
    } finally {
      this.activeLoops.delete(goal.goalId);
    }
  }

  private clearTimer(): void {
    if (this.observationTimer) {
      clearInterval(this.observationTimer);
      this.observationTimer = null;
    }
  }
}

let instance: AutonomousRuntime | null = null;

export function getAutonomousRuntime(config?: Partial<RuntimeConfig>): AutonomousRuntime {
  if (!instance) {
    instance = new AutonomousRuntimeImpl(config);
  }
  return instance;
}

export function resetAutonomousRuntime(): void {
  if (instance) {
    instance.stop();
  }
  instance = null;
}
