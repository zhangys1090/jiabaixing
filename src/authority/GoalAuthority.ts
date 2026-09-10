import { Logger } from '../utils/Logger';
import {
    Goal,
    GoalEvidence,
    GoalPriority,
    GoalStatus,
    GoalStatusEvaluation,
} from './types';

function generateGoalId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `G_${ts}_${rand}`;
}

function generateEvidenceId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `E_${ts}_${rand}`;
}

export interface CreateGoalInput {
  description: string;
  originalInput: string;
  priority?: GoalPriority;
  parentGoalId?: string;
  successCondition?: string;
  abandonmentCondition?: string;
}

export class GoalAuthority {
  private static instance: GoalAuthority | null = null;
  private readonly goals: Map<string, Goal> = new Map();
  private readonly evidenceLog: Map<string, GoalEvidence[]> = new Map();

  private constructor() {}

  public static getInstance(): GoalAuthority {
    if (!GoalAuthority.instance) {
      GoalAuthority.instance = new GoalAuthority();
    }
    return GoalAuthority.instance;
  }

  public static resetInstance(): void {
    GoalAuthority.instance = null;
  }

  public createGoal(input: CreateGoalInput): Goal {
    const now = Date.now();
    const goal: Goal = {
      goalId: generateGoalId(),
      description: input.description,
      originalInput: input.originalInput,
      status: GoalStatus.ACTIVE,
      priority: input.priority ?? GoalPriority.NORMAL,
      progress: 0,
      parentGoalId: input.parentGoalId ?? null,
      createdAt: now,
      updatedAt: now,
      successCondition: input.successCondition ?? '',
      abandonmentCondition: input.abandonmentCondition ?? '',
      currentStage: 'created',
      planVersion: 1,
      metadata: {},
    };

    this.goals.set(goal.goalId, goal);
    Logger.info(
      `GoalAuthority: created goal ${goal.goalId} — "${input.description.slice(0, 60)}"`,
      'GoalAuthority'
    );
    return goal;
  }

  public getGoal(goalId: string): Goal | null {
    return this.goals.get(goalId) ?? null;
  }

  /**
   * D4-I2 Post-Audit: 注册跨进程（Python DecisionAuthority 创建的）Goal 的影子记录。
   *
   * delegated 路径的 goalId 由 Python 侧生成，TS GoalAuthority 中不存在；
   * 为使 G→S→D→A→E 链在跨进程路径完整（Evidence 必须能写回同一 goalId），
   * 用 Python 提供的 goalId 注册影子 Goal（identity 与 Python 侧一致）。
   * 若该 goalId 已存在（本轮已注册），直接返回既有记录。
   */
  public ensureGoal(goalId: string, input: CreateGoalInput): Goal {
    const existing = this.goals.get(goalId);
    if (existing) {
      return existing;
    }
    const now = Date.now();
    const goal: Goal = {
      goalId,
      description: input.description,
      originalInput: input.originalInput,
      status: GoalStatus.ACTIVE,
      priority: input.priority ?? GoalPriority.NORMAL,
      progress: 0,
      parentGoalId: input.parentGoalId ?? null,
      createdAt: now,
      updatedAt: now,
      successCondition: input.successCondition ?? '',
      abandonmentCondition: input.abandonmentCondition ?? '',
      currentStage: 'delegated',
      planVersion: 1,
      metadata: { shadowOfPythonGoal: true },
    };
    this.goals.set(goalId, goal);
    Logger.info(
      `GoalAuthority: registered shadow goal ${goalId} (from Python delegated decision) — "${input.description.slice(0, 60)}"`,
      'GoalAuthority'
    );
    return goal;
  }

  public getActiveGoals(): Goal[] {
    return Array.from(this.goals.values()).filter(
      (g) => g.status === GoalStatus.ACTIVE
    );
  }

  public getAllGoals(): Goal[] {
    return Array.from(this.goals.values());
  }

  public updateFromEvidence(evidence: Omit<GoalEvidence, 'evidenceId' | 'timestamp'>): Goal {
    const goal = this.getGoalOrThrow(evidence.goalId);

    const fullEvidence: GoalEvidence = {
      ...evidence,
      evidenceId: generateEvidenceId(),
      timestamp: Date.now(),
    };

    if (!this.evidenceLog.has(evidence.goalId)) {
      this.evidenceLog.set(evidence.goalId, []);
    }
    this.evidenceLog.get(evidence.goalId)!.push(fullEvidence);

    const clamped = Math.max(0, Math.min(1, goal.progress + evidence.progressDelta));
    goal.progress = clamped;
    goal.updatedAt = Date.now();

    if (clamped >= 1 && goal.status === GoalStatus.ACTIVE) {
      goal.status = GoalStatus.COMPLETED;
      Logger.info(
        `GoalAuthority: goal ${evidence.goalId} auto-completed via evidence (progress=1.0)`,
        'GoalAuthority'
      );
    }

    Logger.info(
      `GoalAuthority: evidence ${fullEvidence.evidenceId} → goal ${evidence.goalId} progress ${goal.progress.toFixed(2)} (delta=${evidence.progressDelta.toFixed(2)})`,
      'GoalAuthority'
    );

    // D5: Evidence → LearningAuthority → future Decision influence
    try {
      const { LearningAuthority } = require('./LearningAuthority');
      const learningAuthority = LearningAuthority.getInstance();
      const decisionAuthority = require('./DecisionAuthority').DecisionAuthority.getInstance();
      const decisionHistory = decisionAuthority.getDecisionHistory(evidence.goalId);
      const lastDecision = decisionHistory.length > 0
        ? decisionHistory[decisionHistory.length - 1]
        : null;
      const proposerId = lastDecision?.chosen?.proposerId ?? 'unknown';
      learningAuthority.learn(fullEvidence, proposerId);
    } catch {
      // Learning failure must not block Evidence write
    }

    return goal;
  }

  public getEvidenceLog(goalId: string): GoalEvidence[] {
    return this.evidenceLog.get(goalId) ?? [];
  }

  public updateStage(goalId: string, stage: string): Goal {
    const goal = this.getGoalOrThrow(goalId);
    goal.currentStage = stage;
    goal.updatedAt = Date.now();
    return goal;
  }

  public markCompleted(goalId: string, reason: string): Goal {
    const goal = this.getGoalOrThrow(goalId);
    goal.status = GoalStatus.COMPLETED;
    goal.progress = 1;
    goal.updatedAt = Date.now();
    goal.metadata['completionReason'] = reason;
    Logger.info(
      `GoalAuthority: goal ${goalId} completed — ${reason}`,
      'GoalAuthority'
    );
    return goal;
  }

  public markAbandoned(goalId: string, reason: string): Goal {
    const goal = this.getGoalOrThrow(goalId);
    goal.status = GoalStatus.ABANDONED;
    goal.updatedAt = Date.now();
    goal.metadata['abandonmentReason'] = reason;
    Logger.info(
      `GoalAuthority: goal ${goalId} abandoned — ${reason}`,
      'GoalAuthority'
    );
    return goal;
  }

  public replan(goalId: string, reason: string): Goal {
    const goal = this.getGoalOrThrow(goalId);
    goal.planVersion += 1;
    goal.updatedAt = Date.now();
    goal.metadata[`replanReason_v${goal.planVersion}`] = reason;
    Logger.info(
      `GoalAuthority: goal ${goalId} replanned → plan v${goal.planVersion} — ${reason}`,
      'GoalAuthority'
    );
    return goal;
  }

  public evaluateStatus(goalId: string, evidence?: GoalEvidence): GoalStatusEvaluation {
    const goal = this.getGoalOrThrow(goalId);

    if (goal.status === GoalStatus.COMPLETED) {
      return { status: GoalStatus.COMPLETED, reason: 'progress reached 1.0' };
    }

    if (goal.status === GoalStatus.ABANDONED) {
      return { status: GoalStatus.ABANDONED, reason: goal.metadata['abandonmentReason'] as string ?? 'abandoned' };
    }

    if (goal.status === GoalStatus.PAUSED) {
      return { status: GoalStatus.PAUSED, reason: 'paused by external signal' };
    }

    if (goal.progress >= 1) {
      return { status: GoalStatus.COMPLETED, reason: 'progress reached 1.0' };
    }

    if (evidence && evidence.progressDelta < -0.3) {
      return {
        status: GoalStatus.ACTIVE,
        reason: `active but negative evidence (delta=${evidence.progressDelta.toFixed(2)}), consider replan`,
      };
    }

    return { status: GoalStatus.ACTIVE, reason: `progress=${goal.progress.toFixed(2)}, plan v${goal.planVersion}` };
  }

  public clear(): void {
    this.goals.clear();
    this.evidenceLog.clear();
  }

  private getGoalOrThrow(goalId: string): Goal {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new Error(`GoalAuthority: goal ${goalId} not found`);
    }
    return goal;
  }
}
