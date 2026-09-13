import type { GoalExecutionDomain, DecisionProposer, DecisionContext } from './types';
import { Logger } from '../utils/Logger';

export type ProposerPhase = 'initial' | 'recovery';

export interface ReplanProposerResolver {
  register(domain: GoalExecutionDomain, proposers: DecisionProposer[]): void;
  registerInitial(domain: GoalExecutionDomain, proposers: DecisionProposer[]): void;
  registerRecovery(domain: GoalExecutionDomain, proposers: DecisionProposer[]): void;
  resolve(domain: GoalExecutionDomain, phase?: ProposerPhase): DecisionProposer[];
}

class ReplanProposerResolverImpl implements ReplanProposerResolver {
  private readonly registry: Map<GoalExecutionDomain, DecisionProposer[]> = new Map();
  private readonly initialRegistry: Map<GoalExecutionDomain, DecisionProposer[]> = new Map();
  private readonly recoveryRegistry: Map<GoalExecutionDomain, DecisionProposer[]> = new Map();

  register(domain: GoalExecutionDomain, proposers: DecisionProposer[]): void {
    this.registry.set(domain, proposers);
    Logger.info(
      `ReplanProposerResolver: registered ${proposers.map((p) => p.proposerId).join(', ')} for domain "${domain}"`,
      'ReplanProposerResolver'
    );
  }

  registerInitial(domain: GoalExecutionDomain, proposers: DecisionProposer[]): void {
    this.initialRegistry.set(domain, proposers);
    Logger.info(
      `ReplanProposerResolver: registered INITIAL proposers ${proposers.map((p) => p.proposerId).join(', ')} for domain "${domain}"`,
      'ReplanProposerResolver'
    );
  }

  registerRecovery(domain: GoalExecutionDomain, proposers: DecisionProposer[]): void {
    this.recoveryRegistry.set(domain, proposers);
    Logger.info(
      `ReplanProposerResolver: registered RECOVERY proposers ${proposers.map((p) => p.proposerId).join(', ')} for domain "${domain}"`,
      'ReplanProposerResolver'
    );
  }

  resolve(domain: GoalExecutionDomain, phase?: ProposerPhase): DecisionProposer[] {
    if (phase === 'initial') {
      const proposers = this.initialRegistry.get(domain);
      if (!proposers || proposers.length === 0) {
        Logger.warn(
          `ReplanProposerResolver: no initial proposers for domain "${domain}" - falling back to legacy registry`,
          'ReplanProposerResolver'
        );
        return this.registry.get(domain) || [];
      }
      return proposers;
    }

    if (phase === 'recovery') {
      const proposers = this.recoveryRegistry.get(domain);
      if (!proposers || proposers.length === 0) {
        Logger.warn(
          `ReplanProposerResolver: no recovery proposers for domain "${domain}" - falling back to legacy registry`,
          'ReplanProposerResolver'
        );
        return this.registry.get(domain) || [];
      }
      return proposers;
    }

    const proposers = this.registry.get(domain);
    if (!proposers || proposers.length === 0) {
      Logger.warn(
        `ReplanProposerResolver: no proposers registered for domain "${domain}" - cannot generate candidates`,
        'ReplanProposerResolver'
      );
      return [];
    }
    return proposers;
  }
}

let instance: ReplanProposerResolverImpl | null = null;

export function getReplanProposerResolver(): ReplanProposerResolver {
  if (!instance) {
    instance = new ReplanProposerResolverImpl();
  }
  return instance;
}

export function resetReplanProposerResolver(): void {
  instance = null;
}