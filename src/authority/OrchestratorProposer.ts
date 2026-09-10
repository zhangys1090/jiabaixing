import type { DecisionCandidate, DecisionContext, DecisionProposer } from './types';
import { Logger } from '../utils/Logger';

function generateCandidateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `OC_${ts}_${rand}`;
}

export interface PlanCandidate {
  readonly taskCount: number;
  readonly parallelizable: boolean;
  readonly estimatedComplexity: string;
  readonly taskGoals: readonly string[];
}

export class OrchestratorProposer implements DecisionProposer {
  public readonly proposerId = 'orchestrator_proposer';

  private decomposeGoalFn?: (userGoal: string, context?: string) => Promise<unknown[]>;

  public setDecomposeFn(
    fn: (userGoal: string, context?: string) => Promise<unknown[]>
  ): void {
    this.decomposeGoalFn = fn;
  }

  public async propose(context: DecisionContext): Promise<DecisionCandidate[]> {
    const taskInput = this.extractTaskInput(context);
    if (!taskInput) return [];

    if (!this.decomposeGoalFn) {
      Logger.warn(
        'OrchestratorProposer: no decomposeGoalFn set, returning empty candidates',
        'OrchestratorProposer'
      );
      return [];
    }

    try {
      const tasks = await this.decomposeGoalFn(taskInput);

      if (!tasks || tasks.length === 0) return [];

      const planCandidate: PlanCandidate = {
        taskCount: tasks.length,
        parallelizable: tasks.length > 1,
        estimatedComplexity: tasks.length <= 1 ? 'simple' : tasks.length <= 3 ? 'medium' : 'complex',
        taskGoals: tasks.map((t: unknown) => {
          const task = t as Record<string, unknown>;
          return String(task.goal || task.description || 'unknown');
        }),
      };

      return [
        {
          candidateId: generateCandidateId(),
          proposerId: this.proposerId,
          action: {
            type: 'composite',
            payload: {
              planType: 'decompose',
              taskCount: planCandidate.taskCount,
              parallelizable: planCandidate.parallelizable,
              tasks,
            },
          },
          confidence: Math.max(0.5, 1 - tasks.length * 0.1),
          reasoning: `Orchestrator proposes ${tasks.length}-task plan: ${planCandidate.taskGoals.slice(0, 3).join('; ')}${planCandidate.taskGoals.length > 3 ? '...' : ''}`,
          estimatedGoalProgress: Math.min(0.3, 0.1 * tasks.length),
        },
      ];
    } catch (err) {
      Logger.warn(
        `OrchestratorProposer: decompose failed — ${(err as Error).message}`,
        'OrchestratorProposer'
      );
      return [];
    }
  }

  private extractTaskInput(context: DecisionContext): string | null {
    const goalAuthority = require('./GoalAuthority').GoalAuthority;
    const ga = goalAuthority.getInstance();
    const goal = ga.getGoal(context.goalId);
    if (goal) return goal.description;
    if (context.snapshot?.context?.systemPrompt) return context.snapshot.context.systemPrompt;
    return null;
  }
}
