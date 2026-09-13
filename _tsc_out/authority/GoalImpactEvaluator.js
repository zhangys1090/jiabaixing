"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateObservationId = generateObservationId;
exports.getGoalImpactEvaluator = getGoalImpactEvaluator;
exports.resetGoalImpactEvaluator = resetGoalImpactEvaluator;
function generateObservationId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `OBS_${ts}_${rand}`;
}
const PATH_PATTERN = /(?:\/|[A-Za-z]:\\)[\w./\\-]+/g;
const REPO_KEYWORDS = /(?:repo|repository|project|仓库|项目)[:\s=]*([\w.-]+)/gi;
const ENV_KEYWORDS = /(?:env|environment|环境)[:\s=]*([\w.-]+)/gi;
function inferBindingsFromDescription(goal) {
    const text = `${goal.description || ''} ${goal.originalInput || ''}`;
    const paths = [];
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
    let repo = null;
    const repoMatches = text.matchAll(REPO_KEYWORDS);
    for (const m of repoMatches) {
        repo = m[1];
        break;
    }
    let env = null;
    const envMatches = text.matchAll(ENV_KEYWORDS);
    for (const m of envMatches) {
        env = m[1];
        break;
    }
    const resources = [];
    if (repo)
        resources.push(`repo:${repo}`);
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
class GoalImpactEvaluatorImpl {
    evaluate(goals, observation) {
        if (goals.length === 0) {
            return [];
        }
        const impacts = [];
        for (const goal of goals) {
            try {
                const impact = this.evaluateOne(goal, observation);
                impacts.push(impact);
            }
            catch (err) {
                impacts.push({
                    goalId: goal.goalId,
                    observationId: observation.observationId,
                    affected: false,
                    impactType: this.inferImpactType(observation.source),
                    reason: `evaluator_error: ${err.message}`,
                    confidence: 0,
                });
            }
        }
        return impacts;
    }
    inferBindings(goal) {
        const inferred = inferBindingsFromDescription(goal);
        const metadata = goal.metadata || {};
        const mResources = metadata['boundResources'];
        const mPaths = metadata['boundPaths'];
        const mRepo = metadata['boundRepository'];
        const mEnv = metadata['boundEnvironment'];
        const resources = new Set(inferred.boundResources);
        if (Array.isArray(mResources)) {
            for (const r of mResources) {
                if (typeof r === 'string')
                    resources.add(r);
            }
        }
        const paths = [...inferred.boundPaths];
        if (Array.isArray(mPaths)) {
            for (const p of mPaths) {
                if (typeof p === 'string')
                    paths.push(p);
            }
        }
        return {
            boundResources: [...resources],
            boundPaths: paths,
            boundRepository: (typeof mRepo === 'string' ? mRepo : null) ?? inferred.boundRepository,
            boundEnvironment: (typeof mEnv === 'string' ? mEnv : null) ?? inferred.boundEnvironment,
        };
    }
    evaluateOne(goal, observation) {
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
    checkGoalBindingsAssociation(goal, observation) {
        if (!goal.bindings) {
            return null;
        }
        const binding = goal.bindings;
        const obsResources = this.extractObservationResources(observation);
        if (obsResources.size === 0) {
            return null;
        }
        const goalResources = new Set();
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
            const payload = observation.payload;
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
            const payload = observation.payload;
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
    checkStructuredAssociation(goal, observation) {
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
    checkContextualAssociation(goal, observation) {
        if (observation.source === 'environment' && goal.metadata['boundEnvironment']) {
            const bound = goal.metadata['boundEnvironment'];
            if (typeof bound === 'string') {
                const payload = observation.payload;
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
                const payload = observation.payload;
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
                const payload = observation.payload;
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
    checkInferredAssociation(goal, observation) {
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
            const payload = observation.payload;
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
            const payload = observation.payload;
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
    extractGoalResourcesFromMetadata(goal) {
        const resources = new Set();
        if (goal.metadata['boundResources']) {
            const bound = goal.metadata['boundResources'];
            if (Array.isArray(bound)) {
                for (const r of bound) {
                    if (typeof r === 'string')
                        resources.add(r);
                }
            }
        }
        if (goal.metadata['boundRepository']) {
            const repo = goal.metadata['boundRepository'];
            if (typeof repo === 'string')
                resources.add(`repo:${repo}`);
        }
        if (goal.metadata['boundPaths']) {
            const paths = goal.metadata['boundPaths'];
            if (Array.isArray(paths)) {
                for (const p of paths) {
                    if (typeof p === 'string')
                        resources.add(`path:${p}`);
                }
            }
        }
        return resources;
    }
    extractObservationResources(observation) {
        const resources = new Set();
        const payload = observation.payload;
        if (!payload)
            return resources;
        if (observation.source === 'file' && typeof payload.filePath === 'string') {
            resources.add(`path:${payload.filePath}`);
            const segs = payload.filePath.replace(/\\/g, '/').split('/');
            if (segs.length > 1) {
                resources.add(`repo:${segs[segs.length - 2]}`);
            }
        }
        if (observation.source === 'git' && Array.isArray(payload.repos)) {
            for (const r of payload.repos) {
                resources.add(`repo:${r.repo}`);
            }
        }
        if (observation.source === 'environment' && typeof payload.activeEnv === 'string') {
            resources.add(`env:${payload.activeEnv}`);
        }
        return resources;
    }
    setIntersection(a, b) {
        const result = new Set();
        for (const item of a) {
            if (b.has(item))
                result.add(item);
        }
        return result;
    }
    inferImpactType(source) {
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
let instance = null;
function getGoalImpactEvaluator() {
    if (!instance) {
        instance = new GoalImpactEvaluatorImpl();
    }
    return instance;
}
function resetGoalImpactEvaluator() {
    instance = null;
}
