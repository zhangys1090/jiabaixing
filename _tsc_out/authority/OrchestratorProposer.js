"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrchestratorProposer = void 0;
const Logger_1 = require("../utils/Logger");
function generateCandidateId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `OC_${ts}_${rand}`;
}
class OrchestratorProposer {
    proposerId = 'orchestrator_proposer';
    decomposeGoalFn;
    setDecomposeFn(fn) {
        this.decomposeGoalFn = fn;
    }
    async propose(context) {
        const taskInput = this.extractTaskInput(context);
        if (!taskInput)
            return [];
        if (!this.decomposeGoalFn) {
            Logger_1.Logger.warn('OrchestratorProposer: no decomposeGoalFn set, returning empty candidates', 'OrchestratorProposer');
            return [];
        }
        try {
            const tasks = await this.decomposeGoalFn(taskInput);
            if (!tasks || tasks.length === 0)
                return [];
            const planCandidate = {
                taskCount: tasks.length,
                parallelizable: tasks.length > 1,
                estimatedComplexity: tasks.length <= 1 ? 'simple' : tasks.length <= 3 ? 'medium' : 'complex',
                taskGoals: tasks.map((t) => {
                    const task = t;
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
        }
        catch (err) {
            Logger_1.Logger.warn(`OrchestratorProposer: decompose failed — ${err.message}`, 'OrchestratorProposer');
            return [];
        }
    }
    extractTaskInput(context) {
        const goalAuthority = require('./GoalAuthority').GoalAuthority;
        const ga = goalAuthority.getInstance();
        const goal = ga.getGoal(context.goalId);
        if (goal)
            return goal.description;
        if (context.snapshot?.context?.systemPrompt)
            return context.snapshot.context.systemPrompt;
        return null;
    }
}
exports.OrchestratorProposer = OrchestratorProposer;
