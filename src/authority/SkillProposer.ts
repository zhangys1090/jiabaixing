import { Logger } from '../utils/Logger';
import {
  DecisionCandidate,
  DecisionContext,
  DecisionProposer,
  ProposedAction,
} from './types';

function generateCandidateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `C_skill_${ts}_${rand}`;
}

/**
 * D4-I2-1: SkillProposer — matchSkill() 不再直接决定执行。
 *
 * 之前：
 *   matchSkill() → confidence > 50 → executeWithSkill()（隐式 FINAL）
 *
 * 现在：
 *   matchSkill() → DecisionCandidate → DecisionAuthority.decide() → FINAL → ActionAuthority
 *
 * SkillProposer 是 proposer，不是 authority。
 * 它只负责"提出候选动作"，不负责"选择最终动作"。
 */
export class SkillProposer implements DecisionProposer {
  public readonly proposerId = 'skill_proposer';

  constructor() {}

  private getSkillRegistry() {
    const { DesktopSkillRegistry } = require('../desktop/DesktopSkillRegistry');
    return DesktopSkillRegistry.getInstance();
  }

  public async propose(
    context: DecisionContext
  ): Promise<DecisionCandidate[]> {
    const candidates: DecisionCandidate[] = [];

    const taskInput = this.extractTaskInput(context);
    if (!taskInput) {
      return candidates;
    }

    const skillMatch = this.getSkillRegistry().matchSkill(taskInput);

    if (skillMatch) {
      const action: ProposedAction = {
        type: 'desktop_action',
        payload: {
          skillId: skillMatch.skill.id,
          skillName: skillMatch.skill.name,
          params: skillMatch.extractedParams,
          steps: skillMatch.skill.steps,
        },
      };

      const candidate: DecisionCandidate = {
        candidateId: generateCandidateId(),
        proposerId: this.proposerId,
        action,
        confidence: skillMatch.confidence / 100,
        reasoning: `Skill "${skillMatch.skill.name}" matched with confidence ${Math.round(skillMatch.confidence)}%`,
        estimatedGoalProgress: this.estimateProgress(
          skillMatch.confidence / 100,
          context
        ),
      };

      candidates.push(candidate);

      Logger.info(
        `SkillProposer: proposed "${skillMatch.skill.name}" (confidence=${Math.round(skillMatch.confidence)}%) as candidate ${candidate.candidateId}`,
        'SkillProposer'
      );
    }

    return candidates;
  }

  private extractTaskInput(context: DecisionContext): string | null {
    const snapshot = context.snapshot;
    if (
      snapshot.context &&
      typeof snapshot.context === 'object' &&
      'taskDescription' in snapshot.context
    ) {
      return (snapshot.context as Record<string, unknown>)
        .taskDescription as string;
    }
    return null;
  }

  private estimateProgress(
    confidence: number,
    context: DecisionContext
  ): number {
    const goalAuthority = require('./GoalAuthority').GoalAuthority.getInstance();
    const goal = goalAuthority.getGoal(context.goalId);
    const currentProgress = goal ? goal.progress : 0;
    return Math.min(1, currentProgress + confidence * 0.4);
  }
}
