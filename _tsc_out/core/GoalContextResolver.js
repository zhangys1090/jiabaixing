"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveGoalBinding = resolveGoalBinding;
function resolveGoalBinding(input) {
    if (input.explicitBinding) {
        return {
            repository: input.explicitBinding.repository,
            repositoryPath: input.explicitBinding.repositoryPath,
            paths: input.explicitBinding.paths ? [...input.explicitBinding.paths] : undefined,
            resources: input.explicitBinding.resources ? [...input.explicitBinding.resources] : undefined,
            source: input.explicitBinding.source,
            confidence: input.explicitBinding.confidence,
            resolvedAt: input.explicitBinding.resolvedAt,
        };
    }
    if (input.projectContext) {
        const pc = input.projectContext;
        const resources = [`project:${pc.projectId}`];
        if (pc.projectName) {
            resources.push(`project_name:${pc.projectName}`);
        }
        return {
            repositoryPath: pc.projectPath,
            paths: [pc.projectPath],
            resources,
            source: 'workspace_context',
            confidence: 0.5,
            resolvedAt: Date.now(),
        };
    }
    return undefined;
}
