import type { Goal, GoalBinding, GoalImpact, GoalImpactType, WorldObservation } from './types';

function generateObservationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `OBS_${ts}_${rand}`;
}

export { generateObservationId };

export interface LegacyGoalBinding {
  boundResources: string[];
  boundPaths: string[];
  boundRepository: string | null;
  boundEnvironment: string | null;
}

export { type GoalBinding };

export interface GoalImpactEvaluator {
  evaluate(goals: readonly Goal[], observation: WorldObservation): GoalImpact[];
  inferBindings(goal: Goal): LegacyGoalBinding;
}

const PATH_PATTERN = /(?:\/|[A-Za-z]:\\)[\w./\\-]+/g;
const REPO_KEYWORDS = /(?:repo|repository|project|仓库|项目)[:\s=]*([\w.-]+)/gi;
const ENV_KEYWORDS = /(?:env|environment|环境)[:\s=]*([\w.-]+)/gi;

function inferBindingsFromDescription(goal: Goal): LegacyGoalBinding {
  const text = `${goal.description || ''} ${goal.originalInput || ''}`;

  const paths: string[] = [];
  const pathMatches = text.matchAll(PATH_PATTERN);
  for (const m of pathMatches) {
    paths.push(m[0].replace(/\\/g, '/'));
  }

  if (goal.successCondition) {
    const condPaths = goal.successCondition.matchAll(PATH_PATTERN);
    for (const m of condPaths) {
      paths.push(m[0].replace(/\\/g, '/'));
    }
  }

  let repo: string | null = null;
  const repoMatches = text.matchAll(REPO_KEYWORDS);
  for (const m of repoMatches) {
    repo = m[1];
    break;
  }

  let env: string | null = null;
  const envMatches = text.matchAll(ENV_KEYWORDS);
  for (const m of envMatches) {
    env = m[1];
    break;
  }

  const resources: string[] = [];
  if (repo) resources.push(`repo:${repo}`);
  for (const p of paths) {
    resources.push(`path:${p}`);
    const segs = p.split('/');
    if (segs.length > 1) {
      resources.push(`repo:${segs[segs.length - 2]}`);
    }
  }

  return {
    boundResources: resources,
    boundPaths: paths,
    boundRepository: repo,
    boundEnvironment: env,
  };
}

class GoalImpactEvaluatorImpl implements GoalImpactEvaluator {
  evaluate(goals: readonly Goal[], observation: WorldObservation): GoalImpact[] {
    if (goals.length === 0) {
      return [];
    }

    const impacts: GoalImpact[] = [];

    for (const goal of goals) {
      try {
        const impact = this.evaluateOne(goal, observation);
        impacts.push(impact);
      } catch (err) {
        impacts.push({
          goalId: goal.goalId,
          observationId: observation.observationId,
          affected: false,
          impactType: this.inferImpactType(observation.source),
          reason: `evaluator_error: ${(err as Error).message}`,
          confidence: 0,
        });
      }
    }

    return impacts;
  }

  inferBindings(goal: Goal): LegacyGoalBinding {
    const inferred = inferBindingsFromDescription(goal);

    const metadata = goal.metadata || {};
    const mResources = metadata['boundResources'];
    const mPaths = metadata['boundPaths'];
    const mRepo = metadata['boundRepository'];
    const mEnv = metadata['boundEnvironment'];

    const resources = new Set<string>(inferred.boundResources);
    if (Array.isArray(mResources)) {
      for (const r of mResources) {
        if (typeof r === 'string') resources.add(r);
      }
    }

    const paths = [...inferred.boundPaths];
    if (Array.isArray(mPaths)) {
      for (const p of mPaths) {
        if (typeof p === 'string') paths.push(p);
      }
    }

    return {
      boundResources: [...resources],
      boundPaths: paths,
      boundRepository: (typeof mRepo === 'string' ? mRepo : null) ?? inferred.boundRepository,
      boundEnvironment: (typeof mEnv === 'string' ? mEnv : null) ?? inferred.boundEnvironment,
    };
  }

  private evaluateOne(goal: Goal, observation: WorldObservation): GoalImpact {
    const structuredResult = this.checkGoalBindingsAssociation(goal, observation);
    if (structuredResult !== null) {
      return structuredResult;
    }

    const legacyStructuredResult = this.checkStructuredAssociation(goal, observation);
    if (legacyStructuredResult !== null) {
      return legacyStructuredResult;
    }

    const contextResult = this.checkContextualAssociation(goal, observation);
    if (contextResult !== null) {
      return contextResult;
    }

    const inferredResult = this.checkInferredAssociation(goal, observation);
    if (inferredResult !== null) {
      return inferredResult;
    }

    return {
      goalId: goal.goalId,
      observationId: observation.observationId,
      affected: false,
      impactType: this.inferImpactType(observation.source),
      reason: 'insufficient_evidence',
      confidence: 0.1,
    };
  }

  private checkGoalBindingsAssociation(
    goal: Goal,
    observation: WorldObservation
  ): GoalImpact | null {
    if (!goal.bindings) {
      return null;
    }

    const binding = goal.bindings;
    const obsResources = this.extractObservationResources(observation);
    if (obsResources.size === 0) {
      return null;
    }

    const goalResources = new Set<string>();
    if (binding.resources) {
      for (const r of binding.resources) {
        goalResources.add(r);
      }
    }
    if (binding.repository) {
      goalResources.add(`repo:${binding.repository}`);
    }
    if (binding.repositoryPath) {
      goalResources.add(`path:${binding.repositoryPath}`);
    }
    if (binding.paths) {
      for (const p of binding.paths) {
        goalResources.add(`path:${p}`);
      }
    }

    if (goalResources.size === 0) {
      return null;
    }

    const overlap = this.setIntersection(goalResources, obsResources);
    if (overlap.size > 0) {
      const isExplicitOrContext = binding.source === 'explicit' || binding.source === 'workspace_context' || binding.source === 'task_context';
      return {
        goalId: goal.goalId,
        observationId: observation.observationId,
        affected: true,
        impactType: this.inferImpactType(observation.source),
        reason: `goal_bindings_match[${binding.source}]: ${[...overlap].join(', ')}`,
        confidence: isExplicitOrContext ? binding.confidence : Math.min(binding.confidence, 0.5),
      };
    }

    if (observation.source === 'git' && binding.repository) {
      const payload = observation.payload as { repos?: Array<{ repo: string }> } | null;
      if (payload && Array.isArray(payload.repos) && payload.repos.some((r) => r.repo === binding.repository)) {
        return {
          goalId: goal.goalId,
          observationId: observation.observationId,
          affected: true,
          impactType: 'git_change',
          reason: `goal_bindings_repository_match[${binding.source}]: ${binding.repository}`,
          confidence: binding.source === 'explicit' ? binding.confidence : Math.min(binding.confidence, 0.5),
        };
      }
    }

    if (observation.source === 'file' && binding.paths) {
      const payload = observation.payload as { filePath?: string } | null;
      if (payload && typeof payload.filePath === 'string') {
        for (const bp of binding.paths) {
          if (payload.filePath.startsWith(bp)) {
            return {
              goalId: goal.goalId,
              observationId: observation.observationId,
              affected: true,
              impactType: 'file_change',
              reason: `goal_bindings_path_match[${binding.source}]: ${bp}`,
              confidence: binding.source === 'explicit' ? binding.confidence : Math.min(binding.confidence, 0.5),
            };
          }
        }
      }
    }

    return null;
  }

  private checkStructuredAssociation(
    goal: Goal,
    observation: WorldObservation
  ): GoalImpact | null {
    const goalResources = this.extractGoalResourcesFromMetadata(goal);
    const obsResources = this.extractObservationResources(observation);

    if (goalResources.size === 0 || obsResources.size === 0) {
      return null;
    }

    const overlap = this.setIntersection(goalResources, obsResources);
    if (overlap.size > 0) {
      return {
        goalId: goal.goalId,
        observationId: observation.observationId,
        affected: true,
        impactType: this.inferImpactType(observation.source),
        reason: `structured_resource_match: ${[...overlap].join(', ')}`,
        confidence: 0.8,
      };
    }

    return null;
  }

  private checkContextualAssociation(
    goal: Goal,
    observation: WorldObservation
  ): GoalImpact | null {
    if (observation.source === 'environment' && goal.metadata['boundEnvironment']) {
      const bound = goal.metadata['boundEnvironment'];
      if (typeof bound === 'string') {
        const payload = observation.payload as Record<string, unknown> | null;
        if (payload && typeof payload.activeEnv === 'string' && payload.activeEnv === bound) {
          return {
            goalId: goal.goalId,
            observationId: observation.observationId,
            affected: true,
            impactType: 'environment_change',
            reason: `bound_environment_match: ${bound}`,
            confidence: 0.7,
          };
        }
      }
    }

    if (observation.source === 'git' && goal.metadata['boundRepository']) {
      const bound = goal.metadata['boundRepository'];
      if (typeof bound === 'string') {
        const payload = observation.payload as { repos?: Array<{ repo: string }> } | null;
        if (payload && Array.isArray(payload.repos) && payload.repos.some((r) => r.repo === bound)) {
          return {
            goalId: goal.goalId,
            observationId: observation.observationId,
            affected: true,
            impactType: 'git_change',
            reason: `bound_repository_match: ${bound}`,
            confidence: 0.7,
          };
        }
      }
    }

    if (observation.source === 'file' && goal.metadata['boundPaths']) {
      const boundPaths = goal.metadata['boundPaths'];
      if (Array.isArray(boundPaths)) {
        const payload = observation.payload as { filePath?: string } | null;
        if (payload && typeof payload.filePath === 'string') {
          for (const bp of boundPaths) {
            if (typeof bp === 'string' && payload.filePath.startsWith(bp)) {
              return {
                goalId: goal.goalId,
                observationId: observation.observationId,
                affected: true,
                impactType: 'file_change',
                reason: `bound_path_match: ${bp}`,
                confidence: 0.75,
              };
            }
          }
        }
      }
    }

    return null;
  }

  private checkInferredAssociation(
    goal: Goal,
    observation: WorldObservation
  ): GoalImpact | null {
    if (goal.bindings) {
      return null;
    }

    const bindings = this.inferBindings(goal);

    if (bindings.boundResources.length === 0) {
      return null;
    }

    const obsResources = this.extractObservationResources(observation);
    if (obsResources.size === 0) {
      return null;
    }

    const inferredSet = new Set(bindings.boundResources);
    const overlap = this.setIntersection(inferredSet, obsResources);

    if (overlap.size > 0) {
      return {
        goalId: goal.goalId,
        observationId: observation.observationId,
        affected: true,
        impactType: this.inferImpactType(observation.source),
        reason: `inferred_binding_match: ${[...overlap].join(', ')}`,
        confidence: 0.5,
      };
    }

    if (observation.source === 'git' && bindings.boundRepository) {
      const payload = observation.payload as { repos?: Array<{ repo: string }> } | null;
      if (payload && Array.isArray(payload.repos) && payload.repos.some((r) => r.repo === bindings.boundRepository)) {
        return {
          goalId: goal.goalId,
          observationId: observation.observationId,
          affected: true,
          impactType: 'git_change',
          reason: `inferred_repository_match: ${bindings.boundRepository}`,
          confidence: 0.5,
        };
      }
    }

    if (observation.source === 'environment' && bindings.boundEnvironment) {
      const payload = observation.payload as Record<string, unknown> | null;
      if (payload && typeof payload.activeEnv === 'string' && payload.activeEnv === bindings.boundEnvironment) {
        return {
          goalId: goal.goalId,
          observationId: observation.observationId,
          affected: true,
          impactType: 'environment_change',
          reason: `inferred_environment_match: ${bindings.boundEnvironment}`,
          confidence: 0.5,
        };
      }
    }

    return null;
  }

  private extractGoalResourcesFromMetadata(goal: Goal): Set<string> {
    const resources = new Set<string>();

    if (goal.metadata['boundResources']) {
      const bound = goal.metadata['boundResources'];
      if (Array.isArray(bound)) {
        for (const r of bound) {
          if (typeof r === 'string') resources.add(r);
        }
      }
    }

    if (goal.metadata['boundRepository']) {
      const repo = goal.metadata['boundRepository'];
      if (typeof repo === 'string') resources.add(`repo:${repo}`);
    }

    if (goal.metadata['boundPaths']) {
      const paths = goal.metadata['boundPaths'];
      if (Array.isArray(paths)) {
        for (const p of paths) {
          if (typeof p === 'string') resources.add(`path:${p}`);
        }
      }
    }

    return resources;
  }

  private extractObservationResources(observation: WorldObservation): Set<string> {
    const resources = new Set<string>();
    const payload = observation.payload as Record<string, unknown> | null;

    if (!payload) return resources;

    if (observation.source === 'file' && typeof payload.filePath === 'string') {
      resources.add(`path:${payload.filePath}`);
      const segs = payload.filePath.replace(/\\/g, '/').split('/');
      if (segs.length > 1) {
        resources.add(`repo:${segs[segs.length - 2]}`);
      }
    }

    if (observation.source === 'git' && Array.isArray(payload.repos)) {
      for (const r of payload.repos as Array<{ repo: string }>) {
        resources.add(`repo:${r.repo}`);
      }
    }

    if (observation.source === 'environment' && typeof payload.activeEnv === 'string') {
      resources.add(`env:${payload.activeEnv}`);
    }

    return resources;
  }

  private setIntersection(a: Set<string>, b: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const item of a) {
      if (b.has(item)) result.add(item);
    }
    return result;
  }

  private inferImpactType(source: WorldObservation['source']): GoalImpactType {
    switch (source) {
      case 'environment':
        return 'environment_change';
      case 'file':
        return 'file_change';
      case 'git':
        return 'git_change';
      case 'scheduled':
        return 'schedule_due';
      case 'proactive':
        return 'proactive_signal';
    }
  }
}

let instance: GoalImpactEvaluator | null = null;

export function getGoalImpactEvaluator(): GoalImpactEvaluator {
  if (!instance) {
    instance = new GoalImpactEvaluatorImpl();
  }
  return instance;
}

export function resetGoalImpactEvaluator(): void {
  instance = null;
}
