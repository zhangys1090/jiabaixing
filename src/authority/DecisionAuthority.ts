import { Logger } from '../utils/Logger';
import { GoalAuthority } from './GoalAuthority';
import {
    CanonicalDecisionSnapshot,
    Decision,
    DecisionCandidate,
    DecisionContext,
    DecisionProposer,
    DecisionType,
    GoalStatus,
} from './types';
import { LearningAuthority } from './LearningAuthority';

function generateDecisionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `D_${ts}_${rand}`;
}

export interface DecisionHistoryEntry {
  decision: Decision;
  goalId: string;
}

export class DecisionAuthority {
  private static instance: DecisionAuthority | null = null;
  private readonly history: Map<string, Decision[]> = new Map();
  private readonly proposers: Map<string, DecisionProposer> = new Map();

  private constructor() {}

  public static getInstance(): DecisionAuthority {
    if (!DecisionAuthority.instance) {
      DecisionAuthority.instance = new DecisionAuthority();
    }
    return DecisionAuthority.instance;
  }

  public static resetInstance(): void {
    DecisionAuthority.instance = null;
  }

  public registerProposer(proposer: DecisionProposer): void {
    this.proposers.set(proposer.proposerId, proposer);
    Logger.info(
      `DecisionAuthority: registered proposer "${proposer.proposerId}"`,
      'DecisionAuthority'
    );
  }

  public async decide(context: DecisionContext): Promise<Decision> {
    const { goalId, snapshot, candidates, decisionType } = context;

    const goalAuthority = GoalAuthority.getInstance();
    const goal = goalAuthority.getGoal(goalId);

    if (!goal) {
      throw new Error(`DecisionAuthority: goal ${goalId} not found`);
    }

    if (goal.status !== GoalStatus.ACTIVE) {
      throw new Error(
        `DecisionAuthority: goal ${goalId} is ${goal.status}, cannot decide`
      );
    }

    if (candidates.length === 0) {
      throw new Error(
        `DecisionAuthority: no candidates for goal ${goalId}`
      );
    }

    // D5: LearningAuthority adjusts candidate confidence/progress based on past Evidence
    const learningAuthority = LearningAuthority.getInstance();
    const adjustedCandidates = candidates.map((c) => learningAuthority.adjustCandidate(c));

    const scored = adjustedCandidates.map((c) => ({
      candidate: c,
      score: this.scoreCandidate(c, goal.progress),
    }));

    scored.sort((a, b) => b.score - a.score);

    const chosen = scored[0].candidate;

    const selectionReason = this.buildSelectionReason(chosen, scored[0].score, goal.progress);

    const acceptThreshold = scored[0].score * 0.7;
    const accepted = scored.filter((s) => s.score >= acceptThreshold).map((s) => s.candidate);
    const rejected = scored.filter((s) => s.score < acceptThreshold).map((s) => s.candidate);

    const decision: Decision = {
      decisionId: generateDecisionId(),
      decisionType: decisionType ?? DecisionType.ACTION,
      goalId,
      snapshotId: snapshot.snapshotId,
      candidateIds: candidates.map((c) => c.candidateId),
      chosenCandidateId: chosen.candidateId,
      chosen,
      acceptedCandidates: accepted,
      rejectedCandidates: rejected,
      selectionReason,
      proposerSet: [...new Set(candidates.map((c) => c.proposerId))],
      vetoReason: null,
      timestamp: Date.now(),
    };

    this.recordDecision(goalId, decision);

    Logger.info(
      `DecisionAuthority: FINAL decision ${decision.decisionId} for goal ${goalId} — proposer=${chosen.proposerId} candidate=${chosen.candidateId} score=${scored[0].score.toFixed(3)} reason="${selectionReason}"`,
      'DecisionAuthority'
    );

    return decision;
  }

  public async decideWithProposers(
    goalId: string,
    snapshot: CanonicalDecisionSnapshot
  ): Promise<Decision> {
    const goalAuthority = GoalAuthority.getInstance();
    const goal = goalAuthority.getGoal(goalId);

    if (!goal) {
      throw new Error(`DecisionAuthority: goal ${goalId} not found`);
    }

    if (goal.status !== GoalStatus.ACTIVE) {
      throw new Error(
        `DecisionAuthority: goal ${goalId} is ${goal.status}, cannot decide`
      );
    }

    const context: DecisionContext = { goalId, snapshot, candidates: [] };

    const allCandidates: DecisionCandidate[] = [];
    for (const proposer of this.proposers.values()) {
      try {
        const proposed = await proposer.propose(context);
        allCandidates.push(...proposed);
      } catch (e) {
        Logger.warn(
          `DecisionAuthority: proposer "${proposer.proposerId}" failed — ${(e as Error).message}`,
          'DecisionAuthority'
        );
      }
    }

    if (allCandidates.length === 0) {
      throw new Error(
        `DecisionAuthority: no candidates from ${this.proposers.size} proposers for goal ${goalId}`
      );
    }

    return this.decide({ goalId, snapshot, candidates: allCandidates });
  }

  public getDecisionHistory(goalId: string): Decision[] {
    return this.history.get(goalId) ?? [];
  }

  public getAllHistory(): DecisionHistoryEntry[] {
    const entries: DecisionHistoryEntry[] = [];
    for (const [goalId, decisions] of this.history) {
      for (const decision of decisions) {
        entries.push({ decision, goalId });
      }
    }
    return entries;
  }

  public clearHistory(): void {
    this.history.clear();
  }

  private scoreCandidate(
    candidate: DecisionCandidate,
    currentGoalProgress: number
  ): number {
    const confidenceWeight = 0.6;
    const progressWeight = 0.4;

    const progressDelta = candidate.estimatedGoalProgress - currentGoalProgress;
    const normalizedProgressDelta = Math.max(0, Math.min(1, progressDelta));

    return (
      confidenceWeight * candidate.confidence +
      progressWeight * normalizedProgressDelta
    );
  }

  private buildSelectionReason(
    chosen: DecisionCandidate,
    score: number,
    currentProgress: number
  ): string {
    return `proposer=${chosen.proposerId} confidence=${chosen.confidence.toFixed(2)} estimatedProgress=${chosen.estimatedGoalProgress.toFixed(2)} currentProgress=${currentProgress.toFixed(2)} score=${score.toFixed(3)}`;
  }

  private recordDecision(goalId: string, decision: Decision): void {
    if (!this.history.has(goalId)) {
      this.history.set(goalId, []);
    }
    this.history.get(goalId)!.push(decision);
  }
}
